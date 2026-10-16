"""Background plan.actual_qty sync — keep GET APIs fast.

Heavy sync_plan_actuals_from_status_logs used to run inside list/detail GETs and
exceeded the browser ~30s timeout. Features still need actuals updated, so we:

  1. schedule_plan_actuals_sync(...) from request handlers (non-blocking)
  2. run a periodic job for recent shifts (scheduler)

Reads return persisted plan.actual_qty immediately; sync catches up in the background.
"""
from __future__ import annotations

import threading
import time
from datetime import date, timedelta
from typing import Any, Dict, Optional

_lock = threading.Lock()
_pending: Dict[str, Any] = {}
_worker_started = False
_last_run_mono = 0.0
_MIN_INTERVAL_SEC = 45.0  # coalesce bursts; don't thrash DB


def _key(kwargs: dict) -> str:
    return "|".join(
        [
            str(kwargs.get("entry_date") or ""),
            str(kwargs.get("date_from") or ""),
            str(kwargs.get("date_to") or ""),
            str(kwargs.get("machine_id") or ""),
            str(kwargs.get("shift") or ""),
        ]
    )


def schedule_plan_actuals_sync(
    *,
    entry_date: Optional[date] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    machine_id: Optional[int] = None,
    shift: Optional[str] = None,
) -> None:
    """Queue a sync request; returns immediately."""
    global _worker_started
    payload = {
        "entry_date": entry_date,
        "date_from": date_from,
        "date_to": date_to,
        "machine_id": machine_id,
        "shift": shift,
    }
    # Drop empty keys so sync uses its own defaults/caps
    payload = {k: v for k, v in payload.items() if v is not None}
    with _lock:
        _pending[_key(payload)] = payload
        if not _worker_started:
            _worker_started = True
            t = threading.Thread(target=_worker_loop, name="plan-actuals-sync", daemon=True)
            t.start()


def _worker_loop():
    global _last_run_mono
    while True:
        time.sleep(2.0)
        with _lock:
            if not _pending:
                continue
            if time.monotonic() - _last_run_mono < _MIN_INTERVAL_SEC:
                continue
            batch = list(_pending.values())
            _pending.clear()
            _last_run_mono = time.monotonic()
        for item in batch:
            _run_one(item)


def _run_one(kwargs: dict) -> None:
    from .models import SessionLocal
    from .routers.hourly_output import sync_plan_actuals_from_status_logs

    db = SessionLocal()
    try:
        n = sync_plan_actuals_from_status_logs(db, commit=True, **kwargs)
        if n:
            print(f"[PlanActualsSync] updated {n} plan(s) kwargs={kwargs}")
    except Exception as exc:
        print(f"[PlanActualsSync] failed: {exc}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


def run_recent_plan_actuals_sync() -> int:
    """Scheduler entry: sync yesterday + today (all machines). Returns plans updated."""
    from .models import SessionLocal, now_ist
    from .routers.hourly_output import sync_plan_actuals_from_status_logs

    today = now_ist().date()
    db = SessionLocal()
    try:
        return int(
            sync_plan_actuals_from_status_logs(
                db,
                date_from=today - timedelta(days=1),
                date_to=today,
                commit=True,
            )
            or 0
        )
    except Exception as exc:
        print(f"[PlanActualsSync] recent sync failed: {exc}")
        try:
            db.rollback()
        except Exception:
            pass
        return 0
    finally:
        db.close()
