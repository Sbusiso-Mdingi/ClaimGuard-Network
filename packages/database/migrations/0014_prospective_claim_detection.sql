CREATE TABLE claim_versions (
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(32) NOT NULL,
  claim_version INT NOT NULL,

  scheme_id VARCHAR(8) NOT NULL,
  member_id VARCHAR(32) NOT NULL,
  provider_id VARCHAR(32) NOT NULL,
  service_date DATE NOT NULL,
  received_date DATE NOT NULL,
  billing_code VARCHAR(32) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,

  claim_payload JSON NOT NULL,
  version_reason VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (
    tenant_id,
    claim_id,
    claim_version
  )
);

ALTER TABLE claim_processing_outbox
ADD COLUMN detection_strategy_id INT NULL,
ADD COLUMN strategy_type VARCHAR(64) NULL,
ADD COLUMN model_deployment_id VARCHAR(128) NULL;

ALTER TABLE detection_strategies
ADD COLUMN activated_at TIMESTAMP(3) NULL,
ADD COLUMN deactivated_at TIMESTAMP(3) NULL,
ADD COLUMN actor VARCHAR(255) NULL,
ADD COLUMN change_reason TEXT NULL;

UPDATE detection_strategies
SET activated_at = created_at
WHERE is_active = 1 AND activated_at IS NULL;

INSERT INTO detection_strategies (
  tenant_id,
  strategy_type,
  model_deployment_id,
  is_active,
  activated_at,
  actor,
  change_reason
)
SELECT
  t.tenant_id,
  'deterministic_rules',
  NULL,
  1,
  UTC_TIMESTAMP(3),
  'migration:0014',
  'Backfill explicit default detection strategy'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1
  FROM detection_strategies ds
  WHERE ds.tenant_id = t.tenant_id
    AND ds.is_active = 1
);

CREATE TABLE claim_detection_results (
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(32) NOT NULL,
  claim_version INT NOT NULL,
  detection_strategy_id INT NOT NULL,
  strategy_type VARCHAR(64) NOT NULL,
  model_deployment_id VARCHAR(128) NULL,
  scored_at TIMESTAMP(3) NOT NULL,
  result_payload JSON NOT NULL,
  PRIMARY KEY (tenant_id, claim_id, claim_version)
);

UPDATE data_plane_metadata
SET schema_version = '14',
    migration_version = GREATEST(migration_version, 14);
