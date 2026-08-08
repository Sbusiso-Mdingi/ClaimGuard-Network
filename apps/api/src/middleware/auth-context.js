import { ACCESS_ERROR_CODE, sha256 } from "@claimguard/control-plane-database";

import { ForbiddenError } from "../application-errors.js";

export const IDENTITY_AUTHORITY_HEADERS = Object.freeze([
  "x-claimguard-user",
  "x-claimguard-role",
  "x-claimguard-user-tenant",
  "x-claimguard-tenant",
]);

export const LEGACY_SERVICE_IDENTITY_HEADERS = Object.freeze([
  "x-cg-service-actor",
  "x-cg-service-role",
  "x-cg-service-tenant",
  "x-cg-service-organisation",
]);

export function createAnonymousAuthContext({ source = "anonymous" } = {}) {
  return Object.freeze({
    is_authenticated: false, user_id: null, roles: Object.freeze([]), permissions: new Set(),
    tenant_id: null, organisation_id: null, membership_id: null, actor_type: "anonymous",
    authentication_version: null, authorization_version: null, correlation_id: null, source,
  });
}

function actorOperationalTenantId(actor) {
  if (actor?.legacyTenant?.tenantId) return actor.legacyTenant.tenantId;
  if (actor?.organisation?.organisationType === "medical_scheme") {
    return actor.organisation.organisationId || null;
  }
  return null;
}

export function createAuthenticatedAuthContext({
  userId, roles, permissions = [], tenantId, organisationId = null, membershipId = null,
  displayName = null, organisation = null, source = "session", actorType = "user",
  authenticationVersion = null, authorizationVersion = null, correlationId = null,
} = {}) {
  const normalizedRoles = Object.freeze([...(roles || [])]);
  const resolvedPermissions = [...new Set(permissions || [])];
  return Object.freeze({
    is_authenticated: true,
    user_id: userId,
    display_name: displayName,
    roles: normalizedRoles,
    permissions: new Set(resolvedPermissions),
    tenant_id: tenantId || null,
    organisation_id: organisationId,
    membership_id: membershipId,
    organisation,
    actor_type: actorType,
    authentication_version: authenticationVersion,
    authorization_version: authorizationVersion,
    correlation_id: correlationId,
    source,
  });
}

export function parseCookieHeader(headerValue) {
  const result = new Map();
  for (const segment of String(headerValue || "").split(";")) {
    const index = segment.indexOf("=");
    if (index < 1) continue;
    result.set(segment.slice(0, index).trim(), decodeURIComponent(segment.slice(index + 1).trim()));
  }
  return result;
}

const CONTROL_PERMISSION_TO_OPERATIONAL = Object.freeze({
  "claims.view_own": ["claims.view_own"],
  "claims.ingest_own": ["claims.ingest"],
  "claims.view_flagged": ["claims.view_flagged"],
  "reports.view_own": ["reports.view_own"],
  "investigations.view_own": ["investigations.view"],
  "investigations.create": ["investigations.create"],
  "investigations.manage": ["investigations.view", "investigations.update_status", "investigations.add_note", "investigations.change_priority", "investigations.assign", "investigations.open", "investigations.complete", "investigations.upload_evidence", "investigations.submit_findings"],
  "registry.search": ["fraud_registry.search", "fraud_registry.view"],
  "registry.review_history": ["fraud_registry.review_history"],
  "scheme_users.manage": ["users.manage_tenant"],
  "scheme_roles.assign": ["users.manage_tenant"],
  "scheme_health.view": ["tenant_status.view"],
  "organisation.manage": ["tenants.manage"],
  "platform_health.view": ["platform_health.view"],
  "platform_releases.view": ["platform_releases.view"],
  "platform_releases.request": ["platform_releases.request"],
  "platform_releases.approve": ["platform_releases.approve"],
  "platform_administrators.manage": ["platform_administrators.manage"],
  "desktop_devices.manage": ["desktop.devices.manage"],
  "desktop_fleet_policy.manage": ["desktop.fleet_policy.manage"],
});

export function operationalPermissions(controlPermissions) {
  return [...new Set((controlPermissions || []).flatMap((permission) => (
    CONTROL_PERMISSION_TO_OPERATIONAL[permission] || [permission]
  )))];
}

export function requestMetadata(request, { trustProxy = false } = {}) {
  const forwarded = trustProxy ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : null;
  const source = forwarded || (trustProxy ? request.headers.get("x-real-ip") : null) || "unavailable";
  return {
    sourceNetworkHash: sha256(source),
    userAgentHash: sha256(request.headers.get("user-agent") || "unavailable"),
    correlationId: request.headers.get("x-request-id") || null,
  };
}

export function createSessionAuthenticationProvider({ authenticationService, configuration }) {
  if (!authenticationService) throw new TypeError("authenticationService is required for session mode.");
  return {
    mode: "session",
    async resolveAuthContext({ request }) {
      const spoofed = [...IDENTITY_AUTHORITY_HEADERS, ...LEGACY_SERVICE_IDENTITY_HEADERS]
        .filter((name) => request.headers.has(name));
      const metadata = requestMetadata(request, configuration);
      if (spoofed.length > 0) {
        await authenticationService.recordSecurityEvent("header_spoof_attempt", "failure", metadata, {}, "identity_authority_header");
        const error = new ForbiddenError("Identity-authority headers are not accepted in session mode.");
        error.code = "IDENTITY_HEADER_REJECTED";
        throw error;
      }
      const authorization = request.headers.get("authorization") || "";
      if (authorization) {
        const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const integration = await authenticationService.resolveIntegrationCredential?.(supplied, metadata);
        if (integration) {
          return {
            authContext: createAuthenticatedAuthContext({
              userId: integration.serviceActorId,
              roles: [integration.roleKey],
              permissions: [],
              tenantId: integration.tenantId,
              organisationId: integration.organisationId,
              source: "internal_service",
              actorType: "service",
              correlationId: metadata.correlationId,
            }),
            resolvedSession: null,
            metadata,
          };
        }
        const error = new ForbiddenError("Internal service authentication failed.");
        error.code = "INTERNAL_SERVICE_AUTHENTICATION_FAILED";
        throw error;
      }
      const bearerSecret = parseCookieHeader(request.headers.get("cookie")).get(configuration.cookie.name) || null;
      if (!bearerSecret) return { authContext: createAnonymousAuthContext(), resolvedSession: null, metadata };
      try {
        const resolvedSession = await authenticationService.resolveSession(bearerSecret, metadata);
        const { actor } = resolvedSession;
        return {
          resolvedSession,
          metadata,
          authContext: createAuthenticatedAuthContext({
            userId: actor.user.userId,
            displayName: actor.user.displayName,
            roles: actor.roles,
            permissions: operationalPermissions(actor.permissions),
            tenantId: actorOperationalTenantId(actor),
            organisationId: actor.organisation.organisationId,
            membershipId: actor.membership.membershipId,
            organisation: actor.organisation,
            source: "session",
            actorType: "user",
            authenticationVersion: actor.authenticationVersion,
            authorizationVersion: actor.authorizationVersion,
            correlationId: metadata.correlationId,
          }),
        };
      } catch (error) {
        if (error?.code === ACCESS_ERROR_CODE.AUTHORIZATION_VERSION_STALE) throw error;
        return {
          authContext: createAnonymousAuthContext({ source: "invalid_session" }),
          resolvedSession: null,
          metadata,
          dataPlaneOrganisationToRetire: error?.organisationId || null,
        };
      }
    },
  };
}
