"""Tool Management — inventory, life monitoring, forecast, SAP sync."""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..models import ToolStock, ToolEvent, ToolAlert, WorkOrder, Machine, get_db, now_ist
from ..tool_service import (
    QR_SCAN_ENABLED,
    serialize_tool,
    evaluate_stock_and_life_alerts,
    log_event,
    refresh_tool_status,
    build_forecast,
    find_tool,
    dump_cavities,
)

router = APIRouter(prefix="/api/tools", tags=["tools"])


class ToolStockCreate(BaseModel):
    tool_code: str
    tool_name: str
    unit: Optional[str] = "pcs"
    stock_qty: Optional[float] = 0
    min_stock: Optional[float] = 0
    sap_material_no: Optional[str] = None
    stock_source: Optional[str] = "manual"
    life_cycles_limit: Optional[int] = None
    cycles_used: Optional[float] = 0
    life_warning_pct: Optional[int] = 90
    cycles_per_part: Optional[float] = 1
    qr_code: Optional[str] = None
    notes: Optional[str] = None
    part_no: Optional[str] = None
    standard_cavity: Optional[int] = None
    running_cavity: Optional[int] = None
    customer_name: Optional[str] = None
    rm_grade: Optional[str] = None
    standard_cycle_time: Optional[float] = None
    std_shot_weight: Optional[float] = None
    std_part_weight: Optional[float] = None
    std_runner_weight: Optional[float] = None
    colour: Optional[str] = None
    target_per_shift: Optional[int] = None
    cavities: Optional[List[dict]] = None
    active: Optional[int] = 1


class ToolStockUpdate(BaseModel):
    tool_name: Optional[str] = None
    unit: Optional[str] = None
    stock_qty: Optional[float] = None
    min_stock: Optional[float] = None
    sap_material_no: Optional[str] = None
    stock_source: Optional[str] = None
    life_cycles_limit: Optional[int] = None
    cycles_used: Optional[float] = None
    life_warning_pct: Optional[int] = None
    cycles_per_part: Optional[float] = None
    qr_code: Optional[str] = None
    notes: Optional[str] = None
    part_no: Optional[str] = None
    standard_cavity: Optional[int] = None
    running_cavity: Optional[int] = None
    customer_name: Optional[str] = None
    rm_grade: Optional[str] = None
    standard_cycle_time: Optional[float] = None
    std_shot_weight: Optional[float] = None
    std_part_weight: Optional[float] = None
    std_runner_weight: Optional[float] = None
    colour: Optional[str] = None
    target_per_shift: Optional[int] = None
    cavities: Optional[List[dict]] = None
    active: Optional[int] = None


class SapStockItem(BaseModel):
    sap_material_no: str
    stock_qty: float = Field(ge=0)
    tool_code: Optional[str] = None
    tool_name: Optional[str] = None
    unit: Optional[str] = "pcs"


class SapSyncRequest(BaseModel):
    items: List[SapStockItem]
    dry_run: bool = False
    create_missing: bool = True


class ForecastRequest(BaseModel):
    work_order_id: int
    planned_qty: int = Field(gt=0)


class CorrectionRequest(BaseModel):
    notes: Optional[str] = None
    qr_code: Optional[str] = None  # required when QR_SCAN_ENABLED


class ReplaceRequest(BaseModel):
    notes: Optional[str] = None
    qr_code: Optional[str] = None
    consume_stock: bool = True  # decrement stock by 1 for new tool instance


def _find_by_keys(db: Session, *, tool_code: Optional[str] = None, sap_material_no: Optional[str] = None):
    if tool_code:
        row = db.query(ToolStock).filter(ToolStock.tool_code == tool_code.strip()).first()
        if row:
            return row
    if sap_material_no:
        return db.query(ToolStock).filter(ToolStock.sap_material_no == sap_material_no.strip()).first()
    return None


def _verify_qr(tool: ToolStock, qr_code: Optional[str]) -> dict:
    """QR verification — suppressed for testing; always passes when disabled."""
    if not QR_SCAN_ENABLED:
        return {"ok": True, "scanned": False, "suppressed": True}
    if not tool.qr_code:
        raise HTTPException(400, "Tool has no QR code mapped")
    if not qr_code or qr_code.strip() != tool.qr_code.strip():
        raise HTTPException(400, "QR code does not match tool — scan required")
    return {"ok": True, "scanned": True, "suppressed": False}


@router.get("/")
def list_tools(
    search: Optional[str] = None,
    active_only: bool = True,
    low_stock_only: bool = False,
    near_eol_only: bool = False,
    limit: int = Query(500, le=2000),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(ToolStock)
    if active_only:
        q = q.filter(ToolStock.active == 1)
    if search and search.strip():
        s = f"%{search.strip()}%"
        q = q.filter(or_(
            ToolStock.tool_code.ilike(s),
            ToolStock.tool_name.ilike(s),
            ToolStock.sap_material_no.ilike(s),
            ToolStock.qr_code.ilike(s),
        ))
    rows = q.order_by(ToolStock.tool_code).limit(limit).all()
    out = []
    for t in rows:
        refresh_tool_status(t)
        out.append(serialize_tool(t))
    if low_stock_only:
        out = [t for t in out if t["below_min"]]
    if near_eol_only:
        out = [t for t in out if t["tool_status"] in ("near_eol", "eol", "blocked", "correction_ack")]
    return out


@router.get("/lookup")
def lookup_stock(
    codes: Optional[str] = Query(None),
    names: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    code_list = [c.strip() for c in (codes or "").split(",") if c.strip()]
    name_list = [n.strip() for n in (names or "").split(",") if n.strip()]
    result = {}
    if code_list:
        for t in db.query(ToolStock).filter(ToolStock.tool_code.in_(code_list)).all():
            result[t.tool_code] = serialize_tool(t)
    if name_list:
        for t in db.query(ToolStock).filter(ToolStock.tool_name.in_(name_list)).all():
            result.setdefault(t.tool_name, serialize_tool(t))
            if t.tool_code:
                result.setdefault(t.tool_code, serialize_tool(t))
    return result


@router.get("/alerts")
def list_alerts(
    include_suppressed: bool = False,
    include_acked: bool = False,
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    q = db.query(ToolAlert)
    if not include_suppressed:
        q = q.filter(ToolAlert.suppressed == 0)
    if not include_acked:
        q = q.filter(ToolAlert.acknowledged == 0)
    rows = q.order_by(ToolAlert.created_at.desc()).limit(limit).all()
    tools = {t.id: t for t in db.query(ToolStock).filter(ToolStock.id.in_({r.tool_id for r in rows} or {-1})).all()}
    return [
        {
            "id": a.id,
            "tool_id": a.tool_id,
            "tool_code": tools.get(a.tool_id).tool_code if tools.get(a.tool_id) else None,
            "tool_name": tools.get(a.tool_id).tool_name if tools.get(a.tool_id) else None,
            "alert_type": a.alert_type,
            "severity": a.severity,
            "message": a.message,
            "suppressed": bool(a.suppressed),
            "acknowledged": bool(a.acknowledged),
            "created_at": a.created_at,
        }
        for a in rows
    ]


@router.post("/alerts/{alert_id}/suppress")
def suppress_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    a = db.query(ToolAlert).filter(ToolAlert.id == alert_id).first()
    if not a:
        raise HTTPException(404, "Alert not found")
    a.suppressed = 1
    a.acknowledged = 1
    a.acknowledged_by = user.id
    a.acknowledged_at = now_ist()
    tool = db.query(ToolStock).filter(ToolStock.id == a.tool_id).first()
    if tool:
        log_event(db, tool, "suppress_alert", user_id=user.id, notes=f"Suppressed {a.alert_type}: {a.message}",
                  acknowledged_by=user.id)
    db.commit()
    return {"ok": True}


@router.post("/alerts/{alert_id}/acknowledge")
def acknowledge_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    a = db.query(ToolAlert).filter(ToolAlert.id == alert_id).first()
    if not a:
        raise HTTPException(404, "Alert not found")
    a.acknowledged = 1
    a.acknowledged_by = user.id
    a.acknowledged_at = now_ist()
    db.commit()
    return {"ok": True}


@router.post("/forecast")
def forecast_tools(data: ForecastRequest, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return build_forecast(db, work_order_id=data.work_order_id, planned_qty=data.planned_qty)


@router.get("/work-order/{wo_id}/monitor")
def work_order_tool_monitor(wo_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Tool details, life, and recent consumption for a work order."""
    wo = db.query(WorkOrder).filter(WorkOrder.id == wo_id).first()
    if not wo:
        raise HTTPException(404, "Work order not found")
    forecast = build_forecast(db, work_order_id=wo_id, planned_qty=wo.target_qty or 1)
    events = (
        db.query(ToolEvent)
        .filter(ToolEvent.work_order_id == wo_id)
        .order_by(ToolEvent.created_at.desc())
        .limit(100)
        .all()
    )
    machines = {m.id: m for m in db.query(Machine).all()}
    history = [
        {
            "id": e.id,
            "tool_id": e.tool_id,
            "event_type": e.event_type,
            "qty_delta": float(e.qty_delta) if e.qty_delta is not None else None,
            "cycles_before": float(e.cycles_before) if e.cycles_before is not None else None,
            "cycles_after": float(e.cycles_after) if e.cycles_after is not None else None,
            "cycles_delta": float(e.cycles_delta) if e.cycles_delta is not None else None,
            "plan_id": e.plan_id,
            "location": e.location,
            "machine_name": machines.get(e.machine_id).name if e.machine_id and machines.get(e.machine_id) else None,
            "notes": e.notes,
            "qr_scanned": bool(e.qr_scanned),
            "qr_suppressed": bool(e.qr_suppressed),
            "created_at": e.created_at,
        }
        for e in events
    ]
    return {
        "work_order_id": wo.id,
        "work_order_no": wo.work_order_no,
        "tools": forecast.get("tools") or [],
        "history": history,
        "qr_scan_enabled": QR_SCAN_ENABLED,
    }


@router.post("/sync-sap")
def sync_stock_from_sap(
    data: SapSyncRequest,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin", "supervisor")),
):
    if not data.items:
        raise HTTPException(400, "No SAP stock items provided")
    updated, created, unmatched = [], [], []
    now = now_ist()
    for item in data.items:
        sap_no = item.sap_material_no.strip()
        code = (item.tool_code or sap_no).strip()
        row = _find_by_keys(db, tool_code=code, sap_material_no=sap_no)
        if not row and data.create_missing:
            if data.dry_run:
                created.append({"sap_material_no": sap_no, "tool_code": code, "stock_qty": item.stock_qty})
                continue
            row = ToolStock(
                tool_code=code,
                tool_name=(item.tool_name or code).strip(),
                unit=item.unit or "pcs",
                stock_qty=item.stock_qty,
                min_stock=0,
                sap_material_no=sap_no,
                stock_source="sap",
                last_synced_at=now,
                cycles_used=0,
                life_warning_pct=90,
                cycles_per_part=1,
                tool_status="ok",
                active=1,
                created_at=now,
                updated_at=now,
            )
            db.add(row)
            created.append({"sap_material_no": sap_no, "tool_code": code, "stock_qty": item.stock_qty})
            continue
        if not row:
            unmatched.append({"sap_material_no": sap_no, "tool_code": code})
            continue
        if data.dry_run:
            updated.append({"id": row.id, "tool_code": row.tool_code, "old_qty": float(row.stock_qty or 0), "new_qty": item.stock_qty})
            continue
        row.stock_qty = item.stock_qty
        row.stock_source = "sap"
        row.last_synced_at = now
        row.sap_material_no = sap_no
        if item.tool_name:
            row.tool_name = item.tool_name.strip()
        if item.unit:
            row.unit = item.unit
        row.updated_at = now
        evaluate_stock_and_life_alerts(db, row)
        updated.append({"id": row.id, "tool_code": row.tool_code, "stock_qty": item.stock_qty})
    if not data.dry_run:
        db.commit()
    return {
        "ok": True,
        "dry_run": data.dry_run,
        "updated_count": len(updated),
        "created_count": len(created),
        "unmatched_count": len(unmatched),
        "updated": updated,
        "created": created,
        "unmatched": unmatched,
        "synced_at": now.isoformat() if isinstance(now, datetime) else str(now),
        "message": "Dry-run complete — no changes written" if data.dry_run else "SAP stock applied to local inventory",
    }


class ToolEmailReportRequest(BaseModel):
    recipients: List[str]
    subject: str = "Tool Management Report"
    body: Optional[str] = None


@router.get("/download-report")
def export_tools_report(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Download Tool Management Excel report (inventory, alerts, consumption)."""
    from fastapi.responses import StreamingResponse
    import io
    from .email_router import build_tools_xlsx

    data = build_tools_xlsx(db)
    filename = f"tool_management_{now_ist().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/email-report")
def email_tools_report(
    data: ToolEmailReportRequest,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    """Send Tool Management Excel report to recipients (uses configured SMTP)."""
    import smtplib
    import os
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.base import MIMEBase
    from email import encoders
    from ..models import EmailSmtpConfig, EmailLog
    from .email_router import build_tools_xlsx

    recipients = [r.strip() for r in (data.recipients or []) if r and r.strip()]
    if not recipients:
        raise HTTPException(400, "At least one recipient email is required")

    xlsx = build_tools_xlsx(db)
    filename = f"tool_management_{now_ist().strftime('%Y%m%d_%H%M%S')}.xlsx"

    cfg = db.query(EmailSmtpConfig).first()
    smtp_host = cfg.smtp_server if cfg else os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = cfg.smtp_port if cfg else int(os.getenv("SMTP_PORT", 587))
    smtp_user = cfg.email_address if cfg else os.getenv("SMTP_USER", "")
    smtp_pass = cfg.email_password if cfg else os.getenv("SMTP_PASS", "")
    if not smtp_user or not smtp_pass:
        raise HTTPException(400, "SMTP not configured. Go to Alerts → Email Settings.")

    body = data.body or (
        f"Please find attached the Tool Management report generated on "
        f"{now_ist().strftime('%d-%m-%Y %H:%M:%S')}."
    )
    msg = MIMEMultipart()
    msg["From"] = smtp_user
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = data.subject or "Tool Management Report"
    msg.attach(MIMEText(body, "plain"))
    part = MIMEBase("application", "octet-stream")
    part.set_payload(xlsx)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
    msg.attach(part)

    log = EmailLog(
        sent_at=now_ist(),
        recipients=", ".join(recipients),
        subject=msg["Subject"],
        report_type="tools",
        sent_by=user.id if user else None,
    )
    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, recipients, msg.as_string())
        log.status = "sent"
    except Exception as e:
        log.status = "failed"
        log.error_msg = str(e)
        db.add(log)
        db.commit()
        raise HTTPException(500, f"Email send failed: {str(e)}")
    db.add(log)
    db.commit()
    return {"ok": True, "message": f"Report emailed to {len(recipients)} recipient(s)"}


@router.get("/{tool_id:int}")
def get_tool(tool_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    return serialize_tool(t)


@router.get("/{tool_id:int}/history")
def tool_history(
    tool_id: int,
    limit: int = Query(100, le=500),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    events = (
        db.query(ToolEvent)
        .filter(ToolEvent.tool_id == tool_id)
        .order_by(ToolEvent.created_at.desc())
        .limit(limit)
        .all()
    )
    machines = {m.id: m for m in db.query(Machine).all()}
    return {
        "tool": serialize_tool(t),
        "events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "qty_delta": float(e.qty_delta) if e.qty_delta is not None else None,
                "cycles_before": float(e.cycles_before) if e.cycles_before is not None else None,
                "cycles_after": float(e.cycles_after) if e.cycles_after is not None else None,
                "cycles_delta": float(e.cycles_delta) if e.cycles_delta is not None else None,
                "work_order_id": e.work_order_id,
                "plan_id": e.plan_id,
                "location": e.location,
                "machine_name": machines.get(e.machine_id).name if e.machine_id and machines.get(e.machine_id) else None,
                "notes": e.notes,
                "qr_scanned": bool(e.qr_scanned),
                "qr_suppressed": bool(e.qr_suppressed),
                "created_at": e.created_at,
            }
            for e in events
        ],
        "qr_scan_enabled": QR_SCAN_ENABLED,
    }


@router.post("/")
def create_tool(
    data: ToolStockCreate,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    code = data.tool_code.strip()
    if not code:
        raise HTTPException(400, "tool_code is required")
    if db.query(ToolStock).filter(ToolStock.tool_code == code).first():
        raise HTTPException(400, "Tool code already exists")
    source = data.stock_source if data.stock_source in ("manual", "sap") else "manual"
    now = now_ist()
    qr = (data.qr_code or "").strip() or code
    t = ToolStock(
        tool_code=code,
        tool_name=data.tool_name.strip(),
        unit=data.unit or "pcs",
        stock_qty=data.stock_qty if data.stock_qty is not None else 0,
        min_stock=data.min_stock if data.min_stock is not None else 0,
        sap_material_no=(data.sap_material_no or "").strip() or None,
        stock_source=source,
        life_cycles_limit=data.life_cycles_limit,
        cycles_used=data.cycles_used if data.cycles_used is not None else 0,
        life_warning_pct=data.life_warning_pct if data.life_warning_pct is not None else 90,
        cycles_per_part=data.cycles_per_part if data.cycles_per_part is not None else 1,
        qr_code=qr,
        tool_status="ok",
        notes=data.notes,
        part_no=(data.part_no or "").strip() or None,
        standard_cavity=data.standard_cavity,
        running_cavity=data.running_cavity,
        customer_name=(data.customer_name or "").strip() or None,
        rm_grade=(data.rm_grade or "").strip() or None,
        standard_cycle_time=data.standard_cycle_time,
        std_shot_weight=data.std_shot_weight,
        std_part_weight=data.std_part_weight,
        std_runner_weight=data.std_runner_weight,
        colour=(data.colour or "").strip() or None,
        target_per_shift=data.target_per_shift,
        cavities_json=dump_cavities(data.cavities),
        active=1 if data.active is None else int(data.active),
        created_at=now,
        updated_at=now,
    )
    refresh_tool_status(t)
    db.add(t)
    db.flush()
    evaluate_stock_and_life_alerts(db, t)
    log_event(db, t, "stock_adjust", user_id=user.id, qty_delta=float(t.stock_qty or 0), notes="Tool created")
    db.commit()
    db.refresh(t)
    return serialize_tool(t)


@router.put("/{tool_id:int}")
def update_tool(
    tool_id: int,
    data: ToolStockUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    payload = data.model_dump(exclude_unset=True)
    if "stock_source" in payload and payload["stock_source"] not in (None, "manual", "sap"):
        raise HTTPException(400, "stock_source must be manual or sap")
    old_stock = float(t.stock_qty or 0)
    if "cavities" in payload:
        cavities = payload.pop("cavities")
        payload["cavities_json"] = dump_cavities(cavities)
    for key, val in payload.items():
        if key in (
            "tool_name", "sap_material_no", "notes", "unit", "qr_code",
            "part_no", "customer_name", "rm_grade", "colour",
        ) and isinstance(val, str):
            val = val.strip() or None
        setattr(t, key, val)
    t.updated_at = now_ist()
    refresh_tool_status(t)
    evaluate_stock_and_life_alerts(db, t)
    new_stock = float(t.stock_qty or 0)
    if new_stock != old_stock:
        log_event(db, t, "stock_adjust", user_id=user.id, qty_delta=new_stock - old_stock,
                  notes=f"Stock {old_stock} → {new_stock}")
    db.commit()
    db.refresh(t)
    return serialize_tool(t)


@router.post("/{tool_id:int}/correction")
def acknowledge_correction(
    tool_id: int,
    data: CorrectionRequest,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    """Allow continued use after EOL via tool correction (QR suppressed for now)."""
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    qr = _verify_qr(t, data.qr_code)
    before = float(t.cycles_used or 0)
    t.tool_status = "correction_ack"
    t.updated_at = now_ist()
    log_event(
        db, t, "correction",
        user_id=user.id,
        cycles_before=before,
        cycles_after=before,
        notes=data.notes or "Tool correction acknowledged — may continue until replace",
        acknowledged_by=user.id,
        qr_scanned=qr["scanned"],
    )
    # Clear EOL alert as acknowledged
    for a in db.query(ToolAlert).filter(
        ToolAlert.tool_id == t.id,
        ToolAlert.alert_type.in_(["eol", "near_eol"]),
        ToolAlert.acknowledged == 0,
    ).all():
        a.acknowledged = 1
        a.acknowledged_by = user.id
        a.acknowledged_at = now_ist()
    db.commit()
    db.refresh(t)
    return {
        "ok": True,
        "tool": serialize_tool(t),
        "qr": qr,
        "message": "Tool correction acknowledged" + (" (QR scan suppressed)" if qr["suppressed"] else ""),
    }


@router.post("/{tool_id:int}/replace")
def replace_tool(
    tool_id: int,
    data: ReplaceRequest,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin", "superadmin", "supervisor")),
):
    """Restock / reset life with new tool instance (QR suppressed for now)."""
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    qr = _verify_qr(t, data.qr_code)
    before = float(t.cycles_used or 0)
    stock_before = float(t.stock_qty or 0)
    if data.consume_stock:
        if stock_before < 1:
            raise HTTPException(400, "No stock available to install replacement tool — restock first")
        t.stock_qty = stock_before - 1
    t.cycles_used = 0
    t.tool_status = "ok"
    t.updated_at = now_ist()
    log_event(
        db, t, "replacement",
        user_id=user.id,
        qty_delta=-1 if data.consume_stock else 0,
        cycles_before=before,
        cycles_after=0,
        notes=data.notes or "Tool replaced — life reset",
        acknowledged_by=user.id,
        qr_scanned=qr["scanned"],
    )
    evaluate_stock_and_life_alerts(db, t)
    for a in db.query(ToolAlert).filter(
        ToolAlert.tool_id == t.id,
        ToolAlert.alert_type.in_(["eol", "near_eol", "blocked"]),
        ToolAlert.acknowledged == 0,
    ).all():
        a.acknowledged = 1
        a.acknowledged_by = user.id
        a.acknowledged_at = now_ist()
    db.commit()
    db.refresh(t)
    return {
        "ok": True,
        "tool": serialize_tool(t),
        "qr": qr,
        "message": "Tool replaced and life reset" + (" (QR scan suppressed)" if qr["suppressed"] else ""),
    }


@router.delete("/{tool_id:int}")
def delete_tool(
    tool_id: int,
    hard: bool = False,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "superadmin")),
):
    t = db.query(ToolStock).filter(ToolStock.id == tool_id).first()
    if not t:
        raise HTTPException(404, "Tool not found")
    if hard:
        db.delete(t)
    else:
        t.active = 0
        t.updated_at = now_ist()
    db.commit()
    return {"ok": True}
