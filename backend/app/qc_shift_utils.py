"""Shift hour slots and QC inspection instance helpers."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

COL_FIRST = 0
COL_OPERATOR_START = 1
MAX_OPERATOR_SLOTS = 24
DEFAULT_OPERATOR_SLOTS = 8


def _parse_mins(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _fmt_mins(mins: int) -> str:
    mins = mins % (24 * 60)
    return f"{mins // 60:02d}:{mins % 60:02d}"


def shift_duration_minutes(shift_start: str, shift_end: str) -> int:
    start_m = _parse_mins(shift_start)
    end_m = _parse_mins(shift_end)
    if end_m <= start_m:
        return (24 * 60 - start_m) + end_m
    return end_m - start_m


def shift_hour_count(shift_start: str, shift_end: str) -> int:
    """One inspection column per clock hour in the shift (H1..Hn)."""
    total = shift_duration_minutes(shift_start, shift_end)
    if total <= 0:
        return DEFAULT_OPERATOR_SLOTS
    hours = max(1, (total + 59) // 60)
    return min(hours, MAX_OPERATOR_SLOTS)


def build_hour_slots(shift_start: str, shift_end: str, count: Optional[int] = None) -> List[dict]:
    """Build one-hour inspection slots from shift start to end."""
    if count is None:
        count = shift_hour_count(shift_start, shift_end)
    start_m = _parse_mins(shift_start)
    total = shift_duration_minutes(shift_start, shift_end)
    if total <= 0 or count <= 0:
        return []
    slots = []
    for i in range(count):
        slot_start = start_m + i * 60
        slot_end = min(start_m + (i + 1) * 60, start_m + total)
        if slot_start >= start_m + total:
            break
        slots.append({
            "instance": i + 1,
            "key": str(i + 1),
            "start": _fmt_mins(slot_start),
            "end": _fmt_mins(slot_end),
            "label": f"H{i + 1} ({_fmt_mins(slot_start)}–{_fmt_mins(slot_end)})",
        })
    return slots


def operator_count_from_approval(approval: Optional[dict]) -> int:
    slots = (approval or {}).get("hour_slots") or []
    if slots:
        return len(slots)
    return DEFAULT_OPERATOR_SLOTS


def col_operator_end(approval: Optional[dict]) -> int:
    return COL_OPERATOR_START + operator_count_from_approval(approval) - 1


def col_inspector_start(approval: Optional[dict]) -> int:
    return COL_OPERATOR_START + operator_count_from_approval(approval)


def col_inspector_end(approval: Optional[dict]) -> int:
    return col_inspector_start(approval) + 1


def cell_count_for(approval: Optional[dict]) -> int:
    return 1 + operator_count_from_approval(approval) + 2


def col_to_instance_key(col: int, approval: Optional[dict] = None) -> Optional[str]:
    if col == COL_FIRST:
        return "first"
    op_end = col_operator_end(approval)
    if COL_OPERATOR_START <= col <= op_end:
        return str(col - COL_OPERATOR_START + 1)
    return None


def instance_key_to_col(key: str, approval: Optional[dict] = None) -> Optional[int]:
    if key == "first":
        return COL_FIRST
    try:
        n = int(key)
    except (TypeError, ValueError):
        return None
    op_count = operator_count_from_approval(approval)
    if 1 <= n <= op_count:
        return COL_OPERATOR_START + n - 1
    return None


def _now_mins(now: datetime) -> int:
    return now.hour * 60 + now.minute


def default_instances_meta(hour_slots: List[dict]) -> Dict[str, dict]:
    meta: Dict[str, dict] = {"first": {"status": "empty", "label": "1st piece"}}
    for slot in hour_slots:
        meta[slot["key"]] = {
            "status": "empty",
            "label": slot["label"],
            "hour_start": slot["start"],
            "hour_end": slot["end"],
        }
    return meta


def ensure_approval_structure(approval: Optional[dict], hour_slots: List[dict]) -> dict:
    approval = dict(approval or {})
    valid_keys = {"first", *(slot["key"] for slot in hour_slots)}
    instances = {
        k: v for k, v in dict(approval.get("instances") or {}).items()
        if k in valid_keys
    }
    for key, default in default_instances_meta(hour_slots).items():
        if key not in instances:
            instances[key] = default
        else:
            # Shift config owns slot labels and hour windows.
            overrides = {"label": default["label"]}
            if "hour_start" in default:
                overrides["hour_start"] = default["hour_start"]
            if "hour_end" in default:
                overrides["hour_end"] = default["hour_end"]
            instances[key] = {**default, **instances[key], **overrides}
    approval["instances"] = instances
    approval["hour_slots"] = hour_slots
    approval["operator_slot_count"] = len(hour_slots)
    return approval


def apply_missed_instances(approval: dict, now: datetime) -> dict:
    instances = approval.get("instances") or {}
    now_m = _now_mins(now)
    for key, inst in instances.items():
        if key == "first":
            continue
        status = inst.get("status", "empty")
        if status not in ("empty", "draft"):
            continue
        end_m = _parse_mins(inst.get("hour_end", "23:59"))
        if now_m >= end_m:
            inst["status"] = "missed"
    approval["instances"] = instances
    return approval


def current_editable_instance(approval: dict, now: datetime) -> Optional[str]:
    instances = approval.get("instances") or {}
    first = instances.get("first", {})
    if first.get("status") in ("empty", "draft"):
        return "first"
    now_m = _now_mins(now)
    for slot in approval.get("hour_slots") or []:
        key = slot["key"]
        inst = instances.get(key, {})
        status = inst.get("status", "empty")
        if status in ("missed", "pending_inspector", "pending_incharge", "approved", "rejected", "frozen"):
            continue
        start_m = _parse_mins(inst.get("hour_start", "00:00"))
        end_m = _parse_mins(inst.get("hour_end", "23:59"))
        if now_m >= start_m and now_m < end_m:
            return key
        if status in ("empty", "draft") and now_m < end_m:
            return key
    return None


def instance_status_color(status: str) -> str:
    if status in ("approved", "frozen"):
        return "green"
    if status in ("pending_inspector", "pending_incharge", "draft"):
        return "yellow"
    if status == "rejected":
        return "red"
    if status == "missed":
        return "gray"
    return "neutral"


def recompute_report_status(approval: dict) -> str:
    instances = (approval or {}).get("instances") or {}
    statuses = [v.get("status", "empty") for v in instances.values()]
    if any(s == "pending_inspector" for s in statuses):
        return "pending_inspector"
    if any(s == "pending_incharge" for s in statuses):
        return "pending_incharge"
    if any(s == "rejected" for s in statuses):
        return "in_progress"
    if any(s in ("approved", "frozen", "pending_incharge") for s in statuses):
        return "in_progress"
    return "draft"


def column_is_frozen(approval: dict, col: int) -> bool:
    key = col_to_instance_key(col, approval)
    if not key:
        return col in (col_inspector_start(approval), col_inspector_end(approval))
    inst = (approval.get("instances") or {}).get(key, {})
    return inst.get("status") in (
        "pending_inspector", "pending_incharge", "approved", "frozen", "rejected",
    )


def column_is_missed(approval: dict, col: int) -> bool:
    key = col_to_instance_key(col, approval)
    if not key or key == "first":
        return False
    return (approval.get("instances") or {}).get(key, {}).get("status") == "missed"


def column_editable_for_operator(approval: dict, col: int, now: datetime) -> bool:
    if col in (col_inspector_start(approval), col_inspector_end(approval)):
        return False
    if column_is_frozen(approval, col) or column_is_missed(approval, col):
        return False
    key = col_to_instance_key(col, approval)
    if not key:
        return False
    return key == current_editable_instance(approval, now)


def pending_instances(approval: dict, target_status: str) -> List[str]:
    return [
        k for k, v in (approval.get("instances") or {}).items()
        if v.get("status") == target_status
    ]


def snapshot_inspector_cells(readings: List[dict], approval: dict) -> List[List[str]]:
    ci0 = col_inspector_start(approval)
    ci1 = col_inspector_end(approval)
    cc = cell_count_for(approval)
    return [
        [
            str((row.get("cells") or [""] * cc)[ci0] or ""),
            str((row.get("cells") or [""] * cc)[ci1] or ""),
        ]
        for row in readings
    ]


def normalize_cells(cells: List[Any], approval: dict) -> List[str]:
    cc = cell_count_for(approval)
    out = [str(c) if c is not None else "" for c in (cells or [])]
    while len(out) < cc:
        out.append("")
    return out[:cc]
