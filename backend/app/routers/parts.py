"""Part master, QC parameters, and work-instruction document management."""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from pathlib import Path
from datetime import date, datetime
import shutil
import uuid
import json
import re

from ..models import (
    Part, PartDocument, PartDocumentHistory, PartQcParameter,
    get_db, now_ist,
)
from ..auth import get_current_user, require_role
from ..upload_limits import (
    MAX_PDF_BYTES,
    MAX_IMAGE_BYTES,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MAX_OPTIONS_LIMIT,
    MAX_REVISION_HISTORY,
    save_upload_limited,
    clamp_page_size,
    assert_wi_doc_extension,
    wi_doc_max_bytes,
)

router = APIRouter(prefix="/api/parts", tags=["parts"])

UPLOAD_DIR = Path(__file__).parent.parent.parent / "static" / "work-instructions"
PART_IMAGE_DIR = Path(__file__).parent.parent.parent / "static" / "parts"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PART_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

BUILTIN_DOC_TYPES = [
    {"key": "control_plan", "label": "Control Plan"},
    {"key": "wi_visual", "label": "WI-Visual"},
    {"key": "breakdown_sheet", "label": "Breakdown Sheet"},
    {"key": "drawing_revision", "label": "Part / Drawing Revision"},
    {"key": "process_sheet_revision", "label": "Process Sheet Revision"},
    {"key": "wi_tray", "label": "WI-Tray"},
]
BUILTIN_DOC_LABELS = {d["key"]: d["label"] for d in BUILTIN_DOC_TYPES}


def _slugify_doc_type(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug or "custom_doc"


def _normalize_doc_type(doc_type: str) -> str:
    key = _slugify_doc_type(doc_type)
    if len(key) > 100:
        raise HTTPException(400, "Document type key is too long")
    return key


def _resolve_doc_label(doc_type: str, doc_label: Optional[str] = None) -> str:
    label = (doc_label or "").strip()
    if label:
        return label[:150]
    return BUILTIN_DOC_LABELS.get(doc_type) or doc_type.replace("_", " ").title()


def _doc_out(d) -> dict:
    return {
        "id": getattr(d, "id", None),
        "doc_type": d.doc_type,
        "doc_label": getattr(d, "doc_label", None) or _resolve_doc_label(d.doc_type),
        "revision": d.revision,
        "rev_date": d.rev_date.isoformat() if getattr(d, "rev_date", None) else None,
        "file_url": d.file_url,
        "notes": getattr(d, "notes", None),
        "is_current": getattr(d, "is_current", None),
        "uploaded_at": d.uploaded_at.isoformat() if getattr(d, "uploaded_at", None) else None,
        "archived_at": d.archived_at.isoformat() if getattr(d, "archived_at", None) else None,
        "part_id": getattr(d, "part_id", None),
    }

DEFAULT_QC_COLUMN_SCHEMA = [
    {"key": "method", "label": "Inspection Method"},
    {"key": "frequency", "label": "Inspection Frequency (Operator)"},
    {"key": "freq_inspector", "label": "Inspection Frequency (Inspector)"},
    {"key": "control_method", "label": "Control Method"},
]

DEFAULT_TOOLS_COLUMNS = [
    {"key": "tools_detail", "label": "Tools Detail"},
    {"key": "tool_no", "label": "Tool No"},
    {"key": "approx_tool_life", "label": "Approx Tool life"},
    {"key": "rpm", "label": "RPM"},
    {"key": "feed_mm_rev", "label": "Feed mm/rev"},
    {"key": "depth_of_cut", "label": "Depth of Cut"},
    {"key": "cutting_speed", "label": "Cutting speed m/min"},
]

DEFAULT_MACHINE_PARAM_COLUMNS = [
    {"key": "parameter", "label": "Parameter"},
    {"key": "specifications", "label": "Specifications"},
    {"key": "inspection_method", "label": "Inspection Method"},
    {"key": "inspection_frequency", "label": "Inspection Frequency"},
]

DEFAULT_JIGS_COLUMNS = [
    {"key": "drawing_number", "label": "Drawing Number"},
    {"key": "description", "label": "Description"},
]

MANUFACTURING_STATUSES = ("prototype", "pre-launch", "production", "other")


def _qc_column_schema(part: Part) -> list:
    raw = getattr(part, "qc_columns_json", None)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and parsed:
                return parsed
        except json.JSONDecodeError:
            pass
    return list(DEFAULT_QC_COLUMN_SCHEMA)


def _parse_cycle_profile(part: Part) -> Optional[dict]:
    raw = getattr(part, "cycle_profile_json", None)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _empty_param_table(default_columns: list) -> dict:
    return {"columns": list(default_columns), "rows": []}


def _parse_param_table(raw, default_columns: list) -> dict:
    if not raw:
        return _empty_param_table(default_columns)
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return _empty_param_table(default_columns)
    if not isinstance(parsed, dict):
        return _empty_param_table(default_columns)
    columns = parsed.get("columns")
    if not isinstance(columns, list) or not columns:
        columns = list(default_columns)
    else:
        columns = [
            {"key": c.get("key") or f"col_{i}", "label": c.get("label") or c.get("key") or ""}
            for i, c in enumerate(columns)
            if isinstance(c, dict)
        ] or list(default_columns)
    rows_in = parsed.get("rows") if isinstance(parsed.get("rows"), list) else []
    rows = []
    for row in rows_in:
        if not isinstance(row, dict):
            continue
        rows.append({col["key"]: row.get(col["key"], "") for col in columns})
    return {"columns": columns, "rows": rows}


def _serialize_param_table(data, default_columns: list) -> str:
    if not data or not isinstance(data, dict):
        return json.dumps(_empty_param_table(default_columns))
    columns = data.get("columns")
    if not isinstance(columns, list) or not columns:
        columns = list(default_columns)
    else:
        columns = [
            {"key": str(c.get("key") or f"col_{i}"), "label": str(c.get("label") or c.get("key") or "").strip()}
            for i, c in enumerate(columns)
            if isinstance(c, dict)
        ] or list(default_columns)
    rows_in = data.get("rows") if isinstance(data.get("rows"), list) else []
    rows = []
    for row in rows_in:
        if not isinstance(row, dict):
            continue
        rows.append({col["key"]: row.get(col["key"], "") for col in columns})
    return json.dumps({"columns": columns, "rows": rows})


def _safe_part_slug(part_no: str) -> str:
    """Flat filename slug — part numbers may contain / which breaks paths on disk."""
    slug = re.sub(r"[^\w.\-]+", "_", (part_no or "").strip())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug or "part"


def _write_upload(dest: Path, upload: UploadFile) -> None:
    """Legacy sync write — prefer save_upload_limited in async upload handlers."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with dest.open("wb") as buf:
            shutil.copyfileobj(upload.file, buf)
    except OSError as exc:
        raise HTTPException(500, f"Failed to save file: {exc}") from exc


def _part_summary_out(part: Part, db: Session) -> dict:
    qc_rows = (
        db.query(PartQcParameter.parameter)
        .filter(PartQcParameter.part_id == part.id, PartQcParameter.active == 1)
        .order_by(PartQcParameter.seq_no)
        .limit(8)
        .all()
    )
    qc_count = (
        db.query(PartQcParameter)
        .filter(PartQcParameter.part_id == part.id, PartQcParameter.active == 1)
        .count()
    )
    return {
        "id": part.id,
        "part_no": part.part_no,
        "model_variant": part.model_variant,
        "description": part.description,
        "image_url": part.image_url,
        "active": part.active,
        "qc_param_count": qc_count,
        "qc_parameter_preview": [r[0] for r in qc_rows if r[0]],
    }


def _apply_part_search(q, search: Optional[str]):
    if not search or not search.strip():
        return q
    term = f"%{search.strip().lower()}%"
    return q.filter(
        or_(
            func.lower(Part.part_no).like(term),
            func.lower(func.coalesce(Part.part_name, "")).like(term),
            func.lower(func.coalesce(Part.model_variant, "")).like(term),
            func.lower(func.coalesce(Part.description, "")).like(term),
            func.lower(func.coalesce(Part.tool_no, "")).like(term),
        )
    )


def _normalize_model_variant(part_no: str, model_variant: Optional[str]) -> str:
    """Use part_no when planning variant is empty or a short numeric placeholder (e.g. '00')."""
    pn = (part_no or "").strip()
    mv = (model_variant or "").strip()
    if not pn:
        return mv
    if not mv or mv == pn:
        return pn
    if len(mv) <= 3 and mv.isdigit():
        return pn
    return mv


class QcParamIn(BaseModel):
    seq_no: int = 1
    parameter: str
    std_value: Optional[str] = None
    method: Optional[str] = None
    frequency: Optional[str] = None
    is_numeric: bool = False
    lsl: Optional[float] = None
    usl: Optional[float] = None
    extra_columns: List[dict] = []
    active: int = 1


class ParamTableIn(BaseModel):
    columns: List[dict] = []
    rows: List[dict] = []


class PartCreate(BaseModel):
    part_no: str
    part_name: Optional[str] = None
    model_variant: Optional[str] = None
    description: Optional[str] = None
    tool_no: Optional[str] = None
    no_of_cavity: int = 1
    production_section: Optional[str] = None
    input_material: Optional[str] = None
    previous_operation: Optional[str] = None
    next_operation: Optional[str] = None
    machine_type: Optional[str] = None
    operation_code: Optional[str] = None
    operation_name: Optional[str] = None
    operation_sequence: Optional[str] = None
    process_time: Optional[float] = None
    loading_unloading: float = 10
    drawing_revision: Optional[str] = None
    manufacturing_status: Optional[str] = "production"
    manufacturing_status_other: Optional[str] = None
    qc_column_schema: List[dict] = []
    qc_parameters: List[QcParamIn] = []
    tools_parameters: Optional[ParamTableIn] = None
    machine_parameters: Optional[ParamTableIn] = None
    jigs_fixtures: Optional[ParamTableIn] = None
    cycle_profile: Optional[dict] = None


class PartUpdate(PartCreate):
    active: int = 1


def _qc_param_rows(part_id: int, qc_parameters: List[QcParamIn]):
    rows = []
    for qp in qc_parameters:
        rows.append(PartQcParameter(
            part_id=part_id,
            seq_no=qp.seq_no,
            parameter=qp.parameter,
            std_value=qp.std_value,
            method=qp.method,
            frequency=qp.frequency,
            is_numeric=1 if qp.is_numeric else 0,
            lsl=qp.lsl if qp.is_numeric else None,
            usl=qp.usl if qp.is_numeric else None,
            extra_columns_json=json.dumps(qp.extra_columns or []),
            active=qp.active,
            created_at=now_ist(),
        ))
    return rows


def _cycle_time(part: Part) -> float:
    return float(part.process_time or 0) + float(part.loading_unloading or 0)


def _normalize_manufacturing_status(status: Optional[str], other: Optional[str]) -> tuple:
    s = (status or "production").strip().lower()
    if s not in MANUFACTURING_STATUSES:
        s = "production"
    other_val = (other or "").strip() if s == "other" else None
    return s, other_val


def _apply_part_fields(part: Part, data: PartCreate) -> None:
    part.part_name = (data.part_name or "").strip() or None
    part.model_variant = _normalize_model_variant(data.part_no, data.model_variant)
    part.description = data.description
    part.tool_no = data.tool_no
    part.no_of_cavity = data.no_of_cavity
    part.production_section = data.production_section
    part.input_material = (data.input_material or "").strip() or None
    part.previous_operation = (data.previous_operation or "").strip() or None
    part.next_operation = (data.next_operation or "").strip() or None
    part.machine_type = (data.machine_type or "").strip() or None
    part.operation_code = data.operation_code
    part.operation_name = data.operation_name
    part.operation_sequence = (data.operation_sequence or "").strip() or None
    part.process_time = data.process_time
    part.loading_unloading = data.loading_unloading
    part.drawing_revision = (data.drawing_revision or "").strip() or None
    status, status_other = _normalize_manufacturing_status(
        data.manufacturing_status, data.manufacturing_status_other,
    )
    part.manufacturing_status = status
    part.manufacturing_status_other = status_other
    part.qc_columns_json = json.dumps(data.qc_column_schema or DEFAULT_QC_COLUMN_SCHEMA)
    part.tools_params_json = _serialize_param_table(
        data.tools_parameters.model_dump() if data.tools_parameters else None,
        DEFAULT_TOOLS_COLUMNS,
    )
    part.machine_params_json = _serialize_param_table(
        data.machine_parameters.model_dump() if data.machine_parameters else None,
        DEFAULT_MACHINE_PARAM_COLUMNS,
    )
    part.jigs_fixtures_json = _serialize_param_table(
        data.jigs_fixtures.model_dump() if data.jigs_fixtures else None,
        DEFAULT_JIGS_COLUMNS,
    )
    if data.cycle_profile is not None:
        part.cycle_profile_json = json.dumps(data.cycle_profile) if data.cycle_profile else None
    else:
        # preserve existing value on update — only overwrite when explicitly sent
        pass


def _part_out(part: Part, db: Session) -> dict:
    docs = db.query(PartDocument).filter(
        PartDocument.part_id == part.id,
        PartDocument.is_current == 1,
    ).all()
    qc = db.query(PartQcParameter).filter(
        PartQcParameter.part_id == part.id,
        PartQcParameter.active == 1,
    ).order_by(PartQcParameter.seq_no).all()
    return {
        "id": part.id,
        "part_no": part.part_no,
        "part_name": getattr(part, "part_name", None),
        "model_variant": part.model_variant,
        "description": part.description,
        "tool_no": part.tool_no,
        "no_of_cavity": part.no_of_cavity,
        "production_section": part.production_section,
        "input_material": getattr(part, "input_material", None),
        "previous_operation": getattr(part, "previous_operation", None),
        "next_operation": getattr(part, "next_operation", None),
        "machine_type": getattr(part, "machine_type", None),
        "operation_code": part.operation_code,
        "operation_name": part.operation_name,
        "operation_sequence": getattr(part, "operation_sequence", None),
        "process_time": float(part.process_time) if part.process_time else None,
        "loading_unloading": float(part.loading_unloading) if part.loading_unloading else 10,
        "drawing_revision": getattr(part, "drawing_revision", None),
        "manufacturing_status": getattr(part, "manufacturing_status", None) or "production",
        "manufacturing_status_other": getattr(part, "manufacturing_status_other", None),
        "cycle_time": _cycle_time(part),
        "active": part.active,
        "image_url": part.image_url,
        "sketch_image_url": getattr(part, "sketch_image_url", None),
        "cycle_profile": _parse_cycle_profile(part),
        "qc_column_schema": _qc_column_schema(part),
        "tools_parameters": _parse_param_table(
            getattr(part, "tools_params_json", None), DEFAULT_TOOLS_COLUMNS,
        ),
        "machine_parameters": _parse_param_table(
            getattr(part, "machine_params_json", None), DEFAULT_MACHINE_PARAM_COLUMNS,
        ),
        "jigs_fixtures": _parse_param_table(
            getattr(part, "jigs_fixtures_json", None), DEFAULT_JIGS_COLUMNS,
        ),
        "documents": [
            {
                "id": d.id,
                "doc_type": d.doc_type,
                "doc_label": getattr(d, "doc_label", None) or _resolve_doc_label(d.doc_type),
                "revision": d.revision,
                "rev_date": d.rev_date.isoformat() if d.rev_date else None,
                "file_url": d.file_url,
                "notes": d.notes,
            }
            for d in docs
        ],
        "qc_parameters": [
            {
                "id": q.id,
                "seq_no": q.seq_no,
                "parameter": q.parameter,
                "std_value": q.std_value,
                "method": q.method,
                "frequency": q.frequency,
                "is_numeric": bool(q.is_numeric),
                "lsl": float(q.lsl) if q.lsl is not None else None,
                "usl": float(q.usl) if q.usl is not None else None,
                "extra_columns": json.loads(q.extra_columns_json or "[]"),
            }
            for q in qc
        ],
    }


def _find_part_by_variant(db: Session, model_variant: str) -> Optional[Part]:
    if not model_variant:
        return None
    v = model_variant.strip()
    part = db.query(Part).filter(Part.part_no == v, Part.active == 1).first()
    if part:
        return part
    return db.query(Part).filter(Part.model_variant == v, Part.active == 1).first()


@router.get("/options")
def list_part_options(
    active_only: bool = Query(True),
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=MAX_OPTIONS_LIMIT),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Lightweight part list for dropdowns (no QC/doc payload)."""
    q = db.query(Part)
    if active_only:
        q = q.filter(Part.active == 1)
    q = _apply_part_search(q, search)
    rows = q.order_by(Part.part_no).limit(limit).all()
    return [
        {
            "id": p.id,
            "part_no": p.part_no,
            "part_name": getattr(p, "part_name", None),
            "model_variant": p.model_variant,
            "description": p.description,
            "tool_no": p.tool_no,
            "operation_name": p.operation_name,
            "operation_code": p.operation_code,
            "previous_operation": getattr(p, "previous_operation", None),
            "next_operation": getattr(p, "next_operation", None),
            "process_time": float(p.process_time) if p.process_time else None,
            "loading_unloading": float(p.loading_unloading) if p.loading_unloading else 10,
            "cycle_time": _cycle_time(p),
            "cycle_profile": _parse_cycle_profile(p),
        }
        for p in rows
    ]


@router.get("/")
def list_parts(
    active_only: bool = Query(True),
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Paginated part summaries for Knowledge Base (full detail via GET /{part_id})."""
    page_size = clamp_page_size(page_size)
    q = db.query(Part)
    if active_only:
        q = q.filter(Part.active == 1)
    q = _apply_part_search(q, search)
    total = q.count()
    parts = (
        q.order_by(Part.part_no)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    pages = max(1, (total + page_size - 1) // page_size)
    return {
        "items": [_part_summary_out(p, db) for p in parts],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
    }


@router.get("/by-variant/{model_variant}")
def get_by_variant(model_variant: str, db: Session = Depends(get_db), _=Depends(get_current_user)):
    part = _find_part_by_variant(db, model_variant)
    if not part:
        raise HTTPException(404, f"No part master found for variant '{model_variant}'")
    return _part_out(part, db)


@router.get("/document-types")
def list_document_types(
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Built-in document types plus any custom types already uploaded."""
    types = {d["key"]: d["label"] for d in BUILTIN_DOC_TYPES}
    rows = (
        db.query(PartDocument.doc_type, PartDocument.doc_label)
        .filter(PartDocument.doc_type.isnot(None))
        .distinct()
        .all()
    )
    for doc_type, doc_label in rows:
        if not doc_type:
            continue
        types[doc_type] = doc_label or types.get(doc_type) or _resolve_doc_label(doc_type)
    hist_rows = (
        db.query(PartDocumentHistory.doc_type, PartDocumentHistory.doc_label)
        .filter(PartDocumentHistory.doc_type.isnot(None))
        .distinct()
        .all()
    )
    for doc_type, doc_label in hist_rows:
        if not doc_type or doc_type in types:
            continue
        types[doc_type] = doc_label or _resolve_doc_label(doc_type)
    return [
        {"key": key, "label": label}
        for key, label in sorted(types.items(), key=lambda x: x[1].lower())
    ]


@router.get("/documents/revisions")
def list_all_revisions(
    part_id: Optional[int] = None,
    doc_type: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Centralized revision listing — paginated to protect large historic catalogs."""
    page_size = clamp_page_size(page_size)

    q = db.query(PartDocument).join(Part, Part.id == PartDocument.part_id)
    if part_id:
        q = q.filter(PartDocument.part_id == part_id)
    if doc_type:
        q = q.filter(PartDocument.doc_type == doc_type)
    current_total = q.count()
    docs = (
        q.order_by(Part.part_no, PartDocument.doc_type, PartDocument.is_current.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    part_ids = {d.part_id for d in docs}
    part_map = {
        p.id: p.part_no
        for p in db.query(Part).filter(Part.id.in_(part_ids)).all()
    } if part_ids else {}
    result = []
    for d in docs:
        result.append({
            "id": d.id,
            "part_id": d.part_id,
            "part_no": part_map.get(d.part_id),
            "doc_type": d.doc_type,
            "doc_label": getattr(d, "doc_label", None) or _resolve_doc_label(d.doc_type),
            "revision": d.revision,
            "rev_date": d.rev_date.isoformat() if d.rev_date else None,
            "file_url": d.file_url,
            "is_current": d.is_current,
            "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
        })

    history_q = db.query(PartDocumentHistory).join(Part, Part.id == PartDocumentHistory.part_id)
    if part_id:
        history_q = history_q.filter(PartDocumentHistory.part_id == part_id)
    if doc_type:
        history_q = history_q.filter(PartDocumentHistory.doc_type == doc_type)
    history_total = history_q.count()
    history_cap = min(page_size, MAX_REVISION_HISTORY)
    history = (
        history_q.order_by(PartDocumentHistory.archived_at.desc())
        .offset((page - 1) * history_cap)
        .limit(history_cap)
        .all()
    )
    hist_part_ids = {h.part_id for h in history}
    hist_part_map = {
        p.id: p.part_no
        for p in db.query(Part).filter(Part.id.in_(hist_part_ids)).all()
    } if hist_part_ids else {}
    hist_out = []
    for h in history:
        hist_out.append({
            "id": h.id,
            "part_id": h.part_id,
            "part_no": hist_part_map.get(h.part_id),
            "doc_type": h.doc_type,
            "doc_label": getattr(h, "doc_label", None) or _resolve_doc_label(h.doc_type),
            "revision": h.revision,
            "rev_date": h.rev_date.isoformat() if h.rev_date else None,
            "file_url": h.file_url,
            "archived_at": h.archived_at.isoformat() if h.archived_at else None,
        })
    current_pages = max(1, (current_total + page_size - 1) // page_size)
    history_pages = max(1, (history_total + history_cap - 1) // history_cap)
    return {
        "current": result,
        "current_total": current_total,
        "current_page": page,
        "current_pages": current_pages,
        "history": hist_out,
        "history_total": history_total,
        "history_page": page,
        "history_pages": history_pages,
        "page_size": page_size,
    }


@router.get("/{part_id}")
def get_part(part_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    return _part_out(part, db)


@router.post("/")
def create_part(
    data: PartCreate,
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    if db.query(Part).filter(Part.part_no == data.part_no.strip()).first():
        raise HTTPException(400, "Part number already exists")
    part = Part(
        part_no=data.part_no.strip(),
        created_by=user.id,
        created_at=now_ist(),
        updated_at=now_ist(),
    )
    _apply_part_fields(part, data)
    db.add(part)
    db.flush()
    for row in _qc_param_rows(part.id, data.qc_parameters):
        db.add(row)
    db.commit()
    db.refresh(part)
    return _part_out(part, db)


@router.put("/{part_id}")
def update_part(
    part_id: int,
    data: PartUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    dup = db.query(Part).filter(Part.part_no == data.part_no.strip(), Part.id != part_id).first()
    if dup:
        raise HTTPException(400, "Part number already exists")
    part.part_no = data.part_no.strip()
    part.active = data.active
    _apply_part_fields(part, data)
    part.updated_at = now_ist()
    db.query(PartQcParameter).filter(PartQcParameter.part_id == part_id).delete()
    for row in _qc_param_rows(part.id, data.qc_parameters):
        db.add(row)
    db.commit()
    db.refresh(part)
    return _part_out(part, db)


@router.delete("/{part_id}")
def delete_part(
    part_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_role("admin")),
):
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    part.active = 0
    part.updated_at = now_ist()
    db.commit()
    return {"ok": True}


async def _upload_part_image_field(part_id: int, file: UploadFile, field: str, db: Session):
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        raise HTTPException(400, "Only image files are allowed")
    slug = _safe_part_slug(part.part_no)
    prefix = "sketch" if field == "sketch_image_url" else "part"
    fname = f"{slug}_{prefix}_{uuid.uuid4().hex[:8]}{ext}"
    dest = PART_IMAGE_DIR / fname
    await save_upload_limited(file, dest, MAX_IMAGE_BYTES)
    url = f"/static/parts/{fname}"
    setattr(part, field, url)
    part.updated_at = now_ist()
    db.commit()
    return {field: url}


@router.post("/{part_id}/image")
async def upload_part_image(
    part_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    return await _upload_part_image_field(part_id, file, "image_url", db)


@router.post("/{part_id}/sketch")
async def upload_part_sketch(
    part_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    return await _upload_part_image_field(part_id, file, "sketch_image_url", db)


@router.post("/{part_id}/documents/{doc_type}/upload")
async def upload_document(
    part_id: int,
    doc_type: str,
    revision: str = Query("0"),
    rev_date: Optional[date] = None,
    notes: Optional[str] = None,
    doc_label: Optional[str] = Query(None),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user=Depends(require_role("supervisor", "admin")),
):
    key = _normalize_doc_type(doc_type)
    label = _resolve_doc_label(key, doc_label)
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    ext = Path(file.filename or "").suffix.lower()
    assert_wi_doc_extension(ext)
    slug = _safe_part_slug(part.part_no)
    safe_rev = re.sub(r"[^\w.\-]+", "_", (revision or "0").strip()) or "0"
    safe_type = re.sub(r"[^\w.\-]+", "_", key)[:40]
    fname = f"{slug}_{safe_type}_{safe_rev}_{uuid.uuid4().hex[:8]}{ext}"
    dest = UPLOAD_DIR / fname
    await save_upload_limited(file, dest, wi_doc_max_bytes(ext))
    file_url = f"/static/work-instructions/{fname}"

    current = db.query(PartDocument).filter(
        PartDocument.part_id == part_id,
        PartDocument.doc_type == key,
        PartDocument.is_current == 1,
    ).first()
    if current and current.file_url:
        db.add(PartDocumentHistory(
            part_id=part_id,
            doc_type=current.doc_type,
            doc_label=getattr(current, "doc_label", None) or _resolve_doc_label(current.doc_type),
            revision=current.revision,
            rev_date=current.rev_date,
            file_url=current.file_url,
            archived_at=now_ist(),
            archived_by=user.id,
            notes=current.notes,
        ))
        current.is_current = 0
        db.flush()

    doc = PartDocument(
        part_id=part_id,
        doc_type=key,
        doc_label=label,
        revision=revision,
        rev_date=rev_date or date.today(),
        file_url=file_url,
        is_current=1,
        uploaded_by=user.id,
        uploaded_at=now_ist(),
        notes=notes,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return {
        "id": doc.id,
        "doc_type": doc.doc_type,
        "doc_label": doc.doc_label,
        "revision": doc.revision,
        "rev_date": doc.rev_date.isoformat() if doc.rev_date else None,
        "file_url": doc.file_url,
    }


@router.get("/{part_id}/documents/history")
def document_history(part_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    part = db.query(Part).filter(Part.id == part_id).first()
    if not part:
        raise HTTPException(404, "Part not found")
    current = db.query(PartDocument).filter(PartDocument.part_id == part_id).all()
    history = (
        db.query(PartDocumentHistory)
        .filter(PartDocumentHistory.part_id == part_id)
        .order_by(PartDocumentHistory.archived_at.desc())
        .limit(MAX_REVISION_HISTORY)
        .all()
    )
    return {
        "current": [
            {
                "id": d.id,
                "doc_type": d.doc_type,
                "doc_label": getattr(d, "doc_label", None) or _resolve_doc_label(d.doc_type),
                "revision": d.revision,
                "rev_date": d.rev_date.isoformat() if d.rev_date else None,
                "file_url": d.file_url,
                "is_current": d.is_current,
                "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
            }
            for d in current
        ],
        "history": [
            {
                "id": h.id,
                "doc_type": h.doc_type,
                "doc_label": getattr(h, "doc_label", None) or _resolve_doc_label(h.doc_type),
                "revision": h.revision,
                "rev_date": h.rev_date.isoformat() if h.rev_date else None,
                "file_url": h.file_url,
                "archived_at": h.archived_at.isoformat() if h.archived_at else None,
            }
            for h in history
        ],
    }
