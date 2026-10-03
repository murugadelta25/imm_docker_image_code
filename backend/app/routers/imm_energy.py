"""Energy Meter dashboard APIs — panels, mapping, shift consumption, trends."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..energy_meter import (
    build_historic_xlsx,
    build_monthwise_xlsx,
    dashboard_payload,
    ensure_default_panels,
    ensure_energy_source_machine,
    historic_dashboard_payload,
    historic_range_report,
    list_energy_source_options,
    monthwise_summary,
    next_panel_defaults,
    sync_meter_from_source_machine,
    trend_series,
)
from ..models import (
    EnergyDailyRollup,
    EnergyMeter,
    EnergyMeterLive,
    EnergyMeterLoad,
    EnergyShiftSnapshot,
    Machine,
    get_db,
)

router = APIRouter(prefix="/api/imm/energy", tags=["imm-energy"])


class LoadIn(BaseModel):
    load_type: str = Field(..., description="machine | utility")
    machine_id: Optional[int] = None
    utility_name: Optional[str] = None
    utility_kind: Optional[str] = None
    # Optional; ignored — shares are split evenly across mapped loads
    share_pct: Optional[float] = None


class MeterPatch(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    source_machine_id: Optional[int] = None
    active: Optional[bool] = None
    sort_order: Optional[int] = None
    notes: Optional[str] = None
    panel_no: Optional[int] = None


class MeterCreate(BaseModel):
    code: Optional[str] = None
    name: Optional[str] = None
    panel_no: Optional[int] = None
    category: str = "mixed"
    source_machine_id: Optional[int] = None


@router.get("/dashboard")
def energy_dashboard(
    mode: str = Query("live", description="live | historic"),
    preset: str = Query("yesterday", description="yesterday | last_3_days | week | custom | month"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    month: Optional[str] = Query(None, description="YYYY-MM for month preset"),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    mode = (mode or "live").lower()
    if mode == "historic":
        try:
            return historic_dashboard_payload(
                db, preset=preset, date_from=date_from, date_to=date_to, month=month
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    return dashboard_payload(db)


@router.get("/trends/{metric}")
def energy_trends(
    metric: str,
    period: str = "daily",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    metric = (metric or "kwh").lower()
    if metric not in ("kwh", "kvah", "pf", "kwh_per_kg"):
        raise HTTPException(400, "metric must be kwh|kvah|pf|kwh_per_kg")
    period = (period or "daily").lower()
    if period not in ("daily", "weekly", "monthly") and not (date_from or date_to):
        raise HTTPException(400, "period must be daily|weekly|monthly (or pass date_from/date_to)")
    try:
        return trend_series(db, metric, period, date_from=date_from, date_to=date_to)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/sources")
def list_energy_sources(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """
    Dropdown options for panel 'Source (Node-RED energy stream)'.
    Ensures EM_PLANT utility machine exists (auto-created; not set in Node-RED fleet map).
    """
    sources = list_energy_source_options(db)
    em = ensure_energy_source_machine(db, "EM_PLANT")
    return {
        "sources": sources,
        "default_source_id": em.id,
        "default_source_name": em.name,
        "hint": "Select EM_PLANT for plant energy meter tags from Node-RED. Map loads separately below.",
    }


@router.get("/meters")
def list_meters(db: Session = Depends(get_db), _=Depends(get_current_user)):
    ensure_default_panels(db)
    ensure_energy_source_machine(db, "EM_PLANT")
    db.commit()
    meters = db.query(EnergyMeter).order_by(EnergyMeter.sort_order, EnergyMeter.panel_no).all()
    out = []
    for m in meters:
        loads = db.query(EnergyMeterLoad).filter(EnergyMeterLoad.meter_id == m.id).all()
        out.append({
            "id": m.id,
            "code": m.code,
            "name": m.name,
            "panel_no": m.panel_no,
            "category": m.category,
            "source_machine_id": m.source_machine_id,
            "active": bool(m.active),
            "sort_order": m.sort_order,
            "notes": m.notes,
            "load_count": len(loads),
        })
    return {"meters": out}


@router.get("/meters/next-defaults")
def meter_next_defaults(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return next_panel_defaults(db)


@router.post("/meters")
def create_meter(
    body: MeterCreate,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    defaults = next_panel_defaults(db)
    panel_no = int(body.panel_no or defaults["panel_no"])
    code = (body.code or defaults["code"]).strip().upper()
    name = (body.name or defaults["name"]).strip()
    if db.query(EnergyMeter).filter(EnergyMeter.code == code).first():
        raise HTTPException(400, f"Meter code already exists: {code}")
    m = EnergyMeter(
        code=code,
        name=name,
        panel_no=panel_no,
        category=body.category or "mixed",
        source_machine_id=body.source_machine_id,
        active=1,
        sort_order=panel_no,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return {"ok": True, "id": m.id, "code": m.code, "name": m.name, "panel_no": m.panel_no}


@router.patch("/meters/{meter_id}")
def patch_meter(
    meter_id: int,
    body: MeterPatch,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    m = db.query(EnergyMeter).filter(EnergyMeter.id == meter_id).first()
    if not m:
        raise HTTPException(404, "Meter not found")
    if body.name is not None:
        m.name = body.name.strip()
    if body.category is not None:
        m.category = body.category
    if body.source_machine_id is not None:
        m.source_machine_id = body.source_machine_id or None
    if body.active is not None:
        m.active = 1 if body.active else 0
    if body.sort_order is not None:
        m.sort_order = body.sort_order
    if body.panel_no is not None:
        m.panel_no = body.panel_no
    if body.notes is not None:
        m.notes = body.notes
    db.commit()
    return {"ok": True}


@router.delete("/meters/{meter_id}")
def delete_meter(
    meter_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    """Permanently delete a panel and its live/shift/daily/load rows."""
    m = db.query(EnergyMeter).filter(EnergyMeter.id == meter_id).first()
    if not m:
        raise HTTPException(404, "Meter not found")
    db.query(EnergyMeterLoad).filter(EnergyMeterLoad.meter_id == meter_id).delete()
    db.query(EnergyMeterLive).filter(EnergyMeterLive.meter_id == meter_id).delete()
    db.query(EnergyShiftSnapshot).filter(EnergyShiftSnapshot.meter_id == meter_id).delete()
    db.query(EnergyDailyRollup).filter(EnergyDailyRollup.meter_id == meter_id).delete()
    db.delete(m)
    db.commit()
    return {"ok": True, "deleted_id": meter_id}


@router.get("/meters/{meter_id}/loads")
def list_loads(meter_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    m = db.query(EnergyMeter).filter(EnergyMeter.id == meter_id).first()
    if not m:
        raise HTTPException(404, "Meter not found")
    loads = db.query(EnergyMeterLoad).filter(EnergyMeterLoad.meter_id == meter_id).all()
    items = []
    for load in loads:
        mac = db.query(Machine).filter(Machine.id == load.machine_id).first() if load.machine_id else None
        items.append({
            "id": load.id,
            "load_type": load.load_type,
            "machine_id": load.machine_id,
            "machine_name": mac.name if mac else None,
            "utility_name": load.utility_name,
            "utility_kind": load.utility_kind,
            "share_pct": load.share_pct,
            "active": bool(load.active),
        })
    return {"meter_id": meter_id, "loads": items}


@router.put("/meters/{meter_id}/loads")
def replace_loads(
    meter_id: int,
    body: List[LoadIn],
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    m = db.query(EnergyMeter).filter(EnergyMeter.id == meter_id).first()
    if not m:
        raise HTTPException(404, "Meter not found")
    db.query(EnergyMeterLoad).filter(EnergyMeterLoad.meter_id == meter_id).delete()
    n = len(body)
    # Equal split among mapped loads (e.g. 3 devices → ~33.333% each). Remainder on last row.
    even = round(100.0 / n, 4) if n else 100.0
    assigned = 0.0
    for i, item in enumerate(body):
        lt = (item.load_type or "").strip().lower()
        if lt not in ("machine", "utility"):
            raise HTTPException(400, "load_type must be machine|utility")
        if lt == "machine" and not item.machine_id:
            raise HTTPException(400, "machine_id required for machine load")
        if lt == "utility" and not (item.utility_name or "").strip():
            raise HTTPException(400, "utility_name required for utility load")
        if i == n - 1:
            share = round(100.0 - assigned, 4)
        else:
            share = even
            assigned += even
        db.add(
            EnergyMeterLoad(
                meter_id=meter_id,
                load_type=lt,
                machine_id=item.machine_id if lt == "machine" else None,
                utility_name=(item.utility_name or "").strip() if lt == "utility" else None,
                utility_kind=(item.utility_kind or "other").strip() if lt == "utility" else None,
                share_pct=share,
                active=1,
            )
        )
    db.commit()
    return {"ok": True, "count": n, "share_each_pct": even if n else 100.0}


@router.post("/sync")
def sync_all(
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "operator", "maintenance")),
):
    ensure_default_panels(db)
    meters = db.query(EnergyMeter).filter(EnergyMeter.active == 1).all()
    for m in meters:
        sync_meter_from_source_machine(db, m)
    db.commit()
    return dashboard_payload(db)


@router.get("/reports/monthwise")
def report_monthwise(
    fiscal_year: Optional[int] = Query(None, description="FY start year, e.g. 2026 for Apr-2026…Mar-2027"),
    fiscal_start_month: int = Query(4, ge=1, le=12),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Monthwise KWH for all panels + YTD (JSON preview)."""
    return monthwise_summary(db, fiscal_year=fiscal_year, fiscal_start_month=fiscal_start_month)


@router.get("/reports/monthwise/download")
def download_monthwise(
    fiscal_year: Optional[int] = Query(None),
    fiscal_start_month: int = Query(4, ge=1, le=12),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Excel download — plant summary + panel-wise monthly KWH."""
    payload = monthwise_summary(db, fiscal_year=fiscal_year, fiscal_start_month=fiscal_start_month)
    data = build_monthwise_xlsx(payload)
    label = payload.get("fiscal_year_label") or str(payload.get("fiscal_year") or "")
    filename = f"monthwise_energy_{label}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/reports/historic/download")
def download_historic(
    preset: str = Query("yesterday", description="yesterday | last_3_days | week | custom | month"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    month: Optional[str] = Query(None, description="YYYY-MM"),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Excel for the selected historic range (day / 3 days / week / custom / calendar month)."""
    try:
        payload = historic_range_report(
            db, preset=preset, date_from=date_from, date_to=date_to, month=month
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    data = build_historic_xlsx(payload)
    rng = payload.get("range") or {}
    fname = f"energy_historic_{rng.get('preset')}_{rng.get('from')}_{rng.get('to')}.xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
