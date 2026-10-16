-- Allow dynamic work-instruction document types (beyond fixed ENUM values)

SET @db = DATABASE();

ALTER TABLE part_documents MODIFY COLUMN doc_type VARCHAR(100) NOT NULL;
ALTER TABLE part_document_history MODIFY COLUMN doc_type VARCHAR(100) NOT NULL;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='part_documents' AND column_name='doc_label');
SET @sql = IF(@c=0, "ALTER TABLE part_documents ADD COLUMN doc_label VARCHAR(150) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @c = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=@db AND table_name='part_document_history' AND column_name='doc_label');
SET @sql = IF(@c=0, "ALTER TABLE part_document_history ADD COLUMN doc_label VARCHAR(150) NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
