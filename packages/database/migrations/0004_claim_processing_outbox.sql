CREATE TABLE IF NOT EXISTS claim_processing_outbox (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  job_type VARCHAR(64) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(64) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  idempotency_key CHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  leased_at TIMESTAMP(3) NULL,
  lease_expires_at TIMESTAMP(3) NULL,
  leased_by VARCHAR(128) NULL,
  last_error VARCHAR(255) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_claim_processing_outbox_tenant_idempotency (tenant_id, idempotency_key),
  INDEX idx_claim_processing_outbox_tenant (tenant_id),
  INDEX idx_claim_processing_outbox_available (status, available_at, created_at),
  INDEX idx_claim_processing_outbox_lease_expiry (status, lease_expires_at),
  INDEX idx_claim_processing_outbox_created (created_at),
  CONSTRAINT fk_claim_processing_outbox_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (tenant_id)
    ON DELETE RESTRICT
);
