#!/usr/bin/env python3
"""Export site settings + email alert config (no secrets) for Git / Ubuntu deploy.

Usage (from repo root):
  backend/.venv/Scripts/python.exe scripts/export_app_config.py
  python3 scripts/export_app_config.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")

OUT_DIR = ROOT / "deploy" / "config-templates"
BUNDLE_PATH = OUT_DIR / "app_config_bundle.json"


def main() -> int:
    from app.models import (
        EmailGroup,
        EmailRecipient,
        EmailSchedule,
        EmailSmtpConfig,
        SessionLocal,
        SiteConfig,
    )
    from app.factory_structure import factories_tree_from_db

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    db = SessionLocal()
    try:
        site = {}
        row = db.query(SiteConfig).first()
        if row and row.config_json:
            try:
                site = json.loads(row.config_json)
            except json.JSONDecodeError:
                site = {}

        groups = []
        for g in db.query(EmailGroup).order_by(EmailGroup.id).all():
            groups.append(
                {
                    "name": g.name,
                    "description": g.description,
                    "report_types": g.report_types or "oee,planning,breakdown",
                }
            )

        recipients = []
        for r in db.query(EmailRecipient).order_by(EmailRecipient.id).all():
            grp = db.query(EmailGroup).filter(EmailGroup.id == r.group_id).first()
            recipients.append(
                {
                    "group_name": grp.name if grp else "",
                    "name": r.name,
                    "email": r.email,
                    "active": bool(r.active),
                }
            )

        schedules = []
        for s in db.query(EmailSchedule).order_by(EmailSchedule.id).all():
            schedules.append(
                {
                    "name": s.name,
                    "group_ids": s.group_ids,
                    "report_type": s.report_type,
                    "send_hour": s.send_hour,
                    "send_minute": s.send_minute,
                    "attach_report": bool(s.attach_report),
                    "active": bool(s.active),
                }
            )

        smtp = {}
        cfg = db.query(EmailSmtpConfig).first()
        if cfg:
            smtp = {
                "smtp_server": cfg.smtp_server or "smtp.gmail.com",
                "smtp_port": int(cfg.smtp_port or 587),
                "email_address": cfg.email_address or "",
                "password_set": bool(cfg.email_password),
            }

        domain_path = ROOT / "deploy" / "domain.config.json"
        domain = {}
        if domain_path.exists():
            try:
                domain = json.loads(domain_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                domain = {}

        bundle = {
            "version": 1,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "note": "SMTP password is never exported. Set Gmail app password on Ubuntu after pull.",
            "site_config": site,
            "email": {
                "smtp_template": smtp,
                "groups": groups,
                "recipients": recipients,
                "schedules": schedules,
            },
            "factory_tree": factories_tree_from_db(db),
            "domain": domain,
        }

        BUNDLE_PATH.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        # Also write split files for easier diff review
        (OUT_DIR / "site_config.json").write_text(
            json.dumps(site, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        (OUT_DIR / "email_alerts.json").write_text(
            json.dumps(bundle["email"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

        print(f"[OK] Exported deploy config -> {BUNDLE_PATH}")
        print(f"     groups={len(groups)} recipients={len(recipients)} schedules={len(schedules)}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
