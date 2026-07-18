export const CLAIMGUARD_ROLES = Object.freeze({
  CLAIMS_ANALYST: "claims_analyst",
  SCHEME_USER: "scheme_user",
  FRAUD_ANALYST: "fraud_analyst",
  INVESTIGATOR: "investigator",
  APPLICATIONS_COMMITTEE_MEMBER: "applications_committee_member",
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
    CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW,
    CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL,
  ]),
});

const canonicalRoleByAlias = Object.freeze({
  claims_analyst: CLAIMGUARD_ROLES.CLAIMS_ANALYST,
  "scheme user": CLAIMGUARD_ROLES.SCHEME_USER,
  scheme_user: CLAIMGUARD_ROLES.SCHEME_USER,
  schemeuser: CLAIMGUARD_ROLES.SCHEME_USER,
  "fraud analyst": CLAIMGUARD_ROLES.FRAUD_ANALYST,
  fraud_analyst: CLAIMGUARD_ROLES.FRAUD_ANALYST,
  fraudanalyst: CLAIMGUARD_ROLES.FRAUD_ANALYST,
  investigator: CLAIMGUARD_ROLES.INVESTIGATOR,
  applications_committee_member: CLAIMGUARD_ROLES.APPLICATIONS_COMMITTEE_MEMBER,
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

export const OPERATIONAL_ROUTE_IDS = Object.freeze({
  CLAIMS_LIST: "claims.list",
  CLAIMS_DETAIL: "claims.detail",
  CLAIMS_INGEST: "claims.ingest",
  INVESTIGATIONS_CREATE: "investigations.create",
  INVESTIGATIONS_VIEW: "investigations.view",
  INVESTIGATIONS_PATCH: "investigations.patch",
  INVESTIGATIONS_ADD_NOTE: "investigations.add_note",
  INVESTIGATIONS_UPLOAD_EVIDENCE: "investigations.upload_evidence",
  INVESTIGATIONS_CONFIRM_FRAUD: "investigations.confirm_fraud",
  INVESTIGATIONS_REVERSE_FRAUD: "investigations.reverse_fraud",
  DETECTION_REPORT: "detection.report",
  DETECTION_GRAPH: "detection.graph",
  DETECTION_RISK: "detection.risk",
  DETECTION_ANALYZE: "detection.analyze",
  LEDGER_PREVIEW: "ledger.preview",
  LEDGER_LATEST: "ledger.latest",
  REGISTRY_SEARCH: "registry.search",
  REGISTRY_HISTORY: "registry.history",
  REGISTRY_DETAIL: "registry.detail",
  SIMULATOR_STATUS: "simulator.status",
  SIMULATOR_START: "simulator.start",
  SIMULATOR_PAUSE: "simulator.pause",
  SIMULATOR_RESUME: "simulator.resume",
  SIMULATOR_STOP: "simulator.stop",
  SIMULATOR_MODE: "simulator.mode",
  INTERNAL_DATA_PLANE_HEALTH: "internal.data_plane.health",
});

export const OPERATIONAL_ROUTE_PREFIXES = Object.freeze([
  "/claims",
  "/investigations",
  "/detection",
  "/ledger",
  "/registry",
  "/simulator",
  "/internal/data-plane",
]);

function normalizeRequestPath(path) {
  const normalized = String(path || "").trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeRequestMethod(method) {
  const upper = String(method || "GET").toUpperCase();
  if (upper === "HEAD") return "GET";
  return upper;
}

function patternMatchesPath(pathPattern, requestPath) {
  const patternSegments = String(pathPattern || "").split("/").filter(Boolean);
  const pathSegments = String(requestPath || "").split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return false;

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];
    if (patternSegment.startsWith(":")) {
      if (!pathSegment) return false;
      continue;
    }
    if (patternSegment !== pathSegment) return false;
  }

  return true;
}

const operationalRoutePolicyEntries = [
  {
    id: OPERATIONAL_ROUTE_IDS.CLAIMS_LIST,
    method: "GET",
    pathPattern: "/claims",
    permissions: [CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.CLAIMS_DETAIL,
    method: "GET",
    pathPattern: "/claims/:claimId",
    permissions: [CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.CLAIMS_INGEST,
    method: "POST",
    pathPattern: "/claims/ingest",
    permissions: [CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CREATE,
    method: "POST",
    pathPattern: "/investigations",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_VIEW,
    method: "GET",
    pathPattern: "/investigations/:id",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_PATCH,
    method: "PATCH",
    pathPattern: "/investigations/:id",
    permissionMode: "all",
    requiresOperationalDataPlane: true,
    resolvePermissionRequirement({ payload } = {}) {
      const hasStatus = Boolean(payload && Object.hasOwn(payload, "status"));
      const hasPriority = Boolean(payload && Object.hasOwn(payload, "priority"));
      if (hasStatus && hasPriority) {
        return {
          permissions: [
            CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS,
            CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY,
          ],
          mode: "all",
        };
      }
      if (hasStatus) {
        return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS], mode: "all" };
      }
      if (hasPriority) {
        return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY], mode: "all" };
      }
      return {
        permissions: [
          CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS,
          CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY,
        ],
        mode: "any",
      };
    },
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_ADD_NOTE,
    method: "POST",
    pathPattern: "/investigations/:id/notes",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_UPLOAD_EVIDENCE,
    method: "POST",
    pathPattern: "/investigations/:id/evidence",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPLOAD_EVIDENCE],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CONFIRM_FRAUD,
    method: "POST",
    pathPattern: "/investigations/confirm-fraud",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_REVERSE_FRAUD,
    method: "POST",
    pathPattern: "/investigations/reverse-fraud",
    permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.DETECTION_ANALYZE,
    method: "POST",
    pathPattern: "/detection/analyze",
    permissions: [CLAIMGUARD_PERMISSIONS.DETECTION_MANAGE_TENANT],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.DETECTION_REPORT,
    method: "GET",
    pathPattern: "/detection/report",
    permissions: [CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.DETECTION_GRAPH,
    method: "GET",
    pathPattern: "/detection/graph",
    permissions: [CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.DETECTION_RISK,
    method: "GET",
    pathPattern: "/detection/risk",
    permissions: [CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.LEDGER_PREVIEW,
    method: "GET",
    pathPattern: "/ledger/preview",
    permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.LEDGER_LATEST,
    method: "GET",
    pathPattern: "/ledger/latest",
    permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.REGISTRY_SEARCH,
    method: "GET",
    pathPattern: "/registry/search",
    permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.REGISTRY_HISTORY,
    method: "GET",
    pathPattern: "/registry/history/:subjectToken",
    permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.REGISTRY_DETAIL,
    method: "GET",
    pathPattern: "/registry/:id",
    permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_STATUS,
    method: "GET",
    pathPattern: "/simulator/status",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_START,
    method: "POST",
    pathPattern: "/simulator/start",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_PAUSE,
    method: "POST",
    pathPattern: "/simulator/pause",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_RESUME,
    method: "POST",
    pathPattern: "/simulator/resume",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_STOP,
    method: "POST",
    pathPattern: "/simulator/stop",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.SIMULATOR_MODE,
    method: "POST",
    pathPattern: "/simulator/mode",
    permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL],
    permissionMode: "all",
    requiresOperationalDataPlane: true,
  },
  {
    id: OPERATIONAL_ROUTE_IDS.INTERNAL_DATA_PLANE_HEALTH,
    method: "GET",
    pathPattern: "/internal/data-plane/health",
    permissions: [CLAIMGUARD_PERMISSIONS.PLATFORM_HEALTH_VIEW],
    permissionMode: "all",
    requiresOperationalDataPlane: false,
  },
];

export const OPERATIONAL_ROUTE_POLICIES = Object.freeze(
  operationalRoutePolicyEntries.map((entry) => Object.freeze(entry)),
);

export function isOperationalRoutePath(path) {
  const normalizedPath = normalizeRequestPath(path);
  return OPERATIONAL_ROUTE_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
}

export function getOperationalRoutePolicyById(routeId) {
  return OPERATIONAL_ROUTE_POLICIES.find((entry) => entry.id === routeId) || null;
}

export function resolveOperationalRoutePolicy({ path, method } = {}) {
  const normalizedPath = normalizeRequestPath(path);
  if (!isOperationalRoutePath(normalizedPath)) return null;

  const normalizedMethod = normalizeRequestMethod(method);
  if (normalizedMethod === "OPTIONS") {
    return Object.freeze({
      id: "operational.options.bypass",
      method: "OPTIONS",
      pathPattern: normalizedPath,
      requiresOperationalDataPlane: false,
      bypassAuthorization: true,
      permissions: [],
      permissionMode: "all",
    });
  }

  for (const entry of OPERATIONAL_ROUTE_POLICIES) {
    if (entry.method !== normalizedMethod) continue;
    if (patternMatchesPath(entry.pathPattern, normalizedPath)) return entry;
  }

  return undefined;
}

export function resolveOperationalRoutePermissionRequirement({ routePolicy, payload } = {}) {
  if (!routePolicy) return Object.freeze({ permissions: [], mode: "all" });

  const resolved = typeof routePolicy.resolvePermissionRequirement === "function"
    ? routePolicy.resolvePermissionRequirement({ payload })
    : {
      permissions: routePolicy.permissions || [],
      mode: routePolicy.permissionMode || "all",
    };

  const permissions = (resolved?.permissions || [])
    .filter((permission) => typeof permission === "string" && permission.trim())
    .map((permission) => permission.trim());
  const mode = resolved?.mode === "any" ? "any" : "all";
  return Object.freeze({ permissions, mode });
}
