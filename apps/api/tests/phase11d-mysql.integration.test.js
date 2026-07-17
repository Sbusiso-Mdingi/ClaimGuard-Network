import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  createLegacySharedAdapter,
  createMysqlConnection,
  createOperationalRepositories,
  createTenantConnectionManager,
  dataPlanePoolKey,
  getOperationalMigrationStatus,
} from "@claimguard/database";
import {
  applyControlPlaneMigrations,
  createControlPlaneAuthenticationService,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
  getControlPlaneMigrationStatus,
  provisionDemoAccounts,
  readLegacyTenantInventory,
} from "@claimguard/control-plane-database";

import { resolveAuthenticationConfiguration } from "../src/authentication-config.js";
import { createBackendApp } from "../src/backend.js";
import { createControlPlaneDataPlaneRouteResolver } from "../src/data-plane-route-resolver.js";
import {
  createLiveDemoBootstrapFromDatabase,
  createLiveDemoSimulator,
} from "../src/simulation/live-demo-simulator.js";
import { createSimulatorWorker } from "../../simulator-worker/src/worker.js";
import { createCanonicalDetectionReport } from "./helpers/detection-report.js";

const controlUrl = process.env.PHASE11D_CONTROL_PLANE_MYSQL_URL || "";
const operationalUrl = process.env.PHASE11D_MYSQL_URL || "";
const enabled = Boolean(controlUrl && operationalUrl);

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

async function seedOperationalFixtures(pool) {
  await pool.execute(
    `INSERT INTO tenants (tenant_id, tenant_slug, tenant_name, status) VALUES
      ('tenant_alpha', 'alpha', 'Tenant Alpha', 'active'),
      ('tenant_beta', 'beta', 'Tenant Beta', 'active')`,
  );
  await pool.execute(
    `INSERT INTO schemes (scheme_id, scheme_name, tenant_id) VALUES
      ('ALPHA01', 'Alpha Scheme', 'tenant_alpha'),
      ('BETA01', 'Beta Scheme', 'tenant_beta')`,
  );
  await pool.execute(
    `INSERT INTO medical_schemes (tenant_id, scheme_id, scheme_name, is_primary) VALUES
      ('tenant_alpha', 'ALPHA01', 'Alpha Scheme', 1),
      ('tenant_beta', 'BETA01', 'Beta Scheme', 1)`,
  );
  await pool.execute(
    `INSERT INTO members
      (member_id, scheme_id, first_name, last_name, date_of_birth, gender, synthetic_id_number,
       synthetic_banking_detail, home_region, home_lat, home_lon, join_date, tenant_id) VALUES
      ('ALPHA-MEMBER-1', 'ALPHA01', 'Alpha', 'Member', '1980-01-01', 'F', 'ALPHA-ID', 'ALPHA-BANK', 'Alpha Region', -26.1, 28.0, '2020-01-01', 'tenant_alpha'),
      ('BETA-MEMBER-1', 'BETA01', 'Beta', 'Member', '1981-01-01', 'M', 'BETA-ID', 'BETA-BANK', 'Beta Region', -33.9, 18.4, '2020-01-01', 'tenant_beta')`,
  );
  await pool.execute(
    `INSERT INTO providers
      (provider_id, scheme_id, practice_number, specialty, practice_name, synthetic_banking_detail,
       practice_region, practice_lat, practice_lon, tenant_id) VALUES
      ('ALPHA-PROVIDER-1', 'ALPHA01', 'ALPHA-PRACTICE', 'GP', 'Alpha Practice', 'ALPHA-PBANK', 'Alpha Region', -26.1, 28.0, 'tenant_alpha'),
      ('BETA-PROVIDER-1', 'BETA01', 'BETA-PRACTICE', 'GP', 'Beta Practice', 'BETA-PBANK', 'Beta Region', -33.9, 18.4, 'tenant_beta')`,
  );
  await pool.execute(
    `INSERT INTO claims
      (claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount, tenant_id) VALUES
      ('ALPHA-CLAIM-1', 'ALPHA01', 'ALPHA-MEMBER-1', 'ALPHA-PROVIDER-1', '2026-07-01', 'GP01', 101.00, 'tenant_alpha'),
      ('ALPHA-CLAIM-2', 'ALPHA01', 'ALPHA-MEMBER-1', 'ALPHA-PROVIDER-1', '2026-07-01', 'GP02', 102.00, 'tenant_alpha'),
      ('BETA-CLAIM-1', 'BETA01', 'BETA-MEMBER-1', 'BETA-PROVIDER-1', '2026-07-01', 'GP01', 202.00, 'tenant_beta')`,
  );
  await pool.execute(
    `INSERT INTO investigations
      (investigation_id, tenant_id, claim_id, assigned_investigator, assigned_by, status, priority) VALUES
      ('ALPHA-INV-1', 'tenant_alpha', 'ALPHA-CLAIM-1', 'alpha-investigator', 'gate', 'OPEN', 'HIGH'),
      ('BETA-INV-1', 'tenant_beta', 'BETA-CLAIM-1', 'beta-investigator', 'gate', 'OPEN', 'HIGH')`,
  );
  await pool.execute(
    `INSERT INTO claim_processing_outbox
      (id, tenant_id, job_type, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, status, available_at) VALUES
      ('ALPHA-OUTBOX-1', 'tenant_alpha', 'report_production', 'claim_batch', 'ALPHA-BATCH', 'ALPHA-CORR', REPEAT('a', 64), '{"claims":[{"claim_id":"ALPHA-CLAIM-1"}]}', 'pending', UTC_TIMESTAMP(3)),
      ('BETA-OUTBOX-1', 'tenant_beta', 'report_production', 'claim_batch', 'BETA-BATCH', 'BETA-CORR', REPEAT('b', 64), '{"claims":[{"claim_id":"BETA-CLAIM-1"}]}', 'pending', UTC_TIMESTAMP(3))`,
  );
  await pool.execute(
    `INSERT INTO simulation_instances
      (id, scope_key, scope_type, tenant_id, mode, status, seed, tick_interval_ms, checkpoint_version, config, created_by) VALUES
      ('tenant_alpha', 'tenant:tenant_alpha', 'tenant', 'tenant_alpha', 'static', 'starting', 42, 1000, 1, '{}', 'gate'),
      ('tenant_beta', 'tenant:tenant_beta', 'tenant', 'tenant_beta', 'static', 'starting', 43, 1000, 1, '{}', 'gate')`,
  );
  await pool.execute(
    `INSERT INTO ledger_entries
      (sequence_number, entry_type, previous_hash, entry_hash, payload, tenant_id) VALUES
      (101, 'GATE_ALPHA', REPEAT('0', 64), REPEAT('c', 64), '{"marker":"ALPHA-LEDGER"}', 'tenant_alpha'),
      (102, 'GATE_BETA', REPEAT('0', 64), REPEAT('d', 64), '{"marker":"BETA-LEDGER"}', 'tenant_beta')`,
  );
  await pool.execute(
    `INSERT INTO ledger_chain_heads (tenant_id, last_sequence_number, last_entry_hash) VALUES
      ('tenant_alpha', 101, REPEAT('c', 64)), ('tenant_beta', 102, REPEAT('d', 64))`,
  );
}

function createAuthenticationService(repositories, configuration) {
  return createControlPlaneAuthenticationService({
    authenticationRepository: repositories.authentication,
    idleTimeoutMs: configuration.idleTimeoutMs,
    absoluteTimeoutMs: configuration.absoluteTimeoutMs,
    throttleWindowMs: configuration.throttle.windowMs,
    throttleMaxAttempts: configuration.throttle.maxAttempts,
    throttleBaseDelayMs: 1,
    throttleMaxDelayMs: 2,
    throttleLockoutMs: configuration.throttle.lockoutMs,
  });
}

async function readSimulatorClaimRows(pool) {
  const [rows] = await pool.execute(
    "SELECT claim_id, tenant_id FROM claims WHERE claim_id LIKE 'SIM-%' ORDER BY claim_id",
  );
  return rows.map((row) => ({ claimId: row.claim_id, tenantId: row.tenant_id }));
}

async function readSimulatorOutboxRows(pool) {
  const [rows] = await pool.execute(
    "SELECT id, tenant_id, payload FROM claim_processing_outbox WHERE payload LIKE '%SIM-%' ORDER BY id",
  );
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    payload: typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload || {}),
  }));
}

function rowsByTenant(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.tenantId)) result.set(row.tenantId, []);
    result.get(row.tenantId).push(row);
  }
  return result;
}

function diffRows(beforeRows, afterRows, keyField) {
  const beforeKeys = new Set(beforeRows.map((row) => row[keyField]));
  return afterRows.filter((row) => !beforeKeys.has(row[keyField]));
}

test("Phase 11D real-MySQL session, isolation, rotation, suspension, platform, and worker-scope gate", { skip: !enabled }, async () => {
  assert.match(new URL(controlUrl).pathname, /cg11d|phase11d/i);
  assert.match(new URL(operationalUrl).pathname, /cg11d|phase11d/i);
  const controlPool = createControlPlanePool(controlUrl);
  const operationalPool = createMysqlConnection(operationalUrl);
  const logs = [];
  let connectionManager;
  try {
    const controlFirst = await applyControlPlaneMigrations(controlPool, { applicationVersion: "phase11d-gate" });
    const controlSecond = await applyControlPlaneMigrations(controlPool, { applicationVersion: "phase11d-gate" });
    const operationalFirst = await applyMigrations(operationalPool, undefined, { applicationVersion: "phase11d-gate" });
    const operationalSecond = await applyMigrations(operationalPool, undefined, { applicationVersion: "phase11d-gate" });
    assert.equal(controlFirst.applied.length, 5);
    assert.equal(controlSecond.applied.length, 0);
    assert.equal(operationalFirst.applied.some(({ id }) => id === "0008_data_plane_metadata"), true);
    assert.equal(operationalSecond.applied.length, 0);
    assert.equal(operationalSecond.appliedStatements, 0);
    assert.equal((await getControlPlaneMigrationStatus(controlPool)).pending.length, 0);
    assert.equal((await getOperationalMigrationStatus(operationalPool)).pending.length, 0);

    await seedOperationalFixtures(operationalPool);
    const controlRepositories = createControlPlaneRepositories(controlPool);
    const controlService = createControlPlaneService({ pool: controlPool, repositories: controlRepositories });
    const inventory = (await readLegacyTenantInventory(operationalPool)).filter(({ tenantId }) => ["tenant_alpha", "tenant_beta"].includes(tenantId));
    const provisioned = await provisionDemoAccounts({
      tenants: inventory,
      repositories: controlRepositories,
      service: controlService,
      executor: controlPool,
      operationalDatabaseName: new URL(operationalUrl).pathname.replace(/^\//, ""),
    });
    const organisations = await controlRepositories.organisations.list();
    const alphaOrganisation = organisations.find(({ canonicalSlug }) => canonicalSlug === "alpha");
    const betaOrganisation = organisations.find(({ canonicalSlug }) => canonicalSlug === "beta");
    const platformOrganisation = organisations.find(({ canonicalSlug }) => canonicalSlug === "claimguard");
    assert.ok(alphaOrganisation && betaOrganisation && platformOrganisation);

    const routeResolver = createControlPlaneDataPlaneRouteResolver({ repositories: controlRepositories });
    const alphaContext = await routeResolver.resolve({ organisationId: alphaOrganisation.organisationId, actorId: "gate-alpha" });
    const betaContext = await routeResolver.resolve({ organisationId: betaOrganisation.organisationId, actorId: "gate-beta" });
    const platformContext = await routeResolver.resolve({ organisationId: platformOrganisation.organisationId, actorId: "gate-platform" });
    assert.equal(alphaContext.operationalTenantId, "tenant_alpha");
    assert.equal(betaContext.operationalTenantId, "tenant_beta");
    assert.notEqual(dataPlanePoolKey(alphaContext), dataPlanePoolKey(betaContext));
    assert.equal(platformContext.routeType, "platform_none");
    assert.equal(platformContext.operationalTenantId, null);

    const adapter = createLegacySharedAdapter({ databaseUrl: operationalUrl });
    connectionManager = createTenantConnectionManager({
      adapters: { legacy_shared: adapter },
      maxPools: 8,
      logger(level, event, details) { logs.push({ level, event, ...details }); },
    });
    const configuration = resolveAuthenticationConfiguration({
      AUTHENTICATION_MODE: "session",
      CONTROL_PLANE_MYSQL_URL: controlUrl,
      DEPLOYMENT_CLASS: "demo",
      SESSION_COOKIE_SECURE: "false",
      AUTH_ALLOWED_ORIGINS: "http://localhost",
    });
    const authenticationService = createAuthenticationService(controlRepositories, configuration);
    const app = createBackendApp({
      authenticationConfiguration: configuration,
      authenticationService,
      controlPlaneConfigurationRepository: controlRepositories.configuration,
      reportStorage: {
        async getLatestReport({ tenantContext }) {
          const tenantId = tenantContext.tenant_id;
          return { report: createCanonicalDetectionReport({ tenantId, version: `${tenantId}-gate` }), metadata: { tenant: tenantId, version: `${tenantId}-gate` } };
        },
        async checkReadiness() { return { reachable: true, available: true }; },
      },
      dataPlaneRuntime: { routeResolver, connectionManager },
    });

    async function login(slug, role) {
      const credential = provisioned.oneTimeCredentials.find((entry) => entry.organisation === slug && entry.role === role);
      assert.ok(credential);
      const response = await app.request("http://localhost/auth/login", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: JSON.stringify({ organisationSlug: slug, username: credential.username, password: credential.password }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return { cookie: cookieFrom(response), csrf: payload.csrfToken, payload };
    }

    async function request(session, path, { method = "GET", body = undefined, extraHeaders = {} } = {}) {
      return app.request(`http://localhost${path}`, {
        method,
        headers: {
          cookie: session.cookie,
          origin: "http://localhost",
          ...(method !== "GET" ? { "x-csrf-token": session.csrf, "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    const alpha = await login("alpha", "investigator");
    const beta = await login("beta", "investigator");
    const alphaClaims = await login("alpha", "claims_analyst");
    const platform = await login("claimguard", "platform_administrator");
    assert.equal(alpha.payload.organisation.organisationId, alphaOrganisation.organisationId);
    assert.equal(beta.payload.organisation.organisationId, betaOrganisation.organisationId);

    const simulatorApiClient = {
      async request({ path, method = "GET", headers = {}, body = null }) {
        const response = await app.request(`http://localhost${path}`, {
          method,
          headers: {
            cookie: alphaClaims.cookie,
            origin: "http://localhost",
            ...(method !== "GET" ? { "x-csrf-token": alphaClaims.csrf, "content-type": "application/json" } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = await response.json().catch(() => null);
        return { status: response.status, json };
      },
    };

    const alphaSimulatorRepository = createOperationalRepositories(alphaContext, operationalPool).simulatorState;
    const createSimulatorFactory = ({ failAfterMutation = false } = {}) => {
      let shouldFail = failAfterMutation;
      return async ({ instance, maxClaimsPerTick }) => {
        const simulator = createLiveDemoSimulator({
          enabled: true,
          mode: instance.mode,
          staticMode: instance.mode === "static",
          seed: instance.seed,
          tickIntervalMs: instance.tickIntervalMs,
          initialCheckpoint: instance.checkpoint,
          maxClaimsPerTick,
          minClaimsPerTick: 1,
          bootstrap: createLiveDemoBootstrapFromDatabase({
            pool: operationalPool,
            configuredTenantIds: ["tenant_alpha"],
            seed: instance.seed,
          }),
          authorityMode: "session",
          apiClient: simulatorApiClient,
        });
        if (!shouldFail) {
          return simulator;
        }
        const originalRunTick = simulator.runTick.bind(simulator);
        simulator.runTick = async () => {
          const output = await originalRunTick();
          if (shouldFail) {
            shouldFail = false;
            throw new Error("response lost after mutation");
          }
          return output;
        };
        return simulator;
      };
    };

    const baselineClaims = await readSimulatorClaimRows(operationalPool);
    const baselineOutbox = await readSimulatorOutboxRows(operationalPool);
    const [tickBeforeRows] = await operationalPool.execute("SELECT tick_number FROM simulation_instances WHERE id = 'tenant_alpha' LIMIT 1");
    const tickBefore = Number(tickBeforeRows[0].tick_number);

    const deterministicTickWorker = createSimulatorWorker({
      repository: alphaSimulatorRepository,
      readiness: async () => true,
      simulatorFactory: createSimulatorFactory(),
      config: {
        instanceId: "tenant_alpha",
        workerId: "phase11d-gate-worker",
        leaseSeconds: 120,
        pollMs: 1,
        maximumTickDurationMs: 60_000,
        maxClaimsPerTick: 1,
        maxOutboxBacklog: 10_000,
        maxActiveInvestigations: 10_000,
      },
      logger() {},
      sleep: async () => {},
    });
    const deterministicTickResult = await deterministicTickWorker.runOneTick();
    assert.equal(deterministicTickResult.executed, true);

    const [tickAfterRows] = await operationalPool.execute("SELECT tick_number FROM simulation_instances WHERE id = 'tenant_alpha' LIMIT 1");
    const tickAfter = Number(tickAfterRows[0].tick_number);
    assert.equal(tickAfter, tickBefore + 1);

    const claimsAfterTick = await readSimulatorClaimRows(operationalPool);
    const outboxAfterTick = await readSimulatorOutboxRows(operationalPool);
    const newClaims = diffRows(baselineClaims, claimsAfterTick, "claimId");
    const newOutbox = diffRows(baselineOutbox, outboxAfterTick, "id");
    const newClaimsByTenant = rowsByTenant(newClaims);
    const newOutboxByTenant = rowsByTenant(newOutbox);
    assert.equal((newClaimsByTenant.get("tenant_alpha") || []).length >= 1, true);
    assert.equal((newClaimsByTenant.get("tenant_beta") || []).length, 0);
    assert.equal((newOutboxByTenant.get("tenant_alpha") || []).length >= 1, true);
    assert.equal((newOutboxByTenant.get("tenant_beta") || []).length, 0);
    for (const claim of newClaimsByTenant.get("tenant_alpha") || []) {
      assert.equal(
        (newOutboxByTenant.get("tenant_alpha") || []).some((row) => String(row.payload || "").includes(claim.claimId)),
        true,
      );
    }

    await operationalPool.execute("UPDATE simulation_instances SET status = 'running' WHERE id = 'tenant_alpha'");
    const [retryTickBeforeRows] = await operationalPool.execute("SELECT tick_number FROM simulation_instances WHERE id = 'tenant_alpha' LIMIT 1");
    const retryTickBefore = Number(retryTickBeforeRows[0].tick_number);
    const retryClaimsBefore = await readSimulatorClaimRows(operationalPool);
    const retryOutboxBefore = await readSimulatorOutboxRows(operationalPool);
    const failingWorker = createSimulatorWorker({
      repository: alphaSimulatorRepository,
      readiness: async () => true,
      simulatorFactory: createSimulatorFactory({ failAfterMutation: true }),
      config: {
        instanceId: "tenant_alpha",
        workerId: "phase11d-gate-worker-failing",
        leaseSeconds: 120,
        pollMs: 1,
        maximumTickDurationMs: 60_000,
        maxClaimsPerTick: 1,
        maxOutboxBacklog: 10_000,
        maxActiveInvestigations: 10_000,
      },
      logger() {},
      sleep: async () => {},
    });
    await assert.rejects(() => failingWorker.runOneTick(), /response lost after mutation/);
    await operationalPool.execute("UPDATE simulation_instances SET status = 'running' WHERE id = 'tenant_alpha'");

    const retryWorker = createSimulatorWorker({
      repository: alphaSimulatorRepository,
      readiness: async () => true,
      simulatorFactory: createSimulatorFactory(),
      config: {
        instanceId: "tenant_alpha",
        workerId: "phase11d-gate-worker-retry",
        leaseSeconds: 120,
        pollMs: 1,
        maximumTickDurationMs: 60_000,
        maxClaimsPerTick: 1,
        maxOutboxBacklog: 10_000,
        maxActiveInvestigations: 10_000,
      },
      logger() {},
      sleep: async () => {},
    });
    const retryResult = await retryWorker.runOneTick();
    assert.equal(retryResult.executed, true);
    const [retryTickRows] = await operationalPool.execute("SELECT tick_number FROM simulation_instances WHERE id = 'tenant_alpha' LIMIT 1");
    assert.equal(Number(retryTickRows[0].tick_number), retryTickBefore + 1);
    const retryClaimsAfter = await readSimulatorClaimRows(operationalPool);
    const retryOutboxAfter = await readSimulatorOutboxRows(operationalPool);
    const retryNewClaims = diffRows(retryClaimsBefore, retryClaimsAfter, "claimId");
    const retryNewOutbox = diffRows(retryOutboxBefore, retryOutboxAfter, "id");
    assert.equal(retryNewClaims.filter((row) => row.tenantId === "tenant_alpha").length, 1);
    assert.equal(retryNewClaims.filter((row) => row.tenantId === "tenant_beta").length, 0);
    assert.equal(retryNewOutbox.filter((row) => row.tenantId === "tenant_alpha").length, 1);
    assert.equal(retryNewOutbox.filter((row) => row.tenantId === "tenant_beta").length, 0);

    const alphaReport = await request(alpha, "/detection/report");
    const betaReport = await request(beta, "/detection/report");
    assert.equal((await alphaReport.json()).report.metadata.tenant.tenantId, "tenant_alpha");
    assert.equal((await betaReport.json()).report.metadata.tenant.tenantId, "tenant_beta");
    assert.equal((await request(alpha, "/investigations/ALPHA-INV-1")).status, 200);
    assert.equal((await request(alpha, "/investigations/BETA-INV-1")).status, 404);
    assert.equal((await request(beta, "/investigations/BETA-INV-1")).status, 200);
    assert.equal((await request(beta, "/investigations/ALPHA-INV-1")).status, 404);
    const alphaLedger = await (await request(alpha, "/ledger/latest")).json();
    const betaLedger = await (await request(beta, "/ledger/latest")).json();
    assert.equal(alphaLedger.entry.tenantId, "tenant_alpha");
    assert.equal(betaLedger.entry.tenantId, "tenant_beta");
    assert.equal((await request(alpha, "/detection/report", { extraHeaders: { "x-claimguard-tenant": "tenant_beta" } })).status, 403);
    assert.equal((await request(platform, "/detection/report")).status, 503);

    const createdInvestigationResponse = await request(alpha, "/investigations", {
      method: "POST",
      body: { claimId: "ALPHA-CLAIM-2", tenantId: "tenant_beta", priority: "NORMAL" },
    });
    assert.equal(createdInvestigationResponse.status, 201);
    assert.equal((await createdInvestigationResponse.json()).investigation.tenantId, "tenant_alpha");
    const ingested = await request(alphaClaims, "/claims/ingest", {
      method: "POST",
      body: { claims: [{
        claim_id: "ALPHA-CLAIM-NEW", scheme_id: "ALPHA01", member_id: "ALPHA-MEMBER-1",
        provider_id: "ALPHA-PROVIDER-1", service_date: "2026-07-02", billing_code: "GP03", amount: 303,
        tenant_id: "tenant_beta",
      }] },
    });
    assert.equal(ingested.status, 202, JSON.stringify(await ingested.clone().json()));

    const alphaClaimsListResponse = await request(alphaClaims, "/claims");
    const alphaClaimsList = await alphaClaimsListResponse.json();
    assert.equal(alphaClaimsListResponse.status, 200);
    assert.equal(alphaClaimsList.available, true);
    assert.equal(alphaClaimsList.claims.some((claim) => claim.claimId.startsWith("ALPHA-")), true);
    assert.equal(alphaClaimsList.claims.some((claim) => claim.claimId.startsWith("BETA-")), false);

    const alphaClaimDetail = await request(alphaClaims, "/claims/ALPHA-CLAIM-1");
    assert.equal(alphaClaimDetail.status, 200);

    const alphaCrossClaimDetail = await request(alphaClaims, "/claims/BETA-CLAIM-1");
    assert.equal(alphaCrossClaimDetail.status, 404);

    const betaCrossClaimDetail = await request(betaClaims, "/claims/ALPHA-CLAIM-1");
    assert.equal(betaCrossClaimDetail.status, 404);

    const crossIngest = await request(alphaClaims, "/claims/ingest", {
      method: "POST",
      body: { claims: [{ claim_id: "BETA-ATTEMPT", scheme_id: "BETA01", member_id: "BETA-MEMBER-1", provider_id: "BETA-PROVIDER-1", service_date: "2026-07-02", billing_code: "X", amount: 1 }] },
    });
    assert.equal(crossIngest.status, 403);

    const [directRows] = await operationalPool.execute(
      `SELECT tenant_id,
        SUM(claim_id LIKE 'ALPHA-%') alpha_claims,
        SUM(claim_id LIKE 'BETA-%') beta_claims
       FROM claims WHERE tenant_id IN ('tenant_alpha','tenant_beta') GROUP BY tenant_id ORDER BY tenant_id`,
    );
    assert.deepEqual(directRows.map((row) => ({ tenant: row.tenant_id, alpha: Number(row.alpha_claims), beta: Number(row.beta_claims) })), [
      { tenant: "tenant_alpha", alpha: 3, beta: 0 },
      { tenant: "tenant_beta", alpha: 0, beta: 1 },
    ]);
    const [newClaimRows] = await operationalPool.execute("SELECT tenant_id FROM claims WHERE claim_id = 'ALPHA-CLAIM-NEW'");
    assert.equal(newClaimRows[0].tenant_id, "tenant_alpha");
    const [crossRows] = await operationalPool.execute("SELECT COUNT(*) count FROM claims WHERE claim_id = 'BETA-ATTEMPT'");
    assert.equal(Number(crossRows[0].count), 0);

    const apiPools = connectionManager.metrics().pools;
    assert.equal(apiPools.some((entry) => entry.organisationId === alphaOrganisation.organisationId), true);
    assert.equal(apiPools.some((entry) => entry.organisationId === betaOrganisation.organisationId), true);
    assert.equal(apiPools.some((entry) => entry.organisationId === platformOrganisation.organisationId), false);

    const alphaHeld = await connectionManager.acquire(alphaContext);
    const betaHeld = await connectionManager.acquire(betaContext);
    await controlPool.execute("UPDATE data_plane_routes SET route_generation = route_generation + 1 WHERE route_id = ?", [alphaContext.routeId]);
    const alphaGenerationTwo = await routeResolver.resolve({ organisationId: alphaOrganisation.organisationId });
    assert.equal(alphaGenerationTwo.routeGeneration, alphaContext.routeGeneration + 1);
    const alphaNew = await connectionManager.acquire(alphaGenerationTwo);
    assert.equal(connectionManager.metrics().pools.some((entry) => entry.routeGeneration === alphaContext.routeGeneration && entry.retiring), true);
    await assert.rejects(() => connectionManager.acquire(alphaContext), (error) => error.code === "DATA_PLANE_ROUTE_GENERATION_STALE");
    await alphaHeld.release();
    assert.equal(connectionManager.metrics().pools.some((entry) => entry.organisationId === alphaOrganisation.organisationId && entry.routeGeneration === alphaContext.routeGeneration), false);
    assert.equal(connectionManager.metrics().pools.some((entry) => entry.organisationId === betaOrganisation.organisationId), true);
    await alphaNew.release();
    await betaHeld.release();

    const metadataCases = [
      ["database_mode = 'private_database'", "DATA_PLANE_ROUTE_TYPE_MISMATCH"],
      ["logical_database_identifier = 'wrong'", "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH"],
      ["schema_version = '999'", "DATA_PLANE_SCHEMA_UNSUPPORTED"],
      ["environment_key = 'wrong'", "DATA_PLANE_ENVIRONMENT_MISMATCH"],
      ["migration_version = 7", "DATA_PLANE_MIGRATION_VERSION_MISMATCH"],
    ];
    for (const [mutation, code] of metadataCases) {
      await operationalPool.execute(`UPDATE data_plane_metadata SET ${mutation} WHERE metadata_key = 'primary'`);
      const isolatedManager = createTenantConnectionManager({ adapters: { legacy_shared: createLegacySharedAdapter({ databaseUrl: operationalUrl }) } });
      await assert.rejects(() => isolatedManager.acquire(betaContext), (error) => error.code === code);
      assert.equal(isolatedManager.metrics().cachedPools, 0);
      await operationalPool.execute(
        "UPDATE data_plane_metadata SET database_mode='legacy_shared', logical_database_identifier='legacy-operational-shared', schema_version='8', environment_key='legacy', migration_version=8 WHERE metadata_key='primary'",
      );
    }
    const missingManager = createTenantConnectionManager({ adapters: { legacy_shared: createLegacySharedAdapter({ databaseUrl: operationalUrl }) } });
    await operationalPool.execute("DELETE FROM data_plane_metadata WHERE metadata_key='primary'");
    await assert.rejects(() => missingManager.acquire(betaContext), (error) => error.code === "DATA_PLANE_METADATA_MISSING");
    await operationalPool.execute("INSERT INTO data_plane_metadata (metadata_key,database_mode,logical_database_identifier,schema_version,environment_key,migration_version) VALUES ('primary','legacy_shared','legacy-operational-shared','8','legacy',8)");
    await assert.rejects(
      () => operationalPool.execute("INSERT INTO data_plane_metadata (metadata_key,database_mode,logical_database_identifier,schema_version,environment_key,migration_version) VALUES ('secondary','legacy_shared','legacy-operational-shared','8','legacy',8)"),
      (error) => error.code === "ER_CHECK_CONSTRAINT_VIOLATED",
    );

    const betaSimulator = createOperationalRepositories(betaContext, betaHeld.pool).simulatorState;
    assert.equal(await betaSimulator.getStatus("tenant_alpha"), null);
    assert.equal(await betaSimulator.acquireLease({ instanceId: "tenant_alpha", workerId: "beta-worker" }), null);

    await controlService.transitionOrganisation(alphaOrganisation.organisationId, "suspended", { suspensionReason: "phase11d-gate" });
    assert.equal((await request(alpha, "/detection/report")).status, 401);
    assert.equal(connectionManager.metrics().pools.some((entry) => entry.organisationId === alphaOrganisation.organisationId), false);
    assert.equal((await request(beta, "/detection/report")).status, 200);
    const alphaCredential = provisioned.oneTimeCredentials.find((entry) => entry.organisation === "alpha" && entry.role === "investigator");
    const suspendedLogin = await app.request("http://localhost/auth/login", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ organisationSlug: "alpha", username: alphaCredential.username, password: alphaCredential.password }),
    });
    assert.equal(suspendedLogin.status, 401);
    assert.equal((await app.request("http://localhost/health")).status, 200);
    await controlService.transitionOrganisation(alphaOrganisation.organisationId, "active");
    const freshAlpha = await login("alpha", "investigator");
    assert.equal((await request(freshAlpha, "/detection/report")).status, 200);

    assert.equal(logs.some(({ event }) => event === "data_plane_pool_drained"), true);
    assert.equal(logs.some(({ event }) => event === "data_plane_metadata_verified"), true);
    console.log(JSON.stringify({
      phase11dRealMysql: true,
      mysqlVersion: (await operationalPool.execute("SELECT VERSION() version"))[0][0].version,
      organisations: { alpha: alphaOrganisation.organisationId, beta: betaOrganisation.organisationId, platform: platformOrganisation.organisationId },
      routeKeys: { alpha: dataPlanePoolKey(alphaGenerationTwo), beta: dataPlanePoolKey(betaContext) },
      directRows,
      safePoolMetrics: connectionManager.metrics(),
    }));
  } finally {
    if (connectionManager) {
      const organisations = connectionManager.metrics().pools.map(({ organisationId }) => organisationId);
      await Promise.all([...new Set(organisations)].map((id) => connectionManager.invalidateOrganisation(id, "gate_shutdown").catch(() => undefined)));
    }
    await Promise.all([controlPool.end(), operationalPool.end()]);
  }
});
