import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneDataPlaneRouteResolver } from "../src/data-plane-route-resolver.js";

function fixture({ organisation = {}, routes = null, mapping = undefined } = {}) {
  const resolvedOrganisation = {
    organisationId: "org-alpha", organisationType: "medical_scheme", status: "active",
    activationState: "activated", deploymentClass: "demo", ...organisation,
  };
  const resolvedRoutes = routes ?? [{
    route_id: "route-alpha", organisation_id: "org-alpha", route_type: "legacy_shared",
    logical_database_identifier: "legacy-operational-shared", database_name: "operational",
    route_generation: 3, schema_version: "10", provisioning_status: "active", health_status: "healthy",
    retired_at: null, region: "za-north",
  }];
  const resolvedMapping = mapping === undefined ? {
    mappingId: "mapping-alpha", organisationId: "org-alpha", legacyTenantId: "tenant-alpha",
    legacyTenantSlug: "alpha", migrationStatus: "verified", routeId: "route-alpha", verifiedAt: new Date(),
  } : mapping;
  return createControlPlaneDataPlaneRouteResolver({ repositories: {
    organisations: { async getById() { return resolvedOrganisation; } },
    routes: { async listInternalActiveForOrganisation() { return resolvedRoutes; } },
    legacyMappings: { async getByOrganisationId() { return resolvedMapping; } },
  } });
}

test("active medical-scheme route resolves canonical immutable DataPlaneContext", async () => {
  const context = await fixture().resolve({ organisationId: "org-alpha", actorId: "user-alpha", correlationId: "corr" });
  assert.equal(context.organisationId, "org-alpha");
  assert.equal(context.operationalTenantId, "tenant-alpha");
  assert.equal(context.routeId, "route-alpha");
  assert.equal(context.routeGeneration, 3);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.hasOwn(context, "secretReference"), false);
});

test("route resolution fails closed for no route, multiple routes, suspension, retirement, unsupported type/schema, and missing mapping", async () => {
  const baseRoute = {
    route_id: "route-alpha", organisation_id: "org-alpha", route_type: "legacy_shared",
    logical_database_identifier: "legacy-operational-shared", route_generation: 1, schema_version: "10",
    provisioning_status: "active", health_status: "healthy", retired_at: null,
  };
  const cases = [
    fixture({ routes: [] }),
    fixture({ routes: [baseRoute, { ...baseRoute, route_id: "route-2", route_generation: 2 }] }),
    fixture({ organisation: { status: "suspended" } }),
    fixture({ routes: [{ ...baseRoute, retired_at: new Date() }] }),
    fixture({ routes: [{ ...baseRoute, schema_version: "999" }] }),
    fixture({ mapping: null }),
  ];
  for (const resolver of cases) {
    await assert.rejects(() => resolver.resolve({ organisationId: "org-alpha" }), (error) => error.status === 503 && error.code.startsWith("DATA_PLANE_"));
  }
});

test("platform organisation resolves platform_none without operational tenant", async () => {
  const resolver = fixture({
    organisation: { organisationId: "org-platform", organisationType: "platform" },
    routes: [{
      route_id: "route-platform", organisation_id: "org-platform", route_type: "platform_none",
      logical_database_identifier: "platform-control-plane", route_generation: 1,
      provisioning_status: "active", health_status: "healthy", retired_at: null,
    }],
    mapping: null,
  });
  const context = await resolver.resolve({ organisationId: "org-platform" });
  assert.equal(context.routeType, "platform_none");
  assert.equal(context.operationalTenantId, null);
  assert.equal(context.databaseName, null);
});

test("private route resolves organisation-scoped operational tenant identity", async () => {
  const resolver = fixture({
    organisation: {
      organisationId: "org-private",
      canonicalSlug: "discovery-health",
    },
    routes: [{
      route_id: "route-private",
      organisation_id: "org-private",
      route_type: "private_database",
      logical_database_identifier: "private:org-private",
      database_name: "claimguard_tenant_discovery_health",
      route_generation: 1,
      schema_version: "10",
      provisioning_status: "active",
      health_status: "healthy",
      retired_at: null,
      region: "za-north",
    }],
    mapping: null,
  });

  const context = await resolver.resolve({ organisationId: "org-private" });
  assert.equal(context.routeType, "private_database");
  assert.equal(context.operationalTenantId, "org-private");
  assert.equal(context.operationalTenantSlug, "discovery-health");
});
