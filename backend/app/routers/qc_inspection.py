"""QC in-process inspection report — hourly instances with multi-level approval."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional, List, Any
from pydantic import BaseModel
from datetime import date
import json

from ..models import QcInspectionReport, User, Machine, Station, PartQcParameter, get_db, now_ist
from ..auth import get_current_user, require_role
from ..ws_manager import manager
from ..qc_shift_utils import (
    build_hour_slots,
    ensure_approval_structure,
    apply_missed_instances,
    current_editable_instance,
    recompute_report_status,
    column_editable_for_operator,
    pending_instances,
    snapshot_inspector_cells,
    instance_key_to_col,
    col_inspector_start,
    col_inspector_end,
    cell_count_for,
    normalize_cells,
)
from ..qc_spc_utils import build_spc_payload, enrich_readings_with_part_limits
from .hourly_output import _load_config
from .parts import _find_part_by_variant

router = APIRouter(prefix="/api/qc-inspection", tags=["qc-inspection"])

INSPECTOR_ROLES = ("quality", "supervisor", "admin")
INCHARGE_ROLES = ("supervisor", "admin")
ACTIVE_STATUSES = ("draft", "in_progress", "pending_inspector", "pending_incharge")


class QcInspectionSubmit(BaseModel):
    part_id: Optional[int] = None
    machine_id: Optional[int] = None
    article_no: str
    machine_name: Optional[str] = None
    description: Optional[str] = None
    operation_code: Optional[str] = None
    operation_name: Optional[str] = None
    production_section: Optional[str] = None
    shift: str = "A"
    inspection_date: date
    readings: List[Any] = []
    operator_name: Optional[str] = None
    approval: Optional[dict] = None


class InstanceAction(BaseModel):
    instance_key: str
    readings: Optional[List[Any]] = None
    reason: Optional[str] = None


def _shift_slots(db: Session, shift_id: str) -> list:
    config = _load_config(db)
    shift = next((s for s in config.get("shifts", []) if s.get("id") == shift_id), None)
    if not shift:
        return build_hour_slots("06:00", "14:30")
    return build_hour_slots(shift.get("start", "06:00"), shift.get("end", "14:30"))


def _prepare_approval(report: QcInspectionReport, db: Session) -> dict:
    slots = _shift_slots(db, report.shift or "A")
    approval = ensure_approval_structure(
        json.loads(report.approval_json or "{}"),
        slots,
    )
    approval = apply_missed_instances(approval, now_ist())
    return approval


def _save_approval(report: QcInspectionReport, approval: dict) -> None:
    report.approval_json = json.dumps(approval)
    report.status = recompute_report_status(approval)


def _report_out(r: QcInspectionReport, db: Session) -> dict:
    def uname(uid):
        if not uid:
            return None
        u = db.query(User).filter(User.id == uid).first()
        return u.username if u else None

    station_name = None
    if r.machine_id:
        machine = db.query(Machine).filter(Machine.id == r.machine_id).first()
        if machine and machine.station_id:
            st = db.query(Station).filter(Station.id == machine.station_id).first()
            station_name = st.display_name if st else None

    approval = _prepare_approval(r, db)
    now = now_ist()

    return {
        "id": r.id,
        "part_id": r.part_id,
        "machine_id": r.machine_id,
        "station_name": station_name,
        "article_no": r.article_no,
        "machine_name": r.machine_name,
        "description": r.description,
        "operation_code": r.operation_code,
        "operation_name": r.operation_name,
        "production_section": r.production_section,
        "shift": r.shift,
        "inspection_date": r.inspection_date.isoformat() if r.inspection_date else None,
        "readings": json.loads(r.readings_json or "[]"),
        "operator_name": r.operator_name,
        "inspector_name": r.inspector_name,
        "production_incharge": r.production_incharge,
        "approval": approval,
        "instances": approval.get("instances", {}),
        "hour_slots": approval.get("hour_slots", []),
        "operator_slot_count": approval.get("operator_slot_count", len(approval.get("hour_slots", []))),
        "cell_count": cell_count_for(approval),
        "current_instance": current_editable_instance(approval, now),
        "status": r.status or "draft",
        "operator_id": r.operator_id,
        "inspector_id": r.inspector_id,
        "incharge_id": r.incharge_id,
        "operator_username": uname(r.operator_id),
        "inspector_username": uname(r.inspector_id),
        "incharge_username": uname(r.incharge_id),
        "operator_approved_at": r.operator_approved_at.isoformat() if r.operator_approved_at else None,
        "inspector_approved_at": r.inspector_approved_at.isoformat() if r.inspector_approved_at else None,
        "incharge_approved_at": r.incharge_approved_at.isoformat() if r.incharge_approved_at else None,
        "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
    }


def _find_active_report(
    db: Session,
    machine_id: Optional[int],
    part_id: Optional[int],
    shift: str,
    inspection_date: date,
) -> Optional[QcInspectionReport]:
    q = db.query(QcInspectionReport).filter(
        QcInspectionReport.status.in_(ACTIVE_STATUSES),
        QcInspectionReport.shift == shift,
        QcInspectionReport.inspection_date == inspection_date,
    )
    if machine_id is not None:
        q = q.filter(QcInspectionReport.machine_id == machine_id)
    if part_id is not None:
        q = q.filter(QcInspectionReport.part_id == part_id)
    return q.order_by(QcInspectionReport.submitted_at.desc()).first()


def _enrich_readings_from_part(db: Session, out: dict) -> dict:
    part_id = out.get("part_id")
    if not part_id and out.get("article_no"):
        part = _find_part_by_variant(db, out["article_no"])
        if part:
            part_id = part.id
    if not part_id:
        return out
    part_qc = (
        db.query(PartQcParameter)
        .filter(PartQcParameter.part_id == part_id, PartQcParameter.active == 1)
        .all()
    )
    part_params = [
        {
            "parameter": q.parameter,
            "std_value": q.std_value,
            "is_numeric": bool(q.is_numeric),
            "lsl": float(q.lsl) if q.lsl is not None else None,
            "usl": float(q.usl) if q.usl is not None else None,
        }
        for q in part_qc
    ]
    out = dict(out)
    out["readings"] = enrich_readings_with_part_limits(out.get("readings") or [], part_params)
    return out


def _spc_warnings_for_report(out: dict, db: Session) -> List[dict]:
    enriched = _enrich_readings_from_part(db, out)
    return build_spc_payload(enriched).get("warnings") or []


async def _broadcast_spc_if_needed(report: QcInspectionReport, db: Session) -> None:
    """Notify header bell clients when SPC deviations are present on a report."""
    try:
        out = _report_out(report, db)
        warnings = _spc_warnings_for_report(out, db)
        if not warnings:
            return
        await manager.broadcast({
            "type": "spc_alert",
            "report_id": report.id,
            "machine_id": report.machine_id,
            "article_no": report.article_no,
            "shift": report.shift,
            "warning_count": len(warnings),
        })
    except Exception as exc:
        print(f"[QC] SPC broadcast failed: {exc}")


def _apply_submit_fields(
    report: QcInspectionReport, data: QcInspectionSubmit, user: User, db: Session,
) -> None:
    report.part_id = data.part_id
    report.machine_id = data.machine_id
    report.article_no = data.article_no
    report.machine_name = data.machine_name
    report.description = data.description
    report.operation_code = data.operation_code
    report.operation_name = data.operation_name
    report.production_section = data.production_section
    report.shift = data.shift
    report.inspection_date = data.inspection_date
    report.readings_json = json.dumps(data.readings)
    report.operator_name = data.operator_name or user.username
    if data.approval:
        slots = _shift_slots(db, data.shift)
        existing = json.loads(report.approval_json or "{}")
        merged = ensure_approval_structure({**existing, **data.approval}, slots)
        report.approval_json = json.dumps(merged)
    report.submitted_by = user.id


def _get_or_create_draft(
    db: Session, data: QcInspectionSubmit, user: User,
) -> QcInspectionReport:
    ts = now_ist()
    report = _find_active_report(
        db, data.machine_id, data.part_id, data.shift, data.inspection_date,
    )
    if report:
        return report
    slots = _shift_slots(db, data.shift)
    approval = ensure_approval_structure({}, slots)
    report = QcInspectionReport(
        status="draft",
        operator_id=user.id,
        submitted_at=ts,
        approval_json=json.dumps(approval),
    )
    _apply_submit_fields(report, data, user, db)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def _validate_instance_submit(approval: dict, instance_key: str, readings: list, now) -> None:
    col = instance_key_to_col(instance_key, approval)
    if col is None:
        raise HTTPException(400, f"Invalid instance '{instance_key}'")
    if not column_editable_for_operator(approval, col, now):
        inst = approval.get("instances", {}).get(instance_key, {})
        st = inst.get("status", "unknown")
        raise HTTPException(400, f"Instance '{instance_key}' is not editable (status: {st})")
    for row in readings:
        cells = row.get("cells") or []
        if col >= len(cells) or not str(cells[col] or "").strip():
            raise HTTPException(400, f"Fill all parameter values for instance {instance_key} before submitting")


@router.get("/pending-approvals")
def pending_approvals(
    queue: str = Query("inspector", pattern="^(inspector|incharge|operator)$"),
    grouped: bool = Query(True, description="Group inspector/incharge queues by shift report"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """QC / supervisor / operator queues — inspector & incharge default to consolidated report rows."""
    target = "pending_inspector" if queue == "inspector" else "pending_incharge" if queue == "incharge" else None
    reports = db.query(QcInspectionReport).filter(
        QcInspectionReport.status.in_(ACTIVE_STATUSES),
    ).order_by(QcInspectionReport.submitted_at.desc()).limit(200).all()

    rows = []
    for r in reports:
        out = _report_out(r, db)
        approval = out["approval"]
        if queue == "operator":
            for key, inst in (approval.get("instances") or {}).items():
                st = inst.get("status", "empty")
                if st in ("pending_inspector", "pending_incharge", "approved", "rejected", "missed", "frozen"):
                    rows.append({
                        "report_id": r.id,
                        "instance_key": key,
                        "instance_label": inst.get("label", key),
                        "status": st,
                        "status_color": "green" if st in ("approved", "frozen") else "yellow" if st in ("pending_inspector", "pending_incharge") else "red" if st == "rejected" else "gray" if st == "missed" else "neutral",
                        "station_name": out["station_name"],
                        "machine_name": out["machine_name"],
                        "article_no": out["article_no"],
                        "operator_username": out["operator_username"],
                        "shift": out["shift"],
                        "inspection_date": out["inspection_date"],
                        "submitted_at": inst.get("submitted_at") or out["submitted_at"],
                    })
            continue

        pending_keys = pending_instances(approval, target)
        if not pending_keys:
            continue

        if grouped:
            rows.append({
                "report_id": r.id,
                "instance_key": pending_keys[0],
                "instance_label": f"{len(pending_keys)} pending",
                "pending_instances": pending_keys,
                "pending_count": len(pending_keys),
                "status": target,
                "status_color": "yellow",
                "station_name": out["station_name"],
                "machine_name": out["machine_name"],
                "article_no": out["article_no"],
                "operator_username": out["operator_username"],
                "shift": out["shift"],
                "inspection_date": out["inspection_date"],
                "submitted_at": out["submitted_at"],
                "consolidated": True,
            })
        else:
            for key in pending_keys:
                inst = approval["instances"][key]
                rows.append({
                    "report_id": r.id,
                    "instance_key": key,
                    "instance_label": inst.get("label", key),
                    "status": target,
                    "station_name": out["station_name"],
                    "machine_name": out["machine_name"],
                    "article_no": out["article_no"],
                    "operator_username": out["operator_username"],
                    "shift": out["shift"],
                    "inspection_date": out["inspection_date"],
                    "submitted_at": inst.get("submitted_at") or out["submitted_at"],
                    "consolidated": False,
                })
    return rows


@router.get("/active")
def get_active_report(
    machine_id: Optional[int] = None,
    part_id: Optional[int] = None,
    shift: str = "A",
    inspection_date: Optional[date] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    if not inspection_date:
        raise HTTPException(400, "inspection_date is required")
    report = _find_active_report(db, machine_id, part_id, shift, inspection_date)
    if not report:
        return None
    approval = _prepare_approval(report, db)
    report.approval_json = json.dumps(approval)
    db.commit()
    out = _report_out(report, db)
    out["spc_warnings"] = _spc_warnings_for_report(out, db)
    return out


@router.put("/draft")
async def save_draft(
    data: QcInspectionSubmit,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Auto-save operator draft for editable hourly columns."""
    ts = now_ist()
    report = _find_active_report(
        db, data.machine_id, data.part_id, data.shift, data.inspection_date,
    )
    approval = None
    if report:
        approval = _prepare_approval(report, db)
        if report.status == "approved":
            raise HTTPException(400, "Shift inspection is already closed")
    else:
        report = QcInspectionReport(
            status="draft",
            operator_id=user.id,
            submitted_at=ts,
        )
        _apply_submit_fields(report, data, user, db)
        approval = _prepare_approval(report, db)
        db.add(report)
    if not report.operator_id:
        report.operator_id = user.id

    # Merge readings: protect inspector columns and future unstarted columns only.
    # Accept incoming values for current and past operator columns so user edits
    # are never reverted by a time-window check at auto-save time.
    existing = json.loads(report.readings_json or "[]")
    incoming = data.readings
    merged = []
    cc = cell_count_for(approval)
    ci0 = col_inspector_start(approval)
    ci1 = col_inspector_end(approval)
    for i, row in enumerate(incoming):
        old_cells = normalize_cells(
            (existing[i].get("cells") if i < len(existing) else None), approval,
        )
        new_cells = normalize_cells(row.get("cells"), approval)
        for col in range(cc):
            if col in (ci0, ci1):
                # Always protect inspector columns from operator writes
                new_cells[col] = old_cells[col]
            # All operator columns: accept incoming value if non-empty,
            # otherwise keep existing to avoid blanking submitted data
            elif new_cells[col] in (None, ""):
                new_cells[col] = old_cells[col]
        merged.append({**row, "cells": new_cells})
    report.readings_json = json.dumps(merged)
    draft_data = data.model_copy(update={"readings": merged, "approval": None})
    _apply_submit_fields(report, draft_data, user, db)
    inst_key = current_editable_instance(approval, ts)
    if inst_key:
        approval["instances"][inst_key]["status"] = "draft"
    _save_approval(report, approval)
    report.submitted_at = ts
    db.commit()
    db.refresh(report)
    out = _report_out(report, db)
    out["spc_warnings"] = _spc_warnings_for_report(out, db)
    if out["spc_warnings"]:
        await _broadcast_spc_if_needed(report, db)
    return out


def _do_submit_instance(report: QcInspectionReport, body: InstanceAction, user: User, db: Session):
    if report.status == "approved":
        raise HTTPException(400, "Shift inspection is already closed")
    ts = now_ist()
    approval = _prepare_approval(report, db)
    readings = body.readings or json.loads(report.readings_json or "[]")
    _validate_instance_submit(approval, body.instance_key, readings, ts)

    report.readings_json = json.dumps(readings)
    if not report.operator_id:
        report.operator_id = user.id
    report.operator_name = user.username
    if not report.operator_approved_at:
        report.operator_approved_at = ts

    inst = approval["instances"].setdefault(body.instance_key, {})
    inst["status"] = "pending_inspector"
    inst["submitted_at"] = ts.isoformat()
    inst["submitted_by"] = user.username
    _save_approval(report, approval)
    report.submitted_at = ts
    db.commit()
    db.refresh(report)
    return report


@router.post("/")
async def submit_operator_report(
    data: QcInspectionSubmit,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Legacy full submit — submits the current hourly instance."""
    report = _get_or_create_draft(db, data, user)
    if data.readings:
        report.readings_json = json.dumps(data.readings)
        db.commit()
    approval = _prepare_approval(report, db)
    inst_key = current_editable_instance(approval, now_ist())
    if not inst_key:
        raise HTTPException(400, "No hourly instance is available to submit right now")
    body = InstanceAction(instance_key=inst_key, readings=data.readings)
    report = _do_submit_instance(report, body, user, db)
    out = _report_out(report, db)
    out["spc_warnings"] = _spc_warnings_for_report(out, db)
    if out["spc_warnings"]:
        await _broadcast_spc_if_needed(report, db)
    await manager.broadcast({
        "type": "qc_report_submitted",
        "report_id": report.id,
        "machine_id": report.machine_id,
    })
    return out


@router.post("/{report_id}/submit-instance")
async def submit_instance(
    report_id: int,
    body: InstanceAction,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Operator submits one hourly instance — notifies QC (pending_inspector)."""
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    report = _do_submit_instance(report, body, user, db)
    out = _report_out(report, db)
    out["spc_warnings"] = _spc_warnings_for_report(out, db)
    if out["spc_warnings"]:
        await _broadcast_spc_if_needed(report, db)
    await manager.broadcast({
        "type": "qc_report_submitted",
        "report_id": report.id,
        "machine_id": report.machine_id,
    })
    return out

@router.post("/{report_id}/approve-inspector")
def approve_inspector(
    report_id: int,
    body: Optional[InstanceAction] = None,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INSPECTOR_ROLES)),
):
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    if report.operator_id and report.operator_id == user.id:
        raise HTTPException(400, "Inspector must be a different login from Operator")

    ts = now_ist()
    approval = _prepare_approval(report, db)
    pending = pending_instances(approval, "pending_inspector")
    instance_key = (body.instance_key if body else None) or (pending[0] if pending else None)
    if not instance_key:
        raise HTTPException(400, "No instance awaiting inspector approval")

    if body and body.readings:
        report.readings_json = json.dumps(body.readings)

    readings = json.loads(report.readings_json or "[]")
    ci0 = col_inspector_start(approval)
    ci1 = col_inspector_end(approval)
    has_inspector_entry = any(
        str(normalize_cells(row.get("cells"), approval)[ci0] or "").strip()
        or str(normalize_cells(row.get("cells"), approval)[ci1] or "").strip()
        for row in readings
    )

    inst = approval["instances"][instance_key]
    inst["status"] = "pending_incharge"
    inst["inspector_at"] = ts.isoformat()
    inst["inspector_username"] = user.username
    if has_inspector_entry:
        inst["inspector_readings"] = snapshot_inspector_cells(readings, approval)
    report.inspector_id = user.id
    report.inspector_name = user.username
    report.inspector_approved_at = ts
    _save_approval(report, approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.post("/{report_id}/approve-inspector-all")
def approve_inspector_all(
    report_id: int,
    body: Optional[InstanceAction] = None,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INSPECTOR_ROLES)),
):
    """QC consolidated sign-off — approves every instance awaiting inspector review."""
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    if report.operator_id and report.operator_id == user.id:
        raise HTTPException(400, "Inspector must be a different login from Operator")

    ts = now_ist()
    approval = _prepare_approval(report, db)
    pending = pending_instances(approval, "pending_inspector")
    if not pending:
        raise HTTPException(400, "No instances awaiting QC approval")

    if body and body.readings:
        report.readings_json = json.dumps(body.readings)

    readings = json.loads(report.readings_json or "[]")
    ci0 = col_inspector_start(approval)
    ci1 = col_inspector_end(approval)
    has_inspector_entry = any(
        str(normalize_cells(row.get("cells"), approval)[ci0] or "").strip()
        or str(normalize_cells(row.get("cells"), approval)[ci1] or "").strip()
        for row in readings
    )
    inspector_snapshot = snapshot_inspector_cells(readings, approval) if has_inspector_entry else None

    for key in pending:
        inst = approval["instances"][key]
        inst["status"] = "pending_incharge"
        inst["inspector_at"] = ts.isoformat()
        inst["inspector_username"] = user.username
        if inspector_snapshot is not None:
            inst["inspector_readings"] = inspector_snapshot

    report.inspector_id = user.id
    report.inspector_name = user.username
    report.inspector_approved_at = ts
    _save_approval(report, approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.post("/{report_id}/reject-instance")
def reject_instance(
    report_id: int,
    body: InstanceAction,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INSPECTOR_ROLES, *INCHARGE_ROLES)),
):
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    approval = _prepare_approval(report, db)
    inst = approval["instances"].get(body.instance_key)
    if not inst:
        raise HTTPException(404, "Instance not found")
    if inst.get("status") not in ("pending_inspector", "pending_incharge"):
        raise HTTPException(400, "Instance is not awaiting rejection")
    inst["status"] = "rejected"
    inst["rejected_at"] = now_ist().isoformat()
    inst["reject_reason"] = body.reason or "Rejected"
    inst["rejected_by"] = user.username
    _save_approval(report, approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.post("/{report_id}/approve-incharge")
def approve_incharge(
    report_id: int,
    body: Optional[InstanceAction] = None,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INCHARGE_ROLES)),
):
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    if report.operator_id and report.operator_id == user.id:
        raise HTTPException(400, "Production Incharge must be a different login from Operator")
    if report.inspector_id and report.inspector_id == user.id:
        raise HTTPException(400, "Production Incharge must be a different login from Inspector")

    ts = now_ist()
    approval = _prepare_approval(report, db)
    pending = pending_instances(approval, "pending_incharge")
    instance_key = (body.instance_key if body else None) or (pending[0] if pending else None)
    if not instance_key:
        raise HTTPException(400, "No instance awaiting incharge approval")

    inst = approval["instances"][instance_key]
    inst["status"] = "approved"
    inst["incharge_at"] = ts.isoformat()
    inst["incharge_username"] = user.username
    report.incharge_id = user.id
    report.production_incharge = user.username
    report.incharge_approved_at = ts
    _save_approval(report, approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.post("/{report_id}/approve-incharge-all")
def approve_incharge_all(
    report_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INCHARGE_ROLES)),
):
    """Supervisor consolidated sign-off — approves all QC-reviewed instances for the shift."""
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    if report.operator_id and report.operator_id == user.id:
        raise HTTPException(400, "Production Incharge must be a different login from Operator")
    if report.inspector_id and report.inspector_id == user.id:
        raise HTTPException(400, "Production Incharge must be a different login from Inspector")

    ts = now_ist()
    approval = _prepare_approval(report, db)
    still_qc = pending_instances(approval, "pending_inspector")
    if still_qc:
        raise HTTPException(
            400,
            f"QC review still pending for: {', '.join(still_qc)}",
        )
    pending = pending_instances(approval, "pending_incharge")
    if not pending:
        raise HTTPException(400, "No instances awaiting supervisor approval")

    for key in pending:
        inst = approval["instances"][key]
        inst["status"] = "approved"
        inst["incharge_at"] = ts.isoformat()
        inst["incharge_username"] = user.username

    report.incharge_id = user.id
    report.production_incharge = user.username
    report.incharge_approved_at = ts
    if not pending_instances(approval, "pending_inspector") and not pending_instances(approval, "pending_incharge"):
        report.status = "approved"
    _save_approval(report, approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.post("/{report_id}/close-shift")
def close_shift(
    report_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role(*INCHARGE_ROLES)),
):
    """Supervisor closes the shift — approves remaining instances and locks the sheet."""
    report = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not report:
        raise HTTPException(404, "Report not found")
    ts = now_ist()
    approval = _prepare_approval(report, db)
    for key, inst in approval.get("instances", {}).items():
        if inst.get("status") == "pending_incharge":
            inst["status"] = "approved"
            inst["incharge_at"] = ts.isoformat()
            inst["incharge_username"] = user.username
        elif inst.get("status") == "pending_inspector":
            raise HTTPException(400, f"Instance '{key}' still awaiting QC inspection")
    report.status = "approved"
    report.incharge_id = user.id
    report.production_incharge = user.username
    report.incharge_approved_at = ts
    report.approval_json = json.dumps(approval)
    db.commit()
    db.refresh(report)
    return _report_out(report, db)


@router.get("/")
def list_reports(
    machine_id: Optional[int] = None,
    part_id: Optional[int] = None,
    status: Optional[str] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(QcInspectionReport)
    if machine_id:
        q = q.filter(QcInspectionReport.machine_id == machine_id)
    if part_id:
        q = q.filter(QcInspectionReport.part_id == part_id)
    if status:
        q = q.filter(QcInspectionReport.status == status)
    if from_date:
        q = q.filter(QcInspectionReport.inspection_date >= from_date)
    if to_date:
        q = q.filter(QcInspectionReport.inspection_date <= to_date)
    reports = q.order_by(QcInspectionReport.submitted_at.desc()).limit(100).all()
    return [_report_out(r, db) for r in reports]


@router.get("/{report_id}/spc-data")
def get_spc_data(report_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    r = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not r:
        raise HTTPException(404, "Report not found")
    out = _report_out(r, db)
    out = _enrich_readings_from_part(db, out)
    return build_spc_payload(out)


@router.get("/{report_id}")
def get_report(report_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    r = db.query(QcInspectionReport).filter(QcInspectionReport.id == report_id).first()
    if not r:
        raise HTTPException(404, "Report not found")
    return _report_out(r, db)
