import assert from "node:assert/strict";
import test from "node:test";
import util from "node:util";

import { createLedgerRepository, getActiveTenantId, runWithTenantContext } from "../src/index.js";

function createFakeDb() {
  const entries = [];

  return {
    entries,
    select() {
      let filteredEntries = [...entries];

      const query = {
        from() {
          return {
            where(condition) {
              const renderedCondition = util.inspect(condition, { depth: 12, breakLength: Infinity });
              const tenantCandidate = getActiveTenantId();
              const hasConfirmedFraudFilter = renderedCondition.includes("INVESTIGATOR_CONFIRMED_FRAUD");
              const hashCandidate = renderedCondition.match(/[a-f0-9]{64}/i)?.[0] || null;

              filteredEntries = filteredEntries.filter((entry) => {
                if (tenantCandidate && entry.tenantId !== tenantCandidate) {
                  return false;
                }

                if (hasConfirmedFraudFilter && entry.entryType !== "INVESTIGATOR_CONFIRMED_FRAUD") {
                  return false;
                }

                if (hashCandidate && entry.entryHash !== hashCandidate) {
                  return false;
                }

                return true;
              });

              return {
                orderBy() {
                  return {
                    limit(limitCount) {
                      return Promise.resolve(filteredEntries.slice(-limitCount));
                    },
                  };
                },
                limit(limitCount) {
                  return Promise.resolve(filteredEntries.slice(0, limitCount));
                },
              };
            },
            orderBy() {
              return {
                limit(limitCount) {
                  return Promise.resolve(filteredEntries.slice(-limitCount));
                },
              };
            },
            limit(limitCount) {
              return Promise.resolve(filteredEntries.slice(0, limitCount));
            },
          };
        },
      };

      return query;
    },
    insert() {
      return {
        values(value) {
          entries.push(value);
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      };
    },
  };
}

test("ledger repository creates chained entries with tenant_id", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      const first = await repository.createEntry({
        entryType: "API_BOOT",
        payload: { service: "api" },
      });

      const second = await repository.createEntry({
        entryType: "CLAIM_REVIEW",
        payload: { claimId: "claim-001" },
      });

      assert.equal(first.sequenceNumber, 1);
      assert.equal(second.sequenceNumber, 2);
      assert.equal(second.previousHash, first.entryHash);
      assert.equal(first.tenantId, "tenant_alpha");
      assert.equal(second.tenantId, "tenant_alpha");
    },
  );

  assert.equal(db.entries.length, 2);
  assert.equal(db.entries[0].tenantId, "tenant_alpha");
});

test("ledger repository records and returns latest confirmed fraud entry for active tenant only", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      await repository.createEntry({
        entryType: "DATA_SEEDED",
        payload: { source: "seed" },
      });

      const confirmed = await repository.createConfirmedFraudEntry({
        claimId: "C-900",
        investigatorId: "INV-7",
        reason: "Member denied service",
        schemeId: "scheme_a",
        reportVersion: "v1",
      });

      const latestConfirmed = await repository.getLatestConfirmedFraudEntry();

      assert.equal(confirmed.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
      assert.equal(confirmed.payload.claimId, "C-900");
      assert.equal(latestConfirmed?.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
      assert.equal(latestConfirmed?.payload.investigatorId, "INV-7");
      assert.equal(latestConfirmed?.tenantId, "tenant_alpha");
    },
  );

  await runWithTenantContext(
    {
      tenant_id: "tenant_beta",
      tenant_slug: "beta",
      scheme_id: null,
      source: "header",
    },
    async () => {
      const latestConfirmed = await repository.getLatestConfirmedFraudEntry();
      assert.equal(latestConfirmed, null);
    },
  );
});

test("ledger repository applies default tenant fallback when no tenant context exists", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

  const entry = await repository.createEntry({
    entryType: "API_BOOT",
    payload: { service: "api" },
  });

  assert.equal(entry.tenantId, "tenant_default");

  const latest = await repository.getLatestEntry();
  assert.equal(latest?.tenantId, "tenant_default");
});

test("ledger repository enforces cross-tenant isolation for hash lookups", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

  let alphaHash = null;

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      const entry = await repository.createEntry({
        entryType: "CLAIM_REVIEW",
        payload: { claimId: "C-alpha" },
      });
      alphaHash = entry.entryHash;
    },
  );

  await runWithTenantContext(
    {
      tenant_id: "tenant_beta",
      tenant_slug: "beta",
      scheme_id: null,
      source: "header",
    },
    async () => {
      const found = await repository.findEntryByHash(alphaHash);
      assert.equal(found, null);
    },
  );

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      const found = await repository.findEntryByHash(alphaHash);
      assert.equal(found?.payload.claimId, "C-alpha");
      assert.equal(found?.tenantId, "tenant_alpha");
    },
  );
});
