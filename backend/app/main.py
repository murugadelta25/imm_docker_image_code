from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from .routers import auth, oee, model_change, breakdown, plans, work_orders
from .routers import email_router
from .routers import machines as machines_router
from .routers import stations as stations_router
from .routers import users as users_router
from .routers import config as config_router
from .routers import hourly_output as hourly_output_router
from .routers import parts as parts_router
from .routers import tools as tools_router
from .routers import operator_dashboard as operator_dashboard_router
from .routers import qc_inspection as qc_inspection_router
from .routers import deviation_alerts as deviation_alerts_router
from .routers import notifications as notifications_router
from .routers import platform as platform_router
from .routers import features as features_router
from .routers import machine_kpi as machine_kpi_router
from .routers import archive as archive_router
from .routers import mobile as mobile_router
from .routers import operators as operators_router
from .routers import imm_monitor as imm_monitor_router
from .routers import imm_opcua as imm_opcua_router
from .routers import imm_dashboard as imm_dashboard_router
from .routers import imm_history_dash as imm_history_dash_router
from .routers import imm_nodered as imm_nodered_router
from .routers import imm_energy as imm_energy_router
from .ws_manager import manager
from sqlalchemy import text, inspect
from sqlalchemy.orm import Session
from .models import get_db, engine
from .scheduler_service import start_scheduler, stop_scheduler


def _run_migrate(label: str, fn):
    try:
        fn()
    except Exception as exc:
        print(f"[WARN] {label} migration skipped: {exc}")


def _ensure_work_instruction_tables():
    """Create part/WI tables in DATABASE_URL if migration was not run yet."""
    try:
        if not inspect(engine).has_table("parts"):
            sql_path = Path(__file__).resolve().parent.parent.parent / "database" / "migrate_work_instructions.sql"
            if sql_path.exists():
                sql = sql_path.read_text(encoding="utf-8")
                for raw in sql.split(";"):
                    stmt = "\n".join(
                        ln for ln in raw.strip().splitlines()
                        if ln.strip() and not ln.strip().startswith("--")
                    ).strip()
                    if not stmt or stmt.upper().startswith("USE "):
                        continue
                    with engine.begin() as conn:
                        conn.execute(text(stmt))
                print("[OK] Work instruction tables created")
    except Exception as exc:
        print(f"[WARN] Work instruction table bootstrap failed: {exc}")
    try:
        from migrate_qc_enhancements import main as qc_migrate
        _run_migrate("qc_enhancements", qc_migrate)
    except Exception as exc:
        print(f"[WARN] QC enhancement import failed: {exc}")
    try:
        from migrate_quality_role import main as quality_role_migrate
        _run_migrate("quality_role", quality_role_migrate)
    except Exception as exc:
        print(f"[WARN] Quality role import failed: {exc}")
    try:
        from migrate_operation_code import main as operation_code_migrate
        _run_migrate("operation_code", operation_code_migrate)
    except Exception as exc:
        print(f"[WARN] operation_code import failed: {exc}")
    try:
        from migrate_work_orders import main as work_orders_migrate
        _run_migrate("work_orders", work_orders_migrate)
    except Exception as exc:
        print(f"[WARN] work_orders import failed: {exc}")
    try:
        from migrate_model_change_plan_link import main as mcr_migrate
        _run_migrate("model_change_plan_link", mcr_migrate)
    except Exception as exc:
        print(f"[WARN] model_change_plan_link import failed: {exc}")
    try:
        from migrate_oee_machine import run as oee_machine_migrate
        _run_migrate("oee_machine", oee_machine_migrate)
    except Exception as exc:
        print(f"[WARN] oee_machine import failed: {exc}")
    try:
        from migrate_part_doc_types import main as part_doc_migrate
        _run_migrate("part_doc_types", part_doc_migrate)
    except Exception as exc:
        print(f"[WARN] part_doc_types import failed: {exc}")
    try:
        from migrate_part_process_sheet import main as process_sheet_migrate
        _run_migrate("part_process_sheet", process_sheet_migrate)
    except Exception as exc:
        print(f"[WARN] part_process_sheet import failed: {exc}")
    try:
        from migrate_tool_stocks import main as tool_stocks_migrate
        _run_migrate("tool_stocks", tool_stocks_migrate)
    except Exception as exc:
        print(f"[WARN] tool_stocks import failed: {exc}")


def _ensure_deviation_alert_table():
    try:
        if not inspect(engine).has_table("deviation_alert_log"):
            from .models import DeviationAlertLog
            DeviationAlertLog.__table__.create(bind=engine)
            print("[OK] deviation_alert_log table created")
        else:
            cols = {c["name"] for c in inspect(engine).get_columns("deviation_alert_log")}
            if "escalation_level" not in cols:
                with engine.begin() as conn:
                    conn.execute(text(
                        "ALTER TABLE deviation_alert_log ADD COLUMN escalation_level INT DEFAULT 0"
                    ))
                print("[OK] deviation_alert_log.escalation_level column added")
        if not inspect(engine).has_table("deviation_escalation_cases"):
            from .models import DeviationEscalationCase
            DeviationEscalationCase.__table__.create(bind=engine)
            print("[OK] deviation_escalation_cases table created")
    except Exception as exc:
        print(f"[WARN] deviation_alert_log bootstrap failed: {exc}")


def _ensure_superadmin_role():
    """Add 'superadmin' to the users.role ENUM and bootstrap the first superadmin."""
    from .models import User, SessionLocal
    try:
        insp = inspect(engine)
        if not insp.has_table("users"):
            return
        cols = insp.get_columns("users")
        role_col = next((c for c in cols if c["name"] == "role"), None)
        if not role_col:
            return
        role_type = role_col.get("type")
        enums = getattr(role_type, "enums", None)
        if enums and "superadmin" not in enums:
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE users MODIFY COLUMN role "
                    "ENUM('operator','supervisor','maintenance','admin','quality','superadmin') NOT NULL"
                ))
            print("[OK] users.role ENUM updated — added 'superadmin'")
    except Exception as exc:
        print(f"[WARN] superadmin role migration skipped: {exc}")
        return

    try:
        db = SessionLocal()
        existing = db.query(User).filter(User.role == "superadmin").first()
        if not existing:
            first_admin = db.query(User).filter(User.role == "admin").first()
            if first_admin:
                first_admin.role = "superadmin"
                db.commit()
                print(f"[OK] Promoted '{first_admin.username}' to superadmin (first-time bootstrap)")
        db.close()
    except Exception as exc:
        print(f"[WARN] superadmin bootstrap skipped: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_superadmin_role()
    _ensure_work_instruction_tables()
    _ensure_deviation_alert_table()
    try:
        from .models import ensure_factory_schema
        from .factory_structure import migrate_json_factories_if_empty
        ensure_factory_schema()
        db = next(get_db())
        try:
            if migrate_json_factories_if_empty(db):
                db.commit()
                print("[OK] Migrated factory/zone JSON into relational tables")
            try:
                from .factory_structure import backfill_zone_stations_from_machines
                n = backfill_zone_stations_from_machines(db)
                if n:
                    db.commit()
                    print(f"[OK] Linked {n} machine station(s) to zones from location paths")
            except Exception as be:
                print(f"[WARN] zone station backfill skipped: {be}")
            start_scheduler(db)
        except Exception as e:
            print(f"[WARN] Scheduler/factory migrate failed (app will still run): {e}")
        finally:
            db.close()
    except Exception as e:
        print(f"[WARN] Database unavailable at startup (app will still run): {e}")
    yield
    stop_scheduler()

app = FastAPI(title="PMS Dashboard API", lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

app.include_router(auth.router)
app.include_router(oee.router)
app.include_router(model_change.router)
app.include_router(breakdown.router)
app.include_router(plans.router)
app.include_router(work_orders.router)
app.include_router(email_router.router)
app.include_router(stations_router.router)
app.include_router(machines_router.router)
app.include_router(users_router.router)
app.include_router(config_router.router)
app.include_router(hourly_output_router.router)
app.include_router(parts_router.router)
app.include_router(tools_router.router)
app.include_router(operator_dashboard_router.router)
app.include_router(qc_inspection_router.router)
app.include_router(deviation_alerts_router.router)
app.include_router(notifications_router.router)
app.include_router(platform_router.router)
app.include_router(features_router.router)
app.include_router(machine_kpi_router.router)
app.include_router(archive_router.router)
app.include_router(mobile_router.router)
app.include_router(operators_router.router)
app.include_router(imm_monitor_router.router)
app.include_router(imm_opcua_router.router)
app.include_router(imm_dashboard_router.router)
app.include_router(imm_history_dash_router.router)
app.include_router(imm_nodered_router.router)
app.include_router(imm_energy_router.router)

# Serve uploaded machine images — pathlib works on both Windows and Linux
STATIC_DIR = Path(__file__).parent.parent / "static"
(STATIC_DIR / "machines").mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "factory").mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "work-instructions").mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "operator-sessions").mkdir(parents=True, exist_ok=True)
(STATIC_DIR / "operator-reference").mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/health/db")
def health_db(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {exc}") from exc
