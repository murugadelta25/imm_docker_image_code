from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..feature_modules import feature_modules_payload, set_feature_modules
from ..models import get_db
from ..platform_auth import create_platform_token, get_platform_admin, verify_platform_credentials
from ..platform_credentials import change_platform_password, uses_env_password

router = APIRouter(prefix="/api/platform", tags=["platform"])


class FeatureModulesPayload(BaseModel):
    modules: dict[str, bool]


class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)
    confirm_password: str


@router.post("/login")
def platform_login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    if not verify_platform_credentials(form.username, form.password, db):
        raise HTTPException(status_code=401, detail="Invalid platform credentials")
    token = create_platform_token(form.username)
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": form.username,
        "password_from_env": uses_env_password(db),
    }


@router.get("/features")
def get_platform_features(
    db: Session = Depends(get_db),
    _admin: str = Depends(get_platform_admin),
):
    payload = feature_modules_payload(db)
    payload["password_from_env"] = uses_env_password(db)
    return payload


@router.put("/features")
def update_platform_features(
    payload: FeatureModulesPayload,
    db: Session = Depends(get_db),
    _admin: str = Depends(get_platform_admin),
):
    updated = set_feature_modules(db, payload.modules)
    return {"modules": updated}


@router.post("/change-password")
def platform_change_password(
    body: ChangePasswordPayload,
    db: Session = Depends(get_db),
    _admin: str = Depends(get_platform_admin),
):
    if body.new_password != body.confirm_password:
        raise HTTPException(status_code=400, detail="New password and confirmation do not match")
    change_platform_password(
        db,
        current_password=body.current_password,
        new_password=body.new_password,
    )
    return {"ok": True, "message": "Platform password updated"}
