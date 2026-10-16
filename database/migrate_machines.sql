-- Legacy upgrade: add machine detail columns (MySQL 8 compatible — skips if column exists)
USE eap_pms;

SET @db = DATABASE();

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='machine_type');
SET @sql = IF(@c=0, "ALTER TABLE machines ADD COLUMN machine_type VARCHAR(50) DEFAULT 'CNC'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='make');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN make VARCHAR(100)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='model_no');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN model_no VARCHAR(100)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='tonnage');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN tonnage VARCHAR(50)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='features');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN features TEXT', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='image_url');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN image_url VARCHAR(500)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='location');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN location VARCHAR(100)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='plc_source');
SET @sql = IF(@c=0, "ALTER TABLE machines ADD COLUMN plc_source ENUM('manual','mqtt','modbus','opcua') DEFAULT 'manual'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='plc_endpoint');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN plc_endpoint VARCHAR(255)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='machines' AND column_name='plc_topic');
SET @sql = IF(@c=0, 'ALTER TABLE machines ADD COLUMN plc_topic VARCHAR(255)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='oee_entries' AND column_name='machine_id');
SET @sql = IF(@c=0, 'ALTER TABLE oee_entries ADD COLUMN machine_id INT NULL AFTER station_no', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
