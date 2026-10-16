"""Real-time deviation / breakdown / alarm email alerts for Loss Tracker thresholds."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy.orm import Session

from .models import (
    Machine, Station, MachineStatusLog, EmailGroup, EmailRecipient,
    EmailSmtpConfig, EmailLog, DeviationAlertLog, DeviationEscalationCase,
    BreakdownTicket, now_ist,
)

# Match Loss Tracker frontend defaults (minutes)
DEFAULT_LIMITS_MIN = {
    'idle': 1,
    'breakdown': 90,
    'alarm': 30,
    'offline': 30,
    'setting_change': 120,
}

THRESHOLD_STATUSES = frozenset(DEFAULT_LIMITS_MIN.keys())
IMMEDIATE_STATUSES = frozenset({'breakdown', 'alarm'})

STATUS_LABELS = {
    'idle': 'Idle',
    'breakdown': 'Breakdown',
    'alarm': 'Alarm',
    'offline': 'Offline',
    'setting_change': 'Setting Change',
    'running': 'Running',
}

ALERT_REPORT_KEYS = frozenset({'loss_tracker', 'deviation_alerts'})

DEFAULT_ESCALATION_CONFIG = {
    'enabled': True,
    'levels': [
        {'level': 1, 'label': 'Operator / Production', 'group_names': ['production'], 'delay_minutes': 0},
        {'level': 2, 'label': 'Supervisor', 'group_names': ['maintenance'], 'delay_minutes': 15},
        {'level': 3, 'label': 'Manager', 'group_names': ['management'], 'delay_minutes': 30},
    ],
}


def get_limits_min(db: Session) -> dict:
    """Return thresholds from DB (SiteConfig), falling back to DEFAULT_LIMITS_MIN.

    Values are kept as floats so decimal-minute thresholds (e.g. 1.5) survive reload.
    """
    try:
        from .routers.config import _load_config
        cfg = _load_config(db)
        stored = cfg.get('loss_tracker_limits') or {}
        out = {}
        for k in DEFAULT_LIMITS_MIN:
            raw = stored.get(k, DEFAULT_LIMITS_MIN[k])
            try:
                out[k] = float(raw)
            except (TypeError, ValueError):
                out[k] = float(DEFAULT_LIMITS_MIN[k])
        return out
    except Exception:
        return {k: float(v) for k, v in DEFAULT_LIMITS_MIN.items()}


def _limit_sec(status: str, db: Session = None) -> Optional[int]:
    limits = get_limits_min(db) if db else DEFAULT_LIMITS_MIN
    mins = limits.get(status)
    return int(mins * 60) if mins is not None else None


def format_duration(sec: float) -> str:
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f'{h}h {m}m {s}s'
    if m:
        return f'{m}m {s}s'
    return f'{s}s'


def _status_label(status: str) -> str:
    return STATUS_LABELS.get(status, status.replace('_', ' ').title())


def _fmt_ist(dt: datetime) -> str:
    if not dt:
        return '—'
    return dt.strftime('%d-%m-%Y %H:%M:%S IST')


def get_escalation_config(db: Session) -> dict:
    from .routers.config import _load_config
    cfg = _load_config(db)
    esc = cfg.get('deviation_escalation') or {}
    if not esc.get('levels'):
        return dict(DEFAULT_ESCALATION_CONFIG)
    return {
        'enabled': bool(esc.get('enabled', DEFAULT_ESCALATION_CONFIG['enabled'])),
        'levels': esc.get('levels') or DEFAULT_ESCALATION_CONFIG['levels'],
    }


def _emails_for_group_names(db: Session, group_names: List[str]) -> List[str]:
    target = {n.lower().strip() for n in group_names if n}
    if not target:
        return []
    groups = db.query(EmailGroup).all()
    group_ids = []
    for g in groups:
        if g.name.lower() not in target:
            continue
        rts = {r.strip() for r in (g.report_types or '').split(',') if r.strip()}
        if rts & ALERT_REPORT_KEYS:
            group_ids.append(g.id)
    if not group_ids:
        return []
    rows = db.query(EmailRecipient).filter(
        EmailRecipient.group_id.in_(group_ids),
        EmailRecipient.active == 1,
    ).all()
    seen, out = set(), []
    for r in rows:
        if r.email and r.email not in seen:
            seen.add(r.email)
            out.append(r.email)
    return out


def get_deviation_recipient_emails(db: Session) -> List[str]:
    groups = db.query(EmailGroup).all()
    group_ids = []
    for g in groups:
        rts = {r.strip() for r in (g.report_types or '').split(',') if r.strip()}
        if rts & ALERT_REPORT_KEYS:
            group_ids.append(g.id)
    if not group_ids:
        return []
    rows = db.query(EmailRecipient).filter(
        EmailRecipient.group_id.in_(group_ids),
        EmailRecipient.active == 1,
    ).all()
    seen, out = set(), []
    for r in rows:
        if r.email and r.email not in seen:
            seen.add(r.email)
            out.append(r.email)
    return out


def get_level_recipient_emails(db: Session, level_def: dict) -> List[str]:
    return _emails_for_group_names(db, level_def.get('group_names') or [])


def _shift_start_today(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _count_breaches_today(db: Session, machine_id: int, status: str, day_start: datetime) -> int:
    """Count threshold breaches for machine+status since midnight IST."""
    logs = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id == machine_id,
            MachineStatusLog.changed_at >= day_start,
        )
        .order_by(MachineStatusLog.changed_at.asc())
        .all()
    )
    count = 0
    limit = _limit_sec(status, db)
    if limit is None:
        return 0
    for i, log in enumerate(logs):
        if log.status != status:
            continue
        end = logs[i + 1].changed_at if i + 1 < len(logs) else now_ist()
        dur = (end - log.changed_at).total_seconds()
        if dur > limit:
            count += 1
    return count


def _already_sent(
    db: Session,
    segment_log_id: int,
    alert_type: str,
    escalation_level: int = 0,
) -> bool:
    q = db.query(DeviationAlertLog).filter(
        DeviationAlertLog.segment_log_id == segment_log_id,
        DeviationAlertLog.alert_type == alert_type,
        DeviationAlertLog.escalation_level == escalation_level,
    )
    return q.first() is not None


def _machine_context(db: Session, machine_id: int) -> dict:
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    station_name = ''
    if m:
        st = db.query(Station).filter(Station.id == m.station_id).first()
        station_name = (st.display_name or st.name) if st else str(m.station_id)
    return {
        'machine_id': machine_id,
        'machine_name': m.name if m else str(machine_id),
        'station_name': station_name,
    }


def _open_escalation_case(
    db: Session,
    *,
    segment_log_id: Optional[int],
    machine_id: int,
    status: str,
    alert_type: str,
    level: int = 1,
) -> DeviationEscalationCase:
    if segment_log_id:
        existing = db.query(DeviationEscalationCase).filter(
            DeviationEscalationCase.segment_log_id == segment_log_id,
            DeviationEscalationCase.alert_type == alert_type,
            DeviationEscalationCase.resolved_at.is_(None),
        ).first()
        if existing:
            return existing
    now = now_ist()
    case = DeviationEscalationCase(
        segment_log_id=segment_log_id,
        machine_id=machine_id,
        status=status,
        alert_type=alert_type,
        current_level=level,
        opened_at=now,
        last_escalated_at=now,
    )
    db.add(case)
    db.flush()
    return case


def _resolve_case(db: Session, case: DeviationEscalationCase, reason: str) -> None:
    if case.resolved_at:
        return
    case.resolved_at = now_ist()
    case.resolved_reason = reason


def resolve_escalation_for_segment(
    db: Session,
    segment_log_id: int,
    reason: str = 'action_taken',
) -> int:
    """Resolve all open escalation cases tied to a status-log segment."""
    cases = db.query(DeviationEscalationCase).filter(
        DeviationEscalationCase.segment_log_id == segment_log_id,
        DeviationEscalationCase.resolved_at.is_(None),
    ).all()
    for case in cases:
        _resolve_case(db, case, reason)
    if cases:
        db.commit()
    return len(cases)


def resolve_escalation_for_machine(
    db: Session,
    machine_id: int,
    reason: str = 'action_taken',
) -> int:
    """Resolve open escalation cases for a machine (e.g. breakdown acknowledged)."""
    cases = db.query(DeviationEscalationCase).filter(
        DeviationEscalationCase.machine_id == machine_id,
        DeviationEscalationCase.resolved_at.is_(None),
    ).all()
    for case in cases:
        _resolve_case(db, case, reason)
    if cases:
        db.commit()
    return len(cases)


def _is_action_taken(db: Session, case: DeviationEscalationCase) -> bool:
    if case.segment_log_id:
        seg = db.query(MachineStatusLog).filter(
            MachineStatusLog.id == case.segment_log_id,
        ).first()
        if seg and seg.deviation_reason and seg.deviation_reason.strip():
            return True
        latest = (
            db.query(MachineStatusLog)
            .filter(MachineStatusLog.machine_id == case.machine_id)
            .order_by(MachineStatusLog.changed_at.desc())
            .first()
        )
        if latest and latest.id != case.segment_log_id:
            return True
        if latest and latest.status != case.status:
            return True

    if case.status == 'breakdown' or 'breakdown' in (case.alert_type or ''):
        ticket = (
            db.query(BreakdownTicket)
            .filter(
                BreakdownTicket.machine_id == case.machine_id,
                BreakdownTicket.status.in_(['acknowledged', 'in_progress', 'resolved']),
            )
            .order_by(BreakdownTicket.created_at.desc())
            .first()
        )
        if ticket and ticket.created_at >= case.opened_at - timedelta(minutes=10):
            return True
    return False


def _send_alert_email(
    db: Session,
    *,
    subject: str,
    body: str,
    alert_type: str,
    machine_id: int,
    status: str,
    segment_log_id: Optional[int],
    breach_count: int,
    duration_sec: Optional[float],
    reason: str,
    escalation_level: int = 0,
    recipients: Optional[List[str]] = None,
    open_case: bool = True,
) -> bool:
    esc_cfg = get_escalation_config(db)
    use_escalation = esc_cfg.get('enabled') and escalation_level > 0

    if recipients is None:
        if use_escalation:
            levels = sorted(esc_cfg.get('levels', []), key=lambda x: x['level'])
            level_def = next((l for l in levels if l['level'] == escalation_level), None)
            recipients = get_level_recipient_emails(db, level_def) if level_def else []
        else:
            recipients = get_deviation_recipient_emails(db)

    if not recipients:
        return False

    cfg = db.query(EmailSmtpConfig).first()
    if not cfg or not cfg.email_address or not cfg.email_password:
        return False

    if segment_log_id and _already_sent(db, segment_log_id, alert_type, escalation_level):
        return False

    log = EmailLog(
        sent_at=now_ist(),
        recipients=', '.join(recipients),
        subject=subject,
        report_type='deviation_alert',
        status='pending',
    )
    db.add(log)
    db.flush()

    try:
        from .routers.email_router import do_send
        do_send(cfg, recipients, subject, body)
        log.status = 'sent'
        sent = True
    except Exception as exc:
        log.status = 'failed'
        log.error_msg = str(exc)
        sent = False

    db.add(DeviationAlertLog(
        sent_at=now_ist(),
        alert_type=alert_type,
        machine_id=machine_id,
        status=status,
        segment_log_id=segment_log_id,
        breach_count=breach_count,
        duration_sec=int(duration_sec) if duration_sec is not None else None,
        deviation_reason=reason or None,
        recipients=', '.join(recipients),
        subject=subject,
        email_log_id=log.id,
        delivery_status=log.status,
        escalation_level=escalation_level,
    ))

    if use_escalation and open_case and segment_log_id:
        _open_escalation_case(
            db,
            segment_log_id=segment_log_id,
            machine_id=machine_id,
            status=status,
            alert_type=alert_type,
            level=escalation_level,
        )

    db.commit()
    return sent


def _escalation_prefix(level_def: dict, elapsed_min: float) -> List[str]:
    label = level_def.get('label') or f"Level {level_def.get('level')}"
    return [
        f"ESCALATION LEVEL {level_def.get('level')} — {label}",
        f"No corrective action recorded within {int(elapsed_min)} minute(s) of the initial alert.",
        '',
    ]


def _build_threshold_body(
    ctx: dict,
    *,
    status: str,
    duration_sec: float,
    limit_sec: int,
    breach_count: int,
    started_at: datetime,
    ended_at: Optional[datetime],
    reason: str,
    source: str,
    ongoing: bool,
    escalation_lines: Optional[List[str]] = None,
) -> tuple[str, str]:
    label = _status_label(status)
    prefix = ''
    if escalation_lines:
        prefix = ' [ESCALATED]'
    subject = f"[PMS ALERT{prefix}] {label} threshold exceeded — {ctx['machine_name']} ({ctx['station_name']})"
    lines = ['Dear Team,', '']
    if escalation_lines:
        lines.extend(escalation_lines)
    lines.extend([
        f'A Loss Tracker threshold deviation has been detected.',
        '',
        f"Parameter deviated : {label}",
        f"Machine            : {ctx['machine_name']}",
        f"Station            : {ctx['station_name']}",
        f"Threshold limit    : {format_duration(limit_sec)}",
        f"Actual duration    : {format_duration(duration_sec)}",
        f"Occurrences today  : {breach_count} (including this event)",
        f"Segment started    : {_fmt_ist(started_at)}",
        f"Segment ended      : {_fmt_ist(ended_at) if ended_at else '(still ongoing)'}",
        f"Status             : {'Ongoing breach' if ongoing else 'Segment completed'}",
        f"Source             : {source or 'system'}",
        f"Deviation reason   : {reason.strip() if reason else '(not recorded yet)'}",
        '',
        'Please review the Loss Tracker dashboard and record a deviation reason if not already done.',
        '',
        f'Generated: {_fmt_ist(now_ist())}',
        'Delta EAP+ PMS — Deviation Alert Module',
    ])
    return subject, '\n'.join(lines)


def _build_immediate_body(
    ctx: dict,
    *,
    event_type: str,
    status: str,
    details: dict,
    escalation_lines: Optional[List[str]] = None,
) -> tuple[str, str]:
    label = _status_label(status)
    prefix = ' [ESCALATED]' if escalation_lines else ''
    if event_type == 'breakdown_raised':
        subject = f"[PMS ALERT{prefix}] Breakdown raised — {ctx['machine_name']} ({ctx['station_name']})"
        headline = 'A machine breakdown has been raised.'
    else:
        subject = f"[PMS ALERT{prefix}] {label} detected — {ctx['machine_name']} ({ctx['station_name']})"
        headline = f'A machine {label.lower()} event has been detected.'

    lines = ['Dear Team,', '']
    if escalation_lines:
        lines.extend(escalation_lines)
    lines.extend([
        headline,
        '',
        f"Event type         : {event_type.replace('_', ' ').title()}",
        f"Parameter / Status : {label}",
        f"Machine            : {ctx['machine_name']}",
        f"Station            : {ctx['station_name']}",
    ])
    for key, val in details.items():
        if val is not None and val != '':
            lines.append(f"{key.replace('_', ' ').title():<19}: {val}")
    lines.extend([
        '',
        f'Generated: {_fmt_ist(now_ist())}',
        'Delta EAP+ PMS — Deviation Alert Module',
    ])
    return subject, '\n'.join(lines)


def _first_escalation_level(esc_cfg: dict) -> int:
    levels = sorted(esc_cfg.get('levels', []), key=lambda x: x['level'])
    return levels[0]['level'] if levels else 1


def evaluate_completed_segment(db: Session, segment_log: MachineStatusLog, ended_at: datetime) -> bool:
    """Send alert when a status segment ended and exceeded its threshold."""
    status = segment_log.status
    limit = _limit_sec(status, db)
    if limit is None or status not in THRESHOLD_STATUSES:
        return False

    duration_sec = (ended_at - segment_log.changed_at).total_seconds()
    if duration_sec <= limit:
        return False

    esc_cfg = get_escalation_config(db)
    esc_level = _first_escalation_level(esc_cfg) if esc_cfg.get('enabled') else 0
    alert_type = 'threshold_breach'

    if _already_sent(db, segment_log.id, alert_type, esc_level):
        return False

    ctx = _machine_context(db, segment_log.machine_id)
    day_start = _shift_start_today(now_ist())
    breach_count = _count_breaches_today(db, segment_log.machine_id, status, day_start)

    subject, body = _build_threshold_body(
        ctx,
        status=status,
        duration_sec=duration_sec,
        limit_sec=limit,
        breach_count=breach_count,
        started_at=segment_log.changed_at,
        ended_at=ended_at,
        reason=segment_log.deviation_reason or '',
        source=segment_log.source or '',
        ongoing=False,
    )
    return _send_alert_email(
        db,
        subject=subject,
        body=body,
        alert_type=alert_type,
        machine_id=segment_log.machine_id,
        status=status,
        segment_log_id=segment_log.id,
        breach_count=breach_count,
        duration_sec=duration_sec,
        reason=segment_log.deviation_reason or '',
        escalation_level=esc_level,
    )


def evaluate_ongoing_segment(db: Session, segment_log: MachineStatusLog) -> bool:
    """Send alert for a segment still in progress that has exceeded threshold."""
    status = segment_log.status
    limit = _limit_sec(status, db)
    if limit is None or status not in THRESHOLD_STATUSES:
        return False

    now = now_ist()
    duration_sec = (now - segment_log.changed_at).total_seconds()
    if duration_sec <= limit:
        return False

    esc_cfg = get_escalation_config(db)
    esc_level = _first_escalation_level(esc_cfg) if esc_cfg.get('enabled') else 0
    alert_type = 'threshold_breach_ongoing'

    if _already_sent(db, segment_log.id, alert_type, esc_level):
        return False

    ctx = _machine_context(db, segment_log.machine_id)
    day_start = _shift_start_today(now)
    breach_count = _count_breaches_today(db, segment_log.machine_id, status, day_start)

    subject, body = _build_threshold_body(
        ctx,
        status=status,
        duration_sec=duration_sec,
        limit_sec=limit,
        breach_count=breach_count,
        started_at=segment_log.changed_at,
        ended_at=None,
        reason=segment_log.deviation_reason or '',
        source=segment_log.source or '',
        ongoing=True,
    )
    return _send_alert_email(
        db,
        subject=subject,
        body=body,
        alert_type=alert_type,
        machine_id=segment_log.machine_id,
        status=status,
        segment_log_id=segment_log.id,
        breach_count=breach_count,
        duration_sec=duration_sec,
        reason=segment_log.deviation_reason or '',
        escalation_level=esc_level,
    )


def on_status_logged(db: Session, machine_id: int, new_log: MachineStatusLog) -> None:
    """After a new status log row is persisted — evaluate the segment that just ended."""
    prior = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id == machine_id,
            MachineStatusLog.id != new_log.id,
            MachineStatusLog.changed_at <= new_log.changed_at,
        )
        .order_by(MachineStatusLog.changed_at.desc())
        .first()
    )
    if prior:
        evaluate_completed_segment(db, prior, new_log.changed_at)
        resolve_escalation_for_segment(db, prior.id, 'status_cleared')


def on_immediate_status_event(db: Session, machine_id: int, status: str, source: str) -> None:
    """Immediate alert when machine enters breakdown or alarm state."""
    if status not in IMMEDIATE_STATUSES:
        return

    latest = (
        db.query(MachineStatusLog)
        .filter(MachineStatusLog.machine_id == machine_id)
        .order_by(MachineStatusLog.changed_at.desc())
        .first()
    )
    segment_id = latest.id if latest else None

    esc_cfg = get_escalation_config(db)
    esc_level = _first_escalation_level(esc_cfg) if esc_cfg.get('enabled') else 0

    ctx = _machine_context(db, machine_id)
    details = {
        'detected_at': _fmt_ist(now_ist()),
        'source': source or 'system',
    }
    event_type = f'{status}_detected'
    if status == 'breakdown':
        ticket = (
            db.query(BreakdownTicket)
            .filter(
                BreakdownTicket.machine_id == machine_id,
                BreakdownTicket.status.in_(['raised', 'acknowledged', 'in_progress']),
            )
            .order_by(BreakdownTicket.created_at.desc())
            .first()
        )
        if ticket:
            event_type = 'breakdown_raised'
            details['ticket_id'] = ticket.id
            details['description'] = ticket.description or ''
            details['ticket_status'] = ticket.status

    alert_type = event_type
    if segment_id and _already_sent(db, segment_id, alert_type, esc_level):
        return

    subject, body = _build_immediate_body(
        ctx,
        event_type=event_type,
        status=status,
        details=details,
    )
    _send_alert_email(
        db,
        subject=subject,
        body=body,
        alert_type=alert_type,
        machine_id=machine_id,
        status=status,
        segment_log_id=segment_id,
        breach_count=1,
        duration_sec=None,
        reason=details.get('description', ''),
        escalation_level=esc_level,
    )


def scan_escalations(db: Session) -> int:
    """Escalate open cases to the next level when delay elapsed and no action taken."""
    esc_cfg = get_escalation_config(db)
    if not esc_cfg.get('enabled'):
        return 0

    levels = sorted(esc_cfg.get('levels', []), key=lambda x: x['level'])
    if len(levels) < 2:
        return 0

    level_by_num = {l['level']: l for l in levels}
    sent = 0
    now = now_ist()

    open_cases = db.query(DeviationEscalationCase).filter(
        DeviationEscalationCase.resolved_at.is_(None),
    ).all()

    for case in open_cases:
        if _is_action_taken(db, case):
            _resolve_case(db, case, 'action_taken')
            continue

        elapsed_min = (now - case.opened_at).total_seconds() / 60
        next_num = case.current_level + 1
        next_level = level_by_num.get(next_num)
        if not next_level:
            continue

        delay = next_level.get('delay_minutes', 0)
        if elapsed_min < delay:
            continue

        esc_alert_type = f"{case.alert_type}_escalation"
        if _already_sent(db, case.segment_log_id, esc_alert_type, next_num):
            case.current_level = next_num
            case.last_escalated_at = now
            continue

        ctx = _machine_context(db, case.machine_id)
        esc_lines = _escalation_prefix(next_level, elapsed_min)

        seg = None
        if case.segment_log_id:
            seg = db.query(MachineStatusLog).filter(
                MachineStatusLog.id == case.segment_log_id,
            ).first()

        reason = (seg.deviation_reason or '') if seg else ''
        duration_sec = None
        if seg:
            duration_sec = (now - seg.changed_at).total_seconds()

        if case.alert_type in ('threshold_breach', 'threshold_breach_ongoing'):
            limit = _limit_sec(case.status, db) or 0
            day_start = _shift_start_today(now)
            breach_count = _count_breaches_today(db, case.machine_id, case.status, day_start)
            subject, body = _build_threshold_body(
                ctx,
                status=case.status,
                duration_sec=duration_sec or 0,
                limit_sec=limit,
                breach_count=breach_count,
                started_at=seg.changed_at if seg else case.opened_at,
                ended_at=None,
                reason=reason,
                source=seg.source if seg else 'system',
                ongoing=True,
                escalation_lines=esc_lines,
            )
        else:
            details = {
                'detected_at': _fmt_ist(case.opened_at),
                'escalated_at': _fmt_ist(now),
                'minutes_without_action': str(int(elapsed_min)),
            }
            subject, body = _build_immediate_body(
                ctx,
                event_type=case.alert_type,
                status=case.status,
                details=details,
                escalation_lines=esc_lines,
            )

        if _send_alert_email(
            db,
            subject=subject,
            body=body,
            alert_type=esc_alert_type,
            machine_id=case.machine_id,
            status=case.status,
            segment_log_id=case.segment_log_id,
            breach_count=1,
            duration_sec=duration_sec,
            reason=reason,
            escalation_level=next_num,
            open_case=False,
        ):
            sent += 1

        case.current_level = next_num
        case.last_escalated_at = now

    db.commit()
    return sent


def scan_ongoing_breaches(db: Session) -> int:
    """Periodic scan — alert on segments still exceeding threshold. Returns alerts sent."""
    sent = 0
    machines = db.query(Machine.id).all()
    for (mid,) in machines:
        latest = (
            db.query(MachineStatusLog)
            .filter(MachineStatusLog.machine_id == mid)
            .order_by(MachineStatusLog.changed_at.desc())
            .first()
        )
        if not latest:
            continue
        if evaluate_ongoing_segment(db, latest):
            sent += 1
    sent += scan_escalations(db)
    return sent


def list_open_escalation_cases(db: Session, limit: int = 50) -> list:
    rows = (
        db.query(DeviationEscalationCase)
        .filter(DeviationEscalationCase.resolved_at.is_(None))
        .order_by(DeviationEscalationCase.opened_at.desc())
        .limit(limit)
        .all()
    )
    esc_cfg = get_escalation_config(db)
    level_labels = {l['level']: l.get('label', f"Level {l['level']}") for l in esc_cfg.get('levels', [])}
    out = []
    now = now_ist()
    for r in rows:
        ctx = _machine_context(db, r.machine_id)
        elapsed_min = int((now - r.opened_at).total_seconds() / 60)
        out.append({
            'id': r.id,
            'segment_log_id': r.segment_log_id,
            'machine_id': r.machine_id,
            'machine_name': ctx['machine_name'],
            'station_name': ctx['station_name'],
            'status': r.status,
            'status_label': _status_label(r.status),
            'alert_type': r.alert_type,
            'current_level': r.current_level,
            'current_level_label': level_labels.get(r.current_level, f"Level {r.current_level}"),
            'opened_at': r.opened_at.isoformat(sep=' ') if r.opened_at else None,
            'last_escalated_at': r.last_escalated_at.isoformat(sep=' ') if r.last_escalated_at else None,
            'minutes_open': elapsed_min,
            'action_pending': not _is_action_taken(db, r),
        })
    return out


def list_recent_alerts(db: Session, limit: int = 50) -> list:
    rows = (
        db.query(DeviationAlertLog)
        .order_by(DeviationAlertLog.sent_at.desc())
        .limit(limit)
        .all()
    )
    out = []
    for r in rows:
        ctx = _machine_context(db, r.machine_id)
        out.append({
            'id': r.id,
            'sent_at': r.sent_at.isoformat(sep=' ') if r.sent_at else None,
            'alert_type': r.alert_type,
            'status': r.status,
            'status_label': _status_label(r.status),
            'machine_id': r.machine_id,
            'machine_name': ctx['machine_name'],
            'station_name': ctx['station_name'],
            'breach_count': r.breach_count,
            'duration_sec': r.duration_sec,
            'duration_display': format_duration(r.duration_sec) if r.duration_sec else None,
            'deviation_reason': r.deviation_reason or '',
            'recipients': r.recipients,
            'subject': r.subject,
            'delivery_status': r.delivery_status,
            'escalation_level': r.escalation_level or 0,
        })
    return out
