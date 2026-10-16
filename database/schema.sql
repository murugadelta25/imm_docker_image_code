-- EAP PMS — full schema (tables only, no business seed data)
-- Placeholder DB name "eap_pms" is substituted at deploy time by:
--   Windows: database/init_database.ps1
--   Ubuntu:  scripts/setup-database.sh (apply_sql_file)

CREATE DATABASE IF NOT EXISTS eap_pms;
USE eap_pms;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('operator','supervisor','maintenance','admin') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS machines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    station_id INT NOT NULL,
    status ENUM('running','idle','breakdown','setting_change','alarm','offline') DEFAULT 'idle',
    machine_type VARCHAR(50) DEFAULT 'CNC',
    make VARCHAR(100),
    model_no VARCHAR(100),
    tonnage VARCHAR(50),
    features TEXT,
    image_url VARCHAR(500),
    location VARCHAR(100),
    plc_source ENUM('manual','mqtt','modbus','opcua') DEFAULT 'manual',
    plc_endpoint VARCHAR(255),
    plc_topic VARCHAR(255),
    FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE IF NOT EXISTS oee_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_date DATE NOT NULL,
    station_no INT NOT NULL,
    machine_id INT,
    shift CHAR(1) NOT NULL,
    current_operation VARCHAR(50),
    next_operation VARCHAR(50),
    model_variant VARCHAR(100),
    process_time INT,
    loading_unloading INT,
    cycle_time INT GENERATED ALWAYS AS (process_time + loading_unloading) STORED,
    start_time TIME,
    stop_time TIME,
    total_minutes INT,
    lunch_break INT DEFAULT 0,
    tea_break INT DEFAULT 0,
    tpm_cleaning INT DEFAULT 0,
    other_cleaning INT DEFAULT 0,
    management_meeting INT DEFAULT 0,
    total_breaks INT GENERATED ALWAYS AS (lunch_break + tea_break + tpm_cleaning + other_cleaning + management_meeting) STORED,
    shift_working_minutes INT GENERATED ALWAYS AS (total_minutes - (lunch_break + tea_break + tpm_cleaning + other_cleaning + management_meeting)) STORED,
    no_load INT DEFAULT 0,
    new_model_trial INT DEFAULT 0,
    power_cut INT DEFAULT 0,
    planned_maintenance INT DEFAULT 0,
    no_manpower_planned INT DEFAULT 0,
    management_loss_total INT GENERATED ALWAYS AS (no_load + new_model_trial + power_cut + planned_maintenance + no_manpower_planned) STORED,
    available_shift_time INT,
    setting_time INT DEFAULT 0,
    tool_change INT DEFAULT 0,
    dimension_correction INT DEFAULT 0,
    scrap_removal INT DEFAULT 0,
    break_down INT DEFAULT 0,
    total_down_time INT GENERATED ALWAYS AS (setting_time + tool_change + dimension_correction + scrap_removal + break_down) STORED,
    operating_time INT,
    possible_qty INT,
    actual_qty INT,
    production_loss INT GENERATED ALWAYS AS (possible_qty - actual_qty) STORED,
    accp_qty INT,
    defect_qty INT,
    ar DECIMAL(5,2),
    pr DECIMAL(5,2),
    qr DECIMAL(5,2),
    oee DECIMAL(5,2),
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS oee_defect_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    oee_entry_id INT NOT NULL,
    updated_at DATETIME NOT NULL,
    updated_by INT,
    before_defect_qty INT,
    before_accp_qty INT,
    before_qr DECIMAL(5,2),
    before_oee DECIMAL(5,2),
    after_defect_qty INT,
    after_accp_qty INT,
    after_qr DECIMAL(5,2),
    after_oee DECIMAL(5,2),
    note VARCHAR(500),
    FOREIGN KEY (oee_entry_id) REFERENCES oee_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS model_change_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    machine_id INT NOT NULL,
    requested_by INT NOT NULL,
    approved_by INT,
    from_model VARCHAR(50),
    to_model VARCHAR(50),
    status ENUM('pending','approved','in_progress','completed','rejected') DEFAULT 'pending',
    ideal_minutes INT DEFAULT 60,
    shift CHAR(1) DEFAULT 'A',
    entry_date DATE,
    reason VARCHAR(50) DEFAULT 'setting_change',
    start_time DATETIME,
    end_time DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS breakdown_tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    machine_id INT NOT NULL,
    raised_by INT NOT NULL,
    acknowledged_by INT,
    description TEXT,
    downtime_type VARCHAR(20),
    downtime_reason VARCHAR(100),
    raised_by_name VARCHAR(100),
    status ENUM('raised','acknowledged','in_progress','resolved') DEFAULT 'raised',
    ack_time DATETIME,
    start_troubleshoot DATETIME,
    resolved_time DATETIME,
    resolution_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (raised_by) REFERENCES users(id),
    FOREIGN KEY (acknowledged_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS production_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plan_date DATE NOT NULL,
    shift CHAR(1) NOT NULL,
    station_no INT NOT NULL,
    machine_id INT,
    current_operation VARCHAR(50) NOT NULL,
    next_operation VARCHAR(50) NOT NULL,
    model_variant VARCHAR(100),
    process_time INT NOT NULL,
    loading_unloading INT DEFAULT 10,
    planned_qty INT NOT NULL,
    actual_qty INT DEFAULT 0,
    priority INT DEFAULT 1,
    status ENUM('pending','running','completed','paused','cancelled') DEFAULT 'pending',
    plan_type ENUM('scheduled','urgent','trial') DEFAULT 'scheduled',
    notes TEXT,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    INDEX idx_plan_date (plan_date),
    INDEX idx_station_no (station_no),
    INDEX idx_shift (shift),
    INDEX idx_status (status)
);

CREATE TABLE IF NOT EXISTS machine_status_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    machine_id INT NOT NULL,
    status VARCHAR(50) NOT NULL,
    changed_at DATETIME NOT NULL,
    source VARCHAR(50) DEFAULT 'system',
    deviation_reason VARCHAR(500) NULL,
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    config_json LONGTEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description VARCHAR(200),
    report_types VARCHAR(100) DEFAULT 'oee,planning,breakdown'
);

CREATE TABLE IF NOT EXISTS email_recipients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    active INT DEFAULT 1,
    FOREIGN KEY (group_id) REFERENCES email_groups(id)
);

CREATE TABLE IF NOT EXISTS email_schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    group_ids VARCHAR(200) NOT NULL,
    report_type VARCHAR(50) DEFAULT 'daily',
    send_hour INT DEFAULT 18,
    send_minute INT DEFAULT 0,
    attach_report TINYINT(1) DEFAULT 1,
    active INT DEFAULT 1,
    last_sent TIMESTAMP NULL
);

CREATE TABLE IF NOT EXISTS email_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recipients TEXT,
    subject VARCHAR(255),
    report_type VARCHAR(50),
    status VARCHAR(20) DEFAULT 'sent',
    error_msg TEXT,
    sent_by INT,
    FOREIGN KEY (sent_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS email_smtp_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    smtp_server VARCHAR(100) DEFAULT 'smtp.gmail.com',
    smtp_port INT DEFAULT 587,
    email_address VARCHAR(150),
    email_password VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS parts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_no VARCHAR(100) NOT NULL UNIQUE,
    part_name VARCHAR(255),
    model_variant VARCHAR(100),
    description VARCHAR(255),
    tool_no VARCHAR(50),
    no_of_cavity INT DEFAULT 1,
    production_section VARCHAR(100),
    input_material VARCHAR(255),
    previous_operation VARCHAR(255),
    next_operation VARCHAR(255),
    machine_type VARCHAR(100),
    operation_code VARCHAR(100),
    operation_name VARCHAR(100),
    operation_sequence TEXT,
    process_time DECIMAL(10,2),
    loading_unloading DECIMAL(10,2) DEFAULT 10,
    drawing_revision VARCHAR(50),
    manufacturing_status VARCHAR(50) DEFAULT 'production',
    manufacturing_status_other VARCHAR(100),
    image_url VARCHAR(500),
    sketch_image_url VARCHAR(500),
    qc_columns_json TEXT,
    tools_params_json TEXT,
    machine_params_json TEXT,
    jigs_fixtures_json TEXT,
    cycle_profile_json TEXT NULL DEFAULT NULL,
    active TINYINT(1) DEFAULT 1,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS part_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_id INT NOT NULL,
    doc_type VARCHAR(100) NOT NULL,
    doc_label VARCHAR(150),
    revision VARCHAR(20) NOT NULL DEFAULT '0',
    rev_date DATE,
    file_url VARCHAR(500),
    is_current TINYINT(1) DEFAULT 1,
    uploaded_by INT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id),
    INDEX idx_part_doc_current (part_id, doc_type, is_current)
);

CREATE TABLE IF NOT EXISTS part_document_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_id INT NOT NULL,
    doc_type VARCHAR(100) NOT NULL,
    doc_label VARCHAR(150),
    revision VARCHAR(20) NOT NULL,
    rev_date DATE,
    file_url VARCHAR(500) NOT NULL,
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_by INT,
    superseded_by INT,
    notes TEXT,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE,
    FOREIGN KEY (archived_by) REFERENCES users(id),
    FOREIGN KEY (superseded_by) REFERENCES part_documents(id)
);

CREATE TABLE IF NOT EXISTS part_qc_parameters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_id INT NOT NULL,
    seq_no INT NOT NULL DEFAULT 1,
    parameter VARCHAR(100) NOT NULL,
    std_value VARCHAR(100),
    method VARCHAR(50),
    frequency VARCHAR(50),
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE,
    INDEX idx_part_qc (part_id, active, seq_no)
);

CREATE TABLE IF NOT EXISTS qc_inspection_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_id INT,
    machine_id INT,
    article_no VARCHAR(100),
    machine_name VARCHAR(100),
    description VARCHAR(255),
    operation_code VARCHAR(50),
    operation_name VARCHAR(100),
    production_section VARCHAR(100),
    shift CHAR(1),
    inspection_date DATE NOT NULL,
    readings_json TEXT,
    operator_name VARCHAR(100),
    inspector_name VARCHAR(100),
    production_incharge VARCHAR(100),
    approval_json TEXT,
    submitted_by INT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts(id),
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (submitted_by) REFERENCES users(id)
);
