"""Migrate process_time / loading_unloading to DECIMAL for fractional cycle times.
Run once from backend/: python migrate_ct_decimal.py"""
from app.models import engine
from sqlalchemy import text


def _column_names(conn, table: str) -> list[str]:
    return [r[0] for r in conn.execute(text(f"SHOW COLUMNS FROM {table}")).fetchall()]


def migrate_oee_entries(conn):
    cols = _column_names(conn, "oee_entries")
    if "cycle_time" in cols:
        conn.execute(text("ALTER TABLE oee_entries DROP COLUMN cycle_time"))
        print("Dropped oee_entries.cycle_time (will recreate as DECIMAL)")

    conn.execute(text("""
        ALTER TABLE oee_entries
        MODIFY COLUMN process_time DECIMAL(10,2) NULL,
        MODIFY COLUMN loading_unloading DECIMAL(10,2) NULL
    """))
    print("Updated oee_entries.process_time / loading_unloading to DECIMAL(10,2)")

    cols = _column_names(conn, "oee_entries")
    if "cycle_time" not in cols:
        conn.execute(text("""
            ALTER TABLE oee_entries
            ADD COLUMN cycle_time DECIMAL(10,2)
            AS (`process_time` + `loading_unloading`) STORED
        """))
        print("Recreated oee_entries.cycle_time as DECIMAL STORED GENERATED")


def migrate_production_plans(conn):
    conn.execute(text("""
        ALTER TABLE production_plans
        MODIFY COLUMN process_time DECIMAL(10,2) NOT NULL,
        MODIFY COLUMN loading_unloading DECIMAL(10,2) NOT NULL DEFAULT 10.00
    """))
    print("Updated production_plans.process_time / loading_unloading to DECIMAL(10,2)")


def run():
    with engine.begin() as conn:
        migrate_oee_entries(conn)
        migrate_production_plans(conn)
    print("Migration complete!")


if __name__ == "__main__":
    run()
