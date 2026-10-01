"""IMM OPC UA APIs — catalog, live values, history, ingest, poll."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_role
from ..models import ImmOpcuaSample, ImmOpcuaTagMap, Machine, get_db, now_ist
from ..opcua_imm import (
    ensure_all_imm_tag_maps,
    ensure_machine_tag_maps,
    highlights_for_machine,
    ingest_samples,
    latest_payload,
    load_catalog,
    poll_machine_opcua,
    seed_param_defs,
    simulate_demo_samples,
)

router = APIRouter(prefix="/api/imm/opcua", tags=["imm-opcua"])


class SampleIn(BaseModel):
    param_key: Optional[str] = None
    key: Optional[str] = None
    tag: Optional[str] = None
    value: Optional[Any] = None
    value_num: Optional[float] = None
    value_text: Optional[str] = None
    quality: Optional[str] = "good"
    kpiv_tag: Optional[str] = None


class IngestBody(BaseModel):
    samples: List[SampleIn] = Field(default_factory=list)
    source: str = "bridge"
    write_history: bool = True
    sync_kpiv: bool = True


class TagMapPatch(BaseModel):
    param_key: str
    opcua_tag_name: Optional[str] = None
    opcua_node_id: Optional[str] = None
    enabled: Optional[bool] = None
    scale: Optional[float] = None
    offset: Optional[float] = None


class TagMapBulkBody(BaseModel):
    maps: List[TagMapPatch]


def _machine_or_404(db: Session, machine_id: int) -> Machine:
    m = db.query(Machine).filter(Machine.id == machine_id).first()
    if not m:
        raise HTTPException(404, "Machine not found")
    return m


@router.get("/catalog")
def get_catalog(_=Depends(get_current_user)):
    """Dia Edge parameter + utilities catalog from the requirements Excel."""
    return load_catalog()


@router.post("/bootstrap")
def bootstrap_opcua_schema(db: Session = Depends(get_db), _=Depends(require_role("admin"))):
    """Seed param defs and per-machine tag maps for IMM/OPCUA machines."""
    inserted = seed_param_defs(db)
    maps = ensure_all_imm_tag_maps(db)
    return {"param_defs_upserted": inserted, "tag_maps_created": maps}


@router.get("/equipment/{machine_id}/live")
def get_live(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    _machine_or_404(db, machine_id)
    params = latest_payload(db, machine_id)
    return {
        "machine_id": machine_id,
        "highlights": highlights_for_machine(db, machine_id),
        "parameters": params,
        "count": len(params),
    }


@router.get("/equipment/{machine_id}/history")
def get_history(
    machine_id: int,
    param_key: Optional[str] = None,
    hours: float = Query(1, ge=0.1, le=168),
    limit: int = Query(500, ge=1, le=5000),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    _machine_or_404(db, machine_id)
    since = now_ist() - timedelta(hours=hours)
    q = db.query(ImmOpcuaSample).filter(
        ImmOpcuaSample.machine_id == machine_id,
        ImmOpcuaSample.recorded_at >= since,
    )
    if param_key:
        q = q.filter(ImmOpcuaSample.param_key == param_key)
    rows = q.order_by(ImmOpcuaSample.recorded_at.desc()).limit(limit).all()
    return {
        "machine_id": machine_id,
        "hours": hours,
        "items": [
            {
                "param_key": r.param_key,
                "value_num": r.value_num,
                "value_text": r.value_text,
                "quality": r.quality,
                "source": r.source,
                "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
            }
            for r in rows
        ],
    }


@router.get("/equipment/{machine_id}/map")
def get_map(machine_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    _machine_or_404(db, machine_id)
    ensure_machine_tag_maps(db, machine_id)
    return {"machine_id": machine_id, "parameters": latest_payload(db, machine_id)}


@router.put("/equipment/{machine_id}/map")
def put_map(
    machine_id: int,
    body: TagMapBulkBody,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    _machine_or_404(db, machine_id)
    ensure_machine_tag_maps(db, machine_id)
    updated = 0
    for item in body.maps:
        row = (
            db.query(ImmOpcuaTagMap)
            .filter(
                ImmOpcuaTagMap.machine_id == machine_id,
                ImmOpcuaTagMap.param_key == item.param_key,
            )
            .first()
        )
        if not row:
            row = ImmOpcuaTagMap(machine_id=machine_id, param_key=item.param_key)
            db.add(row)
        if item.opcua_tag_name is not None:
            row.opcua_tag_name = item.opcua_tag_name
        if item.opcua_node_id is not None:
            row.opcua_node_id = item.opcua_node_id
        if item.enabled is not None:
            row.enabled = 1 if item.enabled else 0
        if item.scale is not None:
            row.scale = item.scale
        if item.offset is not None:
            row.offset = item.offset
        updated += 1
    db.commit()
    return {"updated": updated, "parameters": latest_payload(db, machine_id)}


@router.post("/equipment/{machine_id}/ingest")
def ingest(
    machine_id: int,
    body: IngestBody,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor", "operator", "maintenance")),
):
    """HTTP ingest from OPC UA bridge / Node-RED / Edge gateway."""
    _machine_or_404(db, machine_id)
    samples = [s.model_dump() for s in body.samples]
    if not samples:
        raise HTTPException(400, "samples required")
    result = ingest_samples(
        db,
        machine_id,
        samples,
        source=body.source or "bridge",
        write_history=body.write_history,
        sync_kpiv=body.sync_kpiv,
    )
    return result


@router.post("/equipment/{machine_id}/poll")
async def poll(
    machine_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    """Pull live values from machine.plc_endpoint using asyncua (if installed)."""
    machine = _machine_or_404(db, machine_id)
    if (machine.plc_source or "").lower() not in ("opcua", "manual", ""):
        # still allow poll if endpoint set
        pass
    result = await poll_machine_opcua(db, machine)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error") or "OPC UA poll failed")
    return result


@router.post("/equipment/{machine_id}/simulate")
def simulate(
    machine_id: int,
    db: Session = Depends(get_db),
    _=Depends(require_role("admin", "supervisor")),
):
    """Dev/demo: populate Dia Edge parameters with simulated values."""
    _machine_or_404(db, machine_id)
    return simulate_demo_samples(db, machine_id)
