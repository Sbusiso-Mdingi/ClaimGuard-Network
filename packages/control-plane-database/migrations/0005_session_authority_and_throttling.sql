ALTER TABLE login_sessions
  ADD COLUMN credential_id CHAR(36) NULL AFTER membership_id,
  ADD COLUMN csrf_token_hash CHAR(64) NULL AFTER hashed_bearer_secret,
  ADD COLUMN rotation_generation INT UNSIGNED NOT NULL DEFAULT 1 AFTER authorization_version,
  ADD COLUMN rotated_from_session_id CHAR(36) NULL AFTER rotation_generation;

UPDATE login_sessions
SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)),
    revocation_reason = COALESCE(revocation_reason, 'phase_11c_session_cutover'),
    csrf_token_hash = SHA2(CONCAT(session_id, ':phase_11c_revoked'), 256)
WHERE csrf_token_hash IS NULL;

ALTER TABLE login_sessions
  MODIFY COLUMN csrf_token_hash CHAR(64) NOT NULL;

ALTER TABLE login_sessions
  ADD CONSTRAINT fk_sessions_credential FOREIGN KEY (credential_id) REFERENCES credential_identities (credential_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sessions_rotated_from FOREIGN KEY (rotated_from_session_id) REFERENCES login_sessions (session_id) ON DELETE SET NULL,
  ADD INDEX idx_login_sessions_user_active (user_id, revoked_at, absolute_expires_at),
  ADD INDEX idx_login_sessions_organisation_active (organisation_id, revoked_at, absolute_expires_at),
  ADD INDEX idx_login_sessions_credential_active (credential_id, revoked_at, absolute_expires_at);

CREATE TABLE login_throttle_buckets (
  bucket_key CHAR(64) PRIMARY KEY,
  source_network_hash CHAR(64) NOT NULL,
  organisation_slug_hash CHAR(64) NOT NULL,
  username_hash CHAR(64) NOT NULL,
  failure_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at TIMESTAMP(3) NOT NULL,
  last_failure_at TIMESTAMP(3) NULL,
  blocked_until TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_login_throttle_blocked (blocked_until),
  INDEX idx_login_throttle_window (window_started_at)
);

CREATE INDEX idx_auth_events_credential_time ON authentication_events (credential_id, occurred_at);
CREATE INDEX idx_auth_events_type_time ON authentication_events (event_type, occurred_at);
