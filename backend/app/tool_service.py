"""Tool life, stock alerts, forecast, and consumption helpers."""
from __future__ import annotations

import json
from typing import Any, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from .models import (
    ToolStock,
    ToolEvent,
    ToolAlert,
    WorkOrder,
    ProductionPlan,
    Machine,
    ImmMold,
    now_ist,
)

# Future step: enable QR scan acknowledgment for correction / replacement.
QR_SCAN_ENABLED = False


def life_ratio(tool: ToolStock) -> Optional[float]:
    limit = int(tool.life_cycles_limit or 0)
    if limit <= 0:
        return None
    used = float(tool.cycles_used or 0)
    return used / limit


def refresh_tool_status(tool: ToolStock) -> str:
    """Derive tool_status from cycles vs limit (preserves correction_ack until EOL again)."""
    ratio = life_ratio(tool)
    if ratio is None:
        if tool.tool_status in ("near_eol", "eol", "blocked"):
            tool.tool_status = "ok"
        return tool.tool_status or "ok"

    warn = (tool.life_warning_pct if tool.life_warning_pct is not None else 90) / 100.0
    if ratio >= 1.0:
        tool.tool_status = "eol" if tool.tool_status != "correction_ack" else "correction_ack"
        if tool.tool_status == "correction_ack" and ratio >= 1.05:
            # Past corrected window — block until replace
            tool.tool_status = "blocked"
        elif tool.tool_status != "correction_ack":
            tool.tool_status = "eol"
    elif ratio >= warn:
        if tool.tool_status not in ("correction_ack",):
            tool.tool_status = "near_eol"
    else:
        if tool.tool_status in ("near_eol", "eol", "blocked"):
            tool.tool_status = "ok"
    return tool.tool_status or "ok"


def parse_cavities(raw) -> list:
    """Normalize cavities_json into [{id,name,enabled,part_no}, ...]."""
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        data = raw
    else:
        try:
            data = json.loads(raw)
        except Exception:
            return []
    if not isinstance(data, list):
        return []
    out = []
    for i, row in enumerate(data):
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        cid = str(row.get("id") or f"c{i + 1}")
        out.append({
            "id": cid,
            "name": name,
            "enabled": bool(row.get("enabled")),
            "part_no": str(row.get("part_no") or "").strip() or None,
        })
    return out


def dump_cavities(cavities) -> Optional[str]:
    rows = parse_cavities(cavities if isinstance(cavities, list) else (cavities or []))
    if not rows:
        return None
    # Exactly one cavity may be active for production logging
    enabled_idxs = [i for i, r in enumerate(rows) if r.get("enabled")]
    if not enabled_idxs:
        rows[0]["enabled"] = True
    elif len(enabled_idxs) > 1:
        keep = enabled_idxs[0]
        for i, r in enumerate(rows):
            r["enabled"] = i == keep
    return json.dumps(rows)


def active_cavity(tool: ToolStock) -> Optional[dict]:
    cavities = parse_cavities(getattr(tool, "cavities_json", None))
    enabled = [c for c in cavities if c.get("enabled")]
    if enabled:
        return enabled[0]
    return cavities[0] if cavities else None


def effective_part_no(tool: ToolStock) -> Optional[str]:
    """Part number used for production logging — active cavity overrides mold-level part_no."""
    cav = active_cavity(tool)
    if cav and cav.get("part_no"):
        return cav["part_no"]
    pn = getattr(tool, "part_no", None)
    return (str(pn).strip() or None) if pn else None


def serialize_tool(tool: ToolStock) -> dict:
    stock = float(tool.stock_qty or 0)
    min_s = float(tool.min_stock or 0)
    limit = int(tool.life_cycles_limit or 0) or None
    used = float(tool.cycles_used or 0)
    ratio = life_ratio(tool)
    warn = tool.life_warning_pct if tool.life_warning_pct is not None else 90
    cycles_remaining = (limit - used) if limit else None
    status = refresh_tool_status(tool)
    cavities = parse_cavities(getattr(tool, "cavities_json", None))
    active = active_cavity(tool)
    eff_part = effective_part_no(tool)
    return {
        "id": tool.id,
        "tool_code": tool.tool_code,
        "tool_name": tool.tool_name,
        "mold_name": tool.tool_name,
        "unit": tool.unit or "pcs",
        "stock_qty": stock,
        "min_stock": min_s,
        "below_min": stock < min_s,
        "sap_material_no": tool.sap_material_no,
        "stock_source": tool.stock_source or "manual",
        "last_synced_at": tool.last_synced_at.isoformat() if tool.last_synced_at else None,
        "life_cycles_limit": limit,
        "cycles_used": used,
        "cycles_remaining": cycles_remaining,
        "life_warning_pct": warn,
        "life_used_pct": round(ratio * 100, 1) if ratio is not None else None,
        "cycles_per_part": float(tool.cycles_per_part or 1),
        "tool_status": status,
        "qr_code": tool.qr_code,
        "qr_scan_enabled": QR_SCAN_ENABLED,
        "notes": tool.notes,
        "part_no": getattr(tool, "part_no", None),
        "effective_part_no": eff_part,
        "standard_cavity": getattr(tool, "standard_cavity", None),
        "running_cavity": getattr(tool, "running_cavity", None),
        "customer_name": getattr(tool, "customer_name", None),
        "rm_grade": getattr(tool, "rm_grade", None),
        "standard_cycle_time": float(tool.standard_cycle_time) if getattr(tool, "standard_cycle_time", None) is not None else None,
        "std_shot_weight": float(tool.std_shot_weight) if getattr(tool, "std_shot_weight", None) is not None else None,
        "std_part_weight": float(tool.std_part_weight) if getattr(tool, "std_part_weight", None) is not None else None,
        "std_runner_weight": float(tool.std_runner_weight) if getattr(tool, "std_runner_weight", None) is not None else None,
        "colour": getattr(tool, "colour", None),
        "target_per_shift": getattr(tool, "target_per_shift", None),
        "cavities": cavities,
        "active_cavity": active,
        "active_cavity_name": (active or {}).get("name") if active else None,
        "active": tool.active,
        "created_at": tool.created_at,
        "updated_at": tool.updated_at,
    }


def _open_alert(
    db: Session,
    tool: ToolStock,
    alert_type: str,
    message: str,
    severity: str = "warning",
    meta: Optional[dict] = None,
) -> Optional[ToolAlert]:
    existing = (
        db.query(ToolAlert)
        .filter(
            ToolAlert.tool_id == tool.id,
            ToolAlert.alert_type == alert_type,
            ToolAlert.acknowledged == 0,
            ToolAlert.suppressed == 0,
        )
        .first()
    )
    if existing:
        existing.message = message
        if meta is not None:
            existing.meta_json = json.dumps(meta)
        return existing
    alert = ToolAlert(
        tool_id=tool.id,
        alert_type=alert_type,
        severity=severity,
        message=message,
        suppressed=0,
        acknowledged=0,
        meta_json=json.dumps(meta) if meta else None,
        created_at=now_ist(),
    )
    db.add(alert)
    return alert


def evaluate_stock_and_life_alerts(db: Session, tool: ToolStock) -> list[ToolAlert]:
    """Raise (or refresh) low-stock / near-EOL / EOL alerts. Returns new/updated alerts."""
    raised = []
    stock = float(tool.stock_qty or 0)
    min_s = float(tool.min_stock or 0)
    status = refresh_tool_status(tool)

    if min_s > 0 and stock < min_s:
        a = _open_alert(
            db, tool, "low_stock",
            f"{tool.tool_code}: stock {stock} below min {min_s}",
            severity="alert",
            meta={"stock_qty": stock, "min_stock": min_s},
        )
        if a:
            raised.append(a)

    ratio = life_ratio(tool)
    if ratio is not None:
        if status in ("eol", "blocked") or ratio >= 1.0:
            a = _open_alert(
                db, tool, "eol",
                f"{tool.tool_code}: end of life ({float(tool.cycles_used or 0):.0f}/{tool.life_cycles_limit} cycles) — replace or acknowledge correction",
                severity="alert",
                meta={"cycles_used": float(tool.cycles_used or 0), "limit": tool.life_cycles_limit},
            )
            if a:
                raised.append(a)
        elif status == "near_eol" or ratio >= (tool.life_warning_pct or 90) / 100.0:
            a = _open_alert(
                db, tool, "near_eol",
                f"{tool.tool_code}: near end of life ({round(ratio * 100, 1)}% of {tool.life_cycles_limit} cycles)",
                severity="warning",
                meta={"cycles_used": float(tool.cycles_used or 0), "limit": tool.life_cycles_limit},
            )
            if a:
                raised.append(a)
    return raised


def log_event(
    db: Session,
    tool: ToolStock,
    event_type: str,
    *,
    user_id: Optional[int] = None,
    qty_delta: Optional[float] = None,
    cycles_before: Optional[float] = None,
    cycles_after: Optional[float] = None,
    work_order_id: Optional[int] = None,
    plan_id: Optional[int] = None,
    part_id: Optional[int] = None,
    machine_id: Optional[int] = None,
    location: Optional[str] = None,
    notes: Optional[str] = None,
    acknowledged_by: Optional[int] = None,
    qr_scanned: bool = False,
) -> ToolEvent:
    before = cycles_before if cycles_before is not None else float(tool.cycles_used or 0)
    after = cycles_after if cycles_after is not None else before
    ev = ToolEvent(
        tool_id=tool.id,
        event_type=event_type,
        qty_delta=qty_delta,
        cycles_before=before,
        cycles_after=after,
        cycles_delta=(after - before) if after is not None and before is not None else None,
        work_order_id=work_order_id,
        plan_id=plan_id,
        part_id=part_id,
        machine_id=machine_id,
        location=location,
        notes=notes,
        acknowledged_by=acknowledged_by,
        qr_scanned=1 if qr_scanned else 0,
        qr_suppressed=0 if QR_SCAN_ENABLED else 1,
        created_by=user_id,
        created_at=now_ist(),
    )
    db.add(ev)
    return ev


def find_tool(db: Session, *, tool_code: Optional[str] = None, tool_name: Optional[str] = None) -> Optional[ToolStock]:
    if tool_code:
        row = db.query(ToolStock).filter(ToolStock.tool_code == tool_code.strip()).first()
        if row:
            return row
    if tool_name:
        return db.query(ToolStock).filter(ToolStock.tool_name == tool_name.strip()).first()
    return None


def find_tool_by_mold_no(db: Session, mold_no: Optional[str]) -> Optional[ToolStock]:
    """Resolve Mold Monitoring mold_no to Mold Management (ToolStock) master."""
    key = (mold_no or "").strip()
    if not key:
        return None
    tool = find_tool(db, tool_code=key, tool_name=key)
    if tool:
        return tool
    low = key.lower()
    # Case-insensitive match on code / name / part no
    row = (
        db.query(ToolStock)
        .filter(
            ToolStock.active == 1,
            or_(
                func.lower(ToolStock.tool_code) == low,
                func.lower(ToolStock.tool_name) == low,
                func.lower(ToolStock.part_no) == low,
            ),
        )
        .first()
    )
    if row:
        return row
    # Active-cavity effective part_no (JSON) — small catalog, scan once
    for t in db.query(ToolStock).filter(ToolStock.active == 1).all():
        eff = effective_part_no(t)
        if eff and str(eff).strip().lower() == low:
            return t
    return None


def apply_shot_mold_usage(
    db: Session,
    machine_id: int,
    shots: int,
    *,
    source: str = "shot",
) -> Optional[dict]:
    """Increment active ImmMold usage + linked ToolStock life when shots are counted.

    Updates Mold Monitoring Uses / maintenance cycles and Mold Management
    cycles_used + history (ToolEvent) so both stay in sync with shot count.
    """
    n = int(shots or 0)
    if n <= 0:
        return None

    mold = (
        db.query(ImmMold)
        .filter(ImmMold.machine_id == machine_id, ImmMold.is_active == 1)
        .first()
    )
    if not mold:
        return None

    mold.usage_count = int(mold.usage_count or 0) + n
    mold.cycles_after_maintenance = int(mold.cycles_after_maintenance or 0) + n
    mold.updated_at = now_ist()

    machine = db.query(Machine).filter(Machine.id == machine_id).first()
    location = machine.name if machine else f"Machine {machine_id}"

    tool_payload = None
    tool = find_tool_by_mold_no(db, mold.mold_no)
    if tool:
        before = float(tool.cycles_used or 0)
        after = before + n
        tool.cycles_used = after
        tool.updated_at = now_ist()
        refresh_tool_status(tool)
        log_event(
            db,
            tool,
            "shot",
            cycles_before=before,
            cycles_after=after,
            machine_id=machine_id,
            location=location,
            notes=f"IMM shot cycle (+{n}) via {source}",
        )
        evaluate_stock_and_life_alerts(db, tool)
        tool_payload = {
            "tool_id": tool.id,
            "tool_code": tool.tool_code,
            "cycles_used": after,
        }

    return {
        "mold_id": mold.id,
        "mold_no": mold.mold_no,
        "usage_count": mold.usage_count,
        "cycles_after_maintenance": mold.cycles_after_maintenance,
        "shots": n,
        "tool": tool_payload,
    }


def _wo_tool_rows(wo: WorkOrder) -> list[dict]:
    raw = wo.spares_tools_json
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def build_forecast(
    db: Session,
    *,
    work_order_id: int,
    planned_qty: int,
) -> dict[str, Any]:
    wo = db.query(WorkOrder).filter(WorkOrder.id == work_order_id).first()
    if not wo:
        return {"ok": False, "error": "Work order not found", "tools": [], "requires_ack": False, "blocks_plan": False}

    rows = _wo_tool_rows(wo)
    tools_out = []
    requires_ack = False
    blocks_plan = False

    for row in rows:
        code = (row.get("tool_no") or "").strip() or None
        name = (row.get("name") or "").strip() or None
        req_per_run = float(row.get("qty") or 1)
        required_qty = req_per_run  # stock units required for this plan slot set
        # Scale stock requirement lightly with planned qty only when qty looks like per-part
        # Keep required as declared WO spare qty (planner-entered); cycles scale with planned_qty.
        tool = find_tool(db, tool_code=code, tool_name=name)
        if not tool:
            tools_out.append({
                "tool_code": code,
                "tool_name": name,
                "mapped": False,
                "stock_available": None,
                "required_qty": required_qty,
                "remaining_after": None,
                "status": "unmapped",
                "can_plan": True,
                "requires_ack": False,
                "message": "Tool not in Tool Management inventory",
            })
            continue

        refresh_tool_status(tool)
        stock = float(tool.stock_qty or 0)
        remaining_after = stock - required_qty
        cpp = float(tool.cycles_per_part or 1)
        cycles_needed = planned_qty * cpp
        used = float(tool.cycles_used or 0)
        limit = int(tool.life_cycles_limit or 0) or None
        projected = used + cycles_needed
        status = tool.tool_status or "ok"
        msg_parts = []

        short_stock = remaining_after < 0
        row_requires_ack = False
        can_plan = True

        if short_stock:
            row_requires_ack = True
            msg_parts.append(f"Stock short by {abs(remaining_after):.0f}")

        if status == "blocked":
            can_plan = False
            blocks_plan = True
            msg_parts.append("Tool blocked — replace required")
        elif status == "eol":
            can_plan = False
            blocks_plan = True
            msg_parts.append("End of life — replace or acknowledge tool correction before planning")
        elif status == "correction_ack":
            row_requires_ack = True
            msg_parts.append("Running under tool-correction acknowledgment")
            if limit and projected >= limit * 1.05:
                can_plan = False
                blocks_plan = True
                msg_parts.append("Correction window exceeded — replace tool")

        if limit and can_plan:
            if projected >= limit and status != "correction_ack":
                row_requires_ack = True
                msg_parts.append(f"Plan would reach/exceed life ({projected:.0f}/{limit} cycles)")
            elif projected >= limit * ((tool.life_warning_pct or 90) / 100.0):
                row_requires_ack = True
                msg_parts.append(f"Plan drives tool near EOL ({projected:.0f}/{limit})")

        if row_requires_ack:
            requires_ack = True

        tools_out.append({
            "tool_id": tool.id,
            "tool_code": tool.tool_code,
            "tool_name": tool.tool_name,
            "mapped": True,
            "stock_available": stock,
            "required_qty": required_qty,
            "remaining_after": remaining_after,
            "cycles_used": used,
            "life_cycles_limit": limit,
            "cycles_remaining": (limit - used) if limit else None,
            "cycles_needed": cycles_needed,
            "projected_cycles_after": projected if limit else None,
            "life_used_pct": round((used / limit) * 100, 1) if limit else None,
            "tool_status": status,
            "can_plan": can_plan,
            "requires_ack": row_requires_ack,
            "message": "; ".join(msg_parts) if msg_parts else "OK",
        })

    requires_ack = any(t.get("requires_ack") for t in tools_out)
    blocks_plan = any(not t.get("can_plan", True) for t in tools_out if t.get("mapped"))

    return {
        "ok": True,
        "work_order_id": work_order_id,
        "work_order_no": wo.work_order_no,
        "planned_qty": planned_qty,
        "tools": tools_out,
        "requires_ack": requires_ack and not blocks_plan,
        "blocks_plan": blocks_plan,
        "qr_scan_enabled": QR_SCAN_ENABLED,
        "message": (
            "Cannot plan — one or more tools are end-of-life / blocked. Replace or acknowledge correction first."
            if blocks_plan
            else (
                "Tool stock / life forecast requires planner acknowledgment to proceed."
                if requires_ack
                else "Tool forecast OK"
            )
        ),
    }


def apply_consumption_safe(
    db: Session,
    plan: ProductionPlan,
    prev_actual: int,
    new_actual: int,
    *,
    user_id: Optional[int] = None,
) -> list[dict]:
    delta = max(int(new_actual) - int(prev_actual or 0), 0)
    if delta <= 0 or not plan.work_order_id:
        return []
    wo = db.query(WorkOrder).filter(WorkOrder.id == plan.work_order_id).first()
    if not wo:
        return []
    machine = db.query(Machine).filter(Machine.id == plan.machine_id).first() if plan.machine_id else None
    location = f"Stn {plan.station_no} · {machine.name if machine else '—'} · {plan.plan_date} Shift {plan.shift}"
    results = []
    for row in _wo_tool_rows(wo):
        tool = find_tool(db, tool_code=(row.get("tool_no") or None), tool_name=(row.get("name") or None))
        if not tool:
            continue
        cavities = parse_cavities(getattr(tool, "cavities_json", None))
        # Multi-fixture mold: production logs only against the enabled cavity
        if cavities and not any(c.get("enabled") for c in cavities):
            results.append({
                "skipped": True,
                "tool_id": tool.id,
                "reason": "No active cavity selected — enable a cavity name to log production",
            })
            continue
        cav = active_cavity(tool)
        cav_name = (cav or {}).get("name") if cav else None
        cav_part = effective_part_no(tool)
        cpp = float(tool.cycles_per_part or 1)
        add = delta * cpp
        before = float(tool.cycles_used or 0)
        after = before + add
        tool.cycles_used = after
        tool.updated_at = now_ist()
        refresh_tool_status(tool)
        cav_label = f" · cavity {cav_name}" if cav_name else ""
        part_label = f" · part {cav_part}" if cav_part else ""
        log_event(
            db, tool, "consumed",
            user_id=user_id,
            cycles_before=before,
            cycles_after=after,
            work_order_id=wo.id,
            plan_id=plan.id,
            part_id=wo.part_id,
            machine_id=plan.machine_id,
            location=f"{location}{cav_label}{part_label}",
            notes=(
                f"Consumed {add:.0f} cycles from plan actual (+{delta} pcs)"
                f"{cav_label}{part_label}"
            ),
        )
        # Keep plan model_variant aligned with active cavity part when empty/placeholder
        if cav_part and plan is not None:
            mv = (getattr(plan, "model_variant", None) or "").strip()
            if not mv or mv in ("00", "-", "—"):
                plan.model_variant = cav_part
        evaluate_stock_and_life_alerts(db, tool)
        results.append(serialize_tool(tool))
    return results
