"""Create work_orders table and link production_plans.work_order_id."""
from sqlalchemy import inspect, text
from app.models import engine, WorkOrder


def main():
    insp = inspect(engine)
    if not insp.has_table("work_orders"):
        WorkOrder.__table__.create(bind=engine)
        print("[OK] work_orders table created")
    else:
        print("[SKIP] work_orders table exists")

    if insp.has_table("production_plans"):
        cols = {c["name"] for c in insp.get_columns("production_plans")}
        if "work_order_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE production_plans ADD COLUMN work_order_id INT NULL"
                ))
                try:
                    conn.execute(text(
                        "ALTER TABLE production_plans ADD CONSTRAINT fk_plan_work_order "
                        "FOREIGN KEY (work_order_id) REFERENCES work_orders(id)"
                    ))
                except Exception:
                    pass
            print("[OK] production_plans.work_order_id column added")
        else:
            print("[SKIP] production_plans.work_order_id exists")


if __name__ == "__main__":
    main()
