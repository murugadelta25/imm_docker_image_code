from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_role
from ..feature_modules import feature_modules_payload, set_feature_role_access
from ..models import get_db

router = APIRouter(prefix="/api/features", tags=["features"])


class RoleAccessPayload(BaseModel):
    roleAccess: dict[str, dict[str, bool]]


@router.get("/")
def get_public_features(db: Session = Depends(get_db)):
    """Public feature flags for customer UI (nav + route guards). No user auth required."""
    return feature_modules_payload(db)


@router.get("/role-access")
def get_role_access(
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin")),
):
    payload = feature_modules_payload(db)
    return {
        "roleAccess": payload["roleAccess"],
        "accessMatrix": payload["accessMatrix"],
        "toggleableRoles": payload["toggleableRoles"],
        "roles": payload.get("roles") or [],
    }


@router.put("/role-access")
def update_role_access(
    body: RoleAccessPayload,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin")),
):
    try:
        updated = set_feature_role_access(db, body.roleAccess or {})
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    payload = feature_modules_payload(db)
    return {
        "roleAccess": updated,
        "accessMatrix": payload["accessMatrix"],
        "toggleableRoles": payload["toggleableRoles"],
        "roles": payload.get("roles") or [],
    }
