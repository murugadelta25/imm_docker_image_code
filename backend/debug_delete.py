from app.models import get_db, Machine, BreakdownTicket, ModelChangeRequest, ProductionPlan

db = next(get_db())
machine_id = 1

try:
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    print(f"Machine: {m.name}")

    bd = db.query(BreakdownTicket).filter(BreakdownTicket.machine_id == machine_id).count()
    mc = db.query(ModelChangeRequest).filter(ModelChangeRequest.machine_id == machine_id).count()
    pp = db.query(ProductionPlan).filter(ProductionPlan.machine_id == machine_id).count()
    print(f"Will delete: {bd} tickets, {mc} model-change-requests, nullify {pp} plans")

    # Simulate without committing
    db.rollback()
    print("Dry run OK — no changes committed")
except Exception as e:
    import traceback
    traceback.print_exc()
finally:
    db.close()
