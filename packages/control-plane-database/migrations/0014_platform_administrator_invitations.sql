ALTER TABLE admin_invitations
  ADD COLUMN invitation_type VARCHAR(32) NOT NULL DEFAULT 'scheme_administrator' AFTER token_hash,
  ADD COLUMN revoked_at TIMESTAMP(3) NULL AFTER consumed_by_user_id,
  ADD COLUMN revoked_by CHAR(36) NULL AFTER revoked_at,
  ADD COLUMN platform_open_email VARCHAR(320)
    GENERATED ALWAYS AS (
      CASE
        WHEN invitation_type = 'platform_administrator' AND status = 'pending'
          THEN LOWER(email)
        ELSE NULL
      END
    ) STORED,
  ADD UNIQUE KEY uq_platform_administrator_open_invitation (platform_open_email),
  ADD INDEX idx_admin_invitations_type_status (invitation_type, status, created_at),
  ADD CONSTRAINT chk_admin_invitation_type CHECK (
    invitation_type IN ('scheme_administrator', 'platform_administrator')
  );

INSERT INTO permissions (
  permission_id,
  permission_key,
  description,
  definition_version
) VALUES (
  'platform_administrators.manage',
  'platform_administrators.manage',
  'Invite and revoke ClaimGuard platform administrator access.',
  1
)
ON DUPLICATE KEY UPDATE
  permission_id = VALUES(permission_id),
  definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('platform_administrator', 'platform_administrators.manage')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
