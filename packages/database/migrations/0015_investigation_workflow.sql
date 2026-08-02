ALTER TABLE investigations
  ADD COLUMN record_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER priority,
  ADD CONSTRAINT chk_investigations_record_version CHECK (record_version > 0);

ALTER TABLE investigation_evidence
  ADD COLUMN content_type VARCHAR(128) NULL AFTER evidence_type,
  ADD COLUMN byte_size INT UNSIGNED NULL AFTER content_type,
  ADD COLUMN content_sha256 CHAR(64) NULL AFTER byte_size,
  ADD COLUMN storage_object_key VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER content_sha256,
  ADD UNIQUE KEY uq_investigation_evidence_storage_object (storage_object_key),
  ADD CONSTRAINT chk_investigation_evidence_byte_size CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 10485760),
  ADD CONSTRAINT chk_investigation_evidence_sha256 CHECK (content_sha256 IS NULL OR content_sha256 REGEXP '^[0-9a-f]{64}$'),
  ADD CONSTRAINT chk_investigation_evidence_storage_metadata CHECK (
    (content_type IS NULL AND byte_size IS NULL AND content_sha256 IS NULL AND storage_object_key IS NULL)
    OR
    (content_type IS NOT NULL AND byte_size IS NOT NULL AND content_sha256 IS NOT NULL AND storage_object_key IS NOT NULL)
  );

CREATE TABLE investigation_activity_events (
  activity_event_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  investigation_id VARCHAR(64) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  action VARCHAR(64) NOT NULL,
  before_summary JSON NULL,
  after_summary JSON NULL,
  correlation_id VARCHAR(128) NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_investigation_activity_tenant_case_time (tenant_id, investigation_id, occurred_at),
  CONSTRAINT fk_investigation_activity_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES investigations (tenant_id, investigation_id)
    ON DELETE CASCADE
);

UPDATE data_plane_metadata
SET schema_version = '15', migration_version = 15
WHERE metadata_key = 'primary';
