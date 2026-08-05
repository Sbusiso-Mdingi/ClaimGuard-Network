import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { splitOperationalMigrationStatements } from "../src/migrate.js";

const migrationUrl = new URL(
  "../migrations/0016_domain_safety_foundation.sql",
  import.meta.url,
);
const migration = await readFile(migrationUrl, "utf8");

function assertCompleteSignalTrigger(statement, {
  triggerName,
  event,
  tableName,
  message,
}) {
  assert.match(statement, new RegExp(`^CREATE TRIGGER ${triggerName}\\b`));
  assert.match(statement, new RegExp(`\\b${event} ON ${tableName}\\b`));
  assert.match(statement, /SIGNAL SQLSTATE '45000'/);
  assert.match(statement, new RegExp(`SET MESSAGE_TEXT = '${message}'`));
  assert.doesNotMatch(statement, /^\s*(?:BEGIN|END|SIGNAL|SET)\b\s*$/);
}

test("schema 16 delimiter blocks become complete executable trigger statements", () => {
  const statements = splitOperationalMigrationStatements(migration);

  assert.equal(statements.length, 7);
  assert.equal(statements.every((statement) => Boolean(statement.trim())), true);
  assert.match(statements[0], /^-- Sequrin PR 1:[\s\S]*CREATE TABLE detection_signals/);

  assertCompleteSignalTrigger(statements[1], {
    triggerName: "trg_detection_results_reject_adverse_actions",
    event: "BEFORE INSERT",
    tableName: "claim_detection_results",
    message: "DETECTION_ADVERSE_ACTION_PROHIBITED",
  });
  assert.match(statements[1], /BEGIN[\s\S]*END$/);

  assert.match(statements[2], /^CREATE TRIGGER trg_detection_results_create_signal\b/);
  assert.match(statements[2], /AFTER INSERT ON claim_detection_results/);
  assert.match(statements[2], /BEGIN[\s\S]*INSERT INTO detection_signals[\s\S]*END$/);

  assertCompleteSignalTrigger(statements[3], {
    triggerName: "trg_detection_signals_no_update",
    event: "BEFORE UPDATE",
    tableName: "detection_signals",
    message: "DETECTION_SIGNAL_IMMUTABLE",
  });
  assertCompleteSignalTrigger(statements[4], {
    triggerName: "trg_detection_signals_no_delete",
    event: "BEFORE DELETE",
    tableName: "detection_signals",
    message: "DETECTION_SIGNAL_IMMUTABLE",
  });

  assertCompleteSignalTrigger(statements[5], {
    triggerName: "trg_shared_registry_block_direct_active_publication",
    event: "BEFORE INSERT",
    tableName: "shared_fraud_registry_entries",
    message: "DIRECT_ACTIVE_REGISTRY_PUBLICATION_PROHIBITED",
  });
  assert.match(statements[5], /BEGIN[\s\S]*END$/);

  assert.match(statements[6], /UPDATE data_plane_metadata[\s\S]*migration_version = GREATEST\(migration_version, 16\)/);

  for (const statement of statements) {
    assert.doesNotMatch(statement, /^\s*DELIMITER\b/im);
    assert.doesNotMatch(statement, /^\s*(?:BEGIN|END|SIGNAL|SET)\b\s*$/);
  }
});

test("semicolons inside compound trigger bodies do not create truncated statements", () => {
  const statements = splitOperationalMigrationStatements(`
    DELIMITER $$
    CREATE TRIGGER sample BEFORE INSERT ON example
    FOR EACH ROW
    BEGIN
      IF NEW.status = 'ACTIVE;PENDING' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT = 'BLOCKED; GOVERNED';
      END IF;
    END$$
    DELIMITER ;
    UPDATE metadata SET version = 17;
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TRIGGER sample BEFORE INSERT ON example/);
  assert.match(statements[0], /NEW\.status = 'ACTIVE;PENDING'/);
  assert.match(statements[0], /SET MESSAGE_TEXT = 'BLOCKED; GOVERNED';[\s\S]*END IF;[\s\S]*END$/);
  assert.match(statements[1], /^UPDATE metadata SET version = 17$/);
});

test("comments, quoted semicolons and alternate delimiters remain safe", () => {
  const statements = splitOperationalMigrationStatements(`
    -- delimiter-like text in a comment: DELIMITER ;;
    DELIMITER //
    CREATE TRIGGER alternate BEFORE UPDATE ON example
    FOR EACH ROW
    BEGIN
      # A comment containing ; and // must not split SQL.
      SET @message = 'one;two//three';
      /* block comment with ; and // */
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'ALTERNATE;BLOCKED';
    END//
    DELIMITER ;
    SELECT 'safe;value';
  `);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /^-- delimiter-like text[\s\S]*CREATE TRIGGER alternate/);
  assert.match(statements[0], /SET @message = 'one;two\/\/three';/);
  assert.match(statements[0], /SET MESSAGE_TEXT = 'ALTERNATE;BLOCKED';[\s\S]*END$/);
  assert.equal(statements[1], "SELECT 'safe;value'");
  assert.equal(statements.some((statement) => /^\s*DELIMITER\b/im.test(statement)), false);
});
