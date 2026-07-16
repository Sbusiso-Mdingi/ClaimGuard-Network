import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { createBackendApp } from "../src/backend.js";
import { INVESTIGATION_STATUS, FRAUD_REGISTRY_STATUS } from "@claimguard/database";

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
      return [...tenants.values()].find((t) => t.tenant_slug === tenantSlug) || null;
    },
    async lookupTenantBySchemeId(schemeId) {
      return [...tenants.values()].find((t) => t.scheme_id === schemeId) || null;
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
  const records = new Map(investigations.map((inv) => [inv.investigationId, { ...inv }]));

  function requiredInvestigation(investigationId) {
    const inv = records.get(investigationId);
    if (!inv || inv.tenantId !== activeTenantId) {
      const error = new Error("Not found");
      error.code = "investigation_not_found";
      throw error;
    }
    return inv;
  }

  return {
    records,
    async getInvestigationById(investigationId) {
      const inv = records.get(investigationId);
      return inv && inv.tenantId === activeTenantId ? { ...inv } : null;
    },
    async markFraudPublished(investigationId) {
      const inv = requiredInvestigation(investigationId);
      if (inv.status !== INVESTIGATION_STATUS.CONFIRMED_FRAUD || inv.fraudConfirmedAt) {
        const err = new Error("Conflict");
        err.code = "confirmation_status_not_permitted";
        throw err;
      }
      inv.fraudConfirmedAt = new Date().toISOString();
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
      return records.find((r) => r.registryEntryId === registryEntryId) || null;
    },
    async searchRegistry({ subjectToken, fraudSubjectType = null }) {
      const reversedIds = new Set(
        records.filter((r) => r.reversesRegistryEntryId).map((r) => r.reversesRegistryEntryId)
      );
      return records.filter(
        (r) =>
          r.subjectToken === subjectToken &&
          (!fraudSubjectType || r.fraudSubjectType === fraudSubjectType) &&
          !(r.status === FRAUD_REGISTRY_STATUS.ACTIVE && reversedIds.has(r.registryEntryId))
      );
    },
    async getRegistryHistory(subjectToken) {
      return records.filter((r) => r.subjectToken === subjectToken);
    },
    async getActiveRegistryFindingForInvestigation({ investigationId, tenantId }) {
      const reversedIds = new Set(
        records.filter((r) => r.reversesRegistryEntryId).map((r) => r.reversesRegistryEntryId)
      );
      return (
        records.find(
          (r) =>
            r.investigationId === investigationId &&
            r.tenantId === tenantId &&
            r.status === FRAUD_REGISTRY_STATUS.ACTIVE &&
            !reversedIds.has(r.registryEntryId)
        ) || null
      );
    },
  };
}

test("confirm-fraud successfully publishes to the shared fraud registry", async () => {
  activeTenantId = alphaTenant.tenant_id;
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [
      {
        investigationId: "inv-reg-1",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha",
        status: "CONFIRMED_FRAUD",
        fraudConfirmedAt: null,
      },
    ],
  });
  const ledgerRepository = createLedgerRepositoryStub();
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();
  
  const app = createBackendApp({
    investigationRepository,
    ledgerRepository,
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const response = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
    body: JSON.stringify({
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
  });

  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.entry.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
  assert.equal(data.registryEntry.status, "ACTIVE");
  assert.equal(data.registryEntry.subjectToken, "prov-123");
  assert.equal(sharedFraudRegistryRepository.records.length, 1);
});

test("reverse-fraud creates ledger event and REVERSED registry entry", async () => {
  activeTenantId = alphaTenant.tenant_id;
  const investigationRepository = createInvestigationRepositoryStub({
    investigations: [
      {
        investigationId: "inv-reg-2",
        tenantId: alphaTenant.tenant_id,
        claimId: "claim-alpha",
        status: "CONFIRMED_FRAUD",
        fraudConfirmedAt: "2026-07-13T10:00:00.000Z",
      },
    ],
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
  
  const app = createBackendApp({
    investigationRepository,
    ledgerRepository,
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  const response = await app.request("http://localhost/investigations/reverse-fraud", {
    method: "POST",
    headers: authHeaders({ user: "investigator-alpha", role: "investigator" }),
    body: JSON.stringify({
      investigationId: "inv-reg-2",
      claimId: "claim-alpha",
      investigatorId: "investigator-alpha",
      reason: "Appeal granted",
    }),
  });

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
  
  const app = createBackendApp({
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });

  // Query as Beta tenant
  activeTenantId = betaTenant.tenant_id;
  const betaHeaders = authHeaders({
    user: "analyst-beta",
    role: "fraud_analyst",
    tenantId: betaTenant.tenant_id,
    requestTenantId: betaTenant.tenant_id,
  });

  // 1. Search
  const searchResp = await app.request("http://localhost/registry/search?subjectToken=prov-shared", {
    headers: betaHeaders,
  });
  assert.equal(searchResp.status, 200);
  const searchData = await searchResp.json();
  assert.equal(searchData.results.length, 1);
  assert.equal(searchData.results[0].tenantId, alphaTenant.tenant_id);

  // 2. Get by ID
  const getResp = await app.request("http://localhost/registry/reg-alpha", {
    headers: betaHeaders,
  });
  assert.equal(getResp.status, 200);
  const getData = await getResp.json();
  assert.equal(getData.record.registryEntryId, "reg-alpha");

  // 3. History
  const historyResp = await app.request("http://localhost/registry/history/prov-shared", {
    headers: betaHeaders,
  });
  assert.equal(historyResp.status, 200);
  const historyData = await historyResp.json();
  assert.equal(historyData.history.length, 1);
});

test("registry read endpoints reject incomplete authentication context", async () => {
  const sharedFraudRegistryRepository = createSharedFraudRegistryRepositoryStub();
  const app = createBackendApp({
    sharedFraudRegistryRepository,
    tenantRepository: createTenantRepositoryStub(),
  });
  activeTenantId = alphaTenant.tenant_id;

  const noRolesHeader = {
    "content-type": "application/json",
    "x-claimguard-user": "unknown",
    "x-claimguard-user-tenant": alphaTenant.tenant_id,
    "x-claimguard-tenant": alphaTenant.tenant_id,
  };

  const searchResp = await app.request("http://localhost/registry/search?subjectToken=tok", {
    headers: noRolesHeader,
  });
  assert.equal(searchResp.status, 401);

  const getResp = await app.request("http://localhost/registry/reg-1", {
    headers: noRolesHeader,
  });
  assert.equal(getResp.status, 401);
  
  const histResp = await app.request("http://localhost/registry/history/tok", {
    headers: noRolesHeader,
  });
  assert.equal(histResp.status, 401);
});
