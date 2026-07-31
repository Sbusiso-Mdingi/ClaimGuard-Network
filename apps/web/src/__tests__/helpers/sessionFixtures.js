import { vi } from "vitest";

const MEDICAL_SCHEME = Object.freeze({
  organisationId: "org-bonitas",
  displayName: "Bonitas",
  canonicalSlug: "bonitas",
  organisationType: "medical_scheme",
  deploymentClass: "production",
});

const PLATFORM = Object.freeze({
  organisationId: "org-platform",
  displayName: "ClaimGuard Platform",
  canonicalSlug: "platform",
  organisationType: "platform",
  deploymentClass: "production",
});

const OPERATIONAL_TENANT = Object.freeze({
  tenantId: "tenant_alpha",
  tenantSlug: "bonitas",
});

function session({ userId, displayName, role, capabilities, organisation = MEDICAL_SCHEME, operationalTenant = OPERATIONAL_TENANT }) {
  return Object.freeze({
    authenticated: true,
    user: Object.freeze({ userId, displayName }),
    organisation,
    operationalTenant,
    roles: Object.freeze([role]),
    clientCapabilities: Object.freeze([...capabilities]),
    expires: Object.freeze({ idleAt: "2026-08-01T09:00:00Z", absoluteAt: "2026-08-01T16:00:00Z" }),
    deployment: Object.freeze({ class: "production", demo: false }),
  });
}

export const SESSION_FIXTURES = Object.freeze({
  analyst: session({
    userId: "analyst-alpha",
    displayName: "Fraud Analyst",
    role: "fraud_analyst",
    capabilities: [
      "claims.view_own", "reports.view_own", "investigations.create", "investigations.view",
      "investigations.add_note", "investigations.change_priority", "fraud_registry.search",
      "fraud_registry.view", "fraud_registry.review_history",
    ],
  }),
  investigator: session({
    userId: "investigator-alpha",
    displayName: "Fraud Investigator",
    role: "investigator",
    capabilities: [
      "claims.view_own", "reports.view_own", "investigations.create", "investigations.view",
      "investigations.update_status", "investigations.add_note", "investigations.open",
      "investigations.complete", "investigations.upload_evidence", "investigations.submit_findings",
      "investigations.confirm_fraud", "investigations.reverse_fraud", "fraud_registry.search",
      "fraud_registry.view", "fraud_registry.review_history",
    ],
  }),
  committee: session({
    userId: "committee-alpha",
    displayName: "Applications Committee Member",
    role: "applications_committee_member",
    capabilities: ["fraud_registry.search", "fraud_registry.view", "fraud_registry.review_history"],
  }),
  schemeAdministrator: session({
    userId: "scheme-admin-alpha",
    displayName: "Scheme Administrator",
    role: "scheme_administrator",
    capabilities: [
      "claims.view_own", "reports.view_own", "investigations.view", "users.manage_tenant", "tenant_status.view",
    ],
  }),
  platformAdministrator: session({
    userId: "platform-admin",
    displayName: "Platform Administrator",
    role: "platform_administrator",
    capabilities: [
      "tenants.manage", "platform_health.view", "telemetry.view", "platform_releases.view",
      "platform_releases.request", "platform_releases.approve", "platform_administrators.manage",
    ],
    organisation: PLATFORM,
    operationalTenant: null,
  }),
});

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => payload });
}

export function createSessionFetch(activeSession, routeHandler = null) {
  return vi.fn((url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/api/auth/session")) return jsonResponse(activeSession);
    if (requestUrl.endsWith("/api/auth/csrf")) return jsonResponse({ csrfToken: "csrf-session-fixture" });
    if (routeHandler) return routeHandler(requestUrl, options);
    return jsonResponse({ message: "Not found." }, { ok: false, status: 404 });
  });
}
