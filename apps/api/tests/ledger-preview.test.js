import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

test("ledger preview endpoint returns a chained entry", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/ledger/preview");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.chainReady, true);
  assert.equal(json.entry.sequenceNumber, 1);
  assert.equal(json.entry.entryType, "API_BOOT");
  assert.equal(json.entry.previousHash.length, 64);
  assert.equal(json.entry.entryHash.length, 64);
});