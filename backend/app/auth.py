import bcrypt as _bcrypt
from jose import JWTError, jwt
from datetime import datetime, timedelta
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from .models import User, Operator, get_db
import os

SECRET_KEY = os.getenv("SECRET_KEY", "changeme")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 480))
PERSISTENT_SESSION_USERNAME = "sie_admin"
PERSISTENT_SESSION_DAYS = int(os.getenv("PERSISTENT_SESSION_DAYS", 3650))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


class OperatorPrincipal:
    """Shop-floor operator authenticated via PIN (not a User Management account)."""

    def __init__(self, op: Operator):
        self.id = op.id
        self.operator_id = op.id
        self.username = f"op:{op.employee_code}"
        self.employee_code = op.employee_code
        self.name = op.name
        self.role = "operator"
        self.reference_photo_url = op.reference_photo_url
        self.linked_user_id = op.linked_user_id
        self.is_operator_principal = True


def verify_password(plain, hashed):
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(password):
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()


def create_access_token(data: dict):
    username = data.get("sub")
    if username == PERSISTENT_SESSION_USERNAME:
        expire = datetime.utcnow() + timedelta(days=PERSISTENT_SESSION_DAYS)
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({**data, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    if payload.get("typ") == "operator" or (isinstance(username, str) and username.startswith("op:")):
        op_id = payload.get("operator_id")
        op = None
        if op_id:
            op = db.query(Operator).filter(Operator.id == op_id).first()
        if not op and isinstance(username, str) and username.startswith("op:"):
            op = db.query(Operator).filter(Operator.employee_code == username[3:]).first()
        if not op or not op.is_active:
            raise HTTPException(status_code=401, detail="Operator not found")
        return OperatorPrincipal(op)

    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_role(*roles):
    def checker(current_user: User = Depends(get_current_user)):
        allowed = set(roles)
        if "admin" in allowed:
            allowed.add("superadmin")
            allowed.add("site_admin")
        if getattr(current_user, "is_operator_principal", False):
            if "operator" not in allowed:
                raise HTTPException(status_code=403, detail="Insufficient permissions")
            return current_user
        if current_user.role not in allowed:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user
    return checker


def require_capability(capability_id: str, *fallback_roles: str):
    """Allow if Feature Access Matrix grants this capability to the user's role.

    fallback_roles apply only when the capability is missing from the *stored*
    SiteConfig map (so existing deployments keep working until the matrix is saved).
    Normalized defaults alone do not count as configured — otherwise False defaults
    would always 403 before fallback could run.

    Once the capability is configured, a role that is absent or False is denied —
    legacy fallback_roles are not consulted.
    """
    def checker(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
        from .feature_modules import (
            capability_configured_in_role_access,
            get_feature_role_access,
        )

        role = getattr(current_user, "role", None)
        try:
            configured = capability_configured_in_role_access(db, capability_id)
            access = (get_feature_role_access(db) or {}).get(capability_id) or {}
        except Exception as exc:
            print(f"[auth] capability lookup failed for {capability_id}: {exc}")
            configured = False
            access = {}

        if configured and isinstance(access, dict):
            if role and access.get(role):
                return current_user
            if role == "site_admin" and access.get("admin"):
                return current_user
            raise HTTPException(status_code=403, detail="Insufficient permissions")

        allowed = set(fallback_roles)
        if "admin" in allowed:
            allowed.add("superadmin")
            allowed.add("site_admin")
        if getattr(current_user, "is_operator_principal", False):
            if "operator" in allowed:
                return current_user
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        if role in allowed:
            return current_user
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return checker


def require_superadmin():
    """Strict superadmin-only access — admin is NOT sufficient."""
    def checker(current_user: User = Depends(get_current_user)):
        if getattr(current_user, "is_operator_principal", False) or current_user.role != "superadmin":
            raise HTTPException(status_code=403, detail="Superadmin access required")
        return current_user
    return checker
