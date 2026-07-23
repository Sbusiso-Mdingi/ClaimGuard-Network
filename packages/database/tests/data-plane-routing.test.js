import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaimIngestionRepository,
  createDataPlaneContext,
  createInvestigationRepository,
  createLegacySharedAdapter,
  createOperationalRepositories,
  createTenantConnectionManager,
  dataPlanePoolKey,
  runWithTenantContext,
} from "../src/index.js";

function context(overrides = {}) {
  return createDataPlaneContext({
    organisationId: "org-alpha", organisationType: "medical_scheme", organisationStatus: "active",
    operationalTenantId: "tenant-alpha", operationalTenantSlug: "alpha", routeId: "route-alpha",
    routeType: "legacy_shared", routeGeneration: 1, logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational", schemaVersion: "13", deploymentClass: "demo", correlationId: "corr",
    ...overrides,
  });
}

function fakePool(id, metadata = {}) {
  return {
    id, closed: false,
    async execute(sql) {
      if (sql.includes("data_plane_metadata")) return [[{
        database_mode: "legacy_shared", logical_database_identifier: "legacy-operational-shared",
        schema_version: "13", environment_key: "legacy", migration_version: 13, ...metadata,
      }], []];
      return [[], []];
    },
    async query() { return [[], []]; },
    async getConnection() { return { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, execute: this.execute }; },
    async end() { this.closed = true; },
  };
}

test("DataPlaneContext is immutable, secret-free, and keyed by immutable route identity", () => {
  const value = context();
  assert.equal(Object.isFrozen(value), true);
  assert.equal(value.organisationId, "org-alpha");
  assert.equal(value.operationalTenantId, "tenant-alpha");
  assert.equal(Object.hasOwn(value, "secretReference"), false);
  assert.equal(Object.hasOwn(value, "connectionString"), false);
  assert.equal(dataPlanePoolKey(value), "org-alpha:route-alpha:1");
  assert.throws(() => createDataPlaneContext({ ...value, organisationId: "", operationalTenantSlug: "alpha" }), /organisationId/);
});

test("platform_none context cannot construct private operational repositories", () => {
  const platform = createDataPlaneContext({
    organisationId: "org-platform", organisationType: "platform", organisationStatus: "active",
    routeId: "route-platform", routeType: "platform_none", routeGeneration: 1,
    logicalDatabaseIdentifier: "platform-control-plane", deploymentClass: "demo",
  });
  assert.equal(platform.operationalTenantId, null);
  assert.throws(() => createOperationalRepositories(platform, fakePool("platform")), /no private operational data plane/);
});

test("manager isolates organisations on one physical adapter, deduplicates same-key creation, and rotates generations", async () => {
  let creations = 0;
  const pools = [];
  const adapter = {
    async create() { const pool = fakePool(`pool-${++creations}`); pools.push(pool); return pool; },
    async verify() { return { schemaVersion: "13" }; },
    async close(pool) { await pool.end(); },
  };
  const manager = createTenantConnectionManager({ adapters: { legacy_shared: adapter }, maxPools: 4 });
  const alpha = context();
  const [a1, a2] = await Promise.all([manager.acquire(alpha), manager.acquire(alpha)]);
  assert.equal(a1.pool, a2.pool);
  assert.equal(creations, 1);
  const beta = await manager.acquire(context({
    organisationId: "org-beta", operationalTenantId: "tenant-beta", operationalTenantSlug: "beta", routeId: "route-beta",
  }));
  assert.notEqual(beta.pool, a1.pool);
  const alphaV2 = await manager.acquire(context({ routeGeneration: 2 }));
  assert.notEqual(alphaV2.pool, a1.pool);
  assert.equal(manager.metrics().pools.some((entry) => entry.organisationId === "org-beta"), true);
  await a1.release();
  assert.equal(pools[0].closed, false);
  await a2.release();
  assert.equal(pools[0].closed, true);
  await Promise.all([beta.release(), alphaV2.release()]);
  await manager.invalidateOrganisation("org-alpha", "suspended");
  assert.equal(manager.metrics().pools.some((entry) => entry.organisationId === "org-alpha"), false);
  assert.equal(manager.metrics().pools.some((entry) => entry.organisationId === "org-beta"), true);
  await assert.rejects(
    () => manager.acquire(alpha),
    (error) => error.code === "DATA_PLANE_ROUTE_GENERATION_STALE",
  );
});

test("a late old-generation creation cannot publish after a newer generation is observed", async () => {
  let releaseOldCreation;
  const oldCreationHeld = new Promise((resolve) => { releaseOldCreation = resolve; });
  const pools = [];
  const adapter = {
    async create(ctx) {
      if (ctx.routeGeneration === 1) await oldCreationHeld;
      const pool = fakePool(`generation-${ctx.routeGeneration}`);
      pools.push(pool);
      return pool;
    },
    async verify() { return { schemaVersion: "13" }; },
    async close(pool) { await pool.end(); },
  };
  const manager = createTenantConnectionManager({ adapters: { legacy_shared: adapter } });
  const oldAcquire = manager.acquire(context());
  await new Promise((resolve) => setImmediate(resolve));
  const current = await manager.acquire(context({ routeGeneration: 2 }));
  releaseOldCreation();
  await assert.rejects(oldAcquire, (error) => error.code === "DATA_PLANE_ROUTE_GENERATION_STALE");
  assert.equal(pools.find((pool) => pool.id === "generation-1").closed, true);
  assert.deepEqual(manager.metrics().pools.map((entry) => entry.routeGeneration), [2]);
  await current.release();
});

test("pool limit, idle eviction, and tenant-specific creation failure fail closed without poisoning another tenant", async () => {
  let clock = 0;
  const adapter = {
    async create(ctx) { if (ctx.organisationId === "org-alpha") throw Object.assign(new Error("alpha unavailable"), { code: "ALPHA_DOWN" }); return fakePool(ctx.organisationId); },
    async verify() { return { schemaVersion: "13" }; },
    async close(pool) { await pool.end(); },
  };
  const manager = createTenantConnectionManager({ adapters: { legacy_shared: adapter }, maxPools: 1, idleTimeoutMs: 10, now: () => clock });
  await assert.rejects(() => manager.acquire(context()), /alpha unavailable/);
  const beta = await manager.acquire(context({ organisationId: "org-beta", operationalTenantId: "tenant-beta", operationalTenantSlug: "beta", routeId: "route-beta" }));
  await assert.rejects(() => manager.acquire(context({
    organisationId: "org-gamma", operationalTenantId: "tenant-gamma", operationalTenantSlug: "gamma", routeId: "route-gamma",
  })), (error) => error.code === "DATA_PLANE_POOL_LIMIT");
  await beta.release();
  clock = 11;
  assert.equal(await manager.evictIdle(), 1);
  assert.equal(manager.metrics().cachedPools, 0);
});

test("pool creation and active-request drain timeouts apply backpressure", async () => {
  const slowManager = createTenantConnectionManager({
    adapters: { legacy_shared: {
      async create() { return new Promise((resolve) => setTimeout(() => resolve(fakePool("late")), 20)); },
      async verify() { return { schemaVersion: "13" }; }, async close(pool) { await pool.end(); },
    } },
    creationTimeoutMs: 2,
  });
  await assert.rejects(() => slowManager.acquire(context()), (error) => error.code === "DATA_PLANE_POOL_CREATION_TIMEOUT");

  const manager = createTenantConnectionManager({
    adapters: { legacy_shared: {
      async create() { return fakePool("active"); }, async verify() { return { schemaVersion: "13" }; }, async close(pool) { await pool.end(); },
    } },
    drainTimeoutMs: 2,
  });
  const lease = await manager.acquire(context());
  await assert.rejects(() => manager.invalidateOrganisation("org-alpha", "suspended"), (error) => error.code === "DATA_PLANE_POOL_DRAIN_TIMEOUT");
  await lease.release();
  assert.equal(manager.metrics().cachedPools, 0);
});

test("legacy_shared adapter verifies metadata before publication and closes mismatched pools", async () => {
  const created = [];
  const adapter = createLegacySharedAdapter({
    databaseUrl: "mysql://user:pass@localhost/operational",
    poolFactory() { const pool = fakePool(`pool-${created.length + 1}`); created.push(pool); return pool; },
  });
  const pool = await adapter.create(context());
  const verified = await adapter.verify(pool, context());
  assert.equal(verified.schemaVersion, "13");

  const badAdapter = createLegacySharedAdapter({
    databaseUrl: "mysql://user:pass@localhost/operational",
    poolFactory() { const bad = fakePool("bad", { environment_key: "wrong" }); created.push(bad); return bad; },
  });
  const manager = createTenantConnectionManager({ adapters: { legacy_shared: badAdapter } });
  await assert.rejects(() => manager.acquire(context()), (error) => error.code === "DATA_PLANE_ENVIRONMENT_MISMATCH");
  assert.equal(created.at(-1).closed, true);
  assert.equal(manager.metrics().cachedPools, 0);

  const wrongMigrationAdapter = createLegacySharedAdapter({
    databaseUrl: "mysql://user:pass@localhost/operational",
    poolFactory() { return fakePool("wrong-migration", { migration_version: 7 }); },
  });
  const wrongMigrationManager = createTenantConnectionManager({ adapters: { legacy_shared: wrongMigrationAdapter } });
  await assert.rejects(
    () => wrongMigrationManager.acquire(context()),
    (error) => error.code === "DATA_PLANE_MIGRATION_VERSION_MISMATCH",
  );
  assert.equal(wrongMigrationManager.metrics().cachedPools, 0);
});

test("explicit repository factory pins canonical tenant even when AsyncLocalStorage disagrees", async () => {
  const pool = fakePool("repo");
  const executions = [];
  pool.execute = async (_sql, params = []) => { executions.push(params); return [[], []]; };
  const repositories = createOperationalRepositories(context(), pool);
  assert.equal(repositories.dataPlaneContext.operationalTenantId, "tenant-alpha");
  await assert.rejects(
    () => repositories.fraudWorkflow.confirmFraud({
      tenantId: "tenant-beta", investigationId: "inv-1", reason: "reason", actorId: "actor", actorRole: "investigator",
      correlationId: "corr",
    }),
    (error) => error.code === "data_plane_tenant_mismatch",
  );
  await runWithTenantContext({ tenant_id: "tenant-beta" }, () => repositories.members.getById("member-1"));
  assert.deepEqual(executions.at(-1), ["member-1", "tenant-alpha"]);
  assert.throws(() => createOperationalRepositories(null, pool), /required/);
  assert.throws(() => createClaimIngestionRepository(pool), (error) => error.code === "DATA_PLANE_CONTEXT_REQUIRED");
  assert.throws(() => createInvestigationRepository(pool), (error) => error.code === "DATA_PLANE_CONTEXT_REQUIRED");
});
