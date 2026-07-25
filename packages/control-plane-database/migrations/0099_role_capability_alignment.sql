INSERT INTO permissions (
  permission_id,
  permission_key,
  description,
  definition_version
) VALUES
  (
    'investigations.view_own',
    'investigations.view_own',
    'View investigations in the member organisation without workflow mutation authority.',
    1
  )
ON DUPLICATE KEY UPDATE
  permission_id = VALUES(permission_id),
  definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('fraud_analyst', 'claims.view_own'),
  ('investigator', 'claims.view_own'),
  ('scheme_administrator', 'claims.view_own'),
  ('scheme_administrator', 'reports.view_own'),
  ('scheme_administrator', 'investigations.view_own')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
