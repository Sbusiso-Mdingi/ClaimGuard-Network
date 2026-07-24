import assert from "node:assert/strict";
import test from "node:test";

import { createRouteAwareAuthenticationRepository } from "../src/route-aware-authentication-repository.js";

function createExecutor(responses) {
  const calls = [];
  return {
    calls,
    async execute(sql, parameters) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), parameters });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected database query.");
      return [response, []];
    },
  };
}

test("private database authentication derives tenant context from the active route", async () => {
  const executor = createExecutor([
    [{
      route_id: "route-private-1",
      route_type: "private_database",
      provisioning_status: "active",
      health_status: "healthy",
      retired_at: null,
      active_at: new Date("2026-07-24T17:00:00.000Z"),
      canonical_slug: "ubuntu-scheme",
    }],
  ]);

  const repository = createRouteAwareAuthenticationRepository(executor);
  const bridge = await repository.getLegacyTenantBridge("org-ubuntu");

  assert.deepEqual(bridge, {
    legacyTenantId: "org-ubuntu",
    legacyTenantSlug: "ubuntu-scheme",
    migrationStatus: "verified",
    verifiedAt: new Date("2026-07-24T17:00:00.000Z"),
    routeType: "private_database",
    routeId: "route-private-1",
  });
  assert.equal(executor.calls.length, 1);
});

test("legacy shared authentication requires one verified mapping for the active route", async () => {
  const executor = createExecutor([
    [{
      route_id: "route-legacy-1",
      route_type: "legacy_shared",
      provisioning_status: "active",
      health_status: "healthy",
      retired_at: null,
      active_at: new Date("2026-07-24T17:00:00.000Z"),
      canonical_slug: "legacy-scheme",
    }],
    [{
      legacy_tenant_id: "tenant-legacy",
      legacy_tenant_slug: "legacy-scheme",
      migration_status: "verified",
      verified_at: new Date("2026-07-23T10:00:00.000Z"),
      route_id: "route-legacy-1",
    }],
  ]);

  const repository = createRouteAwareAuthenticationRepository(executor);
  const bridge = await repository.getLegacyTenantBridge("org-legacy");

  assert.equal(bridge.legacyTenantId, "tenant-legacy");
  assert.equal(bridge.migrationStatus, "verified");
  assert.equal(bridge.routeId, "route-legacy-1");
  assert.equal(executor.calls.length, 2);
});

test("authentication fails closed for ambiguous, unhealthy, or unmapped routes", async () => {
  const ambiguous = createRouteAwareAuthenticationRepository(createExecutor([
    [
      { route_id: "route-1", route_type: "private_database", provisioning_status: "active", health_status: "healthy" },
      { route_id: "route-2", route_type: "private_database", provisioning_status: "active", health_status: "healthy" },
    ],
  ]));
  assert.equal(await ambiguous.getLegacyTenantBridge("org-1"), null);

  const unhealthy = createRouteAwareAuthenticationRepository(createExecutor([
    [{
      route_id: "route-1",
      route_type: "private_database",
      provisioning_status: "active",
      health_status: "unreachable",
      retired_at: null,
      active_at: new Date(),
      canonical_slug: "scheme-one",
    }],
  ]));
  assert.equal(await unhealthy.getLegacyTenantBridge("org-1"), null);

  const unmappedLegacy = createRouteAwareAuthenticationRepository(createExecutor([
    [{
      route_id: "route-legacy",
      route_type: "legacy_shared",
      provisioning_status: "active",
      health_status: "healthy",
      retired_at: null,
      active_at: new Date(),
      canonical_slug: "legacy",
    }],
    [],
  ]));
  assert.equal(await unmappedLegacy.getLegacyTenantBridge("org-legacy"), null);
});
