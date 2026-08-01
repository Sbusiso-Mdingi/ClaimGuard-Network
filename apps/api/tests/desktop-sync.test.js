import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopSyncService, MAXIMUM_PAGE_SIZE } from "../src/desktop-sync-service.js";

function change(index, resource = "claim") {
  return {
    resource,
    operation: "upsert",
    id: `${resource}-${String(index).padStart(4, "0")}`,
    version: `v${index}`,
    updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
    record: { id: index },
  };
}

function context() {
  return {
    device: { organisationId: "org-alpha" },
    authContext: { organisation_id: "org-alpha" },
    dataPlaneContext: { organisationId: "org-alpha", operationalTenantId: "tenant-alpha" },
  };
}

test("bootstrap and delta pages are bounded and cursor replay is idempotent", async () => {
  const records = Array.from({ length: 620 }, (_, index) => change(index + 1));
  const requestedLimits = [];
  const repository = {
    async listChanges({ watermarks, limit }) {
      requestedLimits.push(limit);
      const after = watermarks?.claims?.id || "";
      const remaining = records.filter((entry) => entry.id > after);
      return { changes: remaining.slice(0, limit), hasMore: remaining.length > limit };
    },
    async currentProjections() { return { dashboard: change(1, "dashboard"), suspiciousNetwork: change(1, "suspicious_network") }; },
  };
  const service = createDesktopSyncService({
    cursorSecret: "cursor-secret-that-is-at-least-thirty-two-bytes-long",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const first = await service.bootstrap({ repository, ...context(), limit: 500, schemaVersion: 1 });
  assert.equal(first.changes.length, MAXIMUM_PAGE_SIZE);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.scope.retentionDays, 90);
  assert.equal(first.scope.activeInvestigationsRegardlessOfAge, true);
  const replayA = await service.changes({ repository, ...context(), cursor: first.cursor, limit: 500, schemaVersion: 1 });
  const replayB = await service.changes({ repository, ...context(), cursor: first.cursor, limit: 500, schemaVersion: 1 });
  assert.deepEqual(replayA.changes, replayB.changes);
  assert.equal(replayA.cursor, replayB.cursor);
  assert.equal(replayA.changes.length, 120);
  assert.deepEqual(requestedLimits, [500, 500, 500]);
});

test("expired cursors require bounded bootstrap recovery", async () => {
  let current = new Date("2026-08-01T00:00:00.000Z");
  const repository = {
    async listChanges() { return { changes: [], hasMore: false }; },
    async currentProjections() { return {}; },
  };
  const service = createDesktopSyncService({
    cursorSecret: "another-cursor-secret-that-is-more-than-thirty-two-bytes",
    cursorLifetimeDays: 1,
    now: () => new Date(current),
  });
  const first = await service.bootstrap({ repository, ...context(), schemaVersion: 1 });
  current = new Date("2026-08-03T00:00:00.000Z");
  await assert.rejects(
    () => service.changes({ repository, ...context(), cursor: first.cursor, schemaVersion: 1 }),
    (error) => error.code === "DESKTOP_CURSOR_EXPIRED" && error.details.recovery === "bootstrap",
  );
});

test("schema and three-way organisation scope mismatches fail before reads", async () => {
  let reads = 0;
  const repository = {
    async listChanges() { reads += 1; return { changes: [], hasMore: false }; },
    async currentProjections() { return {}; },
  };
  const service = createDesktopSyncService({ cursorSecret: "schema-scope-secret-that-is-at-least-thirty-two-bytes" });
  await assert.rejects(
    () => service.bootstrap({ repository, ...context(), schemaVersion: 999 }),
    (error) => error.code === "DESKTOP_SCHEMA_UNSUPPORTED",
  );
  await assert.rejects(
    () => service.bootstrap({
      repository,
      ...context(),
      authContext: { organisation_id: "org-beta" },
      schemaVersion: 1,
    }),
    (error) => error.code === "DESKTOP_ORGANISATION_MISMATCH",
  );
  assert.equal(reads, 0);
});
