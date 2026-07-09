import assert from "node:assert/strict";
import test from "node:test";

import { createLedgerRepository } from "../src/index.js";

function createFakeDb() {
  const entries = [];

  return {
    entries,
    select() {
      const query = {
        from() {
          return {
            orderBy() {
              return {
                limit(limitCount) {
                  return Promise.resolve(entries.slice(-limitCount));
                },
              };
            },
            where() {
              return {
                limit(limitCount) {
                  return Promise.resolve(entries.slice(0, limitCount));
                },
              };
            },
            limit(limitCount) {
              return Promise.resolve(entries.slice(0, limitCount));
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