-- Sequrin PR 3: trusted runtime authorization integration.
-- Additive only. Migration 0100 remains unchanged.

-- Authentication validity and membership authority are distinct concerns.
ALTER TABLE login_sessions
  ADD COLUMN authentication_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER authorization_version;

-- Existing sessions predate the split and used authorization_version for the
-- user's authentication version. Preserve that value for authentication checks.
UPDATE login_sessions
SET authentication_version = authorization_version;

-- New sessions use the current organisation_memberships.authorization_version
-- for authorization_version and users.authentication_version for authentication_version.

INSERT INTO permissions
  (permission_id, permission_key, description, definition_version,
   category, tenant_assignable, elevated, delegable, system_only)
VALUES
  ('case.triage', 'case.triage', 'Begin or resume governed case triage.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.dismiss', 'case.dismiss', 'Dismiss a governed case after triage.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.monitor', 'case.monitor', 'Place a governed case into monitoring.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.open_investigation', 'case.open_investigation', 'Open a governed investigation case.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.record_notice', 'case.record_notice', 'Record governed notice delivery evidence.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.record_response', 'case.record_response', 'Record governed response status.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.review_evidence', 'case.review_evidence', 'Review governed case evidence.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.complete_report', 'case.complete_report', 'Complete a governed investigation report.', 1, 'case_governance', 1, 0, 1, 0),
  ('case.submit_outcome_review', 'case.submit_outcome_review', 'Submit a completed report for independent outcome review.', 1, 'case_governance', 1, 0, 0, 0),
  ('case.review_outcome', 'case.review_outcome', 'Review a governed case outcome independently.', 1, 'case_governance', 1, 1, 0, 0),
  ('case.approve_outcome', 'case.approve_outcome', 'Approve a governed case outcome independently.', 1, 'case_governance', 1, 1, 0, 0),
  ('case.close_unsubstantiated', 'case.close_unsubstantiated', 'Close a governed case as unsubstantiated.', 1, 'case_governance', 1, 1, 0, 0),
  ('case.open_appeal_or_review', 'case.open_appeal_or_review', 'Open a governed appeal or review.', 1, 'case_governance', 1, 1, 0, 0),
  ('case.return_for_further_evidence', 'case.return_for_further_evidence', 'Return a governed case for further evidence.', 1, 'case_governance', 1, 0, 0, 0)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  definition_version = GREATEST(definition_version, VALUES(definition_version)),
  category = VALUES(category),
  tenant_assignable = VALUES(tenant_assignable),
  elevated = VALUES(elevated),
  delegable = VALUES(delegable),
  system_only = VALUES(system_only);

-- Legacy fraud-verdict permissions are retained only for immutable historical
-- compatibility. A tenant cannot assign or delegate them, and the production
-- contracts remain disabled independently of permission resolution.
UPDATE permissions
SET category = 'legacy_governance', tenant_assignable = 0,
    elevated = 1, delegable = 0, system_only = 1,
    definition_version = GREATEST(definition_version, 2)
WHERE permission_key IN ('investigations.confirm', 'investigations.reverse');

-- Fixed system-role compatibility mappings. These are catalogue permission
-- inputs, not role-name authorization at request time.
INSERT INTO role_permissions (role_id, permission_id) VALUES
  ('fraud_analyst', 'case.triage'),
  ('fraud_analyst', 'case.dismiss'),
  ('fraud_analyst', 'case.monitor'),
  ('fraud_analyst', 'case.open_investigation'),
  ('investigator', 'case.record_notice'),
  ('investigator', 'case.record_response'),
  ('investigator', 'case.review_evidence'),
  ('investigator', 'case.complete_report'),
  ('investigator', 'case.submit_outcome_review'),
  ('applications_committee_member', 'case.review_outcome'),
  ('applications_committee_member', 'case.approve_outcome'),
  ('applications_committee_member', 'case.close_unsubstantiated'),
  ('applications_committee_member', 'case.open_appeal_or_review'),
  ('applications_committee_member', 'case.return_for_further_evidence'),
  ('scheme_administrator', 'access.roles.read'),
  ('scheme_administrator', 'access.roles.manage'),
  ('scheme_administrator', 'access.assignments.read'),
  ('scheme_administrator', 'access.assignments.manage'),
  ('scheme_administrator', 'access.delegations.read'),
  ('scheme_administrator', 'access.delegations.grant'),
  ('scheme_administrator', 'access.delegations.revoke'),
  ('scheme_administrator', 'access.elevated_permissions.review'),
  ('scheme_administrator', 'access.audit.read')
ON DUPLICATE KEY UPDATE granted_at = granted_at;
