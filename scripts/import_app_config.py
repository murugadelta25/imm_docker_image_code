#!/usr/bin/env python3
"""Import deploy/config-templates into MySQL (site config + email groups).

Usage:
  python3 scripts/import_app_config.py           # merge if tables empty / missing rows
  python3 scripts/import_app_config.py --force   # overwrite site_config + replace email groups
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")

BUNDLE_PATH = ROOT / "deploy" / "config-templates" / "app_config_bundle.json"


def _load_bundle() -> dict:
    if not BUNDLE_PATH.exists():
        raise SystemExit(f"Missing {BUNDLE_PATH} — run scripts/export_app_config.py first.")
    return json.loads(BUNDLE_PATH.read_text(encoding="utf-8"))


def import_bundle(db, bundle: dict, *, force: bool = False) -> None:
    from app.models import (
        EmailGroup,
        EmailRecipient,
        EmailSchedule,
        EmailSmtpConfig,
        SiteConfig,
    )
    from app.factory_structure import migrate_json_factories_if_empty

    site = bundle.get("site_config") or {}
    if site:
        row = db.query(SiteConfig).first()
        if force or not row:
            if not row:
                row = SiteConfig(config_json=json.dumps(site))
                db.add(row)
            else:
                row.config_json = json.dumps(site)
            print("[OK] site_config imported")

    email = bundle.get("email") or {}
    smtp_t = email.get("smtp_template") or {}
    if smtp_t.get("email_address"):
        cfg = db.query(EmailSmtpConfig).first()
        if not cfg:
            cfg = EmailSmtpConfig(
                smtp_server=smtp_t.get("smtp_server") or "smtp.gmail.com",
                smtp_port=int(smtp_t.get("smtp_port") or 587),
                email_address=smtp_t.get("email_address"),
                email_password=None,
            )
            db.add(cfg)
            print("[OK] email_smtp_config row created (set password in Email Alerts UI)")
        elif force:
            cfg.smtp_server = smtp_t.get("smtp_server") or cfg.smtp_server
            cfg.smtp_port = int(smtp_t.get("smtp_port") or cfg.smtp_port or 587)
            cfg.email_address = smtp_t.get("email_address") or cfg.email_address

    groups_in = email.get("groups") or []
    recipients_in = email.get("recipients") or []
    schedules_in = email.get("schedules") or []

    if groups_in and (force or db.query(EmailGroup).count() == 0):
        if force:
            db.query(EmailRecipient).delete()
            db.query(EmailSchedule).delete()
            db.query(EmailGroup).delete()
            db.flush()
        name_to_id = {}
        for g in groups_in:
            name = (g.get("name") or "").strip()
            if not name:
                continue
            existing = db.query(EmailGroup).filter(EmailGroup.name == name).first()
            if existing:
                existing.description = g.get("description")
                existing.report_types = g.get("report_types") or existing.report_types
                name_to_id[name] = existing.id
            else:
                row = EmailGroup(
                    name=name,
                    description=g.get("description"),
                    report_types=g.get("report_types") or "oee,planning,breakdown",
                )
                db.add(row)
                db.flush()
                name_to_id[name] = row.id
        for r in recipients_in:
            gname = (r.get("group_name") or "").strip()
            gid = name_to_id.get(gname)
            if not gid:
                continue
            email_addr = (r.get("email") or "").strip()
            if not email_addr:
                continue
            exists = (
                db.query(EmailRecipient)
                .filter(EmailRecipient.group_id == gid, EmailRecipient.email == email_addr)
                .first()
            )
            if exists:
                exists.name = r.get("name") or exists.name
                exists.active = 1 if r.get("active", True) else 0
            else:
                db.add(
                    EmailRecipient(
                        group_id=gid,
                        name=r.get("name") or email_addr,
                        email=email_addr,
                        active=1 if r.get("active", True) else 0,
                    )
                )
        if schedules_in and (force or db.query(EmailSchedule).count() == 0):
            for s in schedules_in:
                db.add(
                    EmailSchedule(
                        name=s.get("name") or "Daily",
                        group_ids=s.get("group_ids") or "",
                        report_type=s.get("report_type") or "daily",
                        send_hour=int(s.get("send_hour") or 18),
                        send_minute=int(s.get("send_minute") or 0),
                        attach_report=1 if s.get("attach_report", True) else 0,
                        active=1 if s.get("active", True) else 0,
                    )
                )
        print(f"[OK] email groups/recipients imported (groups={len(name_to_id)})")

    factories = ((site.get("factory") or {}).get("factories") or [])
    if factories and migrate_json_factories_if_empty(db, factories):
        print("[OK] factory structure migrated from site_config")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Overwrite existing site/email config")
    parser.add_argument("--if-empty", action="store_true", help="Only import when site_config or groups missing")
    args = parser.parse_args()

    bundle = _load_bundle()
    from app.models import EmailGroup, SessionLocal, SiteConfig

    db = SessionLocal()
    try:
        empty_site = db.query(SiteConfig).first() is None
        empty_groups = db.query(EmailGroup).count() == 0
        if args.if_empty and not empty_site and not empty_groups:
            print("[SKIP] Config already present (--if-empty)")
            return 0
        import_bundle(db, bundle, force=args.force)
        db.commit()
        try:
            from app.scheduler_service import reload_schedules

            reload_schedules(db)
        except Exception:
            pass
        print("[OK] Import complete")
        return 0
    except Exception as exc:
        db.rollback()
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
