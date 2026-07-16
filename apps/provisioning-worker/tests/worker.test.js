import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { REQUIRED_STEPS } from "../src/worker.js";

test("required provisioning steps include phase 11E activation gate sequence", () => {
  assert.deepEqual(REQUIRED_STEPS, [
    "validate_request",
    "reserve_slug",
    "create_organisation_record",
    "allocate_database_name",
    "create_database",
    "create_database_principal",
    "store_secret_references",
    "apply_tenant_schema",
    "write_data_plane_metadata",
    "verify_database_isolation",
    "create_report_partition",
    "register_worker_routing",
    "register_private_route",
    "create_initial_scheme_admin",
    "run_activation_checks",
    "ready_for_activation",
  ]);
});

test("private schema baseline includes data-plane metadata and outbox tables", async () => {
  const sql = await readFile(new URL("../src/private-schema-baseline.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS data_plane_metadata/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS claim_processing_outbox/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS trust_publication_outbox/i);
  assert.doesNotMatch(sql, /control_plane_users|login_sessions|platform_audit_events/i);
});
