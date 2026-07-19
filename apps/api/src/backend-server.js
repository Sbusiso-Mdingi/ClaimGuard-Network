import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createClaimIngestionRepository,
  createDatabase,
  createInvestigationRepository,
  createFraudWorkflowRepository,
  createLedgerRepository,
  createSharedFraudRegistryRepository,
  createTenantRepository,
  createLegacySharedAdapter,
  createTenantConnectionManager,
} from "@claimguard/database";
import {
  assertDistinctDatabaseUrls,
  createControlPlaneAuthenticationService,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
} from "@claimguard/control-plane-database";

import { createBackendApp } from "./backend.js";
import { resolveAuthenticationConfiguration } from "./authentication-config.js";
import { createControlPlaneDataPlaneRouteResolver } from "./data-plane-route-resolver.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";
import { createPrivateDatabaseAdapter } from "./private-database-adapter.js";
import { logEvent } from "./services/log-event.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const authenticationConfiguration = resolveAuthenticationConfiguration();

let ledgerRepository = null;
let investigationRepository = null;
let sharedFraudRegistryRepository = null;
let fraudWorkflowRepository = null;
let claimIngestionService = null;
let tenantRepository = null;
let databasePool = null;
let controlPlanePool = null;
let controlPlaneRepositories = null;
let authenticationService = null;
let dataPlaneRuntime = null;
let controlPlaneService = null;

if (databaseUrl && authenticationConfiguration.mode === "demo_headers") {
  const database = createDatabase(databaseUrl);
  ledgerRepository = createLedgerRepository(database.db, database.pool, { allowLegacyTenantContext: true });
  investigationRepository = createInvestigationRepository(database.pool, { allowLegacyTenantContext: true });
  sharedFraudRegistryRepository = createSharedFraudRegistryRepository(database.pool);
  fraudWorkflowRepository = createFraudWorkflowRepository(database.pool);
  claimIngestionService = createClaimIngestionRepository(database.pool, { allowLegacyTenantContext: true });
  tenantRepository = createTenantRepository(database.pool, { allowLegacyDefault: true });
  databasePool = database.pool;
}

if (authenticationConfiguration.mode === "session") {
  if (!databaseUrl) throw new Error("MYSQL_URL is required by the explicit legacy_shared route adapter in session mode.");
  if (databaseUrl) assertDistinctDatabaseUrls(process.env.CONTROL_PLANE_MYSQL_URL, databaseUrl);
  controlPlanePool = createControlPlanePool(process.env.CONTROL_PLANE_MYSQL_URL);
  controlPlaneRepositories = createControlPlaneRepositories(controlPlanePool);
  controlPlaneService = createControlPlaneService({ pool: controlPlanePool, repositories: controlPlaneRepositories });
  authenticationService = createControlPlaneAuthenticationService({
    authenticationRepository: controlPlaneRepositories.authentication,
    idleTimeoutMs: authenticationConfiguration.idleTimeoutMs,
    absoluteTimeoutMs: authenticationConfiguration.absoluteTimeoutMs,
    throttleWindowMs: authenticationConfiguration.throttle.windowMs,
    throttleMaxAttempts: authenticationConfiguration.throttle.maxAttempts,
    throttleBaseDelayMs: authenticationConfiguration.throttle.baseDelayMs,
    throttleMaxDelayMs: authenticationConfiguration.throttle.maxDelayMs,
    throttleLockoutMs: authenticationConfiguration.throttle.lockoutMs,
  });
  const routeResolver = createControlPlaneDataPlaneRouteResolver({ repositories: controlPlaneRepositories });
  const legacySharedAdapter = createLegacySharedAdapter({
    databaseUrl,
    expectedEnvironment: process.env.DATA_PLANE_ENVIRONMENT || "legacy",
    supportedSchemaVersions: String(process.env.DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS || "10").split(",").map((value) => value.trim()).filter(Boolean),
    connectionLimit: Number(process.env.DATA_PLANE_POOL_CONNECTION_LIMIT || 5),
  });
  const connectionManager = createTenantConnectionManager({
    adapters: {
      legacy_shared: legacySharedAdapter,
      private_database: createPrivateDatabaseAdapter({
        expectedEnvironment: process.env.DATA_PLANE_PRIVATE_ENVIRONMENT || "production",
        supportedSchemaVersions: String(process.env.DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS || "10").split(",").map((value) => value.trim()).filter(Boolean),
        connectionLimit: Number(process.env.DATA_PLANE_POOL_CONNECTION_LIMIT || 5),
      }),
    },
    maxPools: Number(process.env.DATA_PLANE_MAX_POOLS || 32),
    idleTimeoutMs: Number(process.env.DATA_PLANE_POOL_IDLE_MS || 600_000),
    creationTimeoutMs: Number(process.env.DATA_PLANE_POOL_CREATION_TIMEOUT_MS || 10_000),
    drainTimeoutMs: Number(process.env.DATA_PLANE_POOL_DRAIN_TIMEOUT_MS || 10_000),
    logger: logEvent,
  });
  dataPlaneRuntime = {
    routeResolver,
    connectionManager,
    logger: logEvent,
    async checkReadiness() {
      const checks = { controlPlaneReachable: false, legacySharedBaselineReachable: false, schemaCompatible: false };
      try { await controlPlanePool.execute("SELECT 1"); checks.controlPlaneReachable = true; } catch { /* fail closed */ }
      try {
        const baseline = await legacySharedAdapter.checkBaseline();
        checks.legacySharedBaselineReachable = baseline.reachable;
        checks.schemaCompatible = baseline.schemaCompatible;
      } catch { /* fail closed */ }
      return { ready: Object.values(checks).every(Boolean), checks };
    },
  };
}

const reportStorage = await createReportStorageFromEnvironment({
  reportStorageBackend: process.env.REPORT_STORAGE_BACKEND,
  reportPath: process.env.DETECTION_REPORT_PATH,
  repoRoot,
});

const app = createBackendApp({
  ledgerRepository,
  investigationRepository,
  sharedFraudRegistryRepository,
  fraudWorkflowRepository,
  claimIngestionService,
  tenantRepository,
  reportStorage,
  authenticationConfiguration,
  authenticationService,
  controlPlaneConfigurationRepository: controlPlaneRepositories?.configuration || null,
  controlPlaneRepositories,
  controlPlaneService,
  dataPlaneRuntime,
});

serve({
  fetch: app.fetch,
  port,
});

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "api",
    event: "api_server_started",
    port,
    hasDatabase: Boolean(databasePool),
    hasTenantRepository: Boolean(tenantRepository),
    reportStorageBackend: (process.env.REPORT_STORAGE_BACKEND || "file").toLowerCase(),
    authenticationMode: authenticationConfiguration.mode,
    explicitDataPlaneRouting: Boolean(dataPlaneRuntime),
  }),
);

process.on("unhandledRejection", (error) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "api",
      event: "unhandled_rejection",
      message: error?.message || String(error),
    }),
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "api",
      event: "uncaught_exception",
      message: error?.message || String(error),
    }),
  );
});

if (databasePool || controlPlanePool) {
  process.on("SIGINT", async () => {
    await Promise.all([databasePool?.end(), controlPlanePool?.end()].filter(Boolean));
    process.exit(0);
  });
}
