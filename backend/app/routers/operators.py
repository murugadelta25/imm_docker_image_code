"""Operator Management — directory, roster, allocation, work hours, reports.

Operators live in the `operators` table (not User Management).
"""
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional, List
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import (
    create_access_token,
    get_current_user,
    hash_password,
    require_role,
    verify_password,
)
from ..models import (
    AttendanceRecord,
    Machine,
    MachineAllocation,
    Operator,
    OperatorRosterDay,
    OperatorSession,
    Station,
    User,
    get_db,
    now_ist,
)
from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited

router = APIRouter(prefix="/api/operators", tags=["operators"])

ROSTER_STATUSES = ("Present", "Absent", "Leave", "Week Off")
OP_PHOTO_DIR = Path(__file__).parent.parent.parent / "static" / "operator-reference"
OP_PHOTO_DIR.mkdir(parents=True, exist_ok=True)


def _unlink_reference_photo_file(photo_url: Optional[str]) -> None:
    """Remove a local /static/operator-reference/* file if present (ignore missing)."""
    if not photo_url:
        return
    # Only delete files under our managed directory — never follow absolute/external URLs
    prefix = "/static/operator-reference/"
    if not str(photo_url).startswith(prefix):
        return
    name = Path(str(photo_url)[len(prefix):]).name
    if not name or name in (".", ".."):
        return
    path = OP_PHOTO_DIR / name
    try:
        if path.is_file() and path.resolve().parent == OP_PHOTO_DIR.resolve():
            path.unlink()
    except OSError:
        pass


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _week_dates(week_start: date) -> List[date]:
    return [week_start + timedelta(days=i) for i in range(7)]


def _as_naive_ist(dt: Optional[datetime]) -> Optional[datetime]:
    """Normalize datetimes to naive IST wall-clock for duration math."""
    if dt is None:
        return None
    if getattr(dt, "tzinfo", None) is not None:
        try:
            import pytz
            return dt.astimezone(pytz.timezone("Asia/Kolkata")).replace(tzinfo=None)
        except Exception:
            return dt.replace(tzinfo=None)
    return dt


def _load_operator_site_config(db: Session) -> dict:
    from .config import DEFAULT_CONFIG, merge_config
    import json

    from ..models import SiteConfig

    row = db.query(SiteConfig).first()
    if row and row.config_json:
        return merge_config(json.loads(row.config_json))
    return dict(DEFAULT_CONFIG)


def _shift_def_for(cfg: dict, shift_id: Optional[str]) -> Optional[dict]:
    shifts = [s for s in (cfg or {}).get("shifts", []) if s.get("enabled", True)]
    if shift_id:
        found = next((s for s in shifts if s.get("id") == shift_id), None)
        if found:
            return found
    return shifts[0] if shifts else None


def _shift_end_for_attendance(rec: AttendanceRecord, cfg: dict) -> Optional[datetime]:
    """Wall-clock shift end for an attendance row (handles overnight shifts)."""
    from .hourly_output import _shift_window

    sh = _shift_def_for(cfg, getattr(rec, "shift_id", None))
    if not sh:
        return None
    ed = rec.entry_date or (_as_naive_ist(rec.time_in).date() if rec.time_in else None)
    if not ed:
        return None
    _, end = _shift_window(ed, sh)
    return end


def _effective_punch_out(
    rec: AttendanceRecord,
    cfg: dict,
    now: Optional[datetime] = None,
) -> Optional[datetime]:
    """
    Punch-out used for duration:
    - closed row → time_out
    - open row → min(now, shift end) while shift in progress; else shift end
    """
    tin = _as_naive_ist(rec.time_in)
    tout = _as_naive_ist(rec.time_out)
    if tin and tout:
        return tout
    if not tin:
        return None
    now_n = _as_naive_ist(now or now_ist())
    shift_end = _shift_end_for_attendance(rec, cfg)
    if shift_end is None:
        return now_n
    # Past shift end (or next day): lock to shift end — never run open punches forever
    if now_n >= shift_end:
        return shift_end
    # Still inside shift: live duration until now
    return now_n


def _punch_span_mins(tin: datetime, tout: datetime, entry_date: Optional[date] = None) -> float:
    """Minutes between punch in/out with overnight + absurd-span guards."""
    secs = (tout - tin).total_seconds()
    if secs < 0:
        secs += 24 * 3600
    mins = secs / 60.0
    if mins > 16 * 60:
        ed = entry_date or tin.date()
        tin2 = datetime.combine(ed, tin.time())
        tout2 = datetime.combine(ed, tout.time())
        if tout2 < tin2:
            tout2 += timedelta(days=1)
        alt = (tout2 - tin2).total_seconds() / 60.0
        if 0 < alt <= 16 * 60:
            mins = alt
    return round(max(0.0, min(mins, 16 * 60)), 2)


def _punch_worked_mins(
    rec: AttendanceRecord,
    now: Optional[datetime] = None,
    cfg: Optional[dict] = None,
) -> float:
    """
    Worked minutes for one attendance row.
    Prefer time_in → time_out; if still open, use shift end (not unbounded now).
    """
    tin = _as_naive_ist(rec.time_in)
    if not tin:
        if rec.duration_mins is not None:
            return float(rec.duration_mins)
        return 0.0

    effective_cfg = cfg if cfg is not None else {}
    tout = _effective_punch_out(rec, effective_cfg, now=now)
    if not tout:
        if rec.duration_mins is not None:
            return float(rec.duration_mins)
        return 0.0

    # Never credit time before punch-in or after a backdated end
    if tout < tin:
        shift_end = _shift_end_for_attendance(rec, effective_cfg)
        if shift_end and shift_end > tin:
            tout = shift_end
        else:
            return 0.0

    return _punch_span_mins(tin, tout, rec.entry_date)


def _auto_close_stale_attendance(
    db: Session,
    rows: List[AttendanceRecord],
    cfg: dict,
    now: Optional[datetime] = None,
) -> bool:
    """Persist-close open punches whose shift has already ended (status=auto_closed).

    auto_closed outs are housekeeping only — they do NOT count as a real punch-out
    for work-hours totals.
    """
    now_n = _as_naive_ist(now or now_ist())
    changed = False
    for rec in rows:
        if getattr(rec, "status", None) != "open" or rec.time_out is not None:
            continue
        tin = _as_naive_ist(rec.time_in)
        if not tin:
            continue
        shift_end = _shift_end_for_attendance(rec, cfg)
        if not shift_end or now_n < shift_end:
            continue
        rec.time_out = shift_end
        rec.duration_mins = _punch_span_mins(tin, shift_end, rec.entry_date)
        rec.status = "auto_closed"
        changed = True
    return changed


def _is_in_last_hour_of_shift(
    punch_dt: datetime,
    entry_date: date,
    shift_id: Optional[str],
    cfg: dict,
) -> bool:
    """True when punch falls in the final hour of the shift window."""
    from .hourly_output import _shift_window

    sh = _shift_def_for(cfg, shift_id)
    if not sh:
        return False
    _, shift_end = _shift_window(entry_date, sh)
    window_start = shift_end - timedelta(hours=1)
    # small grace after shift end (tablet clock skew)
    window_end = shift_end + timedelta(minutes=15)
    return window_start <= punch_dt <= window_end


def _enabled_shift_ids(cfg: dict) -> List[str]:
    return [s["id"] for s in (cfg or {}).get("shifts", []) if s.get("enabled", True) and s.get("id")]


def _shift_id_at(dt: Optional[datetime], cfg: dict) -> Optional[str]:
    """Which enabled shift window contains this timestamp."""
    if not dt:
        return None
    from .hourly_output import _shift_window

    dt = _as_naive_ist(dt)
    for sh in (cfg or {}).get("shifts", []):
        if not sh.get("enabled", True):
            continue
        for base in (dt.date(), dt.date() - timedelta(days=1)):
            start, end = _shift_window(base, sh)
            if start <= dt < end:
                return sh.get("id")
    return None


def _is_forward_adjacent_shift(in_shift: Optional[str], out_shift: Optional[str], cfg: dict) -> bool:
    """True if out_shift is the same shift or the next enabled shift after in_shift."""
    if not in_shift or not out_shift:
        return False
    if in_shift == out_shift:
        return True
    ids = _enabled_shift_ids(cfg)
    if in_shift not in ids or out_shift not in ids:
        return False
    i = ids.index(in_shift)
    return ids[(i + 1) % len(ids)] == out_shift


def _empty_punch_summary(**overrides) -> dict:
    base = {
        "punch_in": None,
        "punch_out": None,
        "in_missing": False,
        "out_missing": False,
        "complete": False,
        "worked_mins": 0.0,
        "status": "none",
        "shift_id": None,
    }
    base.update(overrides)
    return base


def _shift_summary_dict(
    shift_id: Optional[str],
    punch_in: Optional[datetime],
    punch_out: Optional[datetime],
    *,
    in_missing: bool,
    out_missing: bool,
    entry_date: date,
) -> dict:
    complete = bool(punch_in and punch_out and not in_missing and not out_missing)
    worked = _punch_span_mins(punch_in, punch_out, entry_date) if complete else 0.0
    if in_missing and out_missing:
        status = "none"
    elif in_missing:
        status = "in_missing"
    elif out_missing:
        status = "out_missing"
    elif complete:
        status = "complete"
    else:
        status = "none"
    return {
        "shift_id": shift_id,
        "punch_in": punch_in,
        "punch_out": punch_out,
        "in_missing": in_missing,
        "out_missing": out_missing,
        "complete": complete,
        "worked_mins": worked,
        "status": status,
    }


def _summarize_day_punches(
    att_rows: List[AttendanceRecord],
    day_date: date,
    cfg: dict,
) -> dict:
    """
    Day punch summary with First-In/Last-Out and cross-shift rules.

    - Same shift or next (forward-adjacent) shift: first punch = in, last punch = out,
      duration counts (e.g. A 10:56 → B 20:00).
    - Non-adjacent shifts (e.g. A → C, skipping B): shift A out = missing; the later
      punch becomes punch-in for shift C (not punch-out).
    - Synthetic shift-end closes never count as real outs.
    """
    rows = sorted(
        att_rows,
        key=lambda a: (_as_naive_ist(a.time_in) or datetime.min, a.id or 0),
    )

    moments: List[dict] = []
    for a in rows:
        tin = _as_naive_ist(a.time_in)
        tout = _as_naive_ist(a.time_out)
        status = (getattr(a, "status", None) or "").lower()
        if tin:
            sid = _shift_id_at(tin, cfg) or a.shift_id
            moments.append({"t": tin, "shift_id": sid, "kind": "in"})
        if status == "closed" and tout:
            se = _shift_end_for_attendance(a, cfg)
            if se and tout == se:
                continue  # synthetic — ignore as out moment
            sid = _shift_id_at(tout, cfg) or a.shift_id
            moments.append({"t": tout, "shift_id": sid, "kind": "out"})
        # open / auto_closed: only the time_in moment (already added)

    moments.sort(key=lambda m: m["t"])

    if not moments:
        empty = _empty_punch_summary()
        empty["shift_summaries"] = []
        return empty

    # Single punch in last hour of its shift → out only
    if len(moments) == 1:
        m = moments[0]
        sid = m["shift_id"]
        if _is_in_last_hour_of_shift(m["t"], day_date, sid, cfg):
            ss = _shift_summary_dict(sid, None, m["t"], in_missing=True, out_missing=False, entry_date=day_date)
            out = dict(ss)
            out["shift_summaries"] = [ss]
            return out
        ss = _shift_summary_dict(sid, m["t"], None, in_missing=False, out_missing=True, entry_date=day_date)
        out = dict(ss)
        out["shift_summaries"] = [ss]
        return out

    first = moments[0]
    last = moments[-1]
    s_first = first["shift_id"]
    s_last = last["shift_id"]

    # Same or next shift → FILO complete (first in, last out)
    if s_first and s_last and _is_forward_adjacent_shift(s_first, s_last, cfg):
        punch_in = first["t"]
        punch_out = last["t"]
        # Lone near-zero span in last hour → out only
        if len(moments) == 2 and abs((punch_out - punch_in).total_seconds()) <= 60:
            if _is_in_last_hour_of_shift(punch_in, day_date, s_first, cfg):
                ss = _shift_summary_dict(
                    s_first, None, punch_out or punch_in,
                    in_missing=True, out_missing=False, entry_date=day_date,
                )
                out = dict(ss)
                out["shift_summaries"] = [ss]
                return out
        label = s_first if s_first == s_last else f"{s_first}→{s_last}"
        ss = _shift_summary_dict(
            label, punch_in, punch_out,
            in_missing=False, out_missing=False, entry_date=day_date,
        )
        # Also expose primary shift id as the in-shift for filters
        ss["shift_id"] = s_first
        ss["shift_span"] = label
        out = dict(ss)
        out["shift_summaries"] = [ss]
        return out

    # Non-adjacent (e.g. A → C): split segments per shift
    shift_order: List[str] = []
    for m in moments:
        sid = m["shift_id"] or "?"
        if sid not in shift_order:
            shift_order.append(sid)

    shift_summaries = []
    for sid in shift_order:
        sm = [m for m in moments if (m["shift_id"] or "?") == sid]
        if not sm:
            continue

        # Lone punch on a later non-adjacent shift → counts as IN for that shift (not out)
        if sid == s_last and sid != s_first and len(sm) == 1:
            shift_summaries.append(_shift_summary_dict(
                sid, sm[-1]["t"], None,
                in_missing=False, out_missing=True, entry_date=day_date,
            ))
            continue

        # Opening shift with only one punch while a later non-adjacent punch exists
        # → in present, out missing (do not steal the later punch as this shift's out)
        if sid == s_first and sid != s_last and len(sm) == 1:
            shift_summaries.append(_shift_summary_dict(
                sid, sm[0]["t"], None,
                in_missing=False, out_missing=True, entry_date=day_date,
            ))
            continue

        # Enough punches inside this shift → FILO within the shift
        if len(sm) >= 2:
            shift_summaries.append(_shift_summary_dict(
                sid, sm[0]["t"], sm[-1]["t"],
                in_missing=False, out_missing=False, entry_date=day_date,
            ))
            continue

        # Single punch mid-sequence
        if _is_in_last_hour_of_shift(sm[0]["t"], day_date, sid, cfg):
            shift_summaries.append(_shift_summary_dict(
                sid, None, sm[0]["t"],
                in_missing=True, out_missing=False, entry_date=day_date,
            ))
        else:
            shift_summaries.append(_shift_summary_dict(
                sid, sm[0]["t"], None,
                in_missing=False, out_missing=True, entry_date=day_date,
            ))

    if not shift_summaries:
        empty = _empty_punch_summary()
        empty["shift_summaries"] = []
        return empty

    # Day-level rollup: prefer first summary for top-level fields; worked = sum of completes
    total_worked = sum(float(s["worked_mins"] or 0) for s in shift_summaries if s.get("complete"))
    primary = shift_summaries[0]
    out = dict(primary)
    out["worked_mins"] = total_worked
    out["complete"] = any(s.get("complete") for s in shift_summaries)
    # If multiple incomplete segments, day-level shows first segment's missing flags
    if len(shift_summaries) > 1 and not out["complete"]:
        out["status"] = "split"
    out["shift_summaries"] = shift_summaries
    return out


def _serialize_punch_summary(summary: dict) -> dict:
    """ISO-serialize datetimes in a punch summary dict (shift or day level)."""
    return {
        "shift_id": summary.get("shift_id"),
        "shift_span": summary.get("shift_span"),
        "punch_in": summary["punch_in"].isoformat() if summary.get("punch_in") else None,
        "punch_out": summary["punch_out"].isoformat() if summary.get("punch_out") else None,
        "in_missing": bool(summary.get("in_missing")),
        "out_missing": bool(summary.get("out_missing")),
        "complete": bool(summary.get("complete")),
        "punch_status": summary.get("status") or "none",
        "worked_mins": round(float(summary.get("worked_mins") or 0), 1),
    }


def _op_row(op: Operator):
    return {
        "id": op.id,
        "operator_id": op.id,
        "employee_code": op.employee_code,
        "name": op.name,
        "username": op.employee_code,  # tablet / legacy display alias
        "is_temporary": bool(op.is_temporary),
        "is_active": bool(op.is_active),
        "has_pin": bool(op.pin_hash),
        "has_web_login": bool(op.linked_user_id),
        "reference_photo_url": op.reference_photo_url,
        "has_reference_photo": bool(op.reference_photo_url),
        "linked_user_id": op.linked_user_id,
        "notes": op.notes,
    }


def _display_name(op: Operator) -> str:
    return op.name or op.employee_code


def _resolve_operator_for_user(db: Session, user: User) -> Optional[Operator]:
    if not user:
        return None
    op = db.query(Operator).filter(Operator.linked_user_id == user.id).first()
    if op:
        return op
    return db.query(Operator).filter(Operator.employee_code == user.username).first()


def _ensure_operator_login_user(db: Session, op: Operator, password: str) -> User:
    """
    Ensure a User Management login exists for this operator (role=operator).
    Username = employee_code so they can sign into the PMS web/tablet app.
    Never silently overwrite passwords for elevated web roles.
    """
    if len(password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    pwd_hash = hash_password(password)
    protected_roles = ("admin", "superadmin", "supervisor", "quality", "maintenance")

    if op.linked_user_id:
        user = db.query(User).filter(User.id == op.linked_user_id).first()
        if user:
            if user.role in protected_roles:
                raise HTTPException(
                    400,
                    f"Linked account '{user.username}' has role '{user.role}' — "
                    "change password in User Management, not Operator Directory.",
                )
            user.password_hash = pwd_hash
            if user.role != "operator":
                user.role = "operator"
            return user

    existing = db.query(User).filter(User.username == op.employee_code).first()
    if existing:
        other = (
            db.query(Operator)
            .filter(Operator.linked_user_id == existing.id, Operator.id != op.id)
            .first()
        )
        if other:
            raise HTTPException(
                400,
                f"Login username '{op.employee_code}' is already linked to operator {other.employee_code}",
            )
        if existing.role in protected_roles:
            raise HTTPException(
                400,
                f"Username '{op.employee_code}' already belongs to a {existing.role} web user. "
                "Use a different employee code, or link manually without resetting that password.",
            )
        # Re-link an existing operator login only (safe for web-only sites)
        existing.password_hash = pwd_hash
        existing.role = "operator"
        op.linked_user_id = existing.id
        return existing

    user = User(
        username=op.employee_code,
        password_hash=pwd_hash,
        role="operator",
        reference_photo_url=op.reference_photo_url,
    )
    db.add(user)
    db.flush()
    op.linked_user_id = user.id
    return user


# ── Directory CRUD ──────────────────────────────────────────────

class OperatorCreate(BaseModel):
    employee_code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    is_temporary: bool = False
    is_active: bool = True
    password: str = Field(..., min_length=4, description="PMS web/app login password (username = employee code)")
    pin: Optional[str] = None  # optional tablet PIN; defaults to password if omitted
    notes: Optional[str] = None
    linked_user_id: Optional[int] = None


class OperatorUpdate(BaseModel):
    name: Optional[str] = None
    is_temporary: Optional[bool] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None  # set/change web login password; creates login if missing
    pin: Optional[str] = None  # set blank string to clear
    clear_pin: bool = False
    notes: Optional[str] = None
    linked_user_id: Optional[int] = None
    clear_linked_user: bool = False


class OperatorLogin(BaseModel):
    employee_code: str
    pin: str


@router.get("/")
def list_operators(
    active_only: bool = Query(True),
    include_temporary: bool = Query(True),
    q: Optional[str] = Query(None, description="Search code or name"),
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    query = db.query(Operator)
    if active_only:
        query = query.filter(Operator.is_active == 1)
    if not include_temporary:
        query = query.filter(Operator.is_temporary == 0)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (Operator.employee_code.ilike(like)) | (Operator.name.ilike(like))
        )
    total = query.count()
    rows = query.order_by(Operator.employee_code).offset(offset).limit(limit).all()
    return {"total": total, "operators": [_op_row(o) for o in rows]}


@router.post("/")
def create_operator(
    data: OperatorCreate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    code = data.employee_code.strip()
    if not code:
        raise HTTPException(400, "employee_code is required")
    if db.query(Operator).filter(Operator.employee_code == code).first():
        raise HTTPException(400, "Employee code already exists")
    if data.linked_user_id:
        user = db.query(User).filter(User.id == data.linked_user_id).first()
        if not user:
            raise HTTPException(404, "Linked user not found")
        if db.query(Operator).filter(Operator.linked_user_id == data.linked_user_id).first():
            raise HTTPException(400, "That user is already linked to another operator")
    pin_value = data.pin if (data.pin is not None and data.pin != "") else data.password
    if pin_value is not None and len(pin_value) < 4:
        raise HTTPException(400, "PIN/password must be at least 4 characters")
    now = now_ist()
    op = Operator(
        employee_code=code,
        name=data.name.strip(),
        is_temporary=1 if data.is_temporary else 0,
        is_active=1 if data.is_active else 0,
        pin_hash=hash_password(pin_value) if pin_value else None,
        linked_user_id=data.linked_user_id,
        notes=data.notes,
        created_at=now,
        updated_at=now,
    )
    db.add(op)
    db.flush()
    # Default: create operator-role login (username = employee code) for PMS web/app
    if not data.linked_user_id:
        _ensure_operator_login_user(db, op, data.password)
    db.commit()
    db.refresh(op)
    return _op_row(op)


@router.post("/login")
def operator_login(data: OperatorLogin, db: Session = Depends(get_db)):
    """Tablet login for operators (PIN) — does not use User Management."""
    code = data.employee_code.strip()
    op = db.query(Operator).filter(Operator.employee_code == code).first()
    if not op or not op.is_active:
        raise HTTPException(401, "Invalid employee code or PIN")
    if not op.pin_hash or not verify_password(data.pin, op.pin_hash):
        raise HTTPException(401, "Invalid employee code or PIN")
    token = create_access_token({
        "sub": f"op:{op.employee_code}",
        "typ": "operator",
        "operator_id": op.id,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "operator": _op_row(op),
    }


# ── Roster ──────────────────────────────────────────────────────

class RosterCell(BaseModel):
    operator_id: int
    username: Optional[str] = None  # display / code
    entry_date: date
    status: str = "Present"


class RosterSave(BaseModel):
    week_start: date
    shift_id: str = Field(..., min_length=1, max_length=1)
    cells: List[RosterCell]


@router.get("/roster")
def get_roster(
    week_start: Optional[date] = Query(None),
    shift_id: str = Query("A"),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    today = now_ist().date()
    ws = _monday(week_start or today)
    if shift_id not in ("A", "B", "C"):
        shift_id = "A"
    days = _week_dates(ws)
    operators = (
        db.query(Operator)
        .filter(Operator.is_active == 1)
        .order_by(Operator.employee_code)
        .all()
    )
    rows = (
        db.query(OperatorRosterDay)
        .filter(
            OperatorRosterDay.week_start == ws,
            OperatorRosterDay.shift_id == shift_id,
        )
        .all()
    )
    by_key = {}
    for r in rows:
        oid = r.operator_id or r.user_id
        if oid is not None:
            by_key[(oid, r.entry_date.isoformat())] = r.status
    grid = []
    for op in operators:
        day_map = {}
        for d in days:
            key = (op.id, d.isoformat())
            default = "Week Off" if d.weekday() == 6 else "Present"
            day_map[d.isoformat()] = by_key.get(key, default)
        grid.append({
            "operator_id": op.id,
            "user_id": op.id,  # backward-compatible for older UI
            "employee_code": op.employee_code,
            "name": op.name,
            "username": op.employee_code,
            "is_temporary": bool(op.is_temporary),
            "days": day_map,
        })
    return {
        "week_start": ws.isoformat(),
        "shift_id": shift_id,
        "dates": [d.isoformat() for d in days],
        "statuses": list(ROSTER_STATUSES),
        "operators": grid,
    }


@router.put("/roster")
def save_roster(
    data: RosterSave,
    db: Session = Depends(get_db),
    current=Depends(require_role("admin", "superadmin", "supervisor")),
):
    if data.shift_id not in ("A", "B", "C"):
        raise HTTPException(400, "shift_id must be A, B, or C")
    ws = _monday(data.week_start)
    now = now_ist()
    for cell in data.cells:
        if cell.status not in ROSTER_STATUSES:
            raise HTTPException(400, f"Invalid status: {cell.status}")
        op = db.query(Operator).filter(Operator.id == cell.operator_id).first()
        if not op:
            raise HTTPException(404, f"Operator {cell.operator_id} not found")
        label = cell.username or op.employee_code
        row = (
            db.query(OperatorRosterDay)
            .filter(
                OperatorRosterDay.week_start == ws,
                OperatorRosterDay.entry_date == cell.entry_date,
                OperatorRosterDay.shift_id == data.shift_id,
                OperatorRosterDay.operator_id == cell.operator_id,
            )
            .first()
        )
        if row:
            row.status = cell.status
            row.username = label
            row.user_id = op.linked_user_id
            row.updated_at = now
            row.updated_by = current.username
        else:
            db.add(OperatorRosterDay(
                week_start=ws,
                entry_date=cell.entry_date,
                shift_id=data.shift_id,
                operator_id=op.id,
                user_id=op.linked_user_id,
                username=label,
                status=cell.status,
                updated_at=now,
                updated_by=current.username,
            ))
    db.commit()
    return {"ok": True, "week_start": ws.isoformat(), "shift_id": data.shift_id, "saved": len(data.cells)}


@router.get("/roster/available")
def roster_available(
    entry_date: date = Query(...),
    shift_id: str = Query("A"),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    """Operators marked Present for date+shift (for allocation dropdowns)."""
    ws = _monday(entry_date)
    rows = (
        db.query(OperatorRosterDay)
        .filter(
            OperatorRosterDay.week_start == ws,
            OperatorRosterDay.entry_date == entry_date,
            OperatorRosterDay.shift_id == shift_id,
            OperatorRosterDay.status == "Present",
        )
        .all()
    )
    if rows:
        out = []
        for r in rows:
            oid = r.operator_id
            if not oid:
                continue
            op = db.query(Operator).filter(Operator.id == oid).first()
            out.append({
                "operator_id": oid,
                "user_id": oid,
                "employee_code": op.employee_code if op else r.username,
                "name": op.name if op else r.username,
                "username": (op.employee_code if op else r.username),
                "is_temporary": bool(op.is_temporary) if op else False,
            })
        if out:
            return out
    ops = db.query(Operator).filter(Operator.is_active == 1).order_by(Operator.employee_code).all()
    return [{
        "operator_id": o.id,
        "user_id": o.id,
        "employee_code": o.employee_code,
        "name": o.name,
        "username": o.employee_code,
        "is_temporary": bool(o.is_temporary),
    } for o in ops]


# ── Machine allocation ──────────────────────────────────────────

class AllocationItem(BaseModel):
    machine_id: int
    operator_id: Optional[int] = None
    user_id: Optional[int] = None  # legacy alias → operator_id


class AllocationSave(BaseModel):
    entry_date: date
    shift_id: str = Field(..., min_length=1, max_length=1)
    assignments: List[AllocationItem]


def _alloc_dict(a: MachineAllocation, machine: Optional[Machine] = None, station: Optional[Station] = None, db: Session = None):
    oid = a.operator_id or a.user_id
    op_name = a.username
    op_code = a.username
    if db is not None and a.operator_id:
        op = db.query(Operator).filter(Operator.id == a.operator_id).first()
        if op:
            op_name = op.name or op.employee_code
            op_code = op.employee_code
    return {
        "id": a.id,
        "entry_date": a.entry_date.isoformat() if a.entry_date else None,
        "shift_id": a.shift_id,
        "machine_id": a.machine_id,
        "machine_name": machine.name if machine else None,
        "station_name": station.display_name if station else (station.name if station else None),
        "operator_id": oid,
        "user_id": oid,
        "username": a.username,
        "operator_name": op_name,
        "operator_code": op_code,
        "status": a.status,
        "source": a.source,
        "assigned_by": a.assigned_by,
        "assigned_at": a.assigned_at.isoformat() if a.assigned_at else None,
        "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
        "acknowledged_via": a.acknowledged_via,
    }


@router.get("/allocation")
def get_allocation(
    entry_date: Optional[date] = Query(None),
    shift_id: str = Query("A"),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    if shift_id not in ("A", "B", "C"):
        shift_id = "A"
    d = entry_date or now_ist().date()
    machines = db.query(Machine).order_by(Machine.station_id, Machine.name).all()
    stations = {s.id: s for s in db.query(Station).all()}
    allocs = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.entry_date == d,
            MachineAllocation.shift_id == shift_id,
            MachineAllocation.status != "cancelled",
        )
        .all()
    )
    by_machine = {a.machine_id: a for a in allocs}
    sessions = (
        db.query(OperatorSession)
        .filter(OperatorSession.status == "active")
        .all()
    )
    sess_by_machine = {s.machine_id: s for s in sessions}

    items = []
    for m in machines:
        a = by_machine.get(m.id)
        st = stations.get(m.station_id)
        sess = sess_by_machine.get(m.id)
        live = None
        if sess:
            live_name = sess.username
            live_code = sess.username
            if sess.operator_id:
                op = db.query(Operator).filter(Operator.id == sess.operator_id).first()
                if op:
                    live_name = op.name or op.employee_code
                    live_code = op.employee_code
            live = {
                "operator_id": sess.operator_id or sess.user_id,
                "user_id": sess.operator_id or sess.user_id,
                "username": sess.username,
                "operator_name": live_name,
                "operator_code": live_code,
                "started_at": sess.started_at.isoformat() if sess.started_at else None,
                "shift_id": sess.shift_id,
            }
        items.append({
            "machine_id": m.id,
            "machine_name": m.name,
            "station_id": m.station_id,
            "station_name": st.display_name if st else None,
            "allocation": _alloc_dict(a, m, st, db) if a else None,
            "live_session": live,
        })
    return {"entry_date": d.isoformat(), "shift_id": shift_id, "machines": items}


@router.put("/allocation")
def save_allocation(
    data: AllocationSave,
    db: Session = Depends(get_db),
    current=Depends(require_role("admin", "superadmin", "supervisor")),
):
    if data.shift_id not in ("A", "B", "C"):
        raise HTTPException(400, "shift_id must be A, B, or C")
    now = now_ist()
    saved = 0
    for item in data.assignments:
        machine = db.query(Machine).filter(Machine.id == item.machine_id).first()
        if not machine:
            raise HTTPException(404, f"Machine {item.machine_id} not found")

        existing = (
            db.query(MachineAllocation)
            .filter(
                MachineAllocation.entry_date == data.entry_date,
                MachineAllocation.shift_id == data.shift_id,
                MachineAllocation.machine_id == item.machine_id,
                MachineAllocation.status != "cancelled",
            )
            .first()
        )

        oid = item.operator_id if item.operator_id is not None else item.user_id
        if not oid:
            if existing and existing.status == "assigned":
                existing.status = "cancelled"
                saved += 1
            continue

        op = db.query(Operator).filter(Operator.id == oid).first()
        if not op:
            raise HTTPException(404, f"Operator {oid} not found")
        if not op.is_active:
            raise HTTPException(400, f"Operator {op.employee_code} is inactive")

        if existing:
            cur_oid = existing.operator_id or existing.user_id
            if cur_oid != op.id:
                existing.status = "cancelled"
                db.add(MachineAllocation(
                    entry_date=data.entry_date,
                    shift_id=data.shift_id,
                    machine_id=item.machine_id,
                    operator_id=op.id,
                    user_id=op.linked_user_id,
                    username=op.employee_code,
                    status="assigned",
                    source="web",
                    assigned_by=current.username,
                    assigned_at=now,
                ))
                saved += 1
        else:
            db.add(MachineAllocation(
                entry_date=data.entry_date,
                shift_id=data.shift_id,
                machine_id=item.machine_id,
                operator_id=op.id,
                user_id=op.linked_user_id,
                username=op.employee_code,
                status="assigned",
                source="web",
                assigned_by=current.username,
                assigned_at=now,
            ))
            saved += 1
    db.commit()
    return {"ok": True, "saved": saved}


# ── Tablet: pending assignment + acknowledge ────────────────────

@router.get("/assignment/pending")
def pending_assignment(
    machine_id: int = Query(...),
    entry_date: Optional[date] = None,
    shift_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    d = entry_date or now_ist().date()
    q = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.machine_id == machine_id,
            MachineAllocation.entry_date == d,
            MachineAllocation.status.in_(("assigned", "acknowledged")),
        )
    )
    if shift_id:
        q = q.filter(MachineAllocation.shift_id == shift_id)
    row = q.order_by(MachineAllocation.assigned_at.desc()).first()
    if not row:
        return {"pending": False, "assignment": None}
    machine = db.query(Machine).filter(Machine.id == machine_id).first()
    op = None
    if row.operator_id:
        op = db.query(Operator).filter(Operator.id == row.operator_id).first()
    elif row.user_id:
        op = db.query(Operator).filter(Operator.linked_user_id == row.user_id).first()
    oid = (op.id if op else None) or row.operator_id or row.user_id
    return {
        "pending": row.status == "assigned",
        "assignment": {
            **_alloc_dict(row, machine),
            "reference_photo_url": op.reference_photo_url if op else None,
            "operator_id": oid,
            "employee_code": op.employee_code if op else row.username,
            "operator_username": op.employee_code if op else row.username,
            "operator_name": op.name if op else row.username,
            "is_temporary": bool(op.is_temporary) if op else False,
            "has_pin": bool(op.pin_hash) if op else False,
        },
    }


class AckBody(BaseModel):
    allocation_id: int
    via: str = "password"  # password|face|pin
    operator_id: Optional[int] = None


@router.post("/assignment/acknowledge")
def acknowledge_assignment(
    data: AckBody,
    db: Session = Depends(get_db),
    current=Depends(get_current_user),
):
    row = db.query(MachineAllocation).filter(MachineAllocation.id == data.allocation_id).first()
    if not row:
        raise HTTPException(404, "Allocation not found")
    assigned_oid = row.operator_id
    actor_op = _resolve_operator_for_user(db, current)
    # Operator JWT: sub starts with op:
    is_admin = current.role in ("admin", "superadmin", "supervisor")
    allowed = is_admin
    if not allowed and actor_op and assigned_oid and actor_op.id == assigned_oid:
        allowed = True
    if not allowed and data.operator_id and assigned_oid and data.operator_id == assigned_oid:
        # PIN login path may pass operator_id explicitly when token is operator-typed
        # (handled below via typ check in get_current_user extension — fallback linked user)
        pass
    if not allowed and assigned_oid and getattr(current, "id", None):
        # legacy: allocation still keyed by user_id
        if row.user_id and row.user_id == current.id:
            allowed = True
    # Operator token: username is op:CODE — check token payload via employee_code match
    if not allowed and isinstance(getattr(current, "username", None), str):
        uname = current.username
        if uname.startswith("op:"):
            code = uname[3:]
            op = db.query(Operator).filter(Operator.employee_code == code).first()
            if op and assigned_oid and op.id == assigned_oid:
                allowed = True
    if not allowed:
        raise HTTPException(403, "Only the assigned operator can acknowledge this machine")
    if row.status == "cancelled":
        raise HTTPException(400, "Allocation was cancelled")
    now = now_ist()
    row.status = "acknowledged"
    row.acknowledged_at = now
    row.acknowledged_via = data.via if data.via in ("password", "face", "pin") else "password"
    db.commit()
    return {"ok": True, "allocation": _alloc_dict(row)}


# ── Work hours (me + admin view) ────────────────────────────────

def _work_hours_payload(db: Session, operator_id: int, week_start: date):
    days = _week_dates(week_start)
    end = days[-1]
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        raise HTTPException(404, "Operator not found")

    cfg = _load_operator_site_config(db)
    now = now_ist()

    attendance = (
        db.query(AttendanceRecord)
        .filter(
            AttendanceRecord.operator_id == operator_id,
            AttendanceRecord.entry_date >= week_start,
            AttendanceRecord.entry_date <= end,
        )
        .order_by(AttendanceRecord.entry_date, AttendanceRecord.time_in)
        .all()
    )
    # Include legacy rows keyed by linked user
    if op.linked_user_id:
        legacy = (
            db.query(AttendanceRecord)
            .filter(
                AttendanceRecord.user_id == op.linked_user_id,
                AttendanceRecord.operator_id.is_(None),
                AttendanceRecord.entry_date >= week_start,
                AttendanceRecord.entry_date <= end,
            )
            .all()
        )
        attendance = sorted(
            list({a.id: a for a in (attendance + legacy)}.values()),
            key=lambda a: (a.entry_date, a.time_in or datetime.min),
        )

    # Close open punches whose shift already ended (e.g. forgot punch-out)
    healed_any = _auto_close_stale_attendance(db, attendance, cfg, now=now)

    # Reclassify older synthetic closes (exact shift-end outs) so they don't count as real outs
    for a in attendance:
        if (getattr(a, "status", None) or "").lower() != "closed" or not a.time_out:
            continue
        se = _shift_end_for_attendance(a, cfg)
        tout = _as_naive_ist(a.time_out)
        if se and tout == se:
            a.status = "auto_closed"
            healed_any = True

    sessions = (
        db.query(OperatorSession)
        .filter(
            OperatorSession.operator_id == operator_id,
            OperatorSession.started_at >= datetime.combine(week_start, datetime.min.time()),
            OperatorSession.started_at < datetime.combine(end + timedelta(days=1), datetime.min.time()),
        )
        .order_by(OperatorSession.started_at)
        .all()
    )
    allocs = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.operator_id == operator_id,
            MachineAllocation.entry_date >= week_start,
            MachineAllocation.entry_date <= end,
            MachineAllocation.status != "cancelled",
        )
        .all()
    )
    roster = (
        db.query(OperatorRosterDay)
        .filter(
            OperatorRosterDay.operator_id == operator_id,
            OperatorRosterDay.week_start == week_start,
        )
        .all()
    )
    machines = {m.id: m.name for m in db.query(Machine).all()}

    day_rows = []
    total_mins = 0.0
    for d in days:
        ds = d.isoformat()
        att = [a for a in attendance if a.entry_date == d]
        sess = [s for s in sessions if s.started_at and s.started_at.date() == d]
        al = [a for a in allocs if a.entry_date == d]
        rost = [r for r in roster if r.entry_date == d]

        summary = _summarize_day_punches(att, d, cfg)
        shift_summaries = summary.get("shift_summaries") or [summary]
        # Only complete shift segments contribute to week total
        mins = sum(
            float(s.get("worked_mins") or 0)
            for s in shift_summaries
            if s.get("complete")
        )
        total_mins += mins

        punch_payload = []
        for a in att:
            row_complete = (
                (getattr(a, "status", None) or "").lower() == "closed"
                and a.time_in
                and a.time_out
            )
            se = _shift_end_for_attendance(a, cfg)
            tout = _as_naive_ist(a.time_out)
            synthetic = bool(se and tout and tout == se)
            calc = _punch_span_mins(
                _as_naive_ist(a.time_in),
                tout,
                a.entry_date,
            ) if row_complete and not synthetic else 0.0
            punch_payload.append({
                "time_in": a.time_in.isoformat() if a.time_in else None,
                "time_out": a.time_out.isoformat() if a.time_out else None,
                "duration_mins": calc if row_complete and not synthetic else None,
                "shift_id": a.shift_id,
                "machine_id": a.machine_id,
                "machine_name": machines.get(a.machine_id) if a.machine_id else None,
                "status": a.status,
                "counts_as_out": (
                    (getattr(a, "status", None) or "").lower() == "closed" and not synthetic
                ),
            })

        serialized_shifts = [_serialize_punch_summary(s) for s in shift_summaries]
        primary = serialized_shifts[0] if serialized_shifts else _serialize_punch_summary(
            _empty_punch_summary()
        )

        day_rows.append({
            "date": ds,
            "weekday": d.strftime("%a"),
            "roster": [{"shift_id": r.shift_id, "status": r.status} for r in rost],
            "allocations": [{
                "machine_id": a.machine_id,
                "machine_name": machines.get(a.machine_id),
                "shift_id": a.shift_id,
                "status": a.status,
            } for a in al],
            "punches": punch_payload,
            "sessions": [{
                "machine_id": s.machine_id,
                "machine_name": machines.get(s.machine_id),
                "shift_id": s.shift_id,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                "status": s.status,
            } for s in sess],
            "punch_in": primary.get("punch_in"),
            "punch_out": primary.get("punch_out"),
            "in_missing": primary.get("in_missing"),
            "out_missing": primary.get("out_missing"),
            "complete": any(s.get("complete") for s in serialized_shifts),
            "punch_status": summary.get("status") or primary.get("punch_status") or "none",
            "shift_id": primary.get("shift_id"),
            "worked_mins": round(mins, 1),
            "shift_summaries": serialized_shifts,
        })

    if healed_any:
        db.commit()

    return {
        "operator": _op_row(op),
        "user": _op_row(op),
        "week_start": week_start.isoformat(),
        "dates": [d.isoformat() for d in days],
        "days": day_rows,
        "total_worked_mins": round(total_mins, 1),
        "total_worked_hrs": round(total_mins / 60.0, 2),
        "shifts": [
            {"id": s.get("id"), "start": s.get("start"), "end": s.get("end")}
            for s in cfg.get("shifts", []) if s.get("enabled", True)
        ],
    }


@router.get("/me/work-hours")
def my_work_hours(
    week_start: Optional[date] = None,
    db: Session = Depends(get_db),
    current=Depends(get_current_user),
):
    ws = _monday(week_start or now_ist().date())
    op = _resolve_operator_for_user(db, current)
    if not op and getattr(current, "username", "").startswith("op:"):
        code = current.username[3:]
        op = db.query(Operator).filter(Operator.employee_code == code).first()
    if not op:
        # Supervisors/admins have no shop-floor operator row — return empty week (not 404)
        days = _week_dates(ws)
        return {
            "operator": None,
            "user": {
                "id": getattr(current, "id", None),
                "username": getattr(current, "username", None),
                "role": getattr(current, "role", None),
                "reference_photo_url": getattr(current, "reference_photo_url", None),
                "has_reference_photo": bool(getattr(current, "reference_photo_url", None)),
            },
            "week_start": ws.isoformat(),
            "dates": [d.isoformat() for d in days],
            "days": [{
                "date": d.isoformat(),
                "weekday": d.strftime("%a"),
                "roster": [],
                "allocations": [],
                "punches": [],
                "sessions": [],
                "punch_in": None,
                "punch_out": None,
                "in_missing": False,
                "out_missing": False,
                "complete": False,
                "punch_status": "none",
                "worked_mins": 0,
            } for d in days],
            "total_worked_mins": 0,
            "total_worked_hrs": 0,
            "message": "No operator profile linked to this login. Shop-floor hours appear for Operator Directory accounts.",
        }
    return _work_hours_payload(db, op.id, ws)


@router.get("/{operator_id}/work-hours")
def operator_work_hours(
    operator_id: int,
    week_start: Optional[date] = None,
    db: Session = Depends(get_db),
    current=Depends(get_current_user),
):
    op_self = _resolve_operator_for_user(db, current)
    if (not op_self or op_self.id != operator_id) and current.role not in ("admin", "superadmin", "supervisor"):
        raise HTTPException(403, "Not allowed")
    ws = _monday(week_start or now_ist().date())
    return _work_hours_payload(db, operator_id, ws)


# ── Reports ─────────────────────────────────────────────────────

@router.get("/reports/attendance")
def attendance_report(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    shift_id: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    today = now_ist().date()
    start = from_date or (today - timedelta(days=6))
    end = to_date or today
    q = (
        db.query(AttendanceRecord)
        .filter(AttendanceRecord.entry_date >= start, AttendanceRecord.entry_date <= end)
    )
    if shift_id:
        q = q.filter(AttendanceRecord.shift_id == shift_id)
    rows = q.order_by(AttendanceRecord.entry_date.desc(), AttendanceRecord.time_in.desc()).all()
    machines = {m.id: m.name for m in db.query(Machine).all()}

    alloc_map = {}
    allocs = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.entry_date >= start,
            MachineAllocation.entry_date <= end,
            MachineAllocation.status != "cancelled",
        )
        .all()
    )
    for a in allocs:
        key_id = a.operator_id or a.user_id
        alloc_map[(a.entry_date.isoformat(), a.shift_id or "", key_id)] = a

    out = []
    for r in rows:
        key_id = r.operator_id or r.user_id
        key = (r.entry_date.isoformat(), r.shift_id or "", key_id)
        al = alloc_map.get(key)
        mid = r.machine_id or (al.machine_id if al else None)
        out.append({
            "date": r.entry_date.isoformat(),
            "operator_id": key_id,
            "user_id": key_id,
            "username": r.username,
            "shift_id": r.shift_id,
            "machine_id": mid,
            "machine_name": machines.get(mid) if mid else None,
            "time_in": r.time_in.isoformat() if r.time_in else None,
            "time_out": r.time_out.isoformat() if r.time_out else None,
            "duration_mins": float(r.duration_mins) if r.duration_mins is not None else None,
            "status": r.status,
            "allocation_status": al.status if al else None,
        })
    return {
        "from_date": start.isoformat(),
        "to_date": end.isoformat(),
        "rows": out,
        "count": len(out),
    }


@router.get("/reports/machine-run")
def machine_run_report(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    machine_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    today = now_ist().date()
    start = from_date or (today - timedelta(days=6))
    end = to_date or today
    machines = {m.id: m.name for m in db.query(Machine).all()}

    q = (
        db.query(MachineAllocation)
        .filter(
            MachineAllocation.entry_date >= start,
            MachineAllocation.entry_date <= end,
            MachineAllocation.status != "cancelled",
        )
    )
    if machine_id:
        q = q.filter(MachineAllocation.machine_id == machine_id)
    allocs = q.order_by(MachineAllocation.entry_date.desc()).all()

    sess_q = db.query(OperatorSession).filter(
        OperatorSession.started_at >= datetime.combine(start, datetime.min.time()),
        OperatorSession.started_at < datetime.combine(end + timedelta(days=1), datetime.min.time()),
    )
    if machine_id:
        sess_q = sess_q.filter(OperatorSession.machine_id == machine_id)
    sessions = sess_q.order_by(OperatorSession.started_at.desc()).all()

    return {
        "from_date": start.isoformat(),
        "to_date": end.isoformat(),
        "allocations": [{
            **_alloc_dict(a),
            "machine_name": machines.get(a.machine_id),
        } for a in allocs],
        "sessions": [{
            "id": s.id,
            "operator_id": s.operator_id or s.user_id,
            "user_id": s.operator_id or s.user_id,
            "username": s.username,
            "machine_id": s.machine_id,
            "machine_name": machines.get(s.machine_id),
            "shift_id": s.shift_id,
            "started_at": s.started_at.isoformat() if s.started_at else None,
            "ended_at": s.ended_at.isoformat() if s.ended_at else None,
            "status": s.status,
            "logout_reason": s.logout_reason,
        } for s in sessions],
    }

# ── Operator CRUD by id (keep AFTER static paths like /roster, /allocation, /me/*) ──

@router.get("/{operator_id}")
def get_operator(
    operator_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        raise HTTPException(404, "Operator not found")
    return _op_row(op)


@router.put("/{operator_id}")
def update_operator(
    operator_id: int,
    data: OperatorUpdate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        raise HTTPException(404, "Operator not found")
    if data.name is not None:
        op.name = data.name.strip()
    if data.is_temporary is not None:
        op.is_temporary = 1 if data.is_temporary else 0
    if data.is_active is not None:
        op.is_active = 1 if data.is_active else 0
    if data.notes is not None:
        op.notes = data.notes
    if data.clear_pin:
        op.pin_hash = None
    elif data.pin is not None and data.pin != "":
        if len(data.pin) < 4:
            raise HTTPException(400, "PIN must be at least 4 characters")
        op.pin_hash = hash_password(data.pin)
    if data.clear_linked_user:
        op.linked_user_id = None
    elif data.linked_user_id is not None:
        user = db.query(User).filter(User.id == data.linked_user_id).first()
        if not user:
            raise HTTPException(404, "Linked user not found")
        other = (
            db.query(Operator)
            .filter(Operator.linked_user_id == data.linked_user_id, Operator.id != operator_id)
            .first()
        )
        if other:
            raise HTTPException(400, "That user is already linked to another operator")
        op.linked_user_id = data.linked_user_id
    # Create or update PMS web login (username = employee_code, role = operator)
    if data.password is not None and data.password != "":
        _ensure_operator_login_user(db, op, data.password)
        # Keep tablet PIN in sync when password is set and PIN not explicitly cleared
        if not data.clear_pin and (data.pin is None or data.pin == ""):
            op.pin_hash = hash_password(data.password)
    op.updated_at = now_ist()
    db.commit()
    db.refresh(op)
    return _op_row(op)


@router.delete("/{operator_id}")
def deactivate_operator(
    operator_id: int,
    hard: bool = Query(False),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin")),
):
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        raise HTTPException(404, "Operator not found")
    if hard:
        _unlink_reference_photo_file(op.reference_photo_url)
        db.delete(op)
    else:
        op.is_active = 0
        op.updated_at = now_ist()
    db.commit()
    return {"ok": True, "hard": hard}


@router.post("/{operator_id}/reference-photo")
async def upload_operator_photo(
    operator_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    op = db.query(Operator).filter(Operator.id == operator_id).first()
    if not op:
        raise HTTPException(404, "Operator not found")
    ext = Path(file.filename or "photo.jpg").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    fname = f"op_{operator_id}_{uuid.uuid4().hex[:10]}{ext}"
    fpath = OP_PHOTO_DIR / fname
    await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    old_url = op.reference_photo_url
    op.reference_photo_url = f"/static/operator-reference/{fname}"
    op.updated_at = now_ist()
    if op.linked_user_id:
        user = db.query(User).filter(User.id == op.linked_user_id).first()
        if user:
            user.reference_photo_url = op.reference_photo_url
    db.commit()
    if old_url and old_url != op.reference_photo_url:
        _unlink_reference_photo_file(old_url)
    return {"ok": True, "operator_id": operator_id, "reference_photo_url": op.reference_photo_url}



