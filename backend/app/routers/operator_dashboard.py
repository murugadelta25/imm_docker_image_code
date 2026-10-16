"""Operator work-instruction dashboard context API."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from datetime import date, datetime, timedelta
from typing import Optional

import json
from ..models import (
    Machine, Station, ProductionPlan, BreakdownTicket,
    Part, PartDocument, PartQcParameter, get_db, now_ist,
)
from ..auth import get_current_user
from .hourly_output import _load_config, _parse_mins, _break_windows, _expected_parts, _plan_ct
from .parts import (
    _find_part_by_variant,
    _cycle_time,
    _qc_column_schema,
    _parse_param_table,
    DEFAULT_TOOLS_COLUMNS,
    DEFAULT_MACHINE_PARAM_COLUMNS,
    DEFAULT_JIGS_COLUMNS,
)
from .machines import _compute_status

router = APIRouter(prefix="/api/operator-dashboard", tags=["operator-dashboard"])


def _shift_working_minutes(config: dict, shift_id: str) -> float:
    shift = next((s for s in config.get("shifts", []) if s.get("id") == shift_id), None)
    if not shift:
        return 0.0
    start_m = _parse_mins(shift["start"])
    end_m = _parse_mins(shift["end"])
    overnight = end_m <= start_m
    total = (24 * 60 - start_m + end_m) if overnight else max(0, end_m - start_m)
    breaks = _break_windows(config.get("breaks", {}).get(shift_id, {}))
    break_mins = sum(b.get("minutes", 0) for b in breaks)
    return max(0.0, total - break_mins)


def _live_entry_date(shift: dict) -> date:
    today = now_ist().date()
    if not shift:
        return today
    start_m = _parse_mins(shift["start"])
    end_m = _parse_mins(shift["end"])
    now = now_ist()
    current_m = now.hour * 60 + now.minute
    overnight = end_m <= start_m
    if overnight and current_m < end_m:
        return today - timedelta(days=1)
    return today


def _plan_query(db: Session, entry_date: date, shift: str, statuses):
    return (
        db.query(ProductionPlan)
        .filter(
            ProductionPlan.plan_date == entry_date,
            ProductionPlan.shift == shift,
            ProductionPlan.status.in_(statuses),
        )
        .order_by(ProductionPlan.priority, ProductionPlan.id)
    )


def _resolve_running_plan(db: Session, machine_id: int, station_id: Optional[int], entry_date: date, shift: str):
    """
    Resolve the active plan for WI / operator context.

    Station-level planning is the default: machines in a station share the same
    part / WI details. Resolution order:
      1. Plan assigned to this machine
      2. Station-level plan (machine_id is NULL, station_no = station)
      3. Any plan on the same station (sibling machine)
    """
    for statuses in (("running",), ("pending", "running")):
        plan = (
            _plan_query(db, entry_date, shift, statuses)
            .filter(ProductionPlan.machine_id == machine_id)
            .first()
        )
        if plan:
            return plan

        if not station_id:
            continue

        plan = (
            _plan_query(db, entry_date, shift, statuses)
            .filter(
                ProductionPlan.station_no == station_id,
                ProductionPlan.machine_id.is_(None),
            )
            .first()
        )
        if plan:
            return plan

        plan = (
            _plan_query(db, entry_date, shift, statuses)
            .filter(ProductionPlan.station_no == station_id)
            .first()
        )
        if plan:
            return plan

    return None


def _resolve_part_for_plan(db: Session, plan: Optional[ProductionPlan]):
    """Find Part Master row from plan variant / operation fields."""
    if not plan:
        return None
    for key in (plan.model_variant, plan.current_operation, plan.next_operation):
        part = _find_part_by_variant(db, key)
        if part:
            return part
    return None


@router.get("/context")
def get_dashboard_context(
    machine_id: int = Query(...),
    entry_date: Optional[date] = None,
    shift: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    machine = db.query(Machine).filter(Machine.id == machine_id).first()
    if not machine:
        raise HTTPException(404, "Machine not found")
    station = db.query(Station).filter(Station.id == machine.station_id).first()

    config = _load_config(db)
    shift_obj = next((s for s in config.get("shifts", []) if s.get("id") == shift), None) if shift else None
    if not shift_obj:
        now = now_ist()
        hhmm = now.hour * 60 + now.minute
        for sh in config.get("shifts", []):
            if not sh.get("enabled", True):
                continue
            start_m = _parse_mins(sh["start"])
            end_m = _parse_mins(sh["end"])
            in_shift = (end_m > start_m and start_m <= hhmm < end_m) or (
                end_m <= start_m and (hhmm >= start_m or hhmm < end_m)
            )
            if in_shift:
                shift_obj = sh
                break
    shift_id = shift_obj["id"] if shift_obj else "A"
    if not entry_date:
        entry_date = _live_entry_date(shift_obj or {"start": "08:00", "end": "20:00"})

    plan = _resolve_running_plan(db, machine_id, machine.station_id, entry_date, shift_id)
    model_variant = (plan.model_variant or plan.current_operation) if plan else None
    process_time = float(plan.process_time) if plan and plan.process_time else None
    loading_unloading = float(plan.loading_unloading) if plan and plan.loading_unloading else 10
    planned_qty = int(plan.planned_qty or 0) if plan else 0

    part = _resolve_part_for_plan(db, plan)
    if part:
        if part.process_time:
            process_time = float(part.process_time)
        if part.loading_unloading:
            loading_unloading = float(part.loading_unloading)

    # Prefer production-plan cycle time (same source as Hourly Output), then part CT
    ct = _plan_ct(plan) if plan else 0.0
    if ct <= 0:
        ct = (process_time or 0) + (loading_unloading or 0)
    if part and ct <= 0:
        ct = _cycle_time(part)

    shift_mins = _shift_working_minutes(config, shift_id)
    exp_per_hour = _expected_parts(ct, 60) if ct > 0 else 0
    # Shift expected: plan qty when set (matches Hourly Total Expected), else CT × shift minutes
    if planned_qty > 0:
        exp_per_shift = planned_qty
    else:
        exp_per_shift = _expected_parts(ct, shift_mins) if ct > 0 else 0

    docs = []
    qc_params = []
    if part:
        docs = db.query(PartDocument).filter(
            PartDocument.part_id == part.id,
            PartDocument.is_current == 1,
        ).all()
        qc_params = db.query(PartQcParameter).filter(
            PartQcParameter.part_id == part.id,
            PartQcParameter.active == 1,
        ).order_by(PartQcParameter.seq_no).all()

    effective_status = _compute_status(machine, db)
    active_bd = db.query(BreakdownTicket).filter(
        BreakdownTicket.machine_id == machine_id,
        BreakdownTicket.status.in_(["raised", "acknowledged", "in_progress"]),
    ).first()

    breakdown_doc = next((d for d in docs if d.doc_type == "breakdown_sheet"), None)

    return {
        "machine": {
            "id": machine.id,
            "name": machine.name,
            "status": effective_status,
            "machine_type": machine.machine_type,
            "location": machine.location,
        },
        "station": {
            "id": station.id if station else None,
            "name": station.name if station else None,
            "display_name": station.display_name if station else None,
        },
        "entry_date": entry_date.isoformat(),
        "shift": shift_id,
        "running_plan": {
            "id": plan.id,
            "model_variant": plan.model_variant,
            "current_operation": plan.current_operation,
            "next_operation": plan.next_operation,
            "status": plan.status,
            "process_time": float(plan.process_time) if plan.process_time else None,
            "loading_unloading": float(plan.loading_unloading) if plan.loading_unloading else None,
            "planned_qty": planned_qty or None,
            "cycle_time": round(ct, 2) if ct > 0 else None,
        } if plan else None,
        "part": {
            "id": part.id,
            "part_no": part.part_no,
            "part_name": getattr(part, "part_name", None),
            "model_variant": part.model_variant,
            "description": part.description,
            "tool_no": part.tool_no,
            "no_of_cavity": part.no_of_cavity,
            "production_section": part.production_section,
            "input_material": getattr(part, "input_material", None),
            "previous_operation": getattr(part, "previous_operation", None),
            "next_operation": getattr(part, "next_operation", None) or (plan.next_operation if plan else None),
            "machine_type": getattr(part, "machine_type", None) or machine.machine_type,
            "operation_code": part.operation_code or machine.name,
            "operation_name": part.operation_name or (plan.current_operation if plan else None),
            "operation_sequence": getattr(part, "operation_sequence", None),
            "process_time": float(part.process_time) if part.process_time else None,
            "loading_unloading": float(part.loading_unloading) if part.loading_unloading else None,
            "drawing_revision": getattr(part, "drawing_revision", None),
            "manufacturing_status": getattr(part, "manufacturing_status", None) or "production",
            "manufacturing_status_other": getattr(part, "manufacturing_status_other", None),
            "image_url": part.image_url,
            "sketch_image_url": getattr(part, "sketch_image_url", None),
            "tools_parameters": _parse_param_table(
                getattr(part, "tools_params_json", None), DEFAULT_TOOLS_COLUMNS,
            ),
            "machine_parameters": _parse_param_table(
                getattr(part, "machine_params_json", None), DEFAULT_MACHINE_PARAM_COLUMNS,
            ),
            "jigs_fixtures": _parse_param_table(
                getattr(part, "jigs_fixtures_json", None), DEFAULT_JIGS_COLUMNS,
            ),
        } if part else {
            "part_no": model_variant,
            "part_name": None,
            "model_variant": model_variant,
            "tool_no": None,
            "description": None,
            "operation_code": machine.name,
            "operation_name": plan.current_operation if plan else None,
            "next_operation": plan.next_operation if plan else None,
            "production_section": None,
            "machine_type": machine.machine_type,
            "tools_parameters": {"columns": DEFAULT_TOOLS_COLUMNS, "rows": []},
            "machine_parameters": {"columns": DEFAULT_MACHINE_PARAM_COLUMNS, "rows": []},
            "jigs_fixtures": {"columns": DEFAULT_JIGS_COLUMNS, "rows": []},
        },
        "cycle_time": round(ct, 2) if ct > 0 else None,
        "planned_qty": planned_qty or None,
        "exp_output_per_hour": exp_per_hour,
        "exp_output_per_shift": exp_per_shift,
        "documents": [
            {
                "doc_type": d.doc_type,
                "doc_label": getattr(d, "doc_label", None) or (
                    {
                        "control_plan": "Control Plan",
                        "wi_visual": "WI-Visual",
                        "wi_tray": "WI-Tray",
                        "breakdown_sheet": "Breakdown Sheet",
                        "drawing_revision": "Part / Drawing Revision",
                        "process_sheet_revision": "Process Sheet Revision",
                    }.get(d.doc_type) or d.doc_type.replace("_", " ").title()
                ),
                "revision": d.revision,
                "rev_date": d.rev_date.isoformat() if d.rev_date else None,
                "file_url": d.file_url,
            }
            for d in docs
        ],
        "qc_column_schema": _qc_column_schema(part) if part else [],
        "qc_parameters": [
            {
                "seq_no": q.seq_no,
                "parameter": q.parameter,
                "std_value": q.std_value,
                "method": q.method,
                "frequency": q.frequency,
                "is_numeric": bool(getattr(q, "is_numeric", 0)),
                "lsl": float(q.lsl) if getattr(q, "lsl", None) is not None else None,
                "usl": float(q.usl) if getattr(q, "usl", None) is not None else None,
                "extra_columns": json.loads(q.extra_columns_json or "[]") if hasattr(q, "extra_columns_json") else [],
            }
            for q in qc_params
        ],
        "breakdown": {
            "active_ticket_id": active_bd.id if active_bd else None,
            "sheet_url": breakdown_doc.file_url if breakdown_doc else None,
            "sheet_revision": breakdown_doc.revision if breakdown_doc else None,
            "sheet_rev_date": (
                breakdown_doc.rev_date.isoformat()
                if breakdown_doc and breakdown_doc.rev_date else None
            ),
        },
        "server_time": now_ist().strftime("%Y-%m-%d %H:%M:%S IST"),
    }


@router.get("/machines")
def list_machines_for_dashboard(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Machines grouped by station for station/machine interlock selector."""
    machines = db.query(Machine).order_by(Machine.station_id, Machine.name).all()
    stations = {s.id: s for s in db.query(Station).all()}
    out = []
    for m in machines:
        st = stations.get(m.station_id)
        out.append({
            "id": m.id,
            "name": m.name,
            "station_id": m.station_id,
            "station_name": st.display_name if st else None,
            "status": _compute_status(m, db),
        })
    return out
