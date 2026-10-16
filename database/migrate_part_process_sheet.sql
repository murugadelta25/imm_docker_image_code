-- Process Control Sheet fields on part master (tools / machine / jigs tables, sketch, header fields)

SET @db = DATABASE();

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='part_name');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN part_name VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='input_material');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN input_material VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='previous_operation');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN previous_operation VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='next_operation');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN next_operation VARCHAR(255) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='machine_type');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN machine_type VARCHAR(100) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='operation_sequence');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN operation_sequence TEXT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='drawing_revision');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN drawing_revision VARCHAR(50) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='manufacturing_status');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN manufacturing_status VARCHAR(50) NULL DEFAULT 'production'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='manufacturing_status_other');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN manufacturing_status_other VARCHAR(100) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='sketch_image_url');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN sketch_image_url VARCHAR(500) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='tools_params_json');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN tools_params_json TEXT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='machine_params_json');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN machine_params_json TEXT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='jigs_fixtures_json');
SET @sql = IF(@c=0, "ALTER TABLE parts ADD COLUMN jigs_fixtures_json TEXT NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Allow longer operation codes (e.g. OP20, OP30, OP40)
SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='parts' AND column_name='operation_code' AND character_maximum_length < 100);
SET @sql = IF(@c>0, "ALTER TABLE parts MODIFY COLUMN operation_code VARCHAR(100) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
