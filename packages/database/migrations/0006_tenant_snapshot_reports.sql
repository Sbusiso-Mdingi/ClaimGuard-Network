ALTER TABLE claims ADD COLUMN created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE claims ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
ALTER TABLE claims ADD INDEX idx_claims_tenant_updated (tenant_id, updated_at, claim_id);

ALTER TABLE claim_processing_outbox ADD COLUMN covered_report_id CHAR(64) NULL;
ALTER TABLE claim_processing_outbox ADD COLUMN covered_watermark VARCHAR(255) NULL;
ALTER TABLE claim_processing_outbox ADD COLUMN covered_at TIMESTAMP(3) NULL;
ALTER TABLE claim_processing_outbox ADD INDEX idx_claim_processing_outbox_coverage
  (tenant_id, covered_report_id, covered_at);
