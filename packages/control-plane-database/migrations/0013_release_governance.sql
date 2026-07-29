CREATE TABLE IF NOT EXISTS platform_release_candidates (
  release_id CHAR(36) PRIMARY KEY,
  commit_sha CHAR(40) NOT NULL,
  source_repository VARCHAR(255) NOT NULL,
  source_branch VARCHAR(255) NOT NULL,
  artifact_digest CHAR(64) NOT NULL,
  web_artifact_digest CHAR(64) NOT NULL,
  api_artifact_digest CHAR(64) NOT NULL,
  artifact_name VARCHAR(255) NOT NULL,
  artifact_workflow_run_id VARCHAR(64) NOT NULL,
  artifact_workflow_run_url VARCHAR(2048) NOT NULL,
  ci_workflow_run_id VARCHAR(64) NOT NULL,
  ci_workflow_run_url VARCHAR(2048) NOT NULL,
  security_workflow_run_id VARCHAR(64) NOT NULL,
  security_workflow_run_url VARCHAR(2048) NOT NULL,
  ci_conclusion VARCHAR(32) NOT NULL,
  security_conclusion VARCHAR(32) NOT NULL,
  eligible_at TIMESTAMP(3) NOT NULL,
  registered_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_release_commit (commit_sha),
  UNIQUE KEY uq_platform_release_artifact_digest (artifact_digest),
  INDEX idx_platform_release_eligible (eligible_at),
  CONSTRAINT chk_platform_release_commit_sha CHECK (
    commit_sha REGEXP '^[a-f0-9]{40}$'
  ),
  CONSTRAINT chk_platform_release_artifact_digest CHECK (
    artifact_digest REGEXP '^[a-f0-9]{64}$'
    AND web_artifact_digest REGEXP '^[a-f0-9]{64}$'
    AND api_artifact_digest REGEXP '^[a-f0-9]{64}$'
  ),
  CONSTRAINT chk_platform_release_gates CHECK (
    ci_conclusion = 'success' AND security_conclusion = 'success'
  )
);

CREATE TABLE IF NOT EXISTS platform_release_promotion_requests (
  promotion_request_id CHAR(36) PRIMARY KEY,
  release_id CHAR(36) NOT NULL,
  target_environment VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  request_reason VARCHAR(512) NOT NULL,
  requested_by VARCHAR(255) NOT NULL,
  requested_at TIMESTAMP(3) NOT NULL,
  request_reauthenticated_at TIMESTAMP(3) NOT NULL,
  approved_by VARCHAR(255) NULL,
  approved_at TIMESTAMP(3) NULL,
  approval_reauthenticated_at TIMESTAMP(3) NULL,
  rejected_by VARCHAR(255) NULL,
  rejected_at TIMESTAMP(3) NULL,
  rejection_reason VARCHAR(512) NULL,
  deployment_workflow_run_id VARCHAR(64) NULL,
  deployment_workflow_run_url VARCHAR(2048) NULL,
  deployment_started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  failure_summary VARCHAR(512) NULL,
  bootstrap_request TINYINT(1) NOT NULL DEFAULT 0,
  open_request_slot CHAR(36)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('pending_approval', 'approved', 'deploying') THEN release_id
        ELSE NULL
      END
    ) STORED,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_release_open_request (open_request_slot),
  INDEX idx_platform_release_request_status (status, requested_at),
  INDEX idx_platform_release_request_release (release_id, requested_at),
  CONSTRAINT fk_platform_release_request_release
    FOREIGN KEY (release_id) REFERENCES platform_release_candidates (release_id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_release_request_environment CHECK (
    target_environment = 'production'
  ),
  CONSTRAINT chk_platform_release_request_status CHECK (
    status IN ('pending_approval', 'approved', 'rejected', 'deploying', 'deployed', 'failed', 'cancelled')
  ),
  CONSTRAINT chk_platform_release_request_bootstrap CHECK (
    bootstrap_request IN (0, 1)
  )
);

CREATE TABLE IF NOT EXISTS platform_release_deployments (
  deployment_record_id CHAR(36) PRIMARY KEY,
  release_id CHAR(36) NOT NULL,
  promotion_request_id CHAR(36) NOT NULL,
  target_environment VARCHAR(32) NOT NULL,
  deployment_workflow_run_id VARCHAR(64) NOT NULL,
  deployment_workflow_run_url VARCHAR(2048) NOT NULL,
  deployed_at TIMESTAMP(3) NOT NULL,
  recorded_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_release_deployment_request (promotion_request_id),
  INDEX idx_platform_release_deployment_current (target_environment, deployed_at),
  CONSTRAINT fk_platform_release_deployment_release
    FOREIGN KEY (release_id) REFERENCES platform_release_candidates (release_id) ON DELETE RESTRICT,
  CONSTRAINT fk_platform_release_deployment_request
    FOREIGN KEY (promotion_request_id) REFERENCES platform_release_promotion_requests (promotion_request_id) ON DELETE RESTRICT,
  CONSTRAINT chk_platform_release_deployment_environment CHECK (
    target_environment = 'production'
  )
);

INSERT INTO permissions (
  permission_id,
  permission_key,
  description,
  definition_version
) VALUES
  (
    'platform_releases.view',
    'platform_releases.view',
    'View non-sensitive release and production deployment governance metadata.',
    1
  ),
  (
    'platform_releases.request',
    'platform_releases.request',
    'Request promotion of an eligible immutable release.',
    1
  ),
  (
    'platform_releases.approve',
    'platform_releases.approve',
    'Approve or reject another administrator release promotion request.',
    1
  )
ON DUPLICATE KEY UPDATE
  permission_id = VALUES(permission_id),
  definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('platform_administrator', 'platform_releases.view'),
  ('platform_administrator', 'platform_releases.request'),
  ('platform_administrator', 'platform_releases.approve')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
