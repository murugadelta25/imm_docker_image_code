"""IMM Device Monitoring — overview grid, mold life, KPIV, key components."""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..models import (
    ImmKeyComponent,
    ImmKpivSample,
    ImmKpivThreshold,
    ImmMold,
    Machine,
    ProductionPlan,
    Station,
    ToolStock,
    get_db,
    now_ist,
)
from ..tool_service import serialize_tool
from .machines import _compute_status

router = APIRouter(prefix="/api/imm", tags=["imm-monitor"])

KPIV_TAGS = (
    "injection_end",
    "max_pressure",
    "nozzle_temp",
    "barrel_temp",
    "charge_time",
)

KPIV_META = {
    "injection_end": {"label": "Injection End Point", "unit": "mm", "default_center": 10.0},
    "max_pressure": {"label": "Max Injection Pressure", "unit": "MPa", "default_center": 120.0},
    "nozzle_temp": {"label": "Nozzle Temperature", "unit": "°C", "default_center": 210.0},
    "barrel_temp": {"label": "Barrel 1 Temperature", "unit": "°C", "default_center": 200.0},
    "charge_time": {"label": "Feeding / Charge Time", "unit": "s", "default_center": 4.5},
}

COMPONENT_TYPES = ("barrel", "screwRod", "screwTip", "nozzle")
COMPONENT_LABELS = {
    "barrel": "Barrel",
    "screwRod": "Screw",
    "screwTip": "Injection Tip",
    "nozzle": "Nozzle",
}


def _dedupe_active_components(db: Session, machine_id: int) -> int:
    """Keep one active row per component_type (newest id). Deactivate extras.

    Concurrent _ensure_defaults / Change calls can insert duplicates; both stay
    is_active=1 and the Equipment Dashboard renders them twice.
    """
    rows = (
        db.query(ImmKeyComponent)
        .filter(ImmKeyComponent.machine_id == machine_id, ImmKeyComponent.is_active == 1)
        .order_by(ImmKeyComponent.component_type, ImmKeyComponent.id.desc())
        .all()
    )
    seen = set()
    deactivated = 0
    for row in rows:
        key = row.component_type
        if key in seen:
            row.is_active = 0
            deactivated += 1
        else:
            seen.add(key)
    return deactivated


def _active_components(db: Session, machine_id: int) -> List[ImmKeyComponent]:
    """Return at most one active component per type, in display order."""
    deactivated = _dedupe_active_components(db, machine_id)
    if deactivated:
        db.commit()
    rows = (
        db.query(ImmKeyComponent)
        .filter(ImmKeyComponent.machine_id == machine_id, ImmKeyComponent.is_active == 1)
        .order_by(ImmKeyComponent.id.desc())
        .all()
    )
    by_type = {}
    for row in rows:
        if row.component_type not in by_type:
            by_type[row.component_type] = row
    ordered = [by_type[t] for t in COMPONENT_TYPES if t in by_type]
    for t, row in by_type.items():
        if t not in COMPONENT_TYPES:
            ordered.append(row)
    return ordered


def _map_imm_status(eap_imm_status: str, err_msgs: List[str] = None) -> dict:
    """Map machine run state (Motor/Heater + cycle activity → Available / Running / …).

    KPIV alerts must NOT override this — use `_map_kpiv_status` for process health.
    """
    mapping = {
        "running": {"key": "production", "label": "Running", "color": "#22c55e"},
        "available": {"key": "available", "label": "Available", "color": "#3b82f6"},
        "alarm": {"key": "warning", "label": "Warning", "color": "#eab308"},
        "setting_change": {"key": "warning", "label": "Warning", "color": "#eab308"},
        "breakdown": {"key": "abnormal", "label": "Abnormal", "color": "#ef4444"},
        "idle": {"key": "idle", "label": "Idle", "color": "#22cae7"},
        "stop": {"key": "stop", "label": "Stop", "color": "#ef4444"},
        "offline": {"key": "offline", "label": "Offline", "color": "#6b7280"},
    }
    return mapping.get(eap_imm_status or "offline", mapping["offline"])


def _map_kpiv_status(err_msgs: List[str], eap_imm_status: str = "") -> dict:
    """Separate KPIV / process health badge (not machine run state).

    - Abnormal: one or more KPIV alerts
    - Running: no alerts and machine is actively cycling
    - Normal: no alerts and machine is available/idle/offline/other
    """
    if err_msgs:
        return {"key": "abnormal", "label": "Abnormal", "color": "#ef4444"}
    if eap_imm_status == "running":
        return {"key": "running", "label": "Running", "color": "#22c55e"}
    return {"key": "normal", "label": "Normal", "color": "#86efac"}


def _mold_usage_pct(mold: ImmMold) -> float:
    if not mold or not mold.usage_max:
        return 0.0
    return round(min(100.0, (mold.usage_count or 0) / mold.usage_max * 100), 1)


def _maint_status(mold: ImmMold) -> dict:
    if not mold or not mold.maintenance_limit:
        return {"key": "ok", "label": "No maintenance required", "pct": 0.0}
    pct = round(min(100.0, (mold.cycles_after_maintenance or 0) / mold.maintenance_limit * 100), 1)
    if pct >= 100:
        return {"key": "urgent", "label": "Immediate maintenance required", "pct": pct}
    if pct >= 80:
        return {"key": "warn", "label": "Early warning maintenance", "pct": pct}
    return {"key": "ok", "label": "No maintenance required", "pct": pct}


def _component_remaining(comp: ImmKeyComponent) -> dict:
    if not comp or not comp.start_date or not comp.expect_days:
        return {"remaining_days": None, "remaining_label": "—", "pct_used": 0}
    start = comp.start_date
    if isinstance(start, datetime):
        start = start.date()
    elapsed = (date.today() - start).days
    remaining = max(0, (comp.expect_days or 0) - elapsed)
    pct = round(min(100.0, elapsed / max(comp.expect_days, 1) * 100), 1)
    hours = (remaining % 1) * 24 if False else 0
    days = remaining
    return {
        "remaining_days": remaining,
        "remaining_label": f"{days} days",
        "pct_used": pct,
        "elapsed_days": elapsed,
    }


def _check_kpiv_alerts(db: Session, machine_id: int) -> List[str]:
    """Return human-readable KPIV out-of-limit messages for latest samples."""
    msgs = []
    for tag in KPIV_TAGS:
        thr = (
            db.query(ImmKpivThreshold)
            .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tag)
            .first()
        )
        sample = (
            db.query(ImmKpivSample)
            .filter(ImmKpivSample.machine_id == machine_id, ImmKpivSample.tag == tag)
            .order_by(ImmKpivSample.recorded_at.desc())
            .first()
        )
        if not sample:
            continue
        meta = KPIV_META[tag]
        upper = thr.upper if thr and thr.upper is not None else None
        lower = thr.lower if thr and thr.lower is not None else None
        if upper is not None and sample.value > upper:
            msgs.append(
                f"{meta['label']} {sample.value:.1f} {meta['unit']}, exceeds upper limit — please troubleshoot"
            )
        elif lower is not None and sample.value < lower:
            msgs.append(
                f"{meta['label']} {sample.value:.1f} {meta['unit']}, below lower limit — please troubleshoot"
            )
        elif thr and thr.center is not None and thr.sigma and thr.mode == "sigma":
            # Consecutive-point style hint when far from center
            deviation = abs(sample.value - thr.center)
            band = (thr.sigma or 3) * abs(thr.center) * 0.02
            if band > 0 and deviation > band * 2:
                side = "below" if sample.value < thr.center else "above"
                msgs.append(
                    f"{meta['label']} continuously {side} specification center — check process"
                )
    return msgs


def _ensure_defaults(db: Session, machine_id: int):
    """Ensure mold / component / threshold rows exist (no simulated OPC/KPIV samples).

    Spec / Start / Expected life for key components are stored in DB
    (imm_key_components). They are NOT received from Node-RED OPC UA payloads.
    """
    mold = (
        db.query(ImmMold)
        .filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1)
        .first()
    )
    if not mold:
        mold = ImmMold(
            machine_id=machine_id,
            mold_no=f"MOLD-{machine_id:04d}",
            usage_count=0,
            usage_max=1000000,
            cycles_after_maintenance=0,
            maintenance_limit=25000,
            is_active=1,
        )
        db.add(mold)

    # Remove duplicate active components before seeding missing types
    _dedupe_active_components(db, machine_id)

    for ctype in COMPONENT_TYPES:
        exists = (
            db.query(ImmKeyComponent)
            .filter(
                ImmKeyComponent.machine_id == machine_id,
                ImmKeyComponent.component_type == ctype,
                ImmKeyComponent.is_active == 1,
            )
            .first()
        )
        if not exists:
            specs = {
                "barrel": ("12", "Φ33"),
                "screwRod": ("12", "Φ34"),
                "screwTip": ("33", "Φ11"),
                "nozzle": ("3", "Φ2"),
            }
            length, diameter = specs[ctype]
            db.add(
                ImmKeyComponent(
                    machine_id=machine_id,
                    component_type=ctype,
                    spec_length=length,
                    spec_diameter=diameter,
                    start_date=date.today(),
                    expect_days=365,
                    is_active=1,
                )
            )

    for tag, meta in KPIV_META.items():
        thr = (
            db.query(ImmKpivThreshold)
            .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tag)
            .first()
        )
        center = meta["default_center"]
        if not thr:
            thr = ImmKpivThreshold(
                machine_id=machine_id,
                tag=tag,
                center=center,
                sigma=3.0,
                upper=center * 1.15,
                lower=center * 0.85,
                sample_points=20,
                mode="fixed",
            )
            db.add(thr)

    db.commit()


# ── Overview ────────────────────────────────────────────────────────────────

@router.get("/overview")
def imm_overview(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Device monitoring summary: status counts + equipment grid."""
    from ..opcua_imm import ensure_all_imm_tag_maps, highlights_for_machine, eap_imm_status_from_opcua_highlights

    machines = db.query(Machine).order_by(Machine.station_id, Machine.name).all()
    stations = {s.id: s for s in db.query(Station).all()}

    # Seed IMM defaults once so KPIV alert tooltips work without opening each machine.
    if machines and db.query(ImmKpivSample).count() == 0:
        for m in machines[:50]:
            _ensure_defaults(db, m.id)

    try:
        ensure_all_imm_tag_maps(db)
    except Exception:
        pass

    items = []
    counts = {"total": 0, "production": 0, "available": 0, "idle": 0, "stop": 0, "warning": 0, "abnormal": 0, "offline": 0}
    makes = set()
    active_molds = {
        r.machine_id: r.mold_no
        for r in db.query(ImmMold).filter(ImmMold.is_active == 1).all()
    }

    today = date.today()
    planned_machine_ids = {
        mid
        for (mid,) in db.query(ProductionPlan.machine_id)
        .filter(
            ProductionPlan.plan_date == today,
            ProductionPlan.machine_id.isnot(None),
            ProductionPlan.status.in_(("pending", "running", "paused")),
        )
        .distinct()
        .all()
        if mid
    }

    for m in machines:
        errs = _check_kpiv_alerts(db, m.id)
        try:
            opcua_hl = highlights_for_machine(db, m.id)
        except Exception:
            opcua_hl = {}
        # EAP IMM status from Motor/Heater (or Offline when SIE not connected)
        live = eap_imm_status_from_opcua_highlights(opcua_hl)
        # Preserve active breakdown / alarm tickets over Motor/Heater idle/stop
        ticket_live = _compute_status(m, db)
        if ticket_live in ("breakdown", "alarm", "setting_change"):
            live = ticket_live
        imm = _map_imm_status(live, errs)
        kpiv_st = _map_kpiv_status(errs, live)
        counts["total"] += 1
        counts[imm["key"]] = counts.get(imm["key"], 0) + 1
        if m.make:
            makes.add(m.make)
        elif m.machine_type:
            makes.add(m.machine_type)
        station = stations.get(m.station_id)
        items.append(
            {
                "id": m.id,
                "name": m.name,
                "station_id": m.station_id,
                "station_name": station.display_name if station else f"Station {m.station_id}",
                "machine_type": m.machine_type,
                "make": m.make,
                "model_no": m.model_no,
                "location": m.location,
                "image_url": m.image_url,
                "plc_source": m.plc_source,
                "plc_endpoint": m.plc_endpoint,
                "eap_imm_status": live,
                "imm_status": imm["key"],
                "imm_status_label": imm["label"],
                "imm_status_color": imm["color"],
                "kpiv_status": kpiv_st["key"],
                "kpiv_status_label": kpiv_st["label"],
                "kpiv_status_color": kpiv_st["color"],
                "err_msgs": errs,
                "opcua": opcua_hl,
                "active_mold_no": active_molds.get(m.id),
                "has_plan": m.id in planned_machine_ids,
                "operator_name": None,
            }
        )

    # Group by station for grid rows (KINPO line layout)
    by_station = {}
    for it in items:
        sid = it["station_id"]
        by_station.setdefault(
            sid,
            {"station_id": sid, "station_name": it["station_name"], "machines": []},
        )
        by_station[sid]["machines"].append(it)

    return {
        "counts": counts,
        "makes": sorted(makes) or ["Yizumi"],
        "stations": list(by_station.values()),
        "machines": items,
    }


# ── Equipment detail ────────────────────────────────────────────────────────

@router.get("/equipment/{machine_id}")
def equipment_detail(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    _ensure_defaults(db, machine_id)

    station = db.query(Station).filter(Station.id == m.station_id).first()

    mold = (
        db.query(ImmMold)
        .filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1)
        .first()
    )
    molds = (
        db.query(ImmMold)
        .filter(ImmMold.machine_id == machine_id)
        .order_by(ImmMold.is_active.desc(), ImmMold.mold_no)
        .all()
    )
    components = _active_components(db, machine_id)
    thresholds = (
        db.query(ImmKpivThreshold).filter(ImmKpivThreshold.machine_id == machine_id).all()
    )

    from ..opcua_imm import ensure_machine_tag_maps, highlights_for_machine, latest_payload, eap_imm_status_from_opcua_highlights

    try:
        ensure_machine_tag_maps(db, machine_id)
        opcua_hl = highlights_for_machine(db, machine_id)
        opcua_params = latest_payload(db, machine_id)
    except Exception:
        opcua_hl = {}
        opcua_params = []

    live = eap_imm_status_from_opcua_highlights(opcua_hl)
    ticket_live = _compute_status(m, db)
    if ticket_live in ("breakdown", "alarm", "setting_change"):
        live = ticket_live
    errs = _check_kpiv_alerts(db, machine_id)
    imm = _map_imm_status(live, errs)
    kpiv_st = _map_kpiv_status(errs, live)
    master_map = _mold_master_map(db)
    mold_master = [
        serialize_tool(t)
        for t in db.query(ToolStock).filter(ToolStock.active == 1).order_by(ToolStock.tool_name).all()
    ]

    return {
        "machine": {
            "id": m.id,
            "name": m.name,
            "station_id": m.station_id,
            "station_name": station.display_name if station else None,
            "machine_type": m.machine_type,
            "make": m.make or m.machine_type,
            "model_no": m.model_no,
            "tonnage": m.tonnage,
            "location": m.location,
            "image_url": m.image_url,
            "plc_source": m.plc_source,
            "plc_endpoint": m.plc_endpoint,
            "plc_topic": m.plc_topic,
            "eap_imm_status": live,
            "imm_status": imm["key"],
            "imm_status_label": imm["label"],
            "imm_status_color": imm["color"],
            "kpiv_status": kpiv_st["key"],
            "kpiv_status_label": kpiv_st["label"],
            "kpiv_status_color": kpiv_st["color"],
            "err_msgs": errs,
        },
        "active_mold": _serialize_mold(mold, master_map) if mold else None,
        "molds": [_serialize_mold(x, master_map) for x in molds],
        "mold_master": mold_master,
        "components": [_serialize_component(c) for c in components],
        "thresholds": [_serialize_threshold(t) for t in thresholds],
        "kpiv_tags": [
            {"tag": tag, **meta} for tag, meta in KPIV_META.items()
        ],
        "opcua": {
            "highlights": opcua_hl,
            "parameters": opcua_params,
        },
    }


def _mold_master_map(db: Session) -> dict[str, dict]:
    """Index ToolStock mold master by tool_name / tool_code (lower)."""
    out = {}
    for t in db.query(ToolStock).filter(ToolStock.active == 1).all():
        ser = serialize_tool(t)
        for key in (t.tool_name, t.tool_code):
            if key:
                out[str(key).strip().lower()] = ser
    return out


def _attach_master(mold_payload: dict, master_map: dict[str, dict]) -> dict:
    key = (mold_payload.get("mold_no") or "").strip().lower()
    master = master_map.get(key)
    if not master:
        return mold_payload
    mold_payload["master"] = {
        "tool_id": master.get("id"),
        "tool_code": master.get("tool_code"),
        "mold_name": master.get("mold_name") or master.get("tool_name"),
        "part_no": master.get("effective_part_no") or master.get("part_no"),
        "customer_name": master.get("customer_name"),
        "rm_grade": master.get("rm_grade"),
        "colour": master.get("colour"),
        "standard_cavity": master.get("standard_cavity"),
        "running_cavity": master.get("running_cavity"),
        "standard_cycle_time": master.get("standard_cycle_time"),
        "std_shot_weight": master.get("std_shot_weight"),
        "std_part_weight": master.get("std_part_weight"),
        "std_runner_weight": master.get("std_runner_weight"),
        "target_per_shift": master.get("target_per_shift"),
        "cavities": master.get("cavities") or [],
        "active_cavity": master.get("active_cavity"),
        "active_cavity_name": master.get("active_cavity_name"),
    }
    return mold_payload


def _serialize_mold(mold: ImmMold, master_map: Optional[dict] = None) -> dict:
    maint = _maint_status(mold)
    payload = {
        "id": mold.id,
        "machine_id": mold.machine_id,
        "mold_no": mold.mold_no,
        "usage_count": mold.usage_count,
        "usage_max": mold.usage_max,
        "usage_pct": _mold_usage_pct(mold),
        "cycles_after_maintenance": mold.cycles_after_maintenance,
        "maintenance_limit": mold.maintenance_limit,
        "maintenance": maint,
        "is_active": bool(mold.is_active),
        "notes": mold.notes,
    }
    if master_map is not None:
        return _attach_master(payload, master_map)
    return payload


def _serialize_component(c: ImmKeyComponent) -> dict:
    rem = _component_remaining(c)
    return {
        "id": c.id,
        "machine_id": c.machine_id,
        "component_type": c.component_type,
        "label": COMPONENT_LABELS.get(c.component_type, c.component_type),
        "spec_length": c.spec_length,
        "spec_diameter": c.spec_diameter,
        "spec_display": f"{c.spec_length or ''}*{c.spec_diameter or ''}".strip("*"),
        "start_date": c.start_date.isoformat() if c.start_date else None,
        "expect_days": c.expect_days,
        "description": c.description,
        **rem,
    }


def _serialize_threshold(t: ImmKpivThreshold) -> dict:
    meta = KPIV_META.get(t.tag, {})
    return {
        "id": t.id,
        "machine_id": t.machine_id,
        "tag": t.tag,
        "label": meta.get("label", t.tag),
        "unit": meta.get("unit", ""),
        "center": t.center,
        "sigma": t.sigma,
        "upper": t.upper,
        "lower": t.lower,
        "sample_points": t.sample_points,
        "mode": t.mode,
    }


# ── KPIV series ─────────────────────────────────────────────────────────────

@router.get("/equipment/{machine_id}/kpiv")
def kpiv_series(
    machine_id: int,
    hours: float = Query(1, ge=0.25, le=168),
    shift: Optional[str] = Query(None, description="Shift id (A/B/C) — filters to that shift window"),
    entry_date: Optional[date] = Query(None, description="Logical shift date (defaults to today IST)"),
    since: Optional[datetime] = Query(None, description="Custom range start (ISO datetime)"),
    until: Optional[datetime] = Query(None, description="Custom range end (ISO datetime)"),
    tag: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    _ensure_defaults(db, machine_id)

    now = now_ist()
    if getattr(now, "tzinfo", None) is not None:
        now = now.replace(tzinfo=None)
    end_at = now
    start_at = now - timedelta(hours=hours)
    range_mode = "hours"
    shift_meta = None

    def _naive(dt: Optional[datetime]) -> Optional[datetime]:
        if dt is None:
            return None
        if getattr(dt, "tzinfo", None) is not None:
            return dt.replace(tzinfo=None)
        return dt

    custom_since = _naive(since)
    custom_until = _naive(until)

    if custom_since is not None or custom_until is not None:
        start_at = custom_since or (now - timedelta(hours=1))
        end_at = custom_until or now
        if end_at > now:
            end_at = now
        if start_at >= end_at:
            raise HTTPException(400, "Custom range start must be before end")
        # Cap custom window at 7 days
        if (end_at - start_at) > timedelta(days=7):
            raise HTTPException(400, "Custom range cannot exceed 7 days")
        range_mode = "custom"
    elif shift:
        from ..models import SiteConfig
        import json as _json

        cfg = {}
        row = db.query(SiteConfig).first()
        if row and row.config_json:
            try:
                cfg = _json.loads(row.config_json) if isinstance(row.config_json, str) else (row.config_json or {})
            except Exception:
                cfg = {}
        shifts = [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]
        sh = next((s for s in shifts if str(s.get("id")) == str(shift)), None)
        if not sh and shifts:
            sh = next((s for s in shifts if str(s.get("name", "")).upper() == str(shift).upper()), None)
        if not sh:
            raise HTTPException(400, f"Unknown or disabled shift: {shift}")

        day = entry_date or now.date()
        start_s = str(sh.get("start") or "08:00")
        end_s = str(sh.get("end") or "20:00")
        sh_h, sh_m = [int(x) for x in start_s.split(":")[:2]]
        eh_h, eh_m = [int(x) for x in end_s.split(":")[:2]]
        start_at = datetime(day.year, day.month, day.day, sh_h, sh_m, 0)
        end_at = datetime(day.year, day.month, day.day, eh_h, eh_m, 0)
        if end_at <= start_at:
            # Overnight shift: ends next calendar day
            end_at = end_at + timedelta(days=1)
        # Do not project into the future
        if end_at > now:
            end_at = now
        if start_at > now:
            start_at = now - timedelta(minutes=1)
        range_mode = "shift"
        shift_meta = {
            "id": sh.get("id"),
            "name": sh.get("name"),
            "start": start_s,
            "end": end_s,
            "entry_date": day.isoformat(),
            "since": start_at.isoformat(),
            "until": end_at.isoformat(),
        }

    tags = [tag] if tag else list(KPIV_TAGS)
    result = {}
    for tg in tags:
        q = db.query(ImmKpivSample).filter(
            ImmKpivSample.machine_id == machine_id,
            ImmKpivSample.tag == tg,
            ImmKpivSample.recorded_at >= start_at,
            ImmKpivSample.recorded_at <= end_at,
        )
        rows = q.order_by(ImmKpivSample.recorded_at.asc()).all()
        thr = (
            db.query(ImmKpivThreshold)
            .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tg)
            .first()
        )
        meta = KPIV_META.get(tg, {})
        result[tg] = {
            "tag": tg,
            "label": meta.get("label", tg),
            "unit": meta.get("unit", ""),
            "threshold": _serialize_threshold(thr) if thr else None,
            "points": [
                {"t": r.recorded_at.isoformat(), "v": r.value}
                for r in rows
            ],
        }
    result["_meta"] = {
        "mode": range_mode,
        "hours": hours if range_mode == "hours" else None,
        "shift": shift_meta,
        "since": start_at.isoformat(),
        "until": end_at.isoformat(),
    }
    return result


# ── Mold CRUD ───────────────────────────────────────────────────────────────

class MoldCreate(BaseModel):
    mold_no: str
    usage_count: int = 0
    usage_max: int = 1000000
    cycles_after_maintenance: int = 0
    maintenance_limit: int = 25000
    notes: Optional[str] = None
    activate: bool = True


class MoldUpdate(BaseModel):
    mold_no: Optional[str] = None
    usage_count: Optional[int] = None
    usage_max: Optional[int] = None
    cycles_after_maintenance: Optional[int] = None
    maintenance_limit: Optional[int] = None
    notes: Optional[str] = None


@router.get("/equipment/{machine_id}/molds")
def list_molds(
    machine_id: int,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    query = db.query(ImmMold).filter(ImmMold.machine_id == machine_id)
    if q:
        query = query.filter(ImmMold.mold_no.ilike(f"%{q}%"))
    master_map = _mold_master_map(db)
    return [
        _serialize_mold(m, master_map)
        for m in query.order_by(ImmMold.is_active.desc(), ImmMold.mold_no).all()
    ]


@router.post("/equipment/{machine_id}/molds")
def create_mold(
    machine_id: int,
    data: MoldCreate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    if not db.query(Machine).filter(Machine.id == machine_id).first():
        raise HTTPException(404, "Machine not found")
    if data.activate:
        db.query(ImmMold).filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1).update(
            {"is_active": 0}
        )
    mold = ImmMold(
        machine_id=machine_id,
        mold_no=data.mold_no.strip(),
        usage_count=data.usage_count,
        usage_max=data.usage_max,
        cycles_after_maintenance=data.cycles_after_maintenance,
        maintenance_limit=data.maintenance_limit,
        notes=data.notes,
        is_active=1 if data.activate else 0,
    )
    db.add(mold)
    db.commit()
    db.refresh(mold)
    return _serialize_mold(mold)


@router.put("/molds/{mold_id}")
def update_mold(
    mold_id: int,
    data: MoldUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    mold = db.query(ImmMold).filter(ImmMold.id == mold_id).first()
    if not mold:
        raise HTTPException(404, "Mold not found")
    for k, v in data.dict(exclude_unset=True).items():
        setattr(mold, k, v)
    mold.updated_at = now_ist()
    db.commit()
    db.refresh(mold)
    return _serialize_mold(mold)


@router.post("/molds/{mold_id}/activate")
def activate_mold(
    mold_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    mold = db.query(ImmMold).filter(ImmMold.id == mold_id).first()
    if not mold:
        raise HTTPException(404, "Mold not found")
    db.query(ImmMold).filter(ImmMold.machine_id == mold.machine_id, ImmMold.is_active == 1).update(
        {"is_active": 0}
    )
    mold.is_active = 1
    mold.updated_at = now_ist()
    db.commit()
    db.refresh(mold)
    return _serialize_mold(mold)


@router.post("/molds/{mold_id}/reset-maintenance")
def reset_maintenance(
    mold_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "maintenance")),
):
    mold = db.query(ImmMold).filter(ImmMold.id == mold_id).first()
    if not mold:
        raise HTTPException(404, "Mold not found")
    mold.cycles_after_maintenance = 0
    mold.updated_at = now_ist()
    db.commit()
    db.refresh(mold)
    return _serialize_mold(mold)


# ── Key components ──────────────────────────────────────────────────────────

class ComponentUpsert(BaseModel):
    component_type: str
    spec_length: Optional[str] = None
    spec_diameter: Optional[str] = None
    start_date: Optional[date] = None
    expect_days: int = 365
    description: Optional[str] = None


@router.post("/equipment/{machine_id}/components")
def upsert_component(
    machine_id: int,
    data: ComponentUpsert,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "maintenance")),
):
    if data.component_type not in COMPONENT_TYPES:
        raise HTTPException(400, f"component_type must be one of {COMPONENT_TYPES}")
    if not db.query(Machine).filter(Machine.id == machine_id).first():
        raise HTTPException(404, "Machine not found")

    db.query(ImmKeyComponent).filter(
        ImmKeyComponent.machine_id == machine_id,
        ImmKeyComponent.component_type == data.component_type,
        ImmKeyComponent.is_active == 1,
    ).update({"is_active": 0})

    comp = ImmKeyComponent(
        machine_id=machine_id,
        component_type=data.component_type,
        spec_length=data.spec_length,
        spec_diameter=data.spec_diameter,
        start_date=data.start_date or date.today(),
        expect_days=data.expect_days,
        description=data.description,
        is_active=1,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return _serialize_component(comp)


# ── KPIV threshold settings ─────────────────────────────────────────────────

class ThresholdUpdate(BaseModel):
    center: Optional[float] = None
    sigma: Optional[float] = None
    upper: Optional[float] = None
    lower: Optional[float] = None
    sample_points: Optional[int] = None
    mode: Optional[str] = None


@router.put("/equipment/{machine_id}/kpiv/{tag}/threshold")
def update_threshold(
    machine_id: int,
    tag: str,
    data: ThresholdUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    if tag not in KPIV_TAGS:
        raise HTTPException(400, f"Unknown tag {tag}")
    thr = (
        db.query(ImmKpivThreshold)
        .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tag)
        .first()
    )
    if not thr:
        thr = ImmKpivThreshold(machine_id=machine_id, tag=tag)
        db.add(thr)
    for k, v in data.dict(exclude_unset=True).items():
        setattr(thr, k, v)
    thr.updated_at = now_ist()
    db.commit()
    db.refresh(thr)
    return _serialize_threshold(thr)


@router.post("/equipment/{machine_id}/kpiv/{tag}/recalculate")
def recalculate_center(
    machine_id: int,
    tag: str,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    if tag not in KPIV_TAGS:
        raise HTTPException(400, f"Unknown tag {tag}")
    thr = (
        db.query(ImmKpivThreshold)
        .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tag)
        .first()
    )
    points = thr.sample_points if thr else 20
    rows = (
        db.query(ImmKpivSample)
        .filter(ImmKpivSample.machine_id == machine_id, ImmKpivSample.tag == tag)
        .order_by(ImmKpivSample.recorded_at.desc())
        .limit(points or 20)
        .all()
    )
    if not rows:
        raise HTTPException(400, "No samples to recalculate")
    vals = [r.value for r in rows]
    mean = sum(vals) / len(vals)
    variance = sum((v - mean) ** 2 for v in vals) / max(len(vals) - 1, 1)
    std = math.sqrt(variance)
    sigma = thr.sigma if thr and thr.sigma else 3.0
    if not thr:
        thr = ImmKpivThreshold(machine_id=machine_id, tag=tag)
        db.add(thr)
    thr.center = round(mean, 4)
    thr.upper = round(mean + sigma * std, 4)
    thr.lower = round(mean - sigma * std, 4)
    thr.mode = "sigma"
    thr.updated_at = now_ist()
    db.commit()
    db.refresh(thr)
    return _serialize_threshold(thr)


# ── History lists ───────────────────────────────────────────────────────────

@router.get("/history/kpiv")
def history_kpiv(
    machine_id: Optional[int] = None,
    tag: Optional[str] = None,
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(ImmKpivSample)
    if machine_id:
        q = q.filter(ImmKpivSample.machine_id == machine_id)
    if tag:
        q = q.filter(ImmKpivSample.tag == tag)
    rows = q.order_by(ImmKpivSample.recorded_at.desc()).limit(limit).all()
    machines = {m.id: m.name for m in db.query(Machine).all()}
    return [
        {
            "id": r.id,
            "machine_id": r.machine_id,
            "machine_name": machines.get(r.machine_id, f"#{r.machine_id}"),
            "tag": r.tag,
            "label": KPIV_META.get(r.tag, {}).get("label", r.tag),
            "unit": KPIV_META.get(r.tag, {}).get("unit", ""),
            "value": r.value,
            "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
        }
        for r in rows
    ]


@router.get("/history/components")
def history_components(
    machine_id: Optional[int] = None,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    query = db.query(ImmKeyComponent)
    if machine_id:
        query = query.filter(ImmKeyComponent.machine_id == machine_id)
    rows = query.order_by(ImmKeyComponent.updated_at.desc()).all()
    machines = {m.id: m.name for m in db.query(Machine).all()}
    result = []
    for c in rows:
        if q:
            hay = f"{c.component_type} {c.spec_length} {c.spec_diameter} {c.description or ''}".lower()
            if q.lower() not in hay and q.lower() not in (machines.get(c.machine_id) or "").lower():
                continue
        row = _serialize_component(c)
        row["machine_name"] = machines.get(c.machine_id, f"#{c.machine_id}")
        row["is_active"] = bool(c.is_active)
        row["updated_at"] = c.updated_at.isoformat() if c.updated_at else None
        result.append(row)
    return result
