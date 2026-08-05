-- Sequrin PR 1: additive domain-safety foundation.
-- Historical fraud and registry rows are intentionally preserved and are not
-- converted into approved network notices.

CREATE TABLE detection_signals (
  signal_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  claim_version INT UNSIGNED NOT NULL,
  detection_strategy_id INT NOT NULL,
  strategy_type VARCHAR(64) NOT NULL,
  model_deployment_id VARCHAR(128) NULL,
  source_job_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  reason_codes JSON NOT NULL,
  evidence_references JSON NOT NULL,
  model_or_rule_version VARCHAR(128) NULL,
  feature_schema_version VARCHAR(128) NULL,
  input_provenance JSON NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  generated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  signal_state VARCHAR(64) NOT NULL DEFAULT 'SIGNAL_GENERATED',
  PRIMARY KEY (signal_id),
  UNIQUE KEY uq_detection_signals_result (tenant_id, claim_id, claim_version),
  INDEX idx_detection_signals_tenant_state_time (tenant_id, signal_state, generated_at),
  INDEX idx_detection_signals_tenant_strategy (tenant_id, detection_strategy_id, generated_at),
  INDEX idx_detection_signals_tenant_job (tenant_id, source_job_id),
  CONSTRAINT chk_detection_signals_version CHECK (claim_version > 0),
  CONSTRAINT chk_detection_signals_state CHECK (signal_state = 'SIGNAL_GENERATED'),
  CONSTRAINT chk_detection_signals_reason_codes CHECK (JSON_TYPE(reason_codes) = 'ARRAY'),
  CONSTRAINT chk_detection_signals_evidence_refs CHECK (JSON_TYPE(evidence_references) = 'ARRAY'),
  CONSTRAINT chk_detection_signals_provenance CHECK (JSON_TYPE(input_provenance) = 'OBJECT'),
  CONSTRAINT chk_detection_signals_strategy CHECK (
    (strategy_type = 'deterministic_rules' AND model_deployment_id IS NULL)
    OR
    (strategy_type = 'approved_model' AND model_deployment_id IS NOT NULL AND model_deployment_id <> '')
  ),
  CONSTRAINT fk_detection_signal_result
    FOREIGN KEY (tenant_id, claim_id, claim_version)
    REFERENCES claim_detection_results (tenant_id, claim_id, claim_version)
    ON DELETE RESTRICT,
  CONSTRAINT fk_detection_signal_strategy
    FOREIGN KEY (detection_strategy_id)
    REFERENCES detection_strategies (id)
    ON DELETE RESTRICT
);

DELIMITER $$

CREATE TRIGGER trg_detection_results_reject_adverse_actions
BEFORE INSERT ON claim_detection_results
FOR EACH ROW
BEGIN
  IF JSON_CONTAINS_PATH(
    NEW.result_payload,
    'one',
    '$.paymentAction', '$.payment_action',
    '$.adjudicationDecision', '$.adjudication_decision',
    '$.fraudOutcomeApproval', '$.fraud_outcome_approval',
    '$.networkNoticeActivation', '$.network_notice_activation',
    '$.registryPublication', '$.registry_publication',
    '$.contractualSanction', '$.contractual_sanction',
    '$.reject', '$.withhold', '$.recover', '$.terminate',
    '$.blacklist', '$.confirmedFraud', '$.confirmed_fraud',
    '$.automaticPaymentPause', '$.automatic_payment_pause'
  ) = 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'DOMAIN_SAFETY_PROHIBITED_DETECTION_COMMAND';
  END IF;
END$$

CREATE TRIGGER trg_detection_results_create_signal
AFTER INSERT ON claim_detection_results
FOR EACH ROW
BEGIN
  INSERT INTO detection_signals (
    signal_id,
    tenant_id,
    claim_id,
    claim_version,
    detection_strategy_id,
    strategy_type,
    model_deployment_id,
    source_job_id,
    request_id,
    reason_codes,
    evidence_references,
    model_or_rule_version,
    feature_schema_version,
    input_provenance,
    correlation_id,
    generated_at,
    signal_state
  ) VALUES (
    UUID(),
    NEW.tenant_id,
    NEW.claim_id,
    NEW.claim_version,
    NEW.detection_strategy_id,
    NEW.strategy_type,
    NEW.model_deployment_id,
    NEW.source_job_id,
    NEW.request_id,
    COALESCE(JSON_EXTRACT(NEW.result_payload, '$.reasonCodes'), JSON_EXTRACT(NEW.result_payload, '$.reasons'), JSON_ARRAY()),
    COALESCE(JSON_EXTRACT(NEW.result_payload, '$.evidenceReferences'), JSON_ARRAY()),
    COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.model.modelVersion')),
      JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.model.ensembleVersion')),
      JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.ruleVersion')),
      JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.strategy.version'))
    ),
    NEW.feature_schema_version,
    JSON_OBJECT(
      'sourceJobId', NEW.source_job_id,
      'requestId', NEW.request_id,
      'analysisMode', NEW.analysis_mode,
      'resultHash', NEW.result_hash,
      'resultSchemaVersion', JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.schemaVersion'))
    ),
    NEW.request_id,
    NEW.scored_at,
    'SIGNAL_GENERATED'
  );
END$$

CREATE TRIGGER trg_detection_signals_no_update
BEFORE UPDATE ON detection_signals
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'DETECTION_SIGNAL_IMMUTABLE'$$

CREATE TRIGGER trg_detection_signals_no_delete
BEFORE DELETE ON detection_signals
FOR EACH ROW
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'DETECTION_SIGNAL_IMMUTABLE'$$

-- Legacy registry rows remain readable. New direct ACTIVE publication is
-- disabled until the independent outcome-review and sharing-authority model is
-- implemented in later PRs.
CREATE TRIGGER trg_shared_registry_block_direct_active_publication
BEFORE INSERT ON shared_fraud_registry_entries
FOR EACH ROW
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'NETWORK_NOTICE_GOVERNANCE_REQUIRED';
  END IF;
END$$

DELIMITER ;

UPDATE data_plane_metadata
SET
  schema_version = '16',
  migration_version = GREATEST(migration_version, 16)
WHERE metadata_key = 'primary';
