CREATE TABLE IF NOT EXISTS model_deployments (
  deployment_id VARCHAR(128) PRIMARY KEY,
  model_id VARCHAR(128) NOT NULL,
  model_version VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  owner_type VARCHAR(32) NOT NULL,
  owner_organisation_id CHAR(36) NULL,
  lifecycle_status VARCHAR(32) NOT NULL DEFAULT 'candidate',
  request_schema_version VARCHAR(128) NOT NULL,
  response_schema_version VARCHAR(128) NOT NULL,
  feature_schema_version VARCHAR(128) NOT NULL,
  analysis_mode VARCHAR(128) NOT NULL,
  decision_threshold DECIMAL(20, 18) NOT NULL,
  runtime_config_key VARCHAR(96) NOT NULL,
  artifact_sha256 CHAR(64) NULL,
  container_image_digest VARCHAR(255) NULL,
  capabilities JSON NOT NULL,
  automatic_adverse_action TINYINT(1) NOT NULL DEFAULT 0,
  registered_by VARCHAR(255) NOT NULL,
  validated_at TIMESTAMP(3) NULL,
  activated_at TIMESTAMP(3) NULL,
  retired_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_model_deployment_runtime_key (runtime_config_key),
  INDEX idx_model_deployment_owner_status (owner_type, owner_organisation_id, lifecycle_status),
  CONSTRAINT fk_model_deployment_owner FOREIGN KEY (owner_organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_model_deployment_owner CHECK (
    (owner_type = 'claimguard' AND owner_organisation_id IS NULL)
    OR (owner_type = 'scheme' AND owner_organisation_id IS NOT NULL)
  ),
  CONSTRAINT chk_model_deployment_lifecycle CHECK (
    lifecycle_status IN ('candidate', 'validated', 'canary', 'active', 'retired', 'rejected')
  ),
  CONSTRAINT chk_model_deployment_threshold CHECK (
    decision_threshold >= 0 AND decision_threshold <= 1
  ),
  CONSTRAINT chk_model_no_automatic_adverse_action CHECK (
    automatic_adverse_action = 0
  )
);

INSERT INTO model_deployments (
  deployment_id,
  model_id,
  model_version,
  display_name,
  owner_type,
  owner_organisation_id,
  lifecycle_status,
  request_schema_version,
  response_schema_version,
  feature_schema_version,
  analysis_mode,
  decision_threshold,
  runtime_config_key,
  artifact_sha256,
  container_image_digest,
  capabilities,
  automatic_adverse_action,
  registered_by,
  validated_at,
  activated_at
) VALUES (
  'claimguard-claim-fraud-baseline:1.0.0',
  'claimguard-claim-fraud-baseline',
  '1.0.0',
  'ClaimGuard prospective fraud baseline 1.0.0',
  'claimguard',
  NULL,
  'active',
  'claimguard.claim-screening-request.v3',
  'claimguard.claim-screening-response.v3',
  'claim-feature-schema-2026.2',
  'PROSPECTIVE_CLAIM_SCREENING',
  0.087609710014347230,
  'CLAIMGUARD_CLAIM_FRAUD_BASELINE_1_0_0_6E9ED9BC2DEA',
  NULL,
  NULL,
  JSON_OBJECT('prospectiveClaimScreening', TRUE, 'networkEnrichment', FALSE),
  0,
  'control-plane-migration-0012',
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
) ON DUPLICATE KEY UPDATE deployment_id = VALUES(deployment_id);
