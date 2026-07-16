import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInvestigationStatusTransition,
  getActiveTenantId,
  INVESTIGATION_STATUS,
  InvestigationConflictError,
  InvestigationNotFoundError,
} from "@claimguard/database";

import { createBackendApp } from "../src/backend.js";
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

function authHeaders({
  user = "user-alpha",
  role,
  tenantId = alphaTenant.tenant_id,
  requestTenantId = tenantId,
} = {}) {
  return {
    "content-type": "application/json",
    "x-claimguard-user": user,
    "x-claimguard-role": role,
    "x-claimguard-user-tenant": tenantId,
    "x-claimguard-tenant": requestTenantId,
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
      if (!investigation) {
        return null;
      }

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
      if (priority !== undefined) {
        investigation.priority = priority.trim().toUpperCase();
      }
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
  const app = createBackendApp({
    investigationRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const createdResponse = await app.request("http://localhost/investigations", {
    method: "POST",
    headers: authHeaders({ user: "analyst-alpha", role: "fraud_analyst" }),
    body: JSON.stringify({
      claimId: "claim-alpha-100",
      assignedInvestigator: "investigator-alpha",
      priority: "critical",
    }),
  });
  const created = await createdResponse.json();
  const investigationId = created.investigation.investigationId;

  assert.equal(createdResponse.status, 201);
  assert.equal(created.investigation.assignedBy, "analyst-alpha");
  assert.equal(created.investigation.status, "OPEN");
  assert.equal(created.investigation.priority, "CRITICAL");

  const statusResponse = await app.request(`http://localhost/investigations/${investigationId}`, {
    method: "PATCH",
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).investigation.status, "UNDER_REVIEW");

  const priorityResponse = await app.request(`http://localhost/investigations/${investigationId}`, {
    method: "PATCH",
    headers: authHeaders({ user: "analyst-alpha", role: "fraud_analyst" }),
    body: JSON.stringify({ priority: "high" }),
  });
  assert.equal(priorityResponse.status, 200);
  assert.equal((await priorityResponse.json()).investigation.priority, "HIGH");

  const noteResponse = await app.request(`http://localhost/investigations/${investigationId}/notes`, {
    method: "POST",
    headers: authHeaders({ user: "analyst-alpha", role: "fraud_analyst" }),
    body: JSON.stringify({ text: "Provider review requested.", noteType: "Provider Review" }),
  });
  assert.equal(noteResponse.status, 201);
  assert.equal((await noteResponse.json()).note.noteType, "PROVIDER_REVIEW");

  const evidenceResponse = await app.request(`http://localhost/investigations/${investigationId}/evidence`, {
    method: "POST",
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
    body: JSON.stringify({
      filename: "provider-invoice.pdf",
      description: "Invoice used for provider review.",
      evidenceType: "provider invoice",
    }),
  });
  assert.equal(evidenceResponse.status, 201);
  assert.equal((await evidenceResponse.json()).evidence.evidenceType, "PROVIDER_INVOICE");

  const retrievedResponse = await app.request(`http://localhost/investigations/${investigationId}`, {
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
  });
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
  const app = createBackendApp({
    investigationRepository,
    tenantRepository: createTenantRepositoryStub(),
  });
  const url = "http://localhost/investigations/investigation-authorization";

  const invalidTransition = await app.request(url, {
    method: "PATCH",
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
    body: JSON.stringify({ status: "CONFIRMED_FRAUD" }),
  });
  assert.equal(invalidTransition.status, 409);

  const analystStatus = await app.request(url, {
    method: "PATCH",
    headers: authHeaders({ user: "analyst-alpha", role: "fraud_analyst" }),
    body: JSON.stringify({ status: "UNDER_REVIEW" }),
  });
  assert.equal(analystStatus.status, 403);

  const schemeUserCreate = await app.request("http://localhost/investigations", {
    method: "POST",
    headers: authHeaders({ user: "scheme-user-alpha", role: "scheme_user" }),
    body: JSON.stringify({ claimId: "claim-alpha-authorization" }),
  });
  const schemeUserRead = await app.request(url, {
    headers: authHeaders({ user: "scheme-user-alpha", role: "scheme_user" }),
  });
  const schemeUserEvidence = await app.request(`${url}/evidence`, {
    method: "POST",
    headers: authHeaders({ user: "scheme-user-alpha", role: "scheme_user" }),
    body: JSON.stringify({ filename: "blocked.pdf", evidenceType: "document" }),
  });

  assert.equal(schemeUserCreate.status, 403);
  assert.equal(schemeUserRead.status, 403);
  assert.equal(schemeUserEvidence.status, 403);

  const platformRead = await app.request(url, {
    headers: authHeaders({ user: "platform-admin", role: "platform_administrator" }),
  });
  const platformUpdate = await app.request(url, {
    method: "PATCH",
    headers: authHeaders({ user: "platform-admin", role: "platform_administrator" }),
    body: JSON.stringify({ priority: "LOW" }),
  });

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
  const app = createBackendApp({
    investigationRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });
  const betaHeaders = authHeaders({
    user: "investigator-beta",
    role: "investigator",
    tenantId: betaTenant.tenant_id,
    requestTenantId: betaTenant.tenant_id,
  });

  const getResponse = await app.request("http://localhost/investigations/investigation-alpha-only", {
    headers: betaHeaders,
  });
  const noteResponse = await app.request("http://localhost/investigations/investigation-alpha-only/notes", {
    method: "POST",
    headers: betaHeaders,
    body: JSON.stringify({ text: "Cross-tenant access must fail." }),
  });
  const confirmResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: betaHeaders,
    body: JSON.stringify({
      investigationId: "investigation-alpha-only",
      claimId: "claim-alpha-isolated",
      investigatorId: "investigator-beta",
      reason: "Cross-tenant confirmation must fail.",
    }),
  });

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
  const app = createBackendApp({
    investigationRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });
  const headers = authHeaders({ user: "investigator-alpha", role: "investigator" });

  const missingResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers,
    body: JSON.stringify({
      investigationId: "missing-investigation",
      claimId: "claim-alpha-missing",
      investigatorId: "investigator-alpha",
      reason: "This investigation does not exist.",
    }),
  });
  const underReviewResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers,
    body: JSON.stringify({
      investigationId: "investigation-review",
      claimId: "claim-alpha-review",
      investigatorId: "investigator-alpha",
      reason: "The investigation must be completed first.",
    }),
  });
  const confirmedResponse = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers,
    body: JSON.stringify({
      investigationId: "investigation-confirmed",
      claimId: "claim-alpha-confirmed",
      investigatorId: "investigator-alpha",
      reason: "The evidence supports a fraud finding.",
      schemeId: alphaTenant.scheme_id,
      reportVersion: "v20260714",
    }),
  });
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
