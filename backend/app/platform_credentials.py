"""Platform admin credentials — DB-stored hash with .env fallback for bootstrap."""
from __future__ import annotations

import json
import os
import secrets

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .auth import hash_password, verify_password
from .models import SiteConfig

ENV_USERNAME = os.getenv("PLATFORM_ADMIN_USERNAME", "platform_admin")
ENV_PASSWORD = os.getenv("PLATFORM_ADMIN_PASSWORD", "ChangeMe-Platform-2026!")
MIN_PASSWORD_LEN = 8


def _load_site_json(db: Session) -> dict:
    row = db.query(SiteConfig).first()
    if not row:
        return {}
    try:
        return json.loads(row.config_json)
    except (json.JSONDecodeError, TypeError):
        return {}


def _save_site_json(db: Session, cfg: dict) -> None:
    row = db.query(SiteConfig).first()
    if row:
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps(cfg)))
    db.commit()


def get_platform_admin_block(db: Session) -> dict:
    return _load_site_json(db).get("platformAdmin") or {}


def get_platform_username(db: Session) -> str:
    block = get_platform_admin_block(db)
    username = (block.get("username") or "").strip()
    return username or ENV_USERNAME


def uses_env_password(db: Session) -> bool:
    """True when no DB password hash has been set yet."""
    return not bool(get_platform_admin_block(db).get("passwordHash"))


def verify_platform_login(db: Session, username: str, password: str) -> bool:
    expected = get_platform_username(db)
    if not secrets.compare_digest(username, expected):
        return False
    block = get_platform_admin_block(db)
    stored_hash = block.get("passwordHash")
    if stored_hash:
        return verify_password(password, stored_hash)
    if not ENV_PASSWORD:
        return False
    return secrets.compare_digest(password, ENV_PASSWORD)


def change_platform_password(
    db: Session,
    *,
    current_password: str,
    new_password: str,
) -> None:
    username = get_platform_username(db)
    if not verify_platform_login(db, username, current_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    new_password = new_password.strip()
    if len(new_password) < MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"New password must be at least {MIN_PASSWORD_LEN} characters",
        )

    cfg = _load_site_json(db)
    cfg["platformAdmin"] = {
        **(cfg.get("platformAdmin") or {}),
        "username": username,
        "passwordHash": hash_password(new_password),
    }
    _save_site_json(db, cfg)
