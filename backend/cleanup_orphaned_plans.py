"""
Cleanup script for orphaned production plans.

An orphaned plan is one whose work_order_id references a work_order that no
longer exists in the work_orders table.

Usage:
    python cleanup_orphaned_plans.py            # delete orphaned plans
    python cleanup_orphaned_plans.py --dry-run  # only print, do not delete
"""
import argparse
import sys

from app.models import SessionLocal, ProductionPlan, WorkOrder


def main():
    parser = argparse.ArgumentParser(description="Remove orphaned production plans.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print orphaned plans; do not delete them.",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        # Find plans whose work_order_id is set but points to a non-existent work order
        all_wo_ids = {row[0] for row in db.query(WorkOrder.id).all()}

        orphaned = (
            db.query(ProductionPlan)
            .filter(
                ProductionPlan.work_order_id.isnot(None),
                ProductionPlan.work_order_id.notin_(all_wo_ids) if all_wo_ids
                else ProductionPlan.work_order_id.isnot(None),
            )
            .all()
        )

        if not orphaned:
            print("No orphaned plans found.")
            sys.exit(0)

        print(f"Found {len(orphaned)} orphaned plan(s):")
        for plan in orphaned:
            name_field = (
                getattr(plan, "current_operation", None)
                or getattr(plan, "model_variant", None)
                or "(no name)"
            )
            print(
                f"  plan id={plan.id}  name/operation={name_field!r}"
                f"  work_order_id={plan.work_order_id}"
                f"  plan_date={plan.plan_date}  status={plan.status}"
            )

        if args.dry_run:
            print("\n[dry-run] No changes made.")
            sys.exit(0)

        # Delete orphaned plans
        for plan in orphaned:
            db.delete(plan)
        db.commit()
        print(f"\nDeleted {len(orphaned)} orphaned plan(s).")
        sys.exit(0)

    except Exception as exc:
        db.rollback()
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
