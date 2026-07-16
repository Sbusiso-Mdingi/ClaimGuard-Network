CREATE TABLE IF NOT EXISTS ledger_sequence_allocator (
  allocator_id TINYINT UNSIGNED PRIMARY KEY,
  next_sequence BIGINT UNSIGNED NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

INSERT INTO ledger_sequence_allocator (allocator_id, next_sequence)
SELECT 1, COALESCE(MAX(sequence_number), 0) + 1
FROM ledger_entries
ON DUPLICATE KEY UPDATE next_sequence = ledger_sequence_allocator.next_sequence;

CREATE TABLE IF NOT EXISTS ledger_chain_heads (
  tenant_id VARCHAR(64) PRIMARY KEY,
  last_sequence_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_entry_hash CHAR(64) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ledger_chain_heads_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (tenant_id)
    ON DELETE RESTRICT
);

INSERT INTO ledger_chain_heads (tenant_id, last_sequence_number, last_entry_hash)
SELECT
  tenant.tenant_id,
  COALESCE((
    SELECT MAX(entry.sequence_number)
    FROM ledger_entries entry
    WHERE entry.tenant_id = tenant.tenant_id
  ), 0),
  COALESCE((
    SELECT entry.entry_hash
    FROM ledger_entries entry
    WHERE entry.tenant_id = tenant.tenant_id
    ORDER BY entry.sequence_number DESC
    LIMIT 1
  ), REPEAT('0', 64))
FROM tenants tenant
ON DUPLICATE KEY UPDATE last_entry_hash = ledger_chain_heads.last_entry_hash;

ALTER TABLE ledger_entries ADD COLUMN operation_id CHAR(64) NULL;
ALTER TABLE ledger_entries ADD COLUMN operation_type VARCHAR(32) NULL;
ALTER TABLE ledger_entries ADD COLUMN investigation_id VARCHAR(64) NULL;
ALTER TABLE ledger_entries ADD COLUMN reversed_ledger_entry_id INT NULL;
ALTER TABLE ledger_entries ADD COLUMN actor_id VARCHAR(255) NULL;
ALTER TABLE ledger_entries ADD COLUMN actor_role VARCHAR(64) NULL;
ALTER TABLE ledger_entries ADD COLUMN correlation_id VARCHAR(128) NULL;
ALTER TABLE ledger_entries ADD COLUMN workflow_version INT UNSIGNED NULL;
ALTER TABLE ledger_entries ADD UNIQUE KEY uq_ledger_entries_operation_id (operation_id);
ALTER TABLE ledger_entries ADD INDEX idx_ledger_entries_tenant_investigation (tenant_id, investigation_id, sequence_number);
ALTER TABLE ledger_entries ADD INDEX idx_ledger_entries_reversed_entry (reversed_ledger_entry_id);
ALTER TABLE ledger_entries ADD CONSTRAINT fk_ledger_entries_reversed_entry
  FOREIGN KEY (reversed_ledger_entry_id) REFERENCES ledger_entries (id) ON DELETE RESTRICT;

ALTER TABLE investigations ADD COLUMN confirmation_operation_id CHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN confirmation_intent_hash CHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN confirmation_ledger_entry_id INT NULL;
ALTER TABLE investigations ADD COLUMN confirmed_by VARCHAR(255) NULL;
ALTER TABLE investigations ADD COLUMN confirmed_by_role VARCHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN confirmation_correlation_id VARCHAR(128) NULL;
ALTER TABLE investigations ADD COLUMN registry_publication_required TINYINT(1) NULL;
ALTER TABLE investigations ADD COLUMN registry_publication_reason VARCHAR(255) NULL;
ALTER TABLE investigations ADD COLUMN reversal_operation_id CHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN reversal_intent_hash CHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN reversal_ledger_entry_id INT NULL;
ALTER TABLE investigations ADD COLUMN reversal_reason VARCHAR(1024) NULL;
ALTER TABLE investigations ADD COLUMN reversed_by VARCHAR(255) NULL;
ALTER TABLE investigations ADD COLUMN reversed_by_role VARCHAR(64) NULL;
ALTER TABLE investigations ADD COLUMN reversed_at TIMESTAMP(3) NULL;
ALTER TABLE investigations ADD COLUMN reversal_correlation_id VARCHAR(128) NULL;
ALTER TABLE investigations ADD COLUMN workflow_version INT UNSIGNED NULL;
ALTER TABLE investigations ADD UNIQUE KEY uq_investigations_confirmation_operation (confirmation_operation_id);
ALTER TABLE investigations ADD UNIQUE KEY uq_investigations_reversal_operation (reversal_operation_id);
ALTER TABLE investigations ADD UNIQUE KEY uq_investigations_confirmation_ledger (confirmation_ledger_entry_id);
ALTER TABLE investigations ADD UNIQUE KEY uq_investigations_reversal_ledger (reversal_ledger_entry_id);
ALTER TABLE investigations ADD CONSTRAINT fk_investigations_confirmation_ledger
  FOREIGN KEY (confirmation_ledger_entry_id) REFERENCES ledger_entries (id) ON DELETE RESTRICT;
ALTER TABLE investigations ADD CONSTRAINT fk_investigations_reversal_ledger
  FOREIGN KEY (reversal_ledger_entry_id) REFERENCES ledger_entries (id) ON DELETE RESTRICT;

ALTER TABLE shared_fraud_registry_entries ADD COLUMN confirmation_operation_id CHAR(64) NULL;
ALTER TABLE shared_fraud_registry_entries ADD COLUMN reversal_operation_id CHAR(64) NULL;
ALTER TABLE shared_fraud_registry_entries ADD UNIQUE KEY uq_registry_tenant_investigation_status (tenant_id, investigation_id, status);
ALTER TABLE shared_fraud_registry_entries ADD UNIQUE KEY uq_registry_confirmation_operation (confirmation_operation_id);
ALTER TABLE shared_fraud_registry_entries ADD UNIQUE KEY uq_registry_reversal_operation (reversal_operation_id);
ALTER TABLE shared_fraud_registry_entries ADD UNIQUE KEY uq_registry_reversal_target (reverses_registry_entry_id);
ALTER TABLE shared_fraud_registry_entries ADD CONSTRAINT fk_registry_investigation
  FOREIGN KEY (tenant_id, investigation_id)
  REFERENCES investigations (tenant_id, investigation_id) ON DELETE RESTRICT;
ALTER TABLE shared_fraud_registry_entries ADD CONSTRAINT fk_registry_ledger_hash
  FOREIGN KEY (ledger_hash) REFERENCES ledger_entries (entry_hash) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS fraud_workflow_operations (
  operation_id CHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  operation_type VARCHAR(32) NOT NULL,
  investigation_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  ledger_entry_id INT NOT NULL,
  registry_entry_id VARCHAR(64) NULL,
  result_payload JSON NOT NULL,
  workflow_version INT UNSIGNED NOT NULL DEFAULT 1,
  completed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_fraud_workflow_tenant_type_investigation (tenant_id, operation_type, investigation_id),
  UNIQUE KEY uq_fraud_workflow_tenant_type_key (tenant_id, operation_type, idempotency_key),
  INDEX idx_fraud_workflow_actor (tenant_id, actor_id, completed_at),
  INDEX idx_fraud_workflow_ledger (ledger_entry_id),
  INDEX idx_fraud_workflow_registry (registry_entry_id),
  CONSTRAINT fk_fraud_workflow_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants (tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fraud_workflow_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES investigations (tenant_id, investigation_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fraud_workflow_ledger
    FOREIGN KEY (ledger_entry_id)
    REFERENCES ledger_entries (id)
    ON DELETE RESTRICT
);
