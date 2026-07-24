import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneService } from "../src/index.js";

function activationFixture({ adminReady = 1 } = {}) {
  const auditEvents = [];
  const mutations = [];
  const gateQueries = [];

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},

    async execute(sql, parameters) {
      gateQueries.push({ sql, parameters });

      return [[{
        schema_ready: 1,
        worker_ready: 1,
        storage_ready: 1,
        admin_ready: adminReady,
      }], []];
    },
  };

  const pool = {
    async getConnection() {
      return connection;
    },
  };

  const repositories = {
    organisations: {
      async getById() {
        return {
          organisationId: "org-ubuntu",
          organisationType: "medical_scheme",
          status: "ready_for_activation",
        };
      },

      async updateStatus(organisationId, status) {
        mutations.push(["organisation", organisationId, status]);

        return {
          organisationId,
          organisationType: "medical_scheme",
          status,
          activationState: "activated",
        };
      },
    },

    routes: {
      async getInternalLatestReadyForOrganisation() {
        return {
          route_id: "route-ubuntu",
          route_type: "private_database",
          schema_version: "14",
        };
      },

      async activate(routeId, organisationId) {
        mutations.push(["route", routeId, organisationId]);

        return {
          routeId,
          organisationId,
          routeType: "private_database",
          schemaVersion: "14",
          provisioningStatus: "active",
        };
      },
    },

    security: {
      async recordPlatformAudit(event) {
        auditEvents.push(event);
      },
    },
  };

  return {
    service: createControlPlaneService({ pool, repositories }),
    auditEvents,
    mutations,
    gateQueries,
  };
}

test("organisation activation requires a usable scheme administrator credential", async () => {
  const {
    service,
    auditEvents,
    mutations,
    gateQueries,
  } = activationFixture();

  const result = await service.activateOrganisation(
    "org-ubuntu",
    {
      type: "user",
      id: "platform-admin-1",
      source: "test",
    },
  );

  assert.equal(result.organisation.status, "active");
  assert.equal(result.route.schemaVersion, "14");
  assert.equal(gateQueries.length, 1);

  const sql = gateQueries[0].sql;

  assert.match(sql, /JOIN users u/);
  assert.match(sql, /u\.status\s*=\s*'active'/);
  assert.match(sql, /JOIN credential_identities c/);
  assert.match(sql, /c\.authentication_provider\s*=\s*'local_password'/);
  assert.match(sql, /c\.status\s*=\s*'active'/);
  assert.match(sql, /c\.password_hash\s+IS NOT NULL/);
  assert.match(sql, /r\.role_key\s*=\s*'scheme_administrator'/);

  assert.deepEqual(
    gateQueries[0].parameters,
    [
      "org-ubuntu",
      "route-ubuntu",
      "14",
      "14",
      "org-ubuntu",
      "org-ubuntu",
      "org-ubuntu",
    ],
  );

  assert.deepEqual(
    mutations,
    [
      ["route", "route-ubuntu", "org-ubuntu"],
      ["organisation", "org-ubuntu", "active"],
    ],
  );

  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, "organisation.activate");
});

test("organisation activation fails closed when administrator credential is unusable", async () => {
  const {
    service,
    auditEvents,
    mutations,
  } = activationFixture({ adminReady: 0 });

  await assert.rejects(
    () => service.activateOrganisation(
      "org-ubuntu",
      {
        type: "user",
        id: "platform-admin-1",
        source: "test",
      },
    ),
    (error) => {
      assert.equal(error.code, "ACTIVATION_GATES_FAILED");
      assert.equal(error.status, 409);
      return true;
    },
  );

  assert.deepEqual(mutations, []);
  assert.deepEqual(auditEvents, []);
});
