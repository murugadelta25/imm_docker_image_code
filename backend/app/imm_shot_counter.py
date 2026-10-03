"""IMM shot counting from OPC UA / Node-RED parameter sequences.

OPCUA (Dia Edge) machines — one shot across separate messages (not together):
  1) msg N:   Actual_Injection_Time changes  → wait
  2) msg N+k: Actual_Charging_Time changes   → wait
  3) later:   Actual_Production_Count changes → count 1 shot
  Injection + Charging changing in the same payload do not advance past injection.

Status-tag machines (IMM17/18 Map status) — one shot only in sequence
across separate messages (they do not become true together):
  1) msg N:   Injection_Status rises true  → wait
  2) msg N+k: Refilling_Status rises true  → count 1 shot
  If both rise in the same payload, no shot is counted (injection is remembered only).

Actual parts on OEE = shot_count × running_cavity.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import ImmOpcuaLatest, ImmOpcuaSample, ImmShotEvent, ImmShotFsm, now_ist

SHOT_SEQ_TIMEOUT_SEC = int(os.getenv("IMM_SHOT_SEQ_TIMEOUT_SEC", "300"))

OPCUA_INJ = "Actual_Injection_Time"
OPCUA_CHG = "Actual_Charging_Time"
OPCUA_PROD = "Actual_Production_Count"
STATUS_INJ = "Injection_Status"
STATUS_REFILL = "Refilling_Status"

OPCUA_KEYS = (OPCUA_INJ, OPCUA_CHG, OPCUA_PROD)
STATUS_KEYS = (STATUS_INJ, STATUS_REFILL)


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
        # Dia Edge: Injection Time and Charging Time change in sequence across
        # messages — never advance both steps from the same payload.
        #   msg N:   Actual_Injection_Time changes → saw_injection
        #   msg N+k: Actual_Charging_Time changes  → saw_charge
        #   later:   Actual_Production_Count changes → 1 shot
        fsm.mode = "opcua_cycle"
        inj_chg = OPCUA_INJ in changes
        chg_chg = OPCUA_CHG in changes
        prod_chg = OPCUA_PROD in changes

        if inj_chg and chg_chg:
            # Both changed together → remember injection only; wait for a later charge
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif inj_chg:
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif chg_chg:
            if fsm.state == "saw_injection":
                fsm.state = "saw_charge"
                fsm.updated_at = now
            else:
                # Charge without a prior injection message — ignore / reset
                fsm.state = "idle"
                fsm.updated_at = now
        elif prod_chg:
            if fsm.state == "saw_charge":
                db.add(
                    ImmShotEvent(
                        machine_id=machine_id,
                        recorded_at=now,
                        mode="opcua_cycle",
                        source=(source or "nodered")[:40],
                        notes="inj→charge→prod_count (sequential)",
                    )
                )
                shots += 1
                fsm.state = "idle"
                fsm.updated_at = now
            else:
                fsm.state = "idle"
                fsm.updated_at = now
    else:
        # IMM17/18 status tags: Injection and Refilling never complete a shot
        # in the same message. Sequence is always:
        #   msg N: Injection_Status rises true  → wait
        #   msg N+k: Refilling_Status rises true → 1 shot
        fsm.mode = "status_tags"
        inj_ch = changes.get(STATUS_INJ)
        refill_ch = changes.get(STATUS_REFILL)
        inj_rising = False
        refill_rising = False
        if inj_ch:
            inj_rising = _is_truthy(inj_ch.get("value_num"), inj_ch.get("value_text")) and not _is_truthy(
                inj_ch.get("prev_num"), inj_ch.get("prev_text")
            )
        if refill_ch:
            refill_rising = _is_truthy(refill_ch.get("value_num"), refill_ch.get("value_text")) and not _is_truthy(
                refill_ch.get("prev_num"), refill_ch.get("prev_text")
            )

        # Both rising in one payload → not a valid shot; remember injection only
        if inj_rising and refill_rising:
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif inj_rising:
            fsm.state = "saw_injection"
            fsm.updated_at = now
        elif refill_rising and fsm.state == "saw_injection":
            # Refilling rose in a later message after a prior Injection rise
            db.add(
                ImmShotEvent(
                    machine_id=machine_id,
                    recorded_at=now,
                    mode="status_tags",
                    source=(source or "nodered")[:40],
                    notes="injection→refilling (sequential)",
                )
            )
            shots += 1
            fsm.state = "idle"
            fsm.updated_at = now

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

    keys = list(OPCUA_KEYS) + list(STATUS_KEYS)
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
            # Same sequential rule as live FSM: one step per timestamp group.
            inj_r = by_key.get(OPCUA_INJ)
            chg_r = by_key.get(OPCUA_CHG)
            prod_r = by_key.get(OPCUA_PROD)
            inj_changed = False
            chg_changed = False
            prod_changed = False
            if inj_r:
                sig = _value_sig(inj_r.value_num, inj_r.value_text)
                if prev.get(OPCUA_INJ) != sig:
                    inj_changed = True
                    prev[OPCUA_INJ] = sig
            if chg_r:
                sig = _value_sig(chg_r.value_num, chg_r.value_text)
                if prev.get(OPCUA_CHG) != sig:
                    chg_changed = True
                    prev[OPCUA_CHG] = sig
            if prod_r:
                sig = _value_sig(prod_r.value_num, prod_r.value_text)
                if prev.get(OPCUA_PROD) != sig:
                    prod_changed = True
                    prev[OPCUA_PROD] = sig

            if inj_changed and chg_changed:
                state = "saw_injection"
                state_at = ts
            elif inj_changed:
                state = "saw_injection"
                state_at = ts
            elif chg_changed:
                if state == "saw_injection":
                    state = "saw_charge"
                    state_at = ts
                else:
                    state = "idle"
                    state_at = None
            elif prod_changed:
                if state == "saw_charge":
                    if ts >= start:
                        shots += 1
                    state = "idle"
                    state_at = None
                else:
                    state = "idle"
                    state_at = None
        else:
            # Status tags: require Injection rise in an earlier message, then
            # Refilling rise later — never count both rising in the same timestamp.
            inj_r = by_key.get(STATUS_INJ)
            refill_r = by_key.get(STATUS_REFILL)
            inj_rising = False
            refill_rising = False
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
                    refill_rising = _is_truthy(sig[0], sig[1]) and not (
                        _is_truthy(old[0], old[1]) if old else False
                    )
                    prev[STATUS_REFILL] = sig

            if inj_rising and refill_rising:
                state = "saw_injection"
                state_at = ts
            elif inj_rising:
                state = "saw_injection"
                state_at = ts
            elif refill_rising and state == "saw_injection":
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
