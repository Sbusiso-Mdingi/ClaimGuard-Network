import assert from "node:assert/strict";
import test from "node:test";

import {
  computeLedgerEntryHash,
  createLedgerEntry,
  genesisPreviousHash,
  stableStringify,
} from "../src/index.js";

test("stable stringify sorts object keys", () => {
  const value = stableStringify({ b: 2, a: 1, c: { z: 9, y: 8 } });

  assert.equal(value, '{"a":1,"b":2,"c":{"y":8,"z":9}}');
});

test("ledger hash is deterministic for equivalent payloads", () => {
  const first = computeLedgerEntryHash({
    previousHash: genesisPreviousHash,
    entryType: "CLAIM_REVIEW",
    payload: { b: 2, a: 1 },
  });

  const second = computeLedgerEntryHash({
    previousHash: genesisPreviousHash,
    entryType: "CLAIM_REVIEW",
    payload: { a: 1, b: 2 },
  });

  assert.equal(first, second);
});

test("ledger entry captures the chained hash inputs", () => {
  const entry = createLedgerEntry({
    sequenceNumber: 1,
    entryType: "CLAIM_REVIEW",
    payload: { claimId: "claim-001" },
  });

  assert.equal(entry.sequenceNumber, 1);
  assert.equal(entry.previousHash, genesisPreviousHash);
  assert.equal(entry.entryType, "CLAIM_REVIEW");
  assert.equal(typeof entry.entryHash, "string");
  assert.equal(entry.entryHash.length, 64);
});