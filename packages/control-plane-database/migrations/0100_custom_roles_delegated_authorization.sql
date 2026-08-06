-- Sequrin PR 3: tenant custom roles, assignments, bounded delegations and elevated approvals.
-- Additive only. Existing system roles, permissions, memberships and sessions remain intact.

ALTER TABLE organisation_memberships
  ADD COLUMN IF NOT EXISTS authorization_version INT UNSIGNED NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS access_role_definitions (
  role_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  role_key VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  description VARCHAR(512) NOT NULL DEFAULT '',
  role_class VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_changed_by CHAR(36) NOT NULL,
  last_changed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_access_role_org_key (organisation_id, role_key),
  INDEX idx_access_role_org_status (organisation_id, status),
  CONSTRAINT fk_access_role_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_role_created_by FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_role_changed_by FOREIGN KEY (last_changed_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_access_role_class CHECK (role_class IN ('system', 'custom')),
  CONSTRAINT chk_access_role_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_access_role_version CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS access_elevated_requests (
  request_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  target_type VARCHAR(24) NOT NULL,
  target_id CHAR(36) NOT NULL,
  requested_permissions JSON NOT NULL,
  requested_by CHAR(36) NOT NULL,
  target_user_id CHAR(36) NULL,
  reason VARCHAR(512) NOT NULL,
  decision VARCHAR(16) NOT NULL DEFAULT 'pending',
  reviewed_by CHAR(36) NULL,
  requested_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at TIMESTAMP(3) NULL,
  decision_reason VARCHAR(512) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  intent_hash CHAR(64) NOT NULL,
  UNIQUE KEY uq_access_elevated_target_intent (organisation_id, target_type, target_id, intent_hash),
  INDEX idx_access_elevated_org_decision (organisation_id, decision, requested_at),
  CONSTRAINT fk_access_elevated_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_elevated_requested_by FOREIGN KEY (requested_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_elevated_target_user FOREIGN KEY (target_user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_elevated_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_access_elevated_target CHECK (target_type IN ('role_permission_set', 'assignment', 'delegation')),
  CONSTRAINT chk_access_elevated_decision CHECK (decision IN ('pending', 'approved', 'rejected')),
  CONSTRAINT chk_access_elevated_version CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS access_role_permissions (
  role_id CHAR(36) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  granted_by CHAR(36) NOT NULL,
  granted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  elevated_request_id CHAR(36) NULL,
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT fk_access_role_permission_role FOREIGN KEY (role_id) REFERENCES access_role_definitions (role_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_role_permission_catalogue FOREIGN KEY (permission_key) REFERENCES permissions (permission_key) ON DELETE RESTRICT,
  CONSTRAINT fk_access_role_permission_actor FOREIGN KEY (granted_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_role_permission_approval FOREIGN KEY (elevated_request_id) REFERENCES access_elevated_requests (request_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS access_role_assignments (
  assignment_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  membership_id CHAR(36) NOT NULL,
  subject_user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMP(3) NULL,
  revoked_by CHAR(36) NULL,
  revoke_reason VARCHAR(512) NULL,
  elevated_request_id CHAR(36) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  UNIQUE KEY uq_access_assignment_idempotency (organisation_id, idempotency_key),
  INDEX idx_access_assignment_subject (organisation_id, subject_user_id, status, effective_from, expires_at),
  CONSTRAINT fk_access_assignment_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_membership FOREIGN KEY (membership_id) REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_subject FOREIGN KEY (subject_user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_role FOREIGN KEY (role_id) REFERENCES access_role_definitions (role_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_revoker FOREIGN KEY (revoked_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_approval FOREIGN KEY (elevated_request_id) REFERENCES access_elevated_requests (request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_assignment_creator FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_access_assignment_status CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT chk_access_assignment_window CHECK (expires_at IS NULL OR expires_at > effective_from),
  CONSTRAINT chk_access_assignment_version CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS access_delegations (
  delegation_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  grantor_user_id CHAR(36) NOT NULL,
  grantee_user_id CHAR(36) NOT NULL,
  permissions_json JSON NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  revoked_at TIMESTAMP(3) NULL,
  revoked_by CHAR(36) NULL,
  revoke_reason VARCHAR(512) NULL,
  elevated_request_id CHAR(36) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  UNIQUE KEY uq_access_delegation_idempotency (organisation_id, idempotency_key),
  INDEX idx_access_delegation_grantee (organisation_id, grantee_user_id, status, effective_from, expires_at),
  INDEX idx_access_delegation_grantor (organisation_id, grantor_user_id, status, expires_at),
  CONSTRAINT fk_access_delegation_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_delegation_grantor FOREIGN KEY (grantor_user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_delegation_grantee FOREIGN KEY (grantee_user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_delegation_revoker FOREIGN KEY (revoked_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_delegation_approval FOREIGN KEY (elevated_request_id) REFERENCES access_elevated_requests (request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_access_delegation_creator FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT chk_access_delegation_status CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT chk_access_delegation_window CHECK (expires_at > effective_from),
  CONSTRAINT chk_access_delegation_not_self CHECK (grantor_user_id <> grantee_user_id),
  CONSTRAINT chk_access_delegation_version CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS access_authorization_operations (
  operation_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  operation_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  intent_hash CHAR(64) NOT NULL,
  result_json JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_access_operation_idempotency (organisation_id, operation_type, idempotency_key),
  CONSTRAINT fk_access_operation_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS access_audit_events (
  audit_event_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  actor_type VARCHAR(16) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  subject_id VARCHAR(255) NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  before_version INT UNSIGNED NULL,
  after_version INT UNSIGNED NULL,
  reason VARCHAR(512) NULL,
  correlation_id VARCHAR(128) NOT NULL,
  operation_id VARCHAR(128) NOT NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  outcome VARCHAR(16) NOT NULL,
  INDEX idx_access_audit_org_time (organisation_id, occurred_at),
  INDEX idx_access_audit_target (organisation_id, target_type, target_id, occurred_at),
  INDEX idx_access_audit_correlation (correlation_id),
  CONSTRAINT fk_access_audit_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_access_audit_actor CHECK (actor_type IN ('user', 'service', 'system')),
  CONSTRAINT chk_access_audit_outcome CHECK (outcome IN ('success', 'failure', 'denied'))
);

INSERT INTO permissions (permission_id, permission_key, description, definition_version)
VALUES
  ('access.roles.read', 'access.roles.read', 'Read tenant role definitions and fixed catalogue metadata', 1),
  ('access.roles.manage', 'access.roles.manage', 'Create and change tenant custom roles', 1),
  ('access.assignments.read', 'access.assignments.read', 'Read tenant role assignments', 1),
  ('access.assignments.manage', 'access.assignments.manage', 'Create and revoke tenant role assignments', 1),
  ('access.delegations.read', 'access.delegations.read', 'Read tenant permission delegations', 1),
  ('access.delegations.grant', 'access.delegations.grant', 'Grant bounded temporary permission delegations', 1),
  ('access.delegations.revoke', 'access.delegations.revoke', 'Revoke another user permission delegation', 1),
  ('access.elevated_permissions.review', 'access.elevated_permissions.review', 'Independently approve or reject elevated authority', 1),
  ('access.audit.read', 'access.audit.read', 'Read tenant authorization audit evidence', 1)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  definition_version = GREATEST(definition_version, VALUES(definition_version));
