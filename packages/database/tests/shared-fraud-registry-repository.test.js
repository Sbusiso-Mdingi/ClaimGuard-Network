import assert from "node:assert/strict";
import test from "node:test";

import {
  createSharedFraudRegistryRepository,
  FRAUD_REGISTRY_STATUS,
  FRAUD_SUBJECT_TYPE,
  FraudRegistryConflictError,
  FraudRegistryValidationError,
  normalizeRegistryPublicationMetadata,
} from "../src/index.js";

function createFakePool() {
  const rows = [];
  let duplicateHash = null;

  return {
    rows,
    setDuplicateHash(hash) {
      duplicateHash = hash;
    },
    async execute(sql, params) {
      const trimmedSql = sql.trim();

      if (trimmedSql.startsWith("INSERT")) {
        const ledgerHash = params[1];
        if (duplicateHash && ledgerHash === duplicateHash) {
          const error = new Error("Duplicate entry");
          error.code = "ER_DUP_ENTRY";
          throw error;
        }

        const row = {
          registry_entry_id: params[0],
          ledger_hash: params[1],
          investigation_id: params[2],
          tenant_id: params[3],
          medical_scheme: params[4],
          fraud_subject_type: params[5],
          subject_token: params[6],
          offence_category: params[7],
          finding_date: params[8],
          investigator_reference: params[9],
          publication_timestamp: new Date().toISOString(),
          status: params[10],
          reverses_registry_entry_id: params[11],
        };
        rows.push(row);
        return [{ affectedRows: 1 }];
      }

      if (trimmedSql.startsWith("SELECT")) {
        if (trimmedSql.includes("WHERE registry_entry_id = ?")) {
          const id = params[0];
          const matching = rows.filter((r) => r.registry_entry_id === id);
          return [matching];
        }

        if (trimmedSql.includes("WHERE subject_token = ?")) {
          const token = params[0];
          const subjectType = params[1];
          const matching = rows.filter(
            (r) =>
              r.subject_token === token &&
              (subjectType === null || r.fraud_subject_type === subjectType),
          );
          return [matching];
        }

        if (trimmedSql.includes("WHERE active_entry.investigation_id = ?")) {
          const invId = params[0];
          const tenantId = params[1];
          const activeEntries = rows.filter(
            (r) =>
              r.investigation_id === invId &&
              r.tenant_id === tenantId &&
              r.status === "ACTIVE",
          );
          const reversedIds = new Set(
            rows
              .filter((r) => r.reverses_registry_entry_id)
              .map((r) => r.reverses_registry_entry_id),
          );
          const unreversed = activeEntries.filter(
            (r) => !reversedIds.has(r.registry_entry_id),
          );
          return [unreversed.length > 0 ? [unreversed[unreversed.length - 1]] : []];
        }

        return [[]];
      }

      return [[]];
    },
  };
}

function createValidLedgerEntry(entryType = "INVESTIGATOR_CONFIRMED_FRAUD") {
  return {
    sequenceNumber: 1,
    entryType,
    previousHash: "a".repeat(64),
    entryHash: "b".repeat(64),
    payload: { claimId: "C-100" },
  };
}

function createValidInvestigation(overrides = {}) {
  return {
    investigationId: "inv-001",
    tenantId: "tenant_alpha",
    claimId: "C-100",
    ...overrides,
  };
}

function createValidMetadata(overrides = {}) {
  return {
    medicalScheme: "Alpha Medical Scheme",
    fraudSubjectType: "PROVIDER",
    subjectToken: "provider-token-001",
    offenceCategory: "Billing Fraud",
    findingDate: "2026-07-14",
    investigatorReference: "investigator-alpha",
    ...overrides,
  };
}

test("normalizeRegistryPublicationMetadata validates required fields", () => {
  assert.throws(
    () => normalizeRegistryPublicationMetadata({}),
    (error) => error instanceof FraudRegistryValidationError,
  );

  assert.throws(
    () => normalizeRegistryPublicationMetadata({ medicalScheme: "Scheme", fraudSubjectType: "INVALID" }),
    (error) => error instanceof FraudRegistryValidationError,
  );

  const valid = normalizeRegistryPublicationMetadata(createValidMetadata());
  assert.equal(valid.medicalScheme, "Alpha Medical Scheme");
  assert.equal(valid.fraudSubjectType, "PROVIDER");
  assert.equal(valid.subjectToken, "provider-token-001");
});

test("normalizeRegistryPublicationMetadata normalizes subject types", () => {
  const member = normalizeRegistryPublicationMetadata(createValidMetadata({ fraudSubjectType: "member" }));
  assert.equal(member.fraudSubjectType, "MEMBER");

  const practitioner = normalizeRegistryPublicationMetadata(
    createValidMetadata({ fraudSubjectType: "Practitioner" }),
  );
  assert.equal(practitioner.fraudSubjectType, "PRACTITIONER");
});

test("publishConfirmedFraud creates a registry entry with ACTIVE status", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const result = await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  assert.equal(result.status, FRAUD_REGISTRY_STATUS.ACTIVE);
  assert.equal(result.tenantId, "tenant_alpha");
  assert.equal(result.medicalScheme, "Alpha Medical Scheme");
  assert.equal(result.fraudSubjectType, FRAUD_SUBJECT_TYPE.PROVIDER);
  assert.equal(result.subjectToken, "provider-token-001");
  assert.equal(result.offenceCategory, "Billing Fraud");
  assert.equal(result.reversesRegistryEntryId, null);
  assert.ok(result.registryEntryId);
  assert.ok(result.publicationTimestamp);
  assert.equal(pool.rows.length, 1);
});

test("publishConfirmedFraud rejects non-confirmed-fraud ledger entry types", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await assert.rejects(
    () =>
      repo.publishConfirmedFraud({
        ledgerEntry: createValidLedgerEntry("DATA_SEEDED"),
        investigation: createValidInvestigation(),
        metadata: createValidMetadata(),
      }),
    (error) => {
      assert.ok(error instanceof FraudRegistryValidationError);
      return true;
    },
  );
});

test("publishConfirmedFraud throws conflict on duplicate ledger hash", async () => {
  const pool = createFakePool();
  pool.setDuplicateHash("b".repeat(64));
  const repo = createSharedFraudRegistryRepository(pool);

  await assert.rejects(
    () =>
      repo.publishConfirmedFraud({
        ledgerEntry: createValidLedgerEntry(),
        investigation: createValidInvestigation(),
        metadata: createValidMetadata(),
      }),
    (error) => {
      assert.ok(error instanceof FraudRegistryConflictError);
      assert.equal(error.code, "registry_ledger_event_already_published");
      return true;
    },
  );
});

test("publishFraudReversal creates a REVERSED registry entry referencing the original", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const originalEntry = await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  const reversalLedgerEntry = {
    sequenceNumber: 2,
    entryType: "INVESTIGATOR_REVERSED_FRAUD",
    previousHash: "b".repeat(64),
    entryHash: "c".repeat(64),
    payload: { claimId: "C-100" },
  };

  const reversalResult = await repo.publishFraudReversal({
    ledgerEntry: reversalLedgerEntry,
    investigation: createValidInvestigation(),
    originalRegistryEntry: originalEntry,
    investigatorReference: "investigator-alpha",
  });

  assert.equal(reversalResult.status, FRAUD_REGISTRY_STATUS.REVERSED);
  assert.equal(reversalResult.reversesRegistryEntryId, originalEntry.registryEntryId);
  assert.equal(reversalResult.medicalScheme, originalEntry.medicalScheme);
  assert.equal(reversalResult.subjectToken, originalEntry.subjectToken);
  assert.equal(pool.rows.length, 2);
});

test("publishFraudReversal rejects non-reversal ledger entry types", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await assert.rejects(
    () =>
      repo.publishFraudReversal({
        ledgerEntry: createValidLedgerEntry("INVESTIGATOR_CONFIRMED_FRAUD"),
        investigation: createValidInvestigation(),
        originalRegistryEntry: {
          registryEntryId: "existing-id",
          status: FRAUD_REGISTRY_STATUS.ACTIVE,
          investigationId: "inv-001",
          tenantId: "tenant_alpha",
          medicalScheme: "Alpha",
          fraudSubjectType: "PROVIDER",
          subjectToken: "tok",
          offenceCategory: "cat",
          findingDate: "2026-07-14",
        },
        investigatorReference: "inv-alpha",
      }),
    (error) => {
      assert.ok(error instanceof FraudRegistryValidationError);
      return true;
    },
  );
});

test("publishFraudReversal rejects reversal when no active finding exists", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await assert.rejects(
    () =>
      repo.publishFraudReversal({
        ledgerEntry: {
          sequenceNumber: 2,
          entryType: "INVESTIGATOR_REVERSED_FRAUD",
          previousHash: "a".repeat(64),
          entryHash: "c".repeat(64),
          payload: {},
        },
        investigation: createValidInvestigation(),
        originalRegistryEntry: null,
        investigatorReference: "inv-alpha",
      }),
    (error) => {
      assert.ok(error instanceof FraudRegistryConflictError);
      return true;
    },
  );
});

test("searchRegistry returns matching entries by subject token", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  const results = await repo.searchRegistry({
    subjectToken: "provider-token-001",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].subjectToken, "provider-token-001");
  assert.equal(results[0].status, FRAUD_REGISTRY_STATUS.ACTIVE);
});

test("searchRegistry filters by fraudSubjectType when provided", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata({ fraudSubjectType: "PROVIDER" }),
  });

  const providerResults = await repo.searchRegistry({
    subjectToken: "provider-token-001",
    fraudSubjectType: "PROVIDER",
  });
  assert.equal(providerResults.length, 1);

  const memberResults = await repo.searchRegistry({
    subjectToken: "provider-token-001",
    fraudSubjectType: "MEMBER",
  });
  assert.equal(memberResults.length, 0);
});

test("getRegistryHistory returns all entries including reversed ones", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const originalEntry = await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  await repo.publishFraudReversal({
    ledgerEntry: {
      sequenceNumber: 2,
      entryType: "INVESTIGATOR_REVERSED_FRAUD",
      previousHash: "b".repeat(64),
      entryHash: "c".repeat(64),
      payload: {},
    },
    investigation: createValidInvestigation(),
    originalRegistryEntry: originalEntry,
    investigatorReference: "investigator-alpha",
  });

  const history = await repo.getRegistryHistory("provider-token-001");
  assert.equal(history.length, 2);
  assert.equal(history[0].status, FRAUD_REGISTRY_STATUS.ACTIVE);
  assert.equal(history[1].status, FRAUD_REGISTRY_STATUS.REVERSED);
});

test("getRegistryRecordById returns a single record", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const published = await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  const record = await repo.getRegistryRecordById(published.registryEntryId);
  assert.ok(record);
  assert.equal(record.registryEntryId, published.registryEntryId);
  assert.equal(record.status, FRAUD_REGISTRY_STATUS.ACTIVE);
});

test("getRegistryRecordById returns null for unknown id", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const record = await repo.getRegistryRecordById("nonexistent-id");
  assert.equal(record, null);
});

test("getActiveRegistryFindingForInvestigation returns active unreversed entry", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  const published = await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  const active = await repo.getActiveRegistryFindingForInvestigation({
    investigationId: "inv-001",
    tenantId: "tenant_alpha",
  });

  assert.ok(active);
  assert.equal(active.registryEntryId, published.registryEntryId);
  assert.equal(active.status, FRAUD_REGISTRY_STATUS.ACTIVE);
});

test("getActiveRegistryFindingForInvestigation returns null for wrong tenant", async () => {
  const pool = createFakePool();
  const repo = createSharedFraudRegistryRepository(pool);

  await repo.publishConfirmedFraud({
    ledgerEntry: createValidLedgerEntry(),
    investigation: createValidInvestigation(),
    metadata: createValidMetadata(),
  });

  const active = await repo.getActiveRegistryFindingForInvestigation({
    investigationId: "inv-001",
    tenantId: "tenant_beta",
  });

  assert.equal(active, null);
});
