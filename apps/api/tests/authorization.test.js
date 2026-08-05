import assert from "node:assert/strict";
import test from "node:test";

import { ClaimOwnershipConflictError, getActiveTenantId } from "@claimguard/database";

import { createAuthenticatedAuthContext } from "../src/auth-context.js";
import {
  CLAIMGUARD_PERMISSIONS,
  CLAIMGUARD_ROLES,
  evaluateTenantAccess,
  hasPermission,
} from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import {
  createAnonymousAuthenticationProvider,
  createStaticAuthenticationProvider,
} from "./helpers/authentication-provider.js";
import { createCanonicalDetectionReport } from "./helpers/detection-report.js";
import { createFraudWorkflowRepositoryStub } from "./helpers/fraud-workflow-stub.js";

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

const medicalSchemeOrganisation = Object.freeze({
  organisationId: "org-alpha",
  organisationType: "medical_scheme",
  displayName: "Alpha Medical Scheme",
});

const platformOrganisation = Object.freeze({
  organisationId: "org-platform",
  organisationType: "platform",
  displayName: "ClaimGuard Platform",
});

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

function createActorProvider({
  userId = "user-alpha",
  role,
  roles = role ? [role] : [],
  tenantId = alphaTenant.tenant_id,
  organisation = medicalSchemeOrganisation,
} = {}) {
  return createStaticAuthenticationProvider({
    userId,
    roles,
    tenantId,
    organisationId: organisation.organisationId,
    organisation,
  });
}

function createAppForActor({ actor = null, ...dependencies } = {}) {
  const authenticationProvider = actor
    ? createActorProvider(actor)
    : createAnonymousAuthenticationProvider();
  return createBackendApp({
    ...dependencies,
    authenticationProvider,
  });
}

function jsonRequest(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

test("authenticated contexts support tenant-scoped multi-role identities", () => {
  const authContext = createAuthenticatedAuthContext({
    userId: "user-alpha",
    roles: [CLAIMGUARD_ROLES.SCHEME_USER, CLAIMGUARD_ROLES.INVESTIGATOR],
    tenantId: alphaTenant.tenant_id,
    organisationId: medicalSchemeOrganisation.organisationId,
    organisation: medicalSchemeOrganisation,
    source: "test_provider",
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
  const analyst = createAuthenticatedAuthContext({
    userId: "analyst-alpha",
    roles: [CLAIMGUARD_ROLES.FRAUD_ANALYST],
    tenantId: alphaTenant.tenant_id,
  });
  const schemeUser = createAuthenticatedAuthContext({
    userId: "scheme-user-alpha",
    roles: [CLAIMGUARD_ROLES.SCHEME_USER],
    tenantId: alphaTenant.tenant_id,
  });
  const platformAdmin = createAuthenticatedAuthContext({
    userId: "platform-admin",
    roles: [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR],
    tenantId: null,
    organisationId: platformOrganisation.organisationId,
    organisation: platformOrganisation,
  });

  assert.equal(hasPermission(analyst, CLAIMGUARD_PERMISSIONS.ALERTS_TRIAGE), true);
  assert.equal(hasPermission(analyst, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(schemeUser, CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST), true);
  assert.equal(hasPermission(schemeUser, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(platformAdmin, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(hasPermission(platformAdmin, CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE), true);
  assert.equal(hasPermission(platformAdmin, CLAIMGUARD_PERMISSIONS.DESKTOP_FLEET_POLICY_MANAGE), true);
  const schemeAdministrator = createAuthenticatedAuthContext({
    userId: "scheme-admin",
    roles: [CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR],
    tenantId: alphaTenant.tenant_id,
    organisationId: medicalSchemeOrganisation.organisationId,
    organisation: medicalSchemeOrganisation,
  });
  assert.equal(hasPermission(schemeAdministrator, CLAIMGUARD_PERMISSIONS.DESKTOP_DEVICES_MANAGE), true);
  assert.equal(hasPermission(schemeAdministrator, CLAIMGUARD_PERMISSIONS.DESKTOP_FLEET_POLICY_MANAGE), false);
});

test("tenant access denies cross-tenant resources and gives platform administrators no bypass", () => {
  const schemeUser = createAuthenticatedAuthContext({
    userId: "scheme-user-alpha",
    roles: [CLAIMGUARD_ROLES.SCHEME_USER],
    tenantId: alphaTenant.tenant_id,
    organisation: medicalSchemeOrganisation,
  });
  const platformAdmin = createAuthenticatedAuthContext({
    userId: "platform-admin",
    roles: [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR],
    tenantId: null,
    organisationId: platformOrganisation.organisationId,
    organisation: platformOrganisation,
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
    tenantContext: { tenant_id: null, tenant_slug: null, scheme_id: null },
    resourceTenantIds: [betaTenant.tenant_id],
    resourceSchemeIds: [betaTenant.scheme_id],
  });

  assert.equal(sameTenant.allowed, true);
  assert.equal(crossTenant.allowed, false);
  assert.equal(crossTenant.reason, "resource_tenant_mismatch");
  assert.equal(platformBypass.allowed, false);
  assert.equal(platformBypass.bypass, false);
});

test("supported legacy confirmation is blocked for every authenticated role", async () => {
  const fraudWorkflowRepository = createFraudWorkflowRepositoryStub();
  const investigationRepository = createConfirmedInvestigationRepositoryStub();
  const tenantRepository = createTenantRepositoryStub();
  const dependencies = { fraudWorkflowRepository, investigationRepository, tenantRepository };

  async function confirmAs(role, actor = {}) {
    const app = createAppForActor({ actor: { role, ...actor }, ...dependencies });
    const response = await app.request(
      "http://localhost/investigations/confirm-fraud",
      jsonRequest(confirmationPayload()),
    );
    return { response, body: await response.json() };
  }

  const investigator = await confirmAs(CLAIMGUARD_ROLES.INVESTIGATOR);
  const analyst = await confirmAs(CLAIMGUARD_ROLES.FRAUD_ANALYST);
  const schemeUser = await confirmAs(CLAIMGUARD_ROLES.SCHEME_USER);
  const platformAdmin = await confirmAs(CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR, {
    userId: "platform-admin",
    tenantId: null,
    organisation: platformOrganisation,
  });

  for (const result of [investigator, analyst, schemeUser, platformAdmin]) {
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, "LEGACY_FRAUD_CONFIRMATION_DISABLED");
  }
  assert.equal(fraudWorkflowRepository.confirmations.length, 0);
});

test("legacy confirmation rejects after trusted authentication while foreign claim ingestion remains tenant-blocked", async () => {
  const fraudWorkflowRepository = createFraudWorkflowRepositoryStub();
  const investigationRepository = createConfirmedInvestigationRepositoryStub();
  const tenantRepository = createTenantRepositoryStub();
  const ingestedClaims = [];
  const claimIngestionService = {
    async ingestClaims({ claims }) {
      ingestedClaims.push(...claims);
      return {
        received: claims.length,
        inserted: claims.length,
        updated: 0,
        source: "api",
      };
    },
  };

  const confirmationApp = createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.INVESTIGATOR },
    fraudWorkflowRepository,
    investigationRepository,
    tenantRepository,
    claimIngestionService,
  });
  const ingestionApp = createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.SCHEME_USER },
    fraudWorkflowRepository,
    investigationRepository,
    tenantRepository,
    claimIngestionService,
  });

  const confirmationResponse = await confirmationApp.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest(confirmationPayload({ schemeId: betaTenant.scheme_id })),
  );
  const confirmationBody = await confirmationResponse.json();
  const ingestionResponse = await ingestionApp.request(
    "http://localhost/claims/ingest",
    jsonRequest({
      claims: [
        {
          claim_id: "claim-beta-100",
          scheme_id: betaTenant.scheme_id,
          member_id: "member-beta",
          provider_id: "provider-beta",
          service_date: "2026-07-13",
          ...modelClaimFields("2026-07-13"),
          billing_code: "CONSULT",
          amount: 299.99,
        },
      ],
    }),
  );

  assert.equal(confirmationResponse.status, 409);
  assert.equal(confirmationBody.code, "LEGACY_FRAUD_CONFIRMATION_DISABLED");
  assert.equal(ingestionResponse.status, 403);
  assert.equal(fraudWorkflowRepository.confirmations.length, 0);
  assert.deepEqual(ingestedClaims, []);
});

test("an explicit authentication provider reaches the stable legacy governance boundary", async () => {
  const fraudWorkflowRepository = createFraudWorkflowRepositoryStub();
  const app = createBackendApp({
    authenticationProvider: createStaticAuthenticationProvider({
      userId: "future-entra-user",
      roles: [CLAIMGUARD_ROLES.INVESTIGATOR],
      permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD],
      tenantId: "tenant_default",
    }),
    fraudWorkflowRepository,
    investigationRepository: createConfirmedInvestigationRepositoryStub({ tenantId: "tenant_default" }),
  });

  const response = await app.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest(confirmationPayload()),
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, "LEGACY_FRAUD_CONFIRMATION_DISABLED");
  assert.notEqual(response.status, 401);
  assert.notEqual(response.status, 403);
  assert.equal(fraudWorkflowRepository.confirmations.length, 0);
});

test("detection routes require authentication and report permission", async () => {
  const observedStorageTenants = [];
  const tenantRepository = createTenantRepositoryStub();
  const reportStorage = {
    async getLatestReport({ tenantContext }) {
      observedStorageTenants.push(tenantContext.tenant_id);
      return {
        report: createCanonicalDetectionReport({ tenantId: tenantContext.tenant_id, riskScore: 33, severity: "Low" }),
        metadata: { tenant: tenantContext.tenant_id, version: "v1" },
      };
    },
  };

  const unauthenticated = await createAppForActor({ tenantRepository, reportStorage })
    .request("http://localhost/detection/report");
  const insufficient = await createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.APPLICATIONS_COMMITTEE_MEMBER },
    tenantRepository,
    reportStorage,
  }).request("http://localhost/detection/report");
  const permitted = await createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.SCHEME_USER },
    tenantRepository,
    reportStorage,
  }).request("http://localhost/detection/report");
  const permittedBody = await permitted.json();

  assert.equal(unauthenticated.status, 401);
  assert.equal(insufficient.status, 403);
  assert.equal(permitted.status, 200);
  assert.equal(permittedBody.report.metadata.tenant.tenantId, alphaTenant.tenant_id);
  assert.deepEqual(observedStorageTenants, [alphaTenant.tenant_id]);
});

test("ledger routes require authorization and propagate the canonical tenant", async () => {
  const observedLedgerTenants = [];
  const tenantRepository = createTenantRepositoryStub();
  const ledgerRepository = {
    async getLatestEntry() {
      observedLedgerTenants.push(getActiveTenantId());
      return { sequenceNumber: 1, tenantId: getActiveTenantId() };
    },
  };

  const unauthenticated = await createAppForActor({ tenantRepository, ledgerRepository })
    .request("http://localhost/ledger/latest");
  const insufficient = await createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.SCHEME_USER },
    tenantRepository,
    ledgerRepository,
  }).request("http://localhost/ledger/latest");
  const permitted = await createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.INVESTIGATOR },
    tenantRepository,
    ledgerRepository,
  }).request("http://localhost/ledger/latest");
  const permittedBody = await permitted.json();

  assert.equal(unauthenticated.status, 401);
  assert.equal(insufficient.status, 403);
  assert.equal(permitted.status, 200);
  assert.equal(permittedBody.entry.tenantId, alphaTenant.tenant_id);
  assert.deepEqual(observedLedgerTenants, [alphaTenant.tenant_id]);
});

test("cross-tenant claim ownership conflict returns 409 and queues only the owned tenant", async () => {
  const claims = new Map();
  const outboxTenants = [];
  const tenantRepository = createTenantRepositoryStub();
  const claimIngestionService = {
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
  };

  const claim = {
    claim_id: "C1",
    scheme_id: alphaTenant.scheme_id,
    member_id: "member-1",
    provider_id: "provider-1",
    service_date: "2026-07-16",
    ...modelClaimFields("2026-07-16"),
    billing_code: "CONSULT",
    amount: 100,
  };
  const alphaApp = createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.SCHEME_USER },
    tenantRepository,
    claimIngestionService,
  });
  const betaApp = createAppForActor({
    actor: {
      userId: "user-beta",
      role: CLAIMGUARD_ROLES.SCHEME_USER,
      tenantId: betaTenant.tenant_id,
      organisation: { ...medicalSchemeOrganisation, organisationId: "org-beta", displayName: "Beta Medical Scheme" },
    },
    tenantRepository,
    claimIngestionService,
  });

  const alphaResponse = await alphaApp.request(
    "http://localhost/claims/ingest",
    jsonRequest({ claims: [claim] }),
  );
  const betaResponse = await betaApp.request(
    "http://localhost/claims/ingest",
    jsonRequest({
      claims: [{ ...claim, scheme_id: betaTenant.scheme_id, amount: 999 }],
    }),
  );
  const betaBody = await betaResponse.json();

  assert.equal(alphaResponse.status, 202);
  assert.equal(betaResponse.status, 409);
  assert.equal(betaBody.code, "CLAIM_OWNERSHIP_CONFLICT");
  assert.deepEqual(claims.get("C1"), { tenantId: alphaTenant.tenant_id, amount: 100 });
  assert.deepEqual(outboxTenants, [alphaTenant.tenant_id]);
});

test("claims read routes require claims.view_own and enforce canonical tenant context", async () => {
  const observed = [];
  const tenantRepository = createTenantRepositoryStub();
  const claimReadRepository = {
    async listClaims() {
      observed.push(getActiveTenantId());
      return {
        claims: [{ claimId: "ALPHA-CLAIM-1", memberId: "member-1", status: "SUBMITTED", updatedAt: "2026-07-16T00:00:00.000Z" }],
        pagination: {
          page: 1,
          pageSize: 25,
          requestedPageSize: 25,
          maxPageSize: 100,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      };
    },
    async getClaimById(claimId) {
      observed.push(getActiveTenantId());
      if (claimId === "ALPHA-CLAIM-1") {
        return { claimId, memberId: "member-1", status: "SUBMITTED", updatedAt: "2026-07-16T00:00:00.000Z" };
      }
      return null;
    },
  };
  const dependencies = { tenantRepository, claimReadRepository };

  const unauthenticated = await createAppForActor(dependencies)
    .request("http://localhost/claims");
  const investigator = await createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.INVESTIGATOR },
    ...dependencies,
  }).request("http://localhost/claims");
  const platform = await createAppForActor({
    actor: {
      userId: "platform-admin",
      role: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR,
      tenantId: null,
      organisation: platformOrganisation,
    },
    ...dependencies,
  }).request("http://localhost/claims");
  const schemeUserApp = createAppForActor({
    actor: { role: CLAIMGUARD_ROLES.SCHEME_USER },
    ...dependencies,
  });
  const permitted = await schemeUserApp.request("http://localhost/claims");
  const permittedDetail = await schemeUserApp.request("http://localhost/claims/ALPHA-CLAIM-1");
  const missingDetail = await schemeUserApp.request("http://localhost/claims/BETA-CLAIM-1");

  assert.equal(unauthenticated.status, 401);
  assert.equal(investigator.status, 200);
  assert.equal(platform.status, 403);
  assert.equal(permitted.status, 200);
  assert.equal(permittedDetail.status, 200);
  assert.equal(missingDetail.status, 404);
  assert.deepEqual(observed, [
    alphaTenant.tenant_id,
    alphaTenant.tenant_id,
    alphaTenant.tenant_id,
    alphaTenant.tenant_id,
  ]);
});

function modelClaimFields(serviceDate) {
  return {
    received_date: serviceDate,
    quantity: 1,
    benefit_option: "COMPREHENSIVE",
    network_type: "IN_NETWORK",
    line_type: "PROFESSIONAL",
    tariff_discipline: "MEDICAL",
    diagnosis_code: "Z00.0",
    rendering_practitioner_id: null,
    rendering_practitioner_category: "NONE",
    rendering_known_to_billing_provider: false,
  };
}
