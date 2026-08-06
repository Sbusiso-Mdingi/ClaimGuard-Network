import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0017_case_state_machine.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");

test("migration adds tenant-scoped cases, operations, events, checks and outcomes", () => {
  for (const table of [
    "investigation_cases",
    "case_transition_operations",
    "case_transition_events",
    "case_process_checks",
    "case_outcomes",
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  assert.match(migration, /UNIQUE KEY uq_investigation_cases_signal \(tenant_id, signal_id\)/);
  assert.match(migration, /state_version INT UNSIGNED NOT NULL DEFAULT 1/);
  assert.match(migration, /UNIQUE KEY uq_case_transition_idempotency \(tenant_id, idempotency_key\)/);
});

test(
  "migration excludes deferred states and legacy verdict codes",
  () => {
    const stateConstraint = migration.match(
      /CONSTRAINT chk_investigation_cases_state CHECK \(current_state IN \(([\s\S]*?)\)\)/,
    );

    assert.ok(
      stateConstraint,
      "case-state constraint must exist",
    );

    assert.doesNotMatch(
      stateConstraint[1],
      /'NETWORK_NOTICE_ACTIVE'/,
    );

    assert.doesNotMatch(
      stateConstraint[1],
      /'CORRECTED_OR_WITHDRAWN'/,
    );

    assert.doesNotMatch(
      stateConstraint[1],
      /'EXPIRED_OR_SUPERSEDED'/,
    );

    assert.match(
      migration,
      /outcome_code NOT IN \('CONFIRMED_FRAUD','RED','VERIFIED','NETWORK_NOTICE_ACTIVE'\)/,
    );

    assert.doesNotMatch(
      migration,
      /INSERT INTO shared_fraud_registry_entries/,
    );

    assert.doesNotMatch(
      migration,
      /UPDATE claims\s+SET/i,
    );
  },
);

test("events, process checks and outcomes are append-only", () => {
  for (const code of [
    "CASE_TRANSITION_EVENT_IMMUTABLE",
    "CASE_PROCESS_CHECK_IMMUTABLE",
    "CASE_OUTCOME_IMMUTABLE",
  ]) assert.match(migration, new RegExp(code));
  assert.match(migration, /BEFORE UPDATE ON case_transition_events/);
  assert.match(migration, /BEFORE DELETE ON case_outcomes/);
});

test("migration preserves legacy history and advances compatibility metadata", () => {
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  assert.match(migration, /schema_version = '17'/);
  assert.match(migration, /migration_version = GREATEST\(migration_version, 17\)/);
});
