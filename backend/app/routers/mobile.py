"""Mobile operator app APIs — device binding, availability sessions, TPM loss logs."""
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..models import (
    Machine,
    MobileDevice,
    Operator,
    OperatorLossLog,
    OperatorSession,
    AttendanceRecord,
    MachineAllocation,
    ModelChangeRequest,
    User,
    get_db,
    now_ist,
)
from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited
from ..loss_mapping import map_loss_to_oee, ALL_OEE_LOSS_FIELDS
from ..mobile_integration import require_mobile_integration

router = APIRouter(
    prefix="/api/mobile",
    tags=["mobile"],
    dependencies=[Depends(require_mobile_integration)],
)

SESSION_PHOTO_DIR = Path(__file__).parent.parent.parent / "static" / "operator-sessions"
SESSION_PHOTO_DIR.mkdir(parents=True, exist_ok=True)


class DeviceRegister(BaseModel):
    tab_id: str = Field(..., min_length=1, max_length=100)
    machine_id: int
    mac_address: Optional[str] = None
    platform: Optional[str] = "mobile"


class SessionStart(BaseModel):
    operator_id: Optional[int] = None
    user_id: Optional[int] = None  # legacy / linked login
    username: Optional[str] = None
    machine_id: int
    tab_id: Optional[str] = None
    mac_address: Optional[str] = None
    shift_id: Optional[str] = None
    face_verified: Optional[bool] = None
    face_match_score: Optional[float] = None
    password_only: Optional[bool] = False


class SessionEnd(BaseModel):
    session_id: Optional[int] = None
    operator_id: Optional[int] = None
    user_id: Optional[int] = None
    machine_id: Optional[int] = None
    tab_id: Optional[str] = None
    logout_reason: Optional[str] = "manual"


class LossCreate(BaseModel):
    machine_id: int
    tab_id: Optional[str] = None
    operator_id: Optional[int] = None
    user_id: Optional[int] = None
    username: Optional[str] = None
    loss_code: str
    loss_description: str
    sub_division: Optional[str] = None
    minutes: Optional[float] = None  # optional when starting a timed session
    notes: Optional[str] = None
    entry_date: Optional[date] = None
    shift: Optional[str] = None


class LossStart(BaseModel):
    machine_id: int
    tab_id: Optional[str] = None
    operator_id: Optional[int] = None
    user_id: Optional[int] = None
    username: Optional[str] = None
    loss_code: str
    loss_description: str
    sub_division: Optional[str] = None
    notes: Optional[str] = None
    entry_date: Optional[date] = None
    shift: Optional[str] = None
    # Tablet press time — so network lag is not lost from logged minutes
    client_started_at: Optional[datetime] = None


class LossStop(BaseModel):
    loss_id: Optional[int] = None
    machine_id: Optional[int] = None
    notes: Optional[str] = None


def _row(obj):
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def _resolve_operator(db: Session, actor, operator_id: Optional[int] = None, user_id: Optional[int] = None) -> Operator:
    if operator_id:
        op = db.query(Operator).filter(Operator.id == operator_id).first()
        if op:
            return op
    if getattr(actor, "is_operator_principal", False):
        op = db.query(Operator).filter(Operator.id == actor.operator_id).first()
        if op:
            return op
    uid = user_id or (None if getattr(actor, "is_operator_principal", False) else getattr(actor, "id", None))
    if uid:
        op = db.query(Operator).filter(Operator.linked_user_id == uid).first()
        if op:
            return op
        user = db.query(User).filter(User.id == uid).first()
        if user:
            op = db.query(Operator).filter(Operator.employee_code == user.username).first()
            if op:
                return op
    raise HTTPException(404, "Operator profile not found. Add the operator in Operator Management.")


def _open_attendance(db: Session, operator_id: int) -> Optional[AttendanceRecord]:
    """Any open punch for this operator (not limited to today — overnight leftovers)."""
    return (
        db.query(AttendanceRecord)
        .filter(
            AttendanceRecord.operator_id == operator_id,
            AttendanceRecord.status == "open",
        )
        .order_by(AttendanceRecord.time_in.desc())
        .first()
    )


def _close_stale_opens_before_punch(
    db: Session,
    operator_id: int,
    now,
    keep_if_same_day: bool = True,
):
    """
    Close leftover open punches before creating a new one.
    Uses shift end when the shift has already ended; otherwise closes at `now`
    when starting a fresh punch on a later day.
    """
    from .operators import (
        _auto_close_stale_attendance,
        _load_operator_site_config,
        _punch_span_mins,
        _as_naive_ist,
        _shift_end_for_attendance,
    )

    cfg = _load_operator_site_config(db)
    opens = (
        db.query(AttendanceRecord)
        .filter(
            AttendanceRecord.operator_id == operator_id,
            AttendanceRecord.status == "open",
        )
        .all()
    )
    _auto_close_stale_attendance(db, opens, cfg, now=now)

    # Re-query remaining opens (shift still in progress or no shift end)
    opens = (
        db.query(AttendanceRecord)
        .filter(
            AttendanceRecord.operator_id == operator_id,
            AttendanceRecord.status == "open",
        )
        .all()
    )
    today = _as_naive_ist(now).date() if now else now_ist().date()
    for rec in opens:
        if keep_if_same_day and rec.entry_date == today:
            continue
        tin = _as_naive_ist(rec.time_in)
        if not tin:
            continue
        shift_end = _shift_end_for_attendance(rec, cfg)
        end = shift_end if shift_end and shift_end > tin else _as_naive_ist(now)
        if end < tin:
            end = tin
        rec.time_out = end
        rec.duration_mins = _punch_span_mins(tin, end, rec.entry_date)
        # Not a real operator punch-out — exclude from work-hours pair completion
        rec.status = "auto_closed"


def _attendance_punch_in(
    db: Session,
    operator_id: int,
    username: str,
    machine_id: int,
    shift_id: Optional[str],
    session_id: int,
    now,
    linked_user_id: Optional[int] = None,
):
    # Close leftovers from prior days / ended shifts before opening a new punch
    _close_stale_opens_before_punch(db, operator_id, now, keep_if_same_day=True)

    open_row = _open_attendance(db, operator_id)
    if open_row and open_row.entry_date == (now.date() if hasattr(now, "date") else now_ist().date()):
        return open_row
    if open_row:
        # Same-day leftover that wasn't closed — close at now then open fresh
        from .operators import _as_naive_ist, _punch_span_mins
        tin = _as_naive_ist(open_row.time_in)
        tout = _as_naive_ist(now)
        if tin and tout and tout >= tin:
            open_row.time_out = tout
            open_row.duration_mins = _punch_span_mins(tin, tout, open_row.entry_date)
            open_row.status = "auto_closed"

    row = AttendanceRecord(
        operator_id=operator_id,
        user_id=linked_user_id,
        username=username,
        entry_date=now.date(),
        shift_id=shift_id,
        machine_id=machine_id,
        operator_session_id=session_id,
        time_in=now,
        status="open",
        created_at=now,
    )
    db.add(row)
    return row


def _attendance_punch_out(db: Session, operator_id: int, now):
    open_row = _open_attendance(db, operator_id)
    if not open_row:
        return None
    # Normalize both sides to naive IST so duration math is stable
    def _naive(dt):
        if dt is None:
            return None
        if getattr(dt, "tzinfo", None) is not None:
            try:
                import pytz
                return dt.astimezone(pytz.timezone("Asia/Kolkata")).replace(tzinfo=None)
            except Exception:
                return dt.replace(tzinfo=None)
        return dt

    tin = _naive(open_row.time_in)
    tout = _naive(now)
    open_row.time_out = tout if tout is not None else now
    delta = (tout - tin).total_seconds() / 60.0 if tin and tout else 0.0
    if delta < 0:
        delta += 24 * 60
    if delta > 16 * 60 and tin and tout:
        # Same-day wall clock fallback for bad date components / TZ mix-ups
        ed = open_row.entry_date or tout.date()
        tin2 = datetime.combine(ed, tin.time())
        tout2 = datetime.combine(ed, tout.time())
        if tout2 < tin2:
            tout2 += timedelta(days=1)
        alt = (tout2 - tin2).total_seconds() / 60.0
        if 0 <= alt <= 16 * 60:
            delta = alt
    open_row.duration_mins = round(max(0.0, delta), 2)
    open_row.status = "closed"
    return open_row


def _find_active_sessions(db: Session, data: SessionEnd) -> list:
    q = db.query(OperatorSession).filter(OperatorSession.status == "active")
    if data.session_id:
        q = q.filter(OperatorSession.id == data.session_id)
    else:
        if data.operator_id:
            q = q.filter(OperatorSession.operator_id == data.operator_id)
        elif data.user_id:
            q = q.filter(
                (OperatorSession.operator_id == data.user_id) | (OperatorSession.user_id == data.user_id)
            )
        if data.machine_id:
            q = q.filter(OperatorSession.machine_id == data.machine_id)
        if data.tab_id:
            q = q.filter(OperatorSession.tab_id == data.tab_id)
    return q.all()


@router.post("/devices/register")
def register_device(data: DeviceRegister, db: Session = Depends(get_db), user=Depends(get_current_user)):
    machine = db.query(Machine).filter(Machine.id == data.machine_id).first()
    if not machine:
        raise HTTPException(404, "Machine not found")
    device = db.query(MobileDevice).filter(MobileDevice.tab_id == data.tab_id).first()
    now = now_ist()
    if device:
        device.machine_id = data.machine_id
        device.mac_address = data.mac_address or device.mac_address
        device.platform = data.platform or device.platform
        device.last_seen_at = now
        device.updated_at = now
    else:
        device = MobileDevice(
            tab_id=data.tab_id,
            machine_id=data.machine_id,
            mac_address=data.mac_address,
            platform=data.platform or "mobile",
            last_seen_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(device)
    db.commit()
    db.refresh(device)
    return _row(device)


@router.get("/devices")
def list_devices(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return [_row(d) for d in db.query(MobileDevice).order_by(MobileDevice.tab_id).all()]


@router.post("/sessions/start")
def start_session(data: SessionStart, db: Session = Depends(get_db), user=Depends(get_current_user)):
    op = _resolve_operator(db, user, data.operator_id, data.user_id)
    label = data.username or op.employee_code
    open_rows = (
        db.query(OperatorSession)
        .filter(
            OperatorSession.operator_id == op.id,
            OperatorSession.machine_id == data.machine_id,
            OperatorSession.status == "active",
        )
        .all()
    )
    now = now_ist()
    for row in open_rows:
        row.status = "ended"
        row.ended_at = now
        row.logout_reason = row.logout_reason or "replaced"
    sess = OperatorSession(
        operator_id=op.id,
        user_id=op.linked_user_id,
        username=label,
        machine_id=data.machine_id,
        tab_id=data.tab_id,
        mac_address=data.mac_address,
        shift_id=data.shift_id,
        face_verified=1 if data.face_verified and not data.password_only else 0,
        face_match_score=data.face_match_score if data.face_verified and not data.password_only else None,
        started_at=now,
        status="active",
    )
    db.add(sess)
    db.flush()
    _attendance_punch_in(
        db, op.id, label, data.machine_id, data.shift_id, sess.id, now, op.linked_user_id
    )
    today = now.date()
    alloc = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.machine_id == data.machine_id,
            MachineAllocation.entry_date == today,
            MachineAllocation.status.in_(("assigned", "acknowledged", "active")),
        )
        .order_by(MachineAllocation.assigned_at.desc())
        .first()
    )
    if data.shift_id and alloc and alloc.shift_id and alloc.shift_id != data.shift_id:
        alloc = (
            db.query(MachineAllocation)
            .filter(
                MachineAllocation.machine_id == data.machine_id,
                MachineAllocation.entry_date == today,
                MachineAllocation.shift_id == data.shift_id,
                MachineAllocation.status.in_(("assigned", "acknowledged", "active")),
            )
            .first()
        )
    via = "face" if (data.face_verified and not data.password_only) else "password"
    if getattr(user, "is_operator_principal", False):
        via = "pin" if via == "password" else via
    alloc_oid = (alloc.operator_id or alloc.user_id) if alloc else None
    if alloc and alloc_oid == op.id:
        alloc.status = "active"
        if not alloc.acknowledged_at:
            alloc.acknowledged_at = now
            alloc.acknowledged_via = via
    elif not alloc or alloc_oid != op.id:
        if alloc and alloc_oid != op.id and alloc.status == "assigned":
            pass
        db.add(MachineAllocation(
            entry_date=today,
            shift_id=data.shift_id or "A",
            machine_id=data.machine_id,
            operator_id=op.id,
            user_id=op.linked_user_id,
            username=label,
            status="active",
            source="login",
            assigned_by=label,
            assigned_at=now,
            acknowledged_at=now,
            acknowledged_via=via,
        ))
    if data.tab_id:
        device = db.query(MobileDevice).filter(MobileDevice.tab_id == data.tab_id).first()
        if device:
            device.last_seen_at = now
            device.machine_id = data.machine_id
    db.commit()
    db.refresh(sess)
    return _row(sess)


@router.post("/sessions/end")
def end_session(data: SessionEnd, db: Session = Depends(get_db), user=Depends(get_current_user)):
    now = now_ist()
    rows = _find_active_sessions(db, data)
    punched = set()
    for row in rows:
        row.status = "ended"
        row.ended_at = now
        row.logout_reason = data.logout_reason or "manual"
        oid = row.operator_id or row.user_id
        if oid and oid not in punched:
            _attendance_punch_out(db, oid, now)
            punched.add(oid)
    db.commit()
    return {"ended": len(rows), "ended_at": now.isoformat()}


@router.post("/verify-face")
async def verify_face(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Compare live capture against operator master reference photo.
    Live image is discarded after verification — not stored on the session.
    """
    ref_url = None
    if getattr(user, "is_operator_principal", False):
        ref_url = user.reference_photo_url
    else:
        op = db.query(Operator).filter(Operator.linked_user_id == user.id).first()
        if op and op.reference_photo_url:
            ref_url = op.reference_photo_url
        else:
            u = db.query(User).filter(User.id == user.id).first()
            ref_url = u.reference_photo_url if u else None

    if not ref_url:
        raise HTTPException(
            400,
            "No reference photo on file for this operator. Upload one in Operator Management.",
        )

    static_root = Path(__file__).parent.parent.parent / "static"
    ref_rel = ref_url.removeprefix("/static/")
    ref_path = static_root / ref_rel
    if not ref_path.exists():
        raise HTTPException(400, "Reference photo file missing. Re-upload in Operator Management.")

    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"Image too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB)")

    suffix = Path(file.filename or "live.jpg").suffix.lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
        suffix = ".jpg"
    # Lazy import — OpenCV only needed for face verify (web app runs without mobile/OpenCV)
    from ..face_verify import compare_faces, save_temp_upload
    live_path = save_temp_upload(data, suffix)
    try:
        verified, score, message = compare_faces(ref_path, live_path)
    finally:
        live_path.unlink(missing_ok=True)

    if not verified:
        raise HTTPException(403, message)
    return {"verified": True, "score": score, "message": message}


@router.post("/sessions/{session_id}/photo")
async def upload_session_photo(
    session_id: int,
    kind: str = Query(..., pattern="^(login|logout)$"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    sess = db.query(OperatorSession).filter(OperatorSession.id == session_id).first()
    if not sess:
        raise HTTPException(404, "Session not found")
    actor_oid = user.operator_id if getattr(user, "is_operator_principal", False) else None
    if not actor_oid:
        op = db.query(Operator).filter(Operator.linked_user_id == user.id).first()
        actor_oid = op.id if op else user.id
    sess_oid = sess.operator_id or sess.user_id
    if sess_oid != actor_oid and user.role not in ("admin", "superadmin", "supervisor"):
        raise HTTPException(403, "Cannot upload photo for another operator session")

    ext = Path(file.filename or "photo.jpg").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    fname = f"session_{session_id}_{kind}_{uuid.uuid4().hex[:10]}{ext}"
    fpath = SESSION_PHOTO_DIR / fname
    await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    url = f"/static/operator-sessions/{fname}"
    if kind == "login":
        sess.login_photo_url = url
    else:
        sess.logout_photo_url = url
    db.commit()
    return {"ok": True, "session_id": session_id, "kind": kind, "url": url}


@router.get("/sessions/active")
def active_sessions(
    machine_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(OperatorSession).filter(OperatorSession.status == "active")
    if machine_id:
        q = q.filter(OperatorSession.machine_id == machine_id)
    return [_row(s) for s in q.order_by(OperatorSession.started_at.desc()).all()]


@router.get("/sessions/history")
def session_history(
    machine_id: Optional[int] = None,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(OperatorSession).filter(OperatorSession.status == "ended")
    if machine_id:
        q = q.filter(OperatorSession.machine_id == machine_id)
    rows = q.order_by(OperatorSession.ended_at.desc()).limit(limit).all()
    return [_row(s) for s in rows]


@router.get("/attendance/today")
def attendance_today(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Today's attendance punch status for logged-in operator."""
    today = now_ist().date()
    op = _resolve_operator(db, user)
    open_row = _open_attendance(db, op.id)
    today_rows = (
        db.query(AttendanceRecord)
        .filter(AttendanceRecord.operator_id == op.id, AttendanceRecord.entry_date == today)
        .order_by(AttendanceRecord.time_in.desc())
        .all()
    )
    return {
        "operator_id": op.id,
        "user_id": op.id,
        "username": op.employee_code,
        "employee_code": op.employee_code,
        "name": op.name,
        "reference_photo_url": op.reference_photo_url,
        "has_reference_photo": bool(op.reference_photo_url),
        "is_punched_in": open_row is not None,
        "open_record": _row(open_row) if open_row else None,
        "today_records": [_row(r) for r in today_rows],
    }


@router.post("/attendance/punch")
def attendance_punch(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Manual punch in/out toggle (AttendTrack-style kiosk)."""
    now = now_ist()
    op = _resolve_operator(db, user)
    open_row = _open_attendance(db, op.id)
    if open_row:
        _attendance_punch_out(db, op.id, now)
        db.commit()
        return {
            "success": True,
            "action": "out",
            "time": now.strftime("%H:%M:%S"),
            "username": op.employee_code,
            "operator_id": op.id,
        }
    row = AttendanceRecord(
        operator_id=op.id,
        user_id=op.linked_user_id,
        username=op.employee_code,
        entry_date=now.date(),
        shift_id=None,
        time_in=now,
        status="open",
        created_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "success": True,
        "action": "in",
        "time": now.strftime("%H:%M:%S"),
        "username": op.employee_code,
        "operator_id": op.id,
        "record_id": row.id,
    }


@router.post("/losses")
def create_loss(data: LossCreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Manual closed loss (minutes typed) OR legacy clients."""
    if data.minutes is None or data.minutes <= 0:
        raise HTTPException(400, "minutes must be > 0 (or use /losses/start for timed logging)")
    op = None
    try:
        op = _resolve_operator(db, user, data.operator_id, data.user_id)
    except HTTPException:
        op = None
    oee_field, oee_bucket, _status = map_loss_to_oee(data.loss_code, data.sub_division)
    now = now_ist()
    row = OperatorLossLog(
        machine_id=data.machine_id,
        tab_id=data.tab_id,
        operator_id=op.id if op else data.operator_id,
        user_id=data.user_id or (None if getattr(user, "is_operator_principal", False) else getattr(user, "id", None)),
        username=data.username or (op.employee_code if op else user.username),
        loss_code=data.loss_code,
        loss_description=data.loss_description,
        sub_division=data.sub_division,
        minutes=data.minutes,
        notes=data.notes,
        entry_date=data.entry_date or now.date(),
        shift=data.shift,
        status="closed",
        started_at=now,
        ended_at=now,
        oee_field=oee_field,
        oee_bucket=oee_bucket,
        exclude_from_oee=0,
        created_at=now,
    )
    # Avoid double-count: setup loss when model-change setting already covers this shift
    if oee_field == "setting_time" and _mcr_setting_minutes(db, data.machine_id, row.entry_date, data.shift) > 0:
        row.exclude_from_oee = 1
        row.notes = ((row.notes or "") + " [excluded: model-change setting already on Data Entry]").strip()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _loss_row(row)


def _loss_row(row: OperatorLossLog):
    d = _row(row)
    # live elapsed for open sessions
    if row.status == "open" and row.started_at:
        elapsed = (now_ist() - row.started_at).total_seconds() / 60.0
        d["elapsed_mins"] = round(elapsed, 2)
    else:
        d["elapsed_mins"] = float(row.minutes) if row.minutes is not None else 0
    return d


def _mcr_setting_minutes(db: Session, machine_id: int, entry_date, shift: Optional[str]) -> float:
    q = (
        db.query(ModelChangeRequest)
        .filter(
            ModelChangeRequest.machine_id == machine_id,
            ModelChangeRequest.entry_date == entry_date,
            ModelChangeRequest.status.in_(("approved", "completed", "in_progress")),
        )
    )
    if shift:
        q = q.filter(ModelChangeRequest.shift == shift)
    return float(sum(int(r.ideal_minutes or 0) for r in q.all()))


_STATUS_PRIORITY = {
    "offline": 5,
    "breakdown": 4,
    "alarm": 3,
    "setting_change": 2,
    "idle": 1,
    "running": 0,
}


def _format_loss_deviation_reason(
    loss_code: str,
    loss_description: str,
    sub_division: Optional[str] = None,
) -> str:
    """Text shown in Loss Tracker Deviation Reason column."""
    parts = [f"{(loss_code or '').strip()} · {(loss_description or '').strip()}".strip(" ·")]
    if sub_division and str(sub_division).strip():
        parts.append(str(sub_division).strip())
    return " · ".join(p for p in parts if p)[:500]


def _backfill_loss_deviation_reasons(
    db: Session,
    machine_id: int,
    started_at,
    ended_at,
    reason: str,
):
    """Stamp tablet loss reason onto status segments covered by the timed loss window."""
    if not reason or not started_at:
        return
    from ..models import MachineStatusLog

    rows = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id == machine_id,
            MachineStatusLog.changed_at >= started_at,
            MachineStatusLog.changed_at <= ended_at,
        )
        .all()
    )
    for log in rows:
        if log.source == "operator_loss_end" and log.status == "running":
            continue
        if log.status == "running":
            continue
        # Always overwrite empty; also refresh operator_loss / sync segments in the window
        if not (log.deviation_reason or "").strip() or log.source in ("operator_loss", "sync"):
            if log.source in ("operator_loss", "sync") or not (log.deviation_reason or "").strip():
                log.deviation_reason = reason


def _apply_loss_machine_status(
    db: Session,
    machine_id: int,
    new_status: str,
    source: str = "operator_loss",
    deviation_reason: Optional[str] = None,
):
    """Update machine + Loss Tracker segment without downgrading higher-priority states."""
    from .machines import _log_status
    from ..models import BreakdownTicket, ModelChangeRequest

    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        return None
    if source.endswith("_end"):
        # Restore after timed loss — keep real BD/MCR/alarm, else back to running
        active_bd = db.query(BreakdownTicket).filter(
            BreakdownTicket.machine_id == machine_id,
            BreakdownTicket.status.in_(["raised", "acknowledged", "in_progress"]),
        ).first()
        active_mc = db.query(ModelChangeRequest).filter(
            ModelChangeRequest.machine_id == machine_id,
            ModelChangeRequest.status.in_(["approved", "in_progress"]),
        ).first()
        if active_bd:
            live = "setting_change" if getattr(active_bd, "downtime_type", None) == "planned" else "breakdown"
        elif m.status == "alarm":
            live = "alarm"
        elif active_mc:
            live = "setting_change"
        else:
            live = "running"
        if m.status != live:
            m.status = live
            return _log_status(machine_id, live, source, db)
        return None
    if not new_status:
        return None
    cur = m.status or "idle"
    if _STATUS_PRIORITY.get(new_status, 0) < _STATUS_PRIORITY.get(cur, 0) and cur in (
        "breakdown", "offline", "alarm", "setting_change",
    ):
        return None
    if m.status == new_status:
        # Same status already — still stamp reason on the latest open segment if empty
        from ..models import MachineStatusLog
        latest = (
            db.query(MachineStatusLog)
            .filter(MachineStatusLog.machine_id == machine_id)
            .order_by(MachineStatusLog.changed_at.desc(), MachineStatusLog.id.desc())
            .first()
        )
        if latest and latest.status == new_status and deviation_reason:
            if not (latest.deviation_reason or "").strip():
                latest.deviation_reason = deviation_reason
            return latest
        return None
    m.status = new_status
    return _log_status(machine_id, new_status, source, db, deviation_reason=deviation_reason)


@router.post("/losses/start")
def start_loss(data: LossStart, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Start a live timed loss — timer runs until /losses/stop."""
    open_row = (
        db.query(OperatorLossLog)
        .filter(
            OperatorLossLog.machine_id == data.machine_id,
            OperatorLossLog.status == "open",
        )
        .first()
    )
    if open_row:
        raise HTTPException(
            409,
            f"Loss already running: {open_row.loss_code} since {open_row.started_at}. Stop it first.",
        )
    op = None
    try:
        op = _resolve_operator(db, user, data.operator_id, data.user_id)
    except HTTPException:
        op = None
    oee_field, oee_bucket, machine_status = map_loss_to_oee(data.loss_code, data.sub_division)
    now = now_ist()
    # Prefer client press time when sane (not >2s in future, not older than 5 min)
    started = now
    if data.client_started_at:
        cs = data.client_started_at
        if getattr(cs, "tzinfo", None) is not None:
            # Normalize to naive IST wall-clock for DB storage
            try:
                import pytz
                cs = cs.astimezone(pytz.timezone("Asia/Kolkata")).replace(tzinfo=None)
            except Exception:
                cs = cs.replace(tzinfo=None)
        if now - timedelta(minutes=5) <= cs <= now + timedelta(seconds=2):
            started = cs
    entry_date = data.entry_date or now.date()
    exclude = 0
    notes = data.notes
    if oee_field == "setting_time" and _mcr_setting_minutes(db, data.machine_id, entry_date, data.shift) > 0:
        exclude = 1
        notes = ((notes or "") + " [excluded: model-change setting already on Data Entry]").strip()
    reason = _format_loss_deviation_reason(
        data.loss_code, data.loss_description, data.sub_division
    )
    row = OperatorLossLog(
        machine_id=data.machine_id,
        tab_id=data.tab_id,
        operator_id=op.id if op else data.operator_id,
        user_id=data.user_id or (None if getattr(user, "is_operator_principal", False) else getattr(user, "id", None)),
        username=data.username or (op.employee_code if op else user.username),
        loss_code=data.loss_code,
        loss_description=data.loss_description,
        sub_division=data.sub_division,
        minutes=0,
        notes=notes,
        entry_date=entry_date,
        shift=data.shift,
        status="open",
        started_at=started,
        ended_at=None,
        oee_field=oee_field,
        oee_bucket=oee_bucket,
        exclude_from_oee=exclude,
        created_at=now,
    )
    db.add(row)
    _apply_loss_machine_status(
        db, data.machine_id, machine_status or "idle", "operator_loss", deviation_reason=reason
    )
    db.commit()
    db.refresh(row)
    return _loss_row(row)


@router.post("/losses/stop")
def stop_loss(data: LossStop, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Stop the active timed loss and auto-log elapsed minutes."""
    q = db.query(OperatorLossLog).filter(OperatorLossLog.status == "open")
    if data.loss_id:
        q = q.filter(OperatorLossLog.id == data.loss_id)
    elif data.machine_id:
        q = q.filter(OperatorLossLog.machine_id == data.machine_id)
    else:
        raise HTTPException(400, "loss_id or machine_id required")
    row = q.order_by(OperatorLossLog.started_at.desc()).first()
    if not row:
        raise HTTPException(404, "No open loss session found")
    now = now_ist()
    started = row.started_at or now
    mins = max(0.1, round((now - started).total_seconds() / 60.0, 2))
    row.ended_at = now
    row.minutes = mins
    row.status = "closed"
    if data.notes:
        row.notes = ((row.notes or "") + " " + data.notes).strip()
    # Double-count guard for setting vs model-change
    if row.oee_field == "setting_time" and _mcr_setting_minutes(db, row.machine_id, row.entry_date, row.shift) > 0:
        row.exclude_from_oee = 1
        row.notes = ((row.notes or "") + " [excluded: model-change setting already on Data Entry]").strip()
    reason = _format_loss_deviation_reason(
        row.loss_code, row.loss_description, row.sub_division
    )
    _backfill_loss_deviation_reasons(db, row.machine_id, started, now, reason)
    _apply_loss_machine_status(db, row.machine_id, "running", "operator_loss_end")
    db.commit()
    db.refresh(row)
    return _loss_row(row)


@router.get("/losses/active")
def active_loss(
    machine_id: int = Query(...),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    row = (
        db.query(OperatorLossLog)
        .filter(OperatorLossLog.machine_id == machine_id, OperatorLossLog.status == "open")
        .order_by(OperatorLossLog.started_at.desc())
        .first()
    )
    if not row:
        return {"active": False, "loss": None}
    return {"active": True, "loss": _loss_row(row)}


@router.get("/losses/oee-rollup")
def losses_oee_rollup(
    machine_id: int = Query(...),
    entry_date: date = Query(...),
    shift: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Sum closed mobile losses into Data Entry field totals.
    setting_time from mobile is omitted when Model Change already provides setting minutes
    (prevents double-count). Open sessions contribute live elapsed minutes.
    """
    q = (
        db.query(OperatorLossLog)
        .filter(
            OperatorLossLog.machine_id == machine_id,
            OperatorLossLog.entry_date == entry_date,
        )
    )
    if shift:
        q = q.filter(OperatorLossLog.shift == shift)
    rows = q.all()
    mcr_mins = _mcr_setting_minutes(db, machine_id, entry_date, shift)
    fields = {k: 0.0 for k in ALL_OEE_LOSS_FIELDS}
    items = []
    for r in rows:
        mins = float(r.minutes or 0)
        if r.status == "open" and r.started_at:
            mins = max(mins, (now_ist() - r.started_at).total_seconds() / 60.0)
        exclude = bool(r.exclude_from_oee)
        if r.oee_field == "setting_time" and mcr_mins > 0:
            exclude = True
        if r.oee_field and r.oee_field in fields and not exclude:
            fields[r.oee_field] += mins
        items.append({
            **_loss_row(r),
            "counted_mins": round(mins, 2) if not exclude else 0,
            "excluded": exclude,
        })
    # Round for Data Entry integers
    rounded = {k: int(round(v)) for k, v in fields.items()}
    downtime = sum(rounded[k] for k in ("setting_time", "tool_change", "dimension_correction", "scrap_removal", "break_down"))
    # If MCR owns setting, expose it separately for UI
    if mcr_mins > 0:
        rounded["setting_time"] = int(mcr_mins)
        downtime = sum(rounded[k] for k in ("setting_time", "tool_change", "dimension_correction", "scrap_removal", "break_down"))
    return {
        "machine_id": machine_id,
        "entry_date": entry_date.isoformat(),
        "shift": shift,
        "fields": rounded,
        "total_down_time": downtime,
        "management_loss_total": sum(rounded[k] for k in ("no_load", "new_model_trial", "power_cut", "planned_maintenance", "no_manpower_planned")),
        "total_breaks": sum(rounded[k] for k in ("lunch_break", "tea_break", "tpm_cleaning", "other_cleaning", "management_meeting")),
        "model_change_setting_minutes": int(mcr_mins),
        "items": items,
        "count": len(items),
    }


@router.get("/losses")
def list_losses(
    machine_id: Optional[int] = None,
    entry_date: Optional[date] = None,
    shift: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(OperatorLossLog)
    if machine_id:
        q = q.filter(OperatorLossLog.machine_id == machine_id)
    if entry_date:
        q = q.filter(OperatorLossLog.entry_date == entry_date)
    if shift:
        q = q.filter(OperatorLossLog.shift == shift)
    if status:
        q = q.filter(OperatorLossLog.status == status)
    return [_loss_row(r) for r in q.order_by(OperatorLossLog.created_at.desc()).limit(200).all()]


# ---------------------------------------------------------------------------
# Pending idle / deviation reasons (separate tablet page — removable later)
# Shows Loss Tracker segments that need a TPM loss reason selected.
# ---------------------------------------------------------------------------

REASON_NEEDED_STATUSES = ("idle", "breakdown", "alarm", "offline", "setting_change")


class PendingReasonAssign(BaseModel):
    loss_code: str
    loss_description: str
    sub_division: Optional[str] = None
    notes: Optional[str] = None
    reason_text: Optional[str] = None  # optional free-text override


def _idle_limit_minutes(db: Session) -> float:
    try:
        from .config import _load_config
        cfg = _load_config(db)
        limits = (cfg or {}).get("loss_tracker_limits") or {}
        return float(limits.get("idle", 1) or 1)
    except Exception:
        return 1.0


def _status_segment_rows(db: Session, machine_id: int, hours: int = 24):
    """Build status segments with duration (newest first for UI)."""
    from datetime import timedelta as _td
    from ..models import MachineStatusLog

    since = now_ist() - _td(hours=max(1, min(hours, 168)))
    logs = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id == machine_id,
            MachineStatusLog.changed_at >= since,
        )
        .order_by(MachineStatusLog.changed_at.asc(), MachineStatusLog.id.asc())
        .all()
    )
    now = now_ist()
    segments = []
    for i, log in enumerate(logs):
        end_at = logs[i + 1].changed_at if i + 1 < len(logs) else now
        ongoing = i + 1 >= len(logs)
        secs = max(0.0, (end_at - log.changed_at).total_seconds())
        segments.append({
            "log": log,
            "ended_at": end_at,
            "ongoing": ongoing,
            "duration_sec": secs,
            "duration_mins": round(secs / 60.0, 2),
        })
    segments.reverse()
    return segments


@router.get("/pending-reasons")
def list_pending_reasons(
    machine_id: int = Query(...),
    hours: int = Query(24, ge=1, le=168),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Idle (and other) Loss Tracker segments missing a deviation reason.
    Used by the tablet Idle Reason page — can be removed independently later.
    """
    idle_limit_min = _idle_limit_minutes(db)
    idle_limit_sec = idle_limit_min * 60.0
    items = []
    for seg in _status_segment_rows(db, machine_id, hours):
        log = seg["log"]
        if log.status not in REASON_NEEDED_STATUSES:
            continue
        if (log.deviation_reason or "").strip():
            continue
        # Short idle = loading/unloading — skip unless ongoing past limit
        if log.status == "idle" and seg["duration_sec"] < idle_limit_sec and not (
            seg["ongoing"] and seg["duration_sec"] >= idle_limit_sec * 0.5
        ):
            # Still show ongoing idle once it exceeds half the limit so operator can prepare
            if not (seg["ongoing"] and seg["duration_sec"] >= 30):
                continue
        required = seg["duration_sec"] >= idle_limit_sec or log.status != "idle"
        items.append({
            "log_id": log.id,
            "status": log.status,
            "source": log.source,
            "started_at": log.changed_at.strftime("%Y-%m-%dT%H:%M:%S") if log.changed_at else None,
            "ended_at": None if seg["ongoing"] else seg["ended_at"].strftime("%Y-%m-%dT%H:%M:%S"),
            "ongoing": seg["ongoing"],
            "duration_mins": seg["duration_mins"],
            "duration_label": _fmt_duration(seg["duration_sec"]),
            "required": required,
            "idle_limit_min": idle_limit_min,
        })
    return {
        "machine_id": machine_id,
        "count": len(items),
        "required_count": sum(1 for x in items if x["required"]),
        "items": items,
    }


def _fmt_duration(secs: float) -> str:
    s = int(max(0, secs))
    if s < 60:
        return f"{s}s"
    m, rem = divmod(s, 60)
    if m < 60:
        return f"{m}m {rem}s" if rem else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


@router.post("/pending-reasons/{log_id}/assign")
def assign_pending_reason(
    log_id: int,
    data: PendingReasonAssign,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Map a Loss Tracker idle/deviation segment to a TPM loss (tablet Idle Reason page)."""
    from ..models import MachineStatusLog

    log = db.query(MachineStatusLog).filter(MachineStatusLog.id == log_id).first()
    if not log:
        raise HTTPException(404, "Status log not found")
    if log.status not in REASON_NEEDED_STATUSES:
        raise HTTPException(400, f"Status {log.status} does not require a loss reason")

    reason = (data.reason_text or "").strip() or _format_loss_deviation_reason(
        data.loss_code, data.loss_description, data.sub_division
    )
    log.deviation_reason = reason[:500]

    # Duration for OEE rollup
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

    op = None
    try:
        op = _resolve_operator(db, user, None, None)
    except HTTPException:
        op = None

    oee_field, oee_bucket, _st = map_loss_to_oee(data.loss_code, data.sub_division)
    exclude = 0
    notes = data.notes
    entry_date = log.changed_at.date() if log.changed_at else now_ist().date()
    if oee_field == "setting_time" and _mcr_setting_minutes(db, log.machine_id, entry_date, None) > 0:
        exclude = 1
        notes = ((notes or "") + " [excluded: model-change setting already on Data Entry]").strip()

    row = OperatorLossLog(
        machine_id=log.machine_id,
        operator_id=op.id if op else None,
        user_id=None if getattr(user, "is_operator_principal", False) else getattr(user, "id", None),
        username=(op.employee_code if op else getattr(user, "username", None)),
        loss_code=data.loss_code,
        loss_description=data.loss_description,
        sub_division=data.sub_division,
        minutes=mins,
        notes=((notes or "") + f" [from status-log #{log.id}]").strip(),
        entry_date=entry_date,
        shift=None,
        status="closed",
        started_at=log.changed_at,
        ended_at=end_at,
        oee_field=oee_field,
        oee_bucket=oee_bucket,
        exclude_from_oee=exclude,
        created_at=now_ist(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    try:
        from ..deviation_alert_service import resolve_escalation_for_segment
        resolve_escalation_for_segment(db, log_id, "deviation_reason_recorded")
    except Exception:
        pass
    return {
        "ok": True,
        "log_id": log_id,
        "deviation_reason": reason,
        "minutes": mins,
        "loss": _loss_row(row),
    }
