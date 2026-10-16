"""Resolve which operator is on each machine (live session preferred, else shift allocation)."""
from __future__ import annotations

from typing import Dict, Optional

from sqlalchemy.orm import Session

from .models import MachineAllocation, Operator, OperatorSession, User, now_ist


def get_live_operator_map(
    db: Session,
    entry_date=None,
    shift_id: Optional[str] = None,
) -> Dict[int, dict]:
    """
    Map machine_id → { operator_id, operator_name, operator_code, source }.
    Priority: active OperatorSession, then MachineAllocation for date+shift.
    """
    now = now_ist()
    if entry_date is None or not shift_id:
        try:
            from .routers.config import _load_config
            from .routers.machines import _resolve_shift_at_ts
            cfg = _load_config(db)
            sid, edate = _resolve_shift_at_ts(now, cfg)
            shift_id = shift_id or sid
            entry_date = entry_date or edate
        except Exception:
            shift_id = shift_id or "A"
            entry_date = entry_date or now.date()

    result: Dict[int, dict] = {}

    sessions = (
        db.query(OperatorSession)
        .filter(OperatorSession.status == "active")
        .all()
    )
    op_ids = {s.operator_id for s in sessions if s.operator_id}
    user_ids = {s.user_id for s in sessions if s.user_id and not s.operator_id}

    allocs = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.entry_date == entry_date,
            MachineAllocation.shift_id == shift_id,
            MachineAllocation.status.in_(("assigned", "acknowledged", "active")),
        )
        .all()
    )
    for a in allocs:
        if a.operator_id:
            op_ids.add(a.operator_id)
        elif a.user_id:
            user_ids.add(a.user_id)

    ops = {}
    if op_ids:
        ops = {o.id: o for o in db.query(Operator).filter(Operator.id.in_(op_ids)).all()}
    users = {}
    if user_ids:
        users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}

    def _from_operator(op: Operator):
        return {
            "operator_id": op.id,
            "operator_name": op.name or op.employee_code,
            "operator_code": op.employee_code,
        }

    def _from_user(u: User):
        return {
            "operator_id": u.id,
            "operator_name": u.username,
            "operator_code": u.username,
        }

    for s in sessions:
        info = None
        if s.operator_id and s.operator_id in ops:
            info = _from_operator(ops[s.operator_id])
        elif s.user_id and s.user_id in users:
            info = _from_user(users[s.user_id])
        else:
            info = {
                "operator_id": s.operator_id or s.user_id,
                "operator_name": s.username or "Operator",
                "operator_code": s.username,
            }
        info["source"] = "session"
        result[s.machine_id] = info

    for a in allocs:
        if a.machine_id in result:
            continue
        info = None
        if a.operator_id and a.operator_id in ops:
            info = _from_operator(ops[a.operator_id])
        elif a.user_id and a.user_id in users:
            info = _from_user(users[a.user_id])
        else:
            info = {
                "operator_id": a.operator_id or a.user_id,
                "operator_name": a.username or "Operator",
                "operator_code": a.username,
            }
        info["source"] = "allocation"
        result[a.machine_id] = info

    return result


def operator_fields_for_machine(op_map: Dict[int, dict], machine_id: int) -> dict:
    info = op_map.get(machine_id) or {}
    return {
        "operator_id": info.get("operator_id"),
        "operator_name": info.get("operator_name"),
        "operator_code": info.get("operator_code"),
        "operator_source": info.get("source"),
    }
