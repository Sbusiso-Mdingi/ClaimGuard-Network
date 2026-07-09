import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase, createMysqlConnection } from "../src/index.js";

test("createMysqlConnection rejects missing urls", () => {
  assert.throws(() => createMysqlConnection(""), /databaseUrl must be provided/);
});

test("createDatabase exposes a drizzle client and pool", () => {
  const { db, pool } = createDatabase("mysql://claimguard:secret@localhost:3306/claimguard");

  assert.equal(typeof db.select, "function");
  assert.equal(typeof pool.query, "function");
});