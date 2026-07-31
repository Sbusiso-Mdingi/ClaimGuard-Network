import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInvestigationStatusTransition,
  getActiveTenantId,
  INVESTIGATION_STATUS,
  InvestigationConflictError,
  InvestigationNotFoundError,
} from "@claimguard/database";

import { CLAIMGUARD_ROLES } from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import { createStaticAuthenticationProvider } from "./helpers/authentication-provider.js";
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

const platformOrganisation = Object.freeze({
  organisationId: "org-platform",
  organisationType: "platform",
  displayName: "ClaimGuard Platform",
});

function schemeOrganisation(tenant) {
  return Object.freeze({
    organisationId: `org-${tenant.tenant_slug}`,
    organisationType: "medical_scheme",
    displayName: tenant.tenant_name,
  });
}

function createTenantRepositoryStub() {
  const tenants = new Map([
    [alphaTenant.tenant_id, alphaTenant],
    [betaTenant.tenant_id, betaTenant],
  ]);

  return {
    async lookupTenantById(tenantId) {
      return tenants.get(tenantId) || null;
    },
    async lookupTenantBySlug(tenantSlug) {
      return [...tenants.values()].find((tenant) => tenant.tenant_slug === tenantSlug) || null;
    },
    async lookupTenantBySchemeId(schemeId) {
      return [...tenants.values()].find((tenant) => tenant.scheme_id === schemeId) || null;
    },
    async getDefaultTenant() {
      return alphaTenant;
    },
  };
}

function createActorApp({
  userId,
  role,
  tenant = alphaTenant,
  organisation = schemeOrganisation(tenant),
  ...dependencies
}) {
  return createBackendApp({
    ...dependencies,
    authenticationProvider: createStaticAuthenticationProvider({
      userId,
      roles: [role],
      tenantId: tenant?.tenant_id || null,
      organisationId: organisation.organisationId,
      organisation,
    }),
  });
}

function jsonRequest(body, method = "POST") {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function createInvestigationRepositoryStub({ investigations = [] } = {}) {
  const records = new Map(investigations.map((investigation) => [investigation.investigationId, { ...investigation }]));
  const notes = [];
  const evidence = [];
  let sequence = records.size;

  function findForActiveTenant(investigationId) {
    const investigation = records.get(investigationId);
    return investigation?.tenantId === getActiveTenantId() ? investigation : null;
  }

  function requiredInvestigation(investigationId) {
    const investigation = findForActiveTenant(investigationId);
    if (!investigation) {
      throw new InvestigationNotFoundError();
    }
    return investigation;
  }

  return {
    records,
    notes,
    evidence,
    async createInvestigation({ claimId, assignedInvestigator = null, assignedBy, priority = "NORMAL" }) {
      sequence += 1;
      const timestamp = new Date().toISOString();
      const investigation = {
        investigationId: `investigation-${sequence}`,
        tenantId: getActiveTenantId(),
        claimId,
        assignedInvestigator,
        assignedBy,
        status: INVESTIGATION_STATUS.OPEN,
        priority: priority.trim().toUpperCase(),
        createdAt: timestamp,
        updatedAt: timestamp,
        closedAt: null,
        fraudConfirmedAt: null,
      };
      records.set(investigation.investigationId, investigation);
      return { ...investigation };
    },
    async getInvestigationById(investigationId) {
      const investigation = findForActiveTenant(investigationId);
      return investigation ? { ...investigation } : null;
    },
    async getInvestigationDetails(investigationId) {
      const investigation = findForActiveTenant(investigationId);
      if (!investigation) return null;
      return {
        ...investigation,
        notes: notes.filter((note) => note.investigationId === investigationId).map((note) => ({ ...note })),
        evidence: evidence.filter((item) => item.investigationId === investigationId).map((item) => ({ ...item })),
      };
    },
    async updateInvestigation({ investigationId, status = undefined, priority = undefined }) {
      const investigation = requiredInvestigation(investigationId);
      if (status !== undefined) {
        const nextStatus = status.trim().toUpperCase().replace(/[\s-]+/g, "_");
        assertInvestigationStatusTransition(investigation.status, nextStatus);
        investigation.status = nextStatus;
        if (nextStatus === INVESTIGATION_STATUS.CLOSED) {
          investigation.closedAt = new Date().toISOString();
        }
      }
      if (priority !== undefined) investigation.priority = priority.trim().toUpperCase();
      investigation.updatedAt = new Date().toISOString();
      return { ...investigation };
    },
    async addNote({ investigationId, author, text, noteType = "INTERNAL_NOTE" }) {
      const investigation = requiredInvestigation(investigationId);
      const note = {
        noteId: `note-${notes.length + 1}`,
        investigationId,
        tenantId: investigation.tenantId,
        author,
        text,
        noteType: noteType.trim().toUpperCase().replace(/[\s-]+/g, "_"),
        timestamp: new Date().toISOString(),
      };
      notes.push(note);
      return { ...note };
    },
    async registerEvidence({ investigationId, filename, description = null, uploadedBy, evidenceType }) {
      const investigation = requiredInvestigation(investigationId);
      const item = {
        evidenceId: `evidence-${evidence.length + 1}`,
        investigationId,
        tenantId: investigation.tenantId,
        filename,
        description,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
        evidenceType: evidenceType.trim().toUpperCase().replace(/[\s-]+/g, "_"),
      };
      evidence.push(item);
      return { ...item };
    },
    async markFraudPublished(investigationId) {
      const investigation = requiredInvestigation(investigationId);
      if (investigation.status !== INVESTIGATION_STATUS.CONFIRMED_FRAUD || investigation.fraudConfirmedAt) {
        throw new InvestigationConflictError("This investigation cannot publish a fraud decision.");
      }
      investigation.fraudConfirmedAt = new Date().toISOString();
      return true;
    },
  };
}

function createLifecycleFraudWorkflowStub(investigationRepository) {
  return createFraudWorkflowRepositoryStub({
    async confirm(input, helpers) {
      const investigation = await investigationRepository.getInvestigationById(input.investigationId);
      if (!investigation) {
        throw Object.assign(new Error("The investigation was not found in the active tenant."), {
          code: "investigation_not_found",
          status: 404,
        });
      }
      if (investigation.status !== "CONFIRMED_FRAUD" || investigation.fraudConfirmedAt) {
        throw Object.assign(new Error("Investigation status must be CONFIRMED_FRAUD before fraud can be confirmed."), {
          code: "invalid_confirmation_lifecycle",
          status: 409,
        });
      }
      const ledgerEntry = helpers.entry(
        "INVESTIGATOR_CONFIRMED_FRAUD",
        { ...input, requestedClaimId: investigation.claimId },
        helpers.confirmations.length + helpers.reversals.length,
      );
      return {
        entry: ledgerEntry,
        registryEntry: helpers.registry(input, ledgerEntry, "ACTIVE"),
        replayed: false,
      };
    },
  });
}

test("investigation endpoints create, progress, annotate, and retrieve the lifecycle", async () => {
  const investigationRepository = createInvestigationRepositoryStub();
  const dependencies = {
    investigationRepository,
    tenantRepository: createTenantRepositoryStub(),
  };
  const analystApp = createActorApp({
    userId: "analyst-alpha",
    role: CLAIMGUARD_ROLES.FRAUD_ANALYST,
    ...dependencies,
  });
  const investigatorApp = createActorApp({
    userId: "investigator-alpha",
    role: CLAIMGUARD_ROLES.INVESTIGATOR,
    ...dependencies,
  });

  const createdResponse = await analystApp.request(
    "http://localhost/investigations",
    jsonRequest({
      claimId: "claim-alpha-100",
      assignedInvestigator: "investigator-alpha",
      priority: "critical",
    }),
  );
  const created = await createdResponse.json();
  const investigationId = created.investigation.investigationId;

  assert.equal(createdResponse.status, 201);
  assert.equal(created.investigation.assignedBy, "analyst-alpha");
  assert.equal(created.investigation.status, "OPEN");
  assert.equal(created.investigation.priority, "CRITICAL");

  const statusResponse = await investigatorApp.request(
    `http://localhost/investigations/${investigationId}`,
    jsonRequest({ status: "UNDER_REVIEW" }, "PATCH"),
  );
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).investigation.status, "UNDER_REVIEW");

  const priorityResponse = await analystApp.request(
    `http://localhost/investigations/${investigationId}`,
    jsonRequest({ priority: "high" }, "PATCH"),
  );
  assert.equal(priorityResponse.status, 200);
  assert.equal((await priorityResponse.json()).investigation.priority, "HIGH");

  const noteResponse = await analystApp.request(
    `http://localhost/investigations/${investigationId}/notes`,
    jsonRequest({ text: "Provider review requested.", noteType: "Provider Review" }),
  );
  assert.equal(noteResponse.status, 201);
  assert.equal((await noteResponse.json()).note.noteType, "PROVIDER_REVIEW");

  const evidenceResponse = await investigatorApp.request(
    `http://localhost/investigations/${investigationId}/evidence`,
    jsonRequest({
      filename: "provider-invoice.pdf",
      description: "Invoice used for provider review.",
      evidenceType: "provider invoice",
    }),
  );
  assert.equal(evidenceResponse.status, 201);
  assert.equal((await evidenceResponse.json()).evidence.evidenceType, "PROVIDER_INVOICE");

  const retrievedResponse = await investigatorApp.request(
    `http://localhost/investigations/${investigationId}`,
  );
  const retrieved = await retrievedResponse.json();

  assert.equal(retrievedResponse.status, 200);
  assert.equal(retrieved.investigation.notes.length, 1);
  assert.equal(retrieved.investigation.evidence.length, 1);
});

test("investigation APIs enforce status transitions and investigator or analyst permissions", async () => {
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [
      {
        investigationId: "investigation-authorization",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha-authorization",
        assignedInvestigator: "investigator-alpha",
        assignedBy: "analyst-alpha",
        status: "OPEN",
        priority: "NORMAL",
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:00:00.000Z",
        closedAt: null,
        fraudConfirmedAt: null,
      },
    ],
  });
  const dependencies = {
    investigationRepository,
    tenantRepository: createTenantRepositoryStub(),
  };
  const investigatorApp = createActorApp({ userId: "investigator-alpha", role: CLAIMGUARD_ROLES.INVESTIGATOR, ...dependencies });
  const analystApp = createActorApp({ userId: "analyst-alpha", role: CLAIMGUARD_ROLES.FRAUD_ANALYST, ...dependencies });
  const schemeUserApp = createActorApp({ userId: "scheme-user-alpha", role: CLAIMGUARD_ROLES.SCHEME_USER, ...dependencies });
  const platformApp = createActorApp({
    userId: "platform-admin",
    role: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR,
    tenant: null,
    organisation: platformOrganisation,
    ...dependencies,
  });
  const url = "http://localhost/investigations/investigation-authorization";

  const invalidTransition = await investigatorApp.request(
    url,
    jsonRequest({ status: "CONFIRMED_FRAUD" }, "PATCH"),
  );
  assert.equal(invalidTransition.status, 409);

  const analystStatus = await analystApp.request(
    url,
    jsonRequest({ status: "UNDER_REVIEW" }, "PATCH"),
  );
  assert.equal(analystStatus.status, 403);

  const schemeUserCreate = await schemeUserApp.request(
    "http://localhost/investigations",
    jsonRequest({ claimId: "claim-alpha-authorization" }),
  );
  const schemeUserRead = await schemeUserApp.request(url);
  const schemeUserEvidence = await schemeUserApp.request(
    `${url}/evidence`,
    jsonRequest({ filename: "blocked.pdf", evidenceType: "document" }),
  );

  assert.equal(schemeUserCreate.status, 403);
  assert.equal(schemeUserRead.status, 403);
  assert.equal(schemeUserEvidence.status, 403);

  const platformRead = await platformApp.request(url);
  const platformUpdate = await platformApp.request(
    url,
    jsonRequest({ priority: "LOW" }, "PATCH"),
  );

  assert.equal(platformRead.status, 403);
  assert.equal(platformUpdate.status, 403);
});

test("investigation resources are isolated to the active tenant", async () => {
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [
      {
        investigationId: "investigation-alpha-only",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha-isolated",
        assignedInvestigator: "investigator-alpha",
        assignedBy: "analyst-alpha",
        status: "CONFIRMED_FRAUD",
        priority: "HIGH",
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:10:00.000Z",
        closedAt: null,
        fraudConfirmedAt: null,
      },
    ],
  });
  const fraudWorkflowRepository = createLifecycleFraudWorkflowStub(investigationRepository);
  const betaApp = createActorApp({
    userId: "investigator-beta",
    role: CLAIMGUARD_ROLES.INVESTIGATOR,
    tenant: betaTenant,
    investigationRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const getResponse = await betaApp.request(
    "http://localhost/investigations/investigation-alpha-only",
  );
  const noteResponse = await betaApp.request(
    "http://localhost/investigations/investigation-alpha-only/notes",
    jsonRequest({ text: "Cross-tenant access must fail." }),
  );
  const confirmResponse = await betaApp.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest({
      investigationId: "investigation-alpha-only",
      claimId: "claim-alpha-isolated",
      investigatorId: "investigator-beta",
      reason: "Cross-tenant confirmation must fail.",
    }),
  );

  assert.equal(getResponse.status, 404);
  assert.equal(noteResponse.status, 404);
  assert.equal(confirmResponse.status, 404);
  assert.equal(fraudWorkflowRepository.confirmations.length, 1);
});

test("confirmation requires an existing CONFIRMED_FRAUD investigation and retains the existing response shape", async () => {
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [
      {
        investigationId: "investigation-review",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha-review",
        assignedInvestigator: "investigator-alpha",
        assignedBy: "analyst-alpha",
        status: "UNDER_REVIEW",
        priority: "HIGH",
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:10:00.000Z",
        closedAt: null,
        fraudConfirmedAt: null,
      },
      {
        investigationId: "investigation-confirmed",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha-confirmed",
        assignedInvestigator: "investigator-alpha",
        assignedBy: "analyst-alpha",
        status: "CONFIRMED_FRAUD",
        priority: "CRITICAL",
        createdAt: "2026-07-13T10:00:00.000Z",
        updatedAt: "2026-07-13T10:10:00.000Z",
        closedAt: null,
        fraudConfirmedAt: null,
      },
    ],
  });
  const fraudWorkflowRepository = createLifecycleFraudWorkflowStub(investigationRepository);
  const app = createActorApp({
    userId: "investigator-alpha",
    role: CLAIMGUARD_ROLES.INVESTIGATOR,
    investigationRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const missingResponse = await app.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest({
      investigationId: "missing-investigation",
      claimId: "claim-alpha-missing",
      investigatorId: "investigator-alpha",
      reason: "This investigation does not exist.",
    }),
  );
  const underReviewResponse = await app.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest({
      investigationId: "investigation-review",
      claimId: "claim-alpha-review",
      investigatorId: "investigator-alpha",
      reason: "The investigation must be completed first.",
    }),
  );
  const confirmedResponse = await app.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest({
      investigationId: "investigation-confirmed",
      claimId: "claim-alpha-confirmed",
      investigatorId: "investigator-alpha",
      reason: "The evidence supports a fraud finding.",
      schemeId: alphaTenant.scheme_id,
      reportVersion: "v20260714",
    }),
  );
  const confirmed = await confirmedResponse.json();

  assert.equal(missingResponse.status, 404);
  assert.equal(underReviewResponse.status, 409);
  assert.equal(confirmedResponse.status, 201);
  assert.equal(confirmed.available, true);
  assert.equal(confirmed.entry.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
  assert.equal(confirmed.entry.payload.claimId, "claim-alpha-confirmed");
  assert.equal(confirmed.entry.payload.actor.id, "investigator-alpha");
  assert.equal(fraudWorkflowRepository.confirmations.length, 3);
});
