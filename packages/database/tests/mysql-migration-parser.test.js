import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { splitOperationalMigrationStatements } from "../src/migrate.js";

const migrationUrl = new URL(
  "../migrations/0016_domain_safety_foundation.sql",
  import.meta.url,
);
const migration = await readFile(migrationUrl, "utf8");

test("schema 16 delimiter blocks become complete executable trigger statements", () => {
  const statements = splitOperationalMigrationStatements(migration);

  assert.equal(statements.length, 7);
  assert.match(statements[0], /^-- Sequrin PR 1:[\s\S]*CREATE TABLE detection_signals/);
  assert.match(statements[1], /CREATE TRIGGER trg_detection_results_reject_adverse_actions[\s\S]*END$/);
  assert.match(statements[2], /CREATE TRIGGER trg_detection_results_create_signal[\s\S]*END$/);
  assert.match(statements[3], /CREATE TRIGGER trg_detection_signals_no_update[\s\S]*DETECTION_SIGNAL_IMMUTABLE$/);
  assert.match(statements[4], /CREATE TRIGGER trg_detection_signals_no_delete[\s\S]*DETECTION_SIGNAL_IMMUTABLE$/);
  assert.match(statements[5], /CREATE TRIGGER trg_shared_registry_block_direct_active_publication[\s\S]*END$/);
  assert.match(statements[6], /UPDATE data_plane_metadata[\s\S]*migration_version = GREATEST\(migration_version, 16\)/);

  for (const statement of statements) {
    assert.doesNotMatch(statement, /^\s*DELIMITER\b/im);
  }
});

test("semicolons inside trigger bodies do not create truncated statements", () => {
  const statements = splitOperationalMigrationStatements(`
    DELIMITER $$
    CREATE TRIGGER sample BEFORE INSERT ON example
    FOR EACH ROW
    BEGIN
      IF NEW.status = 'ACTIVE' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'BLOCKED';
      END IF;
    END$$
    DELIMITER ;
    UPDATE metadata SET version = 17;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /SET MESSAGE_TEXT = 'BLOCKED';[\s\S]*END IF;[\s\S]*END$/);
  assert.match(statements[1], /^UPDATE metadata SET version = 17$/);
});
