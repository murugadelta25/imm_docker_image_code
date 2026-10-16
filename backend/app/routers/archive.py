"""
API endpoints for database backup & archive management.
All endpoints require admin role.
"""
import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..models import SiteConfig, get_db
from ..auth import require_role, require_superadmin
from ..archive_service import (
    create_backup,
    list_backups,
    get_backup_path,
    delete_backup,
    restore_backup,
    BACKUP_DIR,
)

router = APIRouter(prefix="/api/archive", tags=["archive"])

DEFAULT_BACKUP_CONFIG = {
    "enabled": False,
    "interval_days": 15,
    "max_backups": 10,
    "last_backup_at": None,
}


class BackupConfigPayload(BaseModel):
    enabled: bool = False
    interval_days: int = Field(default=15, ge=1, le=90)
    max_backups: int = Field(default=10, ge=1, le=100)


def _get_backup_config(db: Session) -> dict:
    row = db.query(SiteConfig).first()
    if not row:
        return dict(DEFAULT_BACKUP_CONFIG)
    cfg = json.loads(row.config_json)
    return {**DEFAULT_BACKUP_CONFIG, **cfg.get("backup", {})}


def _save_backup_config(db: Session, backup_cfg: dict):
    row = db.query(SiteConfig).first()
    if row:
        cfg = json.loads(row.config_json)
    else:
        cfg = {}
        row = SiteConfig(config_json="{}")
        db.add(row)
    cfg["backup"] = backup_cfg
    row.config_json = json.dumps(cfg)
    db.commit()


@router.get("/config")
def get_archive_config(db: Session = Depends(get_db), _=Depends(require_superadmin())):
    return _get_backup_config(db)


@router.put("/config")
def update_archive_config(
    payload: BackupConfigPayload,
    db: Session = Depends(get_db),
    _=Depends(require_superadmin()),
):
    current = _get_backup_config(db)
    current["enabled"] = payload.enabled
    current["interval_days"] = payload.interval_days
    current["max_backups"] = payload.max_backups
    _save_backup_config(db, current)

    from ..scheduler_service import reload_archive_schedule
    reload_archive_schedule(db)

    return current


@router.post("/backup")
def trigger_backup(_=Depends(require_superadmin())):
    """Create a backup immediately (manual trigger)."""
    try:
        result = create_backup(method="auto", triggered_by="manual")
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/list")
def list_all_backups(_=Depends(require_superadmin())):
    return list_backups()


@router.get("/download/{filename}")
def download_backup(filename: str, _=Depends(require_superadmin())):
    fp = get_backup_path(filename)
    if not fp:
        raise HTTPException(status_code=404, detail="Backup not found")
    return FileResponse(
        path=str(fp),
        filename=filename,
        media_type="application/gzip",
    )


@router.post("/restore/{filename}")
def restore_from_backup(filename: str, _=Depends(require_superadmin())):
    """Restore database from a backup file. WARNING: overwrites current data."""
    try:
        result = restore_backup(filename)
        return result
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Backup not found")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/{filename}")
def delete_a_backup(filename: str, _=Depends(require_superadmin())):
    if delete_backup(filename):
        return {"status": "deleted", "filename": filename}
    raise HTTPException(status_code=404, detail="Backup not found")
