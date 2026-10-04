"""IMM History analytics — Transfer Rate, Hit Rate, Equipment Parameter dashboards."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..models import (
    ImmKpivSample,
    ImmKpivThreshold,
    ImmOpcuaLatest,
    ImmOpcuaSample,
    Machine,
    MachineStatusLog,
    Station,
    get_db,
    now_ist,
)
from .imm_dashboard import _build_zones_from_config, _load_factory_tree, _match_shift_at, _opcua_sum, HOURLY_RUNNING_RATE_COLORS
from .hourly_output import _shift_slots
from .config import _load_config
from .imm_monitor import KPIV_META, KPIV_TAGS

router = APIRouter(prefix="/api/imm/history", tags=["imm-history-analytics"])

ZONE_PALETTE = [
    "#38bdf8",
    "#77AF46",
    "#f97316",
    "#22cae7",
    "#a78bfa",
    "#eab308",
    "#f43f5e",
    "#14b8a6",
]


def _zone_machine_map(db: Session) -> Tuple[List[dict], Dict[str, List[int]], Dict[int, Machine]]:
    from ..energy_meter import is_energy_utility_machine, iter_production_machines

    stations = {s.id: s for s in db.query(Station).all()}
    # Production IMMs only — exclude EM_PLANT / energy utility hosts from KPI pickers
    machines = iter_production_machines(db, order=True)
    by_id = {m.id: m for m in machines}
    factories = _load_factory_tree(db)
    zones_meta = _build_zones_from_config(factories, stations, machines)
    zone_machines: Dict[str, List[int]] = {}
    zones = []
    for z in zones_meta:
        sids = set(z.get("station_ids") or [])
        mids = [
            m.id
            for m in machines
            if m.station_id in sids and not is_energy_utility_machine(m)
        ]
        # also location-path machines already merged in station_ids by dashboard builder
        zone_machines[str(z["id"])] = mids
        zones.append(
            {
                "id": str(z["id"]),
                "name": z.get("name") or "Zone",
                "factory_name": z.get("factory_name") or "",
                "stations": z.get("stations") or [],
                "machine_ids": mids,
            }
        )
    return zones, zone_machines, by_id


def _day_list(days: int) -> List[date]:
    today = now_ist().date()
    n = max(1, min(int(days), 90))
    return [today - timedelta(days=(n - 1 - i)) for i in range(n)]


def _slot_bounds(day: date, from_minutes: int, shift_start_m: int, overnight: bool) -> Tuple[datetime, datetime]:
    base = datetime.combine(day, datetime.min.time())
    if overnight and from_minutes < shift_start_m:
        base = base + timedelta(days=1)
    start = base + timedelta(minutes=int(from_minutes))
    end = start + timedelta(minutes=60)
    return start, end


def _transfer_pct_for_machines(db: Session, mids: List[int]) -> Optional[float]:
    if not mids:
        return None
    good = _opcua_sum(db, mids, "Total_Good_Count")
    bad = _opcua_sum(db, mids, "Total_Bad_Count")
    prod = _opcua_sum(db, mids, "Actual_Production_Count")
    target = _opcua_sum(db, mids, "Production_Target_Count")
    return _pct_from_counts(good, bad, prod, target)


def _daily_sample_sum(db: Session, mids: List[int], param_key: str, day: date) -> Optional[float]:
    if not mids:
        return None
    start = datetime.combine(day, datetime.min.time())
    end = start + timedelta(days=1)
    row = (
        db.query(func.max(ImmOpcuaSample.value_num))
        .filter(
            ImmOpcuaSample.machine_id.in_(mids),
            ImmOpcuaSample.param_key == param_key,
            ImmOpcuaSample.recorded_at >= start,
            ImmOpcuaSample.recorded_at < end,
            ImmOpcuaSample.value_num.isnot(None),
        )
        .scalar()
    )
    return float(row) if row is not None else None


TRANSFER_PARAM_KEYS = (
    "Total_Good_Count",
    "Total_Bad_Count",
    "Actual_Production_Count",
    "Production_Target_Count",
)

# IMM controllers often publish an unset target as ~1e8; that is not a real plan qty.
_MAX_PLAUSIBLE_TARGET = 1_000_000.0


def _usable_production_target(target: float, good: float, bad: float, prod: float) -> bool:
    """Reject placeholder / absurd Production_Target_Count values."""
    if target is None or target <= 0:
        return False
    if target >= _MAX_PLAUSIBLE_TARGET:
        return False
    output = max(float(good or 0), float(prod or 0), float(good or 0) + float(bad or 0))
    # Target many times larger than anything produced → treat as unset
    if output > 0 and target > output * 50:
        return False
    return True


def _pct_from_counts(good, bad, prod, target) -> Optional[float]:
    """
    Transfer Rate % = stock_in / finished * 100
      stock_in = Total_Good_Count (else Actual_Production_Count)
      finished = Production_Target_Count when plausible;
                 else Actual_Production_Count;
                 else good+bad
    """
    if good is None and prod is None and target is None and bad is None:
        return None
    g = float(good or 0.0)
    b = float(bad or 0.0)
    p = float(prod or 0.0)
    t = float(target or 0.0)
    if g <= 0 and p <= 0 and t <= 0 and b <= 0:
        return None
    if _usable_production_target(t, g, b, p):
        finished = t
    elif p > 0:
        finished = p
    elif (g + b) > 0:
        finished = g + b
    else:
        return None
    stock_in = g if g > 0 else p
    if finished <= 0:
        return None
    return round(100.0 * stock_in / finished, 1)


def _transfer_pct_from_sample_cache(
    cache: Dict[Tuple[int, str], List[Tuple[datetime, float]]],
    mids: List[int],
    start: datetime,
    end: datetime,
) -> Optional[float]:
    """Sum of per-machine max(value) in window from a preloaded sample cache."""
    if not mids or end <= start:
        return None
    totals: Dict[str, float] = {}
    any_row = False
    for key in TRANSFER_PARAM_KEYS:
        total = 0.0
        found = False
        for mid in mids:
            best = None
            for ts, val in cache.get((mid, key), []):
                if start <= ts < end:
                    if best is None or val > best:
                        best = val
            if best is not None:
                found = True
                total += best
        if found:
            any_row = True
            totals[key] = total
    if not any_row:
        return None
    return _pct_from_counts(
        totals.get("Total_Good_Count"),
        totals.get("Total_Bad_Count"),
        totals.get("Actual_Production_Count"),
        totals.get("Production_Target_Count"),
    )


def _load_transfer_sample_cache(
    db: Session,
    mids: List[int],
    start: datetime,
    end: datetime,
) -> Dict[Tuple[int, str], List[Tuple[datetime, float]]]:
    """One query for all machines/params in the shift window."""
    cache: Dict[Tuple[int, str], List[Tuple[datetime, float]]] = {}
    if not mids or end <= start:
        return cache
    rows = (
        db.query(
            ImmOpcuaSample.machine_id,
            ImmOpcuaSample.param_key,
            ImmOpcuaSample.recorded_at,
            ImmOpcuaSample.value_num,
        )
        .filter(
            ImmOpcuaSample.machine_id.in_(mids),
            ImmOpcuaSample.param_key.in_(TRANSFER_PARAM_KEYS),
            ImmOpcuaSample.recorded_at >= start,
            ImmOpcuaSample.recorded_at < end,
            ImmOpcuaSample.value_num.isnot(None),
        )
        .all()
    )
    for mid, key, ts, val in rows:
        if getattr(ts, "tzinfo", None) is not None:
            ts = ts.replace(tzinfo=None)
        cache.setdefault((int(mid), str(key)), []).append((ts, float(val)))
    return cache


def _transfer_rate_live(db: Session) -> dict:
    """Live transfer rate by shift hour — OPC UA samples only (batched, no N+1)."""
    zones, zone_machines, _machines = _zone_machine_map(db)
    cfg = _load_config(db)
    now = now_ist()
    if getattr(now, "tzinfo", None) is not None:
        now = now.replace(tzinfo=None)
    sh = _match_shift_at(cfg, now)
    if not sh:
        enabled = [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]
        sh = enabled[0] if enabled else {"name": "Shift A", "start": "08:00", "end": "20:00"}

    from .hourly_output import _parse_mins

    slots_meta = _shift_slots(sh)
    shift_start_m = _parse_mins(sh.get("start") or "08:00")
    shift_end_m = _parse_mins(sh.get("end") or "20:00")
    overnight = shift_end_m <= shift_start_m
    day = now.date()
    if overnight and (now.hour * 60 + now.minute) < shift_start_m:
        day = day - timedelta(days=1)

    slot_labels = [s["label"] for s in slots_meta]
    all_mids = sorted({mid for mids in zone_machines.values() for mid in mids})

    # Shift window covering all slots (one sample fetch)
    if slots_meta:
        first_start, _ = _slot_bounds(day, slots_meta[0]["from_minutes"], shift_start_m, overnight)
        _, last_end = _slot_bounds(day, slots_meta[-1]["from_minutes"], shift_start_m, overnight)
        sample_end = max(last_end, now) + timedelta(minutes=1)
        cache = _load_transfer_sample_cache(db, all_mids, first_start, sample_end)
    else:
        cache = {}

    # Live ImmOpcuaLatest for current-hour fallback (one query)
    live_by_mid: Dict[int, Dict[str, float]] = {}
    if all_mids:
        latest_rows = (
            db.query(ImmOpcuaLatest.machine_id, ImmOpcuaLatest.param_key, ImmOpcuaLatest.value_num)
            .filter(
                ImmOpcuaLatest.machine_id.in_(all_mids),
                ImmOpcuaLatest.param_key.in_(TRANSFER_PARAM_KEYS),
                ImmOpcuaLatest.value_num.isnot(None),
            )
            .all()
        )
        for mid, key, val in latest_rows:
            live_by_mid.setdefault(int(mid), {})[str(key)] = float(val)

    def _live_pct(mids: List[int]) -> Optional[float]:
        if not mids:
            return None
        totals = {k: 0.0 for k in TRANSFER_PARAM_KEYS}
        any_row = False
        for mid in mids:
            vals = live_by_mid.get(mid) or {}
            for k in TRANSFER_PARAM_KEYS:
                if k in vals:
                    any_row = True
                    totals[k] += vals[k]
        if not any_row:
            return None
        return _pct_from_counts(
            totals["Total_Good_Count"],
            totals["Total_Bad_Count"],
            totals["Actual_Production_Count"],
            totals["Production_Target_Count"],
        )

    def _series_for(mids: List[int], sid: str, name: str, color: str) -> dict:
        hourly = []
        points = []
        for slot in slots_meta:
            start, end = _slot_bounds(day, slot["from_minutes"], shift_start_m, overnight)
            if now < start:
                pct = None
            else:
                win_end = end if now >= end else now
                pct = _transfer_pct_from_sample_cache(cache, mids, start, win_end)
                if pct is None and start <= now < end and mids:
                    pct = _live_pct(mids)
            hourly.append(pct)
            points.append({"slot": slot["label"], "pct": pct})
        return {
            "id": sid,
            "name": name,
            "color": color,
            "hourly_pct": hourly,
            "points": points,
        }

    series = []
    series.append(_series_for(all_mids, "all", "All", HOURLY_RUNNING_RATE_COLORS[0]))
    for idx, z in enumerate(zones):
        mids = zone_machines.get(z["id"]) or []
        series.append(
            _series_for(
                mids,
                str(z["id"]),
                z["name"],
                HOURLY_RUNNING_RATE_COLORS[(idx + 1) % len(HOURLY_RUNNING_RATE_COLORS)],
            )
        )

    return {
        "mode": "live",
        "shift_name": sh.get("name") or "Shift",
        "shift_start": sh.get("start") or "08:00",
        "shift_end": sh.get("end") or "20:00",
        "date": day.isoformat(),
        "slots": slot_labels,
        "series": series,
        "zones": [{"id": z["id"], "name": z["name"]} for z in zones],
    }


@router.get("/transfer-rate")
def transfer_rate_history(
    days: int = Query(3, ge=1, le=90),
    live: bool = Query(False),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    if live:
        return _transfer_rate_live(db)

    zones, zone_machines, _machines = _zone_machine_map(db)
    days_list = _day_list(days)
    series = []

    # All zones aggregate
    all_mids = sorted({mid for mids in zone_machines.values() for mid in mids})
    all_points = []
    for d in days_list:
        good = _daily_sample_sum(db, all_mids, "Total_Good_Count", d)
        bad = _daily_sample_sum(db, all_mids, "Total_Bad_Count", d)
        prod = _daily_sample_sum(db, all_mids, "Actual_Production_Count", d)
        target = _daily_sample_sum(db, all_mids, "Production_Target_Count", d)
        if good is None and prod is None:
            pct = None
        else:
            g = float(good or 0.0)
            b = float(bad or 0.0)
            p = float(prod or 0.0)
            t = float(target or 0.0)
            finished = t if t > 0 else (g + b if (g + b) > 0 else p)
            stock_in = g if g > 0 else p
            pct = round(100.0 * stock_in / finished, 1) if finished else None
        all_points.append({"date": d.isoformat(), "pct": pct})
    series.append({"id": "all", "name": "All", "color": ZONE_PALETTE[0], "points": all_points})

    for idx, z in enumerate(zones):
        mids = zone_machines.get(z["id"]) or []
        points = []
        for d in days_list:
            good = _daily_sample_sum(db, mids, "Total_Good_Count", d)
            bad = _daily_sample_sum(db, mids, "Total_Bad_Count", d)
            prod = _daily_sample_sum(db, mids, "Actual_Production_Count", d)
            target = _daily_sample_sum(db, mids, "Production_Target_Count", d)
            if good is None and prod is None:
                pct = None
            else:
                g = float(good or 0.0)
                b = float(bad or 0.0)
                p = float(prod or 0.0)
                t = float(target or 0.0)
                finished = t if t > 0 else (g + b if (g + b) > 0 else p)
                stock_in = g if g > 0 else p
                pct = round(100.0 * stock_in / finished, 1) if finished else None
            points.append({"date": d.isoformat(), "pct": pct})
        series.append(
            {
                "id": z["id"],
                "name": z["name"],
                "color": ZONE_PALETTE[(idx + 1) % len(ZONE_PALETTE)],
                "points": points,
            }
        )

    return {
        "days": days,
        "dates": [d.isoformat() for d in days_list],
        "series": series,
        "zones": [{"id": z["id"], "name": z["name"]} for z in zones],
    }


def _enabled_shifts(cfg: dict) -> List[dict]:
    return [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]


def _parse_hhmm_mins(value: str) -> int:
    try:
        hh, mm = (value or "0:0").split(":")[:2]
        return int(hh) * 60 + int(mm)
    except Exception:
        return 0


def _config_shift_window(day: date, sh: dict) -> Tuple[datetime, datetime]:
    """Window for a configured shift starting on `day` (handles overnight)."""
    start_m = _parse_hhmm_mins(str(sh.get("start") or "08:00"))
    end_m = _parse_hhmm_mins(str(sh.get("end") or "20:00"))
    base = datetime.combine(day, datetime.min.time())
    start = base + timedelta(minutes=start_m)
    if end_m <= start_m:
        end = base + timedelta(days=1, minutes=end_m)
    else:
        end = base + timedelta(minutes=end_m)
    return start, end


def _resolve_shift_window(day: date, sh: dict, now: datetime) -> Tuple[datetime, datetime]:
    """Shift window for `day`, or prior overnight occurrence still active early morning."""
    start, end = _config_shift_window(day, sh)
    if now >= start:
        return start, end
    start_m = _parse_hhmm_mins(str(sh.get("start") or "08:00"))
    end_m = _parse_hhmm_mins(str(sh.get("end") or "20:00"))
    if end_m <= start_m:
        prev_start, prev_end = _config_shift_window(day - timedelta(days=1), sh)
        if prev_start <= now < prev_end:
            return prev_start, prev_end
    return start, end


def _shift_series_key(sh: dict) -> str:
    raw = str(sh.get("id") or sh.get("name") or "shift").strip()
    safe = "".join(ch if ch.isalnum() else "_" for ch in raw)
    return f"shift_{safe}" or "shift_x"


SHIFT_SERIES_COLORS = [
    "#3b82f6",
    "#eab308",
    "#22c55e",
    "#a78bfa",
    "#f97316",
    "#22cae7",
    "#f43f5e",
    "#14b8a6",
]


def _is_running_status(status: str) -> bool:
    return (status or "").strip().lower() in ("running", "production")


def _normalize_ts(ts: datetime) -> datetime:
    if getattr(ts, "tzinfo", None) is not None:
        return ts.replace(tzinfo=None)
    return ts


def _time_weighted_hit_from_logs(
    logs: List[MachineStatusLog],
    start: datetime,
    end: datetime,
) -> Optional[float]:
    """% of time status was running from start→end using preloaded status logs (incl. prior)."""
    if end <= start:
        return None

    prior = None
    in_win: List[MachineStatusLog] = []
    for log in logs:
        ts = _normalize_ts(log.changed_at)
        if ts < start:
            prior = log
        elif ts <= end:
            in_win.append(log)

    if not prior and not in_win:
        return None

    timeline: List[Tuple[datetime, str]] = []
    if prior:
        timeline.append((start, prior.status or "offline"))
    elif in_win:
        timeline.append((start, in_win[0].status or "offline"))

    for log in in_win:
        st = log.status or "offline"
        ts = _normalize_ts(log.changed_at)
        if timeline and timeline[-1][0] == ts and timeline[-1][1] == st:
            continue
        timeline.append((ts, st))

    total_sec = 0.0
    run_sec = 0.0
    for i, (t0, st) in enumerate(timeline):
        t1 = timeline[i + 1][0] if i + 1 < len(timeline) else end
        seg_start = max(t0, start)
        seg_end = min(t1, end)
        if seg_end <= seg_start:
            continue
        dur = (seg_end - seg_start).total_seconds()
        total_sec += dur
        if _is_running_status(st):
            run_sec += dur

    if total_sec <= 0:
        return None
    return round(100.0 * run_sec / total_sec, 1)


def _load_status_logs_by_machine(
    db: Session,
    mids: List[int],
    start: datetime,
    end: datetime,
) -> Dict[int, List[MachineStatusLog]]:
    """Fetch status logs once for all machines (includes prior row before start)."""
    by_mid: Dict[int, List[MachineStatusLog]] = {mid: [] for mid in mids}
    if not mids:
        return by_mid

    # Pull a lookback window so prior status is available without N+1 queries
    lookback = start - timedelta(days=2)
    rows = (
        db.query(MachineStatusLog)
        .filter(
            MachineStatusLog.machine_id.in_(mids),
            MachineStatusLog.changed_at >= lookback,
            MachineStatusLog.changed_at <= end,
        )
        .order_by(
            MachineStatusLog.machine_id.asc(),
            MachineStatusLog.changed_at.asc(),
            MachineStatusLog.id.asc(),
        )
        .all()
    )
    grouped: Dict[int, List[MachineStatusLog]] = {}
    for log in rows:
        grouped.setdefault(int(log.machine_id), []).append(log)

    for mid in mids:
        logs = grouped.get(mid) or []
        prior = None
        in_win: List[MachineStatusLog] = []
        for log in logs:
            ts = _normalize_ts(log.changed_at)
            if ts < start:
                prior = log
            elif ts <= end:
                in_win.append(log)
        out: List[MachineStatusLog] = []
        if prior:
            out.append(prior)
        out.extend(in_win)
        by_mid[mid] = out
    return by_mid


def _hit_avg_from_cache(
    logs_by_mid: Dict[int, List[MachineStatusLog]],
    mids: List[int],
    start: datetime,
    end: datetime,
    now: datetime,
    live_running: Optional[Dict[int, bool]] = None,
) -> Optional[float]:
    if now < start:
        return None
    effective_end = end if now >= end else now
    if effective_end <= start:
        return None
    if not mids:
        return 0.0
    vals = []
    for mid in mids:
        pct = _time_weighted_hit_from_logs(logs_by_mid.get(mid) or [], start, effective_end)
        if pct is None and live_running is not None and start <= now <= end:
            # No history — live snapshot for active window only
            pct = 100.0 if live_running.get(mid) else 0.0
        if pct is not None:
            vals.append(pct)
    if not vals:
        return None
    return round(sum(vals) / len(vals), 1)


@router.get("/hit-rate")
def hit_rate_history(
    zone_id: Optional[str] = None,
    date_str: Optional[str] = Query(None, alias="date"),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    zones, zone_machines, machines = _zone_machine_map(db)
    cfg = _load_config(db)
    shifts = _enabled_shifts(cfg)
    if not shifts:
        shifts = [
            {"id": "A", "name": "Shift A", "start": "08:00", "end": "20:00", "enabled": True},
            {"id": "B", "name": "Shift B", "start": "20:00", "end": "08:00", "enabled": True},
        ]

    series_meta = []
    for i, sh in enumerate(shifts):
        series_meta.append(
            {
                "key": _shift_series_key(sh),
                "id": sh.get("id"),
                "label": sh.get("name") or f"Shift {sh.get('id') or i + 1}",
                "start": sh.get("start") or "",
                "end": sh.get("end") or "",
                "color": SHIFT_SERIES_COLORS[i % len(SHIFT_SERIES_COLORS)],
            }
        )

    if not zones:
        return {
            "zone": None,
            "zones": [],
            "stations": [],
            "equipment": [],
            "periods": [],
            "series": series_meta,
            "date": (now_ist().date()).isoformat(),
        }

    zone = next((z for z in zones if zone_id and str(z["id"]) == str(zone_id)), None) or zones[0]
    mids = zone_machines.get(zone["id"]) or []
    now = now_ist()
    if getattr(now, "tzinfo", None) is not None:
        now = now.replace(tzinfo=None)
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d").date() if date_str else now.date()
    except ValueError:
        day = now.date()

    # Resolve all shift windows once, then one status-log fetch covering the full span
    shift_windows = []
    span_start = None
    span_end = None
    for sh, meta in zip(shifts, series_meta):
        start, end = _resolve_shift_window(day, sh, now)
        shift_windows.append((sh, meta, start, end))
        span_start = start if span_start is None else min(span_start, start)
        span_end = end if span_end is None else max(span_end, end)

    logs_by_mid = _load_status_logs_by_machine(
        db,
        mids,
        (span_start or now) - timedelta(hours=1),
        max(span_end or now, now),
    )

    live_running: Dict[int, bool] = {}
    if mids:
        from ..opcua_imm import highlights_for_machine, eap_imm_status_from_opcua_highlights

        for mid in mids:
            # Only needed when a machine has no logs in an active window
            has_any = bool(logs_by_mid.get(mid))
            if has_any:
                continue
            try:
                hl = highlights_for_machine(db, mid)
            except Exception:
                hl = {}
            m_live = machines.get(mid)
            live_running[mid] = eap_imm_status_from_opcua_highlights(
                hl,
                machine_name=getattr(m_live, "name", None),
                plc_source=getattr(m_live, "plc_source", None),
                db=db,
            ) == "running"

    equipment = []
    for mid in mids:
        m = machines.get(mid)
        if not m:
            continue
        row = {"id": mid, "name": m.name}
        for _sh, meta, start, end in shift_windows:
            row[meta["key"]] = _hit_avg_from_cache(
                logs_by_mid, [mid], start, end, now, live_running=live_running
            )
        equipment.append(row)

    periods = []
    for _sh, meta, start, end in shift_windows:
        if now < start:
            continue
        cursor = start
        while cursor < end:
            slot_end = min(cursor + timedelta(hours=2), end)
            label = f"{cursor.strftime('%H:%M')}-{slot_end.strftime('%H:%M')}"
            pct = _hit_avg_from_cache(
                logs_by_mid, mids, cursor, slot_end, now, live_running=live_running
            )
            if pct is None and now < cursor:
                cursor = slot_end
                continue
            point = {
                "label": label,
                "shift_key": meta["key"],
                "shift_label": meta["label"],
                "key": f"{meta['key']}-{label}",
            }
            for sm in series_meta:
                point[sm["key"]] = pct if sm["key"] == meta["key"] else None
            periods.append(point)
            cursor = slot_end

    return {
        "date": day.isoformat(),
        "zone": {"id": zone["id"], "name": zone["name"]},
        "zones": [{"id": z["id"], "name": z["name"]} for z in zones],
        "stations": zone.get("stations") or [],
        "series": series_meta,
        "equipment": equipment,
        "periods": periods,
    }


def _param_series(
    db: Session,
    machine_id: int,
    tag: str,
    days: int,
) -> dict:
    meta = KPIV_META.get(tag, {"label": tag, "unit": "", "default_center": 50.0})
    since = now_ist() - timedelta(days=days)
    rows = (
        db.query(ImmKpivSample)
        .filter(
            ImmKpivSample.machine_id == machine_id,
            ImmKpivSample.tag == tag,
            ImmKpivSample.recorded_at >= since,
        )
        .order_by(ImmKpivSample.recorded_at.asc())
        .all()
    )
    thr = (
        db.query(ImmKpivThreshold)
        .filter(ImmKpivThreshold.machine_id == machine_id, ImmKpivThreshold.tag == tag)
        .first()
    )
    center = meta.get("default_center", 50.0)
    upper = thr.upper if thr and thr.upper is not None else center * 1.05
    lower = thr.lower if thr and thr.lower is not None else center * 0.95
    standard = thr.center if thr and thr.center is not None else center

    points = [{"t": r.recorded_at.isoformat(), "v": r.value} for r in rows]

    # downtime bands from consecutive large gaps / sharp drops (real data only)
    downtime = []
    for i in range(1, len(points)):
        try:
            t0 = datetime.fromisoformat(points[i - 1]["t"])
            t1 = datetime.fromisoformat(points[i]["t"])
        except Exception:
            continue
        if getattr(t0, "tzinfo", None) is not None:
            t0 = t0.replace(tzinfo=None)
        if getattr(t1, "tzinfo", None) is not None:
            t1 = t1.replace(tzinfo=None)
        gap_min = (t1 - t0).total_seconds() / 60.0
        if gap_min >= 30:
            downtime.append({"from": points[i - 1]["t"], "to": points[i]["t"]})

    return {
        "tag": tag,
        "label": meta.get("label", tag),
        "unit": meta.get("unit", ""),
        "standard": standard,
        "upper": upper,
        "lower": lower,
        "points": points,
        "downtime": downtime,
    }


@router.get("/equipment-parameters")
def equipment_parameter_history(
    zone_id: Optional[str] = None,
    machine_id: Optional[int] = None,
    days: int = Query(3, ge=1, le=30),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    from ..energy_meter import is_energy_utility_machine

    zones, zone_machines, machines = _zone_machine_map(db)
    zone = None
    if zones:
        zone = next((z for z in zones if zone_id and str(z["id"]) == str(zone_id)), None) or zones[0]
    mids = zone_machines.get(zone["id"]) if zone else list(machines.keys())
    mids = [
        mid
        for mid in (mids or list(machines.keys()))
        if mid in machines and not is_energy_utility_machine(machines[mid])
    ]

    equipment = [{"id": mid, "name": machines[mid].name} for mid in mids]
    # Ignore stale client selection of EM_PLANT / non-production hosts
    mid = machine_id if machine_id in mids else (mids[0] if mids else None)
    charts = {}
    if mid:
        # ensure thresholds exist for nicer standard/limit lines
        try:
            from .imm_monitor import _ensure_defaults
            _ensure_defaults(db, mid)
        except Exception:
            pass
        for tag in KPIV_TAGS:
            charts[tag] = _param_series(db, mid, tag, days)

    return {
        "days": days,
        "zone": {"id": zone["id"], "name": zone["name"]} if zone else None,
        "zones": [{"id": z["id"], "name": z["name"]} for z in zones],
        "stations": (zone.get("stations") if zone else []) or [],
        "equipment": equipment,
        "machine_id": mid,
        "machine_name": machines[mid].name if mid and mid in machines else None,
        "charts": charts,
    }
