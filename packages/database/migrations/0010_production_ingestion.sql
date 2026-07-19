ALTER TABLE investigations DROP FOREIGN KEY fk_investigations_claim_id;

ALTER TABLE medical_schemes DROP FOREIGN KEY fk_medical_schemes_scheme_id;

ALTER TABLE claims
  DROP FOREIGN KEY fk_claims_scheme_id,
  DROP FOREIGN KEY fk_claims_member_id,
  DROP FOREIGN KEY fk_claims_provider_id;

ALTER TABLE members DROP FOREIGN KEY fk_members_scheme_id;

ALTER TABLE providers DROP FOREIGN KEY fk_providers_scheme_id;

ALTER TABLE schemes
  MODIFY COLUMN scheme_id VARCHAR(64) NOT NULL;

ALTER TABLE medical_schemes
  MODIFY COLUMN scheme_id VARCHAR(64) NOT NULL;

ALTER TABLE members
  MODIFY COLUMN member_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN scheme_id VARCHAR(64) NOT NULL,
  MODIFY COLUMN gender VARCHAR(32) NOT NULL,
  CHANGE COLUMN synthetic_id_number identity_number VARCHAR(128) NOT NULL,
  CHANGE COLUMN synthetic_banking_detail banking_detail VARCHAR(255) NOT NULL;

ALTER TABLE providers
  MODIFY COLUMN provider_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN scheme_id VARCHAR(64) NOT NULL,
  MODIFY COLUMN practice_number VARCHAR(64) NOT NULL,
  MODIFY COLUMN specialty VARCHAR(128) NOT NULL,
  CHANGE COLUMN synthetic_banking_detail banking_detail VARCHAR(255) NOT NULL;

ALTER TABLE claims
  MODIFY COLUMN claim_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN scheme_id VARCHAR(64) NOT NULL,
  MODIFY COLUMN member_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN provider_id VARCHAR(128) NOT NULL,
  MODIFY COLUMN billing_code VARCHAR(64) NOT NULL;

ALTER TABLE investigations
  MODIFY COLUMN claim_id VARCHAR(128) NOT NULL;

ALTER TABLE members
  ADD CONSTRAINT fk_members_scheme_id
    FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE;

ALTER TABLE providers
  ADD CONSTRAINT fk_providers_scheme_id
    FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE;

ALTER TABLE claims
  ADD CONSTRAINT fk_claims_scheme_id
    FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_claims_member_id
    FOREIGN KEY (member_id) REFERENCES members (member_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_claims_provider_id
    FOREIGN KEY (provider_id) REFERENCES providers (provider_id) ON DELETE CASCADE;

ALTER TABLE medical_schemes
  ADD CONSTRAINT fk_medical_schemes_scheme_id
    FOREIGN KEY (scheme_id) REFERENCES schemes (scheme_id) ON DELETE CASCADE;

ALTER TABLE investigations
  ADD CONSTRAINT fk_investigations_claim_id
    FOREIGN KEY (claim_id) REFERENCES claims (claim_id) ON DELETE RESTRICT;

DROP TABLE IF EXISTS simulation_tick_history;

DROP TABLE IF EXISTS simulation_leases;

DROP TABLE IF EXISTS simulation_instances;

UPDATE data_plane_metadata
SET schema_version = '10', migration_version = 10
WHERE metadata_key = 'primary';
