from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, date
import pytz

IST = pytz.timezone('Asia/Kolkata')


def now_ist():
    return datetime.now(IST).replace(tzinfo=None)

from pydantic import BaseModel
from typing import Optional
from ..models import ModelChangeRequest, Machine, ProductionPlan, BreakdownTicket, get_db
from ..auth import get_current_user, require_role
from ..ws_manager import manager
from .machines import _log_status

router = APIRouter(prefix="/api/model-change", tags=["model-change"])


class MCRCreate(BaseModel):
    machine_id: int
    from_model: str
    to_model: str
    ideal_minutes: int = 60
    shift: str = "A"
    entry_date: Optional[date] = None
    reason: str = "setting_change"
    plan_id: Optional[int] = None


def _enrich(mcr, db):
    machine = db.query(Machine).filter(Machine.id == mcr.machine_id).first()
    plan = None
    if getattr(mcr, "plan_id", None):
        plan = db.query(ProductionPlan).filter(ProductionPlan.id == mcr.plan_id).first()
    d = {c.name: getattr(mcr, c.name) for c in mcr.__table__.columns}
    for key in ("start_time", "end_time", "created_at", "entry_date"):
        val = d.get(key)
        if val is not None and hasattr(val, "isoformat"):
            d[key] = val.isoformat()
    d["machine_name"] = machine.name if machine else str(mcr.machine_id)
    d["station_id"] = machine.station_id if machine else None
    d["plan_status"] = plan.status if plan else None
    d["plan_operation"] = plan.current_operation if plan else None
    d["source"] = "planning" if getattr(mcr, "plan_id", None) else "manual"
    if mcr.start_time and mcr.end_time:
        d["elapsed_minutes"] = max(0, int((mcr.end_time - mcr.start_time).total_seconds() / 60))
    elif mcr.start_time:
        d["elapsed_minutes"] = max(0, int((now_ist() - mcr.start_time).total_seconds() / 60))
    else:
        d["elapsed_minutes"] = 0
    return d


def _start_linked_plan(mcr, db):
    """On approval: start linked plan so WI and related pages show the new part."""
    if not getattr(mcr, "plan_id", None):
        return None
    plan = db.query(ProductionPlan).filter(ProductionPlan.id == mcr.plan_id).first()
    if not plan:
        return None
    if plan.status in ("pending", "paused"):
        # Auto-pause any other running plan on the same machine (unless trial)
        if plan.plan_type != "trial" and plan.machine_id:
            conflicting = db.query(ProductionPlan).filter(
                ProductionPlan.machine_id == plan.machine_id,
                ProductionPlan.id != plan.id,
                ProductionPlan.status == "running",
            ).all()
            for conflict in conflicting:
                conflict.status = "paused"
                conflict.updated_at = now_ist()
        plan.status = "running"
        plan.updated_at = now_ist()
    return plan


@router.post("/")
async def request_model_change(data: MCRCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    mcr = ModelChangeRequest(
        machine_id=data.machine_id,
        plan_id=data.plan_id,
        requested_by=user.id,
        from_model=data.from_model,
        to_model=data.to_model,
        ideal_minutes=data.ideal_minutes,
        shift=data.shift,
        entry_date=data.entry_date or now_ist().date(),
        reason=data.reason,
        created_at=now_ist(),
    )
    db.add(mcr)
    db.commit()
    db.refresh(mcr)
    await manager.broadcast({
        "type": "model_change_request",
        "id": mcr.id,
        "machine_id": data.machine_id,
        "plan_id": data.plan_id,
        "from_model": data.from_model,
        "to_model": data.to_model,
        "status": "pending",
    })
    return _enrich(mcr, db)


@router.patch("/{mcr_id}/approve")
async def approve_request(mcr_id: int, db: Session = Depends(get_db), user=Depends(require_role("supervisor", "admin"))):
    mcr = db.query(ModelChangeRequest).filter(ModelChangeRequest.id == mcr_id).first()
    if not mcr:
        raise HTTPException(404, "Not found")
    if mcr.status != "pending":
        raise HTTPException(400, f"Only pending requests can be approved (current: {mcr.status})")

    active_bd = db.query(BreakdownTicket).filter(
        BreakdownTicket.machine_id == mcr.machine_id,
        BreakdownTicket.status.in_(["raised", "acknowledged", "in_progress"]),
    ).first()
    if active_bd:
        raise HTTPException(400, "Cannot approve model change while machine has an active breakdown ticket")

    mcr.status = "approved"
    mcr.approved_by = user.id
    mcr.start_time = now_ist()

    machine = db.query(Machine).filter(Machine.id == mcr.machine_id).first()
    if machine and machine.status not in ("breakdown", "offline"):
        machine.status = "setting_change"
    # Loss Tracker segment: setting_change starts here
    _log_status(mcr.machine_id, "setting_change", "model_change", db)

    plan = _start_linked_plan(mcr, db)
    db.commit()
    db.refresh(mcr)

    await manager.broadcast({
        "type": "machine_status_updated",
        "id": mcr.machine_id,
        "status": "setting_change",
        "source": "model_change",
    })
    await manager.broadcast({
        "type": "model_change_approved",
        "id": mcr_id,
        "machine_id": mcr.machine_id,
        "plan_id": mcr.plan_id,
        "start_time": mcr.start_time.isoformat() if mcr.start_time else None,
        "ideal_minutes": mcr.ideal_minutes,
        "to_model": mcr.to_model,
    })
    if plan:
        await manager.broadcast({
            "type": "plan_started",
            "plan_id": plan.id,
            "machine_id": plan.machine_id,
            "station_no": plan.station_no,
            "current_operation": plan.current_operation,
            "next_operation": plan.next_operation,
            "model_variant": plan.model_variant,
            "process_time": float(plan.process_time) if plan.process_time is not None else None,
            "loading_unloading": float(plan.loading_unloading) if plan.loading_unloading is not None else None,
            "shift": plan.shift,
            "plan_date": str(plan.plan_date),
        })
    return _enrich(mcr, db)


@router.patch("/{mcr_id}/complete")
async def complete_request(mcr_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    mcr = db.query(ModelChangeRequest).filter(ModelChangeRequest.id == mcr_id).first()
    if not mcr:
        raise HTTPException(404, "Not found")
    if mcr.status not in ("approved", "in_progress"):
        raise HTTPException(400, f"Only approved requests can be completed (current: {mcr.status})")

    mcr.status = "completed"
    mcr.end_time = now_ist()
    elapsed = int((mcr.end_time - mcr.start_time).total_seconds() / 60) if mcr.start_time else 0

    machine = db.query(Machine).filter(Machine.id == mcr.machine_id).first()
    # After setting change completes, set to idle — the machine status API (PLC/Node-RED)
    # will update to running once the machine actually starts producing
    next_status = "idle"
    if machine and machine.status not in ("breakdown", "offline", "alarm"):
        machine.status = next_status
    # Loss Tracker segment: close setting_change by logging next status
    _log_status(mcr.machine_id, next_status, "model_change", db)

    db.commit()
    db.refresh(mcr)

    await manager.broadcast({
        "type": "machine_status_updated",
        "id": mcr.machine_id,
        "status": next_status,
        "source": "model_change",
    })
    await manager.broadcast({
        "type": "model_change_completed",
        "id": mcr_id,
        "machine_id": mcr.machine_id,
        "plan_id": mcr.plan_id,
        "elapsed_minutes": elapsed,
        "ideal_minutes": mcr.ideal_minutes,
        "to_model": mcr.to_model,
    })
    return _enrich(mcr, db)


@router.patch("/{mcr_id}/reject")
async def reject_request(mcr_id: int, db: Session = Depends(get_db), user=Depends(require_role("supervisor", "admin"))):
    mcr = db.query(ModelChangeRequest).filter(ModelChangeRequest.id == mcr_id).first()
    if not mcr:
        raise HTTPException(404, "Not found")
    if mcr.status != "pending":
        raise HTTPException(400, f"Only pending requests can be rejected (current: {mcr.status})")
    mcr.status = "rejected"
    db.commit()
    await manager.broadcast({
        "type": "model_change_rejected",
        "id": mcr_id,
        "machine_id": mcr.machine_id,
        "plan_id": mcr.plan_id,
    })
    return _enrich(mcr, db)


@router.get("/current-model/{machine_id}")
def get_current_model(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Return the model currently running (or last run) on a machine for From Model autofill."""
    machine = db.query(Machine).filter(Machine.id == machine_id).first()
    if not machine:
        raise HTTPException(404, "Machine not found")

    running = (
        db.query(ProductionPlan)
        .filter(
            ProductionPlan.machine_id == machine_id,
            ProductionPlan.status == "running",
        )
        .order_by(ProductionPlan.updated_at.desc(), ProductionPlan.id.desc())
        .first()
    )
    plan = running
    if not plan:
        plan = (
            db.query(ProductionPlan)
            .filter(
                ProductionPlan.machine_id == machine_id,
                ProductionPlan.status.in_(["paused", "completed"]),
            )
            .order_by(ProductionPlan.updated_at.desc(), ProductionPlan.id.desc())
            .first()
        )

    model = (plan.model_variant if plan else None) or None
    return {
        "machine_id": machine_id,
        "machine_name": machine.name,
        "model_variant": model or "",
        "plan_id": plan.id if plan else None,
        "plan_status": plan.status if plan else None,
        "current_operation": plan.current_operation if plan else None,
        "source": "running" if running else ("last_plan" if plan else "none"),
    }


@router.get("/")
def get_requests(db: Session = Depends(get_db), _=Depends(get_current_user)):
    mcrs = db.query(ModelChangeRequest).order_by(ModelChangeRequest.created_at.desc()).all()
    return [_enrich(m, db) for m in mcrs]


@router.get("/approved")
def get_approved(entry_date: str, shift: str, station_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Return total ideal_minutes for approved/completed model changes for a given date+shift+pair."""
    machines = db.query(Machine).filter(Machine.station_id == station_id).all()
    machine_ids = [m.id for m in machines]
    if not machine_ids:
        return {"total_minutes": 0, "requests": []}
    mcrs = db.query(ModelChangeRequest).filter(
        ModelChangeRequest.entry_date == entry_date,
        ModelChangeRequest.shift == shift,
        ModelChangeRequest.machine_id.in_(machine_ids),
        ModelChangeRequest.status.in_(["approved", "completed"]),
    ).all()
    total = sum(m.ideal_minutes or 0 for m in mcrs)
    return {"total_minutes": total, "requests": [_enrich(m, db) for m in mcrs]}
