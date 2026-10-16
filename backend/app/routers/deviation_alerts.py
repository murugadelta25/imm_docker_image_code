"""API for Loss Tracker deviation alert emails."""
from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from ..models import get_db, EmailGroup, DeviationAlertLog, SiteConfig
from ..auth import get_current_user, require_role
from ..deviation_alert_service import (
    scan_ongoing_breaches,
    list_recent_alerts,
    list_open_escalation_cases,
    get_deviation_recipient_emails,
    get_escalation_config,
    get_limits_min,
    DEFAULT_LIMITS_MIN,
    DEFAULT_ESCALATION_CONFIG,
    STATUS_LABELS,
)

router = APIRouter(prefix="/api/deviation-alerts", tags=["deviation-alerts"])


class ScanResult(BaseModel):
    alerts_sent: int
    message: str


class EscalationLevelIn(BaseModel):
    level: int
    label: str
    group_names: list[str]
    delay_minutes: int = 0


class EscalationConfigIn(BaseModel):
    enabled: bool = True
    levels: list[EscalationLevelIn]


class LimitsIn(BaseModel):
    idle: float = 1.0
    breakdown: float = 90.0
    alarm: float = 30.0
    offline: float = 30.0
    setting_change: float = 120.0


@router.get("/")
def get_deviation_alerts(
    limit: int = 50,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    return {
        'alerts': list_recent_alerts(db, limit=min(limit, 200)),
        'thresholds_minutes': get_limits_min(db),
        'status_labels': STATUS_LABELS,
    }


@router.get("/config")
def get_deviation_alert_config(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    groups = db.query(EmailGroup).all()
    subscribed = []
    for g in groups:
        rts = {r.strip() for r in (g.report_types or '').split(',') if r.strip()}
        if rts & {'loss_tracker', 'deviation_alerts'}:
            subscribed.append({
                'id': g.id,
                'name': g.name,
                'report_types': g.report_types,
            })
    return {
        'enabled': True,
        'recipient_count': len(get_deviation_recipient_emails(db)),
        'subscribed_groups': subscribed,
        'thresholds_minutes': get_limits_min(db),
        'monitored_statuses': list(DEFAULT_LIMITS_MIN.keys()),
        'immediate_statuses': ['breakdown', 'alarm'],
        'scan_interval_minutes': 5,
        'escalation': get_escalation_config(db),
        'open_escalation_cases': list_open_escalation_cases(db, limit=20),
    }


@router.get("/escalation")
def get_escalation_matrix(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    return {
        'escalation': get_escalation_config(db),
        'open_cases': list_open_escalation_cases(db, limit=50),
        'defaults': DEFAULT_ESCALATION_CONFIG,
    }


@router.get("/limits")
def get_deviation_limits(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    return get_limits_min(db)


@router.put("/limits")
def save_deviation_limits(
    payload: LimitsIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    """Save Loss Tracker thresholds into SiteConfig (survives code pull / restart)."""
    import json
    from ..routers.config import _load_config, DEFAULT_CONFIG
    row = db.query(SiteConfig).first()
    # Prefer raw stored JSON so we don't inflate unrelated defaults into the blob
    if row and row.config_json:
        try:
            cfg = json.loads(row.config_json) or {}
        except Exception:
            cfg = _load_config(db)
    else:
        cfg = dict(DEFAULT_CONFIG)

    limits = {k: float(v) for k, v in payload.model_dump().items()}
    cfg['loss_tracker_limits'] = limits
    if row:
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps(cfg)))
    db.commit()
    return limits


@router.put("/escalation")
def save_escalation_matrix(
    payload: EscalationConfigIn,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin")),
):
    import json
    from ..routers.config import _load_config, DEFAULT_CONFIG

    row = db.query(SiteConfig).first()
    cfg = _load_config(db) if row else dict(DEFAULT_CONFIG)
    cfg['deviation_escalation'] = {
        'enabled': payload.enabled,
        'levels': [l.model_dump() for l in sorted(payload.levels, key=lambda x: x.level)],
    }
    if row:
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps(cfg)))
    db.commit()
    return {'ok': True, 'escalation': cfg['deviation_escalation']}


@router.get("/summary")
def get_deviation_summary(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    from sqlalchemy import func
    from datetime import datetime
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = (
        db.query(
            DeviationAlertLog.status,
            func.count(DeviationAlertLog.id).label('count'),
        )
        .filter(DeviationAlertLog.sent_at >= today_start)
        .group_by(DeviationAlertLog.status)
        .all()
    )
    by_status = {r.status: r.count for r in rows}
    total = sum(by_status.values())
    return {
        'date': today_start.date().isoformat(),
        'total_alerts_sent': total,
        'by_status': [
            {'status': s, 'label': STATUS_LABELS.get(s, s), 'count': by_status.get(s, 0)}
            for s in DEFAULT_LIMITS_MIN.keys()
        ] + [
            {'status': 'breakdown', 'label': 'Breakdown (immediate)', 'count': by_status.get('breakdown', 0)},
            {'status': 'alarm', 'label': 'Alarm (immediate)', 'count': by_status.get('alarm', 0)},
        ],
    }


@router.post("/scan", response_model=ScanResult)
def run_deviation_scan(
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    sent = scan_ongoing_breaches(db)
    return ScanResult(
        alerts_sent=sent,
        message=f'Scan complete — {sent} alert(s) sent (including escalations).',
    )


@router.post("/scan-async")
def run_deviation_scan_async(
    bg: BackgroundTasks,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    def _run():
        from ..models import SessionLocal
        sdb = SessionLocal()
        try:
            scan_ongoing_breaches(sdb)
        finally:
            sdb.close()

    bg.add_task(_run)
    return {'ok': True, 'message': 'Deviation scan started in background'}
