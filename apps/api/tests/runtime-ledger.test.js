import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

const ledgerHeaders = {
  "x-claimguard-user": "investigator-default",
  "x-claimguard-role": "investigator",
  "x-claimguard-user-tenant": "tenant_default",
  "x-claimguard-tenant": "tenant_default",
};

function createLedgerRepositoryStub(entry) {
  return {
    async getLatestEntry() {
      return entry;
    },
  };
}

test("latest ledger endpoint returns 503 when mysql is unavailable", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/ledger/latest", { headers: ledgerHeaders });
  const json = await response.json();

  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});

test("latest ledger endpoint returns the repository entry when mysql is available", async () => {
  const app = createBackendApp({
    ledgerRepository: createLedgerRepositoryStub({
      sequenceNumber: 12,
      entryType: "DATA_SEEDED",
      previousHash: "0".repeat(64),
      entryHash: "a".repeat(64),
      payload: { source: "phase1-synthetic" },
    }),
  });

  const response = await app.request("http://localhost/ledger/latest", { headers: ledgerHeaders });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.entry.sequenceNumber, 12);
  assert.equal(json.entry.entryType, "DATA_SEEDED");
});
