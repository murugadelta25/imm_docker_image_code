# EAP PMS — Database Schema & Data Architecture

**Project:** Production Monitoring System (PMS)  
**Database:** MySQL / MariaDB  
**ORM:** SQLAlchemy (Python)  
**Generated:** 2026-07-16  

---

## 1. Overview

The PMS database consists of **22 tables** organized into four domains:

| Domain | Tables | Purpose |
|--------|--------|---------|
| Core Production | 8 | Machines, plans, work orders, status tracking, KPIs |
| Model Change & Maintenance | 4 | Changeover interlock, breakdowns, deviation alerts |
| Quality Control | 5 | Part QC parameters, inspections, document management |
| System & Email | 5 | Users, config, email groups, SMTP, logs |

**Key design decisions:**
- No stored procedures, views, or triggers — all logic in the Python application layer
- Foreign keys for referential integrity, but no SQLAlchemy `relationship()` ORM mappings
- Separate queries + in-memory joins (not SQL JOINs) as the primary data access pattern
- 6 MySQL Computed (generated) columns in `oee_entries` for auto-calculated fields
- JSON columns (`Text` type) for flexible/nested configuration storage

---

## 2. Entity Relationship Diagram (Textual)

```
users ──────────────────────────────────────────────────────────────┐
  │                                                                 │
  ├──→ oee_entries.created_by                                       │
  ├──→ production_plans.created_by                                  │
  ├──→ work_orders.created_by                                       │
  ├──→ model_change_requests.requested_by / approved_by             │
  ├──→ breakdown_tickets.raised_by / acknowledged_by                │
  ├──→ parts.created_by                                             │
  ├──→ qc_inspection_reports.operator_id / inspector_id / etc.      │
  ├──→ oee_defect_log.updated_by                                   │
  ├──→ part_documents.uploaded_by                                   │
  ├──→ part_document_history.archived_by                            │
  └──→ email_logs.sent_by                                           │
                                                                    │
stations ──→ machines.station_id                                    │
                │                                                   │
                ├──→ oee_entries.machine_id                         │
                ├──→ production_plans.machine_id                    │
                ├──→ model_change_requests.machine_id               │
                ├──→ breakdown_tickets.machine_id                   │
                ├──→ machine_status_log.machine_id                  │
                ├──→ machine_kpi_log.machine_id                     │
                ├──→ deviation_alert_log.machine_id                 │
                ├──→ deviation_escalation_cases.machine_id          │
                └──→ qc_inspection_reports.machine_id               │
                                                                    │
parts ─────→ work_orders.part_id                                    │
  │           │                                                     │
  │           └──→ production_plans.work_order_id                   │
  │                  │                                              │
  │                  └──→ model_change_requests.plan_id             │
  │                                                                 │
  ├──→ part_qc_parameters.part_id                                   │
  ├──→ part_documents.part_id                                       │
  ├──→ part_document_history.part_id                                │
  └──→ qc_inspection_reports.part_id                                │
                                                                    │
machine_status_log ──→ deviation_alert_log.segment_log_id           │
                   └──→ deviation_escalation_cases.segment_log_id   │
                                                                    │
oee_entries ──→ oee_defect_log.oee_entry_id                         │
                                                                    │
email_groups ──→ email_recipients.group_id                          │
```

---

## 3. Table Definitions

### 3.1 Core Production Tables

#### `stations`
Work-center / station definitions.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Station ID |
| name | VARCHAR(100) | UNIQUE, NOT NULL | Internal name |
| display_name | VARCHAR(100) | NOT NULL | UI display label |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation time |

---

#### `machines`
Machine master data including PLC connectivity configuration.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Machine ID |
| name | VARCHAR(100) | NOT NULL | Machine name (e.g., "CN40") |
| station_id | INT | FK → stations.id, NOT NULL | Assigned station |
| status | ENUM | DEFAULT 'idle' | running, idle, breakdown, setting_change, alarm, offline |
| machine_type | VARCHAR(50) | DEFAULT 'CNC' | Machine category |
| make | VARCHAR(100) | | Manufacturer name |
| model_no | VARCHAR(100) | | Model number |
| tonnage | VARCHAR(50) | | Machine tonnage/capacity |
| features | TEXT | | Machine features (free text) |
| image_url | VARCHAR(500) | | Path to machine image |
| location | VARCHAR(100) | | Physical location string |
| plc_source | ENUM | DEFAULT 'manual' | manual, mqtt, modbus, opcua |
| plc_endpoint | VARCHAR(255) | | PLC connection address |
| plc_topic | VARCHAR(255) | | MQTT topic / Modbus register |

---

#### `production_plans`
Per-shift production plan for a machine. Central table linking work orders to machine execution.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Plan ID |
| work_order_id | INT | FK → work_orders.id | Associated work order |
| plan_date | DATE | NOT NULL | Planned date |
| shift | VARCHAR(1) | NOT NULL | Shift ID (A, B, C) |
| station_no | INT | NOT NULL | Station number |
| machine_id | INT | FK → machines.id | Assigned machine |
| current_operation | VARCHAR(50) | NOT NULL | Current operation code |
| next_operation | VARCHAR(50) | NOT NULL | Next operation code |
| model_variant | VARCHAR(100) | | Part number / model variant |
| process_time | DECIMAL(10,2) | NOT NULL | Process time in seconds |
| loading_unloading | DECIMAL(10,2) | DEFAULT 10 | Loading/unloading time in seconds |
| planned_qty | INT | NOT NULL | Target quantity for this shift |
| actual_qty | INT | DEFAULT 0 | Actual quantity produced |
| priority | INT | DEFAULT 1 | Plan priority (lower = higher priority) |
| status | ENUM | DEFAULT 'pending' | pending, running, completed, paused, cancelled |
| plan_type | ENUM | DEFAULT 'scheduled' | scheduled, urgent, trial |
| notes | TEXT | | Operator/system notes |
| created_by | INT | FK → users.id | Creator |
| created_at | TIMESTAMP | | Creation timestamp |
| updated_at | TIMESTAMP | | Last update timestamp |

**Key behaviors:**
- `pending → running` triggers a Model Change Request (unless same part continues from previous shift)
- `running` auto-pauses other running plans on the same machine
- `actual_qty ≥ planned_qty` auto-completes the plan
- Auto-transition: same `model_variant` on the same `machine_id` across consecutive shifts starts automatically

---

#### `work_orders`
Work order tracking with target quantities and date ranges.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Work order ID |
| work_order_no | VARCHAR(100) | UNIQUE, NOT NULL | Work order number (e.g., "WO-15072026-test1") |
| part_id | INT | FK → parts.id | Associated part |
| model_variant | VARCHAR(100) | | Part variant identifier |
| description | VARCHAR(255) | | Work order description |
| target_qty | INT | NOT NULL | Total target quantity |
| start_date | DATE | | Planned start date |
| end_date | DATE | | Planned end date |
| status | ENUM | DEFAULT 'draft' | draft, in_progress, completed, cancelled |
| spares_tools_json | TEXT | | JSON: required spares and tools |
| created_by | INT | FK → users.id | Creator |
| created_at | TIMESTAMP | | Creation timestamp |
| updated_at | TIMESTAMP | | Last update timestamp |

---

#### `oee_entries`
Manual OEE data entry — one row per machine per shift per date. Contains the full OEE breakdown with computed columns.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Entry ID |
| entry_date | DATE | NOT NULL | Date of entry |
| station_no | INT | NOT NULL | Station number |
| machine_id | INT | FK → machines.id | Machine |
| shift | VARCHAR(1) | NOT NULL | Shift ID |
| current_operation | VARCHAR(50) | | Operation code |
| next_operation | VARCHAR(50) | | Next operation |
| model_variant | VARCHAR(100) | | Part variant |
| process_time | DECIMAL(10,2) | | Process time (sec) |
| loading_unloading | DECIMAL(10,2) | | L&U time (sec) |
| **cycle_time** | DECIMAL(10,2) | **COMPUTED** | `= process_time + loading_unloading` |
| start_time | VARCHAR(10) | | Shift start (HH:MM) |
| stop_time | VARCHAR(10) | | Shift end (HH:MM) |
| total_minutes | INT | | Total shift minutes |
| lunch_break | INT | DEFAULT 0 | Lunch break (min) |
| tea_break | INT | DEFAULT 0 | Tea break (min) |
| tpm_cleaning | INT | DEFAULT 0 | TPM cleaning (min) |
| other_cleaning | INT | DEFAULT 0 | Other cleaning (min) |
| management_meeting | INT | DEFAULT 0 | Meeting time (min) |
| **total_breaks** | INT | **COMPUTED** | `= sum(all break columns)` |
| **shift_working_minutes** | INT | **COMPUTED** | `= total_minutes - total_breaks` |
| no_load | INT | DEFAULT 0 | No load loss (min) |
| new_model_trial | INT | DEFAULT 0 | Trial run loss (min) |
| power_cut | INT | DEFAULT 0 | Power cut (min) |
| planned_maintenance | INT | DEFAULT 0 | PM loss (min) |
| no_manpower_planned | INT | DEFAULT 0 | No manpower (min) |
| **management_loss_total** | INT | **COMPUTED** | `= sum(all management loss columns)` |
| available_shift_time | INT | | Available time after losses |
| setting_time | INT | DEFAULT 0 | Setting time (min) |
| tool_change | INT | DEFAULT 0 | Tool change (min) |
| dimension_correction | INT | DEFAULT 0 | Dimension correction (min) |
| scrap_removal | INT | DEFAULT 0 | Scrap removal (min) |
| break_down | INT | DEFAULT 0 | Breakdown (min) |
| **total_down_time** | INT | **COMPUTED** | `= sum(all downtime columns)` |
| operating_time | INT | | Operating time (min) |
| possible_qty | INT | | Maximum possible output |
| actual_qty | INT | | Actual parts produced |
| **production_loss** | INT | **COMPUTED** | `= possible_qty - actual_qty` |
| accp_qty | INT | | Accepted quantity |
| defect_qty | INT | | Defective quantity |
| ar | DECIMAL(6,2) | | Availability Rate % |
| pr | DECIMAL(6,2) | | Performance Rate % |
| qr | DECIMAL(6,2) | | Quality Rate % |
| oee | DECIMAL(6,2) | | OEE % |
| ar_raw | DECIMAL(7,2) | NULLABLE | Original uncapped AR (audit) |
| pr_raw | DECIMAL(7,2) | NULLABLE | Original uncapped PR (audit) |
| qr_raw | DECIMAL(7,2) | NULLABLE | Original uncapped QR (audit) |
| oee_raw | DECIMAL(7,2) | NULLABLE | Original uncapped OEE (audit) |
| created_by | INT | FK → users.id | Creator |

---

#### `machine_status_log`
Real-time machine status change journal. Every status transition is recorded with a timestamp.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Log ID |
| machine_id | INT | FK → machines.id, NOT NULL | Machine |
| status | VARCHAR(50) | NOT NULL | New status value |
| changed_at | DATETIME | NOT NULL | When the status changed |
| source | VARCHAR(50) | DEFAULT 'system' | system, mqtt, modbus, manual |
| deviation_reason | VARCHAR(500) | NULLABLE | Operator-entered reason for deviation |

**Used by:** Hourly Output, Loss Tracker, KPI calculations, Cycle Time Analysis

---

#### `machine_kpi_log`
Snapshot of calculated KPI metrics, saved for historical analysis.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Log ID |
| machine_id | INT | FK → machines.id, NOT NULL | Machine |
| entry_date | DATE | NOT NULL | Date |
| shift | VARCHAR(1) | NOT NULL | Shift ID |
| model_variant | VARCHAR(100) | | Part(s) running |
| available_time_min | FLOAT | | Available time (min) |
| operating_time_min | FLOAT | | Operating time (min) |
| downtime_min | FLOAT | | Downtime (min) |
| actual_production_time_min | FLOAT | | Running time only (min) |
| cycle_time_sec | FLOAT | | Cycle time used (sec) |
| planned_qty | INT | | Planned quantity |
| actual_qty | INT | | Actual quantity |
| good_qty | INT | | Good parts |
| defect_qty | INT | | Defective parts |
| expected_qty | INT | | Expected output (capacity) |
| theoretical_qty | INT | | Theoretical max output |
| ar | FLOAT | | Availability Rate % |
| pr | FLOAT | | Performance Rate % |
| qr | FLOAT | | Quality Rate % |
| oee | FLOAT | | OEE % |
| machine_utilization | FLOAT | | Machine Utilization Rate % |
| production_yield | FLOAT | | Production Yield % |
| teep | FLOAT | | TEEP % |
| computed_at | DATETIME | NOT NULL | Calculation timestamp |
| source | VARCHAR(20) | DEFAULT 'auto' | auto, manual |

**Index:** `idx_kpi_machine_date (machine_id, entry_date, shift)`

---

#### `parts`
Part master data including process parameters, QC configuration, and cycle profile.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Part ID |
| part_no | VARCHAR(100) | UNIQUE, NOT NULL | Part number |
| part_name | VARCHAR(255) | | Part name |
| model_variant | VARCHAR(100) | | Variant identifier |
| description | VARCHAR(255) | | Description |
| tool_no | VARCHAR(50) | | Tool number |
| no_of_cavity | INT | DEFAULT 1 | Cavities per cycle |
| production_section | VARCHAR(100) | | Production section |
| input_material | VARCHAR(255) | | Raw material spec |
| previous_operation | VARCHAR(255) | | Previous operation |
| next_operation | VARCHAR(255) | | Next operation |
| machine_type | VARCHAR(100) | | Required machine type |
| operation_code | VARCHAR(100) | | Operation code |
| operation_name | VARCHAR(100) | | Operation name |
| operation_sequence | TEXT | | JSON: sequence of operations |
| process_time | DECIMAL(10,2) | | Standard process time (sec) |
| loading_unloading | DECIMAL(10,2) | DEFAULT 10 | Standard L&U time (sec) |
| drawing_revision | VARCHAR(50) | | Current drawing revision |
| manufacturing_status | VARCHAR(50) | DEFAULT 'production' | production, prototype, etc. |
| manufacturing_status_other | VARCHAR(100) | | Free text status |
| image_url | VARCHAR(500) | | Part image path |
| sketch_image_url | VARCHAR(500) | | Part sketch path |
| qc_columns_json | TEXT | | JSON: QC column definitions |
| tools_params_json | TEXT | | JSON: tool parameters |
| machine_params_json | TEXT | | JSON: machine parameters |
| jigs_fixtures_json | TEXT | | JSON: jigs & fixtures |
| cycle_profile_json | TEXT | NULLABLE | JSON: multi-segment cycle stitching config |
| active | INT | DEFAULT 1 | 1 = active, 0 = inactive |
| created_by | INT | FK → users.id | Creator |
| created_at | TIMESTAMP | | Creation timestamp |
| updated_at | TIMESTAMP | | Last update timestamp |

---

### 3.2 Model Change & Maintenance Tables

#### `model_change_requests`
Interlock workflow when switching parts on a machine. Requires supervisor approval before production starts.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Request ID |
| machine_id | INT | FK → machines.id, NOT NULL | Target machine |
| plan_id | INT | FK → production_plans.id | Associated plan |
| requested_by | INT | FK → users.id, NOT NULL | Requester |
| approved_by | INT | FK → users.id | Approver |
| from_model | VARCHAR(100) | | Previous part/model |
| to_model | VARCHAR(100) | | New part/model |
| status | ENUM | DEFAULT 'pending' | pending, approved, in_progress, completed, rejected |
| ideal_minutes | INT | DEFAULT 60 | Target changeover time |
| shift | VARCHAR(1) | DEFAULT 'A' | Shift |
| entry_date | DATE | | Date |
| reason | VARCHAR(50) | DEFAULT 'setting_change' | Changeover reason |
| start_time | DATETIME | | Changeover start |
| end_time | DATETIME | | Changeover end |
| created_at | TIMESTAMP | | Creation timestamp |

---

#### `breakdown_tickets`
Breakdown incident tracking from raise to resolution.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK, AUTO_INCREMENT | Ticket ID |
| machine_id | INT | FK → machines.id, NOT NULL | Affected machine |
| raised_by | INT | FK → users.id, NOT NULL | Reporter |
| acknowledged_by | INT | FK → users.id | Acknowledger |
| description | TEXT | | Breakdown description |
| status | ENUM | DEFAULT 'raised' | raised, acknowledged, in_progress, resolved |
| ack_time | DATETIME | | Acknowledgement time |
| start_troubleshoot | DATETIME | | Troubleshooting start |
| resolved_time | DATETIME | | Resolution time |
| resolution_notes | TEXT | | Resolution description |
| created_at | TIMESTAMP | | Creation timestamp |

---

#### `deviation_alert_log`
Audit trail of deviation/breakdown/alarm alert emails sent.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | Log ID |
| sent_at | DATETIME | NOT NULL | Send timestamp |
| alert_type | VARCHAR(50) | NOT NULL | Alert category |
| machine_id | INT | FK → machines.id, NOT NULL | Affected machine |
| status | VARCHAR(50) | NOT NULL | Machine status at alert time |
| segment_log_id | INT | FK → machine_status_log.id | Triggering status change |
| breach_count | INT | DEFAULT 1 | Times threshold breached |
| duration_sec | INT | | Duration of the deviation |
| deviation_reason | VARCHAR(500) | | Operator-entered reason |
| recipients | TEXT | | Email recipients |
| subject | VARCHAR(255) | | Email subject |
| email_log_id | INT | FK → email_logs.id | Associated email log |
| delivery_status | VARCHAR(20) | DEFAULT 'sent' | sent, failed |
| escalation_level | INT | DEFAULT 0 | Escalation tier (0 = all) |

---

#### `deviation_escalation_cases`
Open deviation cases tracked for multi-level escalation until resolved.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | Case ID |
| segment_log_id | INT | FK → machine_status_log.id | Triggering event |
| machine_id | INT | FK → machines.id, NOT NULL | Machine |
| status | VARCHAR(50) | NOT NULL | Machine status |
| alert_type | VARCHAR(50) | NOT NULL | Alert type |
| current_level | INT | DEFAULT 1 | Current escalation level |
| opened_at | DATETIME | NOT NULL | Case opened time |
| last_escalated_at | DATETIME | NOT NULL | Last escalation time |
| resolved_at | DATETIME | NULLABLE | Resolution time |
| resolved_reason | VARCHAR(100) | NULLABLE | Resolution reason |

---

### 3.3 Quality Control Tables

#### `part_qc_parameters`
QC inspection parameters per part with optional SPC limits.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | Parameter ID |
| part_id | INT | FK → parts.id, NOT NULL | Parent part |
| seq_no | INT | NOT NULL, DEFAULT 1 | Sequence number |
| parameter | VARCHAR(100) | NOT NULL | Parameter name |
| std_value | VARCHAR(100) | | Standard value |
| method | VARCHAR(50) | | Measurement method |
| frequency | VARCHAR(50) | | Inspection frequency |
| is_numeric | INT | DEFAULT 0 | 1 = numeric (enables LSL/USL) |
| lsl | FLOAT | NULLABLE | Lower specification limit |
| usl | FLOAT | NULLABLE | Upper specification limit |
| extra_columns_json | TEXT | | JSON: additional columns |
| active | INT | DEFAULT 1 | Active flag |
| created_at | TIMESTAMP | | Creation timestamp |

---

#### `qc_inspection_reports`
Inspection report with multi-level approval workflow.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | Report ID |
| part_id | INT | FK → parts.id | Part inspected |
| machine_id | INT | FK → machines.id | Production machine |
| article_no | VARCHAR(100) | | Article number |
| machine_name | VARCHAR(100) | | Machine name snapshot |
| description | VARCHAR(255) | | Description |
| operation_code | VARCHAR(50) | | Operation code |
| operation_name | VARCHAR(100) | | Operation name |
| production_section | VARCHAR(100) | | Production section |
| shift | VARCHAR(1) | | Shift |
| inspection_date | DATE | NOT NULL | Inspection date |
| readings_json | TEXT | | JSON: measurement readings |
| operator_name / inspector_name / production_incharge | VARCHAR(100) | | Name snapshots |
| approval_json | TEXT | | JSON: approval workflow state |
| status | VARCHAR(30) | DEFAULT 'draft' | draft, pending, approved, etc. |
| operator_id / inspector_id / incharge_id | INT | FK → users.id | Approver user IDs |
| operator_approved_at / inspector_approved_at / incharge_approved_at | DATETIME | | Approval timestamps |
| submitted_by | INT | FK → users.id | Submitter |
| submitted_at | TIMESTAMP | | Submission time |

---

#### `oee_defect_log`
Audit trail when defect quantities are updated post-QC, capturing before/after OEE impact.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | Log ID |
| oee_entry_id | INT | FK → oee_entries.id, NOT NULL | Affected OEE entry |
| updated_at | DATETIME | NOT NULL | Update timestamp |
| updated_by | INT | FK → users.id | Updater |
| before_defect_qty / before_accp_qty | INT | | Before values |
| before_qr / before_oee | DECIMAL(5,2) | | Before QR/OEE |
| after_defect_qty / after_accp_qty | INT | | After values |
| after_qr / after_oee | DECIMAL(5,2) | | After QR/OEE |
| note | VARCHAR(500) | | Change note |

---

#### `part_documents` / `part_document_history`
Document revision management with full history.

| Column (part_documents) | Type | Description |
|--------------------------|------|-------------|
| id | INT | PK |
| part_id | INT | FK → parts.id |
| doc_type | VARCHAR(100) | Document type (drawing, SOP, etc.) |
| doc_label | VARCHAR(150) | Display label |
| revision | VARCHAR(20) | Current revision number |
| rev_date | DATE | Revision date |
| file_url | VARCHAR(500) | File path |
| is_current | INT | 1 = current revision |
| uploaded_by | INT | FK → users.id |

`part_document_history` has the same structure plus `archived_at`, `archived_by`, and `superseded_by` (FK → part_documents.id).

---

### 3.4 System & Email Tables

#### `users`
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | INT | PK | User ID |
| username | VARCHAR(50) | UNIQUE, NOT NULL | Login name |
| password_hash | VARCHAR(255) | NOT NULL | Bcrypt hash |
| role | ENUM | NOT NULL | operator, supervisor, maintenance, admin, quality |

#### `site_config`
| Column | Type | Description |
|--------|------|-------------|
| id | INT | PK |
| config_json | TEXT | JSON: shifts, breaks, thresholds, factory hierarchy, hourly output settings |

#### `email_smtp_config`
| Column | Type | Description |
|--------|------|-------------|
| id | INT | PK |
| smtp_server | VARCHAR(100) | SMTP host (default: smtp.gmail.com) |
| smtp_port | INT | Port (default: 587) |
| email_address | VARCHAR(150) | Sender email |
| email_password | VARCHAR(255) | Sender password |

#### `email_groups` → `email_recipients`
Groups of recipients for alert/report distribution.

#### `email_schedules`
Scheduled report delivery with configurable time and report type.

#### `email_logs`
Audit trail for all sent emails (status: sent/failed).

---

## 4. Query Patterns

### 4.1 Primary Pattern: Separate Queries + In-Memory Grouping

The most common pattern throughout the backend. Example from Hourly Output:

```python
# 4 independent queries
machines = db.query(Machine).order_by(Machine.station_id).all()
plans = db.query(ProductionPlan).filter(plan_date==date, shift==shift).all()
oee_all = db.query(OEEEntry).filter(entry_date==date, shift==shift).all()
mcrs_all = db.query(ModelChangeRequest).filter(entry_date==date, shift==shift).all()

# In-memory grouping by machine_id
plans_by_machine = {}
for p in plans:
    plans_by_machine.setdefault(p.machine_id, []).append(p)
```

**Why this works:** Data volumes per shift are small (typically <10 machines, <20 plans), so multiple simple queries with Python-side merging is efficient and readable.

### 4.2 Explicit SQL JOINs (3 instances only)

| Location | Tables Joined | Purpose |
|----------|--------------|---------|
| `work_orders.py` | `ProductionPlan` JOIN `WorkOrder` | Search/filter plans by work order fields |
| `parts.py` | `PartDocument` JOIN `Part` | Document listing with part info |
| `parts.py` | `PartDocumentHistory` JOIN `Part` | Document history with part info |

### 4.3 Aggregate Queries

```python
# Sum planned quantities across plans (plans.py)
db.query(func.coalesce(func.sum(ProductionPlan.planned_qty), 0))
  .filter(ProductionPlan.work_order_id == wo.id)
  .scalar()
```

### 4.4 Status-Based Filtering

Most queries filter by status to get "active" records:

```python
# Plans: active = running, completed, paused (excludes pending, cancelled)
ProductionPlan.status.in_(['running', 'completed', 'paused'])

# Model change: active workflow
ModelChangeRequest.status.in_(['in_progress', 'completed'])
```

### 4.5 Time-Range Queries

Status log queries use time-range filtering for shift boundaries:

```python
db.query(MachineStatusLog).filter(
    MachineStatusLog.machine_id == machine_id,
    MachineStatusLog.changed_at >= shift_start,
    MachineStatusLog.changed_at <= effective_end,
).order_by(MachineStatusLog.changed_at.asc()).all()
```

---

## 5. Computed Columns (MySQL Generated Columns)

The `oee_entries` table uses 6 MySQL Computed columns that auto-calculate values at the database level:

| Column | Formula |
|--------|---------|
| `cycle_time` | `process_time + loading_unloading` |
| `total_breaks` | `lunch_break + tea_break + tpm_cleaning + other_cleaning + management_meeting` |
| `shift_working_minutes` | `total_minutes - total_breaks` |
| `management_loss_total` | `no_load + new_model_trial + power_cut + planned_maintenance + no_manpower_planned` |
| `total_down_time` | `setting_time + tool_change + dimension_correction + scrap_removal + break_down` |
| `production_loss` | `possible_qty - actual_qty` |

All other calculations (OEE, AR, PR, QR, KPIs) are performed in the Python application layer.

---

## 6. JSON Storage Columns

Several tables use `TEXT` columns to store JSON data for flexible/nested structures:

| Table | Column | Content |
|-------|--------|---------|
| `site_config` | `config_json` | Shifts, breaks, thresholds, factory hierarchy |
| `parts` | `qc_columns_json` | QC column definitions |
| `parts` | `tools_params_json` | Tool parameters |
| `parts` | `machine_params_json` | Machine parameters |
| `parts` | `jigs_fixtures_json` | Jigs and fixtures config |
| `parts` | `cycle_profile_json` | Multi-segment cycle stitching config |
| `parts` | `operation_sequence` | Operation sequence definition |
| `work_orders` | `spares_tools_json` | Required spares and tools |
| `qc_inspection_reports` | `readings_json` | Measurement readings |
| `qc_inspection_reports` | `approval_json` | Approval workflow state |

---

## 7. Stored Procedures, Views & Triggers

**None.** The project does not use any MySQL stored procedures, views, or triggers. All business logic is implemented in the Python application layer using SQLAlchemy ORM queries and Python-based computation.

---

## 8. Data Flow Summary

```
Machine PLC/Manual → machine_status_log (real-time status journal)
                         │
                         ├──→ Hourly Output (computed per-slot from status segments)
                         ├──→ Loss Tracker (shift utilization breakdown)
                         ├──→ Machine KPI (OEE/AR/PR/QR computed) → machine_kpi_log
                         └──→ Dashboard (real-time OEE merged with manual data)

Work Order → Production Plan → Model Change Request → Machine Status
    │              │
    │              └──→ oee_entries (manual data entry)
    │                        │
    │                        └──→ oee_defect_log (QC audit trail)
    │
    └──→ Part → Part QC Parameters → QC Inspection Reports

Site Config (JSON) → Shift definitions, break windows, thresholds
                         │
                         └──→ Used by all computation endpoints
```
