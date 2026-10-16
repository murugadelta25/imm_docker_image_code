"""Test the full machines router logic including auth simulation"""
import traceback
from app.models import get_db, Machine, User
from app.routers.machines import _compute_status

db = next(get_db())

# Test 1: single machine GET /{id}
print("=== GET /api/machines/1 ===")
try:
    m = db.query(Machine).filter(Machine.id == 1).first()
    result = {
        "id": m.id, "name": m.name, "pair_id": m.pair_id,
        "status": m.status, "machine_type": m.machine_type,
        "make": m.make, "model_no": m.model_no, "tonnage": m.tonnage,
        "features": m.features, "image_url": m.image_url, "location": m.location,
        "plc_source": m.plc_source, "plc_endpoint": m.plc_endpoint, "plc_topic": m.plc_topic,
    }
    print("OK:", result)
except Exception:
    traceback.print_exc()

# Test 2: list machines GET /
print("\n=== GET /api/machines/ ===")
try:
    from app.models import Pair
    machines = db.query(Machine).order_by(Machine.pair_id, Machine.id).all()
    for m in machines:
        pair = db.query(Pair).filter(Pair.id == m.pair_id).first()
        d = {
            "id": m.id, "name": m.name, "pair_id": m.pair_id,
            "pair_name": pair.display_name if pair else "Unknown",
            "status": m.status,
        }
        print("OK:", d)
except Exception:
    traceback.print_exc()

# Test 3: fleet GET /fleet
print("\n=== GET /api/machines/fleet ===")
try:
    machines = db.query(Machine).order_by(Machine.pair_id, Machine.id).all()
    for m in machines:
        live = _compute_status(m, db)
        print(f"  machine {m.id}: stored={m.status}, computed={live}")
except Exception:
    traceback.print_exc()

# Test 4: breakdown/machines
print("\n=== GET /api/breakdown/machines ===")
try:
    machines = db.query(Machine).order_by(Machine.pair_id, Machine.id).all()
    result = [{"id": m.id, "name": m.name, "pair_id": m.pair_id, "status": m.status,
               "machine_type": m.machine_type, "make": m.make, "image_url": m.image_url,
               "location": m.location, "plc_source": m.plc_source} for m in machines]
    print(f"OK: {len(result)} machines")
except Exception:
    traceback.print_exc()

print("\nDone.")
