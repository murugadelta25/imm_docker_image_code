from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..models import Station, Machine, get_db
from ..auth import get_current_user, require_role
from ..ws_manager import manager

router = APIRouter(prefix="/api/stations", tags=["stations"])


class StationCreate(BaseModel):
    name: str
    display_name: str


class StationUpdate(BaseModel):
    display_name: str


@router.get("/")
def list_stations(db: Session = Depends(get_db), _=Depends(get_current_user)):
    stations = db.query(Station).order_by(Station.id).all()
    result = []
    for s in stations:
        machine_count = db.query(Machine).filter(Machine.station_id == s.id).count()
        result.append({
            "id": s.id,
            "name": s.name,
            "display_name": s.display_name,
            "machine_count": machine_count,
        })
    return result


@router.post("/")
async def create_station(data: StationCreate, db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    existing = db.query(Station).filter(Station.name == data.name).first()
    if existing:
        raise HTTPException(400, f"Station name '{data.name}' already exists")

    s = Station(name=data.name, display_name=data.display_name)
    db.add(s)
    db.commit()
    db.refresh(s)
    await manager.broadcast({"type": "station_created", "id": s.id})
    return {"id": s.id, "name": s.name, "display_name": s.display_name}


@router.put("/{station_id}")
async def update_station(station_id: int, data: StationUpdate,
                         db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    s = db.query(Station).filter(Station.id == station_id).first()
    if not s:
        raise HTTPException(404, "Station not found")

    s.display_name = data.display_name
    db.commit()
    db.refresh(s)
    await manager.broadcast({"type": "station_updated", "id": s.id})
    return {"id": s.id, "name": s.name, "display_name": s.display_name}


@router.delete("/{station_id}")
async def delete_station(station_id: int, db: Session = Depends(get_db),
                         user=Depends(require_role("admin"))):
    s = db.query(Station).filter(Station.id == station_id).first()
    if not s:
        raise HTTPException(404, "Station not found")

    machine_count = db.query(Machine).filter(Machine.station_id == station_id).count()
    if machine_count > 0:
        raise HTTPException(
            400,
            f"Cannot delete station with {machine_count} machine(s) assigned. Reassign machines first."
        )

    db.delete(s)
    db.commit()
    await manager.broadcast({"type": "station_deleted", "id": station_id})
    return {"ok": True}


@router.get("/{station_id}/machines")
def get_station_machines(station_id: int, db: Session = Depends(get_db),
                         _=Depends(get_current_user)):
    s = db.query(Station).filter(Station.id == station_id).first()
    if not s:
        raise HTTPException(404, "Station not found")

    from ..energy_meter import is_energy_utility_machine

    machines = db.query(Machine).filter(Machine.station_id == station_id).order_by(Machine.id).all()
    return [
        {
            "id": m.id,
            "name": m.name,
            "machine_type": m.machine_type,
            "make": m.make,
            "model_no": m.model_no,
            "status": m.status,
        }
        for m in machines
        if not is_energy_utility_machine(m)
    ]
