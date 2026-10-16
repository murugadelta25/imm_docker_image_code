from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from ..models import User, get_db
from ..auth import verify_password, create_access_token, hash_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

APPROVER_ROLES = {"admin", "superadmin"}


class ForgotPasswordRequest(BaseModel):
    username: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=4)
    approver_username: str = Field(..., min_length=1)
    approver_password: str = Field(..., min_length=1)


@router.post("/login")
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": user.username, "role": user.role})
    return {
        "access_token": token,
        "token_type": "bearer",
        "role": user.role,
        "username": user.username,
        "id": user.id,
        "reference_photo_url": user.reference_photo_url,
        "has_reference_photo": bool(user.reference_photo_url),
    }


@router.post("/forgot-password")
def forgot_password(data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """
    Reset any user's password from the login screen.
    Requires a valid admin or superadmin to authorize the reset (no email on factory LAN).
    """
    target_name = data.username.strip()
    approver_name = data.approver_username.strip()
    if not target_name or not approver_name:
        raise HTTPException(400, "Username and approver username are required")
    if len(data.new_password) < 4:
        raise HTTPException(400, "New password must be at least 4 characters")
    if target_name.lower() == approver_name.lower():
        raise HTTPException(400, "Ask another admin or superadmin to authorize your password reset")

    target = db.query(User).filter(User.username == target_name).first()
    if not target:
        raise HTTPException(404, "User not found")

    approver = db.query(User).filter(User.username == approver_name).first()
    if (
        not approver
        or approver.role not in APPROVER_ROLES
        or not verify_password(data.approver_password, approver.password_hash)
    ):
        raise HTTPException(401, "Invalid approver credentials")

    if target.role == "superadmin" and approver.role != "superadmin":
        raise HTTPException(403, "Only a superadmin can reset a superadmin password")

    target.password_hash = hash_password(data.new_password)
    db.commit()
    return {
        "ok": True,
        "username": target.username,
        "role": target.role,
        "message": f"Password reset for {target.username}. You can sign in now.",
    }
