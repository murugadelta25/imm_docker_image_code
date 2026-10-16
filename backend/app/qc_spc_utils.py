"""Build SPC chart series from QC inspection hourly readings."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .qc_shift_utils import COL_FIRST, COL_OPERATOR_START, col_operator_end, col_to_instance_key


def parse_measured_value(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text.upper() in ("OK", "NOK", "VISUAL", "—", "-"):
        return None
    m = re.search(r"[-+]?\d*\.?\d+", text)
    return float(m.group()) if m else None


def resolve_spec_limits(row: dict) -> Optional[dict]:
    """Prefer explicit LSL/USL; else parse std_value."""
    lsl = row.get("lsl")
    usl = row.get("usl")
    if lsl is not None and usl is not None:
        try:
            lsl_f = float(lsl)
            usl_f = float(usl)
            return {
                "nominal": (lsl_f + usl_f) / 2,
                "usl": max(usl_f, lsl_f),
                "lsl": min(usl_f, lsl_f),
            }
        except (TypeError, ValueError):
            pass
    return parse_spec_limits(row.get("std_value") or "")


def parse_spec_limits(std_value: str) -> Optional[dict]:
    """Parse std_value into nominal / USL / LSL when possible."""
    if not std_value:
        return None
    s = str(std_value).replace("Ø", "").replace("ø", "").strip()
    if re.search(r"visual", s, re.I):
        return None

    m = re.match(r"([\d.]+)\s*-\s*([\d.]+)", s)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        return {"nominal": (a + b) / 2, "usl": max(a, b), "lsl": min(a, b)}

    m = re.match(r"([\d.]+)\s*±\s*([\d.]+)", s)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        if b < a:
            # e.g. Ø34.2±33.9 → USL 34.2, LSL 33.9 (range, not symmetric tolerance)
            return {"nominal": (a + b) / 2, "usl": max(a, b), "lsl": min(a, b)}
        tol = b
        if tol >= a:
            tol = abs(a - b) / 2
        return {"nominal": a, "usl": a + tol, "lsl": a - tol}

    m = re.search(r"([\d.]+)", s)
    if m:
        nominal = float(m.group(1))
        return {"nominal": nominal, "usl": nominal, "lsl": nominal}
    return None


def _slot_label(key: str, inst: dict) -> str:
    if key == "first":
        return "1st"
    return inst.get("label") or f"H{key}"


def _chart_note(limits: Optional[dict], points: List[dict]) -> Optional[str]:
    has_numeric = any(p.get("value") is not None for p in points)
    has_readings = any(str(p.get("raw_value") or "").strip() for p in points)
    if limits is None:
        return "Visual / non-numeric spec — shown as pass/fail readings only"
    if not has_numeric:
        if has_readings:
            return "Readings are OK/NOK — enter numeric values to enable SPC trend chart"
        return "No readings yet for this parameter"
    return None


def _pass_fail(raw: str) -> Optional[str]:
    text = str(raw or "").strip().upper()
    if text == "OK":
        return "pass"
    if text == "NOK":
        return "fail"
    return None


def _param_key(name: str) -> str:
    return (name or "").strip().casefold()


def enrich_readings_with_part_limits(readings: List[dict], part_params: List[dict]) -> List[dict]:
    """Part master is source of truth for numeric limits and STD display on SPC."""
    if not part_params:
        return readings
    by_name = {_param_key(p.get("parameter")): p for p in part_params if p.get("parameter")}
    enriched = []
    for row in readings:
        r = dict(row)
        pm = by_name.get(_param_key(r.get("parameter")))
        if pm:
            if pm.get("std_value"):
                r["std_value"] = pm["std_value"]
            if pm.get("is_numeric") and pm.get("lsl") is not None and pm.get("usl") is not None:
                r["is_numeric"] = True
                r["lsl"] = pm["lsl"]
                r["usl"] = pm["usl"]
        enriched.append(r)
    return enriched


def detect_parameter_warnings(points: List[dict], limits: Optional[dict]) -> List[dict]:
    """SPC trend warnings: run on same side of nominal; repeated out-of-spec."""
    if not limits:
        return []
    numeric = [p for p in points if p.get("value") is not None]
    if not numeric:
        return []

    warnings: List[dict] = []
    nominal = limits["nominal"]
    lsl = limits["lsl"]
    usl = limits["usl"]

    run = 0
    side = None
    for p in reversed(numeric):
        v = p["value"]
        s = "above" if v > nominal else ("below" if v < nominal else "on")
        if s == "on":
            break
        if side is None:
            side = s
            run = 1
        elif s == side:
            run += 1
        else:
            break

    if run >= 6:  # more than 5 consecutive
        dir_label = "above" if side == "above" else "below"
        warnings.append({
            "code": "same_side_run",
            "severity": "warning",
            "message": (
                f"Similar trend: last {run} readings are on the same side of nominal "
                f"({dir_label} {nominal}) — process may be drifting"
            ),
        })

    oos = [p for p in numeric if p["value"] < lsl or p["value"] > usl]
    if len(oos) >= 3:  # more than 2 out-of-spec
        warnings.append({
            "code": "threshold_exceeded",
            "severity": "warning",
            "message": (
                f"Threshold exceeded: {len(oos)} readings are outside "
                f"LSL ({lsl}) / USL ({usl}) — not normal variation"
            ),
        })

    return warnings


def build_spc_payload(report_out: dict) -> dict:
    """Return per-parameter time-series for SPC charts."""
    approval = report_out.get("approval") or {}
    instances = approval.get("instances") or {}
    hour_slots = approval.get("hour_slots") or []
    readings = report_out.get("readings") or []
    op_end = col_operator_end(approval)

    slot_keys: List[str] = ["first"]
    slot_keys.extend(slot["key"] for slot in hour_slots)

    parameters: List[dict] = []
    for row in readings:
        param = row.get("parameter") or ""
        std_value = row.get("std_value") or ""
        limits = resolve_spec_limits(row)
        cells = row.get("cells") or []

        points = []
        for key in slot_keys:
            col = COL_FIRST if key == "first" else COL_OPERATOR_START + int(key) - 1
            if col > op_end and key != "first":
                continue
            inst = instances.get(key, {})
            status = inst.get("status", "empty")
            raw = cells[col] if col < len(cells) else ""
            value = parse_measured_value(raw)
            if value is None and not str(raw or "").strip():
                continue
            points.append({
                "instance_key": key,
                "label": _slot_label(key, inst),
                "hour_start": inst.get("hour_start"),
                "hour_end": inst.get("hour_end"),
                "status": status,
                "raw_value": str(raw or ""),
                "value": value,
                "pass_fail": _pass_fail(raw),
                "in_spec": (
                    limits is not None
                    and value is not None
                    and limits["lsl"] <= value <= limits["usl"]
                ) if limits and value is not None else (
                    _pass_fail(raw) == "pass" if _pass_fail(raw) else None
                ),
            })

        param_warnings = detect_parameter_warnings(points, limits)
        for w in param_warnings:
            w["parameter"] = param

        parameters.append({
            "parameter": param,
            "std_value": std_value,
            "is_numeric": bool(row.get("is_numeric")),
            "lsl": row.get("lsl"),
            "usl": row.get("usl"),
            "limits": limits,
            "points": points,
            "warnings": param_warnings,
            "chartable": limits is not None and any(p.get("value") is not None for p in points),
            "chart_note": _chart_note(limits, points),
        })

    report_warnings: List[dict] = []
    for p in parameters:
        report_warnings.extend(p.get("warnings") or [])

    return {
        "report_id": report_out.get("id"),
        "article_no": report_out.get("article_no"),
        "part_id": report_out.get("part_id"),
        "machine_id": report_out.get("machine_id"),
        "machine_name": report_out.get("machine_name"),
        "shift": report_out.get("shift"),
        "inspection_date": report_out.get("inspection_date"),
        "hour_slots": hour_slots,
        "parameters": parameters,
        "warnings": report_warnings,
    }
