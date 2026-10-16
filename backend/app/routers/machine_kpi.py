"""Machine KPI computation and historic storage."""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from datetime import date, datetime
from typing import Optional

from ..models import (
    Machine, Station, ProductionPlan,
    OEEEntry, MachineKpiLog, get_db, now_ist,
)
from ..auth import get_current_user
from .hourly_output import (
    _load_config, _shift_window, _effective_shift_end,
    _break_windows, _build_status_segments, _plan_ct, _plan_variant,
    _cfg_ld_unld_max_sec, _cfg_micro_gap_sec, _get_cycle_profile,
    _running_part_threshold_ratio, _countable_running_segments,
    _overlap, _parse_mins, auto_transition_shift_plans,
)

router = APIRouter(prefix="/api/machine-kpi", tags=["machine-kpi"])


def _sum_state_minutes(segments: list, states: set) -> float:
    return sum(
        seg['seconds'] / 60.0 for seg in segments if seg['state'] in states
    )


def _compute_kpi(
    db: Session,
    machine: Machine,
    entry_date: date,
    shift_id: str,
    cfg: dict,
) -> dict:
    shifts = [s for s in cfg.get('shifts', []) if s.get('enabled', True)]
    shift_def = next((s for s in shifts if s['id'] == shift_id), None)
    if not shift_def:
        return None

    shift_start, shift_end = _shift_window(entry_date, shift_def)
    effective_end = _effective_shift_end(shift_start, shift_end)
    is_live = shift_start < effective_end < shift_end

    break_cfg = (cfg.get('breaks') or {}).get(shift_id, {})
    breaks = _break_windows(break_cfg)
    ld_unld_max = _cfg_ld_unld_max_sec(cfg)
    micro_gap = _cfg_micro_gap_sec(cfg)
    threshold_ratio = _running_part_threshold_ratio(cfg)

    plans = db.query(ProductionPlan).filter(
        ProductionPlan.machine_id == machine.id,
        ProductionPlan.plan_date == entry_date,
        ProductionPlan.shift == shift_id,
        ProductionPlan.status.in_(['running', 'completed', 'paused', 'pending']),
    ).all()

    oee_entries = db.query(OEEEntry).filter(
        OEEEntry.machine_id == machine.id,
        OEEEntry.entry_date == entry_date,
        OEEEntry.shift == shift_id,
    ).all()

    cycle_profile = None
    active_variants = [
        _plan_variant(p) for p in plans
        if getattr(p, 'status', None) in ('running', 'completed', 'paused')
    ]
    if active_variants:
        profiles = [_get_cycle_profile(db, v) for v in active_variants]
        non_null = [p for p in profiles if p is not None]
        if non_null and len(non_null) == len(profiles):
            first = non_null[0]
            all_same = all(
                p.get('interruptions') == first.get('interruptions') and
                p.get('micro_run_threshold_sec') == first.get('micro_run_threshold_sec')
                for p in non_null
            )
            if all_same:
                cycle_profile = first

    segments = _build_status_segments(
        db, machine.id, shift_start, effective_end, cycle_profile, ld_unld_max, micro_gap,
    )

    shift_total_min = (shift_end - shift_start).total_seconds() / 60.0
    elapsed_min = (effective_end - shift_start).total_seconds() / 60.0

    break_min = 0.0
    sh_start_m = _parse_mins(shift_def['start'])
    sh_end_m = _parse_mins(shift_def['end'])
    for b in breaks:
        break_min += _overlap(sh_start_m, sh_end_m, b['start_m'], b['end_m'])

    standard_loss_min = break_min
    for e in oee_entries:
        for field in ('no_load', 'new_model_trial', 'power_cut', 'planned_maintenance', 'no_manpower_planned'):
            standard_loss_min += float(getattr(e, field, 0) or 0)

    available_time_min = max(0, shift_total_min - break_min)

    running_min = _sum_state_minutes(segments, {'running'})
    ld_unld_min = _sum_state_minutes(segments, {'ld_unld'})
    idle_min = _sum_state_minutes(segments, {'idle'})

    operating_time_min = running_min + ld_unld_min
    downtime_min = max(0, available_time_min - operating_time_min)
    actual_production_time_min = running_min

    ct = _plan_ct(plans[0]) if plans else 0.0
    planned_qty = sum(p.planned_qty or 0 for p in plans)
    model_variant = ' · '.join(set(_plan_variant(p) for p in plans if _plan_variant(p))) or None

    running_segs = [s for s in segments if s['state'] == 'running']
    actual_qty = _countable_running_segments(running_segs, ct, threshold_ratio) if ct > 0 else len(running_segs)

    if oee_entries:
        manual_actual = sum(e.actual_qty or 0 for e in oee_entries)
        if manual_actual > 0:
            actual_qty = max(actual_qty, manual_actual)

    good_qty = actual_qty
    defect_qty = 0
    if oee_entries:
        total_defect = sum(e.defect_qty or 0 for e in oee_entries)
        if total_defect > 0:
            defect_qty = total_defect
            good_qty = max(0, actual_qty - defect_qty)

    expected_qty = int(available_time_min * 60 / ct) if ct > 0 else 0
    theoretical_qty = int(shift_total_min * 60 / ct) if ct > 0 else 0

    # --- KPI Calculations ---
    # AR = Operating Time / Available Time × 100
    ar = min(round(operating_time_min / available_time_min * 100, 2), 100.0) if available_time_min > 0 else 0.0

    # PR = Actual Output / Expected Output × 100
    pr = round(actual_qty / expected_qty * 100, 2) if expected_qty > 0 else 0.0

    # QR = Good Units / Total Units × 100
    qr = round(good_qty / actual_qty * 100, 2) if actual_qty > 0 else 100.0

    # OEE = AR × PR × QR / 10000
    oee = round(ar * pr * qr / 10000, 2)

    # Machine Utilization Rate = Actual Production Time / Available Time × 100
    mur = min(round(actual_production_time_min / available_time_min * 100, 2), 100.0) if available_time_min > 0 else 0.0

    # Production Yield = Actual Output / Theoretical Output × 100
    prod_yield = round(actual_qty / theoretical_qty * 100, 2) if theoretical_qty > 0 else 0.0

    # TEEP = Actual Production Time / Total Calendar Time × 100
    # For shift-based: TEEP = OEE × MUR / 100
    teep = round(oee * mur / 100, 2)

    station = db.query(Station).filter(Station.id == machine.station_id).first()

    from ..operator_presence import get_live_operator_map, operator_fields_for_machine
    op = operator_fields_for_machine(
        get_live_operator_map(db, entry_date=entry_date, shift_id=shift_id),
        machine.id,
    )

    return {
        'machine_id': machine.id,
        'machine_name': machine.name,
        'machine_status': machine.status or 'idle',
        'machine_type': machine.machine_type,
        'make': machine.make,
        'model_no': machine.model_no,
        'image_url': machine.image_url,
        'station_name': station.display_name if station else str(machine.station_id),
        'location': machine.location or '',
        **op,
        'entry_date': str(entry_date),
        'shift': shift_id,
        'shift_name': shift_def.get('name', shift_id),
        'shift_start': shift_def['start'],
        'shift_end': shift_def['end'],
        'is_live': is_live,
        'model_variant': model_variant,
        'cycle_time_sec': ct,
        'available_time_min': round(available_time_min, 1),
        'operating_time_min': round(operating_time_min, 1),
        'downtime_min': round(downtime_min, 1),
        'actual_production_time_min': round(actual_production_time_min, 1),
        'planned_qty': planned_qty,
        'actual_qty': actual_qty,
        'good_qty': good_qty,
        'defect_qty': defect_qty,
        'expected_qty': expected_qty,
        'theoretical_qty': theoretical_qty,
        'kpi': {
            'ar': ar,
            'pr': pr,
            'qr': qr,
            'oee': oee,
            'machine_utilization': mur,
            'production_yield': prod_yield,
            'teep': teep,
        },
    }


def _save_kpi_snapshot(db: Session, data: dict, source: str = 'auto'):
    """Upsert a KPI snapshot for the machine/date/shift combination."""
    existing = db.query(MachineKpiLog).filter(
        MachineKpiLog.machine_id == data['machine_id'],
        MachineKpiLog.entry_date == data['entry_date'],
        MachineKpiLog.shift == data['shift'],
    ).first()

    kpi = data['kpi']
    fields = dict(
        model_variant=data.get('model_variant'),
        available_time_min=data.get('available_time_min'),
        operating_time_min=data.get('operating_time_min'),
        downtime_min=data.get('downtime_min'),
        actual_production_time_min=data.get('actual_production_time_min'),
        cycle_time_sec=data.get('cycle_time_sec'),
        planned_qty=data.get('planned_qty'),
        actual_qty=data.get('actual_qty'),
        good_qty=data.get('good_qty'),
        defect_qty=data.get('defect_qty'),
        expected_qty=data.get('expected_qty'),
        theoretical_qty=data.get('theoretical_qty'),
        ar=kpi['ar'],
        pr=kpi['pr'],
        qr=kpi['qr'],
        oee=kpi['oee'],
        machine_utilization=kpi['machine_utilization'],
        production_yield=kpi['production_yield'],
        teep=kpi['teep'],
        computed_at=now_ist(),
        source=source,
    )

    if existing:
        for k, v in fields.items():
            setattr(existing, k, v)
    else:
        existing = MachineKpiLog(
            machine_id=data['machine_id'],
            entry_date=data['entry_date'],
            shift=data['shift'],
            **fields,
        )
        db.add(existing)
    db.commit()


@router.get("/compute")
def compute_machine_kpi(
    machine_id: int = Query(...),
    entry_date: date = Query(...),
    shift: str = Query(...),
    save: bool = Query(True),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    machine = db.query(Machine).filter(Machine.id == machine_id).first()
    if not machine:
        raise HTTPException(404, "Machine not found")

    cfg = _load_config(db)

    shift_defs = [s for s in cfg.get('shifts', []) if s.get('enabled', True)]
    sd = next((s for s in shift_defs if s['id'] == shift), None)
    if sd:
        s_start, s_end = _shift_window(entry_date, sd)
        if s_start <= now_ist() < s_end:
            auto_transition_shift_plans(db, entry_date, shift, cfg)

    result = _compute_kpi(db, machine, entry_date, shift, cfg)
    if not result:
        raise HTTPException(400, f"Shift '{shift}' not found in config")

    if save:
        try:
            _save_kpi_snapshot(db, result, source='auto')
        except Exception:
            pass

    return result


@router.get("/history")
def get_kpi_history(
    machine_id: int = Query(...),
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(30),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(MachineKpiLog).filter(MachineKpiLog.machine_id == machine_id)
    if date_from:
        q = q.filter(MachineKpiLog.entry_date >= date_from)
    if date_to:
        q = q.filter(MachineKpiLog.entry_date <= date_to)
    rows = q.order_by(MachineKpiLog.entry_date.desc(), MachineKpiLog.shift).limit(limit).all()

    return [
        {
            'id': r.id,
            'machine_id': r.machine_id,
            'entry_date': str(r.entry_date),
            'shift': r.shift,
            'model_variant': r.model_variant,
            'ar': r.ar, 'pr': r.pr, 'qr': r.qr, 'oee': r.oee,
            'machine_utilization': r.machine_utilization,
            'production_yield': r.production_yield,
            'teep': r.teep,
            'actual_qty': r.actual_qty,
            'good_qty': r.good_qty,
            'defect_qty': r.defect_qty,
            'computed_at': r.computed_at.isoformat() if r.computed_at else None,
            'source': r.source,
        }
        for r in rows
    ]
