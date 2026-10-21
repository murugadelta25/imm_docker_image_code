from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy.orm import Session
from datetime import datetime
import pytz
_IST = pytz.timezone('Asia/Kolkata')
def now_ist(): return datetime.now(_IST).replace(tzinfo=None)

scheduler = BackgroundScheduler(timezone="Asia/Kolkata", job_defaults={'misfire_grace_time': 3600})

def _send_scheduled(schedule_id: int):
    """Called by APScheduler — creates its own DB session"""
    from .models import EmailSchedule, EmailSmtpConfig, EmailGroup, EmailLog, SessionLocal
    from .routers.email_router import get_group_emails, do_send, build_attachments_for_report_types
    from datetime import timedelta
    db: Session = SessionLocal()
    try:
        s = db.query(EmailSchedule).filter(EmailSchedule.id == schedule_id,
                                           EmailSchedule.active == 1).first()
        if not s: return
        cfg = db.query(EmailSmtpConfig).first()
        if not cfg or not cfg.email_address: return

        group_ids = [int(x) for x in s.group_ids.split(",") if x.strip()]
        to_list = get_group_emails(db, group_ids)
        if not to_list: return

        # Report covers previous day's completed data
        report_date = (datetime.now().date() - timedelta(days=1))
        report_date_str = report_date.strftime('%d-%m-%Y')

        subject = f"[PMS] {s.report_type.capitalize()} Report — {report_date_str}"
        body = (f"Dear Team,\n\nPlease find the {s.report_type} production report for {report_date_str} attached.\n\n"
                f"Generated: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}\n\nDelta EAP+ PMS System")

        attachments = {}
        if s.attach_report:
            grps = db.query(EmailGroup).filter(EmailGroup.id.in_(group_ids)).all()
            combined = set()
            for grp in grps:
                for r in (grp.report_types or "oee,planning,breakdown").split(","):
                    combined.add(r.strip())
            attachments = build_attachments_for_report_types(",".join(combined), db, report_date)

        log = EmailLog(
            sent_at=now_ist(), recipients=", ".join(to_list),
            subject=subject, report_type="scheduled", status="pending"
        )
        db.add(log)
        db.commit()

        try:
            do_send(cfg, to_list, subject, body, attachments)
            log.status = "sent"
            print(f"[Scheduler] Schedule {schedule_id} sent to {len(to_list)} recipient(s)")
        except Exception as e:
            log.status = "failed"
            log.error_msg = str(e)
            print(f"[Scheduler] Send failed for schedule {schedule_id}: {e}")

        s.last_sent = now_ist()
        db.commit()
    except Exception as e:
        print(f"[Scheduler] Error for schedule {schedule_id}: {e}")
    finally:
        db.close()

def _scan_deviation_breaches():
    """Periodic job — alert on ongoing threshold breaches."""
    from .models import SessionLocal
    from .deviation_alert_service import scan_ongoing_breaches
    db = SessionLocal()
    try:
        sent = scan_ongoing_breaches(db)
        if sent:
            print(f"[DeviationAlert] Ongoing breach scan sent {sent} alert(s)")
    except Exception as exc:
        print(f"[DeviationAlert] Scan failed: {exc}")
    finally:
        db.close()


def _run_archive_backup():
    """Periodic job — create scheduled database backup."""
    from .archive_service import run_scheduled_backup
    run_scheduled_backup()


def _run_plan_auto_transition():
    """Periodic job — auto-start continuous same-part pending plans for the live shift.

    Does not rely on someone opening Hourly Output / OEE pages.
    """
    from datetime import timedelta
    from .models import SessionLocal
    from .routers.hourly_output import (
        _load_config, _shift_window, auto_transition_shift_plans,
    )

    db = SessionLocal()
    try:
        cfg = _load_config(db)
        _now = now_ist()
        today = _now.date()
        enabled = [s for s in cfg.get('shifts', []) if s.get('enabled', True)]
        for sh in enabled:
            try:
                s_start, s_end = _shift_window(today, sh)
            except Exception:
                continue
            # Overnight shifts that started yesterday
            if _now < s_start:
                yday = today - timedelta(days=1)
                try:
                    y_start, y_end = _shift_window(yday, sh)
                except Exception:
                    continue
                if y_start <= _now < y_end:
                    auto_transition_shift_plans(db, yday, sh['id'], cfg)
                continue
            if s_start <= _now < s_end:
                auto_transition_shift_plans(db, today, sh['id'], cfg)
    except Exception as exc:
        print(f"[Scheduler] Plan auto-transition failed: {exc}")
    finally:
        db.close()


def _run_plan_actuals_sync():
    """Periodic job — refresh plan.actual_qty from status logs (yesterday + today)."""
    from .plan_actuals_sync import run_recent_plan_actuals_sync
    try:
        n = run_recent_plan_actuals_sync()
        if n:
            print(f"[Scheduler] Plan actuals sync updated {n} plan(s)")
    except Exception as exc:
        print(f"[Scheduler] Plan actuals sync failed: {exc}")


def reload_archive_schedule(db: Session):
    """Add or remove the archive backup job based on site_config.backup settings."""
    import json as _json
    from .models import SiteConfig

    job_id = "archive_backup"

    try:
        row = db.query(SiteConfig).first()
        cfg = _json.loads(row.config_json) if row else {}
        backup_cfg = cfg.get("backup", {})
    except Exception:
        backup_cfg = {}

    enabled = backup_cfg.get("enabled", False)
    interval_days = backup_cfg.get("interval_days", 15)

    existing = scheduler.get_job(job_id)
    if existing:
        existing.remove()

    if enabled:
        scheduler.add_job(
            _run_archive_backup,
            trigger='interval',
            days=interval_days,
            id=job_id,
            replace_existing=True,
        )
        print(f"[Scheduler] Archive backup every {interval_days} day(s)")
    else:
        print("[Scheduler] Archive backup disabled")


def reload_schedules(db: Session):
    """Remove all existing jobs and re-add from DB"""
    from .models import EmailSchedule
    for job in scheduler.get_jobs():
        job.remove()

    schedules = db.query(EmailSchedule).filter(EmailSchedule.active == 1).all()
    for s in schedules:
        scheduler.add_job(
            _send_scheduled,
            trigger='cron',
            hour=s.send_hour,
            minute=s.send_minute,
            args=[s.id],
            id=f"schedule_{s.id}",
            replace_existing=True
        )
    print(f"[Scheduler] Loaded {len(schedules)} active schedule(s)")

    if not scheduler.get_job('deviation_breach_scan'):
        scheduler.add_job(
            _scan_deviation_breaches,
            trigger='interval',
            minutes=5,
            id='deviation_breach_scan',
            replace_existing=True,
        )
        print("[Scheduler] Deviation breach scan every 5 minutes")

    # Always re-register after reload clears jobs
    scheduler.add_job(
        _run_plan_auto_transition,
        trigger='interval',
        minutes=1,
        id='plan_auto_transition',
        replace_existing=True,
    )
    print("[Scheduler] Plan auto-transition every 1 minute")

    # Keep plan.actual_qty fresh without blocking page GETs
    scheduler.add_job(
        _run_plan_actuals_sync,
        trigger='interval',
        minutes=2,
        id='plan_actuals_sync',
        replace_existing=True,
    )
    print("[Scheduler] Plan actuals sync every 2 minutes")

    reload_archive_schedule(db)

def start_scheduler(db: Session = None):
    if not scheduler.running:
        scheduler.start()
    if db:
        reload_schedules(db)

def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
