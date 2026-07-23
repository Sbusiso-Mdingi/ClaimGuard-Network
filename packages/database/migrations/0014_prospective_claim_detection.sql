-- Phase 14: prospective-only, immutable claim-version scoring.
--
-- Invariants established by this migration:
--   1. Existing claims become immutable baseline version 1 records.
--   2. Creating baseline versions does not enqueue scoring work.
--   3. Future claim amendments create new immutable claim versions.
--   4. Detection jobs pin the strategy active at ingestion time.
--   5. Detection results are unique and immutable per claim version.
--   6. Legacy retrospective report jobs cannot be processed accidentally.

-- ---------------------------------------------------------------------------
-- Claims and immutable claim versions
-- ---------------------------------------------------------------------------

ALTER TABLE claims
  ADD COLUMN current_claim_version INT UNSIGNED NULL AFTER claim_id,
  ADD UNIQUE INDEX uq_claims_tenant_claim (
    tenant_id,
    claim_id
  );

-- Earlier migrations already backfilled tenant ownership, but make the
-- invariant explicit before claim_versions introduces a composite foreign key.
UPDATE claims c
INNER JOIN schemes s
  ON s.scheme_id = c.scheme_id
SET c.tenant_id = s.tenant_id
WHERE c.tenant_id IS NULL;

ALTER TABLE claims
  MODIFY COLUMN tenant_id VARCHAR(64) NOT NULL;

CREATE TABLE claim_versions (
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  claim_version INT UNSIGNED NOT NULL,

  scheme_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(128) NOT NULL,
  provider_id VARCHAR(128) NOT NULL,

  service_date DATE NOT NULL,
  received_date DATE NOT NULL,
  billing_code VARCHAR(64) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,

  claim_payload JSON NOT NULL,

  -- Legacy baseline rows are intentionally nullable. The ingestion repository
  -- canonicalises and stores the stable SHA-256 hash the first time such a row
  -- is compared with a newly submitted claim.
  payload_hash CHAR(64) NULL,

  version_reason VARCHAR(64) NOT NULL,

  created_at TIMESTAMP(3)
    NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (
    tenant_id,
    claim_id,
    claim_version
  ),

  INDEX idx_claim_versions_tenant_created (
    tenant_id,
    created_at,
    claim_id,
    claim_version
  ),

  INDEX idx_claim_versions_member_created (
    tenant_id,
    member_id,
    created_at,
    claim_id,
    claim_version
  ),

  INDEX idx_claim_versions_provider_created (
    tenant_id,
    provider_id,
    created_at,
    claim_id,
    claim_version
  ),

  INDEX idx_claim_versions_billing_created (
    tenant_id,
    billing_code,
    created_at,
    claim_id,
    claim_version
  ),

  CONSTRAINT chk_claim_versions_positive_version
    CHECK (claim_version > 0),

  CONSTRAINT chk_claim_versions_payload_hash
    CHECK (
      payload_hash IS NULL
      OR payload_hash REGEXP '^[0-9a-f]{64}$'
    ),

  CONSTRAINT fk_claim_versions_claim
    FOREIGN KEY (
      tenant_id,
      claim_id
    )
    REFERENCES claims (
      tenant_id,
      claim_id
    )
    ON DELETE RESTRICT
);

-- Existing claims become immutable historical baseline records. They are not
-- enqueued and therefore are not retrospectively scored.
INSERT INTO claim_versions (
  tenant_id,
  claim_id,
  claim_version,
  scheme_id,
  member_id,
  provider_id,
  service_date,
  received_date,
  billing_code,
  amount,
  claim_payload,
  payload_hash,
  version_reason,
  created_at
)
SELECT
  c.tenant_id,
  c.claim_id,
  1,
  c.scheme_id,
  c.member_id,
  c.provider_id,
  c.service_date,
  c.received_date,
  c.billing_code,
  c.amount,
  JSON_OBJECT(
    'claim_id',
    c.claim_id,

    'scheme_id',
    c.scheme_id,

    'member_id',
    c.member_id,

    'provider_id',
    c.provider_id,

    'service_date',
    DATE_FORMAT(
      c.service_date,
      '%Y-%m-%d'
    ),

    'received_date',
    DATE_FORMAT(
      c.received_date,
      '%Y-%m-%d'
    ),

    'billing_code',
    c.billing_code,

    'amount',
    CAST(
      c.amount AS CHAR
    ),

    'quantity',
    CAST(
      c.quantity AS CHAR
    ),

    'benefit_option',
    c.benefit_option,

    'network_type',
    c.network_type,

    'line_type',
    c.line_type,

    'tariff_discipline',
    c.tariff_discipline,

    'diagnosis_code',
    c.diagnosis_code,

    'rendering_practitioner_id',
    c.rendering_practitioner_id,

    'rendering_practitioner_category',
    c.rendering_practitioner_category,

    'rendering_known_to_billing_provider',
    IF(
      c.rendering_known_to_billing_provider = 1,
      TRUE,
      FALSE
    )
  ),
  NULL,
  'legacy_baseline',
  c.created_at
FROM claims c;

UPDATE claims
SET current_claim_version = 1
WHERE current_claim_version IS NULL;

ALTER TABLE claims
  MODIFY COLUMN current_claim_version
    INT UNSIGNED
    NOT NULL,
  ADD CONSTRAINT chk_claims_current_version
    CHECK (
      current_claim_version > 0
    );

-- A foreign key from claims.current_claim_version back to claim_versions is
-- intentionally not added. It would create a circular insertion dependency:
-- new claims must exist before their immutable version row can reference them.
-- The ingestion transaction enforces this pointer atomically.

-- ---------------------------------------------------------------------------
-- Detection strategy audit history
-- ---------------------------------------------------------------------------

ALTER TABLE detection_strategies
  ADD COLUMN activated_at
    TIMESTAMP(3) NULL,

  ADD COLUMN deactivated_at
    TIMESTAMP(3) NULL,

  ADD COLUMN actor
    VARCHAR(255) NULL,

  ADD COLUMN change_reason
    VARCHAR(500) NULL;

UPDATE detection_strategies
SET
  activated_at = COALESCE(
    activated_at,
    created_at
  ),

  actor = COALESCE(
    NULLIF(
      actor,
      ''
    ),
    'migration:0014'
  ),

  change_reason = COALESCE(
    NULLIF(
      change_reason,
      ''
    ),
    'Backfilled pre-audit detection strategy'
  );

UPDATE detection_strategies
SET deactivated_at = COALESCE(
  deactivated_at,
  updated_at
)
WHERE is_active = 0;

-- Every tenant must have one explicit active strategy. This replaces the former
-- synthetic fallback behaviour.
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
  'Created explicit default prospective detection strategy'
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1
  FROM detection_strategies ds
  WHERE ds.tenant_id = t.tenant_id
    AND ds.is_active = 1
);

ALTER TABLE detection_strategies
  MODIFY COLUMN activated_at
    TIMESTAMP(3)
    NOT NULL,

  MODIFY COLUMN actor
    VARCHAR(255)
    NOT NULL,

  MODIFY COLUMN change_reason
    VARCHAR(500)
    NOT NULL,

  ADD INDEX idx_detection_strategies_tenant_activated (
    tenant_id,
    activated_at,
    id
  ),

  ADD CONSTRAINT chk_detection_strategy_configuration
    CHECK (
      (
        strategy_type = 'deterministic_rules'
        AND model_deployment_id IS NULL
      )
      OR
      (
        strategy_type = 'approved_model'
        AND model_deployment_id IS NOT NULL
        AND model_deployment_id <> ''
      )
    );

-- ---------------------------------------------------------------------------
-- Strategy-pinned claim-detection outbox jobs
-- ---------------------------------------------------------------------------

ALTER TABLE claim_processing_outbox
  ADD COLUMN detection_strategy_id
    INT NULL,

  ADD COLUMN strategy_type
    VARCHAR(64) NULL,

  ADD COLUMN model_deployment_id
    VARCHAR(128) NULL,

  ADD INDEX idx_claim_outbox_strategy (
    tenant_id,
    detection_strategy_id,
    status,
    available_at
  ),

  ADD CONSTRAINT fk_claim_outbox_strategy
    FOREIGN KEY (
      detection_strategy_id
    )
    REFERENCES detection_strategies (
      id
    )
    ON DELETE RESTRICT,

  ADD CONSTRAINT chk_claim_outbox_strategy
    CHECK (
      job_type <> 'claim_detection'
      OR
      (
        detection_strategy_id IS NOT NULL
        AND
        (
          (
            strategy_type = 'deterministic_rules'
            AND model_deployment_id IS NULL
          )
          OR
          (
            strategy_type = 'approved_model'
            AND model_deployment_id IS NOT NULL
            AND model_deployment_id <> ''
          )
        )
      )
    );

-- Legacy report_production jobs do not contain a historically pinned strategy
-- or claim version. Converting them using today's strategy would amount to
-- retrospective rescoring, so unfinished jobs are terminally cancelled.
UPDATE claim_processing_outbox
SET
  status = 'dead_letter',

  completed_at = UTC_TIMESTAMP(3),

  leased_at = NULL,

  lease_expires_at = NULL,

  leased_by = NULL,

  last_error =
    'Legacy retrospective report-production job cancelled during prospective-only migration.',

  failure_code =
    'LEGACY_RETROSPECTIVE_JOB_CANCELLED',

  failed_watermark = NULL

WHERE job_type = 'report_production'
  AND status IN (
    'pending',
    'retry',
    'processing'
  );

-- ---------------------------------------------------------------------------
-- Immutable claim-version detection results
-- ---------------------------------------------------------------------------

CREATE TABLE claim_detection_results (
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  claim_version INT UNSIGNED NOT NULL,

  detection_strategy_id INT NOT NULL,
  strategy_type VARCHAR(64) NOT NULL,
  model_deployment_id VARCHAR(128) NULL,

  source_job_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NOT NULL,

  analysis_mode VARCHAR(64) NOT NULL,

  ensemble_id VARCHAR(128) NULL,
  ensemble_version VARCHAR(64) NULL,
  feature_schema_version VARCHAR(128) NULL,

  scored_at TIMESTAMP(3) NOT NULL,

  result_payload JSON NOT NULL,
  result_hash CHAR(64) NOT NULL,

  created_at TIMESTAMP(3)
    NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (
    tenant_id,
    claim_id,
    claim_version
  ),

  UNIQUE KEY uq_detection_result_job_target (
    tenant_id,
    source_job_id,
    claim_id,
    claim_version
  ),

  INDEX idx_detection_results_strategy (
    tenant_id,
    detection_strategy_id,
    scored_at
  ),

  INDEX idx_detection_results_job (
    tenant_id,
    source_job_id
  ),

  INDEX idx_detection_results_scored (
    tenant_id,
    scored_at,
    claim_id,
    claim_version
  ),

  CONSTRAINT chk_detection_results_version
    CHECK (
      claim_version > 0
    ),

  CONSTRAINT chk_detection_results_hash
    CHECK (
      result_hash
        REGEXP '^[0-9a-f]{64}$'
    ),

  CONSTRAINT chk_detection_results_strategy
    CHECK (
      (
        strategy_type = 'deterministic_rules'
        AND model_deployment_id IS NULL
        AND ensemble_id IS NULL
        AND ensemble_version IS NULL
      )
      OR
      (
        strategy_type = 'approved_model'
        AND model_deployment_id IS NOT NULL
        AND model_deployment_id <> ''
        AND ensemble_id IS NOT NULL
        AND ensemble_id <> ''
        AND ensemble_version IS NOT NULL
        AND ensemble_version <> ''
        AND feature_schema_version IS NOT NULL
        AND feature_schema_version <> ''
      )
    ),

  CONSTRAINT fk_detection_result_claim_version
    FOREIGN KEY (
      tenant_id,
      claim_id,
      claim_version
    )
    REFERENCES claim_versions (
      tenant_id,
      claim_id,
      claim_version
    )
    ON DELETE RESTRICT,

  CONSTRAINT fk_detection_result_strategy
    FOREIGN KEY (
      detection_strategy_id
    )
    REFERENCES detection_strategies (
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT fk_detection_result_source_job
    FOREIGN KEY (
      source_job_id
    )
    REFERENCES claim_processing_outbox (
      id
    )
    ON DELETE RESTRICT
);

-- Detection decisions cannot be rewritten after insertion.
CREATE TRIGGER trg_detection_results_no_update
BEFORE UPDATE ON claim_detection_results
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT =
  'claim_detection_results rows are immutable';

CREATE TRIGGER trg_detection_results_no_delete
BEFORE DELETE ON claim_detection_results
FOR EACH ROW
SIGNAL SQLSTATE '45000'
SET MESSAGE_TEXT =
  'claim_detection_results rows cannot be deleted';

-- ---------------------------------------------------------------------------
-- Data-plane compatibility version
-- ---------------------------------------------------------------------------

UPDATE data_plane_metadata
SET
  schema_version = '14',
  migration_version = GREATEST(
    migration_version,
    14
  )
WHERE metadata_key = 'primary';
