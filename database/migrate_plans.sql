-- Legacy upgrade: production_plans table (skip if already created by schema.sql)
USE eap_pms;

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
    loading_unloading INT NOT NULL DEFAULT 10,
    planned_qty INT NOT NULL,
    actual_qty INT NOT NULL DEFAULT 0,
    priority INT NOT NULL DEFAULT 1,
    status ENUM('pending','running','completed','paused','cancelled') DEFAULT 'pending',
    plan_type ENUM('scheduled','urgent','trial') DEFAULT 'scheduled',
    notes TEXT,
    created_by INT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

SET @db = DATABASE();
SET @c = (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema=@db AND table_name='production_plans' AND index_name='idx_plan_date_shift');
SET @sql = IF(@c=0,
  'CREATE INDEX idx_plan_date_shift ON production_plans(plan_date, shift, station_no)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
