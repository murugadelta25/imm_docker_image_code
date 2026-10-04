"""Node-RED / SIE EDA bridge — fetch live IMM trx body and ingest as OPC UA parameters."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from .models import Machine
from .opcua_imm import ensure_machine_tag_maps, ingest_samples

NODE_RED_URL = os.getenv("NODE_RED_URL", "http://127.0.0.1:1880").rstrip("/")
WEBHOOK_SECRET = os.getenv("NODE_RED_WEBHOOK_SECRET", "").strip()

# SIE device UUID → friendly label (matches flows.json IMM_xx nodes)
# Note: PLC_Plastech (a916642e-…) carries IMM17/IMM18 status AND plant energy on one device.
# Node-RED routes machine status by trx.name (IMM17/IMM18) and plant energy as EM_PLANT
# (not tied to any IMM — map EM_PLANT to panels in the Energy Meter dashboard).
DEVICE_LABELS: Dict[str, str] = {
    "b695f76c-457a-4742-89d3-8950cc1f38a2": "IMM_07",
    "279cb5fc-18b1-4b7a-8e0c-fde9fc1e8fdf": "IMM_08",
    "69a56343-e331-4165-85a4-ebcc754d1f84": "IMM_09",
    "3a678f1d-1a26-4c2f-a208-a59efbbfd522": "IMM_10",
    "e3d7ca17-9f75-43fb-b8c4-c2b389245f63": "IMM_11",
    "a916642e-1be4-4f54-a9ae-da2a4d074e91": "PLC_Plastech",
}


def _is_energy_entry(entry: dict, device_name: str = "") -> bool:
    trx = str(entry.get("trx_name") or "").strip()
    name = (device_name or str(entry.get("machine_name") or "")).strip().upper()
    if trx.startswith("EnergyMeter_"):
        return True
    if name.startswith("EM_") or name.startswith("PANEL-"):
        return True
    return False


def _http_get_json(path: str, timeout: float = 5.0) -> Any:
    url = f"{NODE_RED_URL}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_all_devices() -> List[dict]:
    data = _http_get_json("/imm/api/live")
    if isinstance(data, dict) and data.get("devices"):
        return list(data["devices"])
    if isinstance(data, list):
        return data
    return []


def fetch_device(device_id: str) -> Optional[dict]:
    try:
        data = _http_get_json(f"/imm/api/live/{device_id}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    if isinstance(data, dict) and data.get("device"):
        return data["device"]
    if isinstance(data, dict) and data.get("parameters"):
        return data
    return None


def parameters_to_samples(parameters: Dict[str, Any]) -> List[dict]:
    samples = []
    # SIE cumulative totals ↔ catalog Energy_Shift_* aliases (either side may arrive)
    aliases = {
        "Total_Active_Energy": "Energy_Shift_Kwh",
        "Total_Appearent_Energy": "Energy_Shift_Kvah",
        "Total_Apparent_Energy": "Energy_Shift_Kvah",
        "Total_Reactive_Energy": "Energy_Shift_Kvarh",
        "Energy_Shift_Kwh": "Total_Active_Energy",
        "Energy_Shift_Kvah": "Total_Appearent_Energy",
        "Energy_Shift_Kvarh": "Total_Reactive_Energy",
    }
    seen = set()
    for key, val in (parameters or {}).items():
        if key in ("device", "trx", "body", "id", "origin"):
            continue
        if val is None or val == "":
            continue
        k = str(key)
        if k not in seen:
            samples.append({"param_key": k, "value": val, "quality": "good"})
            seen.add(k)
        alt = aliases.get(k)
        if alt and alt not in seen:
            samples.append({"param_key": alt, "value": val, "quality": "good"})
            seen.add(alt)
    return samples


def find_machine_for_device(db: Session, device_id: str, device_name: str = "") -> Optional[Machine]:
    device_id = (device_id or "").strip()
    device_name = (device_name or DEVICE_LABELS.get(device_id) or "").strip()
    if device_id:
        m = (
            db.query(Machine)
            .filter(
                (Machine.plc_topic == device_id)
                | (Machine.plc_endpoint == device_id)
            )
            .first()
        )
        if m:
            return m
    if device_name:
        for m in db.query(Machine).all():
            if (m.name or "").strip().upper() == device_name.upper():
                return m
            if device_name.upper().replace("_", "") in (m.name or "").upper().replace("_", ""):
                return m
    return None


def ingest_device_entry(db: Session, entry: dict, machine: Optional[Machine] = None) -> dict:
    device_id = str(entry.get("device_id") or entry.get("device") or "")
    device_name = str(
        entry.get("device_name")
        or entry.get("machine_name")
        or DEVICE_LABELS.get(device_id)
        or ""
    )
    params = entry.get("parameters") or entry.get("body") or {}
    if not isinstance(params, dict):
        params = {}

    m = machine
    is_energy = _is_energy_entry(entry, device_name)
    # Preferred (CNC-style): Node-RED sends EAP fleet machine_id from Machine Configuration
    if m is None:
        raw_mid = entry.get("machine_id")
        if raw_mid is not None and str(raw_mid).strip() != "":
            try:
                mid = int(raw_mid)
            except (TypeError, ValueError):
                mid = None
            if mid is not None and mid > 0:
                m = db.query(Machine).filter(Machine.id == mid).first()
                if not m and not is_energy:
                    return {
                        "ok": False,
                        "device_id": device_id,
                        "device_name": device_name,
                        "machine_id": mid,
                        "error": f"No machine with fleet id={mid} — check Machine Configuration ID",
                    }
    if m is None and not is_energy:
        m = find_machine_for_device(db, device_id, device_name)
    # Plant energy meter: dedicated EM_PLANT utility machine (not IMM17/18)
    if m is None and is_energy:
        from .energy_meter import ensure_energy_source_machine
        m = ensure_energy_source_machine(db, device_name or entry.get("machine_name") or "EM_PLANT")
        db.commit()
    if not m:
        return {
            "ok": False,
            "device_id": device_id,
            "device_name": device_name,
            "error": (
                "No machine mapped — set machine_id (fleet ID) in Node-RED, "
                "or machines.plc_topic to SIE device UUID, or match machine name"
            ),
        }

    # Node-RED shot FSM sends EAP_Shot_Event=1 when a cycle completes.
    # Record a light ImmShotEvent and strip the pulse so it is not stored as a tag.
    params = dict(params)
    shot_raw = params.pop("EAP_Shot_Event", None)
    if shot_raw is None:
        shot_raw = entry.get("shot_count")
    shot_mode = str(entry.get("shot_mode") or params.pop("EAP_Shot_Mode", None) or "")[:40]
    shot_pulse = False
    if shot_raw is not None and str(shot_raw).strip() != "":
        try:
            shot_pulse = int(float(shot_raw)) >= 1
        except (TypeError, ValueError):
            shot_pulse = str(shot_raw).strip().lower() in ("1", "true", "yes", "on")

    samples = parameters_to_samples(params)
    if not samples and not shot_pulse:
        return {"ok": False, "device_id": device_id, "machine_id": m.id, "error": "No parameters in payload"}

    ensure_machine_tag_maps(db, m.id)
    result = {"accepted": 0, "kpiv_written": 0, "shots_detected": 0}
    if samples:
        result = ingest_samples(db, m.id, samples, source="nodered", write_history=True, sync_kpiv=True)
    if shot_pulse:
        try:
            from .models import ImmShotEvent, now_ist
            from .tool_service import apply_shot_mold_usage

            db.add(
                ImmShotEvent(
                    machine_id=m.id,
                    recorded_at=now_ist(),
                    mode=(shot_mode or "nodered")[:40],
                    source="nodered",
                    notes="EAP_Shot_Event from Node-RED",
                )
            )
            mold_usage = apply_shot_mold_usage(db, m.id, 1, source="nodered")
            db.commit()
            result["shots_detected"] = int(result.get("shots_detected") or 0) + 1
            result["shot_event"] = True
            if mold_usage:
                result["mold_usage"] = mold_usage
        except Exception as exc:
            result["shot_event_error"] = str(exc)
    try:
        from .energy_meter import sync_energy_from_machine_ingest
        sync_energy_from_machine_ingest(db, m.id, params)
    except Exception:
        pass
    return {
        "ok": True,
        "device_id": device_id,
        "device_name": device_name,
        "machine_id": m.id,
        "machine_name": m.name,
        **result,
    }


def sync_all_from_nodered(db: Session) -> dict:
    try:
        devices = fetch_all_devices()
    except Exception as exc:
        return {"ok": False, "error": f"Node-RED unreachable at {NODE_RED_URL}: {exc}", "results": []}

    results = []
    for entry in devices:
        try:
            results.append(ingest_device_entry(db, entry))
        except Exception as exc:
            results.append({"ok": False, "device_id": entry.get("device_id"), "error": str(exc)})

    ok_count = sum(1 for r in results if r.get("ok"))
    return {
        "ok": ok_count > 0,
        "node_red_url": NODE_RED_URL,
        "synced": ok_count,
        "total": len(results),
        "results": results,
    }


def sync_machine_from_nodered(db: Session, machine: Machine) -> dict:
    device_id = (machine.plc_topic or machine.plc_endpoint or "").strip()
    if not device_id:
        return {
            "ok": False,
            "machine_id": machine.id,
            "error": "Machine has no plc_topic / plc_endpoint (SIE device UUID)",
        }
    try:
        entry = fetch_device(device_id)
    except Exception as exc:
        return {"ok": False, "machine_id": machine.id, "error": f"Node-RED fetch failed: {exc}"}
    if not entry:
        return {"ok": False, "machine_id": machine.id, "device_id": device_id, "error": "No live data for device"}
    return ingest_device_entry(db, entry, machine=machine)


def has_recent_nodered_data(db: Session, machine_id: int) -> bool:
    from .models import ImmOpcuaLatest

    row = (
        db.query(ImmOpcuaLatest)
        .filter(
            ImmOpcuaLatest.machine_id == machine_id,
            ImmOpcuaLatest.source == "nodered",
        )
        .first()
    )
    return row is not None
