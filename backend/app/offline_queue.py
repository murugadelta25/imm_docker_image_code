"""
Offline Data Queue Management for Node-RED Integration

Handles graceful degradation when Node-RED or machine networks are temporarily unavailable.
- Stores offline data from Node-RED with timestamps
- Tracks restoration progress
- Provides status and monitoring endpoints
- Non-blocking recovery to prevent webapp crashes
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from sqlalchemy import Column, Integer, String, DateTime, Text, create_engine, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
import json
import os

from .models import DATABASE_URL

Base = declarative_base()


class OfflineQueueEntry(Base):
    """Stores offline data entries received from Node-RED when webapp is unreachable."""

    __tablename__ = "imm_offline_queue"

    id = Column(Integer, primary_key=True)
    device_id = Column(String(255), nullable=False, index=True)
    machine_id = Column(Integer, nullable=True, index=True)
    machine_name = Column(String(255), nullable=True)
    trx_name = Column(String(255), nullable=True)
    parameters = Column(JSON, nullable=False)  # Store as JSON
    received_at = Column(DateTime, default=datetime.utcnow, index=True)
    queued_at = Column(DateTime, default=datetime.utcnow, index=True)
    processed_at = Column(DateTime, nullable=True)
    processed = Column(Integer, default=0)  # 0=pending, 1=succeeded, 2=failed
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0)
    last_retry_at = Column(DateTime, nullable=True)

    def __repr__(self):
        return f"<OfflineQueueEntry id={self.id} machine={self.machine_name} processed={self.processed}>"


class OfflineConnectionStatus(Base):
    """Tracks connection status and offline data accumulation."""

    __tablename__ = "imm_offline_connection_status"

    id = Column(Integer, primary_key=True)
    device_id = Column(String(255), unique=True, nullable=False, index=True)
    machine_id = Column(Integer, nullable=True)
    machine_name = Column(String(255), nullable=True)
    is_online = Column(Integer, default=1)  # 1=online, 0=offline
    last_successful_push = Column(DateTime, nullable=True)
    offline_since = Column(DateTime, nullable=True)
    failed_attempts = Column(Integer, default=0)
    queued_entries = Column(Integer, default=0)
    last_updated = Column(DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f"<OfflineConnectionStatus device={self.device_id} online={self.is_online}>"


def get_offline_db() -> Session:
    """Create a separate session for offline queue management."""
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=False
    )
    SessionLocal = sessionmaker(bind=engine)
    return SessionLocal()


def ensure_offline_tables(bind=None):
    """Create offline queue tables if they don't exist."""
    if bind is None:
        engine = create_engine(DATABASE_URL, pool_pre_ping=True)
        bind = engine

    try:
        Base.metadata.create_all(bind)
        print("[OK] Offline queue tables created/verified")
    except Exception as exc:
        print(f"[WARN] Failed to create offline queue tables: {exc}")


def queue_offline_entry(entry: dict, reason: str = "offline") -> Dict[str, Any]:
    """
    Queue an entry when offline. Does NOT block the caller.
    
    Args:
        entry: Device data entry from Node-RED
        reason: Reason for queuing (offline, connection_failed, timeout, etc)
    
    Returns:
        Result dict with queued entry info
    """
    try:
        db = get_offline_db()
        try:
            device_id = str(entry.get("device_id") or entry.get("device") or "unknown")
            machine_id = entry.get("machine_id")
            machine_name = entry.get("machine_name")
            parameters = entry.get("parameters") or {}

            # Create offline queue entry
            offline_entry = OfflineQueueEntry(
                device_id=device_id,
                machine_id=machine_id,
                machine_name=machine_name,
                trx_name=entry.get("trx_name"),
                parameters=parameters,
                received_at=datetime.fromisoformat(entry.get("received_at", datetime.utcnow().isoformat())),
            )
            db.add(offline_entry)

            # Update or create connection status
            status = db.query(OfflineConnectionStatus).filter(
                OfflineConnectionStatus.device_id == device_id
            ).first()

            if status:
                status.is_online = 0
                status.offline_since = status.offline_since or datetime.utcnow()
                status.queued_entries += 1
                status.failed_attempts += 1
            else:
                status = OfflineConnectionStatus(
                    device_id=device_id,
                    machine_id=machine_id,
                    machine_name=machine_name,
                    is_online=0,
                    offline_since=datetime.utcnow(),
                    failed_attempts=1,
                    queued_entries=1,
                )
                db.add(status)

            db.commit()
            return {
                "ok": True,
                "queued": True,
                "entry_id": offline_entry.id,
                "device_id": device_id,
                "machine_name": machine_name,
                "reason": reason,
            }
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to queue offline entry: {exc}")
        return {
            "ok": False,
            "queued": False,
            "error": str(exc),
        }


def mark_device_online(device_id: str) -> Dict[str, Any]:
    """Mark device as back online and ready to restore queued data."""
    try:
        db = get_offline_db()
        try:
            status = db.query(OfflineConnectionStatus).filter(
                OfflineConnectionStatus.device_id == device_id
            ).first()

            if status:
                status.is_online = 1
                status.last_successful_push = datetime.utcnow()
                status.failed_attempts = 0
                status.last_updated = datetime.utcnow()
                db.commit()

            return {
                "ok": True,
                "device_id": device_id,
                "online": True,
                "ready_to_restore": True,
            }
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to mark device online: {exc}")
        return {"ok": False, "error": str(exc)}


def get_offline_queue_status(device_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Get status of offline queue.
    
    Args:
        device_id: If provided, get status for specific device. Otherwise get all.
    
    Returns:
        Queue status including counts, devices, and pending entries
    """
    try:
        db = get_offline_db()
        try:
            if device_id:
                status = db.query(OfflineConnectionStatus).filter(
                    OfflineConnectionStatus.device_id == device_id
                ).first()

                if not status:
                    return {
                        "ok": True,
                        "device_id": device_id,
                        "is_online": True,
                        "queued_entries": 0,
                    }

                pending = db.query(OfflineQueueEntry).filter(
                    OfflineQueueEntry.device_id == device_id,
                    OfflineQueueEntry.processed == 0,
                ).count()

                return {
                    "ok": True,
                    "device_id": device_id,
                    "is_online": status.is_online == 1,
                    "offline_since": status.offline_since.isoformat() if status.offline_since else None,
                    "queued_entries": pending,
                    "total_failed_attempts": status.failed_attempts,
                    "machine_name": status.machine_name,
                }
            else:
                # Get all devices
                all_status = db.query(OfflineConnectionStatus).all()

                offline_devices = [
                    {
                        "device_id": s.device_id,
                        "machine_name": s.machine_name,
                        "offline_since": s.offline_since.isoformat() if s.offline_since else None,
                        "queued_entries": s.queued_entries,
                    }
                    for s in all_status
                    if s.is_online == 0
                ]

                total_queued = sum(s.queued_entries for s in all_status)

                return {
                    "ok": True,
                    "total_offline_devices": len(offline_devices),
                    "total_queued_entries": total_queued,
                    "offline_devices": offline_devices,
                }
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to get offline queue status: {exc}")
        return {"ok": False, "error": str(exc)}


def get_pending_offline_entries(
    device_id: Optional[str] = None,
    limit: int = 100,
    max_age_minutes: int = 15
) -> List[Dict[str, Any]]:
    """
    Get pending offline entries for restoration.
    
    Args:
        device_id: If provided, get entries only for this device
        limit: Maximum entries to retrieve
        max_age_minutes: Only return entries newer than this age
    
    Returns:
        List of pending offline entries
    """
    try:
        db = get_offline_db()
        try:
            cutoff_time = datetime.utcnow() - timedelta(minutes=max_age_minutes)

            query = db.query(OfflineQueueEntry).filter(
                OfflineQueueEntry.processed == 0,
                OfflineQueueEntry.queued_at >= cutoff_time,
            )

            if device_id:
                query = query.filter(OfflineQueueEntry.device_id == device_id)

            entries = query.order_by(OfflineQueueEntry.queued_at.asc()).limit(limit).all()

            return [
                {
                    "id": e.id,
                    "device_id": e.device_id,
                    "machine_id": e.machine_id,
                    "machine_name": e.machine_name,
                    "trx_name": e.trx_name,
                    "parameters": e.parameters,
                    "received_at": e.received_at.isoformat(),
                    "queued_at": e.queued_at.isoformat(),
                }
                for e in entries
            ]
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to get pending offline entries: {exc}")
        return []


def mark_entries_processed(
    entry_ids: List[int],
    success: bool = True,
    error_message: Optional[str] = None
) -> Dict[str, Any]:
    """
    Mark offline entries as processed (restored to backend).
    
    Args:
        entry_ids: List of offline queue entry IDs
        success: Whether restoration was successful
        error_message: Error message if restoration failed
    
    Returns:
        Result dict
    """
    if not entry_ids:
        return {"ok": True, "processed": 0}

    try:
        db = get_offline_db()
        try:
            count = 0
            for entry_id in entry_ids:
                entry = db.query(OfflineQueueEntry).filter(
                    OfflineQueueEntry.id == entry_id
                ).first()

                if entry:
                    entry.processed = 1 if success else 2
                    entry.processed_at = datetime.utcnow()
                    entry.error_message = error_message
                    entry.retry_count += 1
                    entry.last_retry_at = datetime.utcnow()
                    count += 1

            db.commit()

            return {
                "ok": True,
                "processed": count,
                "success": success,
            }
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to mark entries processed: {exc}")
        return {"ok": False, "error": str(exc)}


def cleanup_old_offline_entries(days_old: int = 7) -> Dict[str, Any]:
    """
    Clean up offline queue entries older than specified days.
    Only removes successfully processed entries.
    
    Args:
        days_old: Remove entries older than this many days
    
    Returns:
        Count of removed entries
    """
    try:
        db = get_offline_db()
        try:
            cutoff = datetime.utcnow() - timedelta(days=days_old)

            count = db.query(OfflineQueueEntry).filter(
                OfflineQueueEntry.processed == 1,
                OfflineQueueEntry.processed_at < cutoff,
            ).delete()

            db.commit()

            return {
                "ok": True,
                "removed": count,
            }
        finally:
            db.close()
    except Exception as exc:
        print(f"[ERROR] Failed to cleanup old offline entries: {exc}")
        return {"ok": False, "error": str(exc)}
