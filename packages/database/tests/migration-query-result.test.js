import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOperationalMigrationRows,
} from "../src/migrate.js";

const rows = [
  {
    migration_id: "0016_domain_safety_foundation",
    checksum: "a".repeat(64),
  },
];

test("migration row extraction accepts a mysql2 tuple", () => {
  assert.deepEqual(
    extractOperationalMigrationRows([
      rows,
      [{ name: "migration_id", columnType: 253 }],
    ], "migration history"),
    rows,
  );
});

test("migration row extraction accepts a direct repository-adapter row array", () => {
  assert.deepEqual(
    extractOperationalMigrationRows(rows, "migration history"),
    rows,
  );
});

test("migration row extraction accepts valid empty results", () => {
  assert.deepEqual(extractOperationalMigrationRows([], "history"), []);
  assert.deepEqual(extractOperationalMigrationRows([[], []], "history"), []);
});

test("migration row extraction rejects malformed objects and scalars", () => {
  for (const value of [{ rows }, null, 17, "rows", true]) {
    assert.throws(
      () => extractOperationalMigrationRows(value, "history"),
      (error) => error.code === "OPERATIONAL_MIGRATION_QUERY_RESULT_INVALID",
    );
  }
});

test("migration row extraction rejects ambiguous nested arrays", () => {
  for (const value of [
    [[rows]],
    [rows, rows],
    [[[]], []],
    [[{ migration_id: "0016" }], [{ arbitrary: "metadata" }]],
  ]) {
    assert.throws(
      () => extractOperationalMigrationRows(value, "history"),
      (error) => error.code === "OPERATIONAL_MIGRATION_QUERY_RESULT_INVALID",
    );
  }
});

test("field-definition arrays cannot be interpreted as migration rows", () => {
  assert.throws(
    () => extractOperationalMigrationRows([
      [{ name: "migration_id", columnType: 253 }],
      rows,
    ], "history"),
    (error) => error.code === "OPERATIONAL_MIGRATION_QUERY_RESULT_INVALID",
  );
});
