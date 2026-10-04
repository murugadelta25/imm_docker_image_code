from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, model_validator
from typing import Optional, Literal
from ..models import BreakdownTicket, Machine, ProductionPlan, get_db, now_ist
from ..auth import get_current_user, require_role
from ..ws_manager import manager

from .machines import _log_status

router = APIRouter(prefix="/api/breakdown", tags=["breakdown"])

PLANNED_REASONS = {
    "Machine Preventive", "Meeting", "RM Change", "Plant Shutdown", "No Plan",
    "Mould Change", "Colour Change", "Insert Change", "Mould Trial", "Power Fail",
}
UNPLANNED_REASONS = {
    "Machine Maintenance", "No RM", "Chiller Maintenance", "Compressor Maintenance",
    "Mould Maintenance", "QC Issue", "No Manpower", "Hopper Issue", "Crane Issue",
    "No BOP", "Machine Breakdown", "Mould Polish", "Mould Breakdown", "RM Predrying",
    "Hrs Problem", "Barrel Heating Problem", "No Packing Material", "Water Leakage",
    "Oil Leakage",
}


class TicketCreate(BaseModel):
    machine_id: int
    raised_by: Optional[int] = None
    raised_by_name: Optional[str] = None
    description: Optional[str] = None
    downtime_type: Optional[Literal["planned", "unplanned"]] = None
    downtime_reason: Optional[str] = None

    @model_validator(mode="after")
    def validate_raised_by(self):
        name = (self.raised_by_name or "").strip()
        if not self.raised_by and not name:
            raise ValueError("Provide raised_by (user id) or raised_by_name")
        if self.downtime_type and self.downtime_reason:
            allowed = PLANNED_REASONS if self.downtime_type == "planned" else UNPLANNED_REASONS
            if self.downtime_reason not in allowed:
                raise ValueError(f"Invalid {self.downtime_type} downtime reason")
        return self


class TicketResolve(BaseModel):
    resolution_notes: str


def _machine_status_for_downtime(downtime_type: Optional[str]) -> str:
    if downtime_type == "planned":
        return "setting_change"
    return "breakdown"


@router.get("/reasons")
def get_downtime_reasons(_=Depends(get_current_user)):
    return {
        "planned": sorted(PLANNED_REASONS),
        "unplanned": sorted(UNPLANNED_REASONS),
    }


@router.post("/")
async def raise_ticket(data: TicketCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    raised_by_id = data.raised_by or getattr(user, "id", None)
    if not raised_by_id:
        raise HTTPException(400, "raised_by is required")

    raised_name = (data.raised_by_name or "").strip() or None
    reason = (data.downtime_reason or "").strip() or None
    dtype = data.downtime_type
    desc = (data.description or "").strip()
    if reason and not desc:
        label = "Planned" if dtype == "planned" else "Unplanned" if dtype == "unplanned" else "Downtime"
        desc = f"{label}: {reason}"
    if not desc:
        raise HTTPException(400, "description or downtime_reason is required")

    ticket = BreakdownTicket(
        machine_id=data.machine_id,
        raised_by=raised_by_id,
        raised_by_name=raised_name,
        description=desc,
        downtime_type=dtype,
        downtime_reason=reason,
        created_at=now_ist(),
    )
    db.add(ticket)
    machine = db.query(Machine).filter(Machine.id == data.machine_id).first()
    live_status = _machine_status_for_downtime(dtype)
    if machine:
        machine.status = live_status
    db.commit()
    db.refresh(ticket)
    _log_status(data.machine_id, live_status, "breakdown", db, deviation_reason=reason)
    db.commit()
    await manager.broadcast({
        "type": "breakdown_raised",
        "id": ticket.id,
        "machine_id": data.machine_id,
        "description": desc,
        "status": "raised",
        "downtime_type": dtype,
        "downtime_reason": reason,
    })
    return ticket


@router.patch("/{ticket_id}/acknowledge")
async def acknowledge_ticket(ticket_id: int, db: Session = Depends(get_db), user=Depends(require_role("maintenance", "admin", "supervisor"))):
    ticket = db.query(BreakdownTicket).filter(BreakdownTicket.id == ticket_id).first()
    if not ticket: raise HTTPException(404, "Not found")
    ticket.status = "acknowledged"
    ticket.acknowledged_by = user.id
    ticket.ack_time = now_ist()
    db.commit()
    try:
        from ..deviation_alert_service import resolve_escalation_for_machine
        resolve_escalation_for_machine(db, ticket.machine_id, 'breakdown_acknowledged')
    except Exception as exc:
        print(f"[DeviationAlert] resolve on acknowledge failed: {exc}")
    await manager.broadcast({"type": "breakdown_acknowledged", "id": ticket_id, "machine_id": ticket.machine_id})
    return ticket


@router.patch("/{ticket_id}/start")
async def start_troubleshoot(ticket_id: int, db: Session = Depends(get_db), user=Depends(require_role("maintenance", "admin", "supervisor"))):
    ticket = db.query(BreakdownTicket).filter(BreakdownTicket.id == ticket_id).first()
    if not ticket: raise HTTPException(404, "Not found")
    ticket.status = "in_progress"
    ticket.start_troubleshoot = now_ist()
    db.commit()
    await manager.broadcast({"type": "breakdown_in_progress", "id": ticket_id, "machine_id": ticket.machine_id})
    return ticket


@router.patch("/{ticket_id}/resolve")
async def resolve_ticket(ticket_id: int, data: TicketResolve, db: Session = Depends(get_db), user=Depends(require_role("maintenance", "admin", "supervisor"))):
    ticket = db.query(BreakdownTicket).filter(BreakdownTicket.id == ticket_id).first()
    if not ticket: raise HTTPException(404, "Not found")
    ticket.status = "resolved"
    ticket.resolved_time = now_ist()
    ticket.resolution_notes = data.resolution_notes
    machine = db.query(Machine).filter(Machine.id == ticket.machine_id).first()
    if machine:
        from .machines import _compute_status
        machine.status = _compute_status(machine, db)
        _log_status(ticket.machine_id, machine.status, "breakdown_resolved", db)
    db.commit()
    await manager.broadcast({"type": "breakdown_resolved", "id": ticket_id,
                              "machine_id": ticket.machine_id, "status": machine.status if machine else "idle"})
    return ticket


@router.get("/users")
def get_users(db: Session = Depends(get_db), _=Depends(get_current_user)):
    from ..models import User
    return [{"id": u.id, "username": u.username, "role": u.role}
            for u in db.query(User)
                       .filter(User.role.in_(["operator", "supervisor"]))
                       .order_by(User.role, User.username).all()]


@router.get("/")
def get_tickets(db: Session = Depends(get_db), _=Depends(get_current_user)):
    from ..models import User
    tickets = db.query(BreakdownTicket).order_by(BreakdownTicket.created_at.desc()).all()
    users = {u.id: u.username for u in db.query(User).all()}
    result = []
    for tk in tickets:
        d = {c.name: getattr(tk, c.name) for c in tk.__table__.columns}
        username = users.get(tk.raised_by, str(tk.raised_by) if tk.raised_by else "")
        d["raised_by_username"] = username
        # Prefer free-text name when provided; keep field for MaintenanceDashboard
        if not d.get("raised_by_name"):
            d["raised_by_name"] = username
        d["acknowledged_by_username"] = users.get(tk.acknowledged_by, str(tk.acknowledged_by) if tk.acknowledged_by else "")
        d["acknowledged_by_name"] = d["acknowledged_by_username"]
        result.append(d)
    return result


@router.get("/machines")
def get_machines(db: Session = Depends(get_db), _=Depends(get_current_user)):
    from .machines import _compute_status
    machines = db.query(Machine).order_by(Machine.station_id, Machine.id).all()
    result = []
    for m in machines:
        live = _compute_status(m, db)
        has_plan = db.query(ProductionPlan).filter(
            ProductionPlan.status == "running",
            (ProductionPlan.machine_id == m.id) |
            (ProductionPlan.station_no == m.station_id)
        ).first() is not None
        result.append({
            "id": m.id, "name": m.name, "station_id": m.station_id,
            "status": live, "machine_type": m.machine_type,
            "make": m.make, "model_no": m.model_no, "tonnage": m.tonnage,
            "features": m.features, "image_url": m.image_url, "location": m.location,
            "plc_source": m.plc_source, "has_plan": has_plan,
        })
    return result
