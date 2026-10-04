from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import extract, or_
from typing import Optional, List, Dict, Any
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from calendar import monthrange
import csv, io, json, logging
from ..models import (
    OEEEntry, OEEDefectLog, Machine, Station, ProductionPlan,
    WorkOrder, MachineStatusLog, SiteConfig, get_db, now_ist,
)
from ..auth import get_current_user
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/oee", tags=["oee"])

REJECTION_REASONS = [
    "Short Fill", "Sink Mark", "Burn Mark", "Flow Mark", "Silver Mark",
    "Warpage", "Blow Holes", "Black Spots", "Colour Variation", "Startup Rejection",
    "Parting Lines", "Flash", "Part Damage", "Bubble Mark", "Shrinkage",
    "Patch Mark", "Oil Mark", "Gloss", "Other",
]


def _normalize_rejection_reasons(raw: Optional[Dict[str, Any]]) -> Dict[str, int]:
    out = {r: 0 for r in REJECTION_REASONS}
    if not raw or not isinstance(raw, dict):
        return out
    for key, val in raw.items():
        name = str(key).strip()
        if name not in out:
            continue
        try:
            n = int(val or 0)
        except (TypeError, ValueError):
            n = 0
        out[name] = max(0, n)
    return out


def _rejection_note(reasons: Dict[str, int]) -> str:
    parts = [f"{k}: {v}" for k, v in reasons.items() if v > 0]
    return "; ".join(parts)

class OEECreate(BaseModel):
    entry_date: date
    station_no: int
    machine_id: Optional[int] = None
    shift: str
    current_operation: Optional[str] = ""
    next_operation: Optional[str] = ""
    model_variant: Optional[str] = None
    process_time: float
    loading_unloading: float
    start_time: str
    stop_time: str
    total_minutes: int
    lunch_break: int = 0
    tea_break: int = 0
    tpm_cleaning: int = 0
    other_cleaning: int = 0
    management_meeting: int = 0
    no_load: int = 0
    new_model_trial: int = 0
    power_cut: int = 0
    planned_maintenance: int = 0
    no_manpower_planned: int = 0
    setting_time: int = 0
    tool_change: int = 0
    dimension_correction: int = 0
    scrap_removal: int = 0
    break_down: int = 0
    actual_qty: int
    defect_qty: int = 0

def _cap(value: float) -> float:
    """Cap a percentage at 100. Returns the capped value."""
    return min(float(value), 100.0)


def _parse_mold_details(plan) -> dict:
    raw = getattr(plan, "mold_details_json", None) if plan is not None else None
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else dict(raw or {})
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}


def _running_cavity_from_plan(plan, default: int = 1) -> int:
    """Running cavity from plan mold snapshot (IMM). Minimum 1 for qty math."""
    details = _parse_mold_details(plan)
    raw = details.get("running_cavity")
    try:
        n = int(raw)
        return n if n > 0 else default
    except (TypeError, ValueError):
        return default


def _set_plan_running_cavity(plan, running_cavity: int) -> dict:
    details = _parse_mold_details(plan)
    details["running_cavity"] = int(running_cavity)
    plan.mold_details_json = json.dumps(details)
    return details


def _calculate_display_rates(ar_raw: float, pr_raw: float, qr_raw: float) -> dict:
    ar = _cap(ar_raw)
    pr = _cap(pr_raw)
    qr = _cap(qr_raw)
    oee = round(ar * pr * qr / 10000, 2)
    return {
        "ar": ar,
        "pr": pr,
        "qr": qr,
        "oee": oee,
    }


def _overlap_minutes(
    start: Optional[datetime],
    end: Optional[datetime],
    window_start: datetime,
    window_end: datetime,
) -> float:
    """Minutes of [start, end) overlapping [window_start, window_end). Open end → window_end."""
    if start is None:
        return 0.0
    if getattr(start, "tzinfo", None) is not None:
        start = start.replace(tzinfo=None)
    if end is not None and getattr(end, "tzinfo", None) is not None:
        end = end.replace(tzinfo=None)
    lo = max(start, window_start)
    hi = min(end or window_end, window_end)
    if hi <= lo:
        return 0.0
    return (hi - lo).total_seconds() / 60.0


def _batch_breakdown_downtime_min(
    db: Session,
    machine_ids: List[int],
    window_start: datetime,
    window_end: datetime,
) -> dict:
    """Planned / unplanned downtime minutes from Breakdown + Model Change dashboards.

    Unplanned → BreakdownTicket durations in the window.
    Planned   → ModelChangeRequest / setting_change durations in the window.
    Also folds MachineStatusLog segments (breakdown/alarm vs setting_change) so
    live status from the Breakdown screen is included.
    """
    from ..models import BreakdownTicket, ModelChangeRequest

    mids = [int(x) for x in (machine_ids or []) if x is not None]
    empty = {mid: {"planned_dt_min": 0.0, "unplanned_dt_min": 0.0} for mid in mids}
    if not mids or window_end <= window_start:
        return empty

    out = {mid: {"planned_dt_min": 0.0, "unplanned_dt_min": 0.0} for mid in mids}

    tickets = (
        db.query(BreakdownTicket)
        .filter(
            BreakdownTicket.machine_id.in_(mids),
            BreakdownTicket.created_at.isnot(None),
            BreakdownTicket.created_at < window_end,
            or_(
                BreakdownTicket.resolved_time.is_(None),
                BreakdownTicket.resolved_time > window_start,
            ),
        )
        .all()
    )
    for tk in tickets:
        mid = int(tk.machine_id)
        if mid not in out:
            continue
        mins = _overlap_minutes(
            tk.created_at, tk.resolved_time, window_start, window_end
        )
        if getattr(tk, "downtime_type", None) == "planned":
            out[mid]["planned_dt_min"] += mins
        else:
            out[mid]["unplanned_dt_min"] += mins

    mcrs = (
        db.query(ModelChangeRequest)
        .filter(
            ModelChangeRequest.machine_id.in_(mids),
            ModelChangeRequest.status.in_(("approved", "in_progress", "completed")),
            ModelChangeRequest.start_time.isnot(None),
            ModelChangeRequest.start_time < window_end,
            or_(
                ModelChangeRequest.end_time.is_(None),
                ModelChangeRequest.end_time > window_start,
            ),
        )
        .all()
    )
    for mcr in mcrs:
        mid = int(mcr.machine_id)
        if mid not in out:
            continue
        out[mid]["planned_dt_min"] += _overlap_minutes(
            mcr.start_time, mcr.end_time, window_start, window_end
        )

    # Status-log segments mirror Breakdown dashboard machine states
    logs = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id.in_(mids),
            MachineStatusLog.changed_at >= window_start - timedelta(hours=12),
            MachineStatusLog.changed_at < window_end + timedelta(minutes=1),
        )
        .order_by(MachineStatusLog.machine_id, MachineStatusLog.changed_at, MachineStatusLog.id)
        .all()
    )
    by_mid: dict = {}
    for lg in logs:
        by_mid.setdefault(int(lg.machine_id), []).append(lg)

    for mid, rows in by_mid.items():
        if mid not in out:
            continue
        planned_seg = 0.0
        unplanned_seg = 0.0
        for i, lg in enumerate(rows):
            seg_start = lg.changed_at
            if getattr(seg_start, "tzinfo", None) is not None:
                seg_start = seg_start.replace(tzinfo=None)
            seg_end = rows[i + 1].changed_at if i + 1 < len(rows) else window_end
            if getattr(seg_end, "tzinfo", None) is not None:
                seg_end = seg_end.replace(tzinfo=None)
            st = (lg.status or "").lower()
            mins = _overlap_minutes(seg_start, seg_end, window_start, window_end)
            if mins <= 0:
                continue
            if st == "setting_change":
                planned_seg += mins
            elif st in ("breakdown", "alarm"):
                unplanned_seg += mins
        # Prefer the larger of ticket/MCR vs status-log so nothing is double-missed
        out[mid]["planned_dt_min"] = max(out[mid]["planned_dt_min"], planned_seg)
        out[mid]["unplanned_dt_min"] = max(out[mid]["unplanned_dt_min"], unplanned_seg)

    return out


def _compute_imm_oee_rates(
    *,
    scheduled_min: float,
    planned_dt_min: float,
    unplanned_dt_min: float,
    units_produced: int,
    good_units: int,
    set_cycle_time_sec: float,
) -> dict:
    """IMM OEE per plant formula.

    Total Planned Production Time = Scheduled (shift start→now) − Planned DT
    Total Operating Time          = Planned Production Time − Unplanned DT
    Availability = Operating / Planned Production
    Performance  = (Units × Set CT) / Operating Time
    Quality      = Good / Units
    OEE          = A × P × Q
    """
    scheduled_min = max(0.0, float(scheduled_min or 0))
    planned_dt_min = max(0.0, float(planned_dt_min or 0))
    unplanned_dt_min = max(0.0, float(unplanned_dt_min or 0))
    units = max(0, int(units_produced or 0))
    good = max(0, min(int(good_units or 0), units) if units else 0)
    ct_sec = max(0.0, float(set_cycle_time_sec or 0))

    planned_prod_min = max(0.0, scheduled_min - planned_dt_min)
    operating_min = max(0.0, planned_prod_min - unplanned_dt_min)

    ar_raw = round((operating_min / planned_prod_min * 100.0), 2) if planned_prod_min > 0 else 0.0
    operating_sec = operating_min * 60.0
    if operating_sec > 0 and ct_sec > 0 and units > 0:
        pr_raw = round((units * ct_sec) / operating_sec * 100.0, 2)
    else:
        pr_raw = 0.0
    qr_raw = round((good / units * 100.0), 2) if units > 0 else 100.0

    rates = _calculate_display_rates(ar_raw, pr_raw, qr_raw)
    return {
        **rates,
        "ar_raw": ar_raw,
        "pr_raw": pr_raw,
        "qr_raw": qr_raw,
        "oee_raw": round(ar_raw * pr_raw * qr_raw / 10000, 2),
        "scheduled_min": round(scheduled_min, 2),
        "planned_dt_min": round(planned_dt_min, 2),
        "unplanned_dt_min": round(unplanned_dt_min, 2),
        "planned_prod_min": round(planned_prod_min, 2),
        "operating_min": round(operating_min, 2),
    }


def calculate_oee(data: OEECreate) -> dict:
    # CT = Process Time + Loading & Unloading (seconds)
    ct = data.process_time + data.loading_unloading

    # Shift Working Min = Total Minutes - Total Breaks
    total_breaks = data.lunch_break + data.tea_break + data.tpm_cleaning + data.other_cleaning + data.management_meeting
    shift_working = data.total_minutes - total_breaks

    # Available Shift Time = Shift Working Min - Mgmt Loss Total
    mgmt_loss = data.no_load + data.new_model_trial + data.power_cut + data.planned_maintenance + data.no_manpower_planned
    available = shift_working - mgmt_loss

    # Operating Time = Available Shift Time - Total Down Time
    total_down = data.setting_time + data.tool_change + data.dimension_correction + data.scrap_removal + data.break_down
    operating = available - total_down

    # Possible Qty = (Operating Time * 60) / CT  [operating in min, CT in sec]
    possible_qty = int((operating * 60) / ct) if ct > 0 else 0

    # Production Loss = Possible Qty - Actual Qty
    production_loss = max(0, possible_qty - data.actual_qty)

    # Accepted Qty = Actual Qty - Defect Qty
    accp_qty = max(0, data.actual_qty - data.defect_qty)

    # Raw (uncapped) rates
    ar_raw = round((operating / available * 100), 2) if available > 0 else 0
    pr_raw = round((data.actual_qty / possible_qty * 100), 2) if possible_qty > 0 else 0
    qr_raw = round((accp_qty / data.actual_qty * 100), 2) if data.actual_qty > 0 else 0
    oee_raw = round(ar_raw * pr_raw * qr_raw / 10000, 2)

    # Capped rates (display / stored values — never exceed 100%)
    rates = _calculate_display_rates(ar_raw, pr_raw, qr_raw)
    ar = rates["ar"]
    pr = rates["pr"]
    qr = rates["qr"]
    oee = rates["oee"]

    return {
        "available_shift_time": available,
        "operating_time": operating,
        "possible_qty": possible_qty,
        "accp_qty": accp_qty,
        "ar": ar, "pr": pr, "qr": qr, "oee": oee,
        # Original uncapped values tracked for audit
        "ar_raw": ar_raw, "pr_raw": pr_raw, "qr_raw": qr_raw, "oee_raw": oee_raw,
        # Flags indicating which values were capped
        "ar_capped":  ar_raw  > 100,
        "pr_capped":  pr_raw  > 100,
        "qr_capped":  qr_raw  > 100,
        "oee_capped": oee_raw > oee,
    }

@router.post("/")
def create_entry(data: OEECreate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    from ..models import ProductionPlan
    calc = calculate_oee(data)
    # Only store raw values when capping actually occurred
    entry_fields = {
        k: v for k, v in calc.items()
        if k not in ("ar_capped", "pr_capped", "qr_capped", "oee_capped")
    }
    if not calc["ar_capped"]:  entry_fields.pop("ar_raw",  None)
    if not calc["pr_capped"]:  entry_fields.pop("pr_raw",  None)
    if not calc["qr_capped"]:  entry_fields.pop("qr_raw",  None)
    if not calc["oee_capped"]: entry_fields.pop("oee_raw", None)
    entry = OEEEntry(**data.model_dump(), **entry_fields, created_by=user.id)
    db.add(entry)
    db.flush()

    # Sync actual_qty to matching production plan
    plan = db.query(ProductionPlan).filter(
        ProductionPlan.plan_date == data.entry_date,
        ProductionPlan.shift == data.shift,
        ProductionPlan.station_no == data.station_no,
        ProductionPlan.current_operation == data.current_operation,
        ProductionPlan.next_operation == data.next_operation,
    ).first()
    if plan:
        plan.actual_qty = data.actual_qty
        if data.actual_qty >= plan.planned_qty and plan.status in ("pending", "running"):
            from .plans import _validate_may_complete_plan
            _validate_may_complete_plan(plan)
            plan.status = "completed"

    db.commit()
    db.refresh(entry)
    return entry

@router.get("/")
def get_entries(
    shift: Optional[str] = None,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    current_operation: Optional[str] = None,
    model: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user)
):
    q = db.query(OEEEntry)
    if shift: q = q.filter(OEEEntry.shift == shift)
    if entry_date: q = q.filter(OEEEntry.entry_date == entry_date)
    if date_from: q = q.filter(OEEEntry.entry_date >= date_from)
    if date_to: q = q.filter(OEEEntry.entry_date <= date_to)
    if month: q = q.filter(extract("month", OEEEntry.entry_date) == month)
    if year: q = q.filter(extract("year", OEEEntry.entry_date) == year)
    if station_no: q = q.filter(OEEEntry.station_no == station_no)
    if machine_id: q = q.filter(OEEEntry.machine_id == machine_id)
    term = (search or model or current_operation or "").strip()
    if term:
        like = f"%{term}%"
        q = q.filter(or_(
            OEEEntry.current_operation.like(like),
            OEEEntry.model_variant.like(like),
        ))
    entries = q.order_by(OEEEntry.entry_date.desc(), OEEEntry.shift).all()

    dates = {e.entry_date for e in entries}
    plans = []
    if dates:
        plans = db.query(ProductionPlan).filter(ProductionPlan.plan_date.in_(dates)).all()
    wo_ids = {p.work_order_id for p in plans if p.work_order_id}
    wo_map = {}
    if wo_ids:
        wos = db.query(WorkOrder).filter(WorkOrder.id.in_(wo_ids)).all()
        wo_map = {w.id: w.work_order_no for w in wos}

    plan_wo = {}
    plan_by_mach = {}
    for p in plans:
        key = (p.machine_id, str(p.plan_date), p.shift, p.current_operation)
        if p.work_order_id and p.work_order_id in wo_map:
            plan_wo[key] = wo_map[p.work_order_id]
        mkey = (p.machine_id, str(p.plan_date), p.shift)
        prev = plan_by_mach.get(mkey)
        if prev is None or (p.status == "running" and prev.status != "running"):
            plan_by_mach[mkey] = p

    result = []
    for e in entries:
        d = {c.name: getattr(e, c.name) for c in e.__table__.columns}
        key = (e.machine_id, str(e.entry_date), e.shift, e.current_operation)
        d["work_order_no"] = plan_wo.get(key, "—")
        d["source"] = "manual"
        plan = plan_by_mach.get((e.machine_id, str(e.entry_date), e.shift))
        cav = _running_cavity_from_plan(plan, default=1) if plan else 1
        d["running_cavity"] = cav
        d["plan_id"] = plan.id if plan else None
        actual = int(e.actual_qty or 0)
        # Derive shot count from stored parts when cavity known
        d["shot_count"] = int(actual // cav) if cav > 0 else actual
        result.append(d)
    return result

@router.get("/summary")
def get_summary(
    shift: Optional[str] = None,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    current_operation: Optional[str] = None,
    model: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user)
):
    from sqlalchemy import func
    q = db.query(OEEEntry)
    if shift: q = q.filter(OEEEntry.shift == shift)
    if entry_date: q = q.filter(OEEEntry.entry_date == entry_date)
    if date_from: q = q.filter(OEEEntry.entry_date >= date_from)
    if date_to: q = q.filter(OEEEntry.entry_date <= date_to)
    if month: q = q.filter(extract("month", OEEEntry.entry_date) == month)
    if year: q = q.filter(extract("year", OEEEntry.entry_date) == year)
    if station_no: q = q.filter(OEEEntry.station_no == station_no)
    if machine_id: q = q.filter(OEEEntry.machine_id == machine_id)
    term = (search or model or current_operation or "").strip()
    if term:
        like = f"%{term}%"
        q = q.filter(or_(
            OEEEntry.current_operation.like(like),
            OEEEntry.model_variant.like(like),
        ))
    entries = q.all()
    if not entries:
        return {
            "avg_ar": 0, "avg_pr": 0, "avg_qr": 0, "avg_oee": 0,
            "plant_oee": 0, "total_actual": 0, "total_accp": 0, "total_defect": 0,
            "count": 0, "machine_count": 0,
        }
    n = len(entries)
    avg_oee = round(sum(float(e.oee or 0) for e in entries) / n, 2)
    return {
        "avg_ar": round(sum(float(e.ar or 0) for e in entries) / n, 2),
        "avg_pr": round(sum(float(e.pr or 0) for e in entries) / n, 2),
        "avg_qr": round(sum(float(e.qr or 0) for e in entries) / n, 2),
        "avg_oee": avg_oee,
        # Overall plant efficiency = cumulative OEE of all machines / machine count
        "plant_oee": avg_oee,
        "total_actual": sum(e.actual_qty or 0 for e in entries),
        "total_accp": sum(e.accp_qty or 0 for e in entries),
        "total_defect": sum(e.defect_qty or 0 for e in entries),
        "count": n,
        "machine_count": n,
    }

def _compute_realtime_oee_for_date(
    db: Session,
    target_date: date,
    cfg: dict,
    *,
    shift: Optional[str] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    sync_actuals: bool = False,
) -> list:
    """Compute per-machine realtime OEE rows for a single plan date."""
    from .hourly_output import (
        _break_windows, _build_status_segments,
        _countable_running_segments, _running_part_threshold_ratio,
        auto_transition_shift_plans, _shift_window,
        sync_plan_actuals_from_status_logs,
    )

    enabled_shifts = [s for s in cfg.get("shifts", []) if s.get("enabled")]
    if shift:
        enabled_shifts = [s for s in enabled_shifts if s["id"] == shift]
    if not enabled_shifts:
        return []

    _now = datetime.now()
    if sync_actuals:
        for sh_def in enabled_shifts:
            s_start, s_end = _shift_window(target_date, sh_def)
            if s_start <= _now < s_end:
                auto_transition_shift_plans(db, target_date, sh_def['id'], cfg)

        sync_plan_actuals_from_status_logs(
            db,
            entry_date=target_date,
            machine_id=machine_id,
            shift=shift,
            commit=True,
        )

    plan_q = db.query(ProductionPlan).filter(ProductionPlan.plan_date == target_date)
    if station_no:
        plan_q = plan_q.filter(ProductionPlan.station_no == station_no)
    if machine_id:
        plan_q = plan_q.filter(ProductionPlan.machine_id == machine_id)
    all_plans = plan_q.all()
    if not all_plans:
        return []

    wo_ids = {p.work_order_id for p in all_plans if p.work_order_id}
    wo_map = {}
    if wo_ids:
        wos = db.query(WorkOrder).filter(WorkOrder.id.in_(wo_ids)).all()
        wo_map = {w.id: w.work_order_no for w in wos}

    machine_ids = {p.machine_id for p in all_plans if p.machine_id}
    machines = db.query(Machine).filter(Machine.id.in_(machine_ids)).all() if machine_ids else []
    machine_map = {m.id: m for m in machines}

    station_ids = {m.station_id for m in machines}
    stations = db.query(Station).filter(Station.id.in_(station_ids)).all() if station_ids else []
    station_map = {st.id: st for st in stations}

    threshold_ratio = _running_part_threshold_ratio(cfg)

    results = []
    for sh in enabled_shifts:
        sh_id = sh["id"]
        break_cfg = cfg.get("breaks", {}).get(sh_id, {})
        breaks = _break_windows(break_cfg)

        sh_start_hm = sh["start"]
        sh_end_hm = sh["end"]
        start_h, start_min = map(int, sh_start_hm.split(":"))
        end_h, end_min = map(int, sh_end_hm.split(":"))

        shift_start = datetime.combine(target_date, datetime.min.time()).replace(
            hour=start_h, minute=start_min
        )
        overnight = (end_h * 60 + end_min) <= (start_h * 60 + start_min)
        if overnight:
            shift_end = (datetime.combine(target_date, datetime.min.time()) + timedelta(days=1)).replace(
                hour=end_h, minute=end_min
            )
        else:
            shift_end = datetime.combine(target_date, datetime.min.time()).replace(
                hour=end_h, minute=end_min
            )

        shift_total_mins = (shift_end - shift_start).total_seconds() / 60.0
        total_break_mins = sum(b["minutes"] for b in breaks)
        available_mins = shift_total_mins - total_break_mins

        shift_plans = [
            p for p in all_plans
            if p.shift == sh_id and p.machine_id is not None
        ]

        plans_by_machine = {}
        for p in shift_plans:
            plans_by_machine.setdefault(p.machine_id, []).append(p)

        now = now_ist()
        if getattr(now, "tzinfo", None) is not None:
            now = now.replace(tzinfo=None)
        # Scheduled time = shift start → current (cap at shift end)
        effective_end = min(shift_end, now) if now > shift_start else shift_start
        scheduled_min = max(0.0, (effective_end - shift_start).total_seconds() / 60.0)

        mid_list = list(plans_by_machine.keys())
        dt_by_mid = _batch_breakdown_downtime_min(db, mid_list, shift_start, effective_end)

        # Defects from saved OEE rows (QC edits) for good-units quality
        defect_by_mid = {}
        if mid_list:
            oee_saved = (
                db.query(OEEEntry)
                .filter(
                    OEEEntry.entry_date == target_date,
                    OEEEntry.shift == str(sh_id),
                    OEEEntry.machine_id.in_(mid_list),
                )
                .order_by(OEEEntry.id.desc())
                .all()
            )
            for row in oee_saved:
                mid = int(row.machine_id) if row.machine_id is not None else None
                if mid is not None and mid not in defect_by_mid:
                    defect_by_mid[mid] = max(0, int(row.defect_qty or 0))

        for mid, mplans in plans_by_machine.items():
            m = machine_map.get(mid)
            if not m:
                continue
            st = station_map.get(m.station_id)

            # Prefer running / highest-priority plan for mold cavity + set CT
            status_rank = {"running": 0, "paused": 1, "completed": 2, "pending": 3}
            mplans_sorted = sorted(
                mplans,
                key=lambda p: (status_rank.get(p.status, 9), p.priority or 9999, p.id),
            )
            primary_plan = mplans_sorted[0] if mplans_sorted else None

            primary_ct = 0.0
            for p in mplans_sorted:
                ct = float(p.process_time or 0) + float(p.loading_unloading or 0)
                if ct > 0:
                    primary_ct = ct
                    break

            # Shot count from OPC UA / status-tag cycle sequences
            from ..imm_shot_counter import count_machine_shots
            shot_count = count_machine_shots(db, mid, shift_start, effective_end)
            running_cavity = _running_cavity_from_plan(primary_plan, default=1)
            # Total units produced = shots × actual running cavity
            actual_qty = int(shot_count) * int(running_cavity)

            total_planned = sum(p.planned_qty or 0 for p in mplans)
            # Theoretical capacity over planned production time (for Possible qty display)
            dt = dt_by_mid.get(mid) or {"planned_dt_min": 0.0, "unplanned_dt_min": 0.0}
            planned_dt = float(dt.get("planned_dt_min") or 0)
            unplanned_dt = float(dt.get("unplanned_dt_min") or 0)

            defect_qty = int(defect_by_mid.get(mid) or 0)
            accp_qty = max(0, actual_qty - defect_qty)

            imm = _compute_imm_oee_rates(
                scheduled_min=scheduled_min,
                planned_dt_min=planned_dt,
                unplanned_dt_min=unplanned_dt,
                units_produced=actual_qty,
                good_units=accp_qty,
                set_cycle_time_sec=primary_ct,
            )

            planned_prod_min = float(imm["planned_prod_min"])
            operating_min = float(imm["operating_min"])
            if primary_ct > 0 and operating_min > 0:
                possible_shots = int(operating_min * (60.0 / primary_ct))
                possible_qty = possible_shots * int(running_cavity)
            elif primary_ct > 0 and planned_prod_min > 0:
                possible_shots = int(planned_prod_min * (60.0 / primary_ct))
                possible_qty = possible_shots * int(running_cavity)
            else:
                possible_qty = total_planned

            prod_loss = max(0, possible_qty - actual_qty)

            wo_no_list = list({wo_map.get(p.work_order_id, "") for p in mplans if p.work_order_id})
            wo_display = ", ".join(w for w in wo_no_list if w) or "—"

            model_variants = list({(p.model_variant or "").strip() for p in mplans})
            model_display = ", ".join(v for v in model_variants if v) or "—"

            cur_op = primary_plan.current_operation if primary_plan else ""
            next_op = primary_plan.next_operation if primary_plan else ""

            results.append({
                "id": f"rt_{mid}_{sh_id}_{target_date.isoformat()}",
                "source": "realtime",
                "entry_date": target_date.isoformat(),
                "station_no": m.station_id,
                "station_name": st.display_name if st else f"Station {m.station_id}",
                "machine_id": mid,
                "machine_name": m.name,
                "shift": sh_id,
                "work_order_no": wo_display,
                "model_variant": model_display,
                "current_operation": cur_op,
                "next_operation": next_op,
                "running_cavity": running_cavity,
                "shot_count": int(shot_count),
                "plan_id": primary_plan.id if primary_plan else None,
                "process_time": float(primary_ct) if primary_ct else 0,
                "loading_unloading": 0,
                "cycle_time": float(primary_ct) if primary_ct else 0,
                # IMM time base
                "scheduled_min": imm["scheduled_min"],
                "planned_dt_min": imm["planned_dt_min"],
                "unplanned_dt_min": imm["unplanned_dt_min"],
                "planned_prod_min": imm["planned_prod_min"],
                "available_shift_time": round(imm["planned_prod_min"]),
                "operating_time": round(imm["operating_min"]),
                "possible_qty": possible_qty,
                "actual_qty": actual_qty,
                "production_loss": prod_loss,
                "accp_qty": accp_qty,
                "defect_qty": defect_qty,
                "ar": imm["ar"],
                "pr": imm["pr"],
                "qr": imm["qr"],
                "oee": imm["oee"],
                "ar_raw": imm["ar_raw"],
                "pr_raw": imm["pr_raw"],
                "qr_raw": imm["qr_raw"],
                "oee_raw": imm["oee_raw"],
                "planned_qty": total_planned,
                "formula": "imm_v1",
            })

    return results


@router.get("/realtime")
def realtime_oee(
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    shift: Optional[str] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Compute per-machine OEE from status logs + production plans (real-time).

    Returns entries compatible with the manual OEE data but flagged as
    ``source: 'realtime'`` so the Dashboard can display both sources.
    """
    from .config import DEFAULT_CONFIG, merge_config

    row = db.query(SiteConfig).first()
    if row:
        cfg = merge_config(json.loads(row.config_json))
    else:
        cfg = dict(DEFAULT_CONFIG)

    today = date.today()
    target_dates: list[date] = []

    if date_from and date_to:
        if date_from > date_to:
            date_from, date_to = date_to, date_from
        cursor = date_from
        while cursor <= date_to:
            target_dates.append(cursor)
            cursor += timedelta(days=1)
    else:
        target_dates = [entry_date or today]

    results = []
    for target_date in target_dates:
        results.extend(_compute_realtime_oee_for_date(
            db,
            target_date,
            cfg,
            shift=shift,
            station_no=station_no,
            machine_id=machine_id,
            sync_actuals=(target_date == today),
        ))

    return results


class DefectUpdate(BaseModel):
    defect_qty: Optional[int] = None
    note: Optional[str] = ""
    rejection_reasons: Optional[Dict[str, int]] = None


class DefectUpdateByMachine(BaseModel):
    machine_id: int
    entry_date: date
    shift: str
    defect_qty: Optional[int] = None
    note: Optional[str] = ""
    rejection_reasons: Optional[Dict[str, int]] = None


class RunningCavityUpdate(BaseModel):
    machine_id: int
    entry_date: date
    shift: str
    running_cavity: int
    plan_id: Optional[int] = None


def _load_site_config(db: Session) -> dict:
    from .config import DEFAULT_CONFIG, merge_config

    row = db.query(SiteConfig).first()
    if row:
        return merge_config(json.loads(row.config_json))
    return dict(DEFAULT_CONFIG)


def _as_date(val) -> Optional[date]:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    if isinstance(val, str):
        return date.fromisoformat(val[:10])
    return val


def _resolve_report_dates(
    db: Session,
    *,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
) -> List[date]:
    """Resolve which calendar dates a report should cover."""
    if entry_date:
        return [entry_date]
    if date_from or date_to:
        start = date_from or date_to
        end = date_to or date_from
        if start > end:
            start, end = end, start
        out = []
        cur = start
        while cur <= end:
            out.append(cur)
            cur += timedelta(days=1)
        return out
    if month and year:
        _, last = monthrange(year, month)
        return [date(year, month, d) for d in range(1, last + 1)]

    entry_dates = {r[0] for r in db.query(OEEEntry.entry_date).distinct().all() if r[0]}
    plan_dates = {r[0] for r in db.query(ProductionPlan.plan_date).distinct().all() if r[0]}
    return sorted(entry_dates | plan_dates)


def _manual_entry_to_report_row(
    e: OEEEntry,
    *,
    station_name: str = "",
    machine_name: str = "",
    work_order_no: str = "",
    planned_qty=None,
    running_cavity=None,
    shot_count=None,
) -> SimpleNamespace:
    cav = running_cavity if running_cavity is not None else getattr(e, "running_cavity", None)
    shots = shot_count if shot_count is not None else getattr(e, "shot_count", None)
    if shots is None and cav and int(cav) > 0:
        shots = int((e.actual_qty or 0) // int(cav))
    return SimpleNamespace(
        id=e.id,
        source="manual",
        entry_date=_as_date(e.entry_date),
        station_no=e.station_no,
        station_name=station_name,
        machine_id=e.machine_id,
        machine_name=machine_name,
        shift=e.shift,
        work_order_no=work_order_no or "",
        model_variant=e.model_variant or "",
        current_operation=e.current_operation or "",
        next_operation=e.next_operation or "",
        running_cavity=cav,
        shot_count=shots,
        process_time=float(e.process_time or 0),
        loading_unloading=float(e.loading_unloading or 0),
        start_time=e.start_time or "",
        stop_time=e.stop_time or "",
        total_minutes=int(e.total_minutes or 0),
        lunch_break=int(e.lunch_break or 0),
        tea_break=int(e.tea_break or 0),
        tpm_cleaning=int(e.tpm_cleaning or 0),
        other_cleaning=int(e.other_cleaning or 0),
        management_meeting=int(e.management_meeting or 0),
        total_breaks=int(getattr(e, "total_breaks", 0) or 0),
        shift_working_minutes=int(getattr(e, "shift_working_minutes", 0) or 0),
        no_load=int(e.no_load or 0),
        new_model_trial=int(e.new_model_trial or 0),
        power_cut=int(e.power_cut or 0),
        planned_maintenance=int(e.planned_maintenance or 0),
        no_manpower_planned=int(e.no_manpower_planned or 0),
        management_loss_total=int(getattr(e, "management_loss_total", 0) or 0),
        available_shift_time=int(e.available_shift_time or 0),
        setting_time=int(e.setting_time or 0),
        tool_change=int(e.tool_change or 0),
        dimension_correction=int(e.dimension_correction or 0),
        scrap_removal=int(e.scrap_removal or 0),
        break_down=int(e.break_down or 0),
        total_down_time=int(getattr(e, "total_down_time", 0) or 0),
        operating_time=int(e.operating_time or 0),
        possible_qty=int(e.possible_qty or 0),
        actual_qty=int(e.actual_qty or 0),
        production_loss=max(0, int(e.possible_qty or 0) - int(e.actual_qty or 0)),
        accp_qty=int(e.accp_qty or 0),
        defect_qty=int(e.defect_qty or 0),
        ar=float(e.ar or 0),
        pr=float(e.pr or 0),
        qr=float(e.qr or 0),
        oee=float(e.oee or 0),
        ar_raw=float(e.ar_raw) if e.ar_raw is not None else None,
        pr_raw=float(e.pr_raw) if e.pr_raw is not None else None,
        qr_raw=float(e.qr_raw) if e.qr_raw is not None else None,
        oee_raw=float(e.oee_raw) if e.oee_raw is not None else None,
        planned_qty=planned_qty,
    )


def _realtime_to_report_row(rt: dict) -> SimpleNamespace:
    possible = int(rt.get("possible_qty") or 0)
    actual = int(rt.get("actual_qty") or 0)
    return SimpleNamespace(
        id=None,
        source="realtime",
        entry_date=_as_date(rt.get("entry_date")),
        station_no=rt.get("station_no"),
        station_name=rt.get("station_name") or "",
        machine_id=rt.get("machine_id"),
        machine_name=rt.get("machine_name") or "",
        shift=rt.get("shift"),
        work_order_no=rt.get("work_order_no") or "",
        model_variant=rt.get("model_variant") or "",
        current_operation=rt.get("current_operation") or "",
        next_operation=rt.get("next_operation") or "",
        running_cavity=rt.get("running_cavity"),
        shot_count=rt.get("shot_count"),
        process_time=float(rt.get("process_time") or 0),
        loading_unloading=float(rt.get("loading_unloading") or 0),
        start_time="",
        stop_time="",
        total_minutes=0,
        lunch_break=0,
        tea_break=0,
        tpm_cleaning=0,
        other_cleaning=0,
        management_meeting=0,
        total_breaks=0,
        shift_working_minutes=0,
        no_load=0,
        new_model_trial=0,
        power_cut=0,
        planned_maintenance=0,
        no_manpower_planned=0,
        management_loss_total=0,
        available_shift_time=int(rt.get("available_shift_time") or 0),
        setting_time=0,
        tool_change=0,
        dimension_correction=0,
        scrap_removal=0,
        break_down=0,
        total_down_time=0,
        operating_time=int(rt.get("operating_time") or 0),
        possible_qty=possible,
        actual_qty=actual,
        production_loss=max(0, possible - actual),
        accp_qty=int(rt.get("accp_qty") or actual),
        defect_qty=int(rt.get("defect_qty") or 0),
        ar=float(rt.get("ar") or 0),
        pr=float(rt.get("pr") or 0),
        qr=float(rt.get("qr") or 100),
        oee=float(rt.get("oee") or 0),
        ar_raw=None,
        pr_raw=None,
        qr_raw=None,
        oee_raw=None,
        planned_qty=rt.get("planned_qty"),
    )


def collect_merged_oee_report_rows(
    db: Session,
    *,
    shift: Optional[str] = None,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    search: Optional[str] = None,
    prefer_live: bool = True,
) -> List[SimpleNamespace]:
    """Build report rows from live capture + data entry.

    Default ``prefer_live=True``: use realtime when available for a
    machine/shift/date key; otherwise fall back to persisted ``OEEEntry``.
    This matches the requirement that emailed/downloaded reports include
    live Dashboard data even when Data Entry was never submitted.
    """
    cfg = _load_site_config(db)
    target_dates = _resolve_report_dates(
        db,
        entry_date=entry_date,
        date_from=date_from,
        date_to=date_to,
        month=month,
        year=year,
    )
    if not target_dates:
        return []

    station_map = {s.id: (s.display_name or s.name) for s in db.query(Station).all()}
    machine_map = {m.id: m.name for m in db.query(Machine).all()}

    # Manual / data-entry rows
    q = db.query(OEEEntry).filter(OEEEntry.entry_date.in_(target_dates))
    if shift:
        q = q.filter(OEEEntry.shift == shift)
    if station_no:
        q = q.filter(OEEEntry.station_no == station_no)
    if machine_id:
        q = q.filter(OEEEntry.machine_id == machine_id)
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        q = q.filter(or_(
            OEEEntry.current_operation.like(like),
            OEEEntry.model_variant.like(like),
        ))
    manual_entries = q.all()

    all_plans = db.query(ProductionPlan).filter(ProductionPlan.plan_date.in_(target_dates)).all()
    wo_ids = {p.work_order_id for p in all_plans if p.work_order_id}
    wo_map = (
        {w.id: w.work_order_no for w in db.query(WorkOrder).filter(WorkOrder.id.in_(wo_ids)).all()}
        if wo_ids else {}
    )
    plan_lookup = {}
    for p in all_plans:
        key = (p.machine_id, str(p.plan_date), p.shift, p.current_operation or "")
        wo_no = wo_map.get(p.work_order_id, "")
        existing = plan_lookup.get(key)
        if not existing:
            plan_lookup[key] = {"wo": wo_no, "planned": p.planned_qty or 0}
        else:
            existing["planned"] += (p.planned_qty or 0)
            if wo_no and not existing["wo"]:
                existing["wo"] = wo_no

    # Also aggregate planned qty / WO by machine+shift+date for enrichment
    plan_msd = {}
    for p in all_plans:
        k = (p.machine_id, str(p.plan_date), p.shift)
        wo_no = wo_map.get(p.work_order_id, "")
        existing = plan_msd.get(k)
        if not existing:
            plan_msd[k] = {"wo": wo_no, "planned": p.planned_qty or 0}
        else:
            existing["planned"] += (p.planned_qty or 0)
            if wo_no and wo_no not in (existing["wo"] or ""):
                existing["wo"] = ", ".join(x for x in [existing["wo"], wo_no] if x)

    plan_primary = {}
    for p in all_plans:
        k = (p.machine_id, str(p.plan_date), p.shift)
        prev = plan_primary.get(k)
        if prev is None or (p.status == "running" and getattr(prev, "status", None) != "running"):
            plan_primary[k] = p

    manual_rows = []
    for e in manual_entries:
        pl = plan_lookup.get(
            (e.machine_id, str(e.entry_date), e.shift, e.current_operation or ""),
            {},
        )
        if not pl:
            pl = plan_msd.get((e.machine_id, str(e.entry_date), e.shift), {})
        plan = plan_primary.get((e.machine_id, str(e.entry_date), e.shift))
        cav = _running_cavity_from_plan(plan, default=1) if plan else None
        manual_rows.append(_manual_entry_to_report_row(
            e,
            station_name=station_map.get(e.station_no, str(e.station_no)),
            machine_name=machine_map.get(e.machine_id, "") if e.machine_id else "",
            work_order_no=pl.get("wo", ""),
            planned_qty=pl.get("planned"),
            running_cavity=cav,
        ))

    # Live / realtime rows
    live_rows = []
    for d in target_dates:
        try:
            rt_list = _compute_realtime_oee_for_date(
                db,
                d,
                cfg,
                shift=shift,
                station_no=station_no,
                machine_id=machine_id,
                sync_actuals=False,
            )
        except Exception as exc:
            log.warning("Realtime OEE failed for %s: %s", d, exc)
            continue
        for rt in rt_list:
            if term:
                blob = f"{rt.get('current_operation') or ''} {rt.get('model_variant') or ''}".lower()
                if term.lower() not in blob:
                    continue
            live_rows.append(_realtime_to_report_row(rt))

    def _key(row: SimpleNamespace):
        ed = row.entry_date.isoformat() if isinstance(row.entry_date, date) else str(row.entry_date)
        return (row.machine_id, row.shift, ed)

    merged: dict = {}
    if prefer_live:
        # Data entry first as base, live overwrites when present
        for row in manual_rows:
            merged[_key(row)] = row
        for row in live_rows:
            merged[_key(row)] = row
    else:
        for row in live_rows:
            merged[_key(row)] = row
        for row in manual_rows:
            merged[_key(row)] = row

    rows = list(merged.values())
    rows.sort(
        key=lambda r: (
            r.entry_date or date.min,
            r.shift or "",
            r.station_no or 0,
            r.machine_name or "",
        ),
        reverse=True,
    )
    return rows


def _find_oee_entry(db: Session, machine_id: int, entry_date: date, shift: str) -> Optional[OEEEntry]:
    return db.query(OEEEntry).filter(
        OEEEntry.machine_id == machine_id,
        OEEEntry.entry_date == entry_date,
        OEEEntry.shift == shift,
    ).first()


def _materialize_oee_from_realtime(
    db: Session,
    machine_id: int,
    entry_date: date,
    shift: str,
    user_id: int,
    cfg: dict,
) -> OEEEntry:
    """Create a persisted OEE row from the live/realtime snapshot (for QC defect updates)."""
    from .hourly_output import _shift_window

    rt_rows = _compute_realtime_oee_for_date(
        db,
        entry_date,
        cfg,
        shift=shift,
        machine_id=machine_id,
        sync_actuals=False,
    )
    rt = next((r for r in rt_rows if r["machine_id"] == machine_id and r["shift"] == shift), None)
    if not rt:
        raise HTTPException(404, "No live OEE data found for this machine/shift/date")

    shift_def = next((s for s in cfg.get("shifts", []) if s.get("id") == shift), None)
    if not shift_def:
        raise HTTPException(400, f"Unknown shift: {shift}")

    shift_start, shift_end = _shift_window(entry_date, shift_def)
    total_minutes = max(1, int((shift_end - shift_start).total_seconds() / 60))

    entry = OEEEntry(
        entry_date=entry_date,
        station_no=rt["station_no"],
        machine_id=machine_id,
        shift=shift,
        current_operation=rt.get("current_operation") or "",
        next_operation=rt.get("next_operation") or "",
        model_variant=rt.get("model_variant") or None,
        process_time=float(rt.get("process_time") or 0),
        loading_unloading=float(rt.get("loading_unloading") or 0),
        start_time=shift_def.get("start", "06:00"),
        stop_time=shift_def.get("end", "14:00"),
        total_minutes=total_minutes,
        available_shift_time=int(rt.get("available_shift_time") or 0),
        operating_time=int(rt.get("operating_time") or 0),
        possible_qty=int(rt.get("possible_qty") or 0),
        actual_qty=int(rt.get("actual_qty") or 0),
        accp_qty=int(rt.get("accp_qty") or rt.get("actual_qty") or 0),
        defect_qty=int(rt.get("defect_qty") or 0),
        ar=float(rt.get("ar") or 0),
        pr=float(rt.get("pr") or 0),
        qr=float(rt.get("qr") or 100),
        oee=float(rt.get("oee") or 0),
        created_by=user_id,
    )
    db.add(entry)
    db.flush()
    return entry


def _apply_defect_update(
    entry: OEEEntry,
    defect_qty: Optional[int],
    note: str,
    user_id: int,
    db: Session,
    rejection_reasons: Optional[Dict[str, int]] = None,
) -> dict:
    before_defect = entry.defect_qty or 0
    before_accp = entry.accp_qty or 0
    before_qr = float(entry.qr or 0)
    before_oee = float(entry.oee or 0)

    reasons = _normalize_rejection_reasons(rejection_reasons) if rejection_reasons is not None else None
    if reasons is not None:
        new_defect = sum(reasons.values())
        auto_note = _rejection_note(reasons)
        note = (note or "").strip() or auto_note
        rejection_payload = json.dumps(reasons)
    else:
        if defect_qty is None:
            raise HTTPException(400, "defect_qty or rejection_reasons is required")
        new_defect = max(0, int(defect_qty))
        rejection_payload = getattr(entry, "rejection_json", None)

    actual = entry.actual_qty or 0
    if new_defect > actual:
        raise HTTPException(400, "Defect qty cannot exceed actual qty")
    new_accp = max(0, actual - new_defect)
    qr_raw_new = round(new_accp / actual * 100, 2) if actual > 0 else 0
    ar = float(entry.ar or 0)
    pr = float(entry.pr or 0)
    rates_new = _calculate_display_rates(ar, pr, qr_raw_new)
    new_qr = rates_new["qr"]
    oee_raw_new = round(ar * pr * qr_raw_new / 10000, 2)
    new_oee = rates_new["oee"]

    log_row = OEEDefectLog(
        oee_entry_id=entry.id,
        updated_at=now_ist(),
        updated_by=user_id,
        before_defect_qty=before_defect,
        before_accp_qty=before_accp,
        before_qr=before_qr,
        before_oee=before_oee,
        after_defect_qty=new_defect,
        after_accp_qty=new_accp,
        after_qr=new_qr,
        after_oee=new_oee,
        note=note or "",
        rejection_json=rejection_payload if reasons is not None else None,
    )
    db.add(log_row)

    entry.defect_qty = new_defect
    entry.accp_qty = new_accp
    entry.qr = new_qr
    entry.qr_raw = qr_raw_new if qr_raw_new > 100 else None
    entry.oee = new_oee
    entry.oee_raw = oee_raw_new if oee_raw_new > new_oee else None
    if reasons is not None:
        entry.rejection_json = rejection_payload
    db.commit()
    db.refresh(entry)
    return {
        "id": entry.id,
        "defect_qty": new_defect,
        "accp_qty": new_accp,
        "qr": new_qr,
        "oee": new_oee,
        "qr_raw": qr_raw_new if qr_raw_new > 100 else None,
        "oee_raw": oee_raw_new if oee_raw_new > new_oee else None,
        "rejection_json": getattr(entry, "rejection_json", None),
        "rejection_reasons": reasons,
        "before": {
            "defect_qty": before_defect,
            "accp_qty": before_accp,
            "qr": before_qr,
            "oee": before_oee,
        },
    }


@router.patch("/defect/by-machine")
def update_defect_by_machine(
    data: DefectUpdateByMachine,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Update defect qty for live/realtime dashboard rows (any date/shift).

    Materializes a persisted OEE entry from the realtime snapshot when needed.
    """
    entry = _find_oee_entry(db, data.machine_id, data.entry_date, data.shift)
    if not entry:
        cfg = _load_site_config(db)
        entry = _materialize_oee_from_realtime(
            db,
            data.machine_id,
            data.entry_date,
            data.shift,
            user.id,
            cfg,
        )
    return _apply_defect_update(
        entry, data.defect_qty, data.note or "", user.id, db,
        rejection_reasons=data.rejection_reasons,
    )


@router.get("/rejection-reasons")
def get_rejection_reasons(_=Depends(get_current_user)):
    return {"reasons": REJECTION_REASONS}


@router.get("/rejection/by-machine")
def get_rejection_by_machine(
    machine_id: int = Query(...),
    entry_date: date = Query(...),
    shift: str = Query(...),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Latest rejection breakdown for machine/date/shift (for Rejection Log modal)."""
    entry = _find_oee_entry(db, machine_id, entry_date, shift)
    if not entry:
        return {
            "machine_id": machine_id,
            "entry_date": entry_date.isoformat(),
            "shift": shift,
            "defect_qty": 0,
            "actual_qty": 0,
            "rejection_reasons": {r: 0 for r in REJECTION_REASONS},
            "rejection_json": None,
        }
    parsed = None
    if entry.rejection_json:
        try:
            parsed = json.loads(entry.rejection_json)
        except Exception:
            parsed = None
    reasons = _normalize_rejection_reasons(parsed)
    return {
        "id": entry.id,
        "machine_id": machine_id,
        "entry_date": entry_date.isoformat(),
        "shift": shift,
        "defect_qty": int(entry.defect_qty or 0),
        "actual_qty": int(entry.actual_qty or 0),
        "rejection_reasons": reasons,
        "rejection_json": entry.rejection_json,
    }


@router.patch("/running-cavity")
async def update_running_cavity(
    data: RunningCavityUpdate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Update editable Running Cavity on the production plan for a dashboard row.

    Actual parts on the live dashboard = shot_count × running_cavity.
    """
    if data.running_cavity is None or int(data.running_cavity) < 1:
        raise HTTPException(400, "Running cavity must be at least 1")
    cav = int(data.running_cavity)

    plan = None
    if data.plan_id:
        plan = db.query(ProductionPlan).filter(ProductionPlan.id == data.plan_id).first()
    if not plan:
        plans = (
            db.query(ProductionPlan)
            .filter(
                ProductionPlan.machine_id == data.machine_id,
                ProductionPlan.plan_date == data.entry_date,
                ProductionPlan.shift == data.shift,
                ProductionPlan.status.in_(["running", "paused", "pending", "completed", "incomplete"]),
            )
            .all()
        )
        if not plans:
            raise HTTPException(404, "No production plan found for this machine/date/shift")
        status_rank = {"running": 0, "paused": 1, "completed": 2, "pending": 3}
        plans.sort(key=lambda p: (status_rank.get(p.status, 9), p.priority or 9999, p.id))
        plan = plans[0]

    _set_plan_running_cavity(plan, cav)
    plan.updated_at = now_ist()
    db.commit()

    # Recalculate live row so client can refresh Actual / Possible / OEE
    cfg = _load_site_config(db)
    rt_rows = _compute_realtime_oee_for_date(
        db,
        data.entry_date,
        cfg,
        shift=data.shift,
        machine_id=data.machine_id,
        sync_actuals=False,
    )
    rt = next(
        (r for r in rt_rows if r.get("machine_id") == data.machine_id and r.get("shift") == data.shift),
        None,
    )

    from ..ws_manager import manager
    await manager.broadcast({"type": "oee_updated", "machine_id": data.machine_id})

    return {
        "plan_id": plan.id,
        "running_cavity": cav,
        "shot_count": (rt or {}).get("shot_count"),
        "actual_qty": (rt or {}).get("actual_qty"),
        "possible_qty": (rt or {}).get("possible_qty"),
        "production_loss": (rt or {}).get("production_loss"),
        "ar": (rt or {}).get("ar"),
        "pr": (rt or {}).get("pr"),
        "qr": (rt or {}).get("qr"),
        "oee": (rt or {}).get("oee"),
        "accp_qty": (rt or {}).get("accp_qty"),
    }


def _format_defect_log(db: Session, entry_id: int) -> list:
    from ..models import User

    logs = db.query(OEEDefectLog).filter(OEEDefectLog.oee_entry_id == entry_id)\
              .order_by(OEEDefectLog.updated_at.desc()).all()
    user_map = {u.id: u.username for u in db.query(User).all()}
    return [{
        "id": l.id,
        "updated_at": l.updated_at.strftime('%Y-%m-%d %H:%M:%S IST'),
        "updated_by": user_map.get(l.updated_by, str(l.updated_by)),
        "before_defect_qty": l.before_defect_qty, "before_accp_qty": l.before_accp_qty,
        "rejection_json": getattr(l, "rejection_json", None),
        "before_qr": float(l.before_qr or 0), "before_oee": float(l.before_oee or 0),
        "after_defect_qty": l.after_defect_qty, "after_accp_qty": l.after_accp_qty,
        "after_qr": float(l.after_qr or 0), "after_oee": float(l.after_oee or 0),
        "note": l.note or ""
    } for l in logs]


@router.get("/defect-log/by-machine")
def get_defect_log_by_machine(
    machine_id: int,
    entry_date: date,
    shift: str,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    entry = _find_oee_entry(db, machine_id, entry_date, shift)
    if not entry:
        return []
    return _format_defect_log(db, entry.id)


@router.patch("/{entry_id}/defect")
def update_defect(entry_id: int, data: DefectUpdate,
                  db: Session = Depends(get_db),
                  user=Depends(get_current_user)):
    entry = db.query(OEEEntry).filter(OEEEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found")
    return _apply_defect_update(
        entry, data.defect_qty, data.note or "", user.id, db,
        rejection_reasons=data.rejection_reasons,
    )

@router.get("/{entry_id}/defect-log")
def get_defect_log(entry_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return _format_defect_log(db, entry_id)

@router.get("/download-xlsx")
def download_xlsx(
    shift: Optional[str] = None,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    current_operation: Optional[str] = None,
    model: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user)
):
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from fastapi.responses import Response
    from ..models import OEEDefectLog, User

    term = (search or model or current_operation or "").strip()
    entries = collect_merged_oee_report_rows(
        db,
        shift=shift,
        entry_date=entry_date,
        date_from=date_from,
        date_to=date_to,
        month=month,
        year=year,
        station_no=station_no,
        machine_id=machine_id,
        search=term or None,
        prefer_live=True,
    )

    user_map = {u.id: u.username for u in db.query(User).all()}

    def fmt_ist(dt_val):
        if not dt_val: return ''
        return dt_val.strftime('%d-%m-%Y %H:%M:%S IST')

    wb = openpyxl.Workbook()
    hdr_fill = PatternFill("solid", fgColor="1E3A5F")
    hdr_font = Font(bold=True, color="FFFFFF")
    red_f = Font(bold=True, color="DC2626")
    grn_f = Font(bold=True, color="059669")
    amb_f = Font(bold=True, color="D97706")

    def make_header(ws, hdrs):
        ws.append(hdrs)
        for c in range(1, len(hdrs)+1):
            cell = ws.cell(1, c)
            cell.fill = hdr_fill; cell.font = hdr_font
            cell.alignment = Alignment(horizontal="center")
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    # ── OEE sheet ──
    ws_oee = wb.active
    ws_oee.title = "OEE Report"
    oee_hdrs = ["Date","Station","Machine","Shift","Work Order","Model / Variant",
                "Running Cavity","Shot Counts","CT (sec)",
                "Avail (min)","Op Time (min)","Plan Qty","Possible Qty","Actual Qty",
                "Prod Loss","Accepted Qty","Defect Qty",
                "AR%","PR%","QR%","OEE%",
                "AR% (original)","PR% (original)","QR% (original)","OEE% (original)",
                "Source"]
    make_header(ws_oee, oee_hdrs)
    for e in entries:
        ct = (e.process_time or 0) + (e.loading_unloading or 0)
        prod_loss = max(0, (e.possible_qty or 0) - (e.actual_qty or 0))
        ar_val  = float(e.ar  or 0)
        pr_val  = float(e.pr  or 0)
        qr_val  = float(e.qr  or 0)
        oee_val = float(e.oee or 0)
        ar_raw  = float(e.ar_raw  or 0) if e.ar_raw is not None else None
        pr_raw  = float(e.pr_raw  or 0) if e.pr_raw is not None else None
        qr_raw  = float(e.qr_raw  or 0) if e.qr_raw is not None else None
        oee_raw = float(e.oee_raw or 0) if e.oee_raw is not None else None
        plan_qty = e.planned_qty if e.planned_qty is not None else ""
        run_cav = getattr(e, "running_cavity", None)
        shots = getattr(e, "shot_count", None)
        if shots is None and run_cav and int(run_cav or 0) > 0:
            shots = int((e.actual_qty or 0) // int(run_cav))
        ws_oee.append([
            str(e.entry_date), e.station_name or str(e.station_no or ""),
            e.machine_name or "",
            e.shift, e.work_order_no or "", e.model_variant or "",
            run_cav if run_cav is not None else "",
            shots if shots is not None else "",
            ct, e.available_shift_time, e.operating_time,
            plan_qty, e.possible_qty, e.actual_qty, prod_loss,
            e.accp_qty, e.defect_qty,
            ar_val, pr_val, qr_val, oee_val,
            ar_raw  if ar_raw  is not None else "—",
            pr_raw  if pr_raw  is not None else "—",
            qr_raw  if qr_raw  is not None else "—",
            oee_raw if oee_raw is not None else "—",
            "Live" if e.source == "realtime" else "Data Entry",
        ])
        ri = ws_oee.max_row
        ws_oee.cell(ri, 21).font = grn_f if oee_val>=85 else (amb_f if oee_val>=65 else red_f)
        for col, raw in [(18, ar_raw), (19, pr_raw), (20, qr_raw), (21, oee_raw)]:
            if raw is not None:
                ws_oee.cell(ri, col).font = amb_f
    for i, w in enumerate([12,14,12,8,18,16,14,14,10,12,14,10,12,12,10,12,12,8,8,8,8,14,14,14,14,12], 1):
        ws_oee.column_dimensions[ws_oee.cell(1,i).column_letter].width = w

    # ── QC Logs sheet ──
    entry_ids = [e.id for e in entries if e.id]
    qc_logs = []
    if entry_ids:
        qc_logs = db.query(OEEDefectLog)\
                    .filter(OEEDefectLog.oee_entry_id.in_(entry_ids))\
                    .order_by(OEEDefectLog.updated_at.desc()).all()
    entry_map = {e.id: e for e in entries if e.id}

    ws_qc = wb.create_sheet("QC Logs")
    qc_hdrs = [
        "Current Operation","Next Operation","Entry Date","Shift","Station",
        "Updated At (IST)","Updated By",
        "Before Defect","Before Accp","Before QR%","Before OEE%",
        "After Defect", "After Accp", "After QR%", "After OEE%",
        "Note"
    ]
    make_header(ws_qc, qc_hdrs)

    if not qc_logs:
        ws_qc.append(["No QC updates found for the selected filters."])
    else:
        for l in qc_logs:
            e = entry_map.get(l.oee_entry_id)
            before_oee = float(l.before_oee or 0)
            after_oee  = float(l.after_oee  or 0)
            ws_qc.append([
                e.current_operation if e else "", e.next_operation if e else "",
                str(e.entry_date) if e else "", e.shift if e else "",
                (e.station_name if e else "") or (str(e.station_no) if e else ""),
                fmt_ist(l.updated_at),
                user_map.get(l.updated_by, str(l.updated_by) if l.updated_by else ""),
                l.before_defect_qty, l.before_accp_qty,
                f"{float(l.before_qr or 0):.2f}%", f"{before_oee:.2f}%",
                l.after_defect_qty,  l.after_accp_qty,
                f"{float(l.after_qr  or 0):.2f}%", f"{after_oee:.2f}%",
                l.note or "",
            ])
            ri = ws_qc.max_row
            bf = ws_qc.cell(ri, 11)
            bf.font = grn_f if before_oee>=85 else (amb_f if before_oee>=65 else red_f)
            af = ws_qc.cell(ri, 15)
            af.font = grn_f if after_oee>=85  else (amb_f if after_oee>=65  else red_f)

    for i, w in enumerate([18,18,12,8,14,22,14,14,12,12,12,12,12,12,12,35], 1):
        ws_qc.column_dimensions[ws_qc.cell(1,i).column_letter].width = w

    # ── OEE Daywise sheet ──
    from collections import defaultdict
    day_groups = defaultdict(list)
    for e in entries:
        day_groups[(str(e.entry_date), e.station_no)].append(e)

    ws_day = wb.create_sheet("OEE Daywise")
    day_hdrs = ["Date","Station","AR%","PR%","QR%","OEE%","Total Produced","Accepted Qty","Defects"]
    make_header(ws_day, day_hdrs)
    for (dt, pno), grp in sorted(day_groups.items()):
        n = len(grp)
        avg_ar  = round(sum(float(e.ar  or 0) for e in grp) / n, 2)
        avg_pr  = round(sum(float(e.pr  or 0) for e in grp) / n, 2)
        avg_qr  = round(sum(float(e.qr  or 0) for e in grp) / n, 2)
        avg_oee = round(sum(float(e.oee or 0) for e in grp) / n, 2)
        tot_act  = sum(e.actual_qty  or 0 for e in grp)
        tot_accp = sum(e.accp_qty    or 0 for e in grp)
        tot_def  = sum(e.defect_qty  or 0 for e in grp)
        station_label = grp[0].station_name if grp else str(pno)
        ws_day.append([dt, station_label,
                       avg_ar, avg_pr, avg_qr, avg_oee,
                       tot_act, tot_accp, tot_def])
        ri = ws_day.max_row
        ws_day.cell(ri, 6).font = grn_f if avg_oee >= 85 else (amb_f if avg_oee >= 65 else red_f)
    for i, w in enumerate([12,14,8,8,8,8,14,14,10], 1):
        ws_day.column_dimensions[ws_day.cell(1,i).column_letter].width = w

    # ── OEE Shiftwise sheet ──
    shift_groups = defaultdict(list)
    for e in entries:
        shift_groups[(str(e.entry_date), e.station_no, e.shift)].append(e)

    ws_shift = wb.create_sheet("OEE Shiftwise")
    shift_hdrs = ["Date","Station","Shift","Actual","Prod Loss","Accepted","Defects","AR%","PR%","QR%","OEE%"]
    make_header(ws_shift, shift_hdrs)
    for (dt, pno, sh), grp in sorted(shift_groups.items()):
        n = len(grp)
        tot_act  = sum(e.actual_qty  or 0 for e in grp)
        tot_loss = sum(max(0, (e.possible_qty or 0) - (e.actual_qty or 0)) for e in grp)
        tot_accp = sum(e.accp_qty    or 0 for e in grp)
        tot_def  = sum(e.defect_qty  or 0 for e in grp)
        avg_ar   = round(sum(float(e.ar  or 0) for e in grp) / n, 2)
        avg_pr   = round(sum(float(e.pr  or 0) for e in grp) / n, 2)
        avg_qr   = round(sum(float(e.qr  or 0) for e in grp) / n, 2)
        avg_oee  = round(sum(float(e.oee or 0) for e in grp) / n, 2)
        station_label = grp[0].station_name if grp else str(pno)
        ws_shift.append([dt, station_label, sh,
                         tot_act, tot_loss, tot_accp, tot_def,
                         avg_ar, avg_pr, avg_qr, avg_oee])
        ri = ws_shift.max_row
        ws_shift.cell(ri, 11).font = grn_f if avg_oee >= 85 else (amb_f if avg_oee >= 65 else red_f)
    for i, w in enumerate([12,14,8,10,10,12,10,8,8,8,8], 1):
        ws_shift.column_dimensions[ws_shift.cell(1,i).column_letter].width = w

    buf = io.BytesIO()
    wb.save(buf)
    label = str(entry_date or date_from or month or "report")
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="oee_report_{label}.xlsx"'}
    )


@router.get("/download")
def download_csv(
    shift: Optional[str] = None,
    entry_date: Optional[date] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    station_no: Optional[int] = None,
    machine_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user)
):
    entries = collect_merged_oee_report_rows(
        db,
        shift=shift,
        entry_date=entry_date,
        month=month,
        year=year,
        station_no=station_no,
        machine_id=machine_id,
        prefer_live=True,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date","Station","Machine","Shift","Work Order","Model / Variant",
                     "Current Operation","Next Operation","CT",
                     "Start","Stop","Total Min",
                     "Lunch","Tea","TPM","Other Clean","Mgmt Mtg","No Load","New Model","Power Cut",
                     "Planned Maint","No Manpower","Avail Time","Setting","Tool Change","Dim Corr",
                     "Scrap","Breakdown","Operating Time","Plan Qty","Possible Qty","Actual Qty","Accp Qty",
                     "Defect Qty","AR%","PR%","QR%","OEE%",
                     "AR% (original)","PR% (original)","QR% (original)","OEE% (original)",
                     "Source"])
    for e in entries:
        plan_qty = e.planned_qty if e.planned_qty is not None else ""
        writer.writerow([e.entry_date, e.station_name or str(e.station_no or ""),
                         e.machine_name or "",
                         e.shift, e.work_order_no or "", e.model_variant or "",
                         e.current_operation, e.next_operation,
                         (e.process_time or 0)+(e.loading_unloading or 0), e.start_time, e.stop_time,
                         e.total_minutes, e.lunch_break, e.tea_break, e.tpm_cleaning, e.other_cleaning,
                         e.management_meeting, e.no_load, e.new_model_trial, e.power_cut,
                         e.planned_maintenance, e.no_manpower_planned, e.available_shift_time,
                         e.setting_time, e.tool_change, e.dimension_correction, e.scrap_removal,
                         e.break_down, e.operating_time, plan_qty,
                         e.possible_qty, e.actual_qty, e.accp_qty,
                         e.defect_qty, e.ar, e.pr, e.qr, e.oee,
                         float(e.ar_raw  or 0) if e.ar_raw  is not None else "",
                         float(e.pr_raw  or 0) if e.pr_raw  is not None else "",
                         float(e.qr_raw  or 0) if e.qr_raw  is not None else "",
                         float(e.oee_raw or 0) if e.oee_raw is not None else "",
                         "Live" if e.source == "realtime" else "Data Entry"])
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=oee_report.csv"})
