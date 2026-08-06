/**
 * Sequrin Canonical Permission Catalogue
 *
 * Platform-controlled source of truth for permission keys and immutable metadata.
 * Tenants may combine tenant-assignable entries, but may never invent permission keys
 * or change elevated, delegable, or system-only classifications.
 */

const PERMISSION_ENTRIES = Object.freeze([
  { key: "claims.view_own", description: "View claims in the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "claims.ingest_own", description: "Ingest claims for the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "claims.view_flagged", description: "View flagged claims in the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "reports.view_own", description: "View private reports for the member organisation.", category: "reports", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },

  { key: "investigations.create", description: "Create a private investigation.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "investigations.manage", description: "Manage private investigations.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "investigations.view_own", description: "View investigations in the member organisation without workflow mutation authority.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  // Historical compatibility only. Production legacy confirmation/reversal contracts remain disabled.
  { key: "investigations.confirm", description: "Historical system compatibility permission for disabled fraud confirmation.", category: "legacy_governance", tenantAssignable: false, elevated: true, delegable: false, systemOnly: true, definitionVersion: 2 },
  { key: "investigations.reverse", description: "Historical system compatibility permission for disabled fraud reversal.", category: "legacy_governance", tenantAssignable: false, elevated: true, delegable: false, systemOnly: true, definitionVersion: 2 },

  // Governed PR 2 case permissions.
  { key: "case.triage", description: "Begin or resume governed case triage.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.dismiss", description: "Dismiss a governed case after triage.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.monitor", description: "Place a governed case into monitoring.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.open_investigation", description: "Open a governed investigation case.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.record_notice", description: "Record governed notice delivery evidence.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.record_response", description: "Record governed response status.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.review_evidence", description: "Review governed case evidence.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.complete_report", description: "Complete a governed investigation report.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "case.submit_outcome_review", description: "Submit a completed report for independent outcome review.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "case.review_outcome", description: "Review a governed case outcome independently.", category: "case_governance", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "case.approve_outcome", description: "Approve a governed case outcome independently.", category: "case_governance", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "case.close_unsubstantiated", description: "Close a governed case as unsubstantiated.", category: "case_governance", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "case.open_appeal_or_review", description: "Open a governed appeal or review.", category: "case_governance", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "case.return_for_further_evidence", description: "Return a governed case for further evidence.", category: "case_governance", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },

  { key: "registry.search", description: "Search the minimal shared registry.", category: "registry", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "registry.review_history", description: "Review permitted shared registry history.", category: "registry", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },

  { key: "scheme_users.manage", description: "Manage users in the member organisation.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "scheme_roles.assign", description: "Assign approved scheme roles.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "scheme_health.view", description: "View member organisation health.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },

  { key: "organisation.manage", description: "Manage control-plane organisations.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },
  { key: "platform_health.view", description: "View non-sensitive platform health.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },
  { key: "provisioning.manage", description: "Manage organisation provisioning state.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },

  { key: "simulator.status", description: "View simulator status.", category: "simulator", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "simulator.control_own", description: "Control an explicitly enabled organisation simulator.", category: "simulator", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "simulator.control_platform", description: "Control explicitly enabled platform demo simulation.", category: "simulator", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },

  { key: "access.roles.read", description: "Read tenant role definitions and fixed catalogue metadata.", category: "access_management", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "access.roles.manage", description: "Create and change tenant custom roles.", category: "access_management", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "access.assignments.read", description: "Read tenant role assignments.", category: "access_management", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "access.assignments.manage", description: "Create and revoke tenant role assignments.", category: "access_management", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "access.delegations.read", description: "Read tenant permission delegations.", category: "access_management", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "access.delegations.grant", description: "Grant bounded temporary permission delegations.", category: "access_management", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "access.delegations.revoke", description: "Revoke another user permission delegation.", category: "access_management", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "access.elevated_permissions.review", description: "Independently approve or reject elevated authority.", category: "access_management", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "access.audit.read", description: "Read tenant authorization audit evidence.", category: "access_management", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
]);

const CATALOGUE_BY_KEY = new Map(PERMISSION_ENTRIES.map((entry) => [entry.key, Object.freeze(entry)]));

export const PERMISSION_KEYS = Object.freeze(PERMISSION_ENTRIES.map((entry) => entry.key));
export const PERMISSION_CATALOGUE = Object.freeze(PERMISSION_ENTRIES.map((entry) => CATALOGUE_BY_KEY.get(entry.key)));

export function getPermissionMetadata(key) { return CATALOGUE_BY_KEY.get(key) || null; }
export function isKnownPermission(key) { return CATALOGUE_BY_KEY.has(key); }
export function isTenantAssignable(key) { return Boolean(CATALOGUE_BY_KEY.get(key)?.tenantAssignable); }
export function isElevatedPermission(key) { return Boolean(CATALOGUE_BY_KEY.get(key)?.elevated); }
export function isDelegablePermission(key) { return Boolean(CATALOGUE_BY_KEY.get(key)?.delegable); }
export function isSystemOnlyPermission(key) { return Boolean(CATALOGUE_BY_KEY.get(key)?.systemOnly); }

export function validatePermissionKeys(keys) {
  const valid = [];
  const unknown = [];
  for (const key of keys || []) (CATALOGUE_BY_KEY.has(key) ? valid : unknown).push(key);
  return { valid: [...new Set(valid)], unknown: [...new Set(unknown)] };
}

export function filterTenantAssignable(keys) {
  return [...new Set((keys || []).filter((key) => isTenantAssignable(key)))];
}

export function partitionElevated(keys) {
  const elevated = [];
  const standard = [];
  for (const key of keys || []) {
    const entry = CATALOGUE_BY_KEY.get(key);
    if (!entry) continue;
    (entry.elevated ? elevated : standard).push(key);
  }
  return { elevated: [...new Set(elevated)], standard: [...new Set(standard)] };
}

export function getPermissionsByCategory(category) {
  return PERMISSION_CATALOGUE.filter((entry) => entry.category === category);
}

export function getCategories() {
  return [...new Set(PERMISSION_CATALALOGUE.map((entry) => entry.category))];
}

export const SYSTEM_ROLE_PERMISSION_COMPATIBILITY = Object.freeze({
  fraud_analyst: Object.freeze(["case.triage", "case.dismiss", "case.monitor", "case.open_investigation"]),
  investigator: Object.freeze(["case.record_notice", "case.record_response", "case.review_evidence", "case.complete_report", "case.submit_outcome_review"]),
  applications_committee_member: Object.freeze(["case.review_outcome", "case.approve_outcome", "case.close_unsubstantiated", "case.open_appeal_or_review", "case.return_for_further_evidence"]),
  scheme_administrator: Object.freeze(["access.roles.read", "access.roles.manage", "access.assignments.read", "access.assignments.manage", "access.delegations.read", "access.delegations.grant", "access.delegations.revoke", "access.elevated_permissions.review", "access.audit.read"]),
});

export function getSystemRoleCompatibilityPermissions(roleKey) {
  return SYSTEM_ROLE_PERMISSION_COMPATIBILITY[roleKey] || Object.freeze([]);
}

export const GOVERNANCE_PROTECTED_PERMISSIONS = Object.freeze(new Set([
  "investigations.confirm",
  "investigations.reverse",
]));

export const MAX_DELEGATION_HOURS = 720;
