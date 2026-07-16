export const CLAIMGUARD_ROLES = Object.freeze({
  SCHEME_USER: "scheme_user",
  FRAUD_ANALYST: "fraud_analyst",
  INVESTIGATOR: "investigator",
  NEW_APPLICATIONS_OFFICER: "new_applications_officer",
  SCHEME_ADMINISTRATOR: "scheme_administrator",
  PLATFORM_ADMINISTRATOR: "platform_administrator",
});

export const CLAIMGUARD_PERMISSIONS = Object.freeze({
  CLAIMS_INGEST: "claims.ingest",
  CLAIMS_VIEW_OWN: "claims.view_own",
  REPORTS_VIEW_OWN: "reports.view_own",
  CLAIMS_VIEW_FLAGGED: "claims.view_flagged",
  ALERTS_TRIAGE: "alerts.triage",
  INVESTIGATIONS_ESCALATE: "investigations.escalate",
  INVESTIGATIONS_CREATE: "investigations.create",
  INVESTIGATIONS_VIEW: "investigations.view",
  INVESTIGATIONS_UPDATE_STATUS: "investigations.update_status",
  INVESTIGATIONS_ADD_NOTE: "investigations.add_note",
  INVESTIGATIONS_CHANGE_PRIORITY: "investigations.change_priority",
  INVESTIGATIONS_OPEN: "investigations.open",
  INVESTIGATIONS_COMPLETE: "investigations.complete",
  INVESTIGATIONS_UPLOAD_EVIDENCE: "investigations.upload_evidence",
  INVESTIGATIONS_SUBMIT_FINDINGS: "investigations.submit_findings",
  INVESTIGATIONS_CONFIRM_FRAUD: "investigations.confirm_fraud",
  FRAUD_REGISTRY_SEARCH: "fraud_registry.search",
  FRAUD_REGISTRY_VIEW: "fraud_registry.view",
  FRAUD_REGISTRY_REVIEW_HISTORY: "fraud_registry.review_history",
  USERS_MANAGE_TENANT: "users.manage_tenant",
  DETECTION_MANAGE_TENANT: "detection.manage_tenant",
  TENANT_STATUS_VIEW: "tenant_status.view",
  TENANTS_MANAGE: "tenants.manage",
  PLATFORM_HEALTH_VIEW: "platform_health.view",
  TELEMETRY_VIEW: "telemetry.view",
  SIMULATOR_STATUS_VIEW: "simulator.status_view",
  SIMULATOR_CONTROL: "simulator.control",
});

const rolePermissionMap = Object.freeze({
  [CLAIMGUARD_ROLES.SCHEME_USER]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST,
    CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN,
    CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
  ]),
  [CLAIMGUARD_ROLES.FRAUD_ANALYST]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN,
    CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_FLAGGED,
    CLAIMGUARD_PERMISSIONS.ALERTS_TRIAGE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ESCALATE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
  ]),
  [CLAIMGUARD_ROLES.INVESTIGATOR]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_OPEN,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_COMPLETE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPLOAD_EVIDENCE,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_SUBMIT_FINDINGS,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
  ]),
  [CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
  ]),
  [CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT,
    CLAIMGUARD_PERMISSIONS.DETECTION_MANAGE_TENANT,
    CLAIMGUARD_PERMISSIONS.TENANT_STATUS_VIEW,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
  ]),
  [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR]: Object.freeze([
    CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE,
    CLAIMGUARD_PERMISSIONS.PLATFORM_HEALTH_VIEW,
    CLAIMGUARD_PERMISSIONS.TELEMETRY_VIEW,
    CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW,
    CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL,
  ]),
});

const canonicalRoleByAlias = Object.freeze({
  "scheme user": CLAIMGUARD_ROLES.SCHEME_USER,
  scheme_user: CLAIMGUARD_ROLES.SCHEME_USER,
  schemeuser: CLAIMGUARD_ROLES.SCHEME_USER,
  "fraud analyst": CLAIMGUARD_ROLES.FRAUD_ANALYST,
  fraud_analyst: CLAIMGUARD_ROLES.FRAUD_ANALYST,
  fraudanalyst: CLAIMGUARD_ROLES.FRAUD_ANALYST,
  investigator: CLAIMGUARD_ROLES.INVESTIGATOR,
  "new applications officer": CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER,
  new_applications_officer: CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER,
  newapplicationsofficer: CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER,
  "scheme administrator": CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR,
  scheme_administrator: CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR,
  schemeadministrator: CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR,
  "platform administrator": CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR,
  platform_administrator: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR,
  platformadministrator: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR,
});

export function normalizeRole(roleValue) {
  if (typeof roleValue !== "string") {
    return null;
  }

  const normalized = roleValue.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const withUnderscores = normalized.replace(/[\s-]+/g, "_");
  return canonicalRoleByAlias[normalized] || canonicalRoleByAlias[withUnderscores] || null;
}

export function parseRoles(roleHeaderValue) {
  if (typeof roleHeaderValue !== "string") {
    return [];
  }

  const normalizedRoles = roleHeaderValue
    .split(",")
    .map((role) => normalizeRole(role))
    .filter(Boolean);

  return [...new Set(normalizedRoles)];
}

export function getPermissionsForRoles(roles) {
  const permissionSet = new Set();

  for (const role of roles || []) {
    const rolePermissions = rolePermissionMap[role] || [];
    for (const permission of rolePermissions) {
      permissionSet.add(permission);
    }
  }

  return permissionSet;
}

export function hasPermission(authContext, permission) {
  if (!authContext || !permission) {
    return false;
  }

  return authContext.permissions instanceof Set && authContext.permissions.has(permission);
}

export function isPlatformAdministrator(authContext) {
  return Boolean(
    authContext?.roles?.includes(CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR),
  );
}

function normalizeDistinctNonEmpty(values) {
  const cleaned = values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(cleaned)];
}

export function evaluateTenantAccess({
  authContext,
  tenantContext,
  resourceTenantIds = [],
  resourceSchemeIds = [],
} = {}) {
  if (isPlatformAdministrator(authContext)) {
    return {
      allowed: true,
      bypass: true,
      reason: "platform_admin",
    };
  }

  const normalizedResourceTenantIds = normalizeDistinctNonEmpty(resourceTenantIds);
  const normalizedResourceSchemeIds = normalizeDistinctNonEmpty(resourceSchemeIds);

  const authTenantId = authContext?.tenant_id || null;
  const contextTenantId = tenantContext?.tenant_id || null;
  const contextSchemeId = tenantContext?.scheme_id || null;

  if (!authTenantId || !contextTenantId) {
    return {
      allowed: false,
      bypass: false,
      reason: "tenant_context_unavailable",
    };
  }

  if (authTenantId !== contextTenantId) {
    return {
      allowed: false,
      bypass: false,
      reason: "tenant_mismatch",
    };
  }

  if (normalizedResourceTenantIds.length > 0 && normalizedResourceTenantIds.some((id) => id !== contextTenantId)) {
    return {
      allowed: false,
      bypass: false,
      reason: "resource_tenant_mismatch",
    };
  }

  if (
    contextSchemeId &&
    normalizedResourceSchemeIds.length > 0 &&
    normalizedResourceSchemeIds.some((schemeId) => schemeId !== contextSchemeId)
  ) {
    return {
      allowed: false,
      bypass: false,
      reason: "resource_scheme_mismatch",
    };
  }

  return {
    allowed: true,
    bypass: false,
    reason: "tenant_scoped",
  };
}
