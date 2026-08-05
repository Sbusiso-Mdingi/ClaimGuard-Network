-- Sequrin PR 2: additive human-governed case lifecycle.

CREATE TABLE investigation_cases (
  case_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  signal_id CHAR(36) NOT NULL,
  claim_id VARCHAR(128) NOT NULL,
  claim_version INT UNSIGNED NOT NULL,
  current_state VARCHAR(64) NOT NULL DEFAULT 'SIGNAL_GENERATED',
  state_version INT UNSIGNED NOT NULL DEFAULT 1,
  assigned_investigator_id VARCHAR(255) NULL,
  triage_owner_id VARCHAR(255) NULL,
  originating_reason VARCHAR(1024) NULL,
  correlation_id VARCHAR(128) NOT NULL,
  last_transition_event_id CHAR(36) NULL,
  legacy_investigation_id VARCHAR(64) NULL,
  legacy_status VARCHAR(64) NULL,
  migration_review_status VARCHAR(64) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (case_id),
  UNIQUE KEY uq_investigation_cases_signal (tenant_id, signal_id),
  INDEX idx_investigation_cases_queue (tenant_id, current_state, assigned_investigator_id, updated_at),
  INDEX idx_investigation_cases_correlation (tenant_id, correlation_id),
  CONSTRAINT chk_investigation_cases_state_version CHECK (state_version > 0),
  CONSTRAINT chk_investigation_cases_state CHECK (current_state IN (
    'SIGNAL_GENERATED','TRIAGE_PENDING','DISMISSED','MONITORING','INVESTIGATION_OPEN',
    'NOTICE_RECORDED','RESPONSE_PENDING','EVIDENCE_REVIEW','INVESTIGATION_REPORT_COMPLETED',
    'OUTCOME_REVIEW_PENDING','OUTCOME_APPROVED','CLOSED_UNSUBSTANTIATED','APPEAL_OR_REVIEW'
  )),
  CONSTRAINT fk_investigation_cases_signal FOREIGN KEY (signal_id)
    REFERENCES detection_signals(signal_id) ON DELETE RESTRICT
);

CREATE TABLE case_transition_operations (
  operation_id CHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  case_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  result_payload JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operation_id),
  UNIQUE KEY uq_case_transition_idempotency (tenant_id, idempotency_key),
  CONSTRAINT fk_case_transition_operation_case FOREIGN KEY (case_id)
    REFERENCES investigation_cases(case_id) ON DELETE RESTRICT
);

CREATE TABLE case_transition_events (
  event_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  case_id CHAR(36) NOT NULL,
  previous_state VARCHAR(64) NOT NULL,
  new_state VARCHAR(64) NOT NULL,
  state_version_before INT UNSIGNED NOT NULL,
  state_version_after INT UNSIGNED NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  reason_code VARCHAR(128) NOT NULL,
  reason_summary VARCHAR(1024) NOT NULL,
  evidence_references JSON NOT NULL,
  process_check_references JSON NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  operation_id CHAR(64) NOT NULL,
  transitioned_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  workflow_version INT UNSIGNED NOT NULL,
  PRIMARY KEY (event_id),
  UNIQUE KEY uq_case_transition_event_operation (tenant_id, operation_id),
  INDEX idx_case_transition_events_case (tenant_id, case_id, transitioned_at),
  INDEX idx_case_transition_events_correlation (tenant_id, correlation_id),
  CONSTRAINT chk_case_transition_event_versions CHECK (state_version_after = state_version_before + 1),
  CONSTRAINT fk_case_transition_event_case FOREIGN KEY (case_id)
    REFERENCES investigation_cases(case_id) ON DELETE RESTRICT,
  CONSTRAINT fk_case_transition_event_operation FOREIGN KEY (operation_id)
    REFERENCES case_transition_operations(operation_id) ON DELETE RESTRICT
);

CREATE TABLE case_outcomes (
  outcome_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  case_id CHAR(36) NOT NULL,
  outcome_code VARCHAR(64) NOT NULL,
  recorded_reasons JSON NOT NULL,
  supporting_report_reference VARCHAR(255) NOT NULL,
  evidence_set_reference VARCHAR(255) NOT NULL,
  process_check_result JSON NOT NULL,
  identity_match_review_result JSON NOT NULL,
  decision_maker_id VARCHAR(255) NOT NULL,
  decision_maker_role VARCHAR(64) NOT NULL,
  decision_timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  correlation_id VARCHAR(128) NOT NULL,
  workflow_version INT UNSIGNED NOT NULL,
  supersedes_outcome_id CHAR(36) NULL,
  PRIMARY KEY (outcome_id),
  INDEX idx_case_outcomes_case (tenant_id, case_id, decision_timestamp),
  CONSTRAINT chk_case_outcomes_neutral_code CHECK (outcome_code <> 'CONFIRMED_FRAUD'),
  CONSTRAINT fk_case_outcomes_case FOREIGN KEY (case_id)
    REFERENCES investigation_cases(case_id) ON DELETE RESTRICT,
  CONSTRAINT fk_case_outcomes_supersedes FOREIGN KEY (supersedes_outcome_id)
    REFERENCES case_outcomes(outcome_id) ON DELETE RESTRICT
);

DELIMITER $$
CREATE TRIGGER trg_case_transition_events_no_update BEFORE UPDATE ON case_transition_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_TRANSITION_EVENT_IMMUTABLE'$$
CREATE TRIGGER trg_case_transition_events_no_delete BEFORE DELETE ON case_transition_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_TRANSITION_EVENT_IMMUTABLE'$$
CREATE TRIGGER trg_case_outcomes_no_update BEFORE UPDATE ON case_outcomes
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_OUTCOME_IMMUTABLE'$$
CREATE TRIGGER trg_case_outcomes_no_delete BEFORE DELETE ON case_outcomes
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_OUTCOME_IMMUTABLE'$$
DELIMITER ;

UPDATE data_plane_metadata
SET schema_version = '17', migration_version = GREATEST(migration_version, 17)
WHERE metadata_key = 'primary';
