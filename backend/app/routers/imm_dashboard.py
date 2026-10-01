"""IMM Factory / Zone / Equipment dashboard aggregates."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..models import ImmOpcuaLatest, Machine, Station, get_db, now_ist
from ..opcua_imm import highlights_for_machine, eap_imm_status_from_opcua_highlights
from .config import _load_config
from .machines import _compute_status
from .imm_monitor import _check_kpiv_alerts, _map_imm_status, _map_kpiv_status

router = APIRouter(prefix="/api/imm/dashboard", tags=["imm-dashboard"])

ZONE_COLORS = [
    "#38bdf8",  # sky
    "#a78bfa",  # violet
    "#34d399",  # emerald
    "#f472b6",  # pink
    "#fbbf24",  # amber
    "#fb923c",  # orange
    "#22d3ee",  # cyan
    "#f87171",  # red
    "#84cc16",  # lime
    "#818cf8",  # indigo
    "#e879f9",  # fuchsia
    "#2dd4bf",  # teal
]

# Hourly Running Rate by Zone — green, white, saffron first
HOURLY_RUNNING_RATE_COLORS = [
    "#22C55E",  # green — zone 1
    "#FFFFFF",  # white — zone 2
    "#FF9933",  # saffron — zone 3
    "#38bdf8",
    "#a78bfa",
    "#f472b6",
    "#fbbf24",
    "#fb923c",
    "#22d3ee",
    "#818cf8",
]


def _load_factory_tree(db: Session) -> List[dict]:
    from ..factory_structure import factories_tree_from_db, migrate_json_factories_if_empty

    migrate_json_factories_if_empty(db)
    try:
        db.commit()
    except Exception:
        db.rollback()
    return factories_tree_from_db(db)


def _machine_payload(m: Machine, db: Session, stations: Dict[int, Station]) -> dict:
    errs = _check_kpiv_alerts(db, m.id)
    st = stations.get(m.station_id)
    try:
        opcua = highlights_for_machine(db, m.id)
    except Exception:
        opcua = {}
    live = eap_imm_status_from_opcua_highlights(opcua)
    ticket_live = _compute_status(m, db)
    if ticket_live in ("breakdown", "alarm", "setting_change"):
        live = ticket_live
    imm = _map_imm_status(live, errs)
    kpiv_st = _map_kpiv_status(errs, live)
    return {
        "id": m.id,
        "name": m.name,
        "station_id": m.station_id,
        "station_name": st.display_name if st else f"Station {m.station_id}",
        "machine_type": m.machine_type,
        "make": m.make,
        "model_no": m.model_no,
        "location": m.location,
        "eap_imm_status": live,
        "imm_status": imm["key"],
        "imm_status_label": imm["label"],
        "imm_status_color": imm["color"],
        "kpiv_status": kpiv_st["key"],
        "kpiv_status_label": kpiv_st["label"],
        "kpiv_status_color": kpiv_st["color"],
        "err_msgs": errs,
        "opcua": opcua,
        "operate_mode": _operate_mode(opcua),
    }


def _operate_mode(opcua: dict) -> str:
    def on(key: str) -> bool:
        v = opcua.get(key) or {}
        text = str(v.get("value_text") or "").strip().lower()
        num = v.get("value_num")
        if text in ("on", "1", "true", "yes", "auto", "semi"):
            return True
        if num is not None and float(num) > 0 and key != "Manual_Mode":
            return True
        return False

    if on("Auto_Mode"):
        return "Auto"
    if on("Semi_Mode"):
        return "Semi Auto"
    if on("Manual_Mode"):
        return "Manual"
    return "—"


def _running_pct(items: List[dict]) -> float:
    if not items:
        return 0.0
    run = sum(1 for x in items if x.get("imm_status") == "production")
    return round(100.0 * run / len(items), 1)


def _overview_status_counts(items: List[dict]) -> dict:
    """EAP IMM machine status buckets for factory overview chips."""
    c = Counter((x.get("eap_imm_status") or "offline") for x in items)
    return {
        "running": c.get("running", 0),
        "idle": c.get("idle", 0),
        "stop": c.get("stop", 0),
        "breakdown": c.get("breakdown", 0),
        "alarm": c.get("alarm", 0),
        "setting_change": c.get("setting_change", 0),
        "offline": c.get("offline", 0),
        "total": len(items),
        "production": c.get("running", 0),
        "warning": c.get("alarm", 0),
        "abnormal": c.get("breakdown", 0),
    }


def _zone_achievement(zone_machines: List[dict], stock_in: int, finished: int, zone_idx: int) -> dict:
    """Live achievement from OPC UA Good/Target counts only (no invented demo qty)."""
    n = max(len(zone_machines), 1)
    planned = max(0, int(finished / n)) if finished else 0
    actual = max(0, int(stock_in / n)) if stock_in else 0
    pct = round(100.0 * actual / planned, 1) if planned else 0.0
    return {"pct": pct, "actual": actual, "planned": planned}


def _live_utilization(zones: List[dict], shift_name: str = "Shift A") -> dict:
    """Utilization placeholders from live running counts only (no synthetic uptime)."""
    by_zone = []
    for z in zones:
        total = int(z.get("total") or 0)
        running = int(z.get("running") or 0)
        by_zone.append({
            "id": z.get("id"),
            "name": z.get("name"),
            "uptime_min": None,
            "downtime_min": None,
            "mttr_min": None,
            "mtbf_min": None,
            "running": running,
            "total": total,
            "running_pct": round(100.0 * running / total, 1) if total else 0.0,
        })
    total_m = sum(int(z.get("total") or 0) for z in zones)
    run_m = sum(int(z.get("running") or 0) for z in zones)
    return {
        "shift_name": shift_name,
        "uptime_min": None,
        "downtime_min": None,
        "mttr_min": None,
        "mtbf_min": None,
        "utilization_pct": round(100.0 * run_m / total_m, 1) if total_m else 0.0,
        "by_line": by_zone,
    }


def _parse_hhmm(value: str) -> int:
    try:
        hh, mm = (value or "0:0").split(":")[:2]
        return int(hh) * 60 + int(mm)
    except Exception:
        return 0


def _match_shift_at(cfg: dict, now: datetime) -> Optional[dict]:
    if getattr(now, "tzinfo", None) is not None:
        now = now.replace(tzinfo=None)
    hhmm = now.hour * 60 + now.minute
    for sh in (cfg.get("shifts") or []):
        if not sh.get("enabled", True):
            continue
        start_m = _parse_hhmm(sh.get("start") or "00:00")
        end_m = _parse_hhmm(sh.get("end") or "00:00")
        overnight = end_m <= start_m
        in_shift = (hhmm >= start_m or hhmm < end_m) if overnight else (start_m <= hhmm < end_m)
        if in_shift:
            return sh
    return None


def _factory_running_rate_trend(db: Session, zones: List[dict]) -> dict:
    """Hourly running rate per zone from live zone running_pct (flat until status history exists)."""
    cfg = _load_config(db)
    sh = _match_shift_at(cfg, now_ist())
    if not sh:
        enabled = [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]
        sh = enabled[0] if enabled else {"name": "Shift A", "start": "06:00", "end": "14:00"}

    from .hourly_output import _shift_slots

    slots_meta = _shift_slots(sh)
    slot_labels = [s["label"] for s in slots_meta]
    if not slot_labels:
        slot_labels = [f"{6 + i:02d}:00-{7 + i:02d}:00" for i in range(8)]

    lines = []
    for idx, z in enumerate(zones):
        live_pct = float(z.get("running_pct") or 0.0)
        hourly = [live_pct for _ in slot_labels]
        lines.append({
            "id": z.get("id"),
            "name": z.get("name") or f"Zone {idx + 1}",
            "color": HOURLY_RUNNING_RATE_COLORS[idx % len(HOURLY_RUNNING_RATE_COLORS)],
            "hourly_pct": hourly,
        })

    return {
        "shift_name": sh.get("name") or "Shift",
        "shift_start": sh.get("start") or "06:00",
        "shift_end": sh.get("end") or "14:00",
        "slots": slot_labels,
        "lines": lines,
    }


def _status_counts(items: List[dict]) -> dict:
    counts = {
        "production": 0,
        "warning": 0,
        "abnormal": 0,
        "idle": 0,
        "stop": 0,
        "offline": 0,
        "total": len(items),
    }
    for x in items:
        key = x.get("imm_status") or "offline"
        if key == "production":
            counts["production"] += 1
        elif key == "warning":
            counts["warning"] += 1
        elif key == "abnormal":
            counts["abnormal"] += 1
        elif key == "idle":
            counts["idle"] += 1
        elif key == "stop":
            counts["stop"] += 1
        else:
            counts["offline"] += 1
    counts["running"] = counts["production"]
    return counts


def _opcua_sum(db: Session, machine_ids: List[int], param_key: str) -> float:
    if not machine_ids:
        return 0.0
    rows = (
        db.query(ImmOpcuaLatest)
        .filter(ImmOpcuaLatest.machine_id.in_(machine_ids), ImmOpcuaLatest.param_key == param_key)
        .all()
    )
    total = 0.0
    for r in rows:
        if r.value_num is not None:
            total += float(r.value_num)
    return total


def _build_zones_from_config(factories: List[dict], stations: Dict[int, Station], machines: List[Machine]) -> List[dict]:
    """Each Factory Setup zone (stored as line) becomes a dashboard Zone."""
    from ..factory_structure import zone_location_label

    # machine.location → station_ids (Machine Management Location / Line)
    location_stations: Dict[str, set] = {}
    for m in machines:
        loc = (getattr(m, "location", None) or "").strip()
        if loc and m.station_id:
            location_stations.setdefault(loc, set()).add(int(m.station_id))

    zones = []
    for factory in factories:
        for dept in factory.get("departments") or []:
            for line in dept.get("lines") or []:
                raw_name = (line.get("name") or "").strip()
                station_ids = [
                    int(s) for s in (line.get("stationIds") or [])
                    if str(s).isdigit() or isinstance(s, int)
                ]
                if not raw_name and not station_ids:
                    continue
                zone_name = raw_name or f"Zone {len(zones) + 1}"
                factory_name = (factory.get("name") or "").strip()
                department_name = (dept.get("name") or "").strip()
                path = zone_location_label(factory_name, department_name, zone_name)
                # Merge stations from explicit zone assignment + machines on this location path
                merged = set(station_ids)
                merged |= location_stations.get(path, set())
                station_ids = sorted(merged)

                station_rows = []
                for sid in station_ids:
                    st = stations.get(sid)
                    station_rows.append(
                        {
                            "id": sid,
                            "name": (st.display_name or st.name) if st else f"Station {sid}",
                        }
                    )
                zones.append(
                    {
                        "id": str(line.get("id") or zone_name or f"zone-{len(zones)+1}"),
                        "name": zone_name,
                        "factory_id": factory.get("id"),
                        "factory_name": factory_name,
                        "department_id": dept.get("id"),
                        "department_name": department_name,
                        "location_path": path,
                        "station_ids": station_ids,
                        "stations": station_rows,
                        "lines": [
                            {
                                "id": str(line.get("id") or zone_name),
                                "name": zone_name,
                                "station_ids": station_ids,
                            }
                        ],
                    }
                )
    return zones


def _factory_dashboard_data(db: Session) -> dict:
    stations = {s.id: s for s in db.query(Station).all()}
    machines = db.query(Machine).order_by(Machine.station_id, Machine.name).all()
    items = [_machine_payload(m, db, stations) for m in machines]
    counts = _status_counts(items)
    running_pct = _running_pct(items)

    factories = _load_factory_tree(db)
    zones_meta = _build_zones_from_config(factories, stations, machines)

    mids = [m.id for m in machines]
    good = _opcua_sum(db, mids, "Total_Good_Count")
    bad = _opcua_sum(db, mids, "Total_Bad_Count")
    prod = _opcua_sum(db, mids, "Actual_Production_Count")
    target = _opcua_sum(db, mids, "Production_Target_Count")
    finished = target if target > 0 else (good + bad if (good + bad) > 0 else prod)
    stock_in = good if good > 0 else prod
    transfer_pct = round(100.0 * stock_in / finished, 1) if finished else 0.0

    zone_rows = []
    for idx, z in enumerate(zones_meta):
        zone_machines = []
        line_stats = []
        for line in z.get("lines") or []:
            sids = set(line.get("station_ids") or [])
            line_machines = [x for x in items if x["station_id"] in sids] if sids else []
            zone_machines.extend(line_machines)
            line_stats.append(
                {
                    "id": line["id"],
                    "name": line["name"],
                    "running_pct": _running_pct(line_machines),
                    "running": sum(1 for x in line_machines if x["imm_status"] == "production"),
                    "total": len(line_machines),
                    "machines": line_machines,
                }
            )
        seen = set()
        uniq = []
        for m in zone_machines:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            uniq.append(m)
        ach = _zone_achievement(uniq, int(stock_in), int(finished), idx)
        util_row = _live_utilization([{
            "id": z["id"],
            "name": z["name"],
            "running": sum(1 for x in uniq if x["imm_status"] == "production"),
            "total": len(uniq),
        }], shift_name="Shift A")["by_line"]
        util_row = util_row[0] if util_row else {}
        zone_rows.append(
            {
                "id": z["id"],
                "name": z["name"],
                "factory_id": z.get("factory_id"),
                "factory_name": z.get("factory_name") or "",
                "department_name": z.get("department_name") or "",
                "stations": z.get("stations") or [],
                "color": ZONE_COLORS[idx % len(ZONE_COLORS)],
                "running_pct": _running_pct(uniq),
                "running": sum(1 for x in uniq if x["imm_status"] == "production"),
                "total": len(uniq),
                "hit_rate": _running_pct(uniq),
                "achievement_pct": ach["pct"],
                "achievement_actual": ach["actual"],
                "achievement_planned": ach["planned"],
                "uptime_min": util_row.get("uptime_min"),
                "downtime_min": util_row.get("downtime_min"),
                "mttr_min": util_row.get("mttr_min"),
                "mtbf_min": util_row.get("mtbf_min"),
                "lines": line_stats,
                "machines": uniq,
            }
        )

    factory_list = [
        {"id": str(f.get("id") or f.get("name") or idx), "name": (f.get("name") or "").strip() or f"Factory {idx + 1}"}
        for idx, f in enumerate(factories)
        if isinstance(f, dict)
    ]
    factory_name = factory_list[0]["name"] if factory_list else ""
    site_label = factory_name
    overview_counts = _overview_status_counts(items)
    achievement_rate = {
        "pct": transfer_pct if transfer_pct > 0 else running_pct,
        "actual": int(stock_in),
        "planned": int(finished),
    }
    cfg = _load_config(db)
    active_shift = _match_shift_at(cfg, now_ist())
    utilization = _live_utilization(zone_rows, shift_name=(active_shift or {}).get("name") or "Shift A")

    return {
        "site_label": site_label,
        "factory_name": factory_name,
        "factories": factory_list,
        "zones_from_setup": True,
        "zones_hint": (
            None if zone_rows
            else "No zones configured. Add Departments → Zones and assign stations in Factory Setup."
        ),
        "running_rate": {
            "pct": running_pct,
            "running": counts["running"],
            "total": counts["total"],
        },
        "transfer_rate": {
            "pct": transfer_pct,
            "stock_in": int(stock_in),
            "finished_goods": int(finished),
        },
        "achievement_rate": achievement_rate,
        "status_counts": overview_counts,
        "imm_status_counts": counts,
        "utilization": utilization,
        "zones": zone_rows,
        "machines": items,
        "demo": False,
    }



@router.get("/factory")
def factory_dashboard(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return _factory_dashboard_data(db)


@router.get("/factory/running-rate-trend")
def factory_running_rate_trend(db: Session = Depends(get_db), _=Depends(get_current_user)):
    data = _factory_dashboard_data(db)
    return _factory_running_rate_trend(db, data.get("zones") or [])


@router.get("/zones")
def list_zones(db: Session = Depends(get_db), _=Depends(get_current_user)):
    data = _factory_dashboard_data(db)
    return {
        "site_label": data["site_label"],
        "factory_name": data.get("factory_name") or data["site_label"],
        "factories": data.get("factories") or [],
        "zones_hint": data.get("zones_hint"),
        "zones": [
            {
                "id": z["id"],
                "name": z["name"],
                "factory_id": z.get("factory_id"),
                "factory_name": z.get("factory_name") or "",
                "stations": z.get("stations") or [],
                "running": z["running"],
                "total": z["total"],
                "running_pct": z["running_pct"],
            }
            for z in data["zones"]
        ],
    }


@router.get("/zone/{zone_id}")
def zone_dashboard(zone_id: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    data = _factory_dashboard_data(db)
    zone = next((z for z in data["zones"] if str(z["id"]) == str(zone_id)), None)
    if not zone:
        raise HTTPException(404, f"Zone not found: {zone_id}")
    counts = _status_counts(zone["machines"])
    # Prefer mapped IMM keys for zone status cards
    if not any(counts.get(k) for k in ("running", "warning", "idle", "stop", "offline")):
        prod = sum(1 for m in zone["machines"] if m.get("imm_status") == "production")
        warn = sum(1 for m in zone["machines"] if m.get("imm_status") in ("warning", "abnormal"))
        idle = sum(1 for m in zone["machines"] if m.get("imm_status") == "idle")
        stop = sum(1 for m in zone["machines"] if m.get("imm_status") == "stop")
        off = sum(1 for m in zone["machines"] if m.get("imm_status") == "offline")
        counts = {
            "running": prod,
            "warning": warn,
            "idle": idle,
            "stop": stop,
            "offline": off,
            "abnormal": warn,
            "total": len(zone["machines"]),
        }
    return {
        "site_label": data["site_label"],
        "factory_name": zone.get("factory_name") or data.get("factory_name") or data["site_label"],
        "factories": data.get("factories") or [],
        "zone": zone,
        "status_counts": counts,
        "running_rate": {
            "pct": zone["running_pct"],
            "running": zone["running"],
            "total": zone["total"],
        },
        "lines": zone["lines"],
        "stations": zone.get("stations") or [],
        "machines": zone["machines"],
        "demo": data.get("demo", False),
        "zones": [
            {
                "id": z["id"],
                "name": z["name"],
                "factory_name": z.get("factory_name") or "",
            }
            for z in data["zones"]
        ],
    }


@router.get("/equipment/{machine_id}")
def equipment_dashboard_summary(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    stations = {s.id: s for s in db.query(Station).all()}
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    payload = _machine_payload(m, db, stations)
    opcua = payload.get("opcua") or {}

    def num(key: str, default: float = 0.0) -> float:
        v = opcua.get(key) or {}
        if v.get("value_num") is not None:
            return float(v["value_num"])
        return default

    def text(key: str, default: str = "—") -> str:
        v = opcua.get(key) or {}
        return str(v.get("value_text") or v.get("value_num") or default)

    prod_qty = num("Actual_Production_Count") or num("Total_Good_Count")
    cycle = num("Actual_Cycle_Time") or num("Last_Cycle_Time") or 0.0
    cavity = num("Actual_Cavity_No") or 0.0
    uph = round(3600.0 / cycle, 1) if cycle > 0 else 0.0

    operate = payload.get("operate_mode") or _operate_mode(opcua) or "—"
    part_name = text("Actual_Material_Name")
    mold_name = text("Actual_Mold_Name")

    # All machines for equipment picker (Machine Management)
    all_machines = db.query(Machine).order_by(Machine.station_id, Machine.name).all()
    siblings = (
        db.query(Machine)
        .filter(Machine.station_id == m.station_id)
        .order_by(Machine.name)
        .all()
    )

    factory_data = _factory_dashboard_data(db)
    zone = next(
        (z for z in factory_data["zones"] if m.station_id in {s.get("id") for s in (z.get("stations") or [])}),
        None,
    )
    if zone is None:
        zone = next(
            (z for z in factory_data["zones"] if any(x["id"] == m.id for x in z.get("machines") or [])),
            None,
        )

    return {
        "machine": payload,
        "factory_name": (zone or {}).get("factory_name") or factory_data.get("factory_name") or "",
        "factories": factory_data.get("factories") or [],
        "zone": {"id": zone["id"], "name": zone["name"]} if zone else None,
        "equipment_info": {
            "name": m.name,
            "status": payload["imm_status_label"],
            "status_key": payload["imm_status"],
            "status_color": payload["imm_status_color"],
            "operate_status": operate if operate != "—" else "—",
            "warning_message": "; ".join(payload.get("err_msgs") or []) or "—",
            "part_name": part_name,
            "tool_number": mold_name,
        },
        "production": {
            "quantity": int(prod_qty),
            "uph": uph,
            "total_run_hours": None,
            "actual_ct": cycle,
            "standard_ct": cycle,
            "actual_cav": cavity,
            "standard_cav": cavity,
        },
        "siblings": [{"id": x.id, "name": x.name} for x in siblings],
        "equipment_list": [{"id": x.id, "name": x.name} for x in all_machines],
        "demo": False,
        "station": {
            "id": m.station_id,
            "name": payload["station_name"],
        },
    }
