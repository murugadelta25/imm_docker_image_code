"""Node-RED live data sync for IMM equipment dashboards."""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..models import Machine, get_db
from ..nodered_imm import (
    DEVICE_LABELS,
    NODE_RED_URL,
    WEBHOOK_SECRET,
    fetch_all_devices,
    fetch_device,
    ingest_device_entry,
    sync_all_from_nodered,
    sync_machine_from_nodered,
)

router = APIRouter(prefix="/api/imm/nodered", tags=["imm-nodered"])


class WebhookPushBody(BaseModel):
    """Node-RED push body. Prefer machine_id (fleet ID from Machine Configuration), like CNC status PATCH."""

    machine_id: Optional[int] = Field(
        None, description="EAP machines.id from Machine Configuration (preferred, CNC-style)"
    )
    machine_name: Optional[str] = Field(None, description="Friendly name e.g. IMM_07")
    device_id: Optional[str] = Field(None, description="SIE device UUID (optional if machine_id set)")
    device_name: Optional[str] = None
    trx_name: Optional[str] = None
    parameters: Dict[str, Any] = Field(default_factory=dict)
    received_at: Optional[str] = None
    parameter_count: Optional[int] = None
    message_id: Optional[str] = None


def _check_webhook_secret(x_webhook_secret: Optional[str]) -> None:
    if WEBHOOK_SECRET and x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(401, "Invalid webhook secret")


def _machine_or_404(db: Session, machine_id: int) -> Machine:
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    return m


@router.post("/webhook/push")
def webhook_push(
    body: WebhookPushBody,
    db: Session = Depends(get_db),
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
):
    """
    Node-RED pushes live IMM trx here (no JWT — use when nginx blocks pull API).

    Set X-Webhook-Secret header when NODE_RED_WEBHOOK_SECRET is configured in EAP .env.
    """
    _check_webhook_secret(x_webhook_secret)
    entry = body.model_dump()
    result = ingest_device_entry(db, entry)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "Ingest failed")
    return result


@router.get("/config")
def nodered_config(_=Depends(get_current_user)):
    return {
        "node_red_url": NODE_RED_URL,
        "webhook_push_url_hint": "POST http://<ubuntu-eap-ip>:8040/api/imm/nodered/webhook/push",
        "webhook_secret_required": bool(WEBHOOK_SECRET),
        "device_labels": DEVICE_LABELS,
        "mapping_hint": (
            "Preferred: Node-RED sends machine_id = machines.id from Machine Configuration. "
            "Fallback: machines.plc_topic = SIE UUID, or match machine name."
        ),
    }


@router.get("/live")
def nodered_live_proxy(_=Depends(get_current_user)):
    """Proxy Node-RED GET /imm/api/live for diagnostics."""
    try:
        devices = fetch_all_devices()
    except Exception as exc:
        raise HTTPException(502, f"Node-RED unreachable: {exc}") from exc
    return {"ok": True, "devices": devices, "count": len(devices)}


@router.get("/live/{device_id}")
def nodered_live_device(device_id: str, _=Depends(get_current_user)):
    try:
        entry = fetch_device(device_id)
    except Exception as exc:
        raise HTTPException(502, f"Node-RED unreachable: {exc}") from exc
    if not entry:
        raise HTTPException(404, f"No live data for device {device_id}")
    return {"ok": True, "device": entry}


@router.post("/sync")
def sync_all(
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "operator", "maintenance")),
):
    """Pull all device snapshots from Node-RED and ingest into imm_opcua_latest."""
    return sync_all_from_nodered(db)


@router.post("/equipment/{machine_id}/sync")
def sync_equipment(
    machine_id: int,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Pull one machine's device snapshot from Node-RED by plc_topic UUID."""
    machine = _machine_or_404(db, machine_id)
    return sync_machine_from_nodered(db, machine)


@router.post("/ingest/device/{device_id}")
def ingest_device_webhook(
    device_id: str,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "operator", "maintenance")),
):
    """Fetch one device from Node-RED store and ingest (push-friendly alias)."""
    entry = fetch_device(device_id)
    if not entry:
        raise HTTPException(404, f"No live data for device {device_id}")
    result = ingest_device_entry(db, entry)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "Ingest failed")
    return result
