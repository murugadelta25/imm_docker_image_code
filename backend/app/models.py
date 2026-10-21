from sqlalchemy import create_engine, Column, Integer, String, Date, Time, DateTime, Numeric, Float, Text, Enum, ForeignKey, TIMESTAMP, Computed, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from dotenv import load_dotenv
import os
from pathlib import Path

_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path, encoding="utf-8-sig")

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(f"DATABASE_URL is not set. Check {_env_path}")
engine = create_engine(
    DATABASE_URL,
    pool_size=20,  # Maintain 20 connections in pool
    max_overflow=10,  # Allow up to 10 overflow connections
    pool_recycle=3600,  # Recycle connections every hour
    pool_pre_ping=True,  # Test connections before using
    connect_args={"connect_timeout": 10},
    echo=False,  # Disable SQL logging in production
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def ensure_oee_schema(bind=None):
    """Ensure legacy databases have the raw OEE columns used for audit tracking."""
    if bind is None:
        bind = engine

    try:
        from sqlalchemy import inspect, text

        inspector = inspect(bind)
        if not inspector.has_table("oee_entries"):
            return False

        columns = {column["name"] for column in inspector.get_columns("oee_entries")}
        with bind.begin() as conn:
            if "ar_raw" not in columns:
                conn.execute(text("ALTER TABLE oee_entries ADD COLUMN ar_raw DECIMAL(7, 2) NULL"))
            if "pr_raw" not in columns:
                conn.execute(text("ALTER TABLE oee_entries ADD COLUMN pr_raw DECIMAL(7, 2) NULL"))
            if "qr_raw" not in columns:
                conn.execute(text("ALTER TABLE oee_entries ADD COLUMN qr_raw DECIMAL(7, 2) NULL"))
            if "oee_raw" not in columns:
                conn.execute(text("ALTER TABLE oee_entries ADD COLUMN oee_raw DECIMAL(7, 2) NULL"))
        return True
    except Exception:
        return False


ensure_oee_schema()


def ensure_users_schema(bind=None):
    """Add operator reference photo column for mobile face verification."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import inspect, text

        inspector = inspect(bind)
        if not inspector.has_table("users"):
            return False
        cols = {c["name"] for c in inspector.get_columns("users")}
        if "reference_photo_url" not in cols:
            with bind.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN reference_photo_url VARCHAR(500) NULL"))
        return True
    except Exception:
        return False


ensure_users_schema()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

import pytz as _pytz
_IST = _pytz.timezone('Asia/Kolkata')
def now_ist():
    """Return current IST datetime (naive, for DB storage)."""
    from datetime import datetime
    return datetime.now(_IST).replace(tzinfo=None)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum("operator", "supervisor", "maintenance", "admin", "quality", "superadmin"), nullable=False)
    reference_photo_url = Column(String(500), nullable=True)


class Operator(Base):
    """Shop-floor operator identity — separate from login users (User Management)."""
    __tablename__ = "operators"
    id = Column(Integer, primary_key=True, index=True)
    employee_code = Column(String(50), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    is_temporary = Column(Integer, default=0)
    is_active = Column(Integer, default=1)
    pin_hash = Column(String(255), nullable=True)
    reference_photo_url = Column(String(500), nullable=True)
    linked_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    notes = Column(String(255), nullable=True)
    created_at = Column(TIMESTAMP)
    updated_at = Column(DateTime)


class Station(Base):
    __tablename__ = "stations"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False)
    display_name = Column(String(100), nullable=False)
    created_at = Column(TIMESTAMP, server_default=text("CURRENT_TIMESTAMP"))

# Backward import alias during transition
Pair = Station

class Machine(Base):
    __tablename__ = "machines"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    station_id = Column(Integer, ForeignKey("stations.id"), nullable=False)
    status = Column(Enum("running", "idle", "breakdown", "setting_change", "alarm", "offline"), default="idle")
    machine_type = Column(String(50), default="IMM")
    make = Column(String(100))
    model_no = Column(String(100))
    tonnage = Column(String(50))
    features = Column(Text)
    image_url = Column(String(500))
    location = Column(String(100))
    plc_source = Column(Enum("manual", "mqtt", "modbus", "opcua"), default="manual")
    plc_endpoint = Column(String(255))
    plc_topic = Column(String(255))

class OEEEntry(Base):
    __tablename__ = "oee_entries"
    id = Column(Integer, primary_key=True, index=True)
    entry_date = Column(Date, nullable=False)
    station_no = Column(Integer, nullable=False)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=True)
    shift = Column(String(1), nullable=False)
    current_operation = Column(String(50))
    next_operation = Column(String(50))
    model_variant = Column(String(100))
    process_time = Column(Numeric(10, 2))
    loading_unloading = Column(Numeric(10, 2))
    cycle_time = Column(Numeric(10, 2), Computed('(`process_time` + `loading_unloading`)'))
    start_time = Column(String(10))
    stop_time = Column(String(10))
    total_minutes = Column(Integer)
    lunch_break = Column(Integer, default=0)
    tea_break = Column(Integer, default=0)
    tpm_cleaning = Column(Integer, default=0)
    other_cleaning = Column(Integer, default=0)
    management_meeting = Column(Integer, default=0)
    total_breaks = Column(Integer, Computed('((((`lunch_break` + `tea_break`) + `tpm_cleaning`) + `other_cleaning`) + `management_meeting`)'))
    shift_working_minutes = Column(Integer, Computed('(`total_minutes` - ((((`lunch_break` + `tea_break`) + `tpm_cleaning`) + `other_cleaning`) + `management_meeting`))'))
    no_load = Column(Integer, default=0)
    new_model_trial = Column(Integer, default=0)
    power_cut = Column(Integer, default=0)
    planned_maintenance = Column(Integer, default=0)
    no_manpower_planned = Column(Integer, default=0)
    management_loss_total = Column(Integer, Computed('((((`no_load` + `new_model_trial`) + `power_cut`) + `planned_maintenance`) + `no_manpower_planned`)'))
    available_shift_time = Column(Integer)
    setting_time = Column(Integer, default=0)
    tool_change = Column(Integer, default=0)
    dimension_correction = Column(Integer, default=0)
    scrap_removal = Column(Integer, default=0)
    break_down = Column(Integer, default=0)
    total_down_time = Column(Integer, Computed('((((`setting_time` + `tool_change`) + `dimension_correction`) + `scrap_removal`) + `break_down`)'))
    operating_time = Column(Integer)
    possible_qty = Column(Integer)
    production_loss = Column(Integer, Computed('(`possible_qty` - `actual_qty`)'))
    actual_qty = Column(Integer)
    accp_qty = Column(Integer)
    defect_qty = Column(Integer)
    rejection_json = Column(Text)  # {"Short Fill": 18, ...} latest QC rejection breakdown
    ar = Column(Numeric(6, 2))
    pr = Column(Numeric(6, 2))
    qr = Column(Numeric(6, 2))
    oee = Column(Numeric(6, 2))
    # Original uncapped values — stored for audit; NULL means no capping occurred
    ar_raw  = Column(Numeric(7, 2), nullable=True)
    pr_raw  = Column(Numeric(7, 2), nullable=True)
    qr_raw  = Column(Numeric(7, 2), nullable=True)
    oee_raw = Column(Numeric(7, 2), nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"))

class ModelChangeRequest(Base):
    __tablename__ = "model_change_requests"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    plan_id = Column(Integer, ForeignKey("production_plans.id"), nullable=True)
    requested_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    approved_by = Column(Integer, ForeignKey("users.id"))
    from_model = Column(String(100))
    to_model = Column(String(100))
    status = Column(Enum("pending", "approved", "in_progress", "completed", "rejected"), default="pending")
    ideal_minutes = Column(Integer, default=60)
    shift = Column(String(1), default="A")
    entry_date = Column(Date)
    reason = Column(String(50), default="setting_change")
    start_time = Column(DateTime)
    end_time = Column(DateTime)
    created_at = Column(TIMESTAMP)

class WorkOrder(Base):
    __tablename__ = "work_orders"
    id = Column(Integer, primary_key=True, index=True)
    work_order_no = Column(String(100), unique=True, nullable=False)
    part_id = Column(Integer, ForeignKey("parts.id"))
    # IMM: work order is created against mold master (tool_stocks), not part
    mold_id = Column(Integer, ForeignKey("tool_stocks.id"), nullable=True, index=True)
    model_variant = Column(String(100))
    description = Column(String(255))
    target_qty = Column(Integer, nullable=False)
    start_date = Column(Date)
    end_date = Column(Date)
    status = Column(Enum("draft", "in_progress", "completed", "cancelled"), default="draft")
    spares_tools_json = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(TIMESTAMP)
    updated_at = Column(TIMESTAMP)


class ProductionPlan(Base):
    __tablename__ = "production_plans"
    id = Column(Integer, primary_key=True, index=True)
    work_order_id = Column(Integer, ForeignKey("work_orders.id"))
    plan_date = Column(Date, nullable=False)
    shift = Column(String(1), nullable=False)
    station_no = Column(Integer, nullable=False)
    machine_id = Column(Integer, ForeignKey("machines.id"))
    # Legacy CNC fields — for IMM filled from mold name / cavity name
    current_operation = Column(String(50), nullable=False)
    next_operation = Column(String(50), nullable=False)
    model_variant = Column(String(100))
    process_time = Column(Numeric(10, 2), nullable=False)
    loading_unloading = Column(Numeric(10, 2), default=10)
    planned_qty = Column(Integer, nullable=False)
    actual_qty = Column(Integer, default=0)
    priority = Column(Integer, default=1)
    status = Column(
        Enum(
            "pending", "running", "completed", "paused", "cancelled", "aborted", "incomplete",
            name="productionplan_status",
        ),
        default="pending",
    )
    plan_type = Column(Enum("scheduled","urgent","trial"), default="scheduled")
    notes = Column(Text)
    # IMM mold master link + snapshot of planning fields
    mold_id = Column(Integer, ForeignKey("tool_stocks.id"), nullable=True, index=True)
    mold_details_json = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(TIMESTAMP)
    updated_at = Column(TIMESTAMP)


def ensure_plan_status_enum(bind=None):
    """Widen production_plans.status ENUM for aborted/incomplete (MySQL)."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import text
        with bind.begin() as conn:
            conn.execute(text(
                "ALTER TABLE production_plans MODIFY COLUMN status "
                "ENUM('pending','running','completed','paused','cancelled','aborted','incomplete') "
                "NOT NULL DEFAULT 'pending'"
            ))
    except Exception as exc:
        print(f"[WARN] ensure_plan_status_enum skipped: {exc}")


try:
    ensure_plan_status_enum()
except Exception:
    pass


class EmailGroup(Base):
    __tablename__ = "email_groups"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), unique=True, nullable=False)
    description = Column(String(200))
    report_types = Column(String(100), default="oee,planning,breakdown")

class EmailRecipient(Base):
    __tablename__ = "email_recipients"
    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("email_groups.id"), nullable=False)
    name = Column(String(100), nullable=False)
    email = Column(String(150), nullable=False)
    active = Column(Integer, default=1)

class EmailSchedule(Base):
    __tablename__ = "email_schedules"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    group_ids = Column(String(200), nullable=False)  # comma-separated group ids
    report_type = Column(String(50), default="daily")
    send_hour = Column(Integer, default=18)
    send_minute = Column(Integer, default=0)
    attach_report = Column(Integer, default=1)
    active = Column(Integer, default=1)
    last_sent = Column(DateTime)

class EmailSmtpConfig(Base):
    __tablename__ = "email_smtp_config"
    id = Column(Integer, primary_key=True, index=True)
    smtp_server = Column(String(100), default="smtp.gmail.com")
    smtp_port = Column(Integer, default=587)
    email_address = Column(String(150))
    email_password = Column(String(255))

class SiteConfig(Base):
    __tablename__ = "site_config"
    id = Column(Integer, primary_key=True, index=True)
    config_json = Column(Text, nullable=False)


class Factory(Base):
    """Plant / factory master — source of truth for IMM Factory Setup."""
    __tablename__ = "factories"
    id = Column(Integer, primary_key=True, index=True)
    external_key = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(150), nullable=False)
    logo_url = Column(String(500))
    address = Column(String(500))
    lat = Column(String(50))
    lng = Column(String(50))
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=now_ist)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)
    departments = relationship(
        "FactoryDepartment",
        back_populates="factory",
        cascade="all, delete-orphan",
        order_by="FactoryDepartment.sort_order",
    )


class FactoryDepartment(Base):
    __tablename__ = "factory_departments"
    id = Column(Integer, primary_key=True, index=True)
    factory_id = Column(Integer, ForeignKey("factories.id", ondelete="CASCADE"), nullable=False, index=True)
    external_key = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(150), nullable=False, default="")
    sort_order = Column(Integer, default=0)
    factory = relationship("Factory", back_populates="departments")
    zones = relationship(
        "FactoryZone",
        back_populates="department",
        cascade="all, delete-orphan",
        order_by="FactoryZone.sort_order",
    )


class FactoryZone(Base):
    """IMM Zone (UI) — formerly Factory Setup 'line'."""
    __tablename__ = "factory_zones"
    id = Column(Integer, primary_key=True, index=True)
    department_id = Column(
        Integer, ForeignKey("factory_departments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    external_key = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(150), nullable=False, default="")
    sort_order = Column(Integer, default=0)
    department = relationship("FactoryDepartment", back_populates="zones")
    stations = relationship(
        "FactoryZoneStation",
        back_populates="zone",
        cascade="all, delete-orphan",
    )


class FactoryZoneStation(Base):
    """Stations assigned to a factory zone."""
    __tablename__ = "factory_zone_stations"
    zone_id = Column(Integer, ForeignKey("factory_zones.id", ondelete="CASCADE"), primary_key=True)
    station_id = Column(Integer, ForeignKey("stations.id", ondelete="CASCADE"), primary_key=True)
    zone = relationship("FactoryZone", back_populates="stations")


class MachineStatusLog(Base):
    __tablename__ = "machine_status_log"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    status = Column(String(50), nullable=False)
    changed_at = Column(DateTime, nullable=False)
    source = Column(String(50), default="system")
    deviation_reason = Column(String(500), nullable=True)

class EmailLog(Base):
    __tablename__ = "email_logs"
    id = Column(Integer, primary_key=True, index=True)
    sent_at = Column(TIMESTAMP, nullable=False)
    recipients = Column(Text)          # comma-separated emails
    subject = Column(String(255))
    report_type = Column(String(50))   # planning | manual | scheduled
    status = Column(String(20), default="sent")  # sent | failed
    error_msg = Column(Text)
    sent_by = Column(Integer, ForeignKey("users.id"))

class DeviationAlertLog(Base):
    """Tracks deviation / breakdown / alarm alert emails sent (dedup + audit)."""
    __tablename__ = "deviation_alert_log"
    id = Column(Integer, primary_key=True, index=True)
    sent_at = Column(DateTime, nullable=False)
    alert_type = Column(String(50), nullable=False)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    status = Column(String(50), nullable=False)
    segment_log_id = Column(Integer, ForeignKey("machine_status_log.id"), nullable=True)
    breach_count = Column(Integer, default=1)
    duration_sec = Column(Integer)
    deviation_reason = Column(String(500))
    recipients = Column(Text)
    subject = Column(String(255))
    email_log_id = Column(Integer, ForeignKey("email_logs.id"), nullable=True)
    delivery_status = Column(String(20), default="sent")
    escalation_level = Column(Integer, default=0)  # 0 = all recipients; 1+ = escalation tier


class DeviationEscalationCase(Base):
    """Open deviation case tracked for multi-level escalation until action is taken."""
    __tablename__ = "deviation_escalation_cases"
    id = Column(Integer, primary_key=True, index=True)
    segment_log_id = Column(Integer, ForeignKey("machine_status_log.id"), nullable=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    status = Column(String(50), nullable=False)
    alert_type = Column(String(50), nullable=False)
    current_level = Column(Integer, default=1)
    opened_at = Column(DateTime, nullable=False)
    last_escalated_at = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    resolved_reason = Column(String(100), nullable=True)


class OEEDefectLog(Base):
    """Tracks before/after OEE when defect_qty is updated post-QC"""
    __tablename__ = "oee_defect_log"
    id           = Column(Integer, primary_key=True, index=True)
    oee_entry_id = Column(Integer, ForeignKey("oee_entries.id"), nullable=False)
    updated_at   = Column(DateTime, nullable=False)
    updated_by   = Column(Integer, ForeignKey("users.id"))
    # before
    before_defect_qty = Column(Integer)
    before_accp_qty   = Column(Integer)
    before_qr         = Column(Numeric(5,2))
    before_oee        = Column(Numeric(5,2))
    # after
    after_defect_qty  = Column(Integer)
    after_accp_qty    = Column(Integer)
    after_qr          = Column(Numeric(5,2))
    after_oee         = Column(Numeric(5,2))
    note              = Column(String(500))
    rejection_json    = Column(Text)  # per-reason quantities at this QC update

class BreakdownTicket(Base):
    __tablename__ = "breakdown_tickets"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    raised_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    acknowledged_by = Column(Integer, ForeignKey("users.id"))
    description = Column(Text)
    downtime_type = Column(String(20))  # planned | unplanned
    downtime_reason = Column(String(100))
    raised_by_name = Column(String(100))  # free-text override when not selecting a user
    status = Column(Enum("raised", "acknowledged", "in_progress", "resolved"), default="raised")
    ack_time = Column(DateTime)
    start_troubleshoot = Column(DateTime)
    resolved_time = Column(DateTime)
    resolution_notes = Column(Text)
    created_at = Column(TIMESTAMP)


class Part(Base):
    __tablename__ = "parts"
    id = Column(Integer, primary_key=True, index=True)
    part_no = Column(String(100), unique=True, nullable=False)
    part_name = Column(String(255))
    model_variant = Column(String(100))
    description = Column(String(255))
    tool_no = Column(String(50))
    no_of_cavity = Column(Integer, default=1)
    production_section = Column(String(100))
    input_material = Column(String(255))
    previous_operation = Column(String(255))
    next_operation = Column(String(255))
    machine_type = Column(String(100))
    operation_code = Column(String(100))
    operation_name = Column(String(100))
    operation_sequence = Column(Text)
    process_time = Column(Numeric(10, 2))
    loading_unloading = Column(Numeric(10, 2), default=10)
    drawing_revision = Column(String(50))
    manufacturing_status = Column(String(50), default="production")
    manufacturing_status_other = Column(String(100))
    image_url = Column(String(500))
    sketch_image_url = Column(String(500))
    qc_columns_json = Column(Text)
    tools_params_json = Column(Text)
    machine_params_json = Column(Text)
    jigs_fixtures_json = Column(Text)
    cycle_profile_json = Column(Text, nullable=True)
    active = Column(Integer, default=1)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(TIMESTAMP)
    updated_at = Column(TIMESTAMP)


class PartDocument(Base):
    __tablename__ = "part_documents"
    id = Column(Integer, primary_key=True, index=True)
    part_id = Column(Integer, ForeignKey("parts.id"), nullable=False)
    doc_type = Column(String(100), nullable=False)
    doc_label = Column(String(150))
    revision = Column(String(20), nullable=False, default="0")
    rev_date = Column(Date)
    file_url = Column(String(500))
    is_current = Column(Integer, default=1)
    uploaded_by = Column(Integer, ForeignKey("users.id"))
    uploaded_at = Column(TIMESTAMP)
    notes = Column(Text)


class PartDocumentHistory(Base):
    __tablename__ = "part_document_history"
    id = Column(Integer, primary_key=True, index=True)
    part_id = Column(Integer, ForeignKey("parts.id"), nullable=False)
    doc_type = Column(String(100), nullable=False)
    doc_label = Column(String(150))
    revision = Column(String(20), nullable=False)
    rev_date = Column(Date)
    file_url = Column(String(500), nullable=False)
    archived_at = Column(TIMESTAMP)
    archived_by = Column(Integer, ForeignKey("users.id"))
    superseded_by = Column(Integer, ForeignKey("part_documents.id"))
    notes = Column(Text)


class PartQcParameter(Base):
    __tablename__ = "part_qc_parameters"
    id = Column(Integer, primary_key=True, index=True)
    part_id = Column(Integer, ForeignKey("parts.id"), nullable=False)
    seq_no = Column(Integer, nullable=False, default=1)
    parameter = Column(String(100), nullable=False)
    std_value = Column(String(100))
    method = Column(String(50))
    frequency = Column(String(50))
    is_numeric = Column(Integer, default=0)
    lsl = Column(Float, nullable=True)
    usl = Column(Float, nullable=True)
    extra_columns_json = Column(Text)
    active = Column(Integer, default=1)
    created_at = Column(TIMESTAMP)


class QcInspectionReport(Base):
    __tablename__ = "qc_inspection_reports"
    id = Column(Integer, primary_key=True, index=True)
    part_id = Column(Integer, ForeignKey("parts.id"))
    machine_id = Column(Integer, ForeignKey("machines.id"))
    article_no = Column(String(100))
    machine_name = Column(String(100))
    description = Column(String(255))
    operation_code = Column(String(50))
    operation_name = Column(String(100))
    production_section = Column(String(100))
    shift = Column(String(1))
    inspection_date = Column(Date, nullable=False)
    readings_json = Column(Text)
    operator_name = Column(String(100))
    inspector_name = Column(String(100))
    production_incharge = Column(String(100))
    approval_json = Column(Text)
    status = Column(String(30), default="draft")
    operator_id = Column(Integer, ForeignKey("users.id"))
    inspector_id = Column(Integer, ForeignKey("users.id"))
    incharge_id = Column(Integer, ForeignKey("users.id"))
    operator_approved_at = Column(DateTime)
    inspector_approved_at = Column(DateTime)
    incharge_approved_at = Column(DateTime)
    submitted_by = Column(Integer, ForeignKey("users.id"))
    submitted_at = Column(TIMESTAMP)


class MachineKpiLog(Base):
    """Snapshot of machine KPI metrics for historic analysis."""
    __tablename__ = "machine_kpi_log"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False)
    entry_date = Column(Date, nullable=False)
    shift = Column(String(1), nullable=False)
    model_variant = Column(String(100))
    available_time_min = Column(Float)
    operating_time_min = Column(Float)
    downtime_min = Column(Float)
    actual_production_time_min = Column(Float)
    cycle_time_sec = Column(Float)
    planned_qty = Column(Integer)
    actual_qty = Column(Integer)
    good_qty = Column(Integer)
    defect_qty = Column(Integer)
    expected_qty = Column(Integer)
    theoretical_qty = Column(Integer)
    ar = Column(Float)
    pr = Column(Float)
    qr = Column(Float)
    oee = Column(Float)
    machine_utilization = Column(Float)
    production_yield = Column(Float)
    teep = Column(Float)
    computed_at = Column(DateTime, nullable=False)
    source = Column(String(20), default="auto")


class ToolStock(Base):
    """Mold / tool inventory — manual stock or synced from SAP (IMM mold master)."""
    __tablename__ = "tool_stocks"
    id = Column(Integer, primary_key=True, index=True)
    tool_code = Column(String(100), unique=True, nullable=False)
    tool_name = Column(String(255), nullable=False)  # Mold name
    unit = Column(String(20), default="pcs")
    stock_qty = Column(Numeric(12, 2), default=0)
    min_stock = Column(Numeric(12, 2), default=0)
    sap_material_no = Column(String(100))
    stock_source = Column(Enum("manual", "sap"), default="manual")
    last_synced_at = Column(DateTime)
    # Life / monitoring
    life_cycles_limit = Column(Integer)  # e.g. 50000, 100000
    cycles_used = Column(Numeric(14, 2), default=0)
    life_warning_pct = Column(Integer, default=90)
    cycles_per_part = Column(Numeric(10, 4), default=1)
    tool_status = Column(String(30), default="ok")  # ok | near_eol | eol | correction_ack | blocked
    qr_code = Column(String(100))  # mapped for future QR scan; scan suppressed for now
    notes = Column(Text)
    # IMM mold production master fields
    part_no = Column(String(100))
    standard_cavity = Column(Integer)
    running_cavity = Column(Integer)
    customer_name = Column(String(150))
    rm_grade = Column(String(100))
    standard_cycle_time = Column(Numeric(12, 4))
    std_shot_weight = Column(Numeric(14, 4))
    std_part_weight = Column(Numeric(14, 4))
    std_runner_weight = Column(Numeric(14, 4))
    colour = Column(String(80))
    target_per_shift = Column(Integer)
    # Multi-cavity fixtures: [{id,name,enabled,part_no}]
    cavities_json = Column(Text)
    active = Column(Integer, default=1)
    created_at = Column(TIMESTAMP)
    updated_at = Column(TIMESTAMP)


class ToolEvent(Base):
    """Tool life / consumption / correction / replacement history."""
    __tablename__ = "tool_events"
    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("tool_stocks.id"), nullable=False, index=True)
    event_type = Column(String(40), nullable=False)
    qty_delta = Column(Numeric(12, 2))
    cycles_before = Column(Numeric(14, 2))
    cycles_after = Column(Numeric(14, 2))
    cycles_delta = Column(Numeric(14, 2))
    work_order_id = Column(Integer, ForeignKey("work_orders.id"))
    plan_id = Column(Integer, ForeignKey("production_plans.id"))
    part_id = Column(Integer, ForeignKey("parts.id"))
    machine_id = Column(Integer, ForeignKey("machines.id"))
    location = Column(String(255))
    notes = Column(Text)
    acknowledged_by = Column(Integer, ForeignKey("users.id"))
    qr_scanned = Column(Integer, default=0)
    qr_suppressed = Column(Integer, default=1)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(TIMESTAMP)


class ToolAlert(Base):
    """Low-stock / near-EOL / forecast alerts — can be suppressed or acknowledged."""
    __tablename__ = "tool_alerts"
    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("tool_stocks.id"), nullable=False, index=True)
    alert_type = Column(String(40), nullable=False)
    severity = Column(String(20), default="warning")
    message = Column(String(500), nullable=False)
    suppressed = Column(Integer, default=0)
    acknowledged = Column(Integer, default=0)
    acknowledged_by = Column(Integer, ForeignKey("users.id"))
    acknowledged_at = Column(DateTime)
    meta_json = Column(Text)
    created_at = Column(TIMESTAMP)


class MobileDevice(Base):
    """Factory tablet / phone bound to a machine (operator mobile app)."""
    __tablename__ = "mobile_devices"
    id = Column(Integer, primary_key=True, index=True)
    tab_id = Column(String(100), unique=True, nullable=False, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    mac_address = Column(String(100))
    platform = Column(String(40), default="mobile")
    last_seen_at = Column(DateTime)
    created_at = Column(TIMESTAMP)
    updated_at = Column(DateTime)


class OperatorSession(Base):
    """Operator login presence / availability at a machine tablet."""
    __tablename__ = "operator_sessions"
    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # legacy / linked login
    username = Column(String(50), nullable=False)  # display: employee_code or name
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    tab_id = Column(String(100))
    mac_address = Column(String(100))
    shift_id = Column(String(1))
    face_verified = Column(Integer, default=0)
    face_match_score = Column(Numeric(6, 3))
    login_photo_url = Column(String(500))
    logout_photo_url = Column(String(500))
    logout_reason = Column(String(40))
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime)
    status = Column(String(20), default="active")


class AttendanceRecord(Base):
    """Shift attendance punch in/out (AttendTrack-style, unified with mobile operator app)."""
    __tablename__ = "attendance_records"
    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # legacy
    username = Column(String(50), nullable=False)
    entry_date = Column(Date, nullable=False, index=True)
    shift_id = Column(String(1))
    machine_id = Column(Integer, ForeignKey("machines.id"))
    operator_session_id = Column(Integer)
    time_in = Column(DateTime, nullable=False)
    time_out = Column(DateTime)
    duration_mins = Column(Numeric(10, 2))
    status = Column(String(30), default="open")
    created_at = Column(TIMESTAMP)


class OperatorRosterDay(Base):
    """Weekly shift roster — one row per operator per calendar day per shift."""
    __tablename__ = "operator_roster_days"
    id = Column(Integer, primary_key=True, index=True)
    week_start = Column(Date, nullable=False, index=True)
    entry_date = Column(Date, nullable=False, index=True)
    shift_id = Column(String(1), nullable=False, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # legacy
    username = Column(String(50), nullable=False)
    status = Column(String(20), nullable=False, default="Present")  # Present|Absent|Leave|Week Off
    updated_at = Column(DateTime)
    updated_by = Column(String(50))


class MachineAllocation(Base):
    """Assign operator to machine for a date+shift; tablet must acknowledge."""
    __tablename__ = "machine_allocations"
    id = Column(Integer, primary_key=True, index=True)
    entry_date = Column(Date, nullable=False, index=True)
    shift_id = Column(String(1), nullable=False, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # legacy
    username = Column(String(50), nullable=False)
    status = Column(String(20), default="assigned")  # assigned|acknowledged|active|cancelled
    source = Column(String(20), default="web")  # web|login
    assigned_by = Column(String(50))
    assigned_at = Column(DateTime)
    acknowledged_at = Column(DateTime)
    acknowledged_via = Column(String(20))  # password|face|pin
    notes = Column(String(255))


class OperatorLossLog(Base):
    """TPM 16-loss logging from operator mobile app (timed sessions + OEE mapping)."""
    __tablename__ = "operator_loss_logs"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    tab_id = Column(String(100))
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    username = Column(String(50))
    loss_code = Column(String(20), nullable=False)
    loss_description = Column(String(100), nullable=False)
    sub_division = Column(String(100))
    minutes = Column(Numeric(10, 2), nullable=True, default=0)
    notes = Column(Text)
    entry_date = Column(Date)
    shift = Column(String(1))
    status = Column(String(20), default="closed")  # open | closed
    started_at = Column(DateTime)
    ended_at = Column(DateTime)
    oee_field = Column(String(40))  # Data Entry field key
    oee_bucket = Column(String(20))  # breaks | mgmt | downtime | none
    exclude_from_oee = Column(Integer, default=0)  # 1 = avoid double-count (e.g. setting vs MCR)
    created_at = Column(TIMESTAMP)


def _add_column_if_missing(bind, text, table: str, column: str, ddl: str):
    from sqlalchemy import inspect
    inspector = inspect(bind)
    if not inspector.has_table(table):
        return
    cols = {c["name"] for c in inspector.get_columns(table)}
    if column not in cols:
        with bind.begin() as conn:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))


def ensure_operators_schema(bind=None):
    """Create operators table, add operator_id FKs, migrate former User-role operators."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import inspect, text

        Operator.__table__.create(bind=bind, checkfirst=True)
        inspector = inspect(bind)
        if not inspector.has_table("operators"):
            return False

        with bind.begin() as conn:
            conn.execute(text("""
                INSERT INTO operators (employee_code, name, is_temporary, is_active, reference_photo_url, linked_user_id, created_at)
                SELECT u.username, u.username, 0, 1, u.reference_photo_url, u.id, CURRENT_TIMESTAMP
                FROM users u
                WHERE u.role = 'operator'
                  AND NOT EXISTS (
                    SELECT 1 FROM operators o
                    WHERE o.employee_code = u.username OR o.linked_user_id = u.id
                  )
            """))

        for table in (
            "operator_sessions",
            "attendance_records",
            "operator_roster_days",
            "machine_allocations",
            "operator_loss_logs",
        ):
            _add_column_if_missing(bind, text, table, "operator_id", "operator_id INT NULL")

        with bind.begin() as conn:
            for table in (
                "operator_sessions",
                "attendance_records",
                "operator_roster_days",
                "machine_allocations",
                "operator_loss_logs",
            ):
                insp = inspect(bind)
                if not insp.has_table(table):
                    continue
                cols = {c["name"]: c for c in insp.get_columns(table)}
                if "operator_id" in cols and "user_id" in cols:
                    conn.execute(text(f"""
                        UPDATE {table} t
                        INNER JOIN operators o ON o.linked_user_id = t.user_id
                        SET t.operator_id = o.id
                        WHERE t.operator_id IS NULL AND t.user_id IS NOT NULL
                    """))
                # Allow operator-only rows (no User Management account)
                if "user_id" in cols and cols["user_id"].get("nullable") is False:
                    try:
                        conn.execute(text(f"ALTER TABLE {table} MODIFY COLUMN user_id INT NULL"))
                    except Exception:
                        pass
        return True
    except Exception:
        return False


def ensure_mobile_schema(bind=None):
    """Create mobile operator tables if missing (safe on existing DBs)."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import inspect, text

        Operator.__table__.create(bind=bind, checkfirst=True)

        MobileDevice.__table__.create(bind=bind, checkfirst=True)
        OperatorSession.__table__.create(bind=bind, checkfirst=True)
        AttendanceRecord.__table__.create(bind=bind, checkfirst=True)
        OperatorRosterDay.__table__.create(bind=bind, checkfirst=True)
        MachineAllocation.__table__.create(bind=bind, checkfirst=True)
        OperatorLossLog.__table__.create(bind=bind, checkfirst=True)

        inspector = inspect(bind)
        if inspector.has_table("operator_sessions"):
            cols = {c["name"] for c in inspector.get_columns("operator_sessions")}
            alters = []
            if "shift_id" not in cols:
                alters.append("ADD COLUMN shift_id VARCHAR(1) NULL")
            if "face_verified" not in cols:
                alters.append("ADD COLUMN face_verified INT DEFAULT 0")
            if "face_match_score" not in cols:
                alters.append("ADD COLUMN face_match_score DECIMAL(6,3) NULL")
            if "login_photo_url" not in cols:
                alters.append("ADD COLUMN login_photo_url VARCHAR(500) NULL")
            if "logout_photo_url" not in cols:
                alters.append("ADD COLUMN logout_photo_url VARCHAR(500) NULL")
            if "logout_reason" not in cols:
                alters.append("ADD COLUMN logout_reason VARCHAR(40) NULL")
            if "operator_id" not in cols:
                alters.append("ADD COLUMN operator_id INT NULL")
            if alters:
                with bind.begin() as conn:
                    for stmt in alters:
                        conn.execute(text(f"ALTER TABLE operator_sessions {stmt}"))

        ensure_operators_schema(bind)
        # Timed loss session columns
        for col, ddl in (
            ("status", "status VARCHAR(20) NULL DEFAULT 'closed'"),
            ("started_at", "started_at DATETIME NULL"),
            ("ended_at", "ended_at DATETIME NULL"),
            ("oee_field", "oee_field VARCHAR(40) NULL"),
            ("oee_bucket", "oee_bucket VARCHAR(20) NULL"),
            ("exclude_from_oee", "exclude_from_oee INT NULL DEFAULT 0"),
        ):
            _add_column_if_missing(bind, text, "operator_loss_logs", col, ddl)
        try:
            with bind.begin() as conn:
                conn.execute(text(
                    "UPDATE operator_loss_logs SET status='closed' WHERE status IS NULL"
                ))
                # Allow open sessions with 0 minutes
                conn.execute(text(
                    "ALTER TABLE operator_loss_logs MODIFY COLUMN minutes DECIMAL(10,2) NULL"
                ))
        except Exception:
            pass
        return True
    except Exception:
        return False


ensure_mobile_schema()


# ── IMM (Injection Molding) monitoring ──────────────────────────────────────

class ImmMold(Base):
    """Mold life / maintenance tracking per IMM machine."""
    __tablename__ = "imm_molds"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    mold_no = Column(String(100), nullable=False)
    usage_count = Column(Integer, default=0)
    usage_max = Column(Integer, default=1000000)
    cycles_after_maintenance = Column(Integer, default=0)
    maintenance_limit = Column(Integer, default=25000)
    is_active = Column(Integer, default=1)  # 1 = currently mounted
    # When this mold was last activated on the machine (period shot counter baseline).
    mounted_at = Column(DateTime, nullable=True)
    notes = Column(String(255))
    created_at = Column(DateTime, default=now_ist)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class ImmKeyComponent(Base):
    """Key IMM wear parts: barrel, screw, tip, nozzle."""
    __tablename__ = "imm_key_components"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    component_type = Column(String(40), nullable=False)  # barrel|screwRod|screwTip|nozzle
    spec_length = Column(String(40))
    spec_diameter = Column(String(40))
    start_date = Column(Date)
    expect_days = Column(Integer, default=365)
    description = Column(String(255))
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime, default=now_ist)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class ImmKpivThreshold(Base):
    """SPC / fixed-tolerance thresholds for KPIV charts."""
    __tablename__ = "imm_kpiv_thresholds"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    tag = Column(String(40), nullable=False)  # injection_end|max_pressure|nozzle_temp|barrel_temp|charge_time
    center = Column(Float)
    sigma = Column(Float, default=3.0)
    upper = Column(Float)
    lower = Column(Float)
    sample_points = Column(Integer, default=20)
    mode = Column(String(20), default="sigma")  # sigma | fixed
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class ImmKpivSample(Base):
    """Historical KPIV samples (PLC ingest or simulated)."""
    __tablename__ = "imm_kpiv_samples"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    tag = Column(String(40), nullable=False, index=True)
    value = Column(Float, nullable=False)
    recorded_at = Column(DateTime, default=now_ist, index=True)


class ImmOpcuaParamDef(Base):
    """Catalog of Dia Edge / Yizumi IMM OPC UA parameters (global)."""
    __tablename__ = "imm_opcua_param_defs"
    id = Column(Integer, primary_key=True, index=True)
    param_key = Column(String(120), unique=True, nullable=False, index=True)
    display_name = Column(String(160), nullable=False)
    io_type = Column(String(40), default="STRING")
    category = Column(String(40), default="general")
    identified_tag = Column(String(120))
    identified_node_id = Column(String(80))
    kpiv_tag = Column(String(40))
    sort_order = Column(Integer, default=0)
    is_active = Column(Integer, default=1)


class ImmOpcuaTagMap(Base):
    """Per-machine OPC UA tag / NodeId mapping for each catalog parameter."""
    __tablename__ = "imm_opcua_tag_maps"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    param_key = Column(String(120), nullable=False, index=True)
    opcua_tag_name = Column(String(160))
    opcua_node_id = Column(String(160))
    enabled = Column(Integer, default=1)
    scale = Column(Float, default=1.0)
    offset = Column(Float, default=0.0)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class ImmOpcuaLatest(Base):
    """Latest live value snapshot per machine + parameter."""
    __tablename__ = "imm_opcua_latest"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    param_key = Column(String(120), nullable=False, index=True)
    value_num = Column(Float)
    value_text = Column(String(255))
    quality = Column(String(40), default="good")
    source = Column(String(40), default="opcua")  # opcua | bridge | simulate
    recorded_at = Column(DateTime, default=now_ist, index=True)


class ImmOpcuaSample(Base):
    """Historical OPC UA / bridge parameter samples."""
    __tablename__ = "imm_opcua_samples"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    param_key = Column(String(120), nullable=False, index=True)
    value_num = Column(Float)
    value_text = Column(String(255))
    quality = Column(String(40), default="good")
    source = Column(String(40), default="opcua")
    recorded_at = Column(DateTime, default=now_ist, index=True)


class ImmShotEvent(Base):
    """One detected injection shot (cycle) for a machine."""
    __tablename__ = "imm_shot_events"
    id = Column(Integer, primary_key=True, index=True)
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=False, index=True)
    recorded_at = Column(DateTime, default=now_ist, index=True)
    # opcua_good_count | status_tags | …
    mode = Column(String(40), default="opcua_cycle")
    source = Column(String(40), default="nodered")
    notes = Column(String(255))
    # Active ImmMold at shot time (for mid-shift mold change + mold history).
    mold_id = Column(Integer, ForeignKey("imm_molds.id"), nullable=True, index=True)


class ImmShotFsm(Base):
    """Per-machine shot-sequence state machine (survives across Node-RED messages)."""
    __tablename__ = "imm_shot_fsm"
    machine_id = Column(Integer, ForeignKey("machines.id"), primary_key=True)
    # idle | saw_injection | saw_charge
    state = Column(String(40), default="idle", nullable=False)
    mode = Column(String(40), default="opcua_cycle")
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class EnergyMeter(Base):
    """Factory energy meter / electrical panel (Panel-1, Panel-2, …)."""
    __tablename__ = "energy_meters"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(40), unique=True, nullable=False, index=True)  # PANEL-1
    name = Column(String(120), nullable=False)  # Panel - 1
    panel_no = Column(Integer, default=1)
    category = Column(String(40), default="mixed")  # machines | utilities | mixed
    # Optional: machine_id that receives Node-RED energy tags for this meter
    source_machine_id = Column(Integer, ForeignKey("machines.id"), nullable=True, index=True)
    active = Column(Integer, default=1)
    sort_order = Column(Integer, default=0)
    notes = Column(String(255))
    created_at = Column(DateTime, default=now_ist)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class EnergyMeterLoad(Base):
    """Map an energy meter to one or more machines and/or utility loads."""
    __tablename__ = "energy_meter_loads"
    id = Column(Integer, primary_key=True, index=True)
    meter_id = Column(Integer, ForeignKey("energy_meters.id"), nullable=False, index=True)
    load_type = Column(String(20), nullable=False)  # machine | utility
    machine_id = Column(Integer, ForeignKey("machines.id"), nullable=True, index=True)
    utility_name = Column(String(120), nullable=True)
    utility_kind = Column(String(40), nullable=True)  # motor|chiller|pump|compressor|other
    share_pct = Column(Float, default=100.0)
    active = Column(Integer, default=1)
    created_at = Column(DateTime, default=now_ist)


class EnergyMeterLive(Base):
    """Single overwrite row of latest live readings per meter (no per-minute history)."""
    __tablename__ = "energy_meter_live"
    meter_id = Column(Integer, ForeignKey("energy_meters.id"), primary_key=True)
    # Cumulative totals from Total_enery_cumulative
    total_kwh = Column(Float)
    total_kvah = Column(Float)
    total_kvarh = Column(Float)
    pf = Column(Float)
    # EM_Current
    i1 = Column(Float)
    i2 = Column(Float)
    i3 = Column(Float)
    # EM_Voltage phase-phase
    v12 = Column(Float)
    v13 = Column(Float)
    v23 = Column(Float)
    # EM_Voltage phase-neutral
    v1n = Column(Float)
    v2n = Column(Float)
    v3n = Column(Float)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class EnergyShiftSnapshot(Base):
    """
    Shift energy accounting:
      a = reading at shift start (captured once)
      b = latest live reading (overwritten each update)
      consumption = b - a
    Retains last good values if device drops mid-shift.
    """
    __tablename__ = "energy_shift_snapshots"
    id = Column(Integer, primary_key=True, index=True)
    meter_id = Column(Integer, ForeignKey("energy_meters.id"), nullable=False, index=True)
    shift_date = Column(Date, nullable=False, index=True)
    shift_id = Column(String(8), nullable=False, index=True)
    shift_name = Column(String(40))
    # variable a
    start_kwh = Column(Float)
    start_kvah = Column(Float)
    start_kvarh = Column(Float)
    start_pf = Column(Float)
    start_at = Column(DateTime)
    # variable b (overwrite)
    latest_kwh = Column(Float)
    latest_kvah = Column(Float)
    latest_kvarh = Column(Float)
    latest_pf = Column(Float)
    latest_at = Column(DateTime)
    # b - a
    cons_kwh = Column(Float, default=0.0)
    cons_kvah = Column(Float, default=0.0)
    cons_kvarh = Column(Float, default=0.0)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


class EnergyDailyRollup(Base):
    """Daily rollup = sum of configured shift consumptions for trends."""
    __tablename__ = "energy_daily_rollups"
    id = Column(Integer, primary_key=True, index=True)
    meter_id = Column(Integer, ForeignKey("energy_meters.id"), nullable=False, index=True)
    day = Column(Date, nullable=False, index=True)
    kwh = Column(Float, default=0.0)
    kvah = Column(Float, default=0.0)
    kvarh = Column(Float, default=0.0)
    pf_avg = Column(Float)
    kg = Column(Float)
    kwh_per_kg = Column(Float)
    updated_at = Column(DateTime, default=now_ist, onupdate=now_ist)


def ensure_imm_schema(bind=None):
    """Create IMM monitoring + OPC UA tables if missing."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import inspect
        inspector = inspect(bind)
        tables = {
            "imm_molds": ImmMold.__table__,
            "imm_key_components": ImmKeyComponent.__table__,
            "imm_kpiv_thresholds": ImmKpivThreshold.__table__,
            "imm_kpiv_samples": ImmKpivSample.__table__,
            "imm_opcua_param_defs": ImmOpcuaParamDef.__table__,
            "imm_opcua_tag_maps": ImmOpcuaTagMap.__table__,
            "imm_opcua_latest": ImmOpcuaLatest.__table__,
            "imm_opcua_samples": ImmOpcuaSample.__table__,
            "imm_shot_events": ImmShotEvent.__table__,
            "imm_shot_fsm": ImmShotFsm.__table__,
            "energy_meters": EnergyMeter.__table__,
            "energy_meter_loads": EnergyMeterLoad.__table__,
            "energy_meter_live": EnergyMeterLive.__table__,
            "energy_shift_snapshots": EnergyShiftSnapshot.__table__,
            "energy_daily_rollups": EnergyDailyRollup.__table__,
        }
        for name, table in tables.items():
            if not inspector.has_table(name):
                table.create(bind=bind)
                print(f"[OK] Created table {name}")
        from sqlalchemy import text
        _add_column_if_missing(bind, text, "imm_molds", "mounted_at", "mounted_at DATETIME NULL")
        _add_column_if_missing(bind, text, "imm_shot_events", "mold_id", "mold_id INT NULL")
        return True
    except Exception as exc:
        print(f"[WARN] ensure_imm_schema failed: {exc}")
        return False


ensure_imm_schema()


def ensure_work_orders_schema(bind=None):
    """Add mold_id (mold master / tool_stocks) for IMM work orders."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import text
        _add_column_if_missing(bind, text, "work_orders", "mold_id", "mold_id INT NULL")
        return True
    except Exception as exc:
        print(f"[WARN] ensure_work_orders_schema failed: {exc}")
        return False


ensure_work_orders_schema()


def ensure_production_plans_schema(bind=None):
    """Add mold_id + mold_details_json for IMM production planning."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import text
        _add_column_if_missing(bind, text, "production_plans", "mold_id", "mold_id INT NULL")
        _add_column_if_missing(bind, text, "production_plans", "mold_details_json", "mold_details_json TEXT NULL")
        return True
    except Exception as exc:
        print(f"[WARN] ensure_production_plans_schema failed: {exc}")
        return False


ensure_production_plans_schema()


def ensure_factory_schema(bind=None):
    """Create factories / departments / zones relational tables if missing."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import inspect
        inspector = inspect(bind)
        tables = {
            "factories": Factory.__table__,
            "factory_departments": FactoryDepartment.__table__,
            "factory_zones": FactoryZone.__table__,
            "factory_zone_stations": FactoryZoneStation.__table__,
        }
        for name, table in tables.items():
            if not inspector.has_table(name):
                table.create(bind=bind)
                print(f"[OK] Created table {name}")
        return True
    except Exception as exc:
        print(f"[WARN] ensure_factory_schema failed: {exc}")
        return False


ensure_factory_schema()


def ensure_breakdown_schema(bind=None):
    """Add downtime reason / raised-by-name columns to breakdown_tickets."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import text
        _add_column_if_missing(
            bind, text, "breakdown_tickets", "downtime_type",
            "downtime_type VARCHAR(20) NULL"
        )
        _add_column_if_missing(
            bind, text, "breakdown_tickets", "downtime_reason",
            "downtime_reason VARCHAR(100) NULL"
        )
        _add_column_if_missing(
            bind, text, "breakdown_tickets", "raised_by_name",
            "raised_by_name VARCHAR(100) NULL"
        )
        return True
    except Exception as exc:
        print(f"[WARN] ensure_breakdown_schema failed: {exc}")
        return False


ensure_breakdown_schema()


def ensure_rejection_schema(bind=None):
    """Add rejection_json columns for QC Rejection Log breakdown."""
    if bind is None:
        bind = engine
    try:
        from sqlalchemy import text
        _add_column_if_missing(
            bind, text, "oee_entries", "rejection_json",
            "rejection_json TEXT NULL"
        )
        _add_column_if_missing(
            bind, text, "oee_defect_log", "rejection_json",
            "rejection_json TEXT NULL"
        )
        return True
    except Exception as exc:
        print(f"[WARN] ensure_rejection_schema failed: {exc}")
        return False


ensure_rejection_schema()
