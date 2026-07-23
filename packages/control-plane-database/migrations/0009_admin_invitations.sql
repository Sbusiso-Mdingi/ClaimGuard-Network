-- Admin invitations for scheme administrator self-signup
CREATE TABLE IF NOT EXISTS admin_invitations (
  invitation_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  email VARCHAR(320) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  invited_by CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  consumed_by_user_id CHAR(36) NULL,
  UNIQUE KEY uq_invitations_token (token_hash),
  INDEX idx_invitations_org (organisation_id, status),
  CONSTRAINT fk_invitations_org FOREIGN KEY (organisation_id) REFERENCES organisations(organisation_id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_consumed_by FOREIGN KEY (consumed_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT chk_invitation_status CHECK (status IN ('pending', 'consumed', 'expired', 'revoked'))
);
