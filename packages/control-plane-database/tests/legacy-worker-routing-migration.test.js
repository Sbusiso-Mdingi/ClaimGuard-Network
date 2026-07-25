import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/0011_backfill_legacy_report_worker_routing.sql",
  import.meta.url,
);

test("legacy report-worker routing backfill is limited to active compatible routes", async () => {
  const sql = (await readFile(migrationUrl, "utf8"))
    .replace(/\s+/g, " ")
    .trim();

  assert.match(sql, /INSERT INTO worker_routing_status/i);
  assert.match(sql, /'report-worker'/i);
  assert.match(sql, /'ready'/i);
  assert.match(sql, /organisations\.organisation_type = 'medical_scheme'/i);
  assert.match(sql, /organisations\.status = 'active'/i);
  assert.match(sql, /organisations\.activation_state = 'activated'/i);
  assert.match(sql, /data_plane_routes\.route_type = 'legacy_shared'/i);
  assert.match(sql, /data_plane_routes\.provisioning_status = 'active'/i);
  assert.match(sql, /data_plane_routes\.schema_version = '14'/i);
  assert.match(sql, /data_plane_routes\.retired_at IS NULL/i);
  assert.match(sql, /health_status NOT IN \('suspended', 'unreachable'\)/i);
  assert.match(sql, /ON DUPLICATE KEY UPDATE status = 'ready'/i);
});
