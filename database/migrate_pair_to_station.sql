-- Upgrade existing databases: pair terminology -> station terminology
-- Safe to re-run (checks information_schema before each change)

USE eap_pms;

-- pairs -> stations
SET @has_pairs = (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'pairs');
SET @has_stations = (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'stations');
SET @sql = IF(@has_pairs > 0 AND @has_stations = 0, 'RENAME TABLE pairs TO stations', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- machines.pair_id -> station_id
SET @has_pair_id = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'machines' AND column_name = 'pair_id');
SET @sql = IF(@has_pair_id > 0,
  'ALTER TABLE machines CHANGE COLUMN pair_id station_id INT NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- oee_entries
SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'oee_entries' AND column_name = 'pair_no');
SET @sql = IF(@c > 0, 'ALTER TABLE oee_entries CHANGE COLUMN pair_no station_no INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'oee_entries' AND column_name = 'ip_stock_no');
SET @sql = IF(@c > 0, 'ALTER TABLE oee_entries CHANGE COLUMN ip_stock_no current_operation VARCHAR(50)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'oee_entries' AND column_name = 'op_stock_no');
SET @sql = IF(@c > 0, 'ALTER TABLE oee_entries CHANGE COLUMN op_stock_no next_operation VARCHAR(50)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'oee_entries' AND column_name = 'model_variant');
SET @sql = IF(@c = 0, 'ALTER TABLE oee_entries ADD COLUMN model_variant VARCHAR(100) NULL AFTER next_operation', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- production_plans
SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'production_plans' AND column_name = 'pair_no');
SET @sql = IF(@c > 0, 'ALTER TABLE production_plans CHANGE COLUMN pair_no station_no INT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'production_plans' AND column_name = 'ip_stock_no');
SET @sql = IF(@c > 0, 'ALTER TABLE production_plans CHANGE COLUMN ip_stock_no current_operation VARCHAR(50) NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'production_plans' AND column_name = 'op_stock_no');
SET @sql = IF(@c > 0, 'ALTER TABLE production_plans CHANGE COLUMN op_stock_no next_operation VARCHAR(50) NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'production_plans' AND column_name = 'model_variant');
SET @sql = IF(@c = 0, 'ALTER TABLE production_plans ADD COLUMN model_variant VARCHAR(100) NULL AFTER next_operation', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
