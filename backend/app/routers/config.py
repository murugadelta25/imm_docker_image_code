import json
import os
from typing import Optional
from fastapi import APIRouter, Depends, UploadFile, File, Query, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from pathlib import Path
import uuid
from ..models import SiteConfig, get_db
from ..auth import get_current_user, require_role
from ..network_utils import build_network_payload
from ..factory_structure import (
    attach_factories_to_config,
    replace_factories_tree,
    sync_factory_branding_json,
    update_factory_logo,
)

router = APIRouter(prefix="/api/config", tags=["config"])

# Same root as app.main STATIC_DIR mount → /static/...
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = _BACKEND_ROOT / "static"
FACTORY_DIR = STATIC_DIR / "factory"
FACTORY_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_SITE_TITLE = os.getenv("SITE_TITLE", "Production Monitoring System (PMS)")

DEFAULT_CONFIG = {
    "shifts": [
        {"id": "A", "name": "Shift A", "start": "08:00", "end": "20:00", "enabled": True},
        {"id": "B", "name": "Shift B", "start": "20:00", "end": "08:00", "enabled": True},
        {"id": "C", "name": "Shift C", "start": "22:00", "end": "06:00", "enabled": False},
    ],
    "breaks": {
        "A": {
            "lunch_break": 30, "lunch_start": "12:00", "lunch_end": "12:30",
            "tea_break": 10, "tea_start": "10:00", "tea_end": "10:10",
            "tpm_cleaning": 10, "tpm_start": "11:00", "tpm_end": "11:10",
            "other_cleaning": 0, "management_meeting": 0,
        },
        "B": {
            "lunch_break": 30, "lunch_start": "00:00", "lunch_end": "00:30",
            "tea_break": 10, "tea_start": "22:00", "tea_end": "22:10",
            "tpm_cleaning": 10, "tpm_start": "23:00", "tpm_end": "23:10",
            "other_cleaning": 0, "management_meeting": 0,
        },
        "C": {
            "lunch_break": 30, "lunch_start": "02:00", "lunch_end": "02:30",
            "tea_break": 10, "tea_start": "00:00", "tea_end": "00:10",
            "tpm_cleaning": 10, "tpm_start": "01:00", "tpm_end": "01:10",
            "other_cleaning": 0, "management_meeting": 0,
        },
    },
    "checkDataDaysBack": 1,
    "hourly_output": {
        "running_part_threshold_pct": 30,
        "ld_unld_max_sec": 60,
        "micro_gap_sec": 15,
    },
    "loss_tracker_limits": {
        "idle": 1,
        "breakdown": 90,
        "alarm": 30,
        "offline": 30,
        "setting_change": 120,
    },
    "deviation_escalation": {
        "enabled": True,
        "levels": [
            {"level": 1, "label": "Operator / Production", "group_names": ["production"], "delay_minutes": 0},
            {"level": 2, "label": "Supervisor", "group_names": ["maintenance"], "delay_minutes": 15},
            {"level": 3, "label": "Manager", "group_names": ["management"], "delay_minutes": 30},
        ],
    },
    "factory": {
        "configured": False,
        "siteTitle": DEFAULT_SITE_TITLE,
        "faviconFactoryId": None,
        "factories": [],
        # Login screen hero image (separate from factory logo / favicon)
        "loginImageEnabled": False,
        "loginImageUrl": None,
    },
    "backup": {
        "enabled": False,
        "interval_days": 15,
        "max_backups": 10,
        "last_backup_at": None,
    },
    # Optional tablet / mobile coupling — OFF = web app runs independently
    "mobile_integration": {
        "enabled": True,
    },
}

class ConfigPayload(BaseModel):
    config: dict


def _normalize_factory_cfg(factory: dict) -> dict:
    """Drop nameless logo-upload stubs and keep branding fields consistent."""
    out = dict(factory or {})
    factories = []
    for item in out.get("factories") or []:
        if not isinstance(item, dict):
            continue
        if not str(item.get("name") or "").strip():
            # Preserve logo for later merge if a real factory reuses this id.
            logo = item.get("logoUrl")
            fid = item.get("id")
            if fid and logo:
                draft = dict(out.get("draftLogos") or {})
                draft[str(fid)] = logo
                out["draftLogos"] = draft
                if not out.get("brandingLogoUrl"):
                    out["brandingLogoUrl"] = logo
            continue
        factories.append(item)
    out["factories"] = factories
    fav = out.get("faviconFactoryId")
    if fav and not any(str(f.get("id")) == str(fav) for f in factories):
        # Keep brandingLogoUrl as the active header/favicon source.
        if not out.get("brandingLogoUrl"):
            for f in factories:
                if f.get("logoUrl"):
                    out["brandingLogoUrl"] = f["logoUrl"]
                    out["faviconFactoryId"] = f.get("id")
                    break
            else:
                out["faviconFactoryId"] = None
    return out


def merge_config(stored: dict) -> dict:
    """Merge stored site config with defaults (timed breaks required for hourly output)."""
    if not stored:
        return dict(DEFAULT_CONFIG)
    merged = {**DEFAULT_CONFIG, **stored}
    merged["shifts"] = stored.get("shifts") or DEFAULT_CONFIG["shifts"]
    breaks_out = {}
    for sh in merged["shifts"]:
        sid = sh.get("id")
        if not sid:
            continue
        base = DEFAULT_CONFIG["breaks"].get(sid, DEFAULT_CONFIG["breaks"]["A"])
        breaks_out[sid] = {**base, **(stored.get("breaks") or {}).get(sid, {})}
    merged["breaks"] = breaks_out
    factory = stored.get("factory") or {}
    merged["factory"] = _normalize_factory_cfg({**DEFAULT_CONFIG["factory"], **factory})
    esc = stored.get("deviation_escalation") or {}
    default_esc = DEFAULT_CONFIG["deviation_escalation"]
    merged["deviation_escalation"] = {
        "enabled": esc.get("enabled", default_esc["enabled"]),
        "levels": esc.get("levels") or default_esc["levels"],
    }
    lt = stored.get("loss_tracker_limits") or {}
    default_lt = DEFAULT_CONFIG["loss_tracker_limits"]
    merged["loss_tracker_limits"] = {**default_lt, **lt}
    hourly = stored.get("hourly_output") or {}
    default_hourly = DEFAULT_CONFIG["hourly_output"]
    merged["hourly_output"] = {**default_hourly, **hourly}
    backup = stored.get("backup") or {}
    default_backup = DEFAULT_CONFIG["backup"]
    merged["backup"] = {**default_backup, **backup}
    mi = stored.get("mobile_integration") or {}
    default_mi = DEFAULT_CONFIG["mobile_integration"]
    merged["mobile_integration"] = {**default_mi, **mi}
    return merged


def _load_config(db: Session) -> dict:
    row = db.query(SiteConfig).first()
    if not row:
        return dict(DEFAULT_CONFIG)
    try:
        raw = json.loads(row.config_json) if row.config_json else {}
    except Exception:
        raw = {}
    cfg = merge_config(raw)
    factory = cfg.get("factory") or {}
    if "siteTitle" not in factory:
        factory["siteTitle"] = DEFAULT_CONFIG["factory"]["siteTitle"]
    if "faviconFactoryId" not in factory:
        factory["faviconFactoryId"] = None
    if "loginImageEnabled" not in factory:
        factory["loginImageEnabled"] = bool(DEFAULT_CONFIG["factory"].get("loginImageEnabled"))
    if "loginImageUrl" not in factory:
        factory["loginImageUrl"] = None
    cfg["factory"] = factory

    # Heal DB: logo-upload used to insert nameless factory stubs — drop them once.
    raw_factory = raw.get("factory") if isinstance(raw, dict) else None
    raw_list = (raw_factory or {}).get("factories") if isinstance(raw_factory, dict) else None
    if isinstance(raw_list, list) and any(
        isinstance(f, dict) and not str(f.get("name") or "").strip() for f in raw_list
    ):
        healed = dict(raw)
        healed["factory"] = factory
        row.config_json = json.dumps(healed)
        db.commit()

    # Relational factories / departments / zones are the source of truth
    cfg = attach_factories_to_config(db, cfg)
    try:
        db.commit()
    except Exception:
        db.rollback()
    return cfg


@router.get("/branding")
def get_branding(db: Session = Depends(get_db)):
    """Public site title + favicon + login image (no auth required)."""
    cfg = _load_config(db)
    factory_cfg = cfg.get("factory") or {}
    site_title = factory_cfg.get("siteTitle") or DEFAULT_SITE_TITLE
    favicon_url = None
    favicon_id = factory_cfg.get("faviconFactoryId")
    for f in factory_cfg.get("factories") or []:
        if favicon_id and f.get("id") == favicon_id and f.get("logoUrl"):
            favicon_url = f["logoUrl"]
            break
    if not favicon_url and favicon_id:
        draft = (factory_cfg.get("draftLogos") or {}).get(str(favicon_id))
        if draft:
            favicon_url = draft
    if not favicon_url:
        for f in factory_cfg.get("factories") or []:
            if f.get("logoUrl"):
                favicon_url = f["logoUrl"]
                break
    if not favicon_url:
        favicon_url = factory_cfg.get("brandingLogoUrl") or None

    login_enabled = bool(factory_cfg.get("loginImageEnabled"))
    login_url = factory_cfg.get("loginImageUrl") or None
    if login_enabled and not login_url:
        login_enabled = False

    return {
        "siteTitle": site_title,
        "faviconUrl": favicon_url,
        "loginImageEnabled": login_enabled,
        "loginImageUrl": login_url if login_enabled else None,
    }


@router.get("/network")
def get_network_info():
    """Public LAN URLs and auto-detected IPs (no auth). Use when din.eappms DNS is unavailable."""
    return build_network_payload()


@router.get("/mobile-integration")
def get_mobile_integration_status(db: Session = Depends(get_db)):
    """Public flag for tablet apps — whether coupling with the web PMS is enabled."""
    from ..mobile_integration import is_mobile_integration_enabled
    enabled = is_mobile_integration_enabled(db)
    return {
        "enabled": enabled,
        "message": (
            "Mobile app integration is enabled."
            if enabled
            else "Mobile app integration is disabled in Configuration. Web app runs independently."
        ),
    }


@router.get("/")
def get_config(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return _load_config(db)

@router.put("/")
def save_config(payload: ConfigPayload, db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    """Persist site config while preserving runtime keys omitted by the UI.

    Loss Tracker thresholds (and similar nested settings) live in the same
    SiteConfig blob. Configuration page drafts may not include them — never
    wipe stored values just because the payload left a key out.
    """
    row = db.query(SiteConfig).first()
    existing = {}
    if row and row.config_json:
        try:
            existing = json.loads(row.config_json) or {}
        except Exception:
            existing = {}

    incoming = dict(payload.config or {})
    # Keys that must survive if the client omits or sends an empty object
    preserve_keys = (
        "loss_tracker_limits",
        "deviation_escalation",
        "hourly_output",
        "factory",
        "backup",
        "featureModules",
        "mobile_integration",
    )
    for key in preserve_keys:
        if key not in incoming or incoming.get(key) in (None, {}):
            if key in existing and existing[key] not in (None, {}):
                incoming[key] = existing[key]

    # Nested merge for loss_tracker_limits so partial updates keep other statuses
    if isinstance(incoming.get("loss_tracker_limits"), dict) and isinstance(existing.get("loss_tracker_limits"), dict):
        incoming["loss_tracker_limits"] = {
            **DEFAULT_CONFIG["loss_tracker_limits"],
            **existing["loss_tracker_limits"],
            **incoming["loss_tracker_limits"],
        }

    if isinstance(incoming.get("mobile_integration"), dict):
        incoming["mobile_integration"] = {
            **DEFAULT_CONFIG["mobile_integration"],
            **(existing.get("mobile_integration") or {}),
            **incoming["mobile_integration"],
        }

    if isinstance(incoming.get("factory"), dict):
        # Merge draft logos from upload onto named factories, then prune stubs.
        factory_in = dict(incoming["factory"])
        existing_factory = dict(existing.get("factory") or {})
        draft = dict(existing_factory.get("draftLogos") or {})
        draft.update(factory_in.get("draftLogos") or {})
        factories = []
        for item in factory_in.get("factories") or []:
            if not isinstance(item, dict):
                continue
            row_f = dict(item)
            fid = str(row_f.get("id") or "")
            if fid and not row_f.get("logoUrl") and draft.get(fid):
                row_f["logoUrl"] = draft[fid]
            if fid and row_f.get("logoUrl"):
                draft.pop(fid, None)
            factories.append(row_f)
        factory_in["factories"] = factories
        factory_in["draftLogos"] = draft
        if factory_in.get("brandingLogoUrl") is None and existing_factory.get("brandingLogoUrl"):
            factory_in["brandingLogoUrl"] = existing_factory.get("brandingLogoUrl")
        # Keep login hero settings unless the client explicitly sends them
        if "loginImageUrl" not in factory_in and existing_factory.get("loginImageUrl"):
            factory_in["loginImageUrl"] = existing_factory.get("loginImageUrl")
        if "loginImageEnabled" not in factory_in and "loginImageEnabled" in existing_factory:
            factory_in["loginImageEnabled"] = existing_factory.get("loginImageEnabled")
        # Prefer a real factory logo for site branding after full save.
        fav = factory_in.get("faviconFactoryId")
        for f in factories:
            if fav and str(f.get("id")) == str(fav) and f.get("logoUrl"):
                factory_in["brandingLogoUrl"] = f["logoUrl"]
                break
        else:
            named_logo = next((f.get("logoUrl") for f in factories if f.get("logoUrl")), None)
            if named_logo:
                factory_in["brandingLogoUrl"] = named_logo
        factory_in = _normalize_factory_cfg(factory_in)

        # Persist factory / department / zone tree when client sends factories list
        if "factories" in factory_in:
            tree = replace_factories_tree(db, factory_in.get("factories") or [])
            factory_in["factories"] = tree
        incoming["factory"] = sync_factory_branding_json(db, factory_in)

    if row:
        row.config_json = json.dumps(incoming)
    else:
        db.add(SiteConfig(config_json=json.dumps(incoming)))
    db.commit()
    return attach_factories_to_config(db, merge_config(incoming))


@router.post("/factory-logo")
async def upload_factory_logo(
    file: UploadFile = File(...),
    factory_id: Optional[str] = Query(None),
    set_as_favicon: bool = Query(True),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    """Upload a factory logo and optionally persist logoUrl onto that factory in site config."""
    from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited

    ext = Path(file.filename or "").suffix.lower() or ".png"
    if ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"}:
        ext = ".png"
    fname = f"factory_logo_{uuid.uuid4().hex[:8]}{ext}"
    fpath = FACTORY_DIR / fname
    written = await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    if written <= 0:
        if fpath.exists():
            fpath.unlink(missing_ok=True)
        raise HTTPException(400, "Empty logo file")

    logo_url = f"/static/factory/{fname}"

    # Persist logo onto an existing named factory, or as draft branding until Save.
    # Never create nameless factory rows — those showed up as "—" in Factory Setup.
    if factory_id:
        row = db.query(SiteConfig).first()
        cfg = {}
        if row and row.config_json:
            try:
                cfg = json.loads(row.config_json) or {}
            except Exception:
                cfg = {}
        factory_cfg = dict(cfg.get("factory") or {})
        factories = list(factory_cfg.get("factories") or [])
        found = update_factory_logo(db, str(factory_id), logo_url)
        if not found:
            for item in factories:
                if str(item.get("id")) == str(factory_id):
                    item["logoUrl"] = logo_url
                    found = True
                    break
        if not found:
            draft = dict(factory_cfg.get("draftLogos") or {})
            draft[str(factory_id)] = logo_url
            factory_cfg["draftLogos"] = draft
        else:
            factory_cfg["factories"] = factories
        factory_cfg["brandingLogoUrl"] = logo_url
        if set_as_favicon:
            factory_cfg["faviconFactoryId"] = factory_id
        factory_cfg["configured"] = True
        if not factory_cfg.get("siteTitle"):
            factory_cfg["siteTitle"] = DEFAULT_SITE_TITLE
        factory_cfg = _normalize_factory_cfg(factory_cfg)
        factory_cfg = sync_factory_branding_json(db, factory_cfg)
        cfg["factory"] = factory_cfg
        if row:
            row.config_json = json.dumps(cfg)
        else:
            db.add(SiteConfig(config_json=json.dumps(cfg)))
        db.commit()

    return {
        "logoUrl": logo_url,
        "factoryId": factory_id,
        "bytes": written,
        "path": str(fpath),
    }


@router.post("/login-image")
async def upload_login_image(
    file: UploadFile = File(...),
    enable: bool = Query(True),
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    """Upload login-screen company image (separate from factory logo / favicon)."""
    from ..upload_limits import MAX_IMAGE_BYTES, save_upload_limited

    ext = Path(file.filename or "").suffix.lower() or ".png"
    if ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}:
        ext = ".png"
    fname = f"login_image_{uuid.uuid4().hex[:8]}{ext}"
    fpath = FACTORY_DIR / fname
    written = await save_upload_limited(file, fpath, MAX_IMAGE_BYTES)
    if written <= 0:
        if fpath.exists():
            fpath.unlink(missing_ok=True)
        raise HTTPException(400, "Empty login image file")

    image_url = f"/static/factory/{fname}"
    row = db.query(SiteConfig).first()
    cfg = {}
    if row and row.config_json:
        try:
            cfg = json.loads(row.config_json) or {}
        except Exception:
            cfg = {}
    factory_cfg = dict(cfg.get("factory") or {})
    factory_cfg["loginImageUrl"] = image_url
    factory_cfg["loginImageEnabled"] = bool(enable)
    factory_cfg["configured"] = True
    if not factory_cfg.get("siteTitle"):
        factory_cfg["siteTitle"] = DEFAULT_SITE_TITLE
    factory_cfg = _normalize_factory_cfg(factory_cfg)
    factory_cfg = sync_factory_branding_json(db, factory_cfg)
    cfg["factory"] = factory_cfg
    if row:
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps(cfg)))
    db.commit()

    return {
        "loginImageUrl": image_url,
        "loginImageEnabled": bool(enable),
        "bytes": written,
        "path": str(fpath),
    }
