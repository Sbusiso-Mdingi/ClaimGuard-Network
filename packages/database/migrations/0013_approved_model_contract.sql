ALTER TABLE providers
  ADD COLUMN provider_kind VARCHAR(64) NULL,
  ADD COLUMN provider_category VARCHAR(128) NULL;

UPDATE providers
SET
  provider_kind = COALESCE(NULLIF(provider_kind, ''), 'UNKNOWN'),
  provider_category = COALESCE(NULLIF(provider_category, ''), 'UNKNOWN');

ALTER TABLE providers
  MODIFY COLUMN provider_kind VARCHAR(64) NOT NULL,
  MODIFY COLUMN provider_category VARCHAR(128) NOT NULL;

ALTER TABLE claims
  ADD COLUMN received_date DATE NULL,
  ADD COLUMN quantity DECIMAL(12, 3) NULL,
  ADD COLUMN benefit_option VARCHAR(128) NULL,
  ADD COLUMN network_type VARCHAR(64) NULL,
  ADD COLUMN line_type VARCHAR(64) NULL,
  ADD COLUMN tariff_discipline VARCHAR(128) NULL,
  ADD COLUMN diagnosis_code VARCHAR(32) NULL,
  ADD COLUMN rendering_practitioner_id VARCHAR(128) NULL,
  ADD COLUMN rendering_practitioner_category VARCHAR(128) NULL,
  ADD COLUMN rendering_known_to_billing_provider TINYINT(1) NULL;

UPDATE claims
SET
  received_date = COALESCE(received_date, service_date),
  quantity = COALESCE(quantity, 1.000),
  benefit_option = COALESCE(NULLIF(benefit_option, ''), 'UNKNOWN'),
  network_type = COALESCE(NULLIF(network_type, ''), 'UNKNOWN'),
  line_type = COALESCE(NULLIF(line_type, ''), 'UNKNOWN'),
  tariff_discipline = COALESCE(NULLIF(tariff_discipline, ''), 'UNKNOWN'),
  diagnosis_code = COALESCE(NULLIF(diagnosis_code, ''), 'UNKNOWN'),
  rendering_practitioner_category = CASE
    WHEN rendering_practitioner_id IS NULL OR rendering_practitioner_id = '' THEN 'NONE'
    ELSE COALESCE(NULLIF(rendering_practitioner_category, ''), 'UNKNOWN')
  END,
  rendering_known_to_billing_provider = COALESCE(rendering_known_to_billing_provider, 0);

ALTER TABLE claims
  MODIFY COLUMN received_date DATE NOT NULL,
  MODIFY COLUMN quantity DECIMAL(12, 3) NOT NULL,
  MODIFY COLUMN benefit_option VARCHAR(128) NOT NULL,
  MODIFY COLUMN network_type VARCHAR(64) NOT NULL,
  MODIFY COLUMN line_type VARCHAR(64) NOT NULL,
  MODIFY COLUMN tariff_discipline VARCHAR(128) NOT NULL,
  MODIFY COLUMN diagnosis_code VARCHAR(32) NOT NULL,
  MODIFY COLUMN rendering_practitioner_category VARCHAR(128) NOT NULL,
  MODIFY COLUMN rendering_known_to_billing_provider TINYINT(1) NOT NULL;

UPDATE detection_strategies
SET
  strategy_type = 'deterministic_rules',
  model_deployment_id = NULL
WHERE strategy_type <> 'deterministic_rules';

ALTER TABLE claim_processing_outbox
  ADD COLUMN failure_code VARCHAR(64) NULL,
  ADD COLUMN failed_watermark VARCHAR(1024) NULL,
  ADD INDEX idx_claim_processing_outbox_failure
    (tenant_id, failure_code, updated_at);

UPDATE data_plane_metadata
SET schema_version = '13', migration_version = 13
WHERE metadata_key = 'primary';
