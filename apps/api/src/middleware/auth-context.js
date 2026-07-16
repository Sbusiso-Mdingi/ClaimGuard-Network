import { sha256 } from "@claimguard/control-plane-database";

import { getPermissionsForRoles, parseRoles } from "../authorization-policy.js";
import { ForbiddenError } from "../application-errors.js";
import crypto from "node:crypto";

export const IDENTITY_AUTHORITY_HEADERS = Object.freeze([
  "x-claimguard-user",
  "x-claimguard-role",
  "x-claimguard-user-tenant",
  "x-claimguard-tenant",
]);

function normalizeHeaderValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createAnonymousAuthContext({ source = "anonymous" } = {}) {
  return Object.freeze({
    is_authenticated: false, user_id: null, roles: Object.freeze([]), permissions: new Set(),
    tenant_id: null, organisation_id: null, membership_id: null, source,
  });
}

export function createAuthenticatedAuthContext({
  userId, roles, permissions = null, tenantId, organisationId = null, membershipId = null,
  displayName = null, organisation = null, source = "session",
} = {}) {
  const normalizedRoles = Object.freeze([...(roles || [])]);
  return Object.freeze({
    is_authenticated: true,
    user_id: userId,
    display_name: displayName,
    roles: normalizedRoles,
    permissions: permissions ? new Set(permissions) : getPermissionsForRoles(normalizedRoles),
    tenant_id: tenantId || null,
    organisation_id: organisationId,
    membership_id: membershipId,
    organisation,
    source,
  });
}

export function resolveAuthContextFromHeaders({ request } = {}) {
  const userId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user"));
  const roleHeader = normalizeHeaderValue(request?.headers?.get("x-claimguard-role"));
  const userTenantId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user-tenant"));
  const roles = parseRoles(roleHeader || "");
  if (!userId || !roleHeader || !userTenantId) {
    return createAnonymousAuthContext({ source: userId || roleHeader || userTenantId ? "incomplete_header" : "anonymous" });
  }
  return createAuthenticatedAuthContext({ userId, roles, tenantId: userTenantId, source: "demo_headers" });
}

export function createHeaderAuthenticationProvider() {
  return { mode: "demo_headers", async resolveAuthContext({ request }) { return resolveAuthContextFromHeaders({ request }); } };
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
  "investigations.create": ["investigations.create"],
  "investigations.manage": ["investigations.view", "investigations.update_status", "investigations.add_note", "investigations.change_priority", "investigations.open", "investigations.complete", "investigations.upload_evidence", "investigations.submit_findings"],
  "investigations.confirm": ["investigations.confirm_fraud"],
  "investigations.reverse": ["investigations.confirm_fraud"],
  "registry.search": ["fraud_registry.search", "fraud_registry.view"],
  "registry.review_history": ["fraud_registry.review_history"],
  "scheme_users.manage": ["users.manage_tenant"],
  "scheme_roles.assign": ["users.manage_tenant"],
  "scheme_health.view": ["tenant_status.view"],
  "organisation.manage": ["tenants.manage"],
  "platform_health.view": ["platform_health.view"],
  "simulator.status": ["simulator.status_view"],
  "simulator.control_own": ["simulator.control"],
  "simulator.control_platform": ["simulator.control"],
});

export function operationalPermissions(controlPermissions) {
  return [...new Set((controlPermissions || []).flatMap((permission) => CONTROL_PERMISSION_TO_OPERATIONAL[permission] || []))];
}

function requestMetadata(request, { trustProxy = false } = {}) {
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
      const spoofed = IDENTITY_AUTHORITY_HEADERS.filter((name) => request.headers.has(name));
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
        const expected = configuration.internalServiceToken || "";
        const suppliedBuffer = Buffer.from(supplied);
        const expectedBuffer = Buffer.from(expected);
        const valid = suppliedBuffer.length === expectedBuffer.length && suppliedBuffer.length > 0 && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
        if (!valid) {
          const error = new ForbiddenError("Internal service authentication failed.");
          error.code = "INTERNAL_SERVICE_AUTHENTICATION_FAILED";
          throw error;
        }
        const userId = normalizeHeaderValue(request.headers.get("x-cg-service-actor"));
        const roleHeader = normalizeHeaderValue(request.headers.get("x-cg-service-role"));
        const tenantId = normalizeHeaderValue(request.headers.get("x-cg-service-tenant"));
        const organisationId = normalizeHeaderValue(request.headers.get("x-cg-service-organisation"));
        const roles = parseRoles(roleHeader || "");
        const allowedOrganisations = configuration.internalServiceOrganisationIds || [];
        if (!userId || !tenantId || !organisationId || roles.length === 0 || !allowedOrganisations.includes(organisationId)) {
          const error = new ForbiddenError("Internal service identity is incomplete.");
          error.code = "INTERNAL_SERVICE_IDENTITY_INVALID";
          throw error;
        }
        return {
          authContext: createAuthenticatedAuthContext({ userId, roles, tenantId, organisationId, source: "internal_service" }),
          resolvedSession: null,
          metadata,
        };
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
            tenantId: actor.legacyTenant?.tenantId || null,
            organisationId: actor.organisation.organisationId,
            membershipId: actor.membership.membershipId,
            organisation: actor.organisation,
            source: "session",
          }),
        };
      } catch (error) {
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
