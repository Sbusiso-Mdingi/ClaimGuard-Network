import assert from "node:assert/strict";
import test from "node:test";

import { runOperationalMigrationCli } from "../src/migrate.js";

test("operational migration CLI fails closed outside the governed admin mode", async () => {
  let poolCreated = false;

  await assert.rejects(
    runOperationalMigrationCli({
      env: {
        MYSQL_URL: "mysql://user:secret@database.example/operational",
      },
      poolFactory() {
        poolCreated = true;
      },
    }),
    /OPERATIONAL_ADMIN_MODE=legacy_shared/,
  );

  assert.equal(poolCreated, false);
});

test("operational migration CLI requires an explicit database URL", async () => {
  await assert.rejects(
    runOperationalMigrationCli({
      env: {
        OPERATIONAL_ADMIN_MODE: "legacy_shared",
      },
    }),
    /MYSQL_URL must be set/,
  );
});

test("operational migration CLI applies the canonical migration set and closes the pool", async () => {
  const pool = {
    ended: false,
    async end() {
      this.ended = true;
    },
  };
  const result = {
    applied: [{ id: "0018_versioned_assessment_context" }],
    pending: [],
  };
  const calls = [];
  let output = "";

  const returned = await runOperationalMigrationCli({
    env: {
      OPERATIONAL_ADMIN_MODE: "legacy_shared",
      MYSQL_URL: "mysql://user:secret@database.example/operational",
      CLAIMGUARD_RELEASE: "exact-release-sha",
    },
    poolFactory(databaseUrl) {
      assert.equal(
        databaseUrl,
        "mysql://user:secret@database.example/operational",
      );
      return pool;
    },
    async migrate(...args) {
      calls.push(args);
      return result;
    },
    writeOutput(value) {
      output += value;
    },
  });

  assert.equal(returned, result);
  assert.equal(pool.ended, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], pool);
  assert.equal(calls[0][1], undefined);
  assert.deepEqual(calls[0][2], {
    applicationVersion: "exact-release-sha",
  });
  assert.deepEqual(JSON.parse(output), result);
  assert.doesNotMatch(output, /secret/);
});

test("operational migration CLI closes the pool when migration fails", async () => {
  let ended = false;

  await assert.rejects(
    runOperationalMigrationCli({
      env: {
        OPERATIONAL_ADMIN_MODE: "legacy_shared",
        MYSQL_URL: "mysql://user:secret@database.example/operational",
      },
      poolFactory() {
        return {
          async end() {
            ended = true;
          },
        };
      },
      async migrate() {
        throw new Error("migration failed");
      },
    }),
    /migration failed/,
  );

  assert.equal(ended, true);
});
