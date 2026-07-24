import assert from "node:assert/strict";
import test from "node:test";

import {
  compareLegacyTenantInventory,
  createControlPlaneService,
  readLegacyTenantInventory,
} from "../src/index.js";

function transactionPool() {
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  };
  return { async getConnection() { return connection; }, connection };
}

function serviceFixture({ membershipStatus = "active", organisationType = "medical_scheme", roleScope = "medical_scheme" } = {}) {
  const pool = transactionPool();
  const audit = [];
  const repositories = {
    organisations: {
      async createDraft(input) { return { ...input, organisationId: "org-1", status: "draft" }; },
      async getById() { return { organisationId: "org-1", organisationType, status: "draft" }; },
      async updateStatus(_id, status) { return { organisationId: "org-1", organisationType, status }; },
      async reserveSlug(slug, options) { return options.redirectToSlug ? slug.toLowerCase() : slug.toLowerCase(); },
    },
    identity: {
      async createMembership(input) { return { ...input, membershipId: "membership-1", status: input.status || "invited" }; },
      async getMembership() { return { membershipId: "membership-1", organisationId: "org-1", status: membershipStatus }; },
      async resolveRole(roleKey) { return { roleId: roleKey, roleKey, organisationScope: roleScope }; },
      async assignRole(input) { return input; },
    },
    routes: { async register(input) { return { ...input, routeId: "route-1", routeGeneration: 1, provisioningStatus: "pending" }; } },
    legacyMappings: { async create(input) { return { ...input, mappingId: "mapping-1" }; } },
    provisioning: {
      async getOperation() { return { operationId: "operation-1", status: "pending" }; },
      async transitionOperation(_id, _from, status) { return { operationId: "operation-1", status }; },
    },
    security: { async recordPlatformAudit(input) { audit.push(input); } },
  };
  return { service: createControlPlaneService({ pool, repositories }), audit };
}

test("organisation lifecycle is explicit and audited", async () => {
  const { service, audit } = serviceFixture();
  const created = await service.createDraftOrganisation({
    displayName: "Alpha", canonicalSlug: "alpha", organisationType: "medical_scheme", deploymentClass: "demo",
  });
  assert.equal(created.status, "draft");
  const provisioning = await service.transitionOrganisation("org-1", "provisioning");
  assert.equal(provisioning.status, "provisioning");
  await assert.rejects(() => service.transitionOrganisation("org-1", "active"), /cannot transition/);
  assert.equal(audit.length, 2);
});

test(
  "organisation activation accepts the canonical schema-14 private route",
  async () => {
    const gateQueries =
      [];

    const connection = {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},

      async execute(
        sql,
        parameters,
      ) {
        gateQueries.push(
          {
            sql,
            parameters,
          },
        );

        return [
          [
            {
              schema_ready: 1,
              worker_ready: 1,
              storage_ready: 1,
              admin_ready: 1,
            },
          ],
          [],
        ];
      },
    };

    const pool = {
      async getConnection() {
        return connection;
      },
    };

    const auditEvents =
      [];

    const repositories = {
      organisations: {
        async getById() {
          return {
            organisationId:
              "org-14",

            organisationType:
              "medical_scheme",

            status:
              "ready_for_activation",
          };
        },

        async updateStatus(
          organisationId,
          status,
        ) {
          return {
            organisationId,
            organisationType:
              "medical_scheme",
            status,
            activationState:
              "activated",
          };
        },
      },

      routes: {
        async getInternalLatestReadyForOrganisation() {
          return {
            route_id:
              "route-14",

            route_type:
              "private_database",

            schema_version:
              "14",
          };
        },

        async activate(
          routeId,
          organisationId,
        ) {
          return {
            routeId,
            organisationId,
            routeType:
              "private_database",

            schemaVersion:
              "14",

            provisioningStatus:
              "active",
          };
        },
      },

      security: {
        async recordPlatformAudit(
          event,
        ) {
          auditEvents.push(
            event,
          );
        },
      },
    };

    const service =
      createControlPlaneService(
        {
          pool,
          repositories,
        },
      );

    const result =
      await service
        .activateOrganisation(
          "org-14",
          {
            type:
              "user",

            id:
              "platform-admin-1",

            source:
              "test",
          },
        );

    assert.equal(
      result
        .organisation
        .status,
      "active",
    );

    assert.equal(
      result
        .route
        .schemaVersion,
      "14",
    );

    assert.equal(
      gateQueries.length,
      1,
    );

    assert.deepEqual(
      gateQueries[0]
        .parameters,
      [
        "org-14",
        "route-14",
        "14",
        "14",
        "org-14",
        "org-14",
        "org-14",
      ],
    );

    assert.match(
      gateQueries[0].sql,
      /expected_schema_version\s*=\s*\?/,
    );

    assert.match(
      gateQueries[0].sql,
      /observed_schema_version\s*=\s*\?/,
    );

    assert.equal(
      auditEvents.length,
      1,
    );

    assert.equal(
      auditEvents[0].action,
      "organisation.activate",
    );
  },
);

test("slug reservation and alias creation are explicit and audited", async () => {
  const { service, audit } = serviceFixture();
  const reserved = await service.reserveSlug({ slug: "Future-Scheme", slugType: "reserved" });
  const alias = await service.reserveSlug({
    slug: "alpha-old", slugType: "alias", organisationId: "org-1", redirectToSlug: "alpha",
  });
  assert.equal(reserved, "future-scheme");
  assert.equal(alias, "alpha-old");
  assert.equal(audit.filter((event) => event.action === "organisation_slug.reserve").length, 2);
});

test("inactive membership cannot receive role authority", async () => {
  const { service } = serviceFixture({ membershipStatus: "invited" });
  await assert.rejects(
    () => service.assignMembershipRole({ membershipId: "membership-1", roleKey: "investigator" }),
    /active membership/,
  );
});

test("role scope mismatch and scheme assignment of platform admin are rejected", async () => {
  const mismatched = serviceFixture({ organisationType: "platform", roleScope: "medical_scheme" });
  await assert.rejects(
    () => mismatched.service.assignMembershipRole({ membershipId: "membership-1", roleKey: "investigator" }),
    /scope/,
  );

  const platform = serviceFixture({ organisationType: "platform", roleScope: "platform" });
  await assert.rejects(
    () => platform.service.assignMembershipRole({
      membershipId: "membership-1", roleKey: "platform_administrator", actorRoleKeys: ["scheme_administrator"],
    }),
    /Only a platform administrator/,
  );
});

test("platform organisation accepts only platform_none routes", async () => {
  const { service } = serviceFixture({ organisationType: "platform" });
  await assert.rejects(
    () => service.registerRoute({ organisationId: "org-1", routeType: "legacy_shared" }),
    /platform_none/,
  );
  const route = await service.registerRoute({ organisationId: "org-1", routeType: "platform_none" });
  assert.equal(route.routeType, "platform_none");
});

test("provisioning transitions reject skipped lifecycle states", async () => {
  const { service } = serviceFixture();
  const running = await service.transitionProvisioningOperation("operation-1", "running");
  assert.equal(running.status, "running");
  await assert.rejects(() => service.transitionProvisioningOperation("operation-1", "completed"), /cannot transition/);
});

test("legacy inventory is read-only and reports mappings and conflicts deterministically", async () => {
  const operationalRows = [
    { tenant_id: "tenant_alpha", tenant_slug: "alpha", tenant_name: "Alpha", status: "active" },
    { tenant_id: "tenant_beta", tenant_slug: "beta", tenant_name: "Beta", status: "active" },
  ];
  const before = structuredClone(operationalRows);
  const operationalPool = { async execute(sql) { assert.match(sql, /^SELECT /); return [operationalRows, []]; } };
  const tenants = await readLegacyTenantInventory(operationalPool);
  const report = compareLegacyTenantInventory({
    tenants,
    organisations: [{ organisationId: "org-alpha", canonicalSlug: "alpha" }],
    mappings: [{ legacyTenantId: "tenant_beta", legacyTenantSlug: "wrong-beta", organisationId: "org-beta" }],
  });
  assert.equal(report[0].status, "organisation_exists_unmapped");
  assert.equal(report[1].status, "conflict");
  assert.deepEqual(operationalRows, before);
});

test("legacy inventory applies only unambiguous shadow mappings and leaves conflicts manual", async () => {
  const calls = [];
  const service = {
    async createDraftOrganisation(input) { calls.push(["create", input]); return { organisationId: "org-new" }; },
    async mapLegacyTenant(input) { calls.push(["map", input]); return input; },
  };
  const { applyUnambiguousLegacyMappings } = await import("../src/index.js");
  const results = await applyUnambiguousLegacyMappings({
    deploymentClass: "demo", service, repositories: {},
    report: [
      { tenantId: "tenant-a", tenantSlug: "alpha", tenantName: "Alpha", status: "unmapped", conflicts: [] },
      { tenantId: "tenant-b", tenantSlug: "beta", tenantName: "Beta", status: "conflict", conflicts: ["duplicate_slug"] },
    ],
  });
  assert.deepEqual(calls.map(([operation]) => operation), ["create", "map"]);
  assert.equal(results[0].outcome, "mapped");
  assert.equal(results[1].outcome, "conflict");
});
