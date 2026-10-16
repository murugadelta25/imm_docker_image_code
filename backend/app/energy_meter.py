"""Plant / panel energy meter live updates, shift A/B accounting, and trends."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from .models import (
    EnergyDailyRollup,
    EnergyMeter,
    EnergyMeterLive,
    EnergyMeterLoad,
    EnergyShiftSnapshot,
    ImmOpcuaLatest,
    Machine,
    now_ist,
)

# Live tag aliases from Node-RED / SIE
KWH_KEYS = ("Total_Active_Energy", "Energy_Shift_Kwh")
KVAH_KEYS = ("Total_Appearent_Energy", "Total_Apparent_Energy", "Energy_Shift_Kvah")
KVARH_KEYS = ("Total_Reactive_Energy", "Energy_Shift_Kvarh")
PF_KEYS = ("Energy_Power_Factor", "AveragePF")


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _latest_from_machine(db: Session, machine_id: int, keys: Tuple[str, ...]) -> Optional[float]:
    for key in keys:
        row = (
            db.query(ImmOpcuaLatest)
            .filter(ImmOpcuaLatest.machine_id == machine_id, ImmOpcuaLatest.param_key == key)
            .order_by(ImmOpcuaLatest.recorded_at.desc())
            .first()
        )
        if not row:
            continue
        n = _num(row.value_num if row.value_num is not None else row.value_text)
        if n is not None:
            return n
    return None


def _load_shifts() -> List[dict]:
    try:
        from .routers.config import _load_config
        cfg = _load_config()
        return [s for s in (cfg.get("shifts") or []) if s.get("enabled") is not False]
    except Exception:
        return [
            {"id": "A", "name": "Shift A", "start": "08:00", "end": "20:00", "enabled": True},
            {"id": "B", "name": "Shift B", "start": "20:00", "end": "08:00", "enabled": True},
        ]


def _parse_hhmm(hhmm: str) -> Tuple[int, int]:
    parts = str(hhmm or "00:00").split(":")
    return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0


def current_shift(now: Optional[datetime] = None) -> Tuple[date, dict, datetime, datetime]:
    """Return (shift_date, shift_dict, window_start, window_end) for now."""
    now = now or now_ist()
    shifts = _load_shifts()
    if not shifts:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        return now.date(), {"id": "A", "name": "Shift A", "start": "00:00", "end": "24:00"}, start, end

    for sh in shifts:
        sh_h, sh_m = _parse_hhmm(sh.get("start") or "00:00")
        eh, em = _parse_hhmm(sh.get("end") or "00:00")
        start = now.replace(hour=sh_h, minute=sh_m, second=0, microsecond=0)
        end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
        if end <= start:
            # overnight (e.g. 20:00–08:00)
            if now.time() >= start.time():
                end = end + timedelta(days=1)
            else:
                start = start - timedelta(days=1)
        if start <= now < end:
            shift_date = start.date()
            return shift_date, sh, start, end

    # fallback first shift
    sh = shifts[0]
    sh_h, sh_m = _parse_hhmm(sh.get("start") or "00:00")
    start = now.replace(hour=sh_h, minute=sh_m, second=0, microsecond=0)
    end = start + timedelta(hours=12)
    return start.date(), sh, start, end


def is_energy_utility_machine(machine: Optional[Machine] = None, *, name: str = "", machine_type: str = "") -> bool:
    """True for plant energy / utility tag hosts (not production IMMs)."""
    n = (name or (machine.name if machine else "") or "").strip().upper()
    t = (machine_type or (machine.machine_type if machine else "") or "").strip().upper()
    if t in ("ENERGY", "UTILITY", "METER"):
        return True
    if n.startswith("EM_") or n.startswith("PANEL-") or n == "EM_PLANT":
        return True
    return False


def production_machines_query(db: Session):
    """SQLAlchemy query for real production machines (excludes energy/utility hosts)."""
    q = db.query(Machine)
    # Filter in Python for dialect-safe name/type checks (small fleets)
    return q


def iter_production_machines(db: Session, order: bool = True) -> List[Machine]:
    q = db.query(Machine)
    if order:
        q = q.order_by(Machine.station_id, Machine.name, Machine.id)
    return [m for m in q.all() if not is_energy_utility_machine(m)]


def ensure_energy_source_machine(db: Session, name: str = "EM_PLANT") -> Machine:
    """
    Ensure a dedicated utility machine that holds plant energy meter tags.
    Not an IMM — used only as the Node-RED / OPC source for Energy Meter panels.
    """
    from .models import Station

    label = (name or "EM_PLANT").strip().upper() or "EM_PLANT"
    rows = (
        db.query(Machine)
        .filter(Machine.name.ilike(label))
        .order_by(Machine.id)
        .all()
    )
    if rows:
        keep = rows[0]
        if (keep.machine_type or "").upper() not in ("ENERGY", "UTILITY"):
            keep.machine_type = "ENERGY"
        # Collapse accidental duplicates (keep lowest id; retarget panel sources)
        for dup in rows[1:]:
            db.query(EnergyMeter).filter(EnergyMeter.source_machine_id == dup.id).update(
                {EnergyMeter.source_machine_id: keep.id}, synchronize_session=False
            )
            db.query(EnergyMeterLoad).filter(EnergyMeterLoad.machine_id == dup.id).update(
                {EnergyMeterLoad.machine_id: keep.id}, synchronize_session=False
            )
            db.delete(dup)
        db.flush()
        return keep

    station = db.query(Station).order_by(Station.id).first()
    if not station:
        station = Station(name="UTILITIES", display_name="Utilities")
        db.add(station)
        db.flush()

    m = Machine(
        name=label,
        station_id=station.id,
        machine_type="ENERGY",
        plc_source="opcua",
        status="idle",
        location="Plant energy meter",
    )
    db.add(m)
    db.flush()
    return m


def list_energy_source_options(db: Session) -> List[dict]:
    """
    Options for panel tag source dropdown.
    Energy/utility hosts (EM_PLANT) first, then production machines (optional remapping).
    """
    em = ensure_energy_source_machine(db, "EM_PLANT")
    ensure_default_panels(db)
    db.commit()

    energy_hosts = [
        m for m in db.query(Machine).order_by(Machine.id).all()
        if is_energy_utility_machine(m)
    ]
    production = iter_production_machines(db, order=True)
    out = []
    seen = set()
    for m in energy_hosts + production:
        if m.id in seen:
            continue
        seen.add(m.id)
        out.append({
            "id": m.id,
            "name": m.name,
            "machine_type": m.machine_type,
            "is_energy_source": is_energy_utility_machine(m),
        })
    # Guarantee EM_PLANT is first
    out.sort(key=lambda r: (0 if r["id"] == em.id else (1 if r["is_energy_source"] else 2), r["name"] or ""))
    return out


def ensure_default_panels(db: Session) -> List[EnergyMeter]:
    """Seed Panel-1..3; Panel-1 sources tags from EM_PLANT (not IMM machines)."""
    existing = {m.code: m for m in db.query(EnergyMeter).all()}
    if existing:
        # Always ensure EM_PLANT exists so the Energy dashboard source dropdown has it
        em = ensure_energy_source_machine(db, "EM_PLANT")
        panel1 = existing.get("PANEL-1")
        if panel1:
            if not panel1.source_machine_id:
                panel1.source_machine_id = em.id
            else:
                src = db.query(Machine).filter(Machine.id == panel1.source_machine_id).first()
                src_name = (src.name or "").upper() if src else ""
                if src_name in ("IMM17", "IMM18") or "IMM17" in src_name or "IMM18" in src_name:
                    panel1.source_machine_id = em.id
        db.commit()
        return list(existing.values())

    em = ensure_energy_source_machine(db, "EM_PLANT")
    source_id = em.id
    created = []
    for i, cat in enumerate((("machines", "Machines"), ("utilities", "Utilities"), ("mixed", "Mixed")), start=1):
        m = EnergyMeter(
            code=f"PANEL-{i}",
            name=f"Panel - {i}",
            panel_no=i,
            category=cat[0],
            source_machine_id=source_id if i == 1 else None,
            active=1,
            sort_order=i,
            notes=f"Default {cat[1]} energy panel",
        )
        db.add(m)
        created.append(m)
    db.flush()

    # Default: map Station-01 IMM machines onto Panel-1 (loads), excluding energy source / Plastech IMMs
    if created and source_id:
        machines = db.query(Machine).order_by(Machine.id).limit(10).all()
        for mac in machines:
            n = (mac.name or "").upper()
            if n in ("IMM17", "IMM18", "EM_PLANT") or (mac.machine_type or "").upper() == "ENERGY":
                continue
            db.add(
                EnergyMeterLoad(
                    meter_id=created[0].id,
                    load_type="machine",
                    machine_id=mac.id,
                    share_pct=100.0,
                    active=1,
                )
            )
    db.commit()
    return created


def _get_or_create_live(db: Session, meter_id: int) -> EnergyMeterLive:
    row = db.query(EnergyMeterLive).filter(EnergyMeterLive.meter_id == meter_id).first()
    if row:
        return row
    row = EnergyMeterLive(meter_id=meter_id)
    db.add(row)
    db.flush()
    return row


def apply_live_reading(
    db: Session,
    meter: EnergyMeter,
    *,
    kwh: Optional[float] = None,
    kvah: Optional[float] = None,
    kvarh: Optional[float] = None,
    pf: Optional[float] = None,
    i1: Optional[float] = None,
    i2: Optional[float] = None,
    i3: Optional[float] = None,
    v12: Optional[float] = None,
    v13: Optional[float] = None,
    v23: Optional[float] = None,
    v1n: Optional[float] = None,
    v2n: Optional[float] = None,
    v3n: Optional[float] = None,
) -> EnergyMeterLive:
    """Overwrite live row (retain previous fields when new value missing — device fail safe)."""
    live = _get_or_create_live(db, meter.id)
    now = now_ist()

    def set_if(attr: str, val: Optional[float]):
        if val is not None:
            setattr(live, attr, val)

    set_if("total_kwh", kwh)
    set_if("total_kvah", kvah)
    set_if("total_kvarh", kvarh)
    set_if("pf", pf)
    set_if("i1", i1)
    set_if("i2", i2)
    set_if("i3", i3)
    set_if("v12", v12)
    set_if("v13", v13)
    set_if("v23", v23)
    set_if("v1n", v1n)
    set_if("v2n", v2n)
    set_if("v3n", v3n)
    live.updated_at = now

    # Shift snapshot: a = start, b = latest overwrite, cons = b - a
    if live.total_kwh is not None or live.total_kvah is not None:
        _update_shift_snapshot(db, meter, live, now)

    db.flush()
    return live


def _update_shift_snapshot(db: Session, meter: EnergyMeter, live: EnergyMeterLive, now: datetime) -> EnergyShiftSnapshot:
    shift_date, sh, _start, _end = current_shift(now)
    sid = str(sh.get("id") or "A")
    snap = (
        db.query(EnergyShiftSnapshot)
        .filter(
            EnergyShiftSnapshot.meter_id == meter.id,
            EnergyShiftSnapshot.shift_date == shift_date,
            EnergyShiftSnapshot.shift_id == sid,
        )
        .first()
    )
    if not snap:
        snap = EnergyShiftSnapshot(
            meter_id=meter.id,
            shift_date=shift_date,
            shift_id=sid,
            shift_name=str(sh.get("name") or sid),
            start_kwh=live.total_kwh,
            start_kvah=live.total_kvah,
            start_kvarh=live.total_kvarh,
            start_pf=live.pf,
            start_at=now,
        )
        db.add(snap)

    # Never wipe start once set; only fill if still null
    if snap.start_kwh is None and live.total_kwh is not None:
        snap.start_kwh = live.total_kwh
        snap.start_at = now
    if snap.start_kvah is None and live.total_kvah is not None:
        snap.start_kvah = live.total_kvah
    if snap.start_kvarh is None and live.total_kvarh is not None:
        snap.start_kvarh = live.total_kvarh
    if snap.start_pf is None and live.pf is not None:
        snap.start_pf = live.pf

    # Overwrite variable b with latest (retain previous if live field missing)
    if live.total_kwh is not None:
        snap.latest_kwh = live.total_kwh
    if live.total_kvah is not None:
        snap.latest_kvah = live.total_kvah
    if live.total_kvarh is not None:
        snap.latest_kvarh = live.total_kvarh
    if live.pf is not None:
        snap.latest_pf = live.pf
    snap.latest_at = now

    def cons(latest, start):
        if latest is None or start is None:
            return 0.0
        return max(0.0, float(latest) - float(start))

    snap.cons_kwh = cons(snap.latest_kwh, snap.start_kwh)
    snap.cons_kvah = cons(snap.latest_kvah, snap.start_kvah)
    snap.cons_kvarh = cons(snap.latest_kvarh, snap.start_kvarh)
    snap.updated_at = now

    _upsert_daily_rollup(db, meter.id, shift_date)
    return snap


def _upsert_daily_rollup(db: Session, meter_id: int, day: date) -> None:
    rows = (
        db.query(EnergyShiftSnapshot)
        .filter(EnergyShiftSnapshot.meter_id == meter_id, EnergyShiftSnapshot.shift_date == day)
        .all()
    )
    kwh = sum(float(r.cons_kwh or 0) for r in rows)
    kvah = sum(float(r.cons_kvah or 0) for r in rows)
    kvarh = sum(float(r.cons_kvarh or 0) for r in rows)
    pfs = [float(r.latest_pf) for r in rows if r.latest_pf is not None]
    pf_avg = (sum(pfs) / len(pfs)) if pfs else None

    roll = (
        db.query(EnergyDailyRollup)
        .filter(EnergyDailyRollup.meter_id == meter_id, EnergyDailyRollup.day == day)
        .first()
    )
    if not roll:
        roll = EnergyDailyRollup(meter_id=meter_id, day=day)
        db.add(roll)
    roll.kwh = kwh
    roll.kvah = kvah
    roll.kvarh = kvarh
    roll.pf_avg = pf_avg
    # kWh/Kg when kg known (optional — filled later from production)
    if roll.kg and roll.kg > 0:
        roll.kwh_per_kg = round(kwh / float(roll.kg), 4)
    roll.updated_at = now_ist()


def sync_meter_from_source_machine(db: Session, meter: EnergyMeter) -> Optional[EnergyMeterLive]:
    """Pull latest ImmOpcuaLatest tags from the meter's source machine into live+shift."""
    if not meter.source_machine_id:
        return None
    mid = meter.source_machine_id
    return apply_live_reading(
        db,
        meter,
        kwh=_latest_from_machine(db, mid, KWH_KEYS),
        kvah=_latest_from_machine(db, mid, KVAH_KEYS),
        kvarh=_latest_from_machine(db, mid, KVARH_KEYS),
        pf=_latest_from_machine(db, mid, PF_KEYS),
        i1=_latest_from_machine(db, mid, ("Energy_Current_I1", "Current_I1")),
        i2=_latest_from_machine(db, mid, ("Energy_Current_I2", "Current_I2")),
        i3=_latest_from_machine(db, mid, ("Energy_Current_I3", "Current_I3")),
        v12=_latest_from_machine(db, mid, ("Energy_Voltage_V12", "Voltage_V1toV2")),
        v13=_latest_from_machine(db, mid, ("Energy_Voltage_V13", "Voltage_V1toV3")),
        v23=_latest_from_machine(db, mid, ("Energy_Voltage_V23", "Voltage_V2toV3")),
        v1n=_latest_from_machine(db, mid, ("Energy_Voltage_V1N", "Voltage_V1toN")),
        v2n=_latest_from_machine(db, mid, ("Energy_Voltage_V2N", "Voltage_V2toN")),
        v3n=_latest_from_machine(db, mid, ("Energy_Voltage_V3N", "Voltage_V3toN")),
    )


def sync_energy_from_machine_ingest(db: Session, machine_id: int, params: Dict[str, Any]) -> None:
    """Called after Node-RED ingest — update any meter that sources this machine."""
    meters = (
        db.query(EnergyMeter)
        .filter(EnergyMeter.active == 1, EnergyMeter.source_machine_id == machine_id)
        .all()
    )
    if not meters:
        # Fallback: attach Panel-1 to this energy source (typically EM_PLANT)
        ensure_default_panels(db)
        panel1 = db.query(EnergyMeter).filter(EnergyMeter.code == "PANEL-1").first()
        if panel1 and (
            not panel1.source_machine_id or panel1.source_machine_id == machine_id
        ):
            panel1.source_machine_id = machine_id
            meters = [panel1]
        else:
            return

    def pick(*keys):
        for k in keys:
            if k in params and params[k] not in (None, ""):
                return _num(params[k])
        return None

    for meter in meters:
        apply_live_reading(
            db,
            meter,
            kwh=pick(*KWH_KEYS),
            kvah=pick(*KVAH_KEYS),
            kvarh=pick(*KVARH_KEYS),
            pf=pick(*PF_KEYS),
            i1=pick("Energy_Current_I1", "Current_I1"),
            i2=pick("Energy_Current_I2", "Current_I2"),
            i3=pick("Energy_Current_I3", "Current_I3"),
            v12=pick("Energy_Voltage_V12", "Voltage_V1toV2"),
            v13=pick("Energy_Voltage_V13", "Voltage_V1toV3"),
            v23=pick("Energy_Voltage_V23", "Voltage_V2toV3"),
            v1n=pick("Energy_Voltage_V1N", "Voltage_V1toN"),
            v2n=pick("Energy_Voltage_V2N", "Voltage_V2toN"),
            v3n=pick("Energy_Voltage_V3N", "Voltage_V3toN"),
        )
    db.commit()


def _serialize_load(db: Session, load: EnergyMeterLoad) -> dict:
    mac = None
    if load.machine_id:
        mac = db.query(Machine).filter(Machine.id == load.machine_id).first()
    return {
        "id": load.id,
        "meter_id": load.meter_id,
        "load_type": load.load_type,
        "machine_id": load.machine_id,
        "machine_name": mac.name if mac else None,
        "utility_name": load.utility_name,
        "utility_kind": load.utility_kind,
        "share_pct": load.share_pct,
        "active": bool(load.active),
    }


def _panel_payload(db: Session, meter: EnergyMeter, snap: Optional[EnergyShiftSnapshot]) -> dict:
    live = db.query(EnergyMeterLive).filter(EnergyMeterLive.meter_id == meter.id).first()
    loads = (
        db.query(EnergyMeterLoad)
        .filter(EnergyMeterLoad.meter_id == meter.id, EnergyMeterLoad.active == 1)
        .all()
    )
    return {
        "id": meter.id,
        "code": meter.code,
        "name": meter.name,
        "panel_no": meter.panel_no,
        "category": meter.category,
        "source_machine_id": meter.source_machine_id,
        "kwh": float(snap.cons_kwh or 0) if snap else 0.0,
        "kvah": float(snap.cons_kvah or 0) if snap else 0.0,
        "kvarh": float(snap.cons_kvarh or 0) if snap else 0.0,
        "pf": float(live.pf) if live and live.pf is not None else (float(snap.latest_pf) if snap and snap.latest_pf is not None else None),
        "total_kwh": float(live.total_kwh) if live and live.total_kwh is not None else None,
        "total_kvah": float(live.total_kvah) if live and live.total_kvah is not None else None,
        "total_kvarh": float(live.total_kvarh) if live and live.total_kvarh is not None else None,
        "ampere": {
            "R": live.i1 if live else None,
            "Y": live.i2 if live else None,
            "B": live.i3 if live else None,
        },
        "phase_to_phase": {
            "R": live.v12 if live else None,
            "Y": live.v13 if live else None,
            "B": live.v23 if live else None,
        },
        "phase_to_neutral": {
            "R": live.v1n if live else None,
            "Y": live.v2n if live else None,
            "B": live.v3n if live else None,
        },
        "updated_at": live.updated_at.isoformat() if live and live.updated_at else None,
        "loads": [_serialize_load(db, x) for x in loads],
    }


def _active_meters(db: Session) -> List[EnergyMeter]:
    ensure_default_panels(db)
    return (
        db.query(EnergyMeter)
        .filter(EnergyMeter.active == 1)
        .order_by(EnergyMeter.sort_order, EnergyMeter.panel_no)
        .all()
    )


def _plant_split(meter: EnergyMeter, loads: List[dict], kwh: float) -> Tuple[float, float]:
    """Return (machines_kwh, utilities_kwh) contribution for one panel."""
    has_machine = any(x.get("load_type") == "machine" for x in loads)
    has_utility = any(x.get("load_type") == "utility" for x in loads)
    if meter.category == "utilities" or (has_utility and not has_machine):
        return 0.0, kwh
    return kwh, 0.0


def next_panel_defaults(db: Session) -> dict:
    """Suggest code/name/panel_no for a new panel."""
    ensure_default_panels(db)
    meters = db.query(EnergyMeter).all()
    max_no = max([int(m.panel_no or 0) for m in meters] + [0])
    n = max_no + 1
    while db.query(EnergyMeter).filter(EnergyMeter.code == f"PANEL-{n}").first():
        n += 1
    return {"panel_no": n, "code": f"PANEL-{n}", "name": f"Panel - {n}", "category": "mixed"}


def dashboard_payload(db: Session) -> dict:
    meters = _active_meters(db)
    for m in meters:
        try:
            sync_meter_from_source_machine(db, m)
        except Exception:
            pass
    db.commit()

    shift_date, sh, start, end = current_shift()
    sid = str(sh.get("id") or "A")
    panels = []
    plant_kwh = plant_kvah = plant_mc = plant_util = 0.0

    for m in meters:
        snap = (
            db.query(EnergyShiftSnapshot)
            .filter(
                EnergyShiftSnapshot.meter_id == m.id,
                EnergyShiftSnapshot.shift_date == shift_date,
                EnergyShiftSnapshot.shift_id == sid,
            )
            .first()
        )
        panel = _panel_payload(db, m, snap)
        panels.append(panel)
        kwh = float(panel["kwh"] or 0)
        kvah = float(panel["kvah"] or 0)
        plant_kwh += kwh
        plant_kvah += kvah
        mc, util = _plant_split(m, panel["loads"], kwh)
        plant_mc += mc
        plant_util += util

    return {
        "mode": "live",
        "shift": {
            "id": sid,
            "name": sh.get("name"),
            "date": shift_date.isoformat(),
            "start": start.strftime("%H:%M"),
            "end": end.strftime("%H:%M"),
        },
        "range": {
            "from": shift_date.isoformat(),
            "to": shift_date.isoformat(),
            "preset": "live",
        },
        "plant": {
            "kwh": round(plant_kwh, 3),
            "kvah": round(plant_kvah, 3),
            "machines_kwh": round(plant_mc, 3),
            "utilities_kwh": round(plant_util, 3),
        },
        "panels": panels,
    }


def resolve_historic_range(
    preset: str,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
) -> Tuple[date, date, str]:
    """
    preset: yesterday | last_3_days | week | custom | month
    month: YYYY-MM
    """
    today = now_ist().date()
    p = (preset or "yesterday").lower().strip()

    if p == "month" or month:
        key = (month or date_from or today.strftime("%Y-%m")).strip()
        try:
            y, m = int(key[:4]), int(key[5:7])
            start = date(y, m, 1)
            if m == 12:
                end = date(y, 12, 31)
            else:
                end = date(y, m + 1, 1) - timedelta(days=1)
            return start, end, "month"
        except (TypeError, ValueError):
            raise ValueError("month must be YYYY-MM")

    if p == "yesterday":
        d = today - timedelta(days=1)
        return d, d, "yesterday"

    if p in ("last_3_days", "3days", "prev_3_days"):
        end = today - timedelta(days=1)
        start = end - timedelta(days=2)
        return start, end, "last_3_days"

    if p in ("week", "last_7_days"):
        end = today - timedelta(days=1)
        start = end - timedelta(days=6)
        return start, end, "week"

    # custom
    try:
        start = date.fromisoformat((date_from or (today - timedelta(days=1)).isoformat())[:10])
        end = date.fromisoformat((date_to or date_from or start.isoformat())[:10])
    except ValueError as exc:
        raise ValueError("date_from/date_to must be YYYY-MM-DD") from exc
    if end < start:
        start, end = end, start
    if (end - start).days > 366:
        end = start + timedelta(days=366)
    return start, end, "custom"


def historic_dashboard_payload(
    db: Session,
    *,
    preset: str = "yesterday",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
) -> dict:
    """Aggregate panel kWh/kVAh/PF from daily rollups for a historic range."""
    start, end, resolved = resolve_historic_range(preset, date_from, date_to, month)
    meters = _active_meters(db)

    rows = (
        db.query(EnergyDailyRollup)
        .filter(EnergyDailyRollup.day >= start, EnergyDailyRollup.day <= end)
        .all()
    )
    by_meter: Dict[int, List[EnergyDailyRollup]] = {}
    for r in rows:
        by_meter.setdefault(r.meter_id, []).append(r)

    panels = []
    plant_kwh = plant_kvah = plant_mc = plant_util = 0.0

    for m in meters:
        group = by_meter.get(m.id, [])
        kwh = round(sum(float(x.kwh or 0) for x in group), 3)
        kvah = round(sum(float(x.kvah or 0) for x in group), 3)
        kvarh = round(sum(float(x.kvarh or 0) for x in group), 3)
        pfs = [float(x.pf_avg) for x in group if x.pf_avg is not None]
        pf = round(sum(pfs) / len(pfs), 4) if pfs else None
        loads = (
            db.query(EnergyMeterLoad)
            .filter(EnergyMeterLoad.meter_id == m.id, EnergyMeterLoad.active == 1)
            .all()
        )
        load_rows = [_serialize_load(db, x) for x in loads]
        panel = {
            "id": m.id,
            "code": m.code,
            "name": m.name,
            "panel_no": m.panel_no,
            "category": m.category,
            "source_machine_id": m.source_machine_id,
            "kwh": kwh,
            "kvah": kvah,
            "kvarh": kvarh,
            "pf": pf,
            "total_kwh": None,
            "total_kvah": None,
            "total_kvarh": None,
            "ampere": {"R": None, "Y": None, "B": None},
            "phase_to_phase": {"R": None, "Y": None, "B": None},
            "phase_to_neutral": {"R": None, "Y": None, "B": None},
            "updated_at": None,
            "loads": load_rows,
            "historic": True,
            "days_with_data": len(group),
        }
        panels.append(panel)
        plant_kwh += kwh
        plant_kvah += kvah
        mc, util = _plant_split(m, load_rows, kwh)
        plant_mc += mc
        plant_util += util

    return {
        "mode": "historic",
        "shift": None,
        "range": {
            "from": start.isoformat(),
            "to": end.isoformat(),
            "preset": resolved,
        },
        "plant": {
            "kwh": round(plant_kwh, 3),
            "kvah": round(plant_kvah, 3),
            "machines_kwh": round(plant_mc, 3),
            "utilities_kwh": round(plant_util, 3),
        },
        "panels": panels,
    }


def trend_series(
    db: Session,
    metric: str,
    period: str = "daily",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> dict:
    """metric: kwh|kvah|pf|kwh_per_kg; period: daily|weekly|monthly or explicit dates."""
    ensure_default_panels(db)
    today = now_ist().date()

    if date_from or date_to:
        start, end, _ = resolve_historic_range("custom", date_from, date_to or date_from, None)
    elif period == "weekly":
        end = today
        start = today - timedelta(days=7)
    elif period == "monthly":
        end = today
        start = today - timedelta(days=30)
    else:
        end = today
        start = today - timedelta(days=19)

    rows = (
        db.query(EnergyDailyRollup)
        .filter(EnergyDailyRollup.day >= start, EnergyDailyRollup.day <= end)
        .all()
    )
    by_day: Dict[date, List[EnergyDailyRollup]] = {}
    for r in rows:
        by_day.setdefault(r.day, []).append(r)

    points = []
    d = start
    while d <= end:
        group = by_day.get(d, [])
        if metric == "kvah":
            val = sum(float(x.kvah or 0) for x in group)
        elif metric == "pf":
            pfs = [float(x.pf_avg) for x in group if x.pf_avg is not None]
            val = round(sum(pfs) / len(pfs), 4) if pfs else None
        elif metric == "kwh_per_kg":
            vals = [float(x.kwh_per_kg) for x in group if x.kwh_per_kg is not None]
            val = round(sum(vals) / len(vals), 4) if vals else None
        else:
            val = sum(float(x.kwh or 0) for x in group)
        points.append({"t": d.isoformat(), "v": val})
        d += timedelta(days=1)

    return {
        "metric": metric,
        "period": period,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "points": points,
    }


_MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def monthwise_summary(
    db: Session,
    fiscal_year: Optional[int] = None,
    fiscal_start_month: int = 4,
) -> dict:
    """
    Monthwise energy for all panels (sum of daily rollups).
    Fiscal year label uses start year: FY 2026 = Apr-2026 … Mar-2027 when start_month=4.
    """
    ensure_default_panels(db)
    today = now_ist().date()
    fsm = max(1, min(12, int(fiscal_start_month or 4)))

    if fiscal_year is None:
        # Current FY: if before fiscal start month, FY started previous calendar year
        fiscal_year = today.year if today.month >= fsm else today.year - 1
    else:
        fiscal_year = int(fiscal_year)

    start = date(fiscal_year, fsm, 1)
    # End = day before next FY start
    if fsm == 1:
        end = date(fiscal_year, 12, 31)
        end_year = fiscal_year
    else:
        end_year = fiscal_year + 1
        end_month = fsm - 1
        # last day of end_month
        if end_month == 12:
            end = date(end_year, 12, 31)
        else:
            end = date(end_year, end_month + 1, 1) - timedelta(days=1)

    meters = (
        db.query(EnergyMeter)
        .filter(EnergyMeter.active == 1)
        .order_by(EnergyMeter.sort_order, EnergyMeter.panel_no)
        .all()
    )

    rows = (
        db.query(EnergyDailyRollup)
        .filter(EnergyDailyRollup.day >= start, EnergyDailyRollup.day <= end)
        .all()
    )

    # (year, month) -> meter_id -> kwh
    by_ym: Dict[Tuple[int, int], Dict[int, float]] = {}
    for r in rows:
        key = (r.day.year, r.day.month)
        bucket = by_ym.setdefault(key, {})
        bucket[r.meter_id] = bucket.get(r.meter_id, 0.0) + float(r.kwh or 0)

    months_out = []
    ytd = 0.0
    ytd_dg = 0.0
    cursor = date(start.year, start.month, 1)
    last = date(end.year, end.month, 1)
    while cursor <= last:
        ym = (cursor.year, cursor.month)
        panel_map = by_ym.get(ym, {})
        panel_rows = []
        month_kwh = 0.0
        for m in meters:
            kwh = round(float(panel_map.get(m.id, 0.0)), 3)
            month_kwh += kwh
            panel_rows.append({
                "meter_id": m.id,
                "code": m.code,
                "name": m.name,
                "panel_no": m.panel_no,
                "kwh": kwh,
            })
        month_kwh = round(month_kwh, 3)
        ytd = round(ytd + month_kwh, 3)
        month_dg = 0.0  # reserved — DG hours not yet instrumented
        ytd_dg = round(ytd_dg + month_dg, 4)
        months_out.append({
            "month": f"{_MONTH_ABBR[cursor.month - 1]}-{cursor.year}",
            "month_key": f"{cursor.year:04d}-{cursor.month:02d}",
            "month_kwh": month_kwh,
            "ytd_kwh": ytd,
            "month_dg_hrs": month_dg,
            "ytd_dg_hrs": ytd_dg,
            "panels": panel_rows,
        })
        # next month
        if cursor.month == 12:
            cursor = date(cursor.year + 1, 1, 1)
        else:
            cursor = date(cursor.year, cursor.month + 1, 1)

    fy_label = f"{fiscal_year}-{str(end_year)[-2:]}" if fsm != 1 else str(fiscal_year)
    return {
        "title": "Monthwise Energy Consumption Summary",
        "fiscal_year": fiscal_year,
        "fiscal_year_label": fy_label,
        "fiscal_start_month": fsm,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "panels": [{"id": m.id, "code": m.code, "name": m.name, "panel_no": m.panel_no} for m in meters],
        "months": months_out,
    }


def build_monthwise_xlsx(payload: dict) -> bytes:
    """Excel workbook: plant summary + per-panel monthly kWh."""
    import io
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Plant Summary"
    header_fill = PatternFill("solid", fgColor="4472C4")
    header_font = Font(bold=True, color="FFFFFF")
    title_font = Font(bold=True, size=14, color="2F5496")

    ws.merge_cells("A1:E1")
    ws["A1"] = payload.get("title") or "Monthwise Energy Consumption Summary"
    ws["A1"].font = title_font
    ws["A1"].alignment = Alignment(horizontal="center")
    ws.merge_cells("A2:E2")
    ws["A2"] = f"Fiscal Year {payload.get('fiscal_year_label')}  ({payload.get('from')} → {payload.get('to')})"
    ws["A2"].alignment = Alignment(horizontal="center")

    headers = ["Month", "Month's KWH", "YTD KWH", "Month's DG Run (Hrs.)", "YTD DG Run (Hrs.)"]
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=4, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    for i, row in enumerate(payload.get("months") or [], start=5):
        ws.cell(row=i, column=1, value=row.get("month"))
        ws.cell(row=i, column=2, value=float(row.get("month_kwh") or 0))
        ws.cell(row=i, column=3, value=float(row.get("ytd_kwh") or 0))
        ws.cell(row=i, column=4, value=float(row.get("month_dg_hrs") or 0))
        ws.cell(row=i, column=5, value=float(row.get("ytd_dg_hrs") or 0))

    for col, w in enumerate((14, 16, 14, 22, 20), 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = w

    # Per-panel sheet
    panels = payload.get("panels") or []
    ws2 = wb.create_sheet("By Panel")
    ws2["A1"] = "Panel-wise Monthly KWH"
    ws2["A1"].font = title_font
    panel_headers = ["Month"] + [p.get("name") or p.get("code") for p in panels] + ["Total KWH", "YTD KWH"]
    for col, h in enumerate(panel_headers, 1):
        cell = ws2.cell(row=3, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font

    for i, row in enumerate(payload.get("months") or [], start=4):
        ws2.cell(row=i, column=1, value=row.get("month"))
        panel_lookup = {p["meter_id"]: p for p in (row.get("panels") or [])}
        for j, p in enumerate(panels):
            ws2.cell(row=i, column=2 + j, value=float(panel_lookup.get(p["id"], {}).get("kwh") or 0))
        ws2.cell(row=i, column=2 + len(panels), value=float(row.get("month_kwh") or 0))
        ws2.cell(row=i, column=3 + len(panels), value=float(row.get("ytd_kwh") or 0))

    for col in range(1, len(panel_headers) + 1):
        ws2.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 14

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def historic_range_report(
    db: Session,
    *,
    preset: str = "yesterday",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    month: Optional[str] = None,
) -> dict:
    """Historic dashboard totals + daily per-panel breakdown for Excel export."""
    summary = historic_dashboard_payload(
        db, preset=preset, date_from=date_from, date_to=date_to, month=month
    )
    start = date.fromisoformat(summary["range"]["from"])
    end = date.fromisoformat(summary["range"]["to"])
    meters = _active_meters(db)

    rows = (
        db.query(EnergyDailyRollup)
        .filter(EnergyDailyRollup.day >= start, EnergyDailyRollup.day <= end)
        .all()
    )
    # day -> meter_id -> rollup
    by_day: Dict[date, Dict[int, EnergyDailyRollup]] = {}
    for r in rows:
        by_day.setdefault(r.day, {})[r.meter_id] = r

    daily = []
    d = start
    while d <= end:
        panel_cells = []
        day_kwh = day_kvah = 0.0
        pfs = []
        for m in meters:
            r = by_day.get(d, {}).get(m.id)
            kwh = float(r.kwh or 0) if r else 0.0
            kvah = float(r.kvah or 0) if r else 0.0
            pf = float(r.pf_avg) if r and r.pf_avg is not None else None
            day_kwh += kwh
            day_kvah += kvah
            if pf is not None:
                pfs.append(pf)
            panel_cells.append({
                "meter_id": m.id,
                "code": m.code,
                "name": m.name,
                "kwh": round(kwh, 3),
                "kvah": round(kvah, 3),
                "pf": pf,
            })
        daily.append({
            "day": d.isoformat(),
            "kwh": round(day_kwh, 3),
            "kvah": round(day_kvah, 3),
            "pf": round(sum(pfs) / len(pfs), 4) if pfs else None,
            "panels": panel_cells,
        })
        d += timedelta(days=1)

    return {
        **summary,
        "title": "Energy Meter Historic Report",
        "daily": daily,
        "panel_meta": [
            {"id": m.id, "code": m.code, "name": m.name, "panel_no": m.panel_no} for m in meters
        ],
    }


def build_historic_xlsx(payload: dict) -> bytes:
    """Excel: plant/panel period totals + daily kWh by panel."""
    import io
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = openpyxl.Workbook()
    header_fill = PatternFill("solid", fgColor="0D9488")
    header_font = Font(bold=True, color="FFFFFF")
    title_font = Font(bold=True, size=14, color="0F766E")

    # Sheet 1 — period summary
    ws = wb.active
    ws.title = "Period Summary"
    rng = payload.get("range") or {}
    plant = payload.get("plant") or {}
    ws.merge_cells("A1:D1")
    ws["A1"] = payload.get("title") or "Energy Meter Historic Report"
    ws["A1"].font = title_font
    ws["A1"].alignment = Alignment(horizontal="center")
    ws.merge_cells("A2:D2")
    ws["A2"] = (
        f"Preset: {rng.get('preset')}  ·  {rng.get('from')} → {rng.get('to')}"
    )
    ws["A2"].alignment = Alignment(horizontal="center")

    ws["A4"] = "Plant KWH"
    ws["B4"] = float(plant.get("kwh") or 0)
    ws["A5"] = "Plant KVAH"
    ws["B5"] = float(plant.get("kvah") or 0)
    ws["A6"] = "Plant Mc's KWH"
    ws["B6"] = float(plant.get("machines_kwh") or 0)
    ws["A7"] = "Plant Utilities KWH"
    ws["B7"] = float(plant.get("utilities_kwh") or 0)

    headers = ["Panel", "Code", "KWH", "KVAH", "PF", "Days with data"]
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=9, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
    for i, p in enumerate(payload.get("panels") or [], start=10):
        ws.cell(row=i, column=1, value=p.get("name"))
        ws.cell(row=i, column=2, value=p.get("code"))
        ws.cell(row=i, column=3, value=float(p.get("kwh") or 0))
        ws.cell(row=i, column=4, value=float(p.get("kvah") or 0))
        pf = p.get("pf")
        ws.cell(row=i, column=5, value=float(pf) if pf is not None else None)
        ws.cell(row=i, column=6, value=int(p.get("days_with_data") or 0))

    for col, w in enumerate((16, 12, 12, 12, 10, 14), 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = w

    # Sheet 2 — daily plant totals
    ws2 = wb.create_sheet("Daily Plant")
    ws2["A1"] = "Daily plant totals"
    ws2["A1"].font = title_font
    for col, h in enumerate(["Date", "KWH", "KVAH", "PF"], 1):
        cell = ws2.cell(row=3, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
    for i, row in enumerate(payload.get("daily") or [], start=4):
        ws2.cell(row=i, column=1, value=row.get("day"))
        ws2.cell(row=i, column=2, value=float(row.get("kwh") or 0))
        ws2.cell(row=i, column=3, value=float(row.get("kvah") or 0))
        pf = row.get("pf")
        ws2.cell(row=i, column=4, value=float(pf) if pf is not None else None)
    for col, w in enumerate((14, 12, 12, 10), 1):
        ws2.column_dimensions[openpyxl.utils.get_column_letter(col)].width = w

    # Sheet 3 — daily by panel (kWh)
    panels = payload.get("panel_meta") or []
    ws3 = wb.create_sheet("Daily By Panel KWH")
    ws3["A1"] = "Daily kWh by panel"
    ws3["A1"].font = title_font
    hdr = ["Date"] + [p.get("name") or p.get("code") for p in panels] + ["Total KWH"]
    for col, h in enumerate(hdr, 1):
        cell = ws3.cell(row=3, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
    for i, row in enumerate(payload.get("daily") or [], start=4):
        ws3.cell(row=i, column=1, value=row.get("day"))
        lookup = {x["meter_id"]: x for x in (row.get("panels") or [])}
        for j, p in enumerate(panels):
            ws3.cell(row=i, column=2 + j, value=float(lookup.get(p["id"], {}).get("kwh") or 0))
        ws3.cell(row=i, column=2 + len(panels), value=float(row.get("kwh") or 0))
    for col in range(1, len(hdr) + 1):
        ws3.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 14

    # Sheet 4 — daily by panel (kVAh)
    ws4 = wb.create_sheet("Daily By Panel KVAH")
    ws4["A1"] = "Daily kVAh by panel"
    ws4["A1"].font = title_font
    hdr4 = ["Date"] + [p.get("name") or p.get("code") for p in panels] + ["Total KVAH"]
    for col, h in enumerate(hdr4, 1):
        cell = ws4.cell(row=3, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
    for i, row in enumerate(payload.get("daily") or [], start=4):
        ws4.cell(row=i, column=1, value=row.get("day"))
        lookup = {x["meter_id"]: x for x in (row.get("panels") or [])}
        for j, p in enumerate(panels):
            ws4.cell(row=i, column=2 + j, value=float(lookup.get(p["id"], {}).get("kvah") or 0))
        ws4.cell(row=i, column=2 + len(panels), value=float(row.get("kvah") or 0))
    for col in range(1, len(hdr4) + 1):
        ws4.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 14

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
