"""IMM OPC UA parameter catalog, mapping, ingest, and optional live poll."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy.orm import Session

from .models import (
    ImmKpivSample,
    ImmOpcuaLatest,
    ImmOpcuaParamDef,
    ImmOpcuaSample,
    ImmOpcuaTagMap,
    Machine,
    now_ist,
)

CATALOG_PATH = Path(__file__).resolve().parent / "data" / "imm_opcua_parameters.json"

# Max age of Motor/Heater samples before OPC UA machines are treated as Offline.
# Node-RED often pushes on-change only, so keep a generous window (default 30 min).
IMM_STATUS_MAX_AGE_SEC = int(os.getenv("IMM_STATUS_MAX_AGE_SEC", "1800"))

# PLC status-tag machines (IMM17/18): Offline when Motor/Heater not refreshed for > one shift.
# Default 12h (= typical A/B shift); override with IMM_PLC_STATUS_STALE_SEC.
IMM_PLC_STATUS_STALE_SEC = int(os.getenv("IMM_PLC_STATUS_STALE_SEC", str(12 * 3600)))

# After Actual_Charging_Time / Actual_Injection_Time value changes, show Running this long
IMM_CYCLE_ACTIVITY_SEC = int(os.getenv("IMM_CYCLE_ACTIVITY_SEC", "120"))

CYCLE_ACTIVITY_KEYS = ("Actual_Charging_Time", "Actual_Injection_Time")

# Prefixed SIE tags (IMM18_Motor_status) → catalog keys (Motor_Status)
_STATUS_ALIAS_RE = re.compile(
    r"^(?:IMM[_\s]?\d+[_\s]?)?(Motor|Heater|Injection|Refilling|Connection)_?[Ss]tatus$",
    re.IGNORECASE,
)

# IMM17 / IMM18 — PLC / SIE status-tag category (Motor/Heater/Injection/Refilling)
_PLC_STATUS_NAME_RE = re.compile(r"^IMM[_]?1[78]$", re.IGNORECASE)
# IMM_07..IMM_11 — Dia Edge / OPC UA parameter category
_OPCUA_IMM_NAME_RE = re.compile(r"^IMM[_]?0?(?:[7-9]|1[01])$", re.IGNORECASE)

# Overview / card highlights from Dia Edge parameter list
HIGHLIGHT_KEYS = (
    "Actual_Cycle_Time",
    "Last_Cycle_Time",
    "Actual_Production_Count",
    "Production_Target_Count",
    "Total_Good_Count",
    "Total_Bad_Count",
    "Actual_Mold_Name",
    "Actual_Material_Name",
    "Actual_Nozzle_Temp",
    "Actual_Cylender_1_Temp",
    "Actual_System_Pressure",
    "Actual_Cavity_No",
    "Actual_Injection_Cusion_Monitoring_Position",
    "Actual_Charging_Time",
    "Semi_Mode",
    "Connection_Status",
    "Motor_Status",
    "Heater_Status",
    "Auto_Mode",
    "Manual_Mode",
    "Injection_Status",
    "Refilling_Status",
    "Actual_Injection_Time",
    "Energy_Power_Factor",
    "Energy_Shift_Kwh",
    "Energy_Ampere_Rating",
    "Energy_Phase_to_Phase_Voltage",
)


def load_catalog() -> dict:
    if not CATALOG_PATH.exists():
        return {"parameters": [], "utilities": []}
    with CATALOG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def seed_param_defs(db: Session) -> int:
    """Upsert Dia Edge catalog into imm_opcua_param_defs. Returns inserted/updated count."""
    catalog = load_catalog()
    params = list(catalog.get("parameters") or [])
    # Utilities (energy meter, cooling, …) share the same defs table so UI can list them
    for u in catalog.get("utilities") or []:
        key = u.get("key")
        if not key:
            continue
        params.append(
            {
                "key": key,
                "display": u.get("display") or u.get("particular") or key,
                "io_type": u.get("io_type") or "STRING",
                "category": u.get("category") or "energy",
                "identified_tag": u.get("particular"),
                "identified_node_id": None,
                "kpiv_tag": None,
            }
        )
    changed = 0
    for idx, item in enumerate(params, start=1):
        key = item.get("key")
        if not key:
            continue
        row = db.query(ImmOpcuaParamDef).filter(ImmOpcuaParamDef.param_key == key).first()
        if not row:
            row = ImmOpcuaParamDef(param_key=key)
            db.add(row)
            changed += 1
        row.display_name = item.get("display") or key
        row.io_type = item.get("io_type") or "STRING"
        row.category = item.get("category") or "general"
        row.identified_tag = item.get("identified_tag")
        row.identified_node_id = (
            str(item["identified_node_id"]) if item.get("identified_node_id") is not None else None
        )
        row.kpiv_tag = item.get("kpiv_tag")
        row.sort_order = idx
        row.is_active = 1
    db.commit()
    return changed


def ensure_machine_tag_maps(db: Session, machine_id: int) -> int:
    """Create missing tag maps for a machine from catalog defaults."""
    # Refresh catalog when energy utilities are missing (one-time upsert after deploy)
    has_energy = (
        db.query(ImmOpcuaParamDef.param_key)
        .filter(ImmOpcuaParamDef.param_key == "Energy_Power_Factor")
        .first()
    )
    if not has_energy:
        seed_param_defs(db)
    defs = (
        db.query(ImmOpcuaParamDef)
        .filter(ImmOpcuaParamDef.is_active == 1)
        .order_by(ImmOpcuaParamDef.sort_order)
        .all()
    )
    if not defs:
        seed_param_defs(db)
        defs = (
            db.query(ImmOpcuaParamDef)
            .filter(ImmOpcuaParamDef.is_active == 1)
            .order_by(ImmOpcuaParamDef.sort_order)
            .all()
        )
    existing = {
        m.param_key
        for m in db.query(ImmOpcuaTagMap).filter(ImmOpcuaTagMap.machine_id == machine_id).all()
    }
    created = 0
    for d in defs:
        if d.param_key in existing:
            continue
        db.add(
            ImmOpcuaTagMap(
                machine_id=machine_id,
                param_key=d.param_key,
                opcua_tag_name=d.identified_tag,
                opcua_node_id=d.identified_node_id,
                enabled=1,
                scale=1.0,
                offset=0.0,
            )
        )
        created += 1
    if created:
        db.commit()
    return created


def ensure_all_imm_tag_maps(db: Session) -> int:
    from .energy_meter import is_energy_utility_machine

    seed_param_defs(db)
    machines = db.query(Machine).all()
    total = 0
    for m in machines:
        if is_energy_utility_machine(m):
            continue
        mtype = (m.machine_type or "").upper()
        # Seed all machines that look like IMM / molding; still allow CNC if plc_source=opcua
        if mtype in ("IMM", "INJECTION", "MOLDING") or (m.plc_source or "") == "opcua":
            total += ensure_machine_tag_maps(db, m.id)
        elif not mtype or mtype == "CNC":
            # Project default is IMM — seed CNC-named rows too when empty type
            total += ensure_machine_tag_maps(db, m.id)
    return total


def normalize_param_key(key: str) -> str:
    """Map device-prefixed status tags to catalog keys (IMM18_Motor_status → Motor_Status)."""
    raw = str(key or "").strip()
    if not raw:
        return raw
    m = _STATUS_ALIAS_RE.match(raw)
    if m:
        return f"{m.group(1).title()}_Status"
    return raw


def _parse_value(raw: Any) -> Tuple[Optional[float], Optional[str]]:
    if raw is None:
        return None, None
    if isinstance(raw, bool):
        return (1.0 if raw else 0.0), ("true" if raw else "false")
    if isinstance(raw, (int, float)):
        return float(raw), str(raw)
    text = str(raw).strip()
    if not text:
        return None, ""
    try:
        return float(text), text
    except ValueError:
        m = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", text.replace(",", ""))
        if m:
            try:
                return float(m.group(0)), text
            except ValueError:
                pass
        return None, text


def ingest_samples(
    db: Session,
    machine_id: int,
    samples: Iterable[dict],
    source: str = "bridge",
    write_history: bool = True,
    sync_kpiv: bool = True,
) -> dict:
    """
    Persist live values (+ optional history) and mirror numeric KPIV tags.
    Each sample: {param_key|key, value, quality?}
    """
    ensure_machine_tag_maps(db, machine_id)
    defs = {d.param_key: d for d in db.query(ImmOpcuaParamDef).all()}
    maps = {
        m.param_key: m
        for m in db.query(ImmOpcuaTagMap).filter(ImmOpcuaTagMap.machine_id == machine_id).all()
    }
    now = now_ist()
    accepted = 0
    kpiv_written = 0
    shot_changes: Dict[str, dict] = {}

    for item in samples:
        if not isinstance(item, dict):
            continue
        key = item.get("param_key") or item.get("key") or item.get("tag")
        if not key:
            continue
        key = normalize_param_key(str(key).strip())
        raw = item.get("value")
        if raw is None and "value_text" in item:
            raw = item.get("value_text")
        value_num, value_text = _parse_value(raw)
        if value_num is None and item.get("value_num") is not None:
            try:
                value_num = float(item["value_num"])
            except (TypeError, ValueError):
                value_num = None
        if value_text is None:
            value_text = item.get("value_text")
        quality = str(item.get("quality") or "good")[:40]
        scale = 1.0
        offset = 0.0
        tag_map = maps.get(key)
        if tag_map:
            scale = float(tag_map.scale or 1.0)
            offset = float(tag_map.offset or 0.0)
        if value_num is not None:
            value_num = value_num * scale + offset

        latest = (
            db.query(ImmOpcuaLatest)
            .filter(ImmOpcuaLatest.machine_id == machine_id, ImmOpcuaLatest.param_key == key)
            .first()
        )
        value_changed = True
        prev_num = None
        prev_text = None
        if latest:
            prev_num = latest.value_num
            prev_text = (latest.value_text or "").strip() if latest.value_text is not None else None
            new_text = (value_text or "").strip() if value_text is not None else None
            same_num = (
                prev_num is not None
                and value_num is not None
                and abs(float(prev_num) - float(value_num)) < 1e-9
            ) or (prev_num is None and value_num is None)
            same_text = (prev_text or "") == (new_text or "")
            value_changed = not (same_num and same_text)
        else:
            latest = ImmOpcuaLatest(machine_id=machine_id, param_key=key)
            db.add(latest)

        if value_changed:
            shot_changes[key] = {
                "value_num": value_num,
                "value_text": value_text,
                "prev_num": prev_num,
                "prev_text": prev_text,
            }

        latest.value_num = value_num
        latest.value_text = (value_text or "")[:255] if value_text is not None else None
        latest.quality = quality
        latest.source = source[:40]
        # For cycle-activity tags, only refresh recorded_at when the value actually changes
        # so "Running" expires after IMM_CYCLE_ACTIVITY_SEC without new cycle progress.
        if key in CYCLE_ACTIVITY_KEYS:
            if value_changed:
                latest.recorded_at = now
        else:
            latest.recorded_at = now

        # History: cycle tags + shot-sequence status tags only when value changes
        shot_status_keys = ("Injection_Status", "Refilling_Status")
        write_this = True
        if key in CYCLE_ACTIVITY_KEYS or key in shot_status_keys:
            write_this = value_changed
        if write_history and write_this:
            db.add(
                ImmOpcuaSample(
                    machine_id=machine_id,
                    param_key=key,
                    value_num=value_num,
                    value_text=(value_text or "")[:255] if value_text is not None else None,
                    quality=quality,
                    source=source[:40],
                    recorded_at=now,
                )
            )

        if sync_kpiv and value_num is not None:
            d = defs.get(key)
            kpiv_tag = (d.kpiv_tag if d else None) or item.get("kpiv_tag")
            if kpiv_tag:
                db.add(
                    ImmKpivSample(
                        machine_id=machine_id,
                        tag=str(kpiv_tag)[:40],
                        value=float(value_num),
                        recorded_at=now,
                    )
                )
                kpiv_written += 1
        accepted += 1

    # Shot sequence detection is handled in Node-RED (EAP_Shot_Event).
    # Optional backend FSM remains available via IMM_BACKEND_SHOT_FSM=1.
    shots_detected = 0
    backend_fsm = str(os.getenv("IMM_BACKEND_SHOT_FSM", "0")).strip().lower() in (
        "1", "true", "yes", "on",
    )
    if backend_fsm and shot_changes:
        try:
            from .imm_shot_counter import apply_shot_changes

            shots_detected = apply_shot_changes(
                db, machine_id, shot_changes, now=now, source=source, commit=False,
            )
        except Exception:
            shots_detected = 0

    db.commit()

    # Mirror Motor/Heater-derived status into machine_status_log for Hit Rate / OEE
    try:
        sync_imm_status_log(db, machine_id, source=f"imm_{source}"[:40])
    except Exception:
        pass

    return {
        "accepted": accepted,
        "kpiv_written": kpiv_written,
        "shots_detected": shots_detected,
        "recorded_at": now.isoformat(),
    }


def sync_imm_status_log(db: Session, machine_id: int, source: str = "imm_opcua") -> Optional[str]:
    """Write MachineStatusLog when EAP IMM derived status changes."""
    from .models import Machine, MachineStatusLog
    from .routers.machines import _log_status

    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        return None

    hl = highlights_for_machine(db, machine_id)
    live = eap_imm_status_from_opcua_highlights(
        hl,
        machine_name=m.name,
        plc_source=getattr(m, "plc_source", None),
        db=db,
    )  # running|available|idle|stop|offline
    # machine.status enum has no stop/available — map for Machine row only
    machine_status = {
        "running": "running",
        "available": "idle",
        "idle": "idle",
        "stop": "idle",
        "offline": "offline",
    }.get(live, "offline")
    # Log keeps available/stop so hit-rate can treat running ≠ available
    log_status = live if live in ("running", "available", "idle", "stop", "offline") else machine_status

    last = (
        db.query(MachineStatusLog)
        .filter(MachineStatusLog.machine_id == machine_id)
        .order_by(MachineStatusLog.changed_at.desc(), MachineStatusLog.id.desc())
        .first()
    )
    if last and (last.status or "").lower() == log_status:
        if m.status != machine_status:
            m.status = machine_status
            db.commit()
        return log_status

    _log_status(machine_id, log_status, source[:50], db)
    m.status = machine_status
    db.commit()
    return log_status


def latest_payload(db: Session, machine_id: int) -> List[dict]:
    ensure_machine_tag_maps(db, machine_id)
    defs = {
        d.param_key: d
        for d in db.query(ImmOpcuaParamDef).order_by(ImmOpcuaParamDef.sort_order).all()
    }
    maps = {
        m.param_key: m
        for m in db.query(ImmOpcuaTagMap).filter(ImmOpcuaTagMap.machine_id == machine_id).all()
    }
    latest_rows = {
        r.param_key: r
        for r in db.query(ImmOpcuaLatest).filter(ImmOpcuaLatest.machine_id == machine_id).all()
    }
    out = []
    for key, d in defs.items():
        m = maps.get(key)
        r = latest_rows.get(key)
        out.append(
            {
                "param_key": key,
                "display_name": d.display_name,
                "category": d.category,
                "io_type": d.io_type,
                "identified_tag": d.identified_tag,
                "identified_node_id": d.identified_node_id,
                "opcua_tag_name": m.opcua_tag_name if m else d.identified_tag,
                "opcua_node_id": m.opcua_node_id if m else d.identified_node_id,
                "enabled": bool(m.enabled) if m else True,
                "kpiv_tag": d.kpiv_tag,
                "value_num": r.value_num if r else None,
                "value_text": r.value_text if r else None,
                "quality": r.quality if r else None,
                "source": r.source if r else None,
                "recorded_at": r.recorded_at.isoformat() if r and r.recorded_at else None,
            }
        )
    return out


def highlights_for_machine(db: Session, machine_id: int) -> Dict[str, Any]:
    rows = {
        r.param_key: r
        for r in db.query(ImmOpcuaLatest).filter(ImmOpcuaLatest.machine_id == machine_id).all()
    }
    # Prefer catalog keys; fall back to device-prefixed aliases (IMM18_Motor_status)
    by_norm: Dict[str, Any] = {}
    for pk, r in rows.items():
        nk = normalize_param_key(pk)
        prev = by_norm.get(nk)
        if prev is None or (r.recorded_at and (not prev.recorded_at or r.recorded_at >= prev.recorded_at)):
            by_norm[nk] = r

    out = {}
    for key in HIGHLIGHT_KEYS:
        r = rows.get(key) or by_norm.get(key)
        if not r:
            continue
        out[key] = {
            "value_num": r.value_num,
            "value_text": r.value_text,
            "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
        }
    return out


def _opcua_flag(opcua: dict, key: str) -> bool:
    v = opcua.get(key) or {}
    text = str(v.get("value_text") or "").strip().lower()
    num = v.get("value_num")
    if text in ("on", "1", "true", "yes", "connected", "auto"):
        return True
    if text in ("off", "0", "false", "no", "disconnected"):
        return False
    if num is not None:
        try:
            return float(num) > 0
        except (TypeError, ValueError):
            return False
    return False


def _highlight_recorded_at(entry: dict) -> Optional[datetime]:
    raw = (entry or {}).get("recorded_at")
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def machine_imm_category(machine_name: Optional[str] = None, plc_source: Optional[str] = None) -> str:
    """Return 'plc_status' (IMM17/18) or 'opcua' (IMM_07..11 / Dia Edge)."""
    src = str(plc_source or "").strip().lower()
    if src in ("plc", "status", "sie_status", "nodered_status", "status_tags"):
        return "plc_status"
    if src in ("opcua", "diaedge", "opc", "opc-ua"):
        return "opcua"
    n = re.sub(r"[\s\-]+", "", str(machine_name or "").strip().upper())
    if _PLC_STATUS_NAME_RE.match(n):
        return "plc_status"
    if _OPCUA_IMM_NAME_RE.match(n):
        return "opcua"
    # Heuristic: machines that only stream status tags behave like PLC category
    return "opcua"


def _one_shift_stale_sec(db: Optional[Session] = None) -> int:
    """Longest enabled shift duration (seconds), fallback IMM_PLC_STATUS_STALE_SEC."""
    if db is None:
        return max(3600, IMM_PLC_STATUS_STALE_SEC)
    try:
        from .routers.config import _load_config
        from .routers.hourly_output import _shift_window

        cfg = _load_config(db)
        shifts = [s for s in (cfg.get("shifts") or []) if s.get("enabled", True)]
        if not shifts:
            return max(3600, IMM_PLC_STATUS_STALE_SEC)
        today = now_ist().date()
        longest = 0
        for sh in shifts:
            try:
                start, end = _shift_window(today, sh)
                longest = max(longest, int((end - start).total_seconds()))
            except Exception:
                continue
        if longest > 0:
            return longest
    except Exception:
        pass
    return max(3600, IMM_PLC_STATUS_STALE_SEC)


def _motor_heater_ages_sec(opcua: dict) -> List[float]:
    now = now_ist().replace(tzinfo=None)
    ages = []
    for key in ("Motor_Status", "Heater_Status"):
        if key not in opcua:
            continue
        ts = _highlight_recorded_at(opcua.get(key) or {})
        if ts is None:
            continue
        ages.append((now - ts).total_seconds())
    return ages


def _status_samples_stale(
    opcua: dict,
    max_age_sec: int = IMM_STATUS_MAX_AGE_SEC,
    *,
    allow_connection_bypass: bool = True,
) -> bool:
    """True when Motor/Heater samples are too old to trust as live.

    For OPC UA machines, Connection_Status ON can bypass age (on-change pushes).
    For PLC status-tag machines (IMM17/18), bypass is disabled — stale Motor/Heater
    after one shift ⇒ Offline.
    """
    if allow_connection_bypass and "Connection_Status" in opcua and _opcua_flag(opcua, "Connection_Status"):
        return False

    ages = _motor_heater_ages_sec(opcua)
    if not ages:
        # No usable timestamps → treat as stale for PLC; OPC UA path only reaches
        # here when Motor/Heater keys exist but lack recorded_at.
        return True
    # Offline only when neither Motor nor Heater was refreshed within the window
    # (freshest sample still older than max_age).
    return min(ages) > max_age_sec


def _cycle_activity_recent(opcua: dict, max_age_sec: int = IMM_CYCLE_ACTIVITY_SEC) -> bool:
    """True when Actual_Charging_Time or Actual_Injection_Time changed recently."""
    now = now_ist().replace(tzinfo=None)
    for key in CYCLE_ACTIVITY_KEYS:
        entry = opcua.get(key)
        if not entry:
            continue
        ts = _highlight_recorded_at(entry)
        if ts is None:
            continue
        if (now - ts).total_seconds() <= max_age_sec:
            return True
    return False


def eap_imm_status_from_opcua_highlights(
    opcua: dict,
    *,
    machine_name: Optional[str] = None,
    plc_source: Optional[str] = None,
    category: Optional[str] = None,
    stale_sec: Optional[int] = None,
    db: Optional[Session] = None,
) -> str:
    """Derive EAP IMM machine status from latest OPC UA / Node-RED highlight values.

    Categories:
      plc_status (IMM17/IMM18):
        Motor/Heater not updated for > one shift → offline
        Motor ON + Heater ON → available (running if Injection recently true)
        Motor/Heater mixed → idle; both OFF → stop
      opcua (IMM_07..IMM_11):
        Motor ON + Heater ON + recent Charging/Injection time change → running
        Motor ON + Heater ON (powered, not cycling)                 → available
        Offline when Motor/Heater missing or older than IMM_STATUS_MAX_AGE_SEC
        (Connection_Status may keep OPC UA tags alive across on-change gaps)
    """
    if not opcua:
        return "offline"

    cat = (category or machine_imm_category(machine_name, plc_source) or "opcua").strip().lower()
    has_motor = "Motor_Status" in opcua
    has_heater = "Heater_Status" in opcua
    if not (has_motor and has_heater):
        return "offline"

    if cat == "plc_status":
        max_age = int(stale_sec if stale_sec is not None else _one_shift_stale_sec(db))
        if _status_samples_stale(opcua, max_age, allow_connection_bypass=False):
            return "offline"
        motor = _opcua_flag(opcua, "Motor_Status")
        heater = _opcua_flag(opcua, "Heater_Status")
        if motor and heater:
            # PLC stream has no reliable CT tags — Injection_Status true ≈ cycling
            inj = opcua.get("Injection_Status")
            if inj is not None:
                inj_ts = _highlight_recorded_at(inj)
                inj_on = _opcua_flag(opcua, "Injection_Status")
                if inj_on and inj_ts is not None:
                    age = (now_ist().replace(tzinfo=None) - inj_ts).total_seconds()
                    if age <= IMM_CYCLE_ACTIVITY_SEC:
                        return "running"
            return "available"
        if motor or heater:
            return "idle"
        return "stop"

    # OPC UA / Dia Edge machines
    max_age = int(stale_sec if stale_sec is not None else IMM_STATUS_MAX_AGE_SEC)
    if _status_samples_stale(opcua, max_age, allow_connection_bypass=True):
        return "offline"
    motor = _opcua_flag(opcua, "Motor_Status")
    heater = _opcua_flag(opcua, "Heater_Status")
    if motor and heater:
        if _cycle_activity_recent(opcua):
            return "running"
        return "available"
    if motor or heater:
        return "idle"
    return "stop"


def build_node_id(raw: Optional[str], namespace_index: int = 2) -> Optional[str]:
    """Turn numeric Dia Edge IDs into OPC UA NodeIds (ns=2;i=1517)."""
    if not raw:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if s.lower().startswith("ns=") or s.lower().startswith("i=") or ";" in s:
        return s
    if s.isdigit():
        return f"ns={namespace_index};i={s}"
    return s


async def poll_machine_opcua(db: Session, machine: Machine, timeout_sec: float = 5.0) -> dict:
    """
    Read mapped nodes from machine.plc_endpoint via asyncua.
    Requires: pip install asyncua
    """
    endpoint = (machine.plc_endpoint or "").strip()
    if not endpoint:
        return {"ok": False, "error": "Machine plc_endpoint is empty", "accepted": 0}
    try:
        from asyncua import Client  # type: ignore
    except ImportError:
        return {
            "ok": False,
            "error": "asyncua is not installed. Run: pip install asyncua",
            "accepted": 0,
        }

    ensure_machine_tag_maps(db, machine.id)
    maps = (
        db.query(ImmOpcuaTagMap)
        .filter(ImmOpcuaTagMap.machine_id == machine.id, ImmOpcuaTagMap.enabled == 1)
        .all()
    )
    node_specs = []
    for m in maps:
        nid = build_node_id(m.opcua_node_id)
        if nid:
            node_specs.append((m.param_key, nid))
    if not node_specs:
        return {"ok": False, "error": "No enabled OPC UA node IDs mapped", "accepted": 0}

    samples = []
    errors = []
    try:
        client = Client(url=endpoint, timeout=timeout_sec)
        async with client:
            for param_key, nid in node_specs:
                try:
                    node = client.get_node(nid)
                    val = await node.read_value()
                    samples.append({"param_key": param_key, "value": val, "quality": "good"})
                except Exception as exc:  # noqa: BLE001
                    errors.append({"param_key": param_key, "node_id": nid, "error": str(exc)})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "accepted": 0, "errors": errors}

    result = ingest_samples(db, machine.id, samples, source="opcua", write_history=True, sync_kpiv=True)
    result["ok"] = True
    result["errors"] = errors
    result["endpoint"] = endpoint
    return result


def simulate_demo_samples(db: Session, machine_id: int) -> dict:
    """Fill demo live values when OPC UA is offline (dev / demo only)."""
    import random

    ensure_machine_tag_maps(db, machine_id)
    samples = [
        {"param_key": "Actual_Cycle_Time", "value": round(random.uniform(18, 32), 2)},
        {"param_key": "Last_Cycle_Time", "value": round(random.uniform(18, 32), 2)},
        {"param_key": "Actual_Production_Count", "value": random.randint(100, 5000)},
        {"param_key": "Production_Target_Count", "value": 5000},
        {"param_key": "Total_Good_Count", "value": random.randint(80, 4800)},
        {"param_key": "Total_Bad_Count", "value": random.randint(0, 50)},
        {"param_key": "Actual_Nozzle_Temp", "value": round(random.uniform(200, 220), 1)},
        {"param_key": "Actual_Cylender_1_Temp", "value": round(random.uniform(190, 210), 1)},
        {"param_key": "Actual_Cylender_2_Temp", "value": round(random.uniform(185, 205), 1)},
        {"param_key": "Actual_Cylender_3_Temp", "value": round(random.uniform(180, 200), 1)},
        {"param_key": "Actual_Back_Pressure", "value": round(random.uniform(4, 12), 2)},
        {"param_key": "Actual_System_Pressure", "value": round(random.uniform(90, 140), 1)},
        {"param_key": "Actual_Charging_RPM", "value": round(random.uniform(80, 140), 1)},
        {"param_key": "Actual_Charging_Time", "value": round(random.uniform(3.5, 6.5), 2)},
        {"param_key": "Actual_Injection_Time", "value": round(random.uniform(1.2, 3.5), 2)},
        {"param_key": "Actual_Injection_Cusion_Monitoring_Position", "value": round(random.uniform(8, 14), 2)},
        {"param_key": "Actual_Machine_Oil_Temp", "value": round(random.uniform(35, 55), 1)},
        {"param_key": "Connection_Status", "value": "Connected"},
        {"param_key": "Motor_Status", "value": "ON"},
        {"param_key": "Heater_Status", "value": "ON"},
        {"param_key": "Auto_Mode", "value": "ON"},
        {"param_key": "Manual_Mode", "value": "OFF"},
        {"param_key": "Robot_Running_Status", "value": "ON"},
        {"param_key": "Actual_Mold_Name", "value": "MOLD-DEMO-01"},
        {"param_key": "Actual_Material_Name", "value": "ABS"},
    ]
    return ingest_samples(db, machine_id, samples, source="simulate", write_history=True, sync_kpiv=True)
