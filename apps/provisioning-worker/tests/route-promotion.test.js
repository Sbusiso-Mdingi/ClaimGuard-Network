import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_PRIVATE_SCHEMA_VERSION,
  promoteCompatiblePrivateRoutes,
} from "../src/route-promotion.js";

test("promotes only compatible inactive schema-14 private routes", async () => {
  const calls = [];
  let ended = false;

  const pool = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }, []];
    },
    async end() {
      ended = true;
    },
  };

  const result = await promoteCompatiblePrivateRoutes({ pool });

  assert.deepEqual(result, {
    promoted: 1,
    schemaVersion: "14",
  });
  assert.equal(CANONICAL_PRIVATE_SCHEMA_VERSION, "14");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, ["14", "14", "14"]);
  assert.match(calls[0].sql, /active_route_slot IS NULL/);
  assert.match(calls[0].sql, /compatibility_status = 'compatible'/);
  assert.match(calls[0].sql, /provisioning_status = 'ready'/);
  assert.equal(ended, false);
});

test("closes an internally created pool", async () => {
  let ended = false;

  const pool = {
    async execute() {
      return [{ affectedRows: 0 }, []];
    },
    async end() {
      ended = true;
    },
  };

  const result = await promoteCompatiblePrivateRoutes({
    databaseUrl: "mysql://user:password@localhost:3306/control",
    pool,
  });

  assert.equal(result.promoted, 0);
  assert.equal(ended, false);
});
