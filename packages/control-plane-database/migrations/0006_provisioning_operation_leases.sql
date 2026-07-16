ALTER TABLE organisation_provisioning_operations
  ADD COLUMN lease_owner VARCHAR(255) NULL,
  ADD COLUMN lease_token CHAR(36) NULL,
  ADD COLUMN lease_expires_at TIMESTAMP(3) NULL,
  ADD INDEX idx_provisioning_lease (status, lease_expires_at, created_at);
