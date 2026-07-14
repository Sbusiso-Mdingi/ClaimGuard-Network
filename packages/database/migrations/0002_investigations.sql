CREATE TABLE IF NOT EXISTS investigations (
  investigation_id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(32) NOT NULL,
  assigned_investigator VARCHAR(255) NULL,
  assigned_by VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  priority VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  closed_at TIMESTAMP(3) NULL,
  fraud_confirmed_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_investigations_tenant_claim (tenant_id, claim_id),
  UNIQUE KEY uq_investigations_tenant_investigation (tenant_id, investigation_id),
  INDEX idx_investigations_tenant_status (tenant_id, status),
  INDEX idx_investigations_assigned_investigator (assigned_investigator),
  CONSTRAINT fk_investigations_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_investigations_claim_id FOREIGN KEY (claim_id) REFERENCES claims (claim_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS investigation_notes (
  note_id VARCHAR(64) PRIMARY KEY,
  investigation_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  author VARCHAR(255) NOT NULL,
  note_text TEXT NOT NULL,
  note_type VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_investigation_notes_investigation (tenant_id, investigation_id, created_at),
  CONSTRAINT fk_investigation_notes_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES investigations (tenant_id, investigation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS investigation_evidence (
  evidence_id VARCHAR(64) PRIMARY KEY,
  investigation_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  filename VARCHAR(512) NOT NULL,
  description TEXT NULL,
  uploaded_by VARCHAR(255) NOT NULL,
  uploaded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  evidence_type VARCHAR(64) NOT NULL,
  INDEX idx_investigation_evidence_investigation (tenant_id, investigation_id, uploaded_at),
  CONSTRAINT fk_investigation_evidence_investigation
    FOREIGN KEY (tenant_id, investigation_id)
    REFERENCES investigations (tenant_id, investigation_id)
    ON DELETE CASCADE
);
