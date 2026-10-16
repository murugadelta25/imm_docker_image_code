"""Add cycle_profile_json column to parts table."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.models import engine
from sqlalchemy import text

def run():
    with engine.begin() as conn:
        result = conn.execute(text("SHOW COLUMNS FROM parts LIKE 'cycle_profile_json'"))
        if result.fetchone():
            print("cycle_profile_json already exists — skipping.")
            return
        conn.execute(text("ALTER TABLE parts ADD COLUMN cycle_profile_json TEXT NULL DEFAULT NULL"))
        print("Added cycle_profile_json to parts table.")

if __name__ == "__main__":
    run()
