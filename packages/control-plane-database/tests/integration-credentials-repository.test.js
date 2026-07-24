import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationCredentialsRepository } from "../src/integration-credentials-repository.js";

const TOKEN_HASH = "a".repeat(64);

function credentialRow(overrides = {}) {
  return {
    integration_credential_id: "credential-1",
    organisation_id: "ubuntu-organisation",
    display_name: "Ubuntu claims server",
    service_actor_id: "ubuntu-claims-server",
    token_prefix: "cg_live_example",
    role_key: "claims_analyst",
    status: "active",
    expires_at: null,
    last_used_at: null,
    last_used_correlation_id: null,
    revoked_at: null,
    created_at: new Date("2026-07-24T00:00:00.000Z"),
    updated_at: new Date("2026-07-24T00:00:00.000Z"),
    organisation_status: "active",
    activation_state: "activated",
    organisation_type: "medical_scheme",
    canonical_slug: "ubuntu-medical-scheme",
    ...overrides,
  };
}

function privateRoute(overrides = {}) {
  return {
    route_id: "route-private-1",
    route_type: "private_database",
    provisioning_status: "active",
    health_status: "healthy",
    retired_at: null,
    active_at: new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

test("active private-database credential resolves to the organisation tenant", async () => {
  const queries = [];
  const executor = {
    async execute(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM organisation_integration_credentials")) {
        return [[credentialRow()]];
      }
      if (sql.includes("FROM data_plane_routes")) {
        return [[privateRoute()]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createIntegrationCredentialsRepository(executor);
  const credential = await repository.resolveActiveByTokenHash(TOKEN_HASH);

  assert.equal(credential?.integrationCredentialId, "credential-1");
  assert.equal(credential?.organisationId, "ubuntu-organisation");
  assert.equal(credential?.tenantId, "ubuntu-organisation");
  assert.equal(queries.length, 2);
});

test("legacy-shared credential still requires and uses its verified mapping", async () => {
  const executor = {
    async execute(sql) {
      if (sql.includes("FROM organisation_integration_credentials")) {
        return [[credentialRow()]];
      }
      if (sql.includes("FROM data_plane_routes")) {
        return [[privateRoute({ route_id: "route-legacy-1", route_type: "legacy_shared" })]];
      }
      if (sql.includes("FROM legacy_tenant_mappings")) {
        return [[{
          legacy_tenant_id: "tenant_ubuntu",
          migration_status: "verified",
          verified_at: new Date("2026-07-24T00:00:00.000Z"),
        }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createIntegrationCredentialsRepository(executor);
  const credential = await repository.resolveActiveByTokenHash(TOKEN_HASH);

  assert.equal(credential?.tenantId, "tenant_ubuntu");
});

test("an unusable active route rejects the integration credential", async () => {
  const executor = {
    async execute(sql) {
      if (sql.includes("FROM organisation_integration_credentials")) {
        return [[credentialRow()]];
      }
      if (sql.includes("FROM data_plane_routes")) {
        return [[privateRoute({ health_status: "unreachable" })]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createIntegrationCredentialsRepository(executor);
  const credential = await repository.resolveActiveByTokenHash(TOKEN_HASH);

  assert.equal(credential, null);
});
