import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0016_domain_safety_foundation.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");

test("migration creates tenant-scoped immutable SIGNAL_GENERATED records", () => {
  assert.match(migration, /CREATE TABLE detection_signals/);
  assert.match(migration, /UNIQUE KEY uq_detection_signals_result \(tenant_id, claim_id, claim_version\)/);
  assert.match(migration, /CHECK \(signal_state = 'SIGNAL_GENERATED'\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, claim_id, claim_version\)/);
  assert.match(migration, /AFTER INSERT ON claim_detection_results/);
  assert.match(migration, /NEW\.tenant_id/);
  assert.doesNotMatch(migration, /UPDATE claims\s+SET\s+(payment|status)/i);
});

test("prohibited detection commands and direct ACTIVE publication fail closed", () => {
  for (const prohibited of [
    "paymentAction",
    "adjudicationDecision",
    "fraudOutcomeApproval",
    "networkNoticeActivation",
    "registryPublication",
    "contractualSanction",
    "blacklist",
    "confirmedFraud",
    "automaticPaymentPause",
  ]) {
    assert.match(migration, new RegExp(`\\$\\.${prohibited}`));
  }
  assert.match(migration, /DOMAIN_SAFETY_PROHIBITED_DETECTION_COMMAND/);
  assert.match(migration, /IF NEW\.status = 'ACTIVE'/);
  assert.match(migration, /NETWORK_NOTICE_GOVERNANCE_REQUIRED/);
});

test("migration preserves history and advances data-plane compatibility metadata", () => {
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
  assert.match(migration, /schema_version = '16'/);
  assert.match(migration, /migration_version = GREATEST\(migration_version, 16\)/);
});
