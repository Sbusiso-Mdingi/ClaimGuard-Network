CREATE TABLE clerk_organisation_mappings (
  mapping_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  clerk_organisation_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_by CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  disabled_at TIMESTAMP(3) NULL,
  UNIQUE KEY uq_clerk_mapping_organisation (organisation_id),
  UNIQUE KEY uq_clerk_mapping_external_organisation (clerk_organisation_id),
  CONSTRAINT fk_clerk_mapping_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_clerk_mapping_creator
    FOREIGN KEY (created_by) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT chk_clerk_mapping_status CHECK (status IN ('active', 'disabled'))
);

ALTER TABLE credential_identities
  ADD UNIQUE KEY uq_credentials_org_provider_external_subject
    (organisation_id, authentication_provider, external_subject);

ALTER TABLE admin_invitations
  ADD COLUMN role_key VARCHAR(64) NULL AFTER invitation_type,
  ADD COLUMN external_identity_provider VARCHAR(32) NULL AFTER token_hash,
  ADD COLUMN external_invitation_id VARCHAR(128) NULL AFTER external_identity_provider,
  ADD UNIQUE KEY uq_admin_invitation_external_id
    (external_identity_provider, external_invitation_id),
  ADD CONSTRAINT chk_admin_invitation_external_provider
    CHECK (external_identity_provider IS NULL OR external_identity_provider = 'clerk');

CREATE TABLE desktop_authentication_requests (
  request_id CHAR(36) PRIMARY KEY,
  device_enrollment_id CHAR(36) NOT NULL,
  organisation_id CHAR(36) NOT NULL,
  browser_secret_hash CHAR(64) NOT NULL,
  polling_secret_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  approved_user_id CHAR(36) NULL,
  approved_membership_id CHAR(36) NULL,
  approved_credential_id CHAR(36) NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  approved_at TIMESTAMP(3) NULL,
  exchange_started_at TIMESTAMP(3) NULL,
  consumed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_desktop_auth_browser_secret (browser_secret_hash),
  UNIQUE KEY uq_desktop_auth_polling_secret (polling_secret_hash),
  KEY ix_desktop_auth_device_status (device_enrollment_id, status, expires_at),
  CONSTRAINT fk_desktop_auth_device
    FOREIGN KEY (device_enrollment_id) REFERENCES desktop_device_enrollments (device_enrollment_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_auth_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_auth_user
    FOREIGN KEY (approved_user_id) REFERENCES users (user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_auth_membership
    FOREIGN KEY (approved_membership_id) REFERENCES organisation_memberships (membership_id) ON DELETE RESTRICT,
  CONSTRAINT fk_desktop_auth_credential
    FOREIGN KEY (approved_credential_id) REFERENCES credential_identities (credential_id) ON DELETE RESTRICT,
  CONSTRAINT chk_desktop_auth_status
    CHECK (status IN ('pending', 'approved', 'exchanging', 'consumed', 'expired', 'failed'))
);
