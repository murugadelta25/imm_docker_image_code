"""Node-RED live data sync for IMM equipment dashboards."""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..models import Machine, get_db
from ..offline_queue import (
    queue_offline_entry,
    mark_device_online,
    get_offline_queue_status,
    get_pending_offline_entries,
    mark_entries_processed,
    ensure_offline_tables,
)
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


def _process_webhook_async(entry: dict, retry_count: int = 0, max_retries: int = 3):
    """
    Background task: process webhook payload asynchronously.
    This prevents slow database operations from blocking the HTTP response.
    
    On connection failure, queues the data offline instead of blocking.
    """
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from ..models import DATABASE_URL

        engine = create_engine(
            DATABASE_URL,
            pool_pre_ping=True,
            echo=False
        )
        SessionLocal = sessionmaker(bind=engine)
        db = SessionLocal()
        try:
            result = ingest_device_entry(db, entry)
            if result.get("ok"):
                # Success - mark device as having successful push
                device_id = entry.get("device_id")
                if device_id:
                    mark_device_online(device_id)
                print(f"[OK] Webhook processed: {entry.get('machine_name')} accepted={result.get('accepted')} shots={result.get('shots_detected')}")
            else:
                # Ingest failed - this might be transient
                print(f"[WARN] Webhook ingest failed for device {entry.get('device_id')}: {result.get('error')}")
                # Don't queue offline here - ingest errors are usually data validation
        finally:
            db.close()
            engine.dispose()
    except Exception as exc:
        print(f"[ERROR] Webhook async processing failed (attempt {retry_count}/{max_retries}): {exc}")
        # Queue offline only after max retries exhausted or if it's a connection error
        if "connection" in str(exc).lower() or retry_count >= max_retries:
            offline_result = queue_offline_entry(entry, reason="connection_failed")
            if offline_result.get("ok"):
                print(f"[OK] Entry queued offline: {entry.get('machine_name')}")


@router.post("/webhook/push")
def webhook_push(
    body: WebhookPushBody,
    background_tasks: BackgroundTasks,
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
):
    """
    Node-RED pushes live IMM trx here (no JWT — use when nginx blocks pull API).

    Set X-Webhook-Secret header when NODE_RED_WEBHOOK_SECRET is configured in EAP .env.

    IMPORTANT: This endpoint is NON-BLOCKING. The payload is queued and processed
    asynchronously in a background task. Returns 202 Accepted immediately.
    This prevents slow database operations from causing 30-second timeouts.
    """
    _check_webhook_secret(x_webhook_secret)
    entry = body.model_dump()

    # Queue the payload for background processing
    background_tasks.add_task(_process_webhook_async, entry)

    # Return immediately (should be < 50ms) with 202 Accepted status
    return {"ok": True, "status": "queued", "message": "Payload queued for processing"}


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


class OfflineDataBatch(BaseModel):
    """Batch of offline data entries for restoration."""
    entries: List[Dict[str, Any]] = Field(..., description="List of offline data entries")
    device_id: Optional[str] = Field(None, description="Source device ID")
    batch_id: Optional[str] = Field(None, description="Batch identifier from Node-RED")
    batch_size: Optional[int] = Field(None, description="Total entries in batch")


def _process_offline_restoration_async(entries: List[Dict[str, Any]], entry_ids: List[int]):
    """
    Background task: restore offline data without blocking.
    Processes entries asynchronously and marks them as processed.
    """
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from ..models import DATABASE_URL

        engine = create_engine(
            DATABASE_URL,
            pool_pre_ping=True,
            echo=False
        )
        SessionLocal = sessionmaker(bind=engine)
        db = SessionLocal()
        try:
            processed_count = 0
            error_count = 0

            for entry in entries:
                try:
                    result = ingest_device_entry(db, entry)
                    if result.get("ok"):
                        processed_count += 1
                        print(f"[OK] Restored offline entry: {entry.get('machine_name')}")
                    else:
                        error_count += 1
                        print(f"[WARN] Failed to restore entry: {result.get('error')}")
                except Exception as exc:
                    error_count += 1
                    print(f"[ERROR] Restoration error: {exc}")

            # Mark entries as processed
            if entry_ids:
                mark_entries_processed(entry_ids, success=(error_count == 0))

            print(f"[OK] Offline restoration complete: {processed_count} succeeded, {error_count} failed")
        finally:
            db.close()
            engine.dispose()
    except Exception as exc:
        print(f"[ERROR] Offline restoration async failed: {exc}")


@router.post("/restore/offline")
def restore_offline_data(
    batch: OfflineDataBatch,
    background_tasks: BackgroundTasks,
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
):
    """
    Restore offline data that was queued while webapp was unavailable.
    
    This endpoint accepts batched offline data from Node-RED and processes it
    asynchronously in the background. Returns immediately to keep Node-RED responsive.
    
    When connection is restored:
    1. Node-RED sends POST /api/imm/nodered/restore/offline with queued entries
    2. Backend queues the restoration task and returns 202 Accepted immediately
    3. Background worker processes entries without blocking the webapp
    4. Frontend polls GET /api/imm/nodered/status to check restoration progress
    5. Once restored, frontend refreshes affected dashboards
    """
    _check_webhook_secret(x_webhook_secret)

    if not batch.entries:
        return {
            "ok": True,
            "restored": 0,
            "message": "Empty batch",
        }

    # Extract entry IDs for tracking (if provided)
    entry_ids = [e.get("queue_id") for e in batch.entries if e.get("queue_id")]

    # Queue for background processing - don't block the caller
    background_tasks.add_task(
        _process_offline_restoration_async,
        batch.entries,
        entry_ids,
    )

    # Mark devices as online immediately
    device_id = batch.device_id or batch.entries[0].get("device_id")
    if device_id:
        mark_device_online(device_id)

    return {
        "ok": True,
        "status": "restoring",
        "batch_size": len(batch.entries),
        "batch_id": batch.batch_id,
        "message": "Batch queued for asynchronous restoration",
    }


@router.post("/health/check")
def check_connection_health(
    device_id: str,
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret"),
):
    """
    Health check from Node-RED to verify connection status.
    
    Node-RED calls this periodically to:
    1. Confirm the webapp is reachable
    2. Trigger device status update (online/offline)
    3. Signal readiness to receive offline data restoration
    
    Returns:
    - 200 OK with connection_status="online" when webapp is healthy
    - Trigger offline queue processing if this is first successful ping after outage
    """
    _check_webhook_secret(x_webhook_secret)

    try:
        # Mark device as online - this helps track when connection is restored
        result = mark_device_online(device_id)

        return {
            "ok": True,
            "connection_status": "online",
            "webapp_ready": True,
            "device_id": device_id,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as exc:
        print(f"[ERROR] Health check failed: {exc}")
        return {
            "ok": False,
            "connection_status": "error",
            "error": str(exc),
        }


@router.get("/queue/status")
def get_queue_status(
    device_id: Optional[str] = None,
    _=Depends(get_current_user),
):
    """
    Get offline queue status.
    
    Used by frontend to:
    1. Show offline data count
    2. Track restoration progress
    3. Determine when to refresh dashboards
    
    Query params:
    - device_id: If provided, get status for specific device. Otherwise get all.
    
    Returns:
    - Queue counts
    - Device status (online/offline)
    - Time since offline (if offline)
    - Pending restoration count
    """
    status = get_offline_queue_status(device_id)
    return status


@router.get("/queue/pending")
def get_pending_queue(
    device_id: Optional[str] = None,
    limit: int = 100,
    max_age_minutes: int = 15,
    _=Depends(require_role("admin", "supervisor")),
):
    """
    Get pending offline entries awaiting restoration.
    
    Admin/Supervisor only endpoint for monitoring offline queue.
    
    Query params:
    - device_id: Filter by device (optional)
    - limit: Maximum entries to return (default 100)
    - max_age_minutes: Only return entries newer than this (default 15)
    """
    entries = get_pending_offline_entries(device_id, limit, max_age_minutes)
    return {
        "ok": True,
        "count": len(entries),
        "entries": entries,
    }


@router.post("/queue/cleanup")
def cleanup_queue(
    days_old: int = 7,
    _=Depends(require_role("admin")),
):
    """
    Clean up old processed offline queue entries.
    
    Admin only endpoint to clean up successfully processed entries older than
    specified days. Only removes entries marked as successfully processed.
    
    Query params:
    - days_old: Remove entries older than this many days (default 7)
    """
    from ..offline_queue import cleanup_old_offline_entries

    result = cleanup_old_offline_entries(days_old)
    return result
