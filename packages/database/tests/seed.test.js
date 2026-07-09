import assert from "node:assert/strict";
import test from "node:test";

import { loadSyntheticPhase1Data, seedSyntheticDatabase } from "../src/index.js";

function createFakePool() {
  const queries = [];

  return {
    queries,
    async query(sql) {
      queries.push(sql);
      return [[], []];
    },
  };
}

test("loadSyntheticPhase1Data reads the generated Phase 1 exports", async () => {
  const data = await loadSyntheticPhase1Data();

  assert.equal(data.schemes.length, 3);
  assert.equal(data.members.length, 9000);
  assert.equal(data.providers.length >= 750, true);
  assert.equal(data.members[0].scheme_id, "A");
  assert.equal(typeof data.members[0].home_lat, "number");
  assert.equal(typeof data.claims[0].amount, "number");
});

test("seedSyntheticDatabase writes scheme, entity, claim, and ledger rows", async () => {
  const pool = createFakePool();
  const summary = await seedSyntheticDatabase(pool, {
    applyMigrationsFirst: false,
  });

  assert.equal(summary.schemes, 3);
  assert.equal(summary.members, 9000);
  assert.equal(summary.providers >= 750, true);
  assert.ok(pool.queries.some((query) => String(query).includes("INSERT INTO schemes")));
  assert.ok(pool.queries.some((query) => String(query).includes("INSERT INTO ledger_entries")));
});