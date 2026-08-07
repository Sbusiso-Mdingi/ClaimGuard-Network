-- Sequrin PR 4: immutable, version-addressable assessment context.
-- Expand-first: stable member/provider rows remain as current projections while
-- immutable version rows become authoritative for assessment provenance.

ALTER TABLE members
  ADD COLUMN current_member_version INT UNSIGNED NULL,
  ADD UNIQUE KEY uq_members_tenant_member (tenant_id, member_id),
  ADD CONSTRAINT chk_members_current_member_version
    CHECK (current_member_version IS NULL OR current_member_version > 0);

ALTER TABLE providers
  ADD COLUMN current_provider_version INT UNSIGNED NULL,
  ADD UNIQUE KEY uq_providers_tenant_provider (tenant_id, provider_id),
  ADD CONSTRAINT chk_providers_current_provider_version
    CHECK (current_provider_version IS NULL OR current_provider_version > 0);

CREATE TABLE member_versions (
  tenant_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(128) NOT NULL,
  member_version INT UNSIGNED NOT NULL,
  scheme_id VARCHAR(64) NOT NULL,
  first_name VARCHAR(128) NOT NULL,
  last_name VARCHAR(128) NOT NULL,
  date_of_birth DATE NOT NULL,
  gender VARCHAR(32) NOT NULL,
  identity_number VARCHAR(128) NOT NULL,
  banking_detail VARCHAR(255) NOT NULL,
  home_region VARCHAR(128) NOT NULL,
  home_lat DECIMAL(10,5) NOT NULL,
  home_lon DECIMAL(10,5) NOT NULL,
  join_date DATE NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  effective_to TIMESTAMP(3) NULL,
  version_reason VARCHAR(128) NOT NULL,
  source_reference VARCHAR(255) NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  payload_hash CHAR(64) NOT NULL,
  PRIMARY KEY (tenant_id, member_id, member_version),
  INDEX idx_member_versions_scheme (tenant_id, scheme_id, member_id, member_version),
  CONSTRAINT chk_member_versions_positive CHECK (member_version > 0),
  CONSTRAINT chk_member_versions_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_member_versions_member FOREIGN KEY (tenant_id, member_id)
    REFERENCES members (tenant_id, member_id) ON DELETE RESTRICT
);

CREATE TABLE provider_versions (
  tenant_id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(128) NOT NULL,
  provider_version INT UNSIGNED NOT NULL,
  scheme_id VARCHAR(64) NOT NULL,
  practice_number VARCHAR(64) NOT NULL,
  specialty VARCHAR(128) NOT NULL,
  practice_name VARCHAR(255) NOT NULL,
  banking_detail VARCHAR(255) NOT NULL,
  practice_region VARCHAR(128) NOT NULL,
  practice_lat DECIMAL(10,5) NOT NULL,
  practice_lon DECIMAL(10,5) NOT NULL,
  provider_kind VARCHAR(128) NOT NULL,
  provider_category VARCHAR(128) NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  effective_to TIMESTAMP(3) NULL,
  version_reason VARCHAR(128) NOT NULL,
  source_reference VARCHAR(255) NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  payload_hash CHAR(64) NOT NULL,
  PRIMARY KEY (tenant_id, provider_id, provider_version),
  INDEX idx_provider_versions_scheme (tenant_id, scheme_id, provider_id, provider_version),
  CONSTRAINT chk_provider_versions_positive CHECK (provider_version > 0),
  CONSTRAINT chk_provider_versions_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_provider_versions_provider FOREIGN KEY (tenant_id, provider_id)
    REFERENCES providers (tenant_id, provider_id) ON DELETE RESTRICT
);

INSERT INTO member_versions (
  tenant_id, member_id, member_version, scheme_id, first_name, last_name,
  date_of_birth, gender, identity_number, banking_detail, home_region,
  home_lat, home_lon, join_date, effective_from, version_reason,
  source_reference, created_by, created_at, payload_hash
)
SELECT
  tenant_id, member_id, 1, scheme_id, first_name, last_name,
  date_of_birth, gender, identity_number, banking_detail, home_region,
  home_lat, home_lon, join_date, UTC_TIMESTAMP(3),
  'legacy_baseline', 'migration:0018', 'migration:0018',
  UTC_TIMESTAMP(3),
  SHA2(CAST(JSON_OBJECT(
    'scheme_id', scheme_id,
    'first_name', first_name,
    'last_name', last_name,
    'date_of_birth', DATE_FORMAT(date_of_birth, '%Y-%m-%d'),
    'gender', gender,
    'identity_number', identity_number,
    'banking_detail', banking_detail,
    'home_region', home_region,
    'home_lat', CAST(home_lat AS CHAR),
    'home_lon', CAST(home_lon AS CHAR),
    'join_date', DATE_FORMAT(join_date, '%Y-%m-%d')
  ) AS CHAR), 256)
FROM members;

UPDATE members SET current_member_version = 1 WHERE current_member_version IS NULL;
ALTER TABLE members MODIFY COLUMN current_member_version INT UNSIGNED NOT NULL;

INSERT INTO provider_versions (
  tenant_id, provider_id, provider_version, scheme_id, practice_number,
  specialty, practice_name, banking_detail, practice_region, practice_lat,
  practice_lon, provider_kind, provider_category, effective_from,
  version_reason, source_reference, created_by, created_at, payload_hash
)
SELECT
  tenant_id, provider_id, 1, scheme_id, practice_number,
  specialty, practice_name, banking_detail, practice_region, practice_lat,
  practice_lon, provider_kind, provider_category,
  UTC_TIMESTAMP(3), 'legacy_baseline',
  'migration:0018', 'migration:0018', UTC_TIMESTAMP(3),
  SHA2(CAST(JSON_OBJECT(
    'scheme_id', scheme_id,
    'practice_number', practice_number,
    'specialty', specialty,
    'practice_name', practice_name,
    'banking_detail', banking_detail,
    'practice_region', practice_region,
    'practice_lat', CAST(practice_lat AS CHAR),
    'practice_lon', CAST(practice_lon AS CHAR),
    'provider_kind', provider_kind,
    'provider_category', provider_category
  ) AS CHAR), 256)
FROM providers;

UPDATE providers SET current_provider_version = 1 WHERE current_provider_version IS NULL;
ALTER TABLE providers MODIFY COLUMN current_provider_version INT UNSIGNED NOT NULL;

CREATE TABLE correction_events (
  correction_event_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  previous_version INT UNSIGNED NOT NULL,
  new_version INT UNSIGNED NOT NULL,
  changed_fields JSON NOT NULL,
  impact_classification JSON NOT NULL,
  assessment_impact VARCHAR(64) NOT NULL,
  reason_code VARCHAR(128) NOT NULL,
  reason_summary VARCHAR(1024) NOT NULL,
  source_reference VARCHAR(255) NULL,
  actor_id VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (correction_event_id),
  UNIQUE KEY uq_correction_events_tenant_event (tenant_id, correction_event_id),
  UNIQUE KEY uq_correction_events_idempotency (tenant_id, idempotency_key),
  INDEX idx_correction_events_entity (tenant_id, entity_type, entity_id, created_at),
  CONSTRAINT chk_correction_events_entity CHECK (entity_type IN ('MEMBER','PROVIDER')),
  CONSTRAINT chk_correction_events_versions CHECK (previous_version > 0 AND new_version = previous_version + 1),
  CONSTRAINT chk_correction_events_changed_fields CHECK (JSON_TYPE(changed_fields) = 'ARRAY'),
  CONSTRAINT chk_correction_events_impact_classification CHECK (JSON_TYPE(impact_classification) = 'ARRAY'),
  CONSTRAINT chk_correction_events_assessment_impact CHECK (assessment_impact IN (
    'NO_REASSESSMENT','REASSESSMENT_REQUIRED','IDENTITY_REVIEW_REQUIRED',
    'HUMAN_IMPACT_REVIEW_REQUIRED','SECURITY_REVIEW_REQUIRED'
  )),
  CONSTRAINT chk_correction_events_intent_hash CHECK (intent_hash REGEXP '^[0-9a-f]{64}$')
);

CREATE TABLE assessment_versions (
  assessment_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  claim_version INT UNSIGNED NOT NULL,
  member_id VARCHAR(128) NOT NULL,
  member_version INT UNSIGNED NOT NULL,
  provider_id VARCHAR(128) NOT NULL,
  provider_version INT UNSIGNED NOT NULL,
  detection_strategy_id INT NOT NULL,
  strategy_type VARCHAR(64) NOT NULL,
  model_deployment_id VARCHAR(128) NULL,
  model_or_rule_version VARCHAR(128) NOT NULL,
  feature_schema_version VARCHAR(128) NOT NULL,
  reference_data_version VARCHAR(128) NOT NULL,
  input_snapshot JSON NOT NULL,
  input_hash CHAR(64) NOT NULL,
  assessment_reason VARCHAR(128) NOT NULL,
  supersedes_assessment_id CHAR(36) NULL,
  source_correction_event_id CHAR(36) NULL,
  provenance_status VARCHAR(32) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (assessment_id),
  UNIQUE KEY uq_assessment_versions_tenant_assessment (tenant_id, assessment_id),
  INDEX idx_assessment_versions_claim (tenant_id, claim_id, claim_version, created_at),
  INDEX idx_assessment_versions_member (tenant_id, member_id, member_version, created_at),
  INDEX idx_assessment_versions_provider (tenant_id, provider_id, provider_version, created_at),
  INDEX idx_assessment_versions_supersedes (tenant_id, supersedes_assessment_id),
  CONSTRAINT chk_assessment_versions_positive CHECK (claim_version > 0 AND member_version > 0 AND provider_version > 0),
  CONSTRAINT chk_assessment_versions_hash CHECK (input_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_assessment_versions_provenance CHECK (provenance_status IN ('COMPLETE','LEGACY_PARTIAL')),
  CONSTRAINT chk_assessment_versions_snapshot CHECK (JSON_TYPE(input_snapshot) = 'OBJECT'),
  CONSTRAINT fk_assessment_claim_version FOREIGN KEY (tenant_id, claim_id, claim_version)
    REFERENCES claim_versions (tenant_id, claim_id, claim_version) ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_member_version FOREIGN KEY (tenant_id, member_id, member_version)
    REFERENCES member_versions (tenant_id, member_id, member_version) ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_provider_version FOREIGN KEY (tenant_id, provider_id, provider_version)
    REFERENCES provider_versions (tenant_id, provider_id, provider_version) ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_strategy FOREIGN KEY (detection_strategy_id)
    REFERENCES detection_strategies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_supersedes FOREIGN KEY (tenant_id, supersedes_assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_assessment_correction FOREIGN KEY (tenant_id, source_correction_event_id)
    REFERENCES correction_events (tenant_id, correction_event_id) ON DELETE RESTRICT
);

-- Historical results did not pin immutable member/provider versions. Create an
-- explicit LEGACY_PARTIAL assessment record without pretending current data was
-- the context actually used at scoring time.
INSERT INTO assessment_versions (
  assessment_id, tenant_id, claim_id, claim_version,
  member_id, member_version, provider_id, provider_version,
  detection_strategy_id, strategy_type, model_deployment_id,
  model_or_rule_version, feature_schema_version, reference_data_version,
  input_snapshot, input_hash, assessment_reason, provenance_status,
  created_by, created_at
)
SELECT
  UUID(), r.tenant_id, r.claim_id, r.claim_version,
  cv.member_id, 1, cv.provider_id, 1,
  r.detection_strategy_id, r.strategy_type, r.model_deployment_id,
  COALESCE(r.ensemble_version, JSON_UNQUOTE(JSON_EXTRACT(r.result_payload, '$.ruleVersion')), 'legacy-unpinned'),
  COALESCE(r.feature_schema_version, 'legacy-unpinned'),
  CONCAT('legacy-result:', r.result_hash),
  JSON_OBJECT(
    'legacyPartial', TRUE,
    'claim', JSON_OBJECT('claim_id', r.claim_id, 'claim_version', r.claim_version),
    'historicalContextLimitation', 'member/provider/model reference context was not immutably pinned before schema 18'
  ),
  SHA2(CAST(JSON_OBJECT(
    'legacyPartial', TRUE,
    'claim', JSON_OBJECT('claim_id', r.claim_id, 'claim_version', r.claim_version),
    'historicalContextLimitation', 'member/provider/model reference context was not immutably pinned before schema 18'
  ) AS CHAR), 256),
  'LEGACY_RESULT_MIGRATION', 'LEGACY_PARTIAL', 'migration:0018', r.scored_at
FROM claim_detection_results r
JOIN claim_versions cv
  ON cv.tenant_id = r.tenant_id
 AND cv.claim_id = r.claim_id
 AND cv.claim_version = r.claim_version;

ALTER TABLE claim_processing_outbox
  ADD COLUMN assessment_id CHAR(36) NULL AFTER id,
  ADD INDEX idx_claim_outbox_assessment (tenant_id, assessment_id, status),
  ADD CONSTRAINT fk_claim_outbox_assessment FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT;

-- Pre-18 unpinned pending jobs cannot truthfully be converted into historical
-- pinned work. They are terminally dead-lettered rather than silently adopting
-- today's member/provider state.
UPDATE claim_processing_outbox
SET status = 'dead_letter',
    completed_at = UTC_TIMESTAMP(3),
    leased_at = NULL,
    lease_expires_at = NULL,
    leased_by = NULL,
    last_error = 'Pre-schema-18 detection job lacked immutable assessment context.',
    failure_code = 'LEGACY_UNPINNED_ASSESSMENT_JOB'
WHERE job_type = 'claim_detection'
  AND assessment_id IS NULL
  AND status IN ('pending','retry','processing');

DROP TRIGGER trg_detection_results_no_update;
DROP TRIGGER trg_detection_results_no_delete;
DROP TRIGGER trg_detection_results_reject_adverse_actions;
DROP TRIGGER trg_detection_results_create_signal;

ALTER TABLE claim_detection_results
  ADD COLUMN assessment_id CHAR(36) NULL AFTER tenant_id;

UPDATE claim_detection_results r
JOIN assessment_versions a
  ON a.tenant_id = r.tenant_id
 AND a.claim_id = r.claim_id
 AND a.claim_version = r.claim_version
 AND a.provenance_status = 'LEGACY_PARTIAL'
SET r.assessment_id = a.assessment_id;

ALTER TABLE claim_detection_results
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (tenant_id, assessment_id),
  ADD UNIQUE KEY uq_detection_result_tenant_assessment (tenant_id, assessment_id),
  ADD INDEX idx_detection_results_claim_version (tenant_id, claim_id, claim_version, scored_at),
  ADD CONSTRAINT fk_detection_result_assessment FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT,
  MODIFY COLUMN assessment_id CHAR(36) NOT NULL;

ALTER TABLE detection_signals
  ADD COLUMN assessment_id CHAR(36) NULL AFTER tenant_id;

UPDATE detection_signals s
JOIN claim_detection_results r
  ON r.tenant_id = s.tenant_id
 AND r.claim_id = s.claim_id
 AND r.claim_version = s.claim_version
SET s.assessment_id = r.assessment_id;

ALTER TABLE detection_signals
  DROP FOREIGN KEY fk_detection_signal_result,
  DROP INDEX uq_detection_signals_result,
  ADD UNIQUE KEY uq_detection_signals_assessment (tenant_id, assessment_id),
  ADD CONSTRAINT fk_detection_signal_result FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES claim_detection_results (tenant_id, assessment_id) ON DELETE RESTRICT,
  MODIFY COLUMN assessment_id CHAR(36) NOT NULL;

CREATE TABLE detection_signal_supersessions (
  supersession_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  superseded_signal_id CHAR(36) NOT NULL,
  replacement_signal_id CHAR(36) NOT NULL,
  previous_assessment_id CHAR(36) NOT NULL,
  replacement_assessment_id CHAR(36) NOT NULL,
  correction_event_id CHAR(36) NOT NULL,
  reason_code VARCHAR(128) NOT NULL,
  reason_summary VARCHAR(1024) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (supersession_id),
  UNIQUE KEY uq_signal_supersession_tenant_event (tenant_id, supersession_id),
  UNIQUE KEY uq_signal_supersession_old (tenant_id, superseded_signal_id),
  UNIQUE KEY uq_signal_supersession_pair (tenant_id, superseded_signal_id, replacement_signal_id),
  CONSTRAINT fk_signal_supersession_old FOREIGN KEY (tenant_id, superseded_signal_id)
    REFERENCES detection_signals (tenant_id, signal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_signal_supersession_new FOREIGN KEY (tenant_id, replacement_signal_id)
    REFERENCES detection_signals (tenant_id, signal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_signal_supersession_previous_assessment FOREIGN KEY (tenant_id, previous_assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_signal_supersession_replacement_assessment FOREIGN KEY (tenant_id, replacement_assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_signal_supersession_correction FOREIGN KEY (tenant_id, correction_event_id)
    REFERENCES correction_events (tenant_id, correction_event_id) ON DELETE RESTRICT
);

CREATE TABLE correction_impact_reviews (
  review_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  correction_event_id CHAR(36) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  affected_assessment_id CHAR(36) NULL,
  affected_signal_id CHAR(36) NULL,
  affected_case_id CHAR(36) NULL,
  review_reason VARCHAR(1024) NOT NULL,
  review_status VARCHAR(64) NOT NULL DEFAULT 'PENDING',
  state_version INT UNSIGNED NOT NULL DEFAULT 1,
  assigned_to VARCHAR(255) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at TIMESTAMP(3) NULL,
  reviewed_by VARCHAR(255) NULL,
  review_result JSON NULL,
  PRIMARY KEY (review_id),
  UNIQUE KEY uq_correction_reviews_tenant_review (tenant_id, review_id),
  INDEX idx_correction_reviews_queue (tenant_id, review_status, created_at),
  CONSTRAINT chk_correction_reviews_state_version CHECK (state_version > 0),
  CONSTRAINT chk_correction_reviews_status CHECK (review_status IN ('PENDING','IN_REVIEW','COMPLETED')),
  CONSTRAINT fk_correction_review_event FOREIGN KEY (tenant_id, correction_event_id)
    REFERENCES correction_events (tenant_id, correction_event_id) ON DELETE RESTRICT,
  CONSTRAINT fk_correction_review_assessment FOREIGN KEY (tenant_id, affected_assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_correction_review_signal FOREIGN KEY (tenant_id, affected_signal_id)
    REFERENCES detection_signals (tenant_id, signal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_correction_review_case FOREIGN KEY (tenant_id, affected_case_id)
    REFERENCES investigation_cases (tenant_id, case_id) ON DELETE RESTRICT
);

CREATE TABLE reassessment_operations (
  operation_id CHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  assessment_id CHAR(36) NOT NULL,
  result_payload JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operation_id),
  UNIQUE KEY uq_reassessment_idempotency (tenant_id, idempotency_key),
  CONSTRAINT chk_reassessment_intent_hash CHECK (intent_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT fk_reassessment_assessment FOREIGN KEY (tenant_id, assessment_id)
    REFERENCES assessment_versions (tenant_id, assessment_id) ON DELETE RESTRICT
);

DELIMITER $$
CREATE TRIGGER trg_member_versions_no_update BEFORE UPDATE ON member_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MEMBER_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_member_versions_no_delete BEFORE DELETE ON member_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MEMBER_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_provider_versions_no_update BEFORE UPDATE ON provider_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PROVIDER_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_provider_versions_no_delete BEFORE DELETE ON provider_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PROVIDER_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_assessment_versions_no_update BEFORE UPDATE ON assessment_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ASSESSMENT_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_assessment_versions_no_delete BEFORE DELETE ON assessment_versions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ASSESSMENT_VERSION_IMMUTABLE'$$
CREATE TRIGGER trg_correction_events_no_update BEFORE UPDATE ON correction_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CORRECTION_EVENT_IMMUTABLE'$$
CREATE TRIGGER trg_correction_events_no_delete BEFORE DELETE ON correction_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CORRECTION_EVENT_IMMUTABLE'$$
CREATE TRIGGER trg_signal_supersessions_no_update BEFORE UPDATE ON detection_signal_supersessions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SIGNAL_SUPERSESSION_IMMUTABLE'$$
CREATE TRIGGER trg_signal_supersessions_no_delete BEFORE DELETE ON detection_signal_supersessions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SIGNAL_SUPERSESSION_IMMUTABLE'$$

CREATE TRIGGER trg_detection_results_reject_adverse_actions
BEFORE INSERT ON claim_detection_results
FOR EACH ROW
BEGIN
  IF NEW.assessment_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM assessment_versions a
    WHERE a.tenant_id = NEW.tenant_id
      AND a.assessment_id = NEW.assessment_id
      AND a.claim_id = NEW.claim_id
      AND a.claim_version = NEW.claim_version
      AND a.detection_strategy_id = NEW.detection_strategy_id
      AND a.strategy_type = NEW.strategy_type
      AND (a.model_deployment_id <=> NEW.model_deployment_id)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ASSESSMENT_RESULT_CONTEXT_MISMATCH';
  END IF;
  IF JSON_CONTAINS_PATH(
    NEW.result_payload, 'one',
    '$.paymentAction', '$.payment_action', '$.adjudicationDecision', '$.adjudication_decision',
    '$.fraudOutcomeApproval', '$.fraud_outcome_approval', '$.networkNoticeActivation', '$.network_notice_activation',
    '$.registryPublication', '$.registry_publication', '$.contractualSanction', '$.contractual_sanction',
    '$.reject', '$.withhold', '$.recover', '$.terminate', '$.blacklist', '$.confirmedFraud', '$.confirmed_fraud',
    '$.automaticPaymentPause', '$.automatic_payment_pause'
  ) = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DOMAIN_SAFETY_PROHIBITED_DETECTION_COMMAND';
  END IF;
END$$

CREATE TRIGGER trg_detection_results_create_signal
AFTER INSERT ON claim_detection_results
FOR EACH ROW
BEGIN
  INSERT INTO detection_signals (
    signal_id, tenant_id, assessment_id, claim_id, claim_version,
    detection_strategy_id, strategy_type, model_deployment_id, source_job_id,
    request_id, reason_codes, evidence_references, model_or_rule_version,
    feature_schema_version, input_provenance, correlation_id, generated_at, signal_state
  ) VALUES (
    UUID(), NEW.tenant_id, NEW.assessment_id, NEW.claim_id, NEW.claim_version,
    NEW.detection_strategy_id, NEW.strategy_type, NEW.model_deployment_id, NEW.source_job_id,
    NEW.request_id,
    COALESCE(JSON_EXTRACT(NEW.result_payload, '$.reasonCodes'), JSON_EXTRACT(NEW.result_payload, '$.reasons'), JSON_ARRAY()),
    COALESCE(JSON_EXTRACT(NEW.result_payload, '$.evidenceReferences'), JSON_ARRAY()),
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.model.modelVersion')),
             JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.model.ensembleVersion')),
             JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.ruleVersion')),
             JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.strategy.version'))),
    NEW.feature_schema_version,
    JSON_OBJECT('assessmentId', NEW.assessment_id, 'sourceJobId', NEW.source_job_id,
                'requestId', NEW.request_id, 'analysisMode', NEW.analysis_mode,
                'resultHash', NEW.result_hash,
                'resultSchemaVersion', JSON_UNQUOTE(JSON_EXTRACT(NEW.result_payload, '$.schemaVersion'))),
    NEW.request_id, NEW.scored_at, 'SIGNAL_GENERATED'
  );
END$$

CREATE TRIGGER trg_detection_results_no_update BEFORE UPDATE ON claim_detection_results
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'claim_detection_results rows are immutable'$$
CREATE TRIGGER trg_detection_results_no_delete BEFORE DELETE ON claim_detection_results
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'claim_detection_results rows cannot be deleted'$$
DELIMITER ;

UPDATE data_plane_metadata
SET schema_version = '18', migration_version = GREATEST(migration_version, 18)
WHERE metadata_key = 'primary';
