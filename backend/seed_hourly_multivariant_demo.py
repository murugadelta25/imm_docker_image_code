"""
Seed demo data: Shift B multi-variant scenario on CN40 (S1 Lathe).

  20:00–08:00   Variant A  (ROD/Variant-A, CT 40s) — full shift plan window
  20:15–22:00   Variant B  (ROD/Variant-B, CT 35s) — evening production window
  22:00–22:30   Setting change

Status logs only in each variant's active hours (incremental per slot, no bleed).

Run from backend/:  python seed_hourly_multivariant_demo.py
"""
from datetime import date, datetime, timedelta

from app.models import (
    SessionLocal, ProductionPlan, OEEEntry, ModelChangeRequest,
    MachineStatusLog, now_ist,
)
from app.routers.oee import OEECreate, calculate_oee

DEMO_TAG = "DEMO_MULTIVARIANT"
DEMO_DATE = date(2026, 6, 23)
SHIFT = "B"
MACHINE_ID = 1
STATION_NO = 1
USER_ID = 1

SHIFT_START = datetime.combine(DEMO_DATE, datetime.strptime("20:00", "%H:%M").time())
CT_A = 40.0
CT_B = 35.0


def _clear_demo(db):
    db.query(MachineStatusLog).filter(
        MachineStatusLog.machine_id == MACHINE_ID,
        MachineStatusLog.source == DEMO_TAG,
    ).delete(synchronize_session=False)
    db.query(ProductionPlan).filter(
        ProductionPlan.plan_date == DEMO_DATE,
        ProductionPlan.machine_id == MACHINE_ID,
        ProductionPlan.shift == SHIFT,
    ).delete(synchronize_session=False)
    db.query(OEEEntry).filter(
        OEEEntry.entry_date == DEMO_DATE,
        OEEEntry.machine_id == MACHINE_ID,
        OEEEntry.shift == SHIFT,
    ).delete(synchronize_session=False)
    for m in db.query(ModelChangeRequest).filter(ModelChangeRequest.reason == DEMO_TAG).all():
        db.delete(m)
    db.flush()


def _add_oee(db, *, model_variant, start_time, stop_time, process_time, loading_unloading,
               total_minutes, actual_qty, current_operation="OP-10", next_operation="OP-20"):
    payload = OEECreate(
        entry_date=DEMO_DATE,
        station_no=STATION_NO,
        machine_id=MACHINE_ID,
        shift=SHIFT,
        current_operation=current_operation,
        next_operation=next_operation,
        model_variant=model_variant,
        process_time=process_time,
        loading_unloading=loading_unloading,
        start_time=start_time,
        stop_time=stop_time,
        total_minutes=total_minutes,
        lunch_break=0,
        tea_break=0,
        setting_time=0,
        actual_qty=actual_qty,
        defect_qty=0,
    )
    calc = calculate_oee(payload)
    db.add(OEEEntry(**payload.model_dump(), **calc, created_by=USER_ID))


def _parts_to_seconds(parts, ct):
    if not parts or not ct:
        return 0
    return int(parts * ct)


def _log(db, at: datetime, status: str):
    db.add(MachineStatusLog(
        machine_id=MACHINE_ID, status=status, changed_at=at, source=DEMO_TAG,
    ))


def _slot_activity_events(slot_start: datetime, slot_end: datetime, ct: float,
                          run_parts: int, ld_parts: int, idle_parts: int):
    """Tight status bursts inside one hour — ends in idle so time does not bleed across the slot."""
    if run_parts <= 0 and ld_parts <= 0 and idle_parts <= 0:
        return []
    events = [(slot_start, "running")]
    cursor = slot_start

    run_sec = min(_parts_to_seconds(run_parts, ct), int((slot_end - slot_start).total_seconds()) - 20)
    if run_sec > 0:
        cursor += timedelta(seconds=run_sec)
        if cursor >= slot_end:
            return events
        events.append((cursor, "idle"))

    if ld_parts > 0 and cursor < slot_end:
        ld_sec = min(_parts_to_seconds(ld_parts, ct), 40)
        cursor += timedelta(seconds=ld_sec)

    if idle_parts > 0 and cursor < slot_end:
        cursor += timedelta(seconds=min(_parts_to_seconds(idle_parts, ct), 65))

    if cursor < slot_end:
        events.append((cursor, "idle"))

    return events


def _slot_start(hour_index: int) -> datetime:
    return SHIFT_START + timedelta(hours=hour_index)


def _seed_status_logs(db):
    """Variant B: hours 20–22. Variant A: hours 22–08."""
    all_events = []

    for i, (run_p, ld_p, idle_p) in enumerate([(35, 8, 0), (50, 10, 0)]):
        all_events.extend(_slot_activity_events(
            _slot_start(i), _slot_start(i + 1), CT_B, run_p, ld_p, idle_p,
        ))

    for i, (run_p, ld_p, idle_p) in enumerate([
        (6, 2, 1), (6, 2, 0), (5, 2, 1), (5, 2, 0),
        (5, 2, 1), (5, 2, 0), (5, 2, 1), (5, 2, 0),
        (5, 2, 1), (5, 2, 0),
    ]):
        all_events.extend(_slot_activity_events(
            _slot_start(i + 2), _slot_start(i + 3), CT_A, run_p, ld_p, idle_p,
        ))

    all_events.sort(key=lambda e: e[0])
    deduped = []
    for at, status in all_events:
        if deduped and deduped[-1][0] == at:
            deduped[-1] = (at, status)
        else:
            deduped.append((at, status))

    for at, status in deduped:
        _log(db, at, status)


def run():
    db = SessionLocal()
    try:
        _clear_demo(db)

        for spec in [
            dict(model_variant="ROD/Variant-A", process_time=32, loading_unloading=8,
                 planned_qty=90, priority=1),
            dict(model_variant="ROD/Variant-B", process_time=25, loading_unloading=10,
                 planned_qty=110, priority=2),
        ]:
            db.add(ProductionPlan(
                plan_date=DEMO_DATE, shift=SHIFT, station_no=STATION_NO, machine_id=MACHINE_ID,
                current_operation="OP-10", next_operation="OP-20",
                model_variant=spec["model_variant"],
                process_time=spec["process_time"], loading_unloading=spec["loading_unloading"],
                planned_qty=spec["planned_qty"], priority=spec["priority"],
                plan_type="scheduled", notes=DEMO_TAG, created_by=USER_ID, created_at=now_ist(),
            ))

        _add_oee(db,
            model_variant="ROD/Variant-A",
            start_time="20:00", stop_time="08:00",
            process_time=32, loading_unloading=8,
            total_minutes=720, actual_qty=72,
        )
        _add_oee(db,
            model_variant="ROD/Variant-B",
            start_time="20:15", stop_time="22:00",
            process_time=25, loading_unloading=10,
            total_minutes=105, actual_qty=95,
        )

        db.add(ModelChangeRequest(
            machine_id=MACHINE_ID, requested_by=USER_ID,
            from_model="ROD/Variant-B", to_model="ROD/Variant-A",
            ideal_minutes=30, shift=SHIFT, entry_date=DEMO_DATE, reason=DEMO_TAG,
            status="completed",
            start_time=datetime.combine(DEMO_DATE, datetime.strptime("22:00", "%H:%M").time()),
            end_time=datetime.combine(DEMO_DATE, datetime.strptime("22:30", "%H:%M").time()),
            created_at=now_ist(),
        ))

        _seed_status_logs(db)
        db.commit()
        print(f"Demo data seeded for {DEMO_DATE} Shift {SHIFT} — machine CN40")
        print("  Open: Hourly Output - 2026-06-23, Shift B")
    finally:
        db.close()


if __name__ == "__main__":
    run()
