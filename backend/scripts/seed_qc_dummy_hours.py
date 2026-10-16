"""Seed QC report: 3 numeric parameters (SPC) + Thread OK/NOK only."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import SessionLocal, QcInspectionReport
from app.qc_shift_utils import (
    build_hour_slots,
    ensure_approval_structure,
    cell_count_for,
    COL_FIRST,
    COL_OPERATOR_START,
)
from app.routers.hourly_output import _load_config

# Parameter seed rules — any row matching name uses this pattern (dynamic per report rows).
NUMERIC_SPECS = {
    "Facing head": {
        "std_value": "14.5-14.70",
        "is_numeric": True,
        "lsl": 14.5,
        "usl": 14.70,
        "first": "14.55",
        "hours": {1: "14.58", 2: "14.62", 3: "14.72", 4: "14.60", 5: "14.56"},  # H3 out of spec
    },
    "Thread Length": {
        "std_value": "13.5-12.0",
        "is_numeric": True,
        "lsl": 12.0,
        "usl": 13.5,
        "first": "13.2",
        "hours": {1: "13.0", 2: "12.85", 3: "13.1", 4: "11.9", 5: "12.95"},  # H4 below LSL
    },
    "Inner Dia": {
        "std_value": "34.35-34.05",
        "is_numeric": True,
        "lsl": 34.05,
        "usl": 34.35,
        "first": "34.18",
        "hours": {1: "34.12", 2: "34.20", 3: "34.15", 4: "34.08", 5: "34.22"},  # H5 above USL
    },
}

OK_NOK_ONLY = {"Thread"}


def shift_slots(db, shift_id: str):
    config = _load_config(db)
    shift = next((s for s in config.get("shifts", []) if s.get("id") == shift_id), None)
    if not shift:
        return build_hour_slots("08:00", "20:00")
    return build_hour_slots(shift.get("start", "08:00"), shift.get("end", "14:30"))


def _blank_cells(cc: int) -> list:
    return [""] * cc


def _apply_numeric_row(row: dict, spec: dict, cc: int) -> None:
    row["std_value"] = spec["std_value"]
    row["is_numeric"] = spec.get("is_numeric", True)
    row["lsl"] = spec.get("lsl")
    row["usl"] = spec.get("usl")
    cells = list(row.get("cells") or [])
    if len(cells) < cc:
        cells = cells + [""] * (cc - len(cells))
    cells = cells[:cc]
    cells[COL_FIRST] = spec.get("first", "")
    for h, val in spec.get("hours", {}).items():
        col = COL_OPERATOR_START + h - 1
        if col < cc:
            cells[col] = val
    h6_col = COL_OPERATOR_START + 5
    if h6_col < cc:
        cells[h6_col] = ""
    row["cells"] = cells


def _apply_ok_nok_row(row: dict, cc: int) -> None:
    cells = list(row.get("cells") or [])
    if len(cells) < cc:
        cells = cells + [""] * (cc - len(cells))
    cells = cells[:cc]
    ok_nok_pattern = ["OK", "OK", "OK", "NOK", "OK", ""]
    cells[COL_FIRST] = "OK"
    for h in range(1, 7):
        col = COL_OPERATOR_START + h - 1
        if col < cc:
            cells[col] = ok_nok_pattern[h - 1] if h - 1 < len(ok_nok_pattern) else ""
    row["cells"] = cells


def seed_report(report: QcInspectionReport, db) -> None:
    slots = shift_slots(db, report.shift or "A")
    approval = ensure_approval_structure(
        json.loads(report.approval_json or "{}"),
        slots,
    )
    cc = cell_count_for(approval)
    instances = approval.get("instances") or {}

    instances["first"] = {**instances.get("first", {}), "status": "pending_inspector"}
    for h in range(1, 6):
        key = str(h)
        if key in instances:
            instances[key] = {**instances[key], "status": "frozen"}
    if "6" in instances:
        instances["6"] = {**instances["6"], "status": "empty"}

    approval["instances"] = instances

    saved = json.loads(report.readings_json or "[]")
    if not saved:
        saved = [
            {"parameter": "Thread", "std_value": "M37x1.5", "cells": _blank_cells(cc)},
            {"parameter": "Thread Length", "std_value": "13.5-12.0", "cells": _blank_cells(cc)},
            {"parameter": "Inner Dia", "std_value": "34.35-34.05", "cells": _blank_cells(cc)},
            {"parameter": "Facing head", "std_value": "14.5-14.70", "cells": _blank_cells(cc)},
        ]

    numeric_count = 0
    ok_nok_count = 0
    for row in saved:
        name = row.get("parameter") or ""
        if name in OK_NOK_ONLY:
            _apply_ok_nok_row(row, cc)
            ok_nok_count += 1
        elif name in NUMERIC_SPECS:
            _apply_numeric_row(row, NUMERIC_SPECS[name], cc)
            numeric_count += 1
        else:
            # Any other dynamic parameter: default to numeric if std looks like a range
            std = str(row.get("std_value") or "")
            if "-" in std and any(c.isdigit() for c in std):
                _apply_numeric_row(row, {
                    "std_value": std,
                    "first": "0",
                    "hours": {i: str(12.0 + i * 0.1) for i in range(1, 6)},
                }, cc)
                numeric_count += 1
            else:
                _apply_ok_nok_row(row, cc)
                ok_nok_count += 1

    report.readings_json = json.dumps(saved)
    report.approval_json = json.dumps(approval)
    report.status = "pending_inspector"
    db.commit()
    print(
        f"Seeded report #{report.id} shift={report.shift} columns={cc} "
        f"numeric_params={numeric_count} ok_nok_params={ok_nok_count}"
    )


def main():
    db = SessionLocal()
    try:
        report = (
            db.query(QcInspectionReport)
            .filter(QcInspectionReport.status.in_((
                "draft", "in_progress", "pending_inspector", "pending_incharge",
            )))
            .order_by(QcInspectionReport.id.desc())
            .first()
        )
        if not report:
            report = db.query(QcInspectionReport).order_by(QcInspectionReport.id.desc()).first()
        if not report:
            print("No QC report found.")
            return
        seed_report(report, db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
