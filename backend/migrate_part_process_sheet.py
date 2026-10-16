"""Add Process Control Sheet fields to parts table."""
from sqlalchemy import inspect, text
from app.models import engine

ALTERS = [
    "ALTER TABLE parts ADD COLUMN part_name VARCHAR(255) NULL",
    "ALTER TABLE parts ADD COLUMN input_material VARCHAR(255) NULL",
    "ALTER TABLE parts ADD COLUMN previous_operation VARCHAR(255) NULL",
    "ALTER TABLE parts ADD COLUMN next_operation VARCHAR(255) NULL",
    "ALTER TABLE parts ADD COLUMN machine_type VARCHAR(100) NULL",
    "ALTER TABLE parts ADD COLUMN operation_sequence TEXT NULL",
    "ALTER TABLE parts ADD COLUMN drawing_revision VARCHAR(50) NULL",
    "ALTER TABLE parts ADD COLUMN manufacturing_status VARCHAR(50) NULL DEFAULT 'production'",
    "ALTER TABLE parts ADD COLUMN manufacturing_status_other VARCHAR(100) NULL",
    "ALTER TABLE parts ADD COLUMN sketch_image_url VARCHAR(500) NULL",
    "ALTER TABLE parts ADD COLUMN tools_params_json TEXT NULL",
    "ALTER TABLE parts ADD COLUMN machine_params_json TEXT NULL",
    "ALTER TABLE parts ADD COLUMN jigs_fixtures_json TEXT NULL",
]

MODIFIES = [
    "ALTER TABLE parts MODIFY COLUMN operation_code VARCHAR(100) NULL",
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
    for stmt in MODIFIES:
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            print(f"[OK] {stmt}")
        except Exception as exc:
            print(f"[WARN] {stmt}: {exc}")


if __name__ == "__main__":
    main()
