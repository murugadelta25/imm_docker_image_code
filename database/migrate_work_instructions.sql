-- Work instructions, part master, QC parameters, inspection reports
-- Applied to the database in DATABASE_URL (no USE statement).

CREATE TABLE IF NOT EXISTS parts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_no VARCHAR(100) NOT NULL UNIQUE,
    model_variant VARCHAR(100),
    description VARCHAR(255),
    tool_no VARCHAR(50),
    no_of_cavity INT DEFAULT 1,
    production_section VARCHAR(100),
    operation_code VARCHAR(50),
    operation_name VARCHAR(100),
    process_time DECIMAL(10,2),
    loading_unloading DECIMAL(10,2) DEFAULT 10,
    active TINYINT(1) DEFAULT 1,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS part_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    part_id INT NOT NULL,
    doc_type ENUM('control_plan','wi_visual','wi_tray','breakdown_sheet') NOT NULL,
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
    doc_type ENUM('control_plan','wi_visual','wi_tray','breakdown_sheet') NOT NULL,
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
