from fastapi import APIRouter, Depends, Header, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from pathlib import Path
import shutil, uuid
from datetime import datetime, timedelta
from ..models import Machine, Station, BreakdownTicket, ProductionPlan, ModelChangeRequest, MachineStatusLog, get_db, now_ist
from ..auth import get_current_user, require_role
from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited
from ..ws_manager import manager

router = APIRouter(prefix="/api/machines", tags=["machines"])

UPLOAD_DIR = Path(__file__).parent.parent.parent / "static" / "machines"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class MachineCreate(BaseModel):
    name: str
    station_id: int
    machine_type: Optional[str] = "IMM"
    make: Optional[str] = None
    model_no: Optional[str] = None
    tonnage: Optional[str] = None
    features: Optional[str] = None
    location: Optional[str] = None
    plc_source: Optional[str] = "manual"
    plc_endpoint: Optional[str] = None
    plc_topic: Optional[str] = None


class MachineUpdate(MachineCreate):
    pass


class StatusPush(BaseModel):
    status: str
    source: Optional[str] = "api"


def _compute_status(machine: Machine, db: Session) -> str:
    """Priority: offline > breakdown > alarm > setting_change > open operator loss > PLC status (running/idle) > idle"""
    # 1. Offline — highest priority
    if machine.status == "offline":
        return "offline"

    # 2. Active downtime ticket → breakdown (unplanned) or setting_change (planned)
    active_bd = db.query(BreakdownTicket).filter(
        BreakdownTicket.machine_id == machine.id,
        BreakdownTicket.status.in_(["raised", "acknowledged", "in_progress"])
    ).first()
    if active_bd:
        if getattr(active_bd, "downtime_type", None) == "planned":
            return "setting_change"
        return "breakdown"

    # 3. PLC alarm
    if machine.status == "alarm":
        return "alarm"

    # 4. Active model change request → setting_change
    active_mc = db.query(ModelChangeRequest).filter(
        ModelChangeRequest.machine_id == machine.id,
        ModelChangeRequest.status.in_(["approved", "in_progress"])
    ).first()
    if active_mc:
        return "setting_change"

    # 5. Open timed loss from tablet — only when mobile integration is enabled
    try:
        from ..mobile_integration import is_mobile_integration_enabled
        if not is_mobile_integration_enabled(db):
            pass  # fall through to PLC / idle
        else:
            from ..models import OperatorLossLog
            from ..loss_mapping import map_loss_to_oee
            from datetime import timedelta as _td
            open_loss = (
                db.query(OperatorLossLog)
                .filter(
                    OperatorLossLog.machine_id == machine.id,
                    OperatorLossLog.status == "open",
                )
                .order_by(OperatorLossLog.started_at.desc())
                .first()
            )
            if open_loss:
                # Abandoned open losses must not freeze web Loss Tracker / PLC forever
                started = open_loss.started_at
                if started and (now_ist() - started) > _td(hours=12):
                    open_loss.status = "closed"
                    open_loss.ended_at = now_ist()
                    if open_loss.minutes is None or float(open_loss.minutes or 0) <= 0:
                        open_loss.minutes = round((now_ist() - started).total_seconds() / 60.0, 2)
                    open_loss.notes = ((open_loss.notes or "") + " [auto-closed: stale open session]").strip()
                    # Persist immediately — many callers of _compute_status are read-only
                    # and never commit (unlike push_status, which already commits here).
                    try:
                        db.commit()
                    except Exception:
                        db.rollback()
                else:
                    _field, _bucket, loss_status = map_loss_to_oee(
                        open_loss.loss_code, open_loss.sub_division
                    )
                    if loss_status:
                        return loss_status
    except Exception:
        pass

    # 6. Trust PLC-pushed running/idle directly — PLC is ground truth
    if machine.status in ("running", "idle"):
        return machine.status

    return "idle"


def _log_status(machine_id: int, status: str, source: str, db: Session,
                deviation_reason: str = None):
    entry = MachineStatusLog(
        machine_id=machine_id,
        status=status,
        changed_at=now_ist(),
        source=source,
        deviation_reason=(deviation_reason or None),
    )
    db.add(entry)
    db.flush()
    try:
        from ..deviation_alert_service import on_status_logged, on_immediate_status_event
        on_status_logged(db, machine_id, entry)
        on_immediate_status_event(db, machine_id, status, source)
    except Exception as exc:
        print(f"[DeviationAlert] status hook failed: {exc}")
    return entry


def _resolve_shift_at_ts(ts: datetime, cfg: dict):
    """Resolve shift id and logical entry_date for a timestamp."""
    from .hourly_output import _parse_mins

    shifts = [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]
    if not shifts:
        shifts = [
            {"id": "A", "start": "08:00", "end": "20:00", "enabled": True},
            {"id": "B", "start": "20:00", "end": "08:00", "enabled": True},
        ]

    hhmm = ts.hour * 60 + ts.minute
    for sh in shifts:
        start_m = _parse_mins(sh.get("start", "08:00"))
        end_m = _parse_mins(sh.get("end", "20:00"))
        overnight = end_m <= start_m
        in_shift = (
            (not overnight and start_m <= hhmm < end_m)
            or (overnight and (hhmm >= start_m or hhmm < end_m))
        )
        if not in_shift:
            continue
        entry_date = ts.date()
        if overnight and hhmm < end_m:
            entry_date = entry_date - timedelta(days=1)
        return sh.get("id", "A"), entry_date

    first = shifts[0]
    return first.get("id", "A"), ts.date()


def _pick_plan_for_segment(db: Session, machine_id: int, changed_at: datetime, cfg: dict):
    """Pick the best matching production plan for one status segment."""
    shift_id, entry_date = _resolve_shift_at_ts(changed_at, cfg)
    plans = db.query(ProductionPlan).filter(
        ProductionPlan.machine_id == machine_id,
        ProductionPlan.plan_date == entry_date,
        ProductionPlan.shift == shift_id,
        ProductionPlan.status.in_(["running", "completed", "pending", "paused"]),
    ).order_by(ProductionPlan.priority, ProductionPlan.id).all()
    if not plans:
        return None
    status_rank = {"running": 0, "completed": 1, "pending": 2, "paused": 3}
    plans.sort(key=lambda p: (status_rank.get(p.status, 9), p.priority or 9999, p.id))
    return plans[0]

class ReasonUpdate(BaseModel):
    reason: str
    loss_code: Optional[str] = None
    loss_description: Optional[str] = None
    sub_division: Optional[str] = None
    create_loss_log: bool = False  # opt-in; default keeps web manual reason independent of mobile rollup


@router.patch("/status-log/{log_id}/reason")
def update_reason(log_id: int, data: ReasonUpdate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    log = db.query(MachineStatusLog).filter(MachineStatusLog.id == log_id).first()
    if not log:
        raise HTTPException(404, "Log entry not found")
    log.deviation_reason = data.reason

    # Optional: create OperatorLossLog so Data Entry / availability picks up the minutes
    loss_id = None
    if data.create_loss_log and data.loss_code:
        try:
            from ..mobile_integration import is_mobile_integration_enabled
            if not is_mobile_integration_enabled(db):
                raise RuntimeError("mobile integration off")
            from ..models import OperatorLossLog
            from ..loss_mapping import map_loss_to_oee

            nxt = (
                db.query(MachineStatusLog)
                .filter(
                    MachineStatusLog.machine_id == log.machine_id,
                    MachineStatusLog.changed_at > log.changed_at,
                )
                .order_by(MachineStatusLog.changed_at.asc())
                .first()
            )
            end_at = nxt.changed_at if nxt else now_ist()
            mins = max(0.1, round((end_at - log.changed_at).total_seconds() / 60.0, 2))
            oee_field, oee_bucket, _st = map_loss_to_oee(data.loss_code, data.sub_division)
            desc = data.loss_description or data.reason
            row = OperatorLossLog(
                machine_id=log.machine_id,
                operator_id=None,
                user_id=getattr(user, "id", None) if not getattr(user, "is_operator_principal", False) else None,
                username=getattr(user, "username", None) or getattr(user, "employee_code", None),
                loss_code=data.loss_code,
                loss_description=desc[:100],
                sub_division=data.sub_division,
                minutes=mins,
                notes=f"Assigned from Loss Tracker status-log #{log.id}",
                entry_date=log.changed_at.date() if log.changed_at else now_ist().date(),
                shift=None,
                status="closed",
                started_at=log.changed_at,
                ended_at=end_at,
                oee_field=oee_field,
                oee_bucket=oee_bucket,
                exclude_from_oee=0,
                created_at=now_ist(),
            )
            db.add(row)
            db.flush()
            loss_id = row.id
        except Exception as exc:
            print(f"[ReasonUpdate] loss log create skipped: {exc}")

    db.commit()
    try:
        from ..deviation_alert_service import resolve_escalation_for_segment
        resolve_escalation_for_segment(db, log_id, 'deviation_reason_recorded')
    except Exception as exc:
        print(f"[DeviationAlert] resolve on reason failed: {exc}")
    return {"ok": True, "loss_log_id": loss_id}


def _machine_public_dict(m: Machine, station: Optional[Station] = None, live_status: Optional[str] = None) -> dict:
    """JSON-safe machine payload (avoids ORM/Enum serialization edge cases)."""
    status = live_status if live_status is not None else (m.status or "idle")
    if hasattr(status, "value"):
        status = status.value
    plc_source = m.plc_source or "manual"
    if hasattr(plc_source, "value"):
        plc_source = plc_source.value
    return {
        "id": m.id,
        "name": m.name,
        "station_id": m.station_id,
        "station_name": station.display_name if station else "Unknown",
        "machine_type": m.machine_type,
        "make": m.make,
        "model_no": m.model_no,
        "tonnage": m.tonnage,
        "features": m.features,
        "location": m.location,
        "image_url": m.image_url,
        "plc_source": plc_source,
        "plc_endpoint": m.plc_endpoint,
        "plc_topic": m.plc_topic,
        "status": status,
    }


@router.get("/")
def list_machines(
    include_energy: bool = False,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """List production machines with live display status.

    Energy / utility tag hosts (EM_PLANT, machine_type ENERGY|UTILITY) are excluded
    by default — they are not production machines. Pass include_energy=true only for admin tooling.

    Important: do NOT write status-log / deviation hooks on every GET — Dashboard and
    other pages poll this endpoint and that side-effect path can exceed client timeouts.
    """
    from ..energy_meter import is_energy_utility_machine
    from ..operator_presence import get_live_operator_map, operator_fields_for_machine

    machines = db.query(Machine).order_by(Machine.station_id, Machine.id).all()
    if not include_energy:
        machines = [m for m in machines if not is_energy_utility_machine(m)]
    stations = {s.id: s for s in db.query(Station).all()}
    op_map = get_live_operator_map(db)
    result = []
    for m in machines:
        live_status = _compute_status(m, db)
        row = _machine_public_dict(m, stations.get(m.station_id), live_status)
        row.update(operator_fields_for_machine(op_map, m.id))
        result.append(row)
    return result


@router.get("/station-numbers")
def get_station_numbers(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Returns all stations available."""
    stations = db.query(Station).order_by(Station.id).all()
    return [{"id": s.id, "name": s.display_name} for s in stations]


@router.get("/fleet")
def get_fleet(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Returns production machines with live computed status (excludes energy utilities)."""
    from ..energy_meter import is_energy_utility_machine
    from ..operator_presence import get_live_operator_map, operator_fields_for_machine

    machines = [
        m for m in db.query(Machine).order_by(Machine.station_id, Machine.id).all()
        if not is_energy_utility_machine(m)
    ]
    stations = {s.id: s for s in db.query(Station).all()}
    op_map = get_live_operator_map(db)
    result = []
    for m in machines:
        live_status = _compute_status(m, db)
        row = _machine_public_dict(m, stations.get(m.station_id), live_status)
        row.update(operator_fields_for_machine(op_map, m.id))
        result.append(row)
    return result


@router.post("/")
async def create_machine(data: MachineCreate, db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    # Validate pair exists
    station = db.query(Station).filter(Station.id == data.station_id).first()
    if not station:
        raise HTTPException(404, f"Station with id {data.station_id} not found")
    
    m = Machine(**data.dict())
    db.add(m)
    db.flush()
    try:
        from ..factory_structure import sync_machine_to_zone
        sync_machine_to_zone(db, m.station_id, m.location)
    except Exception as exc:
        print(f"[WARN] zone station sync skipped: {exc}")
    db.commit()
    db.refresh(m)
    await manager.broadcast({"type": "machine_created", "id": m.id})
    station = db.query(Station).filter(Station.id == m.station_id).first()
    return _machine_public_dict(m, station)


@router.put("/{machine_id}")
async def update_machine(machine_id: int, data: MachineUpdate,
                         db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")

    payload = data.model_dump(exclude_unset=True) if hasattr(data, "model_dump") else data.dict(exclude_unset=True)

    # If station_id is being changed, validate it exists
    if "station_id" in payload:
        station = db.query(Station).filter(Station.id == data.station_id).first()
        if not station:
            raise HTTPException(404, f"Station with id {data.station_id} not found")

    allowed = {
        "name", "station_id", "machine_type", "make", "model_no", "tonnage",
        "features", "location", "plc_source", "plc_endpoint", "plc_topic",
    }
    for k, v in payload.items():
        if k not in allowed:
            continue
        if k == "plc_source" and v not in (None, "manual", "mqtt", "modbus", "opcua"):
            raise HTTPException(400, f"plc_source must be one of manual|mqtt|modbus|opcua (got {v!r})")
        setattr(m, k, v)
    try:
        from ..factory_structure import sync_machine_to_zone
        sync_machine_to_zone(db, m.station_id, m.location)
    except Exception as exc:
        print(f"[WARN] zone station sync skipped: {exc}")
    try:
        db.commit()
        db.refresh(m)
    except Exception as exc:
        db.rollback()
        raise HTTPException(500, f"Failed to update machine {machine_id}: {exc}") from exc
    await manager.broadcast({"type": "machine_updated", "id": m.id})
    station = db.query(Station).filter(Station.id == m.station_id).first()
    return _machine_public_dict(m, station)


@router.delete("/{machine_id}")
async def delete_machine(machine_id: int, db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    db.delete(m)
    db.commit()
    await manager.broadcast({"type": "machine_deleted", "id": machine_id})
    return {"ok": True}


@router.post("/{machine_id}/image")
async def upload_image(machine_id: int, file: UploadFile = File(...),
                       db: Session = Depends(get_db),
                       user=Depends(require_role("admin"))):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    ext = Path(file.filename).suffix
    fname = f"machine_{machine_id}_{uuid.uuid4().hex[:8]}{ext}"
    fpath = UPLOAD_DIR / fname
    await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    m.image_url = f"/static/machines/{fname}"
    db.commit()
    return {"image_url": m.image_url}


@router.patch("/{machine_id}/status")
async def push_status(
    machine_id: int,
    data: StatusPush,
    db: Session = Depends(get_db),
    x_machine_push_secret: Optional[str] = Header(None, alias="X-Machine-Push-Secret"),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
):
    """External PLC/API push — called by Node-RED, MQTT bridge, Modbus bridge.

    When MACHINE_STATUS_PUSH_SECRET (or NODE_RED_WEBHOOK_SECRET) is set in the
    environment, require matching X-Machine-Push-Secret or X-Webhook-Secret.
    """
    import os

    expected = (
        os.getenv("MACHINE_STATUS_PUSH_SECRET", "").strip()
        or os.getenv("NODE_RED_WEBHOOK_SECRET", "").strip()
    )
    if expected:
        provided = (x_machine_push_secret or x_webhook_secret or "").strip()
        if provided != expected:
            raise HTTPException(401, "Invalid or missing machine push secret")

    allowed = {"running", "idle", "breakdown", "setting_change", "alarm", "offline"}
    if data.status not in allowed:
        raise HTTPException(400, f"status must be one of {allowed}")
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    # Operator breakdown ticket takes priority — don't override with PLC idle/running
    if data.status in ("idle", "running"):
        active_bd = db.query(BreakdownTicket).filter(
            BreakdownTicket.machine_id == machine_id,
            BreakdownTicket.status.in_(["raised", "acknowledged", "in_progress"])
        ).first()
        if active_bd:
            return {"id": machine_id, "status": m.status, "source": data.source, "note": "breakdown ticket active"}
        # Active model-change (setting change in progress) takes priority — don't override
        active_mc = db.query(ModelChangeRequest).filter(
            ModelChangeRequest.machine_id == machine_id,
            ModelChangeRequest.status.in_(["approved", "in_progress"]),
        ).first()
        if active_mc:
            return {"id": machine_id, "status": m.status, "source": data.source, "note": "setting change active"}
        # Open tablet timed loss — don't override with PLC idle/running (ignore when integration off / stale)
        try:
            from ..mobile_integration import is_mobile_integration_enabled
            from ..models import OperatorLossLog
            from datetime import timedelta as _td
            if is_mobile_integration_enabled(db):
                open_loss = db.query(OperatorLossLog).filter(
                    OperatorLossLog.machine_id == machine_id,
                    OperatorLossLog.status == "open",
                ).first()
                if open_loss:
                    started = open_loss.started_at
                    if started and (now_ist() - started) > _td(hours=12):
                        open_loss.status = "closed"
                        open_loss.ended_at = now_ist()
                        if open_loss.minutes is None or float(open_loss.minutes or 0) <= 0:
                            open_loss.minutes = round((now_ist() - started).total_seconds() / 60.0, 2)
                        open_loss.notes = ((open_loss.notes or "") + " [auto-closed: stale open session]").strip()
                        db.commit()
                    else:
                        return {
                            "id": machine_id,
                            "status": m.status,
                            "source": data.source,
                            "note": "operator loss active",
                        }
        except Exception:
            pass
    if m.status == data.status:
        return {"id": machine_id, "status": m.status, "source": data.source, "note": "no change"}
    m.status = data.status
    _log_status(machine_id, data.status, data.source or "api", db)
    db.commit()
    await manager.broadcast({
        "type": "machine_status_updated",
        "id": machine_id, "status": data.status, "source": data.source
    })
    return {"id": machine_id, "status": data.status, "source": data.source}


@router.get("/{machine_id}/status-log")
def get_status_log(
    machine_id: int,
    limit: int = 500,
    date_from: str = None,
    date_to: str = None,
    stitch: bool = False,
    model_variant: str = None,
    include_plan_metrics: bool = False,
    db: Session = Depends(get_db),
    _=Depends(get_current_user)
):
    from .hourly_output import _load_config

    from datetime import datetime as dt
    q = db.query(MachineStatusLog).filter(MachineStatusLog.machine_id == machine_id)
    if date_from:
        try:
            q = q.filter(MachineStatusLog.changed_at >= dt.fromisoformat(date_from))
        except ValueError:
            pass
    if date_to:
        try:
            from datetime import timedelta as _td
            q = q.filter(MachineStatusLog.changed_at < dt.fromisoformat(date_to) + _td(days=1))
        except ValueError:
            pass
    logs = q.order_by(MachineStatusLog.changed_at.desc()).limit(limit).all()

    # Auto-fill empty Deviation Reason from tablet loss logs (only when mobile integration ON)
    try:
        from ..mobile_integration import is_mobile_integration_enabled
        if is_mobile_integration_enabled(db):
            from ..models import OperatorLossLog
            loss_rows = (
                db.query(OperatorLossLog)
                .filter(OperatorLossLog.machine_id == machine_id)
                .order_by(OperatorLossLog.started_at.desc())
                .limit(100)
                .all()
            )
            updated = False
            for loss in loss_rows:
                if not loss.started_at:
                    continue
                reason_parts = [f"{loss.loss_code} · {loss.loss_description}"]
                if loss.sub_division:
                    reason_parts.append(loss.sub_division)
                reason = " · ".join(reason_parts)[:500]
                end_at = loss.ended_at or now_ist()
                from datetime import timedelta as _td
                win_start = loss.started_at - _td(seconds=2)
                win_end = end_at + _td(seconds=2)
                for log in logs:
                    if log.changed_at < win_start or log.changed_at > win_end:
                        continue
                    if log.status == "running" or log.source == "operator_loss_end":
                        continue
                    if not (log.deviation_reason or "").strip():
                        log.deviation_reason = reason
                        updated = True
            if updated:
                db.commit()
    except Exception as exc:
        print(f"[LossReasonSync] skipped: {exc}")

    result = []
    cfg = _load_config(db) if include_plan_metrics else {}
    hourly_cfg = cfg.get("hourly_output") if include_plan_metrics else {}
    ld_unld_max_sec = int((hourly_cfg or {}).get("ld_unld_max_sec", 60))

    for i, l in enumerate(logs):
        end_dt = logs[i - 1].changed_at if i > 0 else None
        duration_sec = max(0.0, (end_dt - l.changed_at).total_seconds()) if end_dt else 0.0
        row = {
            "id": l.id, "status": l.status,
            "changed_at": l.changed_at.strftime('%Y-%m-%dT%H:%M:%S'),
            "end_time": end_dt.strftime('%Y-%m-%dT%H:%M:%S') if end_dt else None,
            "source": l.source,
            "deviation_reason": l.deviation_reason or "",
        }
        if include_plan_metrics:
            plan = _pick_plan_for_segment(db, machine_id, l.changed_at, cfg)
            process_time_sec = float(plan.process_time or 0) if plan else 0.0
            loading_unloading_sec = float(plan.loading_unloading or 0) if plan else 0.0
            is_ld_unld = l.status == "idle" and 0 < duration_sec < ld_unld_max_sec
            row["process_time_sec"] = process_time_sec
            row["loading_unloading_sec"] = loading_unloading_sec
            row["running_completion_pct"] = (
                round(min(100.0, (duration_sec / process_time_sec) * 100), 2)
                if l.status == "running" and process_time_sec > 0 and duration_sec > 0
                else None
            )
            row["ld_unld_completion_pct"] = (
                round(min(100.0, (duration_sec / loading_unloading_sec) * 100), 2)
                if is_ld_unld and loading_unloading_sec > 0
                else None
            )
        result.append(row)

    if stitch and model_variant:
        try:
            from ..models import Part
            import json as _json
            part = db.query(Part).filter(
                (Part.part_no == model_variant) | (Part.model_variant == model_variant),
                Part.active == 1,
            ).first()
            if part and getattr(part, 'cycle_profile_json', None):
                profile = _json.loads(part.cycle_profile_json)
                # Only stitch when interruptions > 0 is explicitly configured
                if isinstance(profile, dict) and int(profile.get('interruptions') or 0) > 0:
                    from ..cycle_stitcher import stitch_cycles
                    result = stitch_cycles(result, profile)
                    for row in result:
                        row.pop('_consumed', None)
        except Exception as exc:
            print(f"[CycleStitcher] error: {exc}")

    return result


@router.get("/{machine_id}")
def get_machine(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    try:
        live_status = _compute_status(m, db)
        station = db.query(Station).filter(Station.id == m.station_id).first()
        return _machine_public_dict(m, station, live_status)
    except Exception as exc:
        # Fall back to stored fields so a status-compute glitch does not 500 the page
        print(f"[machines] get_machine({machine_id}) status compute failed: {exc}")
        station = db.query(Station).filter(Station.id == m.station_id).first()
        return _machine_public_dict(m, station)
