ALTER TABLE organisation_desktop_policies
  ALTER COLUMN device_limit DROP DEFAULT;

ALTER TABLE desktop_activation_audit_events
  ADD COLUMN event_details JSON NULL AFTER failure_category;

INSERT INTO permissions (permission_id, permission_key, description, definition_version) VALUES
  ('desktop_fleet_policy.manage', 'desktop_fleet_policy.manage', 'Set the licensed Windows desktop allowance for medical-scheme organisations.', 1)
ON DUPLICATE KEY UPDATE
  permission_id = VALUES(permission_id),
  definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('platform_administrator', 'desktop_fleet_policy.manage')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
