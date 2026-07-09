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