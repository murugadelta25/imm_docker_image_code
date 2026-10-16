from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
import uuid
from ..models import (
    User,
    Operator,
    OperatorSession,
    AttendanceRecord,
    MachineAllocation,
    OperatorRosterDay,
    OperatorLossLog,
    BreakdownTicket,
    QcInspectionReport,
    get_db,
)
from ..auth import hash_password, get_current_user, require_role
from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited

router = APIRouter(prefix="/api/users", tags=["users"])

USER_PHOTO_DIR = Path(__file__).parent.parent.parent / "static" / "operator-reference"
USER_PHOTO_DIR.mkdir(parents=True, exist_ok=True)


def _unlink_reference_photo_file(photo_url: Optional[str]) -> None:
    if not photo_url:
        return
    prefix = "/static/operator-reference/"
    if not str(photo_url).startswith(prefix):
        return
    name = Path(str(photo_url)[len(prefix):]).name
    if not name or name in (".", ".."):
        return
    path = USER_PHOTO_DIR / name
    try:
        if path.is_file() and path.resolve().parent == USER_PHOTO_DIR.resolve():
            path.unlink()
    except OSError:
        pass


ROLES = ["operator", "supervisor", "maintenance", "admin", "quality", "superadmin"]

class UserCreate(BaseModel):
    username: str
    password: str
    role: str

class UserUpdate(BaseModel):
    role: Optional[str] = None
    password: Optional[str] = None  # blank = don't change

class PasswordChange(BaseModel):
    current_password: str
    new_password: str

@router.get("/")
def list_users(db: Session = Depends(get_db), _=Depends(get_current_user)):
    users = db.query(User).order_by(User.role, User.username).all()
    return [{"id": u.id, "username": u.username, "role": u.role, "reference_photo_url": u.reference_photo_url, "has_reference_photo": bool(u.reference_photo_url)} for u in users]

@router.get("/me")
def get_me(current=Depends(get_current_user)):
    return {
        "id": current.id,
        "username": current.username,
        "role": current.role,
        "reference_photo_url": current.reference_photo_url,
        "has_reference_photo": bool(current.reference_photo_url),
    }

@router.post("/")
def create_user(data: UserCreate, db: Session = Depends(get_db),
                current=Depends(require_role("admin"))):
    if data.role not in ROLES:
        raise HTTPException(400, f"role must be one of {ROLES}")
    if data.role == "superadmin" and current.role != "superadmin":
        raise HTTPException(403, "Only superadmin can create superadmin users")
    if db.query(User).filter(User.username == data.username).first():
        raise HTTPException(400, "Username already exists")
    if len(data.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    u = User(username=data.username, password_hash=hash_password(data.password), role=data.role)
    db.add(u)
    db.commit()
    db.refresh(u)
    return {"id": u.id, "username": u.username, "role": u.role}

@router.put("/{user_id}")
def update_user(user_id: int, data: UserUpdate, db: Session = Depends(get_db),
                current=Depends(require_role("admin"))):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if u.id == current.id and data.role and data.role != current.role:
        raise HTTPException(400, "Cannot change your own role")
    if data.role:
        if data.role not in ROLES:
            raise HTTPException(400, f"role must be one of {ROLES}")
        if data.role == "superadmin" and current.role != "superadmin":
            raise HTTPException(403, "Only superadmin can assign superadmin role")
        if u.role == "superadmin" and current.role != "superadmin":
            raise HTTPException(403, "Only superadmin can modify superadmin users")
        u.role = data.role
    if data.password:
        if len(data.password) < 4:
            raise HTTPException(400, "Password must be at least 4 characters")
        u.password_hash = hash_password(data.password)
    db.commit()
    return {"id": u.id, "username": u.username, "role": u.role, "reference_photo_url": u.reference_photo_url}

@router.post("/{user_id}/reference-photo")
async def upload_reference_photo(
    user_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current=Depends(require_role("admin", "supervisor")),
):
    """Master reference photo for mobile operator face verification."""
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    ext = Path(file.filename or "photo.jpg").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    fname = f"user_{user_id}_{uuid.uuid4().hex[:10]}{ext}"
    fpath = USER_PHOTO_DIR / fname
    await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    old_url = u.reference_photo_url
    u.reference_photo_url = f"/static/operator-reference/{fname}"
    db.commit()
    if old_url and old_url != u.reference_photo_url:
        _unlink_reference_photo_file(old_url)
    return {"ok": True, "user_id": user_id, "reference_photo_url": u.reference_photo_url}


def _unlink_user_references(db: Session, user_id: int, reassign_to: int) -> dict:
    """
    Detach login user from shop-floor / history rows so the users row can be deleted.
    Keeps operator directory records and historical rows (nulls legacy user_id where allowed).
    Non-nullable FKs (e.g. breakdown raised_by) are reassigned to the deleting admin.
    """
    counts = {}
    linked = db.query(Operator).filter(Operator.linked_user_id == user_id).all()
    for op in linked:
        op.linked_user_id = None
    counts["operators_unlinked"] = len(linked)

    counts["roster"] = (
        db.query(OperatorRosterDay)
        .filter(OperatorRosterDay.user_id == user_id)
        .update({OperatorRosterDay.user_id: None}, synchronize_session=False)
    )
    counts["allocations"] = (
        db.query(MachineAllocation)
        .filter(MachineAllocation.user_id == user_id)
        .update({MachineAllocation.user_id: None}, synchronize_session=False)
    )
    counts["attendance"] = (
        db.query(AttendanceRecord)
        .filter(AttendanceRecord.user_id == user_id)
        .update({AttendanceRecord.user_id: None}, synchronize_session=False)
    )
    counts["sessions"] = (
        db.query(OperatorSession)
        .filter(OperatorSession.user_id == user_id)
        .update({OperatorSession.user_id: None}, synchronize_session=False)
    )
    counts["losses"] = (
        db.query(OperatorLossLog)
        .filter(OperatorLossLog.user_id == user_id)
        .update({OperatorLossLog.user_id: None}, synchronize_session=False)
    )
    counts["qc_submitted_by"] = (
        db.query(QcInspectionReport)
        .filter(QcInspectionReport.submitted_by == user_id)
        .update({QcInspectionReport.submitted_by: None}, synchronize_session=False)
    )
    # Non-nullable: reassign ticket ownership so the login account can be removed
    counts["breakdown_reassigned"] = (
        db.query(BreakdownTicket)
        .filter(BreakdownTicket.raised_by == user_id)
        .update({BreakdownTicket.raised_by: reassign_to}, synchronize_session=False)
    )
    if hasattr(BreakdownTicket, "acknowledged_by"):
        counts["breakdown_ack_cleared"] = (
            db.query(BreakdownTicket)
            .filter(BreakdownTicket.acknowledged_by == user_id)
            .update({BreakdownTicket.acknowledged_by: None}, synchronize_session=False)
        )
    return counts


@router.delete("/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db),
                current=Depends(require_role("admin"))):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(404, "User not found")
    if u.id == current.id:
        raise HTTPException(400, "Cannot delete your own account")
    if u.role == "superadmin" and current.role != "superadmin":
        raise HTTPException(403, "Only superadmin can delete superadmin users")

    unlinked = _unlink_user_references(db, user_id, reassign_to=current.id)
    try:
        db.delete(u)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            409,
            "Cannot delete this user because other records still reference them "
            f"(plans/QC/tools/etc.). Reassign or archive those first. Detail: {e.orig}",
        ) from e
    return {"ok": True, "unlinked": unlinked}

# Any logged-in user can change their own password
@router.post("/me/change-password")
def change_own_password(data: PasswordChange, db: Session = Depends(get_db),
                        current=Depends(get_current_user)):
    import bcrypt as _bcrypt
    if not _bcrypt.checkpw(data.current_password.encode(), current.password_hash.encode()):
        raise HTTPException(400, "Current password is incorrect")
    if len(data.new_password) < 4:
        raise HTTPException(400, "New password must be at least 4 characters")
    current.password_hash = hash_password(data.new_password)
    db.commit()
    return {"ok": True}
