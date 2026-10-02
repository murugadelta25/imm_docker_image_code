"""Create / upgrade tool_stocks + tool_events + tool_alerts tables."""
from sqlalchemy import inspect, text
from app.models import engine, ToolStock, ToolEvent, ToolAlert

TOOL_STOCK_COLS = {
    "life_cycles_limit": "INT NULL",
    "cycles_used": "DECIMAL(14,2) NULL DEFAULT 0",
    "life_warning_pct": "INT NULL DEFAULT 90",
    "cycles_per_part": "DECIMAL(10,4) NULL DEFAULT 1",
    "tool_status": "VARCHAR(30) NULL DEFAULT 'ok'",
    "qr_code": "VARCHAR(100) NULL",
    "part_no": "VARCHAR(100) NULL",
    "standard_cavity": "INT NULL",
    "running_cavity": "INT NULL",
    "customer_name": "VARCHAR(150) NULL",
    "rm_grade": "VARCHAR(100) NULL",
    "standard_cycle_time": "DECIMAL(12,4) NULL",
    "std_shot_weight": "DECIMAL(14,4) NULL",
    "std_part_weight": "DECIMAL(14,4) NULL",
    "std_runner_weight": "DECIMAL(14,4) NULL",
    "colour": "VARCHAR(80) NULL",
    "target_per_shift": "INT NULL",
    "cavities_json": "TEXT NULL",
}


def main():
    insp = inspect(engine)
    if not insp.has_table("tool_stocks"):
        ToolStock.__table__.create(bind=engine)
        print("[OK] tool_stocks table created")
    else:
        cols = {c["name"] for c in insp.get_columns("tool_stocks")}
        with engine.begin() as conn:
            for name, ddl in TOOL_STOCK_COLS.items():
                if name not in cols:
                    conn.execute(text(f"ALTER TABLE tool_stocks ADD COLUMN {name} {ddl}"))
                    print(f"[OK] tool_stocks.{name} added")

    if not insp.has_table("tool_events"):
        ToolEvent.__table__.create(bind=engine)
        print("[OK] tool_events table created")
    else:
        print("[SKIP] tool_events exists")

    if not insp.has_table("tool_alerts"):
        ToolAlert.__table__.create(bind=engine)
        print("[OK] tool_alerts table created")
    else:
        print("[SKIP] tool_alerts exists")


if __name__ == "__main__":
    main()
