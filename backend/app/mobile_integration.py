"""Mobile app integration gate — optional coupling with the PMS web app."""
from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from .models import get_db


def is_mobile_integration_enabled(db: Session) -> bool:
    """
    True when Configuration → Mobile App Integration is ON.
    Default True so existing deployments keep working until explicitly decoupled.
    """
    try:
        from .routers.config import _load_config
        cfg = _load_config(db) or {}
        mi = cfg.get("mobile_integration") or {}
        return bool(mi.get("enabled", True))
    except Exception:
        return True


def require_mobile_integration(db: Session = Depends(get_db)):
    """FastAPI dependency — blocks mobile APIs when integration is turned off."""
    if not is_mobile_integration_enabled(db):
        raise HTTPException(
            403,
            "Mobile app integration is disabled. "
            "Enable it under Configuration → Mobile App Integration.",
        )
    return True
