"""Work order management — master orders, plan linkage, track record, machine suggestions."""
import json
import io
from datetime import date, timedelta, datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import extract, func, or_, and_
from sqlalchemy.orm import Session
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

from ..auth import get_current_user, require_role
from ..models import WorkOrder, ProductionPlan, Machine, Part, ToolStock, get_db, now_ist
from ..ws_manager import manager

router = APIRouter(prefix="/api/work-orders", tags=["work-orders"])


class SpareToolItem(BaseModel):
    name: str
    qty: Optional[float] = None
    unit: Optional[str] = "pcs"
    notes: Optional[str] = None
    tool_no: Optional[str] = None
    stock_available: Optional[float] = None
    remaining_qty: Optional[float] = None
    source: Optional[str] = None  # "mold" | "part" | "manual"


class WorkOrderCreate(BaseModel):
    work_order_no: str
    mold_id: Optional[int] = None  # preferred for IMM — mold master (tool_stocks.id)
    part_id: Optional[int] = None
    model_variant: Optional[str] = None
    description: Optional[str] = None
    target_qty: int = Field(gt=0)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    spares_tools: Optional[List[SpareToolItem]] = None


class WorkOrderUpdate(BaseModel):
    description: Optional[str] = None
    target_qty: Optional[int] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: Optional[str] = None
    mold_id: Optional[int] = None
    part_id: Optional[int] = None
    model_variant: Optional[str] = None
    spares_tools: Optional[List[SpareToolItem]] = None


def _mold_label(mold: ToolStock) -> str:
    bits = [mold.tool_code, mold.tool_name]
    if getattr(mold, "part_no", None):
        bits.append(str(mold.part_no))
    return " · ".join(b for b in bits if b)


def _resolve_part_id_from_mold(db: Session, mold: ToolStock) -> Optional[int]:
    """Optional legacy link: match Part.part_no to mold.part_no when present."""
    pn = (getattr(mold, "part_no", None) or "").strip()
    if not pn:
        return None
    part = db.query(Part).filter(Part.part_no == pn).first()
    return part.id if part else None


class WorkOrderExportParams(BaseModel):
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    status: Optional[str] = None
    search: Optional[str] = None
    historic: bool = False


def _parse_spares(raw: Optional[str]) -> list:
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _wo_stats(db: Session, wo: WorkOrder) -> dict:
    plans = db.query(ProductionPlan).filter(
        ProductionPlan.work_order_id == wo.id,
        ProductionPlan.status.notin_(["cancelled", "aborted"]),
    ).all()
    planned_qty = sum(p.planned_qty for p in plans)
    completed_qty = sum(p.actual_qty for p in plans)
    remaining_qty = max(wo.target_qty - completed_qty, 0)
    unplanned_qty = max(wo.target_qty - planned_qty, 0)
    pct = round(completed_qty / wo.target_qty * 100, 1) if wo.target_qty else 0
    return {
        "planned_qty": planned_qty,
        "completed_qty": completed_qty,
        "remaining_qty": remaining_qty,
        "unplanned_qty": unplanned_qty,
        "complete_pct": pct,
        "plan_count": len(plans),
    }


def _serialize_wo(db: Session, wo: WorkOrder, include_plans: bool = False) -> dict:
    part = db.query(Part).filter(Part.id == wo.part_id).first() if wo.part_id else None
    mold = db.query(ToolStock).filter(ToolStock.id == wo.mold_id).first() if getattr(wo, "mold_id", None) else None
    stats = _wo_stats(db, wo)
    mold_label = _mold_label(mold) if mold else None
    out = {
        "id": wo.id,
        "work_order_no": wo.work_order_no,
        "mold_id": getattr(wo, "mold_id", None),
        "mold_code": mold.tool_code if mold else None,
        "mold_name": mold.tool_name if mold else None,
        "mold_label": mold_label,
        "part_id": wo.part_id,
        "part_no": (part.part_no if part else None) or (getattr(mold, "part_no", None) if mold else None),
        "model_variant": wo.model_variant or mold_label or (part.model_variant if part else None),
        "description": wo.description,
        "target_qty": wo.target_qty,
        "start_date": str(wo.start_date) if wo.start_date else None,
        "end_date": str(wo.end_date) if wo.end_date else None,
        "status": wo.status,
        "spares_tools": _parse_spares(wo.spares_tools_json),
        "created_at": wo.created_at,
        "updated_at": wo.updated_at,
        **stats,
    }
    if include_plans:
        plans = db.query(ProductionPlan).filter(
            ProductionPlan.work_order_id == wo.id
        ).order_by(ProductionPlan.plan_date, ProductionPlan.shift).all()
        machines = {m.id: m for m in db.query(Machine).all()}
        out["plans"] = [_serialize_plan(p, machines) for p in plans]
    return out


def _serialize_plan(p: ProductionPlan, machines: dict) -> dict:
    m = machines.get(p.machine_id)
    return {
        "id": p.id,
        "work_order_id": p.work_order_id,
        "plan_date": str(p.plan_date),
        "shift": p.shift,
        "station_no": p.station_no,
        "machine_id": p.machine_id,
        "machine_name": m.name if m else None,
        "current_operation": p.current_operation,
        "next_operation": p.next_operation,
        "model_variant": p.model_variant,
        "planned_qty": p.planned_qty,
        "actual_qty": p.actual_qty,
        "status": p.status,
        "plan_type": p.plan_type,
        "notes": p.notes,
    }


def _sync_wo_status(db: Session, wo_id: int):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo or wo.status == "cancelled":
        return
    stats = _wo_stats(db, wo)
    if stats["completed_qty"] >= wo.target_qty:
        wo.status = "completed"
    elif stats["plan_count"] > 0 or stats["completed_qty"] > 0:
        wo.status = "in_progress"
    elif wo.status == "completed":
        wo.status = "in_progress"
    wo.updated_at = now_ist()


def _apply_wo_date_range(q, date_from: Optional[date], date_to: Optional[date]):
    """Include work orders whose schedule overlaps the requested date window."""
    if date_from:
        q = q.filter(or_(WorkOrder.end_date.is_(None), WorkOrder.end_date >= date_from))
    if date_to:
        q = q.filter(or_(WorkOrder.start_date.is_(None), WorkOrder.start_date <= date_to))
    return q


def _month_end(d: date) -> date:
    if d.month == 12:
        return date(d.year, 12, 31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def _apply_active_in_range(q, db: Session, date_from: date, date_to: date):
    """Active WOs with production plans in range, or whose WO schedule overlaps the range."""
    plan_wo_ids = [
        row[0] for row in db.query(ProductionPlan.work_order_id).filter(
            ProductionPlan.work_order_id.isnot(None),
            ProductionPlan.plan_date >= date_from,
            ProductionPlan.plan_date <= date_to,
            ProductionPlan.status != "cancelled",
        ).distinct().all()
    ]
    overlap = and_(
        or_(WorkOrder.end_date.is_(None), WorkOrder.end_date >= date_from),
        or_(WorkOrder.start_date.is_(None), WorkOrder.start_date <= date_to),
    )
    if plan_wo_ids:
        return q.filter(or_(WorkOrder.id.in_(plan_wo_ids), overlap))
    return q.filter(overlap)


@router.post("/")
async def create_work_order(
    data: WorkOrderCreate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if db.query(WorkOrder).filter(WorkOrder.work_order_no == data.work_order_no).first():
        raise HTTPException(400, "Work order number already exists")

    mold = None
    if data.mold_id:
        mold = db.query(ToolStock).filter(ToolStock.id == data.mold_id, ToolStock.active == 1).first()
        if not mold:
            raise HTTPException(404, "Mold not found in mold master")
    elif not data.part_id:
        raise HTTPException(400, "Select a mold from mold master")

    part_id = data.part_id
    if part_id:
        part = db.query(Part).filter(Part.id == part_id).first()
        if not part:
            raise HTTPException(404, "Part not found")
    elif mold:
        part_id = _resolve_part_id_from_mold(db, mold)

    model_variant = data.model_variant
    if not model_variant and mold:
        model_variant = _mold_label(mold)

    spares_json = json.dumps([s.model_dump() for s in data.spares_tools]) if data.spares_tools else None
    wo = WorkOrder(
        work_order_no=data.work_order_no.strip(),
        mold_id=data.mold_id,
        part_id=part_id,
        model_variant=model_variant,
        description=data.description,
        target_qty=data.target_qty,
        start_date=data.start_date,
        end_date=data.end_date,
        spares_tools_json=spares_json,
        status="draft",
        created_by=user.id,
        created_at=now_ist(),
        updated_at=now_ist(),
    )
    db.add(wo)
    db.commit()
    db.refresh(wo)
    await manager.broadcast({"type": "work_order_created", "work_order_id": wo.id})
    return _serialize_wo(db, wo)


@router.get("/")
def list_work_orders(
    search: Optional[str] = None,
    status: Optional[str] = None,
    month: Optional[int] = None,
    year: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    active_only: bool = False,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(WorkOrder)
    if search:
        like = f"%{search}%"
        mold_ids = [
            r[0] for r in db.query(ToolStock.id).filter(or_(
                ToolStock.tool_code.ilike(like),
                ToolStock.tool_name.ilike(like),
                ToolStock.part_no.ilike(like),
            )).all()
        ]
        search_filters = [
            WorkOrder.work_order_no.ilike(like),
            WorkOrder.model_variant.ilike(like),
            WorkOrder.description.ilike(like),
        ]
        if mold_ids:
            search_filters.append(WorkOrder.mold_id.in_(mold_ids))
        q = q.filter(or_(*search_filters))
    if status:
        q = q.filter(WorkOrder.status == status)
    if month:
        q = q.filter(extract("month", WorkOrder.start_date) == month)
    if year:
        q = q.filter(extract("year", WorkOrder.start_date) == year)
    if active_only and date_from and date_to:
        q = _apply_active_in_range(q, db, date_from, date_to)
    else:
        q = _apply_wo_date_range(q, date_from, date_to)
    orders = q.order_by(WorkOrder.start_date.desc(), WorkOrder.id.desc()).all()

    # Sync plan actuals from machine running count before rolling up WO completed qty
    try:
        from .hourly_output import sync_plan_actuals_from_status_logs
        sync_plan_actuals_from_status_logs(
            db,
            date_from=date_from,
            date_to=date_to,
            commit=True,
        )
    except Exception as exc:
        print(f"[WorkOrders] actual sync skipped: {exc}")

    for wo in orders:
        _sync_wo_status(db, wo.id)
    db.commit()
    if active_only:
        orders = [wo for wo in orders if wo.status in ("draft", "in_progress")]
    return [_serialize_wo(db, wo) for wo in orders]


@router.get("/overview")
def work_order_overview(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    search: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Overview list with gantt bar data per work order."""
    today = date.today()
    if not date_from:
        date_from = today - timedelta(days=7)
    if not date_to:
        date_to = today + timedelta(days=14)

    q = db.query(WorkOrder)
    if search:
        like = f"%{search}%"
        q = q.filter(or_(
            WorkOrder.work_order_no.ilike(like),
            WorkOrder.model_variant.ilike(like),
        ))
    if status:
        q = q.filter(WorkOrder.status == status)
    q = q.filter(or_(
        WorkOrder.start_date.is_(None),
        WorkOrder.start_date <= date_to,
    )).filter(or_(
        WorkOrder.end_date.is_(None),
        WorkOrder.end_date >= date_from,
    ))
    orders = q.order_by(WorkOrder.start_date, WorkOrder.id).all()
    machines = {m.id: m for m in db.query(Machine).all()}

    items = []
    for wo in orders:
        stats = _wo_stats(db, wo)
        plans = db.query(ProductionPlan).filter(
            ProductionPlan.work_order_id == wo.id,
            ProductionPlan.status != "cancelled",
        ).all()
        plan_dates = [p.plan_date for p in plans]
        bar_start = min(plan_dates) if plan_dates else wo.start_date
        bar_end = max(plan_dates) if plan_dates else wo.end_date
        if not bar_start:
            bar_start = date_from
        if not bar_end:
            bar_end = date_to

        delay = wo.end_date and wo.end_date < today and stats["completed_qty"] < wo.target_qty
        gantt_status = "completed" if wo.status == "completed" else (
            "delay" if delay else ("running" if stats["completed_qty"] > 0 else "schedule")
        )

        segments = []
        for p in plans:
            seg_end = p.plan_date
            pct = round(p.actual_qty / p.planned_qty * 100) if p.planned_qty else 0
            seg_status = p.status
            if p.plan_date < today and p.status not in ("completed", "cancelled"):
                seg_status = "delay"
            segments.append({
                "plan_id": p.id,
                "start": str(p.plan_date),
                "end": str(seg_end),
                "planned_qty": p.planned_qty,
                "actual_qty": p.actual_qty,
                "machine_name": machines.get(p.machine_id).name if p.machine_id and machines.get(p.machine_id) else None,
                "status": seg_status,
                "complete_pct": pct,
            })

        part = db.query(Part).filter(Part.id == wo.part_id).first() if wo.part_id else None
        mold = db.query(ToolStock).filter(ToolStock.id == wo.mold_id).first() if getattr(wo, "mold_id", None) else None
        items.append({
            "id": wo.id,
            "work_order_no": wo.work_order_no,
            "mold_id": getattr(wo, "mold_id", None),
            "mold_label": _mold_label(mold) if mold else None,
            "part_label": wo.model_variant or (_mold_label(mold) if mold else None) or (part.part_no if part else "—"),
            "target_qty": wo.target_qty,
            "completed_qty": stats["completed_qty"],
            "remaining_qty": stats["remaining_qty"],
            "complete_pct": stats["complete_pct"],
            "status": wo.status,
            "gantt_status": gantt_status,
            "bar_start": str(bar_start),
            "bar_end": str(bar_end),
            "segments": segments,
            "plans": [_serialize_plan(p, machines) for p in plans],
        })

    return {
        "date_from": str(date_from),
        "date_to": str(date_to),
        "today": str(today),
        "items": items,
    }


@router.get("/planned")
def list_planned_work_orders(
    search: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Work orders with upcoming production plans or a future WO schedule in the date window."""
    today = now_ist().date()
    plan_from = date_from or today.replace(day=1)
    plan_to = date_to or _month_end(today)

    plans_q = db.query(ProductionPlan).filter(
        ProductionPlan.work_order_id.isnot(None),
        ProductionPlan.plan_date >= plan_from,
        ProductionPlan.plan_date <= plan_to,
        ProductionPlan.status.in_(["pending", "paused"]),
    )
    if search:
        like = f"%{search}%"
        plans_q = plans_q.join(WorkOrder, WorkOrder.id == ProductionPlan.work_order_id).filter(or_(
            WorkOrder.work_order_no.ilike(like),
            WorkOrder.model_variant.ilike(like),
            WorkOrder.description.ilike(like),
        ))

    plans = plans_q.order_by(ProductionPlan.plan_date, ProductionPlan.shift).all()
    machines = {m.id: m for m in db.query(Machine).all()}

    by_wo: dict = {}
    for p in plans:
        by_wo.setdefault(p.work_order_id, []).append(p)

    items = []
    seen_ids = set()

    for wo_id, wo_plans in by_wo.items():
        wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
        if not wo or wo.status in ("completed", "cancelled"):
            continue
        _sync_wo_status(db, wo.id)
        if wo.status in ("completed", "cancelled"):
            continue
        stats = _wo_stats(db, wo)
        if stats["completed_qty"] >= wo.target_qty:
            continue
        future_plans = [_serialize_plan(p, machines) for p in wo_plans]
        future_qty = sum(p.planned_qty - p.actual_qty for p in wo_plans)
        items.append({
            **_serialize_wo(db, wo),
            "future_plans": future_plans,
            "future_plan_count": len(future_plans),
            "future_planned_qty": future_qty,
            "next_plan_date": future_plans[0]["plan_date"] if future_plans else None,
            "unplanned_qty": stats["unplanned_qty"],
            "schedule_only": False,
        })
        seen_ids.add(wo_id)

    # Future-scheduled work orders with no production plans yet (WO period in range, start in future)
    wo_q = db.query(WorkOrder).filter(
        WorkOrder.status.notin_(["completed", "cancelled"]),
        WorkOrder.start_date.isnot(None),
        WorkOrder.start_date > today,
        WorkOrder.start_date <= plan_to,
        or_(WorkOrder.end_date.is_(None), WorkOrder.end_date >= plan_from),
    )
    if search:
        like = f"%{search}%"
        wo_q = wo_q.filter(or_(
            WorkOrder.work_order_no.ilike(like),
            WorkOrder.model_variant.ilike(like),
            WorkOrder.description.ilike(like),
        ))

    for wo in wo_q.order_by(WorkOrder.start_date, WorkOrder.id).all():
        if wo.id in seen_ids:
            continue
        _sync_wo_status(db, wo.id)
        if wo.status in ("completed", "cancelled"):
            continue
        stats = _wo_stats(db, wo)
        if stats["completed_qty"] >= wo.target_qty:
            continue
        items.append({
            **_serialize_wo(db, wo),
            "future_plans": [],
            "future_plan_count": 0,
            "future_planned_qty": 0,
            "next_plan_date": str(wo.start_date),
            "unplanned_qty": stats["unplanned_qty"],
            "schedule_only": True,
        })
        seen_ids.add(wo.id)

    db.commit()
    items.sort(key=lambda x: (x["next_plan_date"] or "", x["work_order_no"]))
    return {
        "today": str(today),
        "date_from": str(plan_from),
        "date_to": str(plan_to),
        "items": items,
    }


@router.get("/suggest-machines")
def suggest_machines(
    part_id: Optional[int] = None,
    model_variant: Optional[str] = None,
    smart: bool = Query(True, description="Only suggest machines near completion or idle"),
    limit: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Suggest machines based on historical runs for the same part."""
    if not part_id and not model_variant:
        return {"suggestions": [], "smart_mode": smart}

    part = db.query(Part).filter(Part.id == part_id).first() if part_id else None
    variant = model_variant or (part.model_variant if part else None)

    hist_q = db.query(ProductionPlan).filter(
        ProductionPlan.machine_id.isnot(None),
        ProductionPlan.status.in_(["completed", "running", "paused"]),
    )
    if variant:
        hist_q = hist_q.filter(ProductionPlan.model_variant == variant)
    elif part:
        hist_q = hist_q.filter(ProductionPlan.model_variant == part.part_no)

    historical = hist_q.order_by(ProductionPlan.plan_date.desc()).all()
    machine_ids = []
    seen = set()
    for p in historical:
        if p.machine_id not in seen:
            seen.add(p.machine_id)
            machine_ids.append(p.machine_id)

    if not smart:
        machines = {m.id: m for m in db.query(Machine).filter(Machine.id.in_(machine_ids)).all()}
        suggestions = []
        for mid in machine_ids[:limit]:
            m = machines.get(mid)
            if not m:
                continue
            last = next((p for p in historical if p.machine_id == mid), None)
            suggestions.append({
                "machine_id": mid,
                "machine_name": m.name,
                "station_id": m.station_id,
                "machine_status": m.status,
                "reason": "Previously used for this part",
                "last_run_date": str(last.plan_date) if last else None,
                "total_qty_produced": sum(p.actual_qty for p in historical if p.machine_id == mid),
            })
        return {"suggestions": suggestions, "smart_mode": False}

    machines = {m.id: m for m in db.query(Machine).all()}
    suggestions = []
    completion_threshold = 0.15  # within 15% of plan completion

    for mid in machine_ids:
        m = machines.get(mid)
        if not m:
            continue
        current = db.query(ProductionPlan).filter(
            ProductionPlan.machine_id == mid,
            ProductionPlan.status.in_(["pending", "running", "paused"]),
        ).order_by(ProductionPlan.priority, ProductionPlan.plan_date).first()

        reason = "Previously used for this part"
        include = False

        if m.status in ("idle", "offline") and not current:
            include = True
            reason = "Machine idle — available for this part"
        elif current:
            remaining = max(current.planned_qty - current.actual_qty, 0)
            ratio = remaining / current.planned_qty if current.planned_qty else 1
            if ratio <= completion_threshold or current.status == "completed":
                include = True
                reason = f"Current job ~{100 - int(ratio * 100)}% complete"
            elif m.status == "idle":
                include = True
                reason = "Machine idle after recent run"
        elif m.status == "running":
            continue

        if not include:
            continue

        last = next((p for p in historical if p.machine_id == mid), None)
        suggestions.append({
            "machine_id": mid,
            "machine_name": m.name,
            "station_id": m.station_id,
            "machine_status": m.status,
            "reason": reason,
            "last_run_date": str(last.plan_date) if last else None,
            "total_qty_produced": sum(p.actual_qty for p in historical if p.machine_id == mid),
            "current_plan_remaining": (
                max(current.planned_qty - current.actual_qty, 0) if current else 0
            ),
        })

    suggestions.sort(key=lambda s: (
        0 if s["machine_status"] == "idle" else 1,
        -(s.get("total_qty_produced") or 0),
    ))
    return {"suggestions": suggestions[:limit], "smart_mode": True}


def _filter_work_orders(q, params: WorkOrderExportParams):
    if params.search:
        like = f"%{params.search}%"
        q = q.filter(or_(
            WorkOrder.work_order_no.ilike(like),
            WorkOrder.model_variant.ilike(like),
            WorkOrder.description.ilike(like),
        ))
    if params.status:
        q = q.filter(WorkOrder.status == params.status)
    elif params.historic:
        q = q.filter(WorkOrder.status.in_(["completed", "cancelled"]))
    else:
        q = q.filter(WorkOrder.status.in_(["draft", "in_progress"]))
    q = _apply_wo_date_range(q, params.date_from, params.date_to)
    return q


def _style_header_row(ws, ncols):
    hdr_fill = PatternFill("solid", fgColor="1E3A5F")
    hdr_font = Font(bold=True, color="FFFFFF")
    for col in range(1, ncols + 1):
        cell = ws.cell(row=1, column=col)
        cell.fill = hdr_fill
        cell.font = hdr_font
        cell.alignment = Alignment(horizontal="center")


def _build_work_order_excel(db: Session, orders: list, report_label: str) -> io.BytesIO:
    wb = openpyxl.Workbook()
    ws1 = wb.active
    ws1.title = "Summary"
    ws1.append(["WORK ORDER REPORT", report_label])
    ws1.append(["Generated", datetime.now().strftime("%Y-%m-%d %H:%M:%S")])
    ws1.append([])
    ws1.append(["Total Work Orders", len(orders)])
    ws1.append(["Total Target Qty", sum(o.target_qty for o in orders)])
    ws1.append(["Total Completed Qty", sum(_wo_stats(db, o)["completed_qty"] for o in orders)])

    ws2 = wb.create_sheet("Work Orders")
    wo_headers = [
        "Work Order No", "Part No", "Model/Variant", "Description", "Target Qty",
        "Planned Qty", "Completed Qty", "Remaining Qty", "Complete %", "Status",
        "Period Start", "Period End", "Spares/Tools", "Created At",
    ]
    ws2.append(wo_headers)
    _style_header_row(ws2, len(wo_headers))
    for wo in orders:
        stats = _wo_stats(db, wo)
        part = db.query(Part).filter(Part.id == wo.part_id).first() if wo.part_id else None
        spares = _parse_spares(wo.spares_tools_json)
        spares_txt = "; ".join(
            f"{s.get('name', '')}{' x' + str(s['qty']) if s.get('qty') else ''}" for s in spares
        )
        ws2.append([
            wo.work_order_no,
            part.part_no if part else "",
            wo.model_variant or (part.model_variant if part else ""),
            wo.description or "",
            wo.target_qty,
            stats["planned_qty"],
            stats["completed_qty"],
            stats["remaining_qty"],
            stats["complete_pct"],
            wo.status,
            str(wo.start_date) if wo.start_date else "",
            str(wo.end_date) if wo.end_date else "",
            spares_txt,
            str(wo.created_at) if wo.created_at else "",
        ])

    ws3 = wb.create_sheet("Production Runs")
    run_headers = [
        "Work Order No", "Plan Date", "Shift", "Station", "Machine", "Operation",
        "Planned Qty", "Actual Qty", "Complete %", "Status", "Notes",
    ]
    ws3.append(run_headers)
    _style_header_row(ws3, len(run_headers))
    machines = {m.id: m for m in db.query(Machine).all()}
    for wo in orders:
        plans = db.query(ProductionPlan).filter(
            ProductionPlan.work_order_id == wo.id,
        ).order_by(ProductionPlan.plan_date, ProductionPlan.shift).all()
        for p in plans:
            m = machines.get(p.machine_id)
            pct = round(p.actual_qty / p.planned_qty * 100, 1) if p.planned_qty else 0
            ws3.append([
                wo.work_order_no,
                str(p.plan_date),
                p.shift,
                p.station_no,
                m.name if m else "",
                p.current_operation,
                p.planned_qty,
                p.actual_qty,
                pct,
                p.status,
                p.notes or "",
            ])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


@router.post("/export")
def export_work_orders(
    params: WorkOrderExportParams,
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = _filter_work_orders(db.query(WorkOrder), params)
    orders = q.order_by(WorkOrder.start_date.desc(), WorkOrder.id.desc()).all()
    label = "Historic" if params.historic else "Current"
    if params.date_from and params.date_to:
        label += f" ({params.date_from} to {params.date_to})"
    buf = _build_work_order_excel(db, orders, label)
    filename = f"work_orders_{label.lower().replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/{wo_id}")
def get_work_order(wo_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Work order not found")
    try:
        from .hourly_output import sync_plan_actuals_from_status_logs
        sync_plan_actuals_from_status_logs(
            db,
            date_from=wo.start_date,
            date_to=wo.end_date or now_ist().date(),
            commit=True,
        )
    except Exception as exc:
        print(f"[WorkOrders] detail actual sync skipped: {exc}")
    return _serialize_wo(db, wo, include_plans=True)


@router.get("/{wo_id}/track-record")
def track_record(wo_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Work order not found")
    try:
        from .hourly_output import sync_plan_actuals_from_status_logs
        sync_plan_actuals_from_status_logs(
            db,
            date_from=wo.start_date,
            date_to=wo.end_date or now_ist().date(),
            commit=True,
        )
    except Exception as exc:
        print(f"[WorkOrders] track-record actual sync skipped: {exc}")
    plans = db.query(ProductionPlan).filter(
        ProductionPlan.work_order_id == wo_id,
    ).order_by(ProductionPlan.plan_date.desc(), ProductionPlan.shift).all()
    machines = {m.id: m for m in db.query(Machine).all()}
    stats = _wo_stats(db, wo)

    records = []
    for p in plans:
        m = machines.get(p.machine_id)
        records.append({
            "plan_id": p.id,
            "run_date": str(p.plan_date),
            "shift": p.shift,
            "station_no": p.station_no,
            "machine_id": p.machine_id,
            "machine_name": m.name if m else "—",
            "machine_status": m.status if m else None,
            "planned_qty": p.planned_qty,
            "actual_qty": p.actual_qty,
            "complete_pct": round(p.actual_qty / p.planned_qty * 100, 1) if p.planned_qty else 0,
            "status": p.status,
            "current_operation": p.current_operation,
            "next_operation": p.next_operation,
            "model_variant": p.model_variant,
            "updated_at": p.updated_at,
        })

    return {
        "work_order": _serialize_wo(db, wo),
        "summary": stats,
        "records": records,
    }


@router.patch("/{wo_id}")
async def update_work_order(
    wo_id: int,
    data: WorkOrderUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Work order not found")
    if data.description is not None:
        wo.description = data.description
    if data.target_qty is not None:
        wo.target_qty = data.target_qty
    if data.start_date is not None:
        wo.start_date = data.start_date
    if data.end_date is not None:
        wo.end_date = data.end_date
    if data.status is not None:
        wo.status = data.status
    if data.mold_id is not None:
        if data.mold_id:
            mold = db.query(ToolStock).filter(ToolStock.id == data.mold_id, ToolStock.active == 1).first()
            if not mold:
                raise HTTPException(404, "Mold not found in mold master")
            wo.mold_id = mold.id
            if data.part_id is None and not wo.part_id:
                wo.part_id = _resolve_part_id_from_mold(db, mold)
            if data.model_variant is None and not wo.model_variant:
                wo.model_variant = _mold_label(mold)
        else:
            wo.mold_id = None
    if data.part_id is not None:
        wo.part_id = data.part_id or None
    if data.model_variant is not None:
        wo.model_variant = data.model_variant
    if data.spares_tools is not None:
        wo.spares_tools_json = json.dumps([s.model_dump() for s in data.spares_tools])
    wo.updated_at = now_ist()
    _sync_wo_status(db, wo_id)
    db.commit()
    db.refresh(wo)
    await manager.broadcast({"type": "work_order_updated", "work_order_id": wo_id})
    return _serialize_wo(db, wo, include_plans=True)


@router.delete("/{wo_id}")
async def delete_work_order(
    wo_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    """Delete a work order. Linked plans/tool events are unlinked (kept as history)."""
    from ..models import ToolEvent

    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Work order not found")

    # Block deletion if any plans are still linked to this work order
    linked_plan_count = (
        db.query(ProductionPlan)
        .filter(ProductionPlan.work_order_id == wo_id)
        .count()
    )
    if linked_plan_count > 0:
        raise HTTPException(
            400,
            f"Cannot delete work order: it has {linked_plan_count} plan(s) assigned. "
            "Please remove the plans first.",
        )

    wo_no = wo.work_order_no
    db.query(ProductionPlan).filter(ProductionPlan.work_order_id == wo_id).update(
        {ProductionPlan.work_order_id: None},
        synchronize_session=False,
    )
    try:
        db.query(ToolEvent).filter(ToolEvent.work_order_id == wo_id).update(
            {ToolEvent.work_order_id: None},
            synchronize_session=False,
        )
    except Exception:
        pass
    db.delete(wo)
    db.commit()
    await manager.broadcast({"type": "work_order_deleted", "work_order_id": wo_id})
    return {"ok": True, "deleted_id": wo_id, "work_order_no": wo_no}


def sync_work_order_after_plan_change(db: Session, work_order_id: Optional[int]):
    if work_order_id:
        _sync_wo_status(db, work_order_id)
