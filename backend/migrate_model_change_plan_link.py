"""Link model_change_requests to production plans."""
from sqlalchemy import inspect, text
from app.models import engine

ALTERS = [
    "ALTER TABLE model_change_requests ADD COLUMN plan_id INT NULL",
    "ALTER TABLE model_change_requests MODIFY COLUMN from_model VARCHAR(100) NULL",
    "ALTER TABLE model_change_requests MODIFY COLUMN to_model VARCHAR(100) NULL",
]


def main():
    insp = inspect(engine)
    existing = {f"{t}.{c['name']}" for t in insp.get_table_names() for c in insp.get_columns(t)}
    for stmt in ALTERS:
        if "ADD COLUMN" in stmt:
            col = stmt.split("ADD COLUMN ")[1].split()[0]
            table = stmt.split("ALTER TABLE ")[1].split()[0]
            if f"{table}.{col}" in existing:
                print(f"[SKIP] {table}.{col}")
                continue
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            print(f"[OK] {stmt}")
        except Exception as exc:
            if "Duplicate column" in str(exc):
                print(f"[SKIP] {stmt}")
            else:
                raise
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE INDEX idx_mcr_plan ON model_change_requests (plan_id)"
            ))
        print("[OK] index idx_mcr_plan")
    except Exception as exc:
        print(f"[SKIP] index: {exc}")


if __name__ == "__main__":
    main()
