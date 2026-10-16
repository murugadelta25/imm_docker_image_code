"""Add machine_id column to oee_entries. Run once: python migrate_oee_machine.py"""
from app.models import engine
from sqlalchemy import text


def run():
    with engine.begin() as conn:
        cols = [r[0] for r in conn.execute(text("SHOW COLUMNS FROM oee_entries")).fetchall()]
        if "machine_id" not in cols:
            conn.execute(text(
                "ALTER TABLE oee_entries ADD COLUMN machine_id INT NULL AFTER station_no"
            ))
            print("Added machine_id column to oee_entries")
        else:
            print("machine_id column already exists")
    print("Migration complete!")


if __name__ == "__main__":
    run()
