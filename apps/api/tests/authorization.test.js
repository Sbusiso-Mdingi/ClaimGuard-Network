import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthContextFromHeaders } from "../src/auth-context.js";
import {
  CLAIMGUARD_PERMISSIONS,
  CLAIMGUARD_ROLES,
  evaluateTenantAccess,
  hasPermission,
} from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import { ClaimOwnershipConflictError, getActiveTenantId } from "@claimguard/database";

const alphaTenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
  tenant_name: "Alpha Medical Scheme",
  scheme_id: "scheme_alpha",
  status: "active",
};

const betaTenant = {
  tenant_id: "tenant_beta",
  tenant_slug: "beta",
  tenant_name: "Beta Medical Scheme",
  scheme_id: "scheme_beta",
  status: "active",
};

function createTenantRepositoryStub() {
  const tenants = new Map([
    [alphaTenant.tenant_id, alphaTenant],
    [betaTenant.tenant_id, betaTenant],
  ]);
  const tenantsByScheme = new Map([
    [alphaTenant.scheme_id, alphaTenant],
    [betaTenant.scheme_id, betaTenant],
  ]);

  return {
    async lookupTenantById(tenantId) {
      return tenants.get(tenantId) || null;
    },
    async lookupTenantBySlug(tenantSlug) {
      return [...tenants.values()].find((tenant) => tenant.tenant_slug === tenantSlug) || null;
    },
    async lookupTenantBySchemeId(schemeId) {
      return tenantsByScheme.get(schemeId) || null;
    },
    async getDefaultTenant() {
      return alphaTenant;
    },
  };
}

function authHeaders({
  user = "user-alpha",
  role,
  tenantId = alphaTenant.tenant_id,
  requestTenantId = alphaTenant.tenant_id,
} = {}) {
  return {
    "content-type": "application/json",
    "x-claimguard-user": user,
    "x-claimguard-role": role,
    "x-claimguard-user-tenant": tenantId,
    "x-claimguard-tenant": requestTenantId,
  };
}

function createLedgerRepositoryStub() {
  const writes = [];

  return {
    writes,
    async createConfirmedFraudEntry(payload) {
      writes.push(payload);
      return {
        sequenceNumber: writes.length,
        entryType: "INVESTIGATOR_CONFIRMED_FRAUD",
        previousHash: "a".repeat(64),
        entryHash: "b".repeat(64),
        payload,
      };
    },
  };
}

function createConfirmedInvestigationRepositoryStub({ tenantId = alphaTenant.tenant_id } = {}) {
  let fraudPublished = false;

  return {
    async getInvestigationById(investigationId) {
      if (investigationId !== "investigation-100") {
        return null;
      }

      return {
        investigationId,
        tenantId,
        claimId: "claim-100",
        assignedInvestigator: "investigator-alpha",
        assignedBy: "analyst-alpha",
        status: "CONFIRMED_FRAUD",
        priority: "HIGH",
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:10:00.000Z",
        closedAt: null,
        fraudConfirmedAt: fraudPublished ? "2026-07-13T10:15:00.000Z" : null,
      };
    },
    async markFraudPublished(investigationId) {
      assert.equal(investigationId, "investigation-100");
      fraudPublished = true;
      return true;
    },
  };
}

function confirmationPayload({ schemeId = alphaTenant.scheme_id } = {}) {
  return {
    investigationId: "investigation-100",
    claimId: "claim-100",
    investigatorId: "investigator-alpha",
    reason: "Evidence confirmed the claim was fraudulent.",
    schemeId,
  };
}

test("header authentication resolves a tenant-scoped multi-role identity", () => {
  const request = new Request("http://localhost/claims/ingest", {
    headers: {
      "x-claimguard-user": "user-alpha",
      "x-claimguard-role": "Scheme User, Investigator",
      "x-claimguard-user-tenant": alphaTenant.tenant_id,
    },
  });

  const authContext = resolveAuthContextFromHeaders({
    request,
    tenantContext: betaTenant,
  });

  assert.equal(authContext.is_authenticated, true);
  assert.equal(authContext.user_id, "user-alpha");
  assert.equal(authContext.tenant_id, alphaTenant.tenant_id);
  assert.deepEqual(authContext.roles, [
    CLAIMGUARD_ROLES.SCHEME_USER,
    CLAIMGUARD_ROLES.INVESTIGATOR,
  ]);
  assert.equal(hasPermission(authContext, CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST), true);
  assert.equal(hasPermission(authContext, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), true);
});

test("permission evaluation grants only the capabilities assigned to each role", () => {
  const analyst = resolveAuthContextFromHeaders({
    request: new Request("http://localhost", {
      headers: {
        "x-claimguard-user": "analyst-alpha",
        "x-claimguard-role": "fraud analyst",
        "x-claimguard-user-tenant": alphaTenant.tenant_id,
      },
    }),
    tenantContext: alphaTenant,
  });
  const schemeUser = resolveAuthContextFromHeaders({
    request: new Request("http://localhost", {
      headers: {
        "x-claimguard-user": "scheme-user-alpha",
        "x-claimguard-role": "scheme_user",
        "x-claimguard-user-tenant": alphaTenant.tenant_id,
      },
    }),
    tenantContext: alphaTenant,
  });
  const platformAdmin = resolveAuthContextFromHeaders({
    request: new Request("http://localhost", {
      headers: {
        "x-claimguard-user": "platform-admin",
        "x-claimguard-role": "platform administrator",
        "x-claimguard-user-tenant": alphaTenant.tenant_id,
      },
    }),
    tenantContext: alphaTenant,
  });

  assert.equal(hasPermission(analyst, CLAIMGUARD_PERMISSIONS.ALERTS_TRIAGE), true);
  assert.equal(hasPermission(analyst, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(schemeUser, CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST), true);
  assert.equal(hasPermission(schemeUser, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(platformAdmin, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(platformAdmin, CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE), true);
});

test("tenant access denies cross-tenant resources and permits a platform administrator bypass", () => {
  const schemeUser = resolveAuthContextFromHeaders({
    request: new Request("http://localhost", {
      headers: {
        "x-claimguard-user": "scheme-user-alpha",
        "x-claimguard-role": "scheme user",
        "x-claimguard-user-tenant": alphaTenant.tenant_id,
      },
    }),
    tenantContext: alphaTenant,
  });
  const platformAdmin = resolveAuthContextFromHeaders({
    request: new Request("http://localhost", {
      headers: {
        "x-claimguard-user": "platform-admin",
        "x-claimguard-role": "platform_administrator",
        "x-claimguard-user-tenant": alphaTenant.tenant_id,
      },
    }),
    tenantContext: alphaTenant,
  });

  const sameTenant = evaluateTenantAccess({
    authContext: schemeUser,
    tenantContext: alphaTenant,
    resourceTenantIds: [alphaTenant.tenant_id],
    resourceSchemeIds: [alphaTenant.scheme_id],
  });
  const crossTenant = evaluateTenantAccess({
    authContext: schemeUser,
    tenantContext: alphaTenant,
    resourceTenantIds: [betaTenant.tenant_id],
    resourceSchemeIds: [betaTenant.scheme_id],
  });
  const platformBypass = evaluateTenantAccess({
    authContext: platformAdmin,
    tenantContext: alphaTenant,
    resourceTenantIds: [betaTenant.tenant_id],
    resourceSchemeIds: [betaTenant.scheme_id],
  });

  assert.equal(sameTenant.allowed, true);
  assert.equal(crossTenant.allowed, false);
  assert.equal(crossTenant.reason, "resource_tenant_mismatch");
  assert.equal(platformBypass.allowed, true);
  assert.equal(platformBypass.bypass, true);
});

test("only investigators can confirm fraud for their tenant", async () => {
  const ledgerRepository = createLedgerRepositoryStub();
  const app = createBackendApp({
    ledgerRepository,
    investigationRepository: createConfirmedInvestigationRepositoryStub(),
    tenantRepository: createTenantRepositoryStub(),
  });

  const investigatorResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ role: "investigator" }),
    body: JSON.stringify(confirmationPayload()),
  });
  const analystResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ role: "fraud_analyst" }),
    body: JSON.stringify(confirmationPayload()),
  });
  const schemeUserResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ role: "scheme_user" }),
    body: JSON.stringify(confirmationPayload()),
  });
  const platformAdminResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ role: "platform_administrator" }),
    body: JSON.stringify(confirmationPayload()),
  });

  assert.equal(investigatorResponse.status, 201);
  assert.equal(analystResponse.status, 403);
  assert.equal(schemeUserResponse.status, 403);
  assert.equal(platformAdminResponse.status, 403);
  assert.equal(ledgerRepository.writes.length, 1);
});

test("tenant-scoped confirmation and claim ingestion reject a foreign scheme", async () => {
  const ledgerRepository = createLedgerRepositoryStub();
  const ingestedClaims = [];
  const app = createBackendApp({
    ledgerRepository,
    investigationRepository: createConfirmedInvestigationRepositoryStub(),
    tenantRepository: createTenantRepositoryStub(),
    claimIngestionService: {
      async ingestClaims({ claims }) {
        ingestedClaims.push(...claims);
        return {
          received: claims.length,
          inserted: claims.length,
          updated: 0,
          source: "api",
        };
      },
    },
  });

  const confirmationResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ role: "investigator" }),
    body: JSON.stringify(confirmationPayload({ schemeId: betaTenant.scheme_id })),
  });
  const ingestionResponse = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: authHeaders({ role: "scheme_user" }),
    body: JSON.stringify({
      claims: [
        {
          claim_id: "claim-beta-100",
          scheme_id: betaTenant.scheme_id,
          member_id: "member-beta",
          provider_id: "provider-beta",
          service_date: "2026-07-13",
          billing_code: "CONSULT",
          amount: 299.99,
        },
      ],
    }),
  });

  assert.equal(confirmationResponse.status, 403);
  assert.equal(ingestionResponse.status, 403);
  assert.equal(ledgerRepository.writes.length, 0);
  assert.deepEqual(ingestedClaims, []);
});

test("the pluggable authentication provider can replace development headers", async () => {
  const app = createBackendApp({
    authenticationProvider: {
      async resolveAuthContext() {
        return {
          is_authenticated: true,
          user_id: "future-entra-user",
          roles: [CLAIMGUARD_ROLES.INVESTIGATOR],
          permissions: new Set([CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD]),
          tenant_id: "tenant_default",
          source: "test-provider",
        };
      },
    },
    ledgerRepository: createLedgerRepositoryStub(),
    investigationRepository: createConfirmedInvestigationRepositoryStub({ tenantId: "tenant_default" }),
  });

  const response = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmationPayload()),
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).entry.payload.claimId, "claim-100");
});

test("detection routes require authentication, tenant match, and report permission", async () => {
  const observedStorageTenants = [];
  const app = createBackendApp({
    tenantRepository: createTenantRepositoryStub(),
    reportStorage: {
      async getLatestReport({ tenantContext }) {
        observedStorageTenants.push(tenantContext.tenant_id);
        return {
          report: {
            tenantId: tenantContext.tenant_id,
            detection: {
              risk_score: { riskScore: 33, severity: "Low", reasons: [] },
              graph_summary: { entity_count: 0, relationship_count: 0 },
            },
          },
          metadata: { tenant: tenantContext.tenant_id, version: "v1" },
        };
      },
    },
  });

  const unauthenticated = await app.request("http://localhost/detection/report");
  const contradictory = await app.request("http://localhost/detection/report", {
    headers: authHeaders({ role: "scheme_user", requestTenantId: betaTenant.tenant_id }),
  });
  const insufficient = await app.request("http://localhost/detection/report", {
    headers: authHeaders({ role: "scheme_administrator" }),
  });
  const permitted = await app.request("http://localhost/detection/report", {
    headers: authHeaders({ role: "scheme_user" }),
  });
  const permittedBody = await permitted.json();

  assert.equal(unauthenticated.status, 401);
  assert.equal(contradictory.status, 403);
  assert.equal(insufficient.status, 403);
  assert.equal(permitted.status, 200);
  assert.equal(permittedBody.report.tenantId, alphaTenant.tenant_id);
  assert.deepEqual(observedStorageTenants, [alphaTenant.tenant_id]);
});

test("ledger routes require authorization and propagate the canonical tenant", async () => {
  const observedLedgerTenants = [];
  const app = createBackendApp({
    tenantRepository: createTenantRepositoryStub(),
    ledgerRepository: {
      async getLatestEntry() {
        observedLedgerTenants.push(getActiveTenantId());
        return { sequenceNumber: 1, tenantId: getActiveTenantId() };
      },
    },
  });

  const unauthenticated = await app.request("http://localhost/ledger/latest");
  const contradictory = await app.request("http://localhost/ledger/latest", {
    headers: authHeaders({ role: "investigator", requestTenantId: betaTenant.tenant_id }),
  });
  const insufficient = await app.request("http://localhost/ledger/latest", {
    headers: authHeaders({ role: "scheme_user" }),
  });
  const permitted = await app.request("http://localhost/ledger/latest", {
    headers: authHeaders({ role: "investigator" }),
  });
  const permittedBody = await permitted.json();

  assert.equal(unauthenticated.status, 401);
  assert.equal(contradictory.status, 403);
  assert.equal(insufficient.status, 403);
  assert.equal(permitted.status, 200);
  assert.equal(permittedBody.entry.tenantId, alphaTenant.tenant_id);
  assert.deepEqual(observedLedgerTenants, [alphaTenant.tenant_id]);
});

test("cross-tenant claim ownership conflict returns 409 and API never invokes legacy production", async () => {
  const claims = new Map();
  const outboxTenants = [];
  let producerTriggerCount = 0;
  const app = createBackendApp({
    tenantRepository: createTenantRepositoryStub(),
    claimIngestionService: {
      async ingestClaims({ claims: incomingClaims, source }) {
        for (const claim of incomingClaims) {
          const existing = claims.get(claim.claim_id);
          const activeTenantId = getActiveTenantId();
          if (existing && existing.tenantId !== activeTenantId) {
            throw new ClaimOwnershipConflictError();
          }
          claims.set(claim.claim_id, { tenantId: activeTenantId, amount: claim.amount });
          outboxTenants.push(activeTenantId);
        }
        return {
          received: incomingClaims.length,
          inserted: 1,
          updated: 0,
          source,
          processing: {
            status: "queued",
            asynchronous: true,
            jobId: "job-alpha",
            correlationId: "request-alpha",
            reused: false,
          },
        };
      },
    },
    producerRuntimeTrigger: {
      async triggerAfterIngestion() {
        producerTriggerCount += 1;
      },
    },
  });

  const claim = {
    claim_id: "C1",
    scheme_id: alphaTenant.scheme_id,
    member_id: "member-1",
    provider_id: "provider-1",
    service_date: "2026-07-16",
    billing_code: "CONSULT",
    amount: 100,
  };
  const alphaResponse = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: authHeaders({ role: "scheme_user" }),
    body: JSON.stringify({ claims: [claim] }),
  });
  const betaResponse = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: authHeaders({
      user: "user-beta",
      role: "scheme_user",
      tenantId: betaTenant.tenant_id,
      requestTenantId: betaTenant.tenant_id,
    }),
    body: JSON.stringify({
      claims: [{ ...claim, scheme_id: betaTenant.scheme_id, amount: 999 }],
    }),
  });
  const betaBody = await betaResponse.json();

  assert.equal(alphaResponse.status, 202);
  assert.equal(betaResponse.status, 409);
  assert.equal(betaBody.code, "CLAIM_OWNERSHIP_CONFLICT");
  assert.deepEqual(claims.get("C1"), { tenantId: alphaTenant.tenant_id, amount: 100 });
  assert.deepEqual(outboxTenants, [alphaTenant.tenant_id]);
  assert.equal(producerTriggerCount, 0);
});
