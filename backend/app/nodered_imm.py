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
DEVICE_LABELS: Dict[str, str] = {
    "b695f76c-457a-4742-89d3-8950cc1f38a2": "IMM_07",
    "39ee125e-fa64-45c2-a92d-7dcf3990896f": "IMM_08",
    "7c0cee0d-1466-49da-830f-bb0447870286": "IMM_09",
    "7e9ab0d8-70bf-423a-be18-d4829c8dcdc5": "IMM_10",
}


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
    for key, val in (parameters or {}).items():
        if key in ("device", "trx", "body", "id", "origin"):
            continue
        if val is None or val == "":
            continue
        samples.append({"param_key": str(key), "value": val, "quality": "good"})
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
    # Preferred (CNC-style): Node-RED sends EAP fleet machine_id from Machine Configuration
    if m is None:
        raw_mid = entry.get("machine_id")
        if raw_mid is not None and str(raw_mid).strip() != "":
            try:
                mid = int(raw_mid)
            except (TypeError, ValueError):
                mid = None
            if mid is not None:
                m = db.query(Machine).filter(Machine.id == mid).first()
                if not m:
                    return {
                        "ok": False,
                        "device_id": device_id,
                        "device_name": device_name,
                        "machine_id": mid,
                        "error": f"No machine with fleet id={mid} — check Machine Configuration ID",
                    }
    if m is None:
        m = find_machine_for_device(db, device_id, device_name)
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

    samples = parameters_to_samples(params)
    if not samples:
        return {"ok": False, "device_id": device_id, "machine_id": m.id, "error": "No parameters in payload"}

    ensure_machine_tag_maps(db, m.id)
    result = ingest_samples(db, m.id, samples, source="nodered", write_history=True, sync_kpiv=True)
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
