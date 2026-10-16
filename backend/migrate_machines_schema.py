"""
Migrates the machines table from old schema (pair_no INT) to new schema
(pair_id FK -> pairs table), preserving existing machine data.
Run once: python migrate_machines_schema.py
"""
from app.models import engine
from sqlalchemy import text

def run():
    with engine.begin() as conn:
        # 1. Create pairs table if missing
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS pairs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                display_name VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))
        print("pairs table ready")

        # 2. Discover existing pair numbers from machines
        rows = conn.execute(text("SELECT DISTINCT pair_no FROM machines ORDER BY pair_no")).fetchall()
        for (pair_no,) in rows:
            conn.execute(text("""
                INSERT IGNORE INTO pairs (name, display_name)
                VALUES (:name, :display_name)
            """), {"name": f"pair_{pair_no}", "display_name": f"Pair {pair_no}"})
        print(f"Seeded {len(rows)} pair(s)")

        # 3. Add pair_id column if missing
        cols = [r[0] for r in conn.execute(text("SHOW COLUMNS FROM machines")).fetchall()]
        if "pair_id" not in cols:
            conn.execute(text("ALTER TABLE machines ADD COLUMN pair_id INT NULL AFTER name"))
            print("Added pair_id column")

        # 4. Populate pair_id from pair_no via the pairs table
        conn.execute(text("""
            UPDATE machines m
            JOIN pairs p ON p.name = CONCAT('pair_', m.pair_no)
            SET m.pair_id = p.id
        """))
        print("Populated pair_id values")

        # 5. Add new columns if missing
        new_cols = {
            "machine_type": "VARCHAR(50) DEFAULT 'CNC'",
            "make":          "VARCHAR(100)",
            "model_no":      "VARCHAR(100)",
            "tonnage":       "VARCHAR(50)",
            "features":      "TEXT",
            "image_url":     "VARCHAR(500)",
            "location":      "VARCHAR(100)",
            "plc_source":    "ENUM('manual','mqtt','modbus','opcua') DEFAULT 'manual'",
            "plc_endpoint":  "VARCHAR(255)",
            "plc_topic":     "VARCHAR(255)",
        }
        for col, definition in new_cols.items():
            if col not in cols:
                conn.execute(text(f"ALTER TABLE machines ADD COLUMN {col} {definition}"))
                print(f"Added column: {col}")

        # 6. Make pair_id NOT NULL and add FK (drop pair_no FK first if exists)
        conn.execute(text("ALTER TABLE machines MODIFY COLUMN pair_id INT NOT NULL"))
        try:
            conn.execute(text("ALTER TABLE machines ADD CONSTRAINT fk_machine_pair FOREIGN KEY (pair_id) REFERENCES pairs(id)"))
            print("FK constraint added")
        except Exception as e:
            print(f"FK note: {e}")

        # 7. Drop old pair_no column
        if "pair_no" in cols:
            conn.execute(text("ALTER TABLE machines DROP COLUMN pair_no"))
            print("Dropped pair_no column")

        # 8. Fix production_plans pair_no reference (keep as-is, it's just an int field)
        # Fix model_change_requests machine_id FK if machines was recreated
        print("\nMigration complete!")

if __name__ == "__main__":
    run()
