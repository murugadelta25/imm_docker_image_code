"""IMM shot counting from OPC UA / Node-RED parameter sequences.

OPCUA (Dia Edge) machines IMM_07..IMM_11:
  Any Total_Good_Count value change (e.g. 6926→6928, or reset 6928→0→3) = 1 shot.
  Same value repeated = no shot. Actual parts = shot_count × running_cavity.

  Shift shot counter starts at 0 each shift (events only inside the shift window).
  Mold / tool life never resets at shift start — ImmMold.usage_count and tool
  cycles keep accumulating for mold history.

  Mid-shift mold change: new mold period shots start at 0; prior mold shots stay
  in the same shift total; OEE sums all shift shots (using each mold's cavity).

Status-tag machines (IMM17/18 Map status) — one shot per cycle:
  Path A (injection wired): Injection_Status rises → Refilling_Status rises → 1 shot
  Path B (Plastech / motor running): Motor ON + Refilling rises → Refilling falls → 1 shot

PLC status machines (IMM17/18): Actual_Cycle_Time (sec) = elapsed time between
consecutive Refilling_Status rising edges.
"""
from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import ImmMold, ImmOpcuaLatest, ImmOpcuaSample, ImmShotEvent, ImmShotFsm, Machine, now_ist

SHOT_SEQ_TIMEOUT_SEC = int(os.getenv("IMM_SHOT_SEQ_TIMEOUT_SEC", "300"))

OPCUA_INJ = "Actual_Injection_Time"
OPCUA_CHG = "Actual_Charging_Time"
OPCUA_PROD = "Actual_Production_Count"
OPCUA_GOOD = "Total_Good_Count"
STATUS_INJ = "Injection_Status"
STATUS_REFILL = "Refilling_Status"

# Mode detection + history replay: good count is the live shot source for Dia Edge.
OPCUA_KEYS = (OPCUA_GOOD, OPCUA_INJ, OPCUA_CHG, OPCUA_PROD)
STATUS_KEYS = (STATUS_INJ, STATUS_REFILL)
MOTOR_STATUS = "Motor_Status"
ACTUAL_CYCLE_TIME = "Actual_Cycle_Time"
# Internal timestamp of last Refilling_Status rise (not in OPC UA catalog UI).
_REFILL_RISE_TS_KEY = "_imm_refill_rise_ts"


def _motor_status_on(db: Session, machine_id: int, changes: Dict[str, Dict[str, Any]]) -> bool:
    """Motor ON from this batch, else latest ImmOpcuaLatest."""
    ch = changes.get(MOTOR_STATUS)
    if ch is not None:
        return _is_truthy(ch.get("value_num"), ch.get("value_text"))
    row = (
        db.query(ImmOpcuaLatest)
        .filter(ImmOpcuaLatest.machine_id == machine_id, ImmOpcuaLatest.param_key == MOTOR_STATUS)
        .first()
    )
    if not row:
        return False
    return _is_truthy(row.value_num, row.value_text)


def _ensure_opcua_latest(db: Session, machine_id: int, param_key: str) -> ImmOpcuaLatest:
    row = (
        db.query(ImmOpcuaLatest)
        .filter(ImmOpcuaLatest.machine_id == machine_id, ImmOpcuaLatest.param_key == param_key)
        .first()
    )
    if not row:
        row = ImmOpcuaLatest(machine_id=machine_id, param_key=param_key)
        db.add(row)
    return row


def apply_plc_refilling_cycle_time(
    db: Session,
    machine_id: int,
    changes: Dict[str, Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    machine_name: Optional[str] = None,
    plc_source: Optional[str] = None,
    write_history: bool = True,
    source: str = "nodered",
) -> Optional[float]:
    """IMM17/18: set Actual_Cycle_Time from Refilling_Status rise-to-rise interval (seconds)."""
    from .opcua_imm import machine_imm_category

    if machine_name is None:
        m = db.query(Machine).filter(Machine.id == machine_id).first()
        machine_name = m.name if m else None
    if machine_imm_category(machine_name, plc_source) != "plc_status":
        return None

    ch = changes.get(STATUS_REFILL)
    if not ch:
        return None
    rising = _is_truthy(ch.get("value_num"), ch.get("value_text")) and not _is_truthy(
        ch.get("prev_num"), ch.get("prev_text")
    )
    if not rising:
        return None

    now = now or now_ist()
    now_naive = now.replace(tzinfo=None) if now.tzinfo else now

    track = _ensure_opcua_latest(db, machine_id, _REFILL_RISE_TS_KEY)
    prev_epoch = track.value_num
    track.value_num = float(now_naive.timestamp())
    track.value_text = now_naive.isoformat()[:255]
    track.recorded_at = now
    track.source = (source or "refill_rise")[:40]

    ct_sec: Optional[float] = None
    if prev_epoch is not None and float(prev_epoch) > 0:
        prev_dt = datetime.fromtimestamp(float(prev_epoch))
        ct_sec = max(0.0, (now_naive - prev_dt).total_seconds())
        min_gap = float(os.getenv("IMM_PLC_MIN_CYCLE_SEC", "1"))
        max_gap = float(os.getenv("IMM_PLC_MAX_CYCLE_SEC", "7200"))
        if min_gap <= ct_sec <= max_gap:
            ct_round = round(ct_sec, 2)
            act = _ensure_opcua_latest(db, machine_id, ACTUAL_CYCLE_TIME)
            act.value_num = ct_round
            act.value_text = str(ct_round)
            act.recorded_at = now
            act.source = "refill_interval"[:40]
            act.quality = "good"
            if write_history:
                db.add(
                    ImmOpcuaSample(
                        machine_id=machine_id,
                        param_key=ACTUAL_CYCLE_TIME,
                        value_num=ct_round,
                        value_text=str(ct_round)[:255],
                        quality="good",
                        source="refill_interval"[:40],
                        recorded_at=now,
                    )
                )
            return ct_round

    return None


def _record_shot(
    db: Session,
    machine_id: int,
    now: datetime,
    source: str,
    notes: str,
    *,
    mode: str = "status_tags",
    count: int = 1,
    mold_id: Optional[int] = None,
) -> int:
    n = max(0, int(count or 0))
    if mold_id is None:
        active = (
            db.query(ImmMold)
            .filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1)
            .first()
        )
        mold_id = int(active.id) if active else None
    for _ in range(n):
        db.add(
            ImmShotEvent(
                machine_id=machine_id,
                recorded_at=now,
                mode=(mode or "status_tags")[:40],
                source=(source or "nodered")[:40],
                notes=(notes or "")[:200],
                mold_id=mold_id,
            )
        )
    return n


def _parse_count_value(value_num: Optional[float], value_text: Optional[str]) -> Optional[float]:
    if value_num is not None:
        try:
            return float(value_num)
        except (TypeError, ValueError):
            pass
    text = (value_text or "").strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        m = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", text)
        if m:
            try:
                return float(m.group(0))
            except ValueError:
                return None
    return None


def _good_count_shot_pulse(
    prev_num: Optional[float],
    prev_text: Optional[str],
    value_num: Optional[float],
    value_text: Optional[str],
) -> int:
    """1 shot when Total_Good_Count changes to a different value (incl. reset to 0).

    Examples: 6926→6928 → 1 shot; 6928→0 → 1 shot; 0→3 → 1 shot; 6926→6926 → 0.
    First observation only baselines — no shot.
    """
    old = _parse_count_value(prev_num, prev_text)
    new = _parse_count_value(value_num, value_text)
    if new is None:
        # Fall back to raw text inequality when not numeric
        old_t = (prev_text or "").strip()
        new_t = (value_text or "").strip()
        if not new_t and value_num is None:
            return 0
        if old is None and not old_t:
            return 0
        return 1 if (old_t != new_t or (old is not None and value_num is not None)) else 0
    if old is None:
        old_t = (prev_text or "").strip()
        if not old_t and prev_num is None:
            return 0
        # Had prior text-only baseline
        return 1 if _parse_count_value(None, old_t) != new else 0
    if abs(float(new) - float(old)) < 1e-9:
        return 0
    return 1


# Back-compat alias
def _good_count_shot_delta(
    prev_num: Optional[float],
    prev_text: Optional[str],
    value_num: Optional[float],
    value_text: Optional[str],
) -> int:
    return _good_count_shot_pulse(prev_num, prev_text, value_num, value_text)


def apply_opcua_good_count_shots(
    db: Session,
    machine_id: int,
    changes: Dict[str, Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    source: str = "nodered",
    commit: bool = False,
) -> int:
    """IMM_07..11: record 1 shot when Total_Good_Count value changes."""
    ch = changes.get(OPCUA_GOOD)
    if not ch:
        return 0
    now = now or now_ist()
    pulse = _good_count_shot_pulse(
        ch.get("prev_num"),
        ch.get("prev_text"),
        ch.get("value_num"),
        ch.get("value_text"),
    )
    if pulse <= 0:
        return 0

    fsm = _get_or_create_fsm(db, machine_id)
    fsm.mode = "opcua_good_count"
    fsm.state = "idle"
    fsm.updated_at = now

    old_v = _parse_count_value(ch.get("prev_num"), ch.get("prev_text"))
    new_v = _parse_count_value(ch.get("value_num"), ch.get("value_text"))
    notes = f"Total_Good_Count {old_v}→{new_v}" if old_v is not None and new_v is not None else "Total_Good_Count change"

    shots = _record_shot(
        db,
        machine_id,
        now,
        source,
        notes,
        mode="opcua_good_count",
        count=1,
    )
    if shots:
        try:
            from .tool_service import apply_shot_mold_usage

            apply_shot_mold_usage(db, machine_id, shots, source=source or "opcua_good")
        except Exception:
            pass
    if commit and shots:
        db.commit()
    return shots


def _cavity_for_imm_mold(db: Session, mold: Optional[ImmMold], default: int = 1) -> int:
    if not mold:
        return max(1, int(default or 1))
    try:
        from .tool_service import find_tool_by_mold_no

        tool = find_tool_by_mold_no(db, mold.mold_no)
        cav = getattr(tool, "running_cavity", None) if tool else None
        if cav not in (None, ""):
            return max(1, int(cav))
    except Exception:
        pass
    return max(1, int(default or 1))


def shift_shots_and_parts(
    db: Session,
    machine_id: int,
    start: datetime,
    end: datetime,
    *,
    fallback_cavity: int = 1,
) -> Tuple[int, int, int]:
    """Return (shift_shot_count, shift_parts, current_mold_period_shots).

    Shift shots = all ImmShotEvent in [start, end) — never cleared by mold change.
    Parts = sum(shots_per_mold × that mold's running cavity), untagged × fallback.
    Current mold period shots = events for active mold since mounted_at (or 0).
    """
    if end <= start:
        return 0, 0, 0

    events = (
        db.query(ImmShotEvent)
        .filter(
            ImmShotEvent.machine_id == machine_id,
            ImmShotEvent.recorded_at >= start,
            ImmShotEvent.recorded_at < end,
        )
        .all()
    )
    by_mold: Dict[Optional[int], int] = defaultdict(int)
    for e in events:
        by_mold[e.mold_id if getattr(e, "mold_id", None) else None] += 1

    mold_ids = [mid for mid in by_mold.keys() if mid is not None]
    molds = {
        m.id: m
        for m in db.query(ImmMold).filter(ImmMold.id.in_(mold_ids)).all()
    } if mold_ids else {}

    parts = 0
    for mid, n in by_mold.items():
        if mid is None:
            parts += int(n) * max(1, int(fallback_cavity or 1))
        else:
            parts += int(n) * _cavity_for_imm_mold(db, molds.get(mid), fallback_cavity)

    shot_count = len(events)

    period_shots = 0
    active = (
        db.query(ImmMold)
        .filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1)
        .first()
    )
    if active:
        mount = getattr(active, "mounted_at", None) or active.created_at or start
        if mount and mount < end:
            period_start = max(start, mount) if mount else start
            period_shots = sum(
                1
                for e in events
                if getattr(e, "mold_id", None) == active.id and e.recorded_at >= period_start
            )

    return int(shot_count), int(parts), int(period_shots)


def _is_truthy(value_num: Optional[float], value_text: Optional[str]) -> bool:
    text = (value_text or "").strip().lower()
    if text in ("on", "1", "true", "yes", "connected", "auto"):
        return True
    if text in ("off", "0", "false", "no", "disconnected", ""):
        if text == "" and value_num is not None:
            try:
                return float(value_num) > 0
            except (TypeError, ValueError):
                return False
        return False
    if value_num is not None:
        try:
            return float(value_num) > 0
        except (TypeError, ValueError):
            return False
    return False


def _value_sig(value_num: Optional[float], value_text: Optional[str]) -> Tuple[Optional[float], str]:
    text = (value_text or "").strip()
    num = None
    if value_num is not None:
        try:
            num = float(value_num)
        except (TypeError, ValueError):
            num = None
    return num, text


def _get_or_create_fsm(db: Session, machine_id: int) -> ImmShotFsm:
    row = db.query(ImmShotFsm).filter(ImmShotFsm.machine_id == machine_id).first()
    if row:
        return row
    row = ImmShotFsm(machine_id=machine_id, state="idle", mode="opcua_cycle", updated_at=now_ist())
    db.add(row)
    db.flush()
    return row


def _reset_if_stale(fsm: ImmShotFsm, now: datetime) -> None:
    if fsm.state == "idle" or not fsm.updated_at:
        return
    age = (now - fsm.updated_at).total_seconds()
    if age > SHOT_SEQ_TIMEOUT_SEC:
        fsm.state = "idle"


def _prefer_opcua_mode(changed_keys: Iterable[str], latest_keys: Optional[Iterable[str]] = None) -> bool:
    keys = set(changed_keys or [])
    if latest_keys:
        keys |= set(latest_keys)
    if any(k in keys for k in OPCUA_KEYS):
        return True
    return False


def apply_shot_changes(
    db: Session,
    machine_id: int,
    changes: Dict[str, Dict[str, Any]],
    *,
    now: Optional[datetime] = None,
    source: str = "nodered",
    commit: bool = False,
) -> int:
    """Advance per-machine FSM from a batch of param value changes. Returns new shots.

    ``changes`` map: param_key → {value_num, value_text, prev_num, prev_text}
    """
    if not changes:
        return 0
    now = now or now_ist()
    fsm = _get_or_create_fsm(db, machine_id)
    _reset_if_stale(fsm, now)

    latest_keys = [
        r.param_key
        for r in db.query(ImmOpcuaLatest.param_key)
        .filter(ImmOpcuaLatest.machine_id == machine_id)
        .all()
    ]
    use_opcua = _prefer_opcua_mode(changes.keys(), latest_keys)
    shots = 0

    if use_opcua:
        # Live OPC UA shots are recorded by apply_opcua_good_count_shots() on ingest.
        # Keep this branch as a no-op so IMM_BACKEND_SHOT_FSM does not double-count.
        fsm.mode = "opcua_good_count"
        fsm.state = "idle"
        fsm.updated_at = now
    else:
        # IMM17/18 status tags (Plastech): Path A injection→refill rise; Path B motor+refill pulse.
        fsm.mode = "status_tags"
        inj_ch = changes.get(STATUS_INJ)
        refill_ch = changes.get(STATUS_REFILL)
        inj_rising = False
        refill_rising = False
        refill_falling = False
        if inj_ch:
            inj_rising = _is_truthy(inj_ch.get("value_num"), inj_ch.get("value_text")) and not _is_truthy(
                inj_ch.get("prev_num"), inj_ch.get("prev_text")
            )
        if refill_ch:
            refill_rising = _is_truthy(refill_ch.get("value_num"), refill_ch.get("value_text")) and not _is_truthy(
                refill_ch.get("prev_num"), refill_ch.get("prev_text")
            )
            refill_falling = _is_truthy(refill_ch.get("prev_num"), refill_ch.get("prev_text")) and not _is_truthy(
                refill_ch.get("value_num"), refill_ch.get("value_text")
            )

        motor_on = _motor_status_on(db, machine_id, changes)

        if inj_rising and refill_rising:
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif inj_rising:
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif refill_rising:
            if fsm.state == "saw_injection":
                shots += _record_shot(db, machine_id, now, source, "injection→refilling (sequential)")
                fsm.state = "idle"
                fsm.updated_at = now
            elif motor_on:
                fsm.state = "saw_refill_high"
                fsm.updated_at = now
        elif refill_falling and fsm.state == "saw_refill_high":
            shots += _record_shot(db, machine_id, now, source, "refilling pulse end (motor on)")
            fsm.state = "idle"
            fsm.updated_at = now

    if shots:
        try:
            from .tool_service import apply_shot_mold_usage

            apply_shot_mold_usage(db, machine_id, shots, source=source or "shot_fsm")
        except Exception:
            # Shot event already recorded — mold life sync must not roll back the shot
            pass

    if commit and shots:
        db.commit()
    return shots


def count_shot_events(
    db: Session,
    machine_id: int,
    start: datetime,
    end: datetime,
) -> int:
    """Count persisted shot events in [start, end)."""
    if end <= start:
        return 0
    n = (
        db.query(func.count(ImmShotEvent.id))
        .filter(
            ImmShotEvent.machine_id == machine_id,
            ImmShotEvent.recorded_at >= start,
            ImmShotEvent.recorded_at < end,
        )
        .scalar()
    )
    return int(n or 0)


def batch_count_shot_events(
    db: Session,
    machine_ids: Iterable[int],
    start: datetime,
    end: datetime,
) -> Dict[int, int]:
    """Count ImmShotEvent rows per machine in [start, end)."""
    mids = [int(x) for x in (machine_ids or []) if x is not None]
    if not mids or end <= start:
        return {}
    rows = (
        db.query(ImmShotEvent.machine_id, func.count(ImmShotEvent.id))
        .filter(
            ImmShotEvent.machine_id.in_(mids),
            ImmShotEvent.recorded_at >= start,
            ImmShotEvent.recorded_at < end,
        )
        .group_by(ImmShotEvent.machine_id)
        .all()
    )
    return {int(mid): int(n or 0) for mid, n in rows}


def count_shots_from_samples(
    db: Session,
    machine_id: int,
    start: datetime,
    end: datetime,
) -> int:
    """Replay ImmOpcuaSample history to count shots in [start, end).

    Used as fallback / backfill when live FSM events are missing.
    """
    if end <= start:
        return 0

    keys = list(OPCUA_KEYS) + list(STATUS_KEYS) + [MOTOR_STATUS]
    # Include a small lookback so an in-progress sequence can complete inside the window
    lookback = start - timedelta(seconds=SHOT_SEQ_TIMEOUT_SEC)
    rows = (
        db.query(ImmOpcuaSample)
        .filter(
            ImmOpcuaSample.machine_id == machine_id,
            ImmOpcuaSample.param_key.in_(keys),
            ImmOpcuaSample.recorded_at >= lookback,
            ImmOpcuaSample.recorded_at < end,
        )
        .order_by(ImmOpcuaSample.recorded_at.asc(), ImmOpcuaSample.id.asc())
        .all()
    )
    if not rows:
        return 0

    # Detect mode from samples present
    present = {r.param_key for r in rows}
    use_opcua = any(k in present for k in OPCUA_KEYS)

    prev: Dict[str, Tuple[Optional[float], str]] = {}
    for pk in (MOTOR_STATUS, STATUS_INJ, STATUS_REFILL):
        row = (
            db.query(ImmOpcuaLatest)
            .filter(ImmOpcuaLatest.machine_id == machine_id, ImmOpcuaLatest.param_key == pk)
            .first()
        )
        if row:
            prev[pk] = _value_sig(row.value_num, row.value_text)
    state = "idle"
    state_at: Optional[datetime] = None
    shots = 0

    # Group by timestamp so same-message params process in sequence order
    groups: List[Tuple[datetime, List[ImmOpcuaSample]]] = []
    for r in rows:
        if not groups or groups[-1][0] != r.recorded_at:
            groups.append((r.recorded_at, [r]))
        else:
            groups[-1][1].append(r)

    for ts, batch in groups:
        if state != "idle" and state_at and (ts - state_at).total_seconds() > SHOT_SEQ_TIMEOUT_SEC:
            state = "idle"
            state_at = None

        by_key = {r.param_key: r for r in batch}

        if use_opcua:
            # Any Total_Good_Count value change = 1 shot (incl. counter reset).
            good_r = by_key.get(OPCUA_GOOD)
            if good_r:
                sig = _value_sig(good_r.value_num, good_r.value_text)
                old = prev.get(OPCUA_GOOD)
                if old is None:
                    prev[OPCUA_GOOD] = sig
                elif prev.get(OPCUA_GOOD) != sig:
                    old_num, old_text = old
                    pulse = _good_count_shot_pulse(old_num, old_text, sig[0], sig[1])
                    if pulse > 0 and ts >= start:
                        shots += pulse
                    prev[OPCUA_GOOD] = sig
        else:
            # Status tags: require Injection rise in an earlier message, then
            # Refilling rise later — never count both rising in the same timestamp.
            inj_r = by_key.get(STATUS_INJ)
            refill_r = by_key.get(STATUS_REFILL)
            motor_r = by_key.get(MOTOR_STATUS)
            inj_rising = False
            refill_rising = False
            refill_falling = False
            if inj_r:
                sig = _value_sig(inj_r.value_num, inj_r.value_text)
                old = prev.get(STATUS_INJ)
                if prev.get(STATUS_INJ) != sig:
                    inj_rising = _is_truthy(sig[0], sig[1]) and not (
                        _is_truthy(old[0], old[1]) if old else False
                    )
                    prev[STATUS_INJ] = sig
            if refill_r:
                sig = _value_sig(refill_r.value_num, refill_r.value_text)
                old = prev.get(STATUS_REFILL)
                if prev.get(STATUS_REFILL) != sig:
                    was = _is_truthy(old[0], old[1]) if old else False
                    now_true = _is_truthy(sig[0], sig[1])
                    if now_true and not was:
                        refill_rising = True
                    elif was and not now_true:
                        refill_falling = True
                    prev[STATUS_REFILL] = sig
            motor_on = False
            if motor_r:
                sig = _value_sig(motor_r.value_num, motor_r.value_text)
                prev[MOTOR_STATUS] = sig
                motor_on = _is_truthy(sig[0], sig[1])
            elif prev.get(MOTOR_STATUS):
                sig = prev[MOTOR_STATUS]
                motor_on = _is_truthy(sig[0], sig[1])

            if inj_rising and refill_rising:
                state = "saw_injection"
                state_at = ts
            elif inj_rising:
                state = "saw_injection"
                state_at = ts
            elif refill_rising:
                if state == "saw_injection":
                    if ts >= start:
                        shots += 1
                    state = "idle"
                    state_at = None
                elif motor_on:
                    state = "saw_refill_high"
                    state_at = ts
            elif refill_falling and state == "saw_refill_high":
                if ts >= start:
                    shots += 1
                state = "idle"
                state_at = None

    return shots


def count_machine_shots(
    db: Session,
    machine_id: int,
    start: datetime,
    end: datetime,
) -> int:
    """Count shots for a machine/window.

    Uses the larger of live ImmShotEvent rows and a replay over ImmOpcuaSample
    history so OEE stays accurate across the transition to event-based counting.
    """
    events = count_shot_events(db, machine_id, start, end)
    samples = count_shots_from_samples(db, machine_id, start, end)
    return max(int(events or 0), int(samples or 0))
