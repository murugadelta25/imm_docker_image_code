"""Relational factory / department / zone structure (IMM Factory Setup).

Tables are the source of truth. site_config.factory still holds branding keys
(siteTitle, faviconFactoryId, draftLogos) and is kept in sync for the API shape
the frontend already expects (factories[].departments[].lines[]).
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session, joinedload

from .models import (
    Factory,
    FactoryDepartment,
    FactoryZone,
    FactoryZoneStation,
    SiteConfig,
    Station,
    ensure_factory_schema,
)


def _new_key(existing: Optional[str] = None) -> str:
    key = (existing or "").strip()
    return key or str(uuid.uuid4())


def zone_location_label(factory_name: str, department_name: str, zone_name: str) -> str:
    """Same path format as frontend getFactoryLines() / machine.location."""
    return " / ".join(p for p in [factory_name or "", department_name or "", zone_name or ""] if str(p).strip())


def find_zone_by_location_label(db: Session, location: str) -> Optional[FactoryZone]:
    """Resolve a machine location path to a FactoryZone row."""
    label = (location or "").strip()
    if not label:
        return None
    ensure_factory_schema()
    tree = factories_tree_from_db(db)
    for f in tree:
        for d in f.get("departments") or []:
            for line in d.get("lines") or []:
                path = zone_location_label(f.get("name") or "", d.get("name") or "", line.get("name") or "")
                if path == label:
                    zid = line.get("dbId")
                    if zid:
                        return db.query(FactoryZone).filter(FactoryZone.id == int(zid)).first()
                    return (
                        db.query(FactoryZone)
                        .filter(FactoryZone.external_key == str(line.get("id") or ""))
                        .first()
                    )
    return None


def link_station_to_zone(db: Session, zone: FactoryZone, station_id: int) -> bool:
    """Ensure station is assigned to the zone. Returns True if a new link was added."""
    if not zone or not station_id:
        return False
    exists = (
        db.query(FactoryZoneStation)
        .filter(
            FactoryZoneStation.zone_id == zone.id,
            FactoryZoneStation.station_id == int(station_id),
        )
        .first()
    )
    if exists:
        return False
    db.add(FactoryZoneStation(zone_id=zone.id, station_id=int(station_id)))
    db.flush()
    return True


def sync_machine_to_zone(db: Session, station_id: Optional[int], location: Optional[str]) -> bool:
    """When a machine is saved with Location = zone path, attach its station to that zone."""
    zone = find_zone_by_location_label(db, location or "")
    if not zone or not station_id:
        return False
    return link_station_to_zone(db, zone, int(station_id))


def backfill_zone_stations_from_machines(db: Session) -> int:
    """Link stations onto zones using existing machines.location paths."""
    from .models import Machine

    ensure_factory_schema()
    added = 0
    for m in db.query(Machine).all():
        if sync_machine_to_zone(db, m.station_id, m.location):
            added += 1
    if added:
        db.flush()
    return added


def factories_tree_from_db(db: Session) -> List[dict]:
    """Serialize factories → departments → zones (as lines) for the existing UI/API."""
    ensure_factory_schema()
    rows = (
        db.query(Factory)
        .options(
            joinedload(Factory.departments)
            .joinedload(FactoryDepartment.zones)
            .joinedload(FactoryZone.stations)
        )
        .order_by(Factory.sort_order, Factory.id)
        .all()
    )
    out: List[dict] = []
    for f in rows:
        departments = []
        for d in sorted(f.departments or [], key=lambda x: (x.sort_order or 0, x.id or 0)):
            lines = []
            for z in sorted(d.zones or [], key=lambda x: (x.sort_order or 0, x.id or 0)):
                station_ids = [zs.station_id for zs in (z.stations or []) if zs.station_id is not None]
                lines.append(
                    {
                        "id": z.external_key,
                        "name": z.name or "",
                        "stationIds": station_ids,
                        "dbId": z.id,
                    }
                )
            departments.append(
                {
                    "id": d.external_key,
                    "name": d.name or "",
                    "lines": lines,
                    "dbId": d.id,
                }
            )
        out.append(
            {
                "id": f.external_key,
                "name": f.name or "",
                "logoUrl": f.logo_url or "",
                "location": {
                    "address": f.address or "",
                    "lat": f.lat or "",
                    "lng": f.lng or "",
                },
                "departments": departments,
                "dbId": f.id,
            }
        )
    return out


def replace_factories_tree(db: Session, factories: List[dict]) -> List[dict]:
    """Full replace of relational factory tree from Factory Setup payload."""
    ensure_factory_schema()
    valid_station_ids = {row[0] for row in db.query(Station.id).all()}

    # Clear existing tree (cascade removes departments/zones/station links)
    for row in db.query(Factory).all():
        db.delete(row)
    db.flush()

    for fi, item in enumerate(factories or []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        loc = item.get("location") if isinstance(item.get("location"), dict) else {}
        factory = Factory(
            external_key=_new_key(str(item.get("id") or "")),
            name=name,
            logo_url=(item.get("logoUrl") or "") or None,
            address=(loc.get("address") or "") or None,
            lat=str(loc.get("lat") or "") or None,
            lng=str(loc.get("lng") or "") or None,
            sort_order=fi,
        )
        db.add(factory)
        db.flush()

        for di, dept in enumerate(item.get("departments") or []):
            if not isinstance(dept, dict):
                continue
            department = FactoryDepartment(
                factory_id=factory.id,
                external_key=_new_key(str(dept.get("id") or "")),
                name=str(dept.get("name") or "").strip(),
                sort_order=di,
            )
            db.add(department)
            db.flush()

            for zi, line in enumerate(dept.get("lines") or []):
                if not isinstance(line, dict):
                    continue
                zone_name = str(line.get("name") or "").strip()
                raw_ids = line.get("stationIds") or []
                station_ids: List[int] = []
                for sid in raw_ids:
                    try:
                        n = int(sid)
                    except (TypeError, ValueError):
                        continue
                    if n in valid_station_ids and n not in station_ids:
                        station_ids.append(n)
                # Skip completely empty unnamed zone shells
                if not zone_name and not station_ids:
                    continue
                zone = FactoryZone(
                    department_id=department.id,
                    external_key=_new_key(str(line.get("id") or "")),
                    name=zone_name or f"Zone {zi + 1}",
                    sort_order=zi,
                )
                db.add(zone)
                db.flush()
                for sid in station_ids:
                    db.add(FactoryZoneStation(zone_id=zone.id, station_id=sid))

    db.flush()
    return factories_tree_from_db(db)


def update_factory_logo(db: Session, factory_external_key: str, logo_url: str) -> bool:
    ensure_factory_schema()
    row = db.query(Factory).filter(Factory.external_key == str(factory_external_key)).first()
    if not row:
        return False
    row.logo_url = logo_url
    db.flush()
    return True


def migrate_json_factories_if_empty(db: Session, factories_json: Optional[List[dict]] = None) -> bool:
    """One-time: copy site_config factory.factories into tables when tables are empty."""
    ensure_factory_schema()
    if db.query(Factory).count() > 0:
        return False

    payload = factories_json
    if payload is None:
        row = db.query(SiteConfig).first()
        if not row or not row.config_json:
            return False
        try:
            cfg = json.loads(row.config_json) or {}
        except Exception:
            return False
        payload = ((cfg.get("factory") or {}).get("factories") or [])

    named = [
        f for f in (payload or [])
        if isinstance(f, dict) and str(f.get("name") or "").strip()
    ]
    if not named:
        return False
    replace_factories_tree(db, named)
    return True


def attach_factories_to_config(db: Session, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure cfg['factory']['factories'] comes from relational tables."""
    ensure_factory_schema()
    factory_cfg = dict(cfg.get("factory") or {})
    json_list = factory_cfg.get("factories") or []
    migrate_json_factories_if_empty(db, json_list if isinstance(json_list, list) else None)
    tree = factories_tree_from_db(db)
    factory_cfg["factories"] = tree
    factory_cfg["configured"] = bool(tree) or bool(factory_cfg.get("configured"))
    # Drop nested tree from being the only store — branding keys remain in JSON
    cfg = dict(cfg)
    cfg["factory"] = factory_cfg
    return cfg


def sync_factory_branding_json(db: Session, factory_cfg: dict) -> dict:
    """Keep branding fields in site_config; factories list mirrored for compatibility."""
    out = dict(factory_cfg or {})
    tree = factories_tree_from_db(db)
    out["factories"] = tree
    out["configured"] = True if tree else bool(out.get("configured"))
    return out
