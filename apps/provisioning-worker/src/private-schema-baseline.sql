CREATE TABLE IF NOT EXISTS private_migration_history (
  migration_id VARCHAR(128) PRIMARY KEY,
  applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS data_plane_metadata (
  metadata_key VARCHAR(64) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  route_type VARCHAR(32) NOT NULL,
  logical_database_identifier VARCHAR(128) NOT NULL,
  schema_version VARCHAR(64) NOT NULL,
  migration_version VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS members (
  member_id VARCHAR(64) PRIMARY KEY,
  tenant_member_id VARCHAR(64) UNIQUE,
  first_name VARCHAR(128) NOT NULL,
  last_name VARCHAR(128) NOT NULL,
  date_of_birth DATE NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS providers (
  provider_id VARCHAR(64) PRIMARY KEY,
  practice_number VARCHAR(64) UNIQUE,
  practice_name VARCHAR(255) NOT NULL,
  specialty VARCHAR(128) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id VARCHAR(64) PRIMARY KEY,
  member_id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  service_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_private_claim_member FOREIGN KEY (member_id) REFERENCES members(member_id),
  CONSTRAINT fk_private_claim_provider FOREIGN KEY (provider_id) REFERENCES providers(provider_id)
);

CREATE TABLE IF NOT EXISTS investigations (
  investigation_id VARCHAR(64) PRIMARY KEY,
  claim_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  priority VARCHAR(32) NOT NULL DEFAULT 'NORMAL',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_private_investigation_claim FOREIGN KEY (claim_id) REFERENCES claims(claim_id)
);

CREATE TABLE IF NOT EXISTS claim_processing_outbox (
  id VARCHAR(64) PRIMARY KEY,
  job_type VARCHAR(64) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS report_production_state (
  state_key VARCHAR(64) PRIMARY KEY,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS report_watermarks (
  watermark_key VARCHAR(64) PRIMARY KEY,
  watermark_value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS trust_publication_outbox (
  id VARCHAR(64) PRIMARY KEY,
  payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS simulator_state_checkpoints (
  checkpoint_key VARCHAR(64) PRIMARY KEY,
  checkpoint JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
