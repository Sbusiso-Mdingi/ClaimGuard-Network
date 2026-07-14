CREATE TABLE IF NOT EXISTS shared_fraud_registry_entries (
  registry_entry_id VARCHAR(64) PRIMARY KEY,
  ledger_hash CHAR(64) NOT NULL,
  investigation_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  medical_scheme VARCHAR(255) NOT NULL,
  fraud_subject_type VARCHAR(32) NOT NULL,
  subject_token VARCHAR(255) NOT NULL,
  offence_category VARCHAR(128) NOT NULL,
  finding_date DATE NOT NULL,
  investigator_reference VARCHAR(255) NOT NULL,
  publication_timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status VARCHAR(16) NOT NULL,
  reverses_registry_entry_id VARCHAR(64) NULL,
  UNIQUE KEY uq_shared_fraud_registry_ledger_hash (ledger_hash),
  INDEX idx_shared_fraud_registry_subject (subject_token, fraud_subject_type, publication_timestamp),
  INDEX idx_shared_fraud_registry_investigation (tenant_id, investigation_id, publication_timestamp),
  INDEX idx_shared_fraud_registry_reversal (reverses_registry_entry_id),
  CONSTRAINT fk_shared_fraud_registry_reversal
    FOREIGN KEY (reverses_registry_entry_id)
    REFERENCES shared_fraud_registry_entries (registry_entry_id)
    ON DELETE RESTRICT
);
