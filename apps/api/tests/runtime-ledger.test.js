import assert from "node:assert/strict";
import test from "node:test";

import { CLAIMGUARD_ROLES } from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import { createStaticAuthenticationProvider } from "./helpers/authentication-provider.js";

function createLedgerAuthenticationProvider() {
  return createStaticAuthenticationProvider({
    userId: "investigator-default",
    roles: [CLAIMGUARD_ROLES.INVESTIGATOR],
    tenantId: "tenant_default",
  });
}

function createLedgerRepositoryStub(entry) {
  return {
    async getLatestEntry() {
      return entry;
    },
  };
}

test("latest ledger endpoint returns 503 when mysql is unavailable", async () => {
  const app = createBackendApp({ authenticationProvider: createLedgerAuthenticationProvider() });
  const response = await app.request("http://localhost/ledger/latest");
  const json = await response.json();

  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});

test("latest ledger endpoint returns the repository entry when mysql is available", async () => {
  const app = createBackendApp({
    authenticationProvider: createLedgerAuthenticationProvider(),
    ledgerRepository: createLedgerRepositoryStub({
      sequenceNumber: 12,
      entryType: "DATA_SEEDED",
      previousHash: "0".repeat(64),
      entryHash: "a".repeat(64),
      payload: { source: "test-fixture" },
    }),
  });

  const response = await app.request("http://localhost/ledger/latest");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.entry.sequenceNumber, 12);
  assert.equal(json.entry.entryType, "DATA_SEEDED");
});
