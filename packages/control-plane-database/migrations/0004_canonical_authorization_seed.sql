INSERT INTO roles (role_id, role_key, display_name, organisation_scope, definition_version) VALUES
  ('claims_analyst', 'claims_analyst', 'Claims Analyst', 'medical_scheme', 1),
  ('fraud_analyst', 'fraud_analyst', 'Fraud Analyst', 'medical_scheme', 1),
  ('investigator', 'investigator', 'Investigator', 'medical_scheme', 1),
  ('applications_committee_member', 'applications_committee_member', 'Applications Committee Member', 'medical_scheme', 1),
  ('scheme_administrator', 'scheme_administrator', 'Scheme Administrator', 'medical_scheme', 1),
  ('platform_administrator', 'platform_administrator', 'ClaimGuard Platform Administrator', 'platform', 1)
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_aliases (alias_key, role_id) VALUES
  ('scheme_user', 'claims_analyst'),
  ('new_applications_officer', 'applications_committee_member')
ON DUPLICATE KEY UPDATE role_id = VALUES(role_id);

INSERT INTO organisation_slugs (slug, organisation_id, slug_type, status) VALUES
  ('admin', NULL, 'reserved', 'reserved'),
  ('api', NULL, 'reserved', 'reserved'),
  ('auth', NULL, 'reserved', 'reserved'),
  ('login', NULL, 'reserved', 'reserved'),
  ('status', NULL, 'reserved', 'reserved'),
  ('support', NULL, 'reserved', 'reserved'),
  ('www', NULL, 'reserved', 'reserved')
ON DUPLICATE KEY UPDATE slug = VALUES(slug);

INSERT INTO permissions (permission_id, permission_key, description, definition_version) VALUES
  ('claims.view_own', 'claims.view_own', 'View claims in the member organisation.', 1),
  ('claims.ingest_own', 'claims.ingest_own', 'Ingest claims for the member organisation.', 1),
  ('claims.view_flagged', 'claims.view_flagged', 'View flagged claims in the member organisation.', 1),
  ('reports.view_own', 'reports.view_own', 'View private reports for the member organisation.', 1),
  ('investigations.create', 'investigations.create', 'Create a private investigation.', 1),
  ('investigations.manage', 'investigations.manage', 'Manage private investigations.', 1),
  ('investigations.confirm', 'investigations.confirm', 'Confirm an approved private fraud finding.', 1),
  ('investigations.reverse', 'investigations.reverse', 'Reverse an approved private fraud finding.', 1),
  ('registry.search', 'registry.search', 'Search the minimal shared registry.', 1),
  ('registry.review_history', 'registry.review_history', 'Review permitted shared registry history.', 1),
  ('scheme_users.manage', 'scheme_users.manage', 'Manage users in the member organisation.', 1),
  ('scheme_roles.assign', 'scheme_roles.assign', 'Assign approved scheme roles.', 1),
  ('scheme_health.view', 'scheme_health.view', 'View member organisation health.', 1),
  ('organisation.manage', 'organisation.manage', 'Manage control-plane organisations.', 1),
  ('platform_health.view', 'platform_health.view', 'View non-sensitive platform health.', 1),
  ('provisioning.manage', 'provisioning.manage', 'Manage organisation provisioning state.', 1),
  ('simulator.status', 'simulator.status', 'View simulator status.', 1),
  ('simulator.control_own', 'simulator.control_own', 'Control an explicitly enabled organisation simulator.', 1),
  ('simulator.control_platform', 'simulator.control_platform', 'Control explicitly enabled platform demo simulation.', 1)
ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id), definition_version = GREATEST(definition_version, VALUES(definition_version));

INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('claims_analyst', 'claims.view_own'), ('claims_analyst', 'claims.ingest_own'), ('claims_analyst', 'reports.view_own'), ('claims_analyst', 'registry.search'), ('claims_analyst', 'simulator.status'),
  ('fraud_analyst', 'claims.view_flagged'), ('fraud_analyst', 'reports.view_own'), ('fraud_analyst', 'investigations.create'), ('fraud_analyst', 'investigations.manage'), ('fraud_analyst', 'registry.search'), ('fraud_analyst', 'registry.review_history'), ('fraud_analyst', 'simulator.status'),
  ('investigator', 'reports.view_own'), ('investigator', 'investigations.create'), ('investigator', 'investigations.manage'), ('investigator', 'investigations.confirm'), ('investigator', 'investigations.reverse'), ('investigator', 'registry.search'), ('investigator', 'registry.review_history'), ('investigator', 'simulator.status'),
  ('applications_committee_member', 'registry.search'), ('applications_committee_member', 'registry.review_history'), ('applications_committee_member', 'simulator.status'),
  ('scheme_administrator', 'scheme_users.manage'), ('scheme_administrator', 'scheme_roles.assign'), ('scheme_administrator', 'scheme_health.view'), ('scheme_administrator', 'simulator.status'), ('scheme_administrator', 'simulator.control_own'),
  ('platform_administrator', 'organisation.manage'), ('platform_administrator', 'platform_health.view'), ('platform_administrator', 'provisioning.manage'), ('platform_administrator', 'simulator.status'), ('platform_administrator', 'simulator.control_platform')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
