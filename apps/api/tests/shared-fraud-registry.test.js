import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { FRAUD_REGISTRY_STATUS, INVESTIGATION_STATUS } from "@claimguard/database";

import { CLAIMGUARD_ROLES } from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import {
  createAnonymousAuthenticationProvider,
  createStaticAuthenticationProvider,
} from "./helpers/authentication-provider.js";
import { createFraudWorkflowRepositoryStub } from "./helpers/fraud-workflow-stub.js";

const alphaTenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
  scheme_id: "scheme_alpha",
  status: "active",
};

const betaTenant = {
  tenant_id: "tenant_beta",
  tenant_slug: "beta",
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

function createActorProvider({
  userId,
  role,
  tenant = alphaTenant,
} = {}) {
  return createStaticAuthenticationProvider({
    userId,
    roles: [role],
    tenantId: tenant.tenant_id,
    organisationId: `org-${tenant.tenant_slug}`,
    organisation: {
      organisationId: `org-${tenant.tenant_slug}`,
      organisationType: "medical_scheme",
      displayName: `${tenant.tenant_slug} scheme`,
    },
  });
}

function jsonRequest(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function createLedgerRepositoryStub() {
  const entries = [];
  return {
    entries,
    async createConfirmedFraudEntry(payload) {
      const entry = {
        sequenceNumber: entries.length + 1,
        entryType: "INVESTIGATOR_CONFIRMED_FRAUD",
        previousHash: entries.length > 0 ? entries[entries.length - 1].entryHash : "0".repeat(64),
        entryHash: crypto.randomBytes(32).toString("hex"),
        payload,
        tenantId: getActiveTenantIdStub(),
      };
      entries.push(entry);
      return entry;
    },
    async createReversedFraudEntry(payload) {
      const entry = {
        sequenceNumber: entries.length + 1,
        entryType: "INVESTIGATOR_REVERSED_FRAUD",
        previousHash: entries.length > 0 ? entries[entries.length - 1].entryHash : "0".repeat(64),
        entryHash: crypto.randomBytes(32).toString("hex"),
        payload,
        tenantId: getActiveTenantIdStub(),
      };
      entries.push(entry);
      return entry;
    },
  };
}

let activeTenantId = alphaTenant.tenant_id;
function getActiveTenantIdStub() {
  return activeTenantId;
}

function createInvestigationRepositoryStub({ investigations = [] } = {}) {
  const records = new Map(investigations.map((investigation) => [investigation.investigationId, { ...investigation }]));

  function requiredInvestigation(investigationId) {
    const investigation = records.get(investigationId);
    if (!investigation || investigation.tenantId !== activeTenantId) {
      const error = new Error("Not found");
      error.code = "investigation_not_found";
      throw error;
    }
    return investigation;
  }

  return {
    records,
    async getInvestigationById(investigationId) {
      const investigation = records.get(investigationId);
      return investigation && investigation.tenantId === activeTenantId ? { ...investigation } : null;
    },
    async markFraudPublished(investigationId) {
      const investigation = requiredInvestigation(investigationId);
      if (investigation.status !== INVESTIGATION_STATUS.CONFIRMED_FRAUD || investigation.fraudConfirmedAt) {
        const error = new Error("Conflict");
        error.code = "confirmation_status_not_permitted";
        throw error;
      }
      investigation.fraudConfirmedAt = new Date().toISOString();
      return true;
    },
  };
}

function createSharedFraudRegistryRepositoryStub() {
  const records = [];

  return {
    records,
    async publishConfirmedFraud({ ledgerEntry, investigation, metadata }) {
      const entry = {
        registryEntryId: `reg-${records.length + 1}`,
        ledgerHash: ledgerEntry.entryHash,
        investigationId: investigation.investigationId,
        tenantId: investigation.tenantId,
        medicalScheme: metadata.medicalScheme,
        fraudSubjectType: metadata.fraudSubjectType,
        subjectToken: metadata.subjectToken,
        offenceCategory: metadata.offenceCategory,
        findingDate: metadata.findingDate,
        investigatorReference: metadata.investigatorReference,
        publicationTimestamp: new Date().toISOString(),
        status: FRAUD_REGISTRY_STATUS.ACTIVE,
        reversesRegistryEntryId: null,
      };
      records.push(entry);
      return entry;
    },
    async publishFraudReversal({ ledgerEntry, investigation, originalRegistryEntry, investigatorReference }) {
      const entry = {
        registryEntryId: `reg-${records.length + 1}`,
        ledgerHash: ledgerEntry.entryHash,
        investigationId: investigation.investigationId,
        tenantId: investigation.tenantId,
        medicalScheme: originalRegistryEntry.medicalScheme,
        fraudSubjectType: originalRegistryEntry.fraudSubjectType,
        subjectToken: originalRegistryEntry.subjectToken,
        offenceCategory: originalRegistryEntry.offenceCategory,
        findingDate: originalRegistryEntry.findingDate,
        investigatorReference,
        publicationTimestamp: new Date().toISOString(),
        status: FRAUD_REGISTRY_STATUS.REVERSED,
        reversesRegistryEntryId: originalRegistryEntry.registryEntryId,
      };
      records.push(entry);
      return entry;
    },
    async getRegistryRecordById(registryEntryId) {
      return records.find((record) => record.registryEntryId === registryEntryId) || null;
    },
    async searchRegistry({ subjectToken, fraudSubjectType = null }) {
      const reversedIds = new Set(records.filter((record) => record.reversesRegistryEntryId).map((record) => record.reversesRegistryEntryId));
      return records.filter((record) =>
        record.subjectToken === subjectToken
        && (!fraudSubjectType || record.fraudSubjectType === fraudSubjectType)
        && !(record.status === FRAUD_REGISTRY_STATUS.ACTIVE && reversedIds.has(record.registryEntryId))
      );
    },
    async getRegistryHistory(subjectToken) {
      return records.filter((record) => record.subjectToken === subjectToken);
    },
    async getActiveRegistryFindingForInvestigation({ investigationId, tenantId }) {
      const reversedIds = new Set(records.filter((record) => record.reversesRegistryEntryId).map((record) => record.reversesRegistryEntryId));
      return records.find((record) =>
        record.investigationId === investigationId
        && record.tenantId === tenantId
        && record.status === FRAUD_REGISTRY_STATUS.ACTIVE
        && !reversedIds.has(record.registryEntryId)
      ) || null;
    },
  };
}

test("confirm-fraud successfully publishes to the shared fraud registry", async () => {
  activeTenantId = alphaTenant.tenant_id;
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [{
      investigationId: "inv-reg-1",
      tenantId: alphaTenant.tenant_id,
      claimId: "claim-alpha",
      status: "CONFIRMED_FRAUD",
      fraudConfirmedAt: null,
    }],
  });
  const ledgerRepository = createLedgerRepositoryStub();
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();
  const fraudWorkflowRepository = createFraudWorkflowRepositoryStub({
    async confirm(input, helpers) {
      const ledgerEntry = helpers.entry("INVESTIGATOR_CONFIRMED_FRAUD", input, 1);
      const registryEntry = helpers.registry(input, ledgerEntry, "ACTIVE");
      sharedFraudRegistryRepository.records.push(registryEntry);
      return { entry: ledgerEntry, registryEntry, replayed: false };
    },
  });

  const app = createBackendApp({
    authenticationProvider: createActorProvider({
      userId: "investigator-alpha",
      role: CLAIMGUARD_ROLES.INVESTIGATOR,
    }),
    investigationRepository,
    ledgerRepository,
    sharedFraudRegistryRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const response = await app.request(
    "http://localhost/investigations/confirm-fraud",
    jsonRequest({
      investigationId: "inv-reg-1",
      claimId: "claim-alpha",
      investigatorId: "investigator-alpha",
      reason: "Confirmed",
      registryMetadata: {
        medicalScheme: "Alpha",
        fraudSubjectType: "PROVIDER",
        subjectToken: "prov-123",
        offenceCategory: "Billing",
        findingDate: "2026-07-14",
        investigatorReference: "INV-001",
      },
    }),
  );

  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.entry.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
  assert.equal(data.registryEntry.status, "ACTIVE");
  assert.notEqual(data.registryEntry.subjectToken, "prov-123");
  assert.equal(data.registryEntry.investigatorReference, "investigator-alpha");
  assert.equal(sharedFraudRegistryRepository.records.length, 1);
});

test("reverse-fraud creates ledger event and REVERSED registry entry", async () => {
  activeTenantId = alphaTenant.tenant_id;
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [{
      investigationId: "inv-reg-2",
      tenantId: alphaTenant.tenant_id,
      claimId: "claim-alpha",
      status: "CONFIRMED_FRAUD",
      fraudConfirmedAt: "2026-07-13T10:00:00.000Z",
    }],
  });
  const ledgerRepository = createLedgerRepositoryStub();
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();

  sharedFraudRegistryRepository.records.push({
    registryEntryId: "reg-active",
    ledgerHash: "hash",
    investigationId: "inv-reg-2",
    tenantId: alphaTenant.tenant_id,
    medicalScheme: "Alpha",
    fraudSubjectType: "MEMBER",
    subjectToken: "mem-456",
    offenceCategory: "Identity",
    findingDate: "2026-07-13",
    investigatorReference: "INV-002",
    publicationTimestamp: "2026-07-13T10:00:00.000Z",
    status: "ACTIVE",
    reversesRegistryEntryId: null,
  });
  const fraudWorkflowRepository = createFraudWorkflowRepositoryStub({
    async reverse(input, helpers) {
      const ledgerEntry = helpers.entry("INVESTIGATOR_REVERSED_FRAUD", input, 2);
      const registryEntry = helpers.registry(input, ledgerEntry, "REVERSED", "reg-active");
      registryEntry.subjectToken = "mem-456";
      sharedFraudRegistryRepository.records.push(registryEntry);
      return { entry: ledgerEntry, registryEntry, replayed: false };
    },
  });

  const app = createBackendApp({
    authenticationProvider: createActorProvider({
      userId: "investigator-alpha",
      role: CLAIMGUARD_ROLES.INVESTIGATOR,
    }),
    investigationRepository,
    ledgerRepository,
    sharedFraudRegistryRepository,
    fraudWorkflowRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const response = await app.request(
    "http://localhost/investigations/reverse-fraud",
    jsonRequest({
      investigationId: "inv-reg-2",
      claimId: "claim-alpha",
      investigatorId: "investigator-alpha",
      reason: "Appeal granted",
    }),
  );

  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.entry.entryType, "INVESTIGATOR_REVERSED_FRAUD");
  assert.equal(data.registryEntry.status, "REVERSED");
  assert.equal(data.registryEntry.reversesRegistryEntryId, "reg-active");
  assert.equal(data.registryEntry.subjectToken, "mem-456");
  assert.equal(sharedFraudRegistryRepository.records.length, 2);
});

test("registry endpoints allow global read access across tenants", async () => {
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();
  sharedFraudRegistryRepository.records.push({
    registryEntryId: "reg-alpha",
    ledgerHash: "hash1",
    investigationId: "inv-1",
    tenantId: alphaTenant.tenant_id,
    medicalScheme: "Alpha",
    fraudSubjectType: "PROVIDER",
    subjectToken: "prov-shared",
    offenceCategory: "Billing",
    findingDate: "2026-07-10",
    investigatorReference: "INV-A",
    publicationTimestamp: "2026-07-10T10:00:00.000Z",
    status: "ACTIVE",
    reversesRegistryEntryId: null,
  });

  activeTenantId = betaTenant.tenant_id;
  const app = createBackendApp({
    authenticationProvider: createActorProvider({
      userId: "analyst-beta",
      role: CLAIMGUARD_ROLES.FRAUD_ANALYST,
      tenant: betaTenant,
    }),
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const searchResponse = await app.request("http://localhost/registry/search?subjectToken=prov-shared");
  assert.equal(searchResponse.status, 200);
  const searchData = await searchResponse.json();
  assert.equal(searchData.results.length, 1);
  assert.equal(searchData.results[0].tenantId, alphaTenant.tenant_id);

  const getResponse = await app.request("http://localhost/registry/reg-alpha");
  assert.equal(getResponse.status, 200);
  const getData = await getResponse.json();
  assert.equal(getData.record.registryEntryId, "reg-alpha");

  const historyResponse = await app.request("http://localhost/registry/history/prov-shared");
  assert.equal(historyResponse.status, 200);
  const historyData = await historyResponse.json();
  assert.equal(historyData.history.length, 1);
});

test("registry read endpoints reject anonymous authentication context", async () => {
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();
  const app = createBackendApp({
    authenticationProvider: createAnonymousAuthenticationProvider(),
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });
  activeTenantId = alphaTenant.tenant_id;

  const searchResponse = await app.request("http://localhost/registry/search?subjectToken=tok");
  assert.equal(searchResponse.status, 401);

  const getResponse = await app.request("http://localhost/registry/reg-1");
  assert.equal(getResponse.status, 401);

  const historyResponse = await app.request("http://localhost/registry/history/tok");
  assert.equal(historyResponse.status, 401);
});
