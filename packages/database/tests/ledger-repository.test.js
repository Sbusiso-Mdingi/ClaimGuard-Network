import assert from "node:assert/strict";
import test from "node:test";

import { createLedgerRepository } from "../src/index.js";

function createFakeDb() {
  const entries = [];

  return {
    entries,
    select() {
      let filteredEntries = entries;

      const query = {
        from() {
          return {
            orderBy() {
              return {
                limit(limitCount) {
                  return Promise.resolve(filteredEntries.slice(-limitCount));
                },
              };
            },
            where(condition) {
              const rightValue = condition?.right?.value;
              if (rightValue !== undefined) {
                filteredEntries = entries.filter((entry) => entry.entryType === rightValue);
              }
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

test("ledger repository creates chained entries", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

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
  assert.equal(db.entries.length, 2);
});

test("ledger repository records and returns latest confirmed fraud entry", async () => {
  const db = createFakeDb();
  const repository = createLedgerRepository(db);

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
});