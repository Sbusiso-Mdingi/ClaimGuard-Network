CREATE TABLE IF NOT EXISTS organisation_desktop_policies (
  organisation_id CHAR(36) PRIMARY KEY,
  device_limit INT UNSIGNED NOT NULL DEFAULT 5,
  activation_key_lifetime_hours INT UNSIGNED NOT NULL DEFAULT 24,
  offline_grace_days INT UNSIGNED NOT NULL DEFAULT 7,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_desktop_policy_organisation FOREIGN KEY (organisation_id)
    REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_desktop_policy_device_limit CHECK (device_limit BETWEEN 1 AND 10000),
  CONSTRAINT chk_desktop_policy_key_lifetime CHECK (activation_key_lifetime_hours BETWEEN 1 AND 168),
  CONSTRAINT chk_desktop_policy_offline_grace CHECK (offline_grace_days BETWEEN 1 AND 30)
);

CREATE TABLE IF NOT EXISTS organisation_activation_keys (
  activation_key_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  activation_key_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  maximum_uses INT UNSIGNED NOT NULL DEFAULT 1,
  use_count INT UNSIGNED NOT NULL DEFAULT 0,
  issued_by CHAR(36) NOT NULL,
  issued_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  used_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  revoked_by CHAR(36) NULL,
  revocation_reason VARCHAR(256) NULL,
  UNIQUE KEY uq_activation_key_hash (activation_key_hash),
  UNIQUE KEY uq_activation_key_organisation (activation_key_id, organisation_id),
  INDEX idx_activation_keys_organisation_status (organisation_id, status, expires_at),
  CONSTRAINT fk_activation_key_organisation FOREIGN KEY (organisation_id)
    REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_activation_key_issuer FOREIGN KEY (issued_by)
    REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_activation_key_revoker FOREIGN KEY (revoked_by)
    REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT chk_activation_key_status CHECK (status IN ('pending', 'used', 'revoked', 'expired')),
  CONSTRAINT chk_activation_key_uses CHECK (maximum_uses BETWEEN 1 AND 10000 AND use_count <= maximum_uses)
);

CREATE TABLE IF NOT EXISTS desktop_device_enrollments (
  device_enrollment_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  activation_key_id CHAR(36) NOT NULL,
  installation_id CHAR(36) NOT NULL,
  device_public_key JSON NOT NULL,
  public_key_thumbprint CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  document_version INT UNSIGNED NOT NULL DEFAULT 1,
  signing_key_id VARCHAR(128) NOT NULL,
  permitted_api_origin VARCHAR(512) NOT NULL,
  environment VARCHAR(64) NOT NULL,
  activated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  offline_grace_expires_at TIMESTAMP(3) NOT NULL,
  revoked_at TIMESTAMP(3) NULL,
  revoked_by CHAR(36) NULL,
  revocation_reason VARCHAR(256) NULL,
  UNIQUE KEY uq_desktop_installation (installation_id),
  UNIQUE KEY uq_desktop_public_key (public_key_thumbprint),
  INDEX idx_desktop_devices_organisation_status (organisation_id, status, expires_at),
  CONSTRAINT fk_desktop_device_organisation FOREIGN KEY (organisation_id)
    REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_device_activation_key_organisation FOREIGN KEY (activation_key_id, organisation_id)
    REFERENCES organisation_activation_keys (activation_key_id, organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_device_revoker FOREIGN KEY (revoked_by)
    REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT chk_desktop_device_status CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT chk_desktop_document_version CHECK (document_version >= 1)
);

CREATE TABLE IF NOT EXISTS desktop_device_proof_nonces (
  nonce_hash CHAR(64) PRIMARY KEY,
  device_enrollment_id CHAR(36) NOT NULL,
  issued_at TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_desktop_nonce_device_expiry (device_enrollment_id, expires_at),
  CONSTRAINT fk_desktop_nonce_device FOREIGN KEY (device_enrollment_id)
    REFERENCES desktop_device_enrollments (device_enrollment_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS desktop_activation_rate_limits (
  bucket_key CHAR(64) PRIMARY KEY,
  source_network_hash CHAR(64) NOT NULL,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at TIMESTAMP(3) NOT NULL,
  last_failure_at TIMESTAMP(3) NOT NULL,
  blocked_until TIMESTAMP(3) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_desktop_activation_blocked (blocked_until)
);

CREATE TABLE IF NOT EXISTS desktop_activation_audit_events (
  desktop_audit_event_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NULL,
  activation_key_id CHAR(36) NULL,
  device_enrollment_id CHAR(36) NULL,
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  failure_category VARCHAR(128) NULL,
  source_network_hash CHAR(64) NULL,
  correlation_id VARCHAR(128) NULL,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_desktop_audit_organisation_time (organisation_id, occurred_at),
  INDEX idx_desktop_audit_device_time (device_enrollment_id, occurred_at),
  CONSTRAINT fk_desktop_audit_organisation FOREIGN KEY (organisation_id)
    REFERENCES organisations (organisation_id) ON DELETE SET NULL,
  CONSTRAINT fk_desktop_audit_activation_key FOREIGN KEY (activation_key_id)
    REFERENCES organisation_activation_keys (activation_key_id) ON DELETE SET NULL,
  CONSTRAINT fk_desktop_audit_device FOREIGN KEY (device_enrollment_id)
    REFERENCES desktop_device_enrollments (device_enrollment_id) ON DELETE SET NULL,
  CONSTRAINT chk_desktop_audit_actor CHECK (actor_type IN ('user', 'device', 'system', 'anonymous')),
  CONSTRAINT chk_desktop_audit_outcome CHECK (outcome IN ('success', 'failure', 'denied'))
);

INSERT INTO permissions (permission_id, permission_key, description, definition_version) VALUES
  ('desktop_devices.manage', 'desktop_devices.manage', 'Issue activation keys and manage enrolled desktop devices.', 1)
ON DUPLICATE KEY UPDATE
  permission_id = VALUES(permission_id),
  definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('scheme_administrator', 'desktop_devices.manage'),
  ('platform_administrator', 'desktop_devices.manage')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
