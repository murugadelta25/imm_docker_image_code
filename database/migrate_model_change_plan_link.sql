-- Link model change requests to production plans (planning Run interlock)

SET @db = DATABASE();

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='model_change_requests' AND column_name='plan_id');
SET @sql = IF(@c=0, "ALTER TABLE model_change_requests ADD COLUMN plan_id INT NULL, ADD INDEX idx_mcr_plan (plan_id)", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Widen model fields for part numbers like TL/TQW/DI/11/250/81
ALTER TABLE model_change_requests MODIFY COLUMN from_model VARCHAR(100) NULL;
ALTER TABLE model_change_requests MODIFY COLUMN to_model VARCHAR(100) NULL;
