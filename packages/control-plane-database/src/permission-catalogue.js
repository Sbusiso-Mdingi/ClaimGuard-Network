/**
 * Sequrin Canonical Permission Catalogue
 *
 * This module is the single authoritative platform-controlled source of truth for all
 * permission keys and their metadata. Tenants cannot invent arbitrary permission names.
 * Unknown permissions fail closed. Protected permissions cannot be downgraded by tenant
 * configuration.
 *
 * The database `permissions` table stores the definitive rows; this module mirrors
 * that contract as compile-time metadata for validation, resolver, and UI use.
 *
 * Compatibility note: existing system-role permissions (in `roles`, `role_permissions`,
 * `membership_roles`) remain immutable compatibility sources. Custom roles and PR 3
 * structures reference the same canonical permission keys through this catalogue.
 */

/**
 * @typedef {Object} PermissionMetadata
 * @property {string} key             - Canonical permission_key matching the database.
 * @property {string} description     - Human-readable description.
 * @property {string} category        - Logical grouping (claims, investigations, etc.).
 * @property {boolean} tenantAssignable - Can tenants assign this to custom roles?
 * @property {boolean} elevated       - Requires independent elevated approval?
 * @property {boolean} delegable      - Can be granted through bounded delegation?
 * @property {boolean} systemOnly     - Reserved for system/platform roles only?
 * @property {number} definitionVersion - Schema version of this permission definition.
 */

/** @type {ReadonlyArray<Readonly<PermissionMetadata>>} */
const PERMISSION_ENTRIES = Object.freeze([
  // === Claims ===
  { key: "claims.view_own", description: "View claims in the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "claims.ingest_own", description: "Ingest claims for the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "claims.view_flagged", description: "View flagged claims in the member organisation.", category: "claims", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },

  // === Reports ===
  { key: "reports.view_own", description: "View private reports for the member organisation.", category: "reports", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },

  // === Investigations ===
  { key: "investigations.create", description: "Create a private investigation.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "investigations.manage", description: "Manage private investigations.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "investigations.view_own", description: "View investigations in the member organisation without workflow mutation authority.", category: "investigations", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  // Fraud confirmation and reversal are elevated and non-delegable.
  { key: "investigations.confirm", description: "Confirm an approved private fraud finding.", category: "investigations", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "investigations.reverse", description: "Reverse an approved private fraud finding.", category: "investigations", tenantAssignable: true, elevated: true, delegable: false, systemOnly: false, definitionVersion: 1 },

  // === Registry ===
  { key: "registry.search", description: "Search the minimal shared registry.", category: "registry", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },
  { key: "registry.review_history", description: "Review permitted shared registry history.", category: "registry", tenantAssignable: true, elevated: false, delegable: true, systemOnly: false, definitionVersion: 1 },

  // === Scheme Administration ===
  { key: "scheme_users.manage", description: "Manage users in the member organisation.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "scheme_roles.assign", description: "Assign approved scheme roles.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "scheme_health.view", description: "View member organisation health.", category: "scheme_administration", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },

  // === Platform (system-only, non-delegable) ===
  { key: "organisation.manage", description: "Manage control-plane organisations.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },
  { key: "platform_health.view", description: "View non-sensitive platform health.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },
  { key: "provisioning.manage", description: "Manage organisation provisioning state.", category: "platform", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },

  // === Simulator ===
  { key: "simulator.status", description: "View simulator status.", category: "simulator", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "simulator.control_own", description: "Control an explicitly enabled organisation simulator.", category: "simulator", tenantAssignable: true, elevated: false, delegable: false, systemOnly: false, definitionVersion: 1 },
  { key: "simulator.control_platform", description: "Control explicitly enabled platform demo simulation.", category: "simulator", tenantAssignable: false, elevated: false, delegable: false, systemOnly: true, definitionVersion: 1 },

  // === Access Management (PR 3) ===
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

/** @type {ReadonlyMap<string, Readonly<PermissionMetadata>>} */
const CATALOGUE_BY_KEY = new Map(PERMISSION_ENTRIES.map((entry) => [entry.key, entry]));

/** Every canonical permission key. */
export const PERMISSION_KEYS = Object.freeze(PERMISSION_ENTRIES.map((entry) => entry.key));

/** The complete catalogue array. */
export const PERMISSION_CATALOGUE = Object.freeze(PERMISSION_ENTRIES);

/** Look up a single permission entry by key. Returns null for unknown keys. */
export function getPermissionMetadata(key) {
  return CATALOGUE_BY_KEY.get(key) || null;
}

/** Returns true only if the key exists in the canonical catalogue. */
export function isKnownPermission(key) {
  return CATALOGUE_BY_KEY.has(key);
}

/** Returns true if the permission can be assigned to tenant custom roles. */
export function isTenantAssignable(key) {
  const entry = CATALOGUE_BY_KEY.get(key);
  return entry ? entry.tenantAssignable : false;
}

/** Returns true if the permission requires elevated approval. */
export function isElevatedPermission(key) {
  const entry = CATALOGUE_BY_KEY.get(key);
  return entry ? entry.elevated : false;
}

/** Returns true if the permission can be granted through bounded delegation. */
export function isDelegablePermission(key) {
  const entry = CATALOGUE_BY_KEY.get(key);
  return entry ? entry.delegable : false;
}

/** Returns true if the permission is reserved for system/platform roles only. */
export function isSystemOnlyPermission(key) {
  const entry = CATALOGUE_BY_KEY.get(key);
  return entry ? entry.systemOnly : false;
}

/**
 * Validate a list of permission keys against the catalogue.
 * Returns { valid: string[], unknown: string[] }.
 */
export function validatePermissionKeys(keys) {
  const valid = [];
  const unknown = [];
  for (const key of keys || []) {
    if (CATALOGUE_BY_KEY.has(key)) {
      valid.push(key);
    } else {
      unknown.push(key);
    }
  }
  return { valid, unknown };
}

/**
 * Filter permissions that are assignable to tenant custom roles.
 * Returns only keys that exist in the catalogue and are tenant-assignable.
 */
export function filterTenantAssignable(keys) {
  return (keys || []).filter((key) => {
    const entry = CATALOGUE_BY_KEY.get(key);
    return entry && entry.tenantAssignable;
  });
}

/**
 * Partition permissions into elevated and non-elevated groups.
 * Unknown keys are excluded from both.
 */
export function partitionElevated(keys) {
  const elevated = [];
  const standard = [];
  for (const key of keys || []) {
    const entry = CATALOGUE_BY_KEY.get(key);
    if (!entry) continue;
    if (entry.elevated) {
      elevated.push(key);
    } else {
      standard.push(key);
    }
  }
  return { elevated, standard };
}

/** Get all permission entries for a given category. */
export function getPermissionsByCategory(category) {
  return PERMISSION_ENTRIES.filter((entry) => entry.category === category);
}

/** Get all distinct categories. */
export function getCategories() {
  return [...new Set(PERMISSION_ENTRIES.map((entry) => entry.category))];
}

/**
 * The set of permission keys that no custom role or delegation may ever authorize.
 * These operations require governed case workflow or registry governance.
 */
export const GOVERNANCE_PROTECTED_PERMISSIONS = Object.freeze(new Set([
  "investigations.confirm",
  "investigations.reverse",
]));

/**
 * Maximum delegation duration in hours. Delegations cannot exceed this duration
 * and cannot outlive the source authority.
 */
export const MAX_DELEGATION_HOURS = 720; // 30 days
