CREATE TABLE IF NOT EXISTS organisations (
  organisation_id CHAR(36) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  canonical_slug VARCHAR(63) NOT NULL,
  organisation_type VARCHAR(32) NOT NULL,
  deployment_class VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  activation_state VARCHAR(32) NOT NULL DEFAULT 'not_activated',
  legacy_mapping_status VARCHAR(32) NOT NULL DEFAULT 'unmapped',
  metadata_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  activated_at TIMESTAMP(3) NULL,
  suspended_at TIMESTAMP(3) NULL,
  suspension_reason VARCHAR(512) NULL,
  UNIQUE KEY uq_organisations_canonical_slug (canonical_slug),
  CONSTRAINT chk_organisation_type CHECK (organisation_type IN ('medical_scheme', 'platform')),
  CONSTRAINT chk_organisation_status CHECK (status IN ('draft', 'provisioning', 'ready_for_activation', 'active', 'suspended', 'failed', 'archived')),
  CONSTRAINT chk_organisation_activation CHECK (activation_state IN ('not_activated', 'activated', 'suspended', 'deactivated')),
  CONSTRAINT chk_organisation_deployment CHECK (deployment_class IN ('local', 'demo', 'pilot', 'production'))
);

CREATE TABLE IF NOT EXISTS organisation_slugs (
  slug VARCHAR(63) PRIMARY KEY,
  organisation_id CHAR(36) NULL,
  slug_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'reserved',
  redirect_to_slug VARCHAR(63) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  retired_at TIMESTAMP(3) NULL,
  INDEX idx_org_slugs_organisation (organisation_id, status),
  CONSTRAINT fk_org_slugs_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_org_slugs_redirect FOREIGN KEY (redirect_to_slug) REFERENCES organisation_slugs (slug) ON DELETE RESTRICT,
  CONSTRAINT chk_org_slug_type CHECK (slug_type IN ('canonical', 'alias', 'reserved')),
  CONSTRAINT chk_org_slug_status CHECK (status IN ('reserved', 'active', 'redirect', 'retired'))
);

CREATE TABLE IF NOT EXISTS users (
  user_id CHAR(36) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  canonical_contact VARCHAR(320) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'invited',
  authentication_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  disabled_at TIMESTAMP(3) NULL,
  disabled_reason VARCHAR(512) NULL,
  UNIQUE KEY uq_users_canonical_contact (canonical_contact),
  CONSTRAINT chk_user_status CHECK (status IN ('invited', 'active', 'disabled', 'locked', 'archived'))
);

CREATE TABLE IF NOT EXISTS credential_identities (
  credential_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  organisation_id CHAR(36) NOT NULL,
  authentication_provider VARCHAR(32) NOT NULL,
  normalized_username VARCHAR(255) NOT NULL,
  external_subject VARCHAR(512) NULL,
  password_hash VARCHAR(1024) NULL,
  password_algorithm VARCHAR(64) NULL,
  password_parameters JSON NULL,
  password_version INT UNSIGNED NULL,
  password_changed_at TIMESTAMP(3) NULL,
  failed_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until TIMESTAMP(3) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_activation',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_credentials_org_provider_username (organisation_id, authentication_provider, normalized_username),
  INDEX idx_credentials_user (user_id, status),
  CONSTRAINT fk_credentials_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_credentials_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_credential_provider CHECK (authentication_provider IN ('local_password', 'oidc', 'managed_identity')),
  CONSTRAINT chk_credential_status CHECK (status IN ('pending_activation', 'active', 'disabled', 'locked', 'archived'))
);

CREATE TABLE IF NOT EXISTS organisation_memberships (
  membership_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  organisation_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'invited',
  valid_from TIMESTAMP(3) NULL,
  valid_until TIMESTAMP(3) NULL,
  invited_by CHAR(36) NULL,
  activated_by CHAR(36) NULL,
  disabled_by CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_memberships_user_organisation (user_id, organisation_id),
  INDEX idx_memberships_organisation_status (organisation_id, status),
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_memberships_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_memberships_invited_by FOREIGN KEY (invited_by) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_memberships_activated_by FOREIGN KEY (activated_by) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_memberships_disabled_by FOREIGN KEY (disabled_by) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT chk_membership_status CHECK (status IN ('invited', 'active', 'disabled', 'expired', 'revoked'))
);

CREATE TABLE IF NOT EXISTS roles (
  role_id VARCHAR(64) PRIMARY KEY,
  role_key VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  organisation_scope VARCHAR(32) NOT NULL,
  definition_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_roles_role_key (role_key),
  CONSTRAINT chk_role_scope CHECK (organisation_scope IN ('medical_scheme', 'platform'))
);

CREATE TABLE IF NOT EXISTS role_aliases (
  alias_key VARCHAR(64) PRIMARY KEY,
  role_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_role_alias_role FOREIGN KEY (role_id) REFERENCES roles (role_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS permissions (
  permission_id VARCHAR(128) PRIMARY KEY,
  permission_key VARCHAR(128) NOT NULL,
  description VARCHAR(512) NOT NULL,
  definition_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_permissions_permission_key (permission_key)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id VARCHAR(64) NOT NULL,
  permission_id VARCHAR(128) NOT NULL,
  granted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (role_id) ON DELETE RESTRICT,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (permission_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS membership_roles (
  membership_id CHAR(36) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  assigned_by CHAR(36) NULL,
  assigned_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at TIMESTAMP(3) NULL,
  PRIMARY KEY (membership_id, role_id),
  CONSTRAINT fk_membership_roles_membership FOREIGN KEY (membership_id) REFERENCES organisation_memberships (membership_id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_roles_role FOREIGN KEY (role_id) REFERENCES roles (role_id) ON DELETE RESTRICT,
  CONSTRAINT fk_membership_roles_assigned_by FOREIGN KEY (assigned_by) REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  session_id CHAR(36) PRIMARY KEY,
  hashed_bearer_secret CHAR(64) NOT NULL,
  signing_key_id VARCHAR(128) NOT NULL,
  user_id CHAR(36) NOT NULL,
  organisation_id CHAR(36) NOT NULL,
  membership_id CHAR(36) NOT NULL,
  issued_at TIMESTAMP(3) NOT NULL,
  last_activity_at TIMESTAMP(3) NOT NULL,
  idle_expires_at TIMESTAMP(3) NOT NULL,
  absolute_expires_at TIMESTAMP(3) NOT NULL,
  revoked_at TIMESTAMP(3) NULL,
  revocation_reason VARCHAR(512) NULL,
  authorization_version INT UNSIGNED NOT NULL,
  client_metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_login_sessions_secret_hash (hashed_bearer_secret),
  INDEX idx_login_sessions_membership (membership_id, absolute_expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sessions_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sessions_membership FOREIGN KEY (membership_id) REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS authentication_events (
  event_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NULL,
  organisation_candidate_hash CHAR(64) NULL,
  user_id CHAR(36) NULL,
  credential_id CHAR(36) NULL,
  event_type VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_network_hash CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  correlation_id VARCHAR(128) NULL,
  result VARCHAR(32) NOT NULL,
  failure_category VARCHAR(128) NULL,
  INDEX idx_auth_events_org_time (organisation_id, occurred_at),
  INDEX idx_auth_events_correlation (correlation_id),
  CONSTRAINT fk_auth_events_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_events_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_events_credential FOREIGN KEY (credential_id) REFERENCES credential_identities (credential_id) ON DELETE SET NULL,
  CONSTRAINT chk_auth_event_result CHECK (result IN ('success', 'failure', 'throttled', 'locked'))
);

CREATE TABLE IF NOT EXISTS platform_audit_events (
  audit_event_id CHAR(36) PRIMARY KEY,
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(255) NULL,
  organisation_scope_id CHAR(36) NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(128) NOT NULL,
  target_id VARCHAR(255) NULL,
  before_summary JSON NULL,
  after_summary JSON NULL,
  correlation_id VARCHAR(128) NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  outcome VARCHAR(32) NOT NULL,
  source VARCHAR(128) NOT NULL,
  INDEX idx_platform_audit_org_time (organisation_scope_id, occurred_at),
  INDEX idx_platform_audit_correlation (correlation_id),
  CONSTRAINT fk_platform_audit_organisation FOREIGN KEY (organisation_scope_id) REFERENCES organisations (organisation_id) ON DELETE SET NULL,
  CONSTRAINT chk_platform_audit_actor CHECK (actor_type IN ('user', 'service', 'system')),
  CONSTRAINT chk_platform_audit_outcome CHECK (outcome IN ('success', 'failure', 'denied'))
);
