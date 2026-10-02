"""Seed IMM Mold Master into tool_stocks (+ sync ImmMold names on machines)."""
from __future__ import annotations

import json
import re
from typing import Optional

from app.models import SessionLocal, ToolStock, ImmMold, Machine, now_ist
from app.tool_service import dump_cavities, refresh_tool_status

# Mould Master sheet (15 rows)
MOLD_MASTER = [
    {
        "sr_no": 1,
        "mould_name": "Flange",
        "standard_cavity": 8,
        "running_cavity": 8,
        "standard_cycle_time": 40,
        "std_shot_weight": 65,
        "std_part_weight": 48,
        "std_runner_weight": 17,
        "part_no": None,
        "customer_name": "PFDB",
        "rm_grade": "POM Celocon M90",
        "colour": "White",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 2,
        "mould_name": "Numerator Box",
        "standard_cavity": 4,
        "running_cavity": 4,
        "standard_cycle_time": 60,
        "std_shot_weight": 126,
        "std_part_weight": 116,
        "std_runner_weight": 10,
        "part_no": None,
        "customer_name": "PFDB",
        "rm_grade": "IM 11BC-7035",
        "colour": "Black",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 3,
        "mould_name": "Rubber Mat 1290",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 45,
        "std_shot_weight": 225,
        "std_part_weight": 225,
        "std_runner_weight": 0,
        "part_no": None,
        "customer_name": "GRT",
        "rm_grade": None,
        "colour": None,
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 4,
        "mould_name": "GRT Thread Mould",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 90,
        "std_shot_weight": 130,
        "std_part_weight": 124,
        "std_runner_weight": 6,
        "part_no": None,
        "customer_name": "GRT",
        "rm_grade": "Polycarbonate",
        "colour": "Grey",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 5,
        "mould_name": "Bracket",
        "standard_cavity": 2,
        "running_cavity": 2,
        "standard_cycle_time": 65,
        "std_shot_weight": 36,
        "std_part_weight": 30,
        "std_runner_weight": 6,
        "part_no": None,
        "customer_name": "SMR",
        "rm_grade": "Duracon POM CD 3068",
        "colour": "Black",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 6,
        "mould_name": "Cover 3P",
        "standard_cavity": 2,
        "running_cavity": 2,
        "standard_cycle_time": 60,
        "std_shot_weight": 46,
        "std_part_weight": 45,
        "std_runner_weight": 1,
        "part_no": None,
        "customer_name": "Legrand",
        "rm_grade": "44 CM6G 1360",
        "colour": None,
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 7,
        "mould_name": "FAK Box Green",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 45,
        "std_shot_weight": 60,
        "std_part_weight": 60,
        "std_runner_weight": 0,
        "part_no": None,
        "customer_name": "Apollo",
        "rm_grade": "SRM 100",
        "colour": "Green",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 8,
        "mould_name": "Flex Trim",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 65,
        "std_shot_weight": 35,
        "std_part_weight": 35,
        "std_runner_weight": 0,
        "part_no": None,
        "customer_name": "Cruiser Accessories",
        "rm_grade": "Rubber-MARA1",
        "colour": "Black",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 9,
        "mould_name": "Mountain",
        "standard_cavity": 2,
        "running_cavity": 2,
        "standard_cycle_time": 55,
        "std_shot_weight": 32,
        "std_part_weight": 27,
        "std_runner_weight": 5,
        "part_no": None,
        "customer_name": "Cruiser Accessories",
        "rm_grade": "SD 0150U",
        "colour": "Black K2007",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 10,
        "mould_name": "FAK Lid",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 30,
        "std_shot_weight": 37.5,
        "std_part_weight": 37,
        "std_runner_weight": 0.5,
        "part_no": None,
        "customer_name": "Apollo",
        "rm_grade": "SRM 100 NC",
        "colour": "Natural",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 11,
        "mould_name": "Index Cover",
        "standard_cavity": 4,
        "running_cavity": 4,
        "standard_cycle_time": 110,
        "std_shot_weight": 62,
        "std_part_weight": 52,
        "std_runner_weight": 10,
        "part_no": "120070764",
        "customer_name": "PFDB",
        "rm_grade": "PC",
        "colour": "Natural",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 12,
        "mould_name": "Q5 Cap",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 55,
        "std_shot_weight": 24,
        "std_part_weight": 20,
        "std_runner_weight": 4,
        "part_no": None,
        "customer_name": "Sintex BPEL",
        "rm_grade": None,
        "colour": None,
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 13,
        "mould_name": "Cover 4P",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 45,
        "std_shot_weight": 31,
        "std_part_weight": 30,
        "std_runner_weight": 1,
        "part_no": None,
        "customer_name": "Legrand",
        "rm_grade": "44 CM6G 1360",
        "colour": None,
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 14,
        "mould_name": "DIR Cover",
        "standard_cavity": 1,
        "running_cavity": 1,
        "standard_cycle_time": 65,
        "std_shot_weight": 61,
        "std_part_weight": 55.5,
        "std_runner_weight": 5.5,
        "part_no": None,
        "customer_name": "Legrand",
        "rm_grade": "44 CM6G 3980",
        "colour": "Grey",
        "target_per_shift": 0,
        "cavity_name": None,
    },
    {
        "sr_no": 15,
        "mould_name": "63A Base Cover",
        "standard_cavity": 2,
        "running_cavity": 2,
        "standard_cycle_time": 35,
        "std_shot_weight": 43,
        "std_part_weight": 39,
        "std_runner_weight": 4,
        "part_no": None,
        "customer_name": "Legrand",
        "rm_grade": "BKV25fn27-703130BC100W",
        "colour": "Grey",
        "target_per_shift": 0,
        "cavity_name": "Base,Cover",
    },
]


def _code_for(name: str, sr_no: int) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", (name or "").strip()).strip("-").upper()
    slug = slug[:40] or f"MOLD-{sr_no:03d}"
    return f"MM-{sr_no:03d}-{slug}"


def _cavities_from(row: dict) -> Optional[list]:
    raw = (row.get("cavity_name") or "").strip()
    if not raw:
        return None
    parts = [p.strip() for p in re.split(r"[,;/|]+", raw) if p.strip()]
    if not parts:
        return None
    return [
        {"id": f"c{i + 1}", "name": name, "enabled": i == 0, "part_no": None}
        for i, name in enumerate(parts)
    ]


def seed_tool_stocks(db) -> dict:
    created = updated = 0
    now = now_ist()
    for row in MOLD_MASTER:
        code = _code_for(row["mould_name"], row["sr_no"])
        existing = (
            db.query(ToolStock).filter(ToolStock.tool_code == code).first()
            or db.query(ToolStock).filter(ToolStock.tool_name == row["mould_name"]).first()
        )
        cavities = _cavities_from(row)
        fields = dict(
            tool_name=row["mould_name"],
            unit="pcs",
            stock_qty=1,
            min_stock=0,
            stock_source="manual",
            life_cycles_limit=100000,
            cycles_used=0,
            life_warning_pct=90,
            cycles_per_part=1,
            qr_code=code,
            notes=f"Seeded from Mould Master Sr.{row['sr_no']}",
            part_no=row.get("part_no"),
            standard_cavity=row.get("standard_cavity"),
            running_cavity=row.get("running_cavity") or row.get("standard_cavity"),
            customer_name=row.get("customer_name"),
            rm_grade=row.get("rm_grade"),
            standard_cycle_time=row.get("standard_cycle_time"),
            std_shot_weight=row.get("std_shot_weight"),
            std_part_weight=row.get("std_part_weight"),
            std_runner_weight=row.get("std_runner_weight"),
            colour=row.get("colour"),
            target_per_shift=row.get("target_per_shift") or 0,
            cavities_json=dump_cavities(cavities) if cavities else None,
            active=1,
            updated_at=now,
        )
        if existing:
            for k, v in fields.items():
                setattr(existing, k, v)
            refresh_tool_status(existing)
            updated += 1
        else:
            t = ToolStock(tool_code=code, created_at=now, **fields)
            refresh_tool_status(t)
            db.add(t)
            created += 1
    db.commit()
    return {"created": created, "updated": updated, "total": len(MOLD_MASTER)}


def sync_imm_molds(db) -> dict:
    """Map placeholder ImmMold rows to real master names; ensure each machine has master catalog."""
    machines = db.query(Machine).order_by(Machine.id).all()
    if not machines:
        return {"machines": 0, "synced": 0}

    # Deduplicate active molds per machine (keep lowest id)
    for m in machines:
        actives = (
            db.query(ImmMold)
            .filter(ImmMold.machine_id == m.id, ImmMold.is_active == 1)
            .order_by(ImmMold.id)
            .all()
        )
        for extra in actives[1:]:
            extra.is_active = 0

    name_by_sr = {r["sr_no"]: r["mould_name"] for r in MOLD_MASTER}
    synced = 0
    now = now_ist()

    # Rename existing MOLD-000N placeholders
    for mold in db.query(ImmMold).all():
        m = re.match(r"^MOLD-0*(\d+)$", (mold.mold_no or "").strip(), re.I)
        if m:
            sr = int(m.group(1))
            if sr in name_by_sr:
                mold.mold_no = name_by_sr[sr]
                mold.notes = (mold.notes or "") or f"Linked to Mold Master Sr.{sr}"
                mold.updated_at = now
                synced += 1

    # Ensure every machine has all master molds available for Change Mold
    for machine in machines:
        rows = (
            db.query(ImmMold)
            .filter(ImmMold.machine_id == machine.id)
            .order_by(ImmMold.is_active.desc(), ImmMold.id)
            .all()
        )
        existing_names = set()
        for r in rows:
            key = (r.mold_no or "").strip().lower()
            if key in existing_names:
                db.delete(r)
                synced += 1
                continue
            existing_names.add(key)

        has_active = (
            db.query(ImmMold)
            .filter(ImmMold.machine_id == machine.id, ImmMold.is_active == 1)
            .first()
            is not None
        )
        for i, row in enumerate(MOLD_MASTER):
            name = row["mould_name"]
            if name.strip().lower() in existing_names:
                continue
            activate = (not has_active) and i == 0
            db.add(
                ImmMold(
                    machine_id=machine.id,
                    mold_no=name,
                    usage_count=0,
                    usage_max=100000,
                    cycles_after_maintenance=0,
                    maintenance_limit=25000,
                    is_active=1 if activate else 0,
                    notes=f"From Mold Master Sr.{row['sr_no']}",
                    created_at=now,
                    updated_at=now,
                )
            )
            existing_names.add(name.strip().lower())
            if activate:
                has_active = True
            synced += 1

    db.commit()
    return {"machines": len(machines), "synced": synced}


def main():
    db = SessionLocal()
    try:
        stock = seed_tool_stocks(db)
        imm = sync_imm_molds(db)
        print(json.dumps({"tool_stocks": stock, "imm_molds": imm}, indent=2))
    finally:
        db.close()


if __name__ == "__main__":
    main()
