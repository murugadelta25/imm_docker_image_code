"""Add QC approval columns, part image, extra QC columns."""
from sqlalchemy import inspect, text
from app.models import engine

ALTERS = [
    "ALTER TABLE parts ADD COLUMN image_url VARCHAR(500) NULL",
    "ALTER TABLE parts ADD COLUMN qc_columns_json TEXT NULL",
    "ALTER TABLE part_qc_parameters ADD COLUMN extra_columns_json TEXT NULL",
    "ALTER TABLE part_qc_parameters ADD COLUMN is_numeric TINYINT DEFAULT 0",
    "ALTER TABLE part_qc_parameters ADD COLUMN lsl DOUBLE NULL",
    "ALTER TABLE part_qc_parameters ADD COLUMN usl DOUBLE NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN status VARCHAR(30) DEFAULT 'draft'",
    "ALTER TABLE qc_inspection_reports ADD COLUMN operator_id INT NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN inspector_id INT NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN incharge_id INT NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN operator_approved_at DATETIME NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN inspector_approved_at DATETIME NULL",
    "ALTER TABLE qc_inspection_reports ADD COLUMN incharge_approved_at DATETIME NULL",
]


def main():
    insp = inspect(engine)
    existing = {f"{t}.{c['name']}" for t in insp.get_table_names() for c in insp.get_columns(t)}
    for stmt in ALTERS:
        col = stmt.split("ADD COLUMN ")[1].split()[0]
        table = stmt.split("ALTER TABLE ")[1].split()[0]
        if f"{table}.{col}" in existing:
            print(f"[SKIP] {table}.{col}")
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            print(f"[OK] {table}.{col}")
        except Exception as exc:
            if "Duplicate column" in str(exc):
                print(f"[SKIP] {table}.{col}")
            else:
                raise


if __name__ == "__main__":
    main()
