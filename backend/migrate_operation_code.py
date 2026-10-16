"""Rename machine_code → operation_code on parts and QC inspection reports."""
from sqlalchemy import inspect, text
from app.models import engine

RENAMES = [
    ("parts", "machine_code", "operation_code"),
    ("qc_inspection_reports", "machine_code", "operation_code"),
]


def main():
    insp = inspect(engine)
    existing = {f"{t}.{c['name']}" for t in insp.get_table_names() for c in insp.get_columns(t)}
    for table, old_col, new_col in RENAMES:
        if f"{table}.{new_col}" in existing:
            print(f"[SKIP] {table}.{new_col} (already renamed)")
            continue
        if f"{table}.{old_col}" not in existing:
            print(f"[SKIP] {table}.{old_col} (column not found)")
            continue
        stmt = (
            f"ALTER TABLE {table} CHANGE COLUMN {old_col} {new_col} VARCHAR(50) NULL"
        )
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            print(f"[OK] {table}.{old_col} → {new_col}")
        except Exception as exc:
            if "Unknown column" in str(exc) or "check that column" in str(exc).lower():
                print(f"[SKIP] {table}.{old_col}")
            else:
                raise


if __name__ == "__main__":
    main()
