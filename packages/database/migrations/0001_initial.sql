CREATE TABLE IF NOT EXISTS schemes (
  scheme_id VARCHAR(8) PRIMARY KEY,
  scheme_name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  member_id VARCHAR(32) PRIMARY KEY,
  scheme_id VARCHAR(8) NOT NULL,
  first_name VARCHAR(128) NOT NULL,
  last_name VARCHAR(128) NOT NULL,
  date_of_birth DATE NOT NULL,
  gender CHAR(1) NOT NULL,
  synthetic_id_number VARCHAR(32) NOT NULL,
  synthetic_banking_detail VARCHAR(255) NOT NULL,
  home_region VARCHAR(128) NOT NULL,
  home_lat DECIMAL(10, 5) NOT NULL,
  home_lon DECIMAL(10, 5) NOT NULL,
  join_date DATE NOT NULL,
  INDEX idx_members_scheme_id (scheme_id),
  CONSTRAINT fk_members_scheme_id FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS providers (
  provider_id VARCHAR(32) PRIMARY KEY,
  scheme_id VARCHAR(8) NOT NULL,
  practice_number VARCHAR(32) NOT NULL,
  specialty VARCHAR(64) NOT NULL,
  practice_name VARCHAR(255) NOT NULL,
  synthetic_banking_detail VARCHAR(255) NOT NULL,
  practice_region VARCHAR(128) NOT NULL,
  practice_lat DECIMAL(10, 5) NOT NULL,
  practice_lon DECIMAL(10, 5) NOT NULL,
  INDEX idx_providers_scheme_id (scheme_id),
  CONSTRAINT fk_providers_scheme_id FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id VARCHAR(32) PRIMARY KEY,
  scheme_id VARCHAR(8) NOT NULL,
  member_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(32) NOT NULL,
  service_date DATE NOT NULL,
  billing_code VARCHAR(32) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  INDEX idx_claims_scheme_id (scheme_id),
  INDEX idx_claims_member_id (member_id),
  INDEX idx_claims_provider_id (provider_id),
  CONSTRAINT fk_claims_scheme_id FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE,
  CONSTRAINT fk_claims_member_id FOREIGN KEY (member_id) REFERENCES members (member_id) ON DELETE CASCADE,
  CONSTRAINT fk_claims_provider_id FOREIGN KEY (provider_id) REFERENCES providers (provider_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sequence_number INT NOT NULL,
  entry_type VARCHAR(64) NOT NULL,
  previous_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL UNIQUE,
  payload JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ledger_entries_sequence_number (sequence_number)
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  tenant_slug VARCHAR(128) NOT NULL UNIQUE,
  tenant_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS medical_schemes (
  medical_scheme_id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  scheme_id VARCHAR(8) NOT NULL,
  scheme_name VARCHAR(255) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_medical_schemes_tenant_scheme (tenant_id, scheme_id),
  UNIQUE KEY uq_medical_schemes_scheme_id (scheme_id),
  INDEX idx_medical_schemes_tenant_id (tenant_id),
  CONSTRAINT fk_medical_schemes_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_medical_schemes_scheme_id FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE
);

ALTER TABLE schemes
  ADD COLUMN tenant_id VARCHAR(64) NULL;

ALTER TABLE members
  ADD COLUMN tenant_id VARCHAR(64) NULL;

ALTER TABLE providers
  ADD COLUMN tenant_id VARCHAR(64) NULL;

ALTER TABLE claims
  ADD COLUMN tenant_id VARCHAR(64) NULL;

ALTER TABLE ledger_entries
  ADD COLUMN tenant_id VARCHAR(64) NULL;

ALTER TABLE schemes
  ADD INDEX idx_schemes_tenant_id (tenant_id),
  ADD CONSTRAINT fk_schemes_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT;

ALTER TABLE members
  ADD INDEX idx_members_tenant_id (tenant_id),
  ADD CONSTRAINT fk_members_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT;

ALTER TABLE providers
  ADD INDEX idx_providers_tenant_id (tenant_id),
  ADD CONSTRAINT fk_providers_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT;

ALTER TABLE claims
  ADD INDEX idx_claims_tenant_id (tenant_id),
  ADD CONSTRAINT fk_claims_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT;

ALTER TABLE ledger_entries
  ADD INDEX idx_ledger_entries_tenant_id (tenant_id),
  ADD CONSTRAINT fk_ledger_entries_tenant_id FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT;

INSERT INTO tenants (tenant_id, tenant_slug, tenant_name, status)
VALUES ('tenant_default', 'default', 'Default Medical Scheme Tenant', 'active')
ON DUPLICATE KEY UPDATE
  tenant_slug = VALUES(tenant_slug),
  tenant_name = VALUES(tenant_name),
  status = VALUES(status);

UPDATE schemes
SET tenant_id = 'tenant_default'
WHERE tenant_id IS NULL;

UPDATE members m
JOIN schemes s ON s.scheme_id = m.scheme_id
SET m.tenant_id = s.tenant_id
WHERE m.tenant_id IS NULL;

UPDATE providers p
JOIN schemes s ON s.scheme_id = p.scheme_id
SET p.tenant_id = s.tenant_id
WHERE p.tenant_id IS NULL;

UPDATE claims c
JOIN schemes s ON s.scheme_id = c.scheme_id
SET c.tenant_id = s.tenant_id
WHERE c.tenant_id IS NULL;

UPDATE ledger_entries
SET tenant_id = 'tenant_default'
WHERE tenant_id IS NULL;

INSERT INTO medical_schemes (tenant_id, scheme_id, scheme_name, is_primary)
SELECT s.tenant_id, s.scheme_id, s.scheme_name, 1
FROM schemes s
ON DUPLICATE KEY UPDATE
  tenant_id = VALUES(tenant_id),
  scheme_name = VALUES(scheme_name);