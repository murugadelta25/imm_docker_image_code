-- QC approval workflow, part image, dynamic QC columns

ALTER TABLE parts ADD COLUMN image_url VARCHAR(500) NULL;

ALTER TABLE part_qc_parameters ADD COLUMN extra_columns_json TEXT NULL;

ALTER TABLE qc_inspection_reports ADD COLUMN status VARCHAR(30) DEFAULT 'draft';
ALTER TABLE qc_inspection_reports ADD COLUMN operator_id INT NULL;
ALTER TABLE qc_inspection_reports ADD COLUMN inspector_id INT NULL;
ALTER TABLE qc_inspection_reports ADD COLUMN incharge_id INT NULL;
ALTER TABLE qc_inspection_reports ADD COLUMN operator_approved_at DATETIME NULL;
ALTER TABLE qc_inspection_reports ADD COLUMN inspector_approved_at DATETIME NULL;
ALTER TABLE qc_inspection_reports ADD COLUMN incharge_approved_at DATETIME NULL;
