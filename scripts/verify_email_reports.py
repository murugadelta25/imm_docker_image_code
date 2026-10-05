#!/usr/bin/env python3
"""Verify Excel report builders and optional SMTP send (Gmail-ready).

Usage:
  python3 scripts/verify_email_reports.py
  python3 scripts/verify_email_reports.py --write-samples
  python3 scripts/verify_email_reports.py --send-test user@gmail.com
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")

REPORT_TYPES = "oee,planning,breakdown,maintenance,data_entry,loss_tracker,tools"
SAMPLES_DIR = ROOT / "deploy" / "config-templates" / "report-samples"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-samples", action="store_true", help="Write .xlsx samples under deploy/config-templates/report-samples/")
    parser.add_argument("--send-test", metavar="EMAIL", help="Send all reports to one address (requires SMTP in DB or env)")
    args = parser.parse_args()

    from app.models import EmailSmtpConfig, SessionLocal
    from app.routers.email_router import build_attachments_for_report_types, do_send

    report_date = (date.today() - timedelta(days=1)).isoformat()
    db = SessionLocal()
    errors = []
    try:
        attachments = build_attachments_for_report_types(REPORT_TYPES, db, report_date)
        if not attachments:
            errors.append("No attachments produced")
        for fname, data in attachments.items():
            size = len(data or b"")
            status = "OK" if size > 500 else "WARN (small/empty)"
            print(f"  [{status}] {fname}: {size:,} bytes")
            if size <= 500:
                errors.append(f"{fname} too small ({size} bytes)")
            if args.write_samples:
                SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
                out = SAMPLES_DIR / fname.replace(".xlsx", f"_{report_date}.xlsx")
                out.write_bytes(data)
                print(f"         -> {out}")

        if args.send_test:
            cfg = db.query(EmailSmtpConfig).first()
            if cfg and cfg.email_address and cfg.email_password:
                smtp = cfg
            else:
                class _EnvCfg:
                    smtp_server = os.getenv("SMTP_HOST", "smtp.gmail.com")
                    smtp_port = int(os.getenv("SMTP_PORT", "587"))
                    email_address = os.getenv("SMTP_USER", "")
                    email_password = os.getenv("SMTP_PASS", "")

                smtp = _EnvCfg()
            if not smtp.email_address or not smtp.email_password:
                errors.append("SMTP not configured (DB or SMTP_USER/SMTP_PASS env)")
            else:
                subject = f"[PMS] Report verification — {report_date}"
                body = (
                    "Automated verification: all configured Excel report attachments.\n"
                    "If you received this on Ubuntu after git pull, update Gmail SMTP in Email Alerts.\n"
                )
                do_send(smtp, [args.send_test], subject, body, attachments)
                print(f"[OK] Test email sent to {args.send_test} with {len(attachments)} attachment(s)")
    except Exception as exc:
        errors.append(str(exc))
        print(f"[FAIL] {exc}", file=sys.stderr)
    finally:
        db.close()

    if errors:
        print("\nVerification FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nVerification PASSED — report builders OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
