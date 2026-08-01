import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN_API) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_API,
    environment: process.env.CLAIMGUARD_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.CLAIMGUARD_RELEASE || undefined,
    sendDefaultPii: false,
    // New Relic owns API performance tracing. Sentry is deliberately error-only.
    tracesSampleRate: 0,
  });
}

import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLegacySharedAdapter,
  createTenantConnectionManager,
} from "@claimguard/database";
import {
  assertDistinctDatabaseUrls,
  createControlPlaneAuthenticationService,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
  createActivationKeyHasher,
  createDesktopEnrollmentService,
  createEnrollmentDocumentSigner,
} from "@claimguard/control-plane-database";

import { createBackendApp } from "./backend.js";
import { resolveAuthenticationConfiguration } from "./authentication-config.js";
import { createControlPlaneDataPlaneRouteResolver } from "./data-plane-route-resolver.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";
import { createPrivateDatabaseAdapter } from "./private-database-adapter.js";
import { logEvent } from "./services/log-event.js";
import { createDesktopDeviceProofVerifier } from "./desktop-device-proof.js";
import { createDesktopSyncService } from "./desktop-sync-service.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const authenticationConfiguration = resolveAuthenticationConfiguration();
const supportedDataPlaneSchemaVersions = String(
  process.env.DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS || "14",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!databaseUrl) {
  throw new Error("MYSQL_URL is required by the explicit legacy_shared route adapter.");
}

assertDistinctDatabaseUrls(process.env.CONTROL_PLANE_MYSQL_URL, databaseUrl);
const controlPlanePool = createControlPlanePool(process.env.CONTROL_PLANE_MYSQL_URL);
const controlPlaneRepositories = createControlPlaneRepositories(controlPlanePool);
const baseControlPlaneService = createControlPlaneService({
  pool: controlPlanePool,
  repositories: controlPlaneRepositories,
});
const controlPlaneService = Object.freeze({
  ...baseControlPlaneService,
  async listUsersByOrganisation(organisationId) {
    return controlPlaneRepositories.identity.listUsersByOrganisation(organisationId);
  },
});
const authenticationService = createControlPlaneAuthenticationService({
  authenticationRepository: controlPlaneRepositories.authentication,
  integrationCredentialsRepository: controlPlaneRepositories.integrationCredentials,
  idleTimeoutMs: authenticationConfiguration.idleTimeoutMs,
  absoluteTimeoutMs: authenticationConfiguration.absoluteTimeoutMs,
  throttleWindowMs: authenticationConfiguration.throttle.windowMs,
  throttleMaxAttempts: authenticationConfiguration.throttle.maxAttempts,
  throttleBaseDelayMs: authenticationConfiguration.throttle.baseDelayMs,
  throttleMaxDelayMs: authenticationConfiguration.throttle.maxDelayMs,
  throttleLockoutMs: authenticationConfiguration.throttle.lockoutMs,
});

const routeResolver = createControlPlaneDataPlaneRouteResolver({
  repositories: controlPlaneRepositories,
  supportedSchemaVersions: supportedDataPlaneSchemaVersions,
});

const legacySharedAdapter = createLegacySharedAdapter({
  databaseUrl,
  expectedEnvironment: process.env.DATA_PLANE_ENVIRONMENT || "legacy",
  supportedSchemaVersions: supportedDataPlaneSchemaVersions,
  connectionLimit: Number(process.env.DATA_PLANE_POOL_CONNECTION_LIMIT || 5),
});
const connectionManager = createTenantConnectionManager({
  adapters: {
    legacy_shared: legacySharedAdapter,
    private_database: createPrivateDatabaseAdapter({
      expectedEnvironment: process.env.DATA_PLANE_PRIVATE_ENVIRONMENT || "production",
      supportedSchemaVersions: supportedDataPlaneSchemaVersions,
      connectionLimit: Number(process.env.DATA_PLANE_POOL_CONNECTION_LIMIT || 5),
    }),
  },
  maxPools: Number(process.env.DATA_PLANE_MAX_POOLS || 32),
  idleTimeoutMs: Number(process.env.DATA_PLANE_POOL_IDLE_MS || 600_000),
  creationTimeoutMs: Number(process.env.DATA_PLANE_POOL_CREATION_TIMEOUT_MS || 10_000),
  drainTimeoutMs: Number(process.env.DATA_PLANE_POOL_DRAIN_TIMEOUT_MS || 10_000),
  logger: logEvent,
});
const dataPlaneRuntime = {
  routeResolver,
  connectionManager,
  logger: logEvent,
  async checkReadiness() {
    const checks = {
      controlPlaneReachable: false,
      legacySharedBaselineReachable: false,
      schemaCompatible: false,
    };
    try {
      await controlPlanePool.execute("SELECT 1");
      checks.controlPlaneReachable = true;
    } catch {
      // Fail closed.
    }
    try {
      const baseline = await legacySharedAdapter.checkBaseline();
      checks.legacySharedBaselineReachable = baseline.reachable;
      checks.schemaCompatible = baseline.schemaCompatible;
    } catch {
      // Fail closed.
    }
    return { ready: Object.values(checks).every(Boolean), checks };
  },
};

const desktopConfigurationValues = {
  activationKeyPepper: process.env.DESKTOP_ACTIVATION_KEY_PEPPER,
  enrollmentSigningPrivateKey: process.env.DESKTOP_ENROLLMENT_SIGNING_PRIVATE_KEY,
  enrollmentSigningKeyId: process.env.DESKTOP_ENROLLMENT_SIGNING_KEY_ID,
  cursorSecret: process.env.DESKTOP_SYNC_CURSOR_SECRET,
  apiOrigin: process.env.DESKTOP_API_ORIGIN,
};
const configuredDesktopValueCount = Object.values(desktopConfigurationValues).filter((value) => String(value || "").trim()).length;
if (configuredDesktopValueCount > 0 && configuredDesktopValueCount !== Object.keys(desktopConfigurationValues).length) {
  throw new Error("Desktop enrollment configuration is incomplete; all DESKTOP_* security settings are required together.");
}
const desktopEnrollmentService = configuredDesktopValueCount > 0
  ? createDesktopEnrollmentService({
      repositories: controlPlaneRepositories,
      activationKeyHasher: createActivationKeyHasher({ pepper: desktopConfigurationValues.activationKeyPepper }),
      enrollmentSigner: createEnrollmentDocumentSigner({
        privateKey: desktopConfigurationValues.enrollmentSigningPrivateKey.replaceAll("\\n", "\n"),
        keyId: desktopConfigurationValues.enrollmentSigningKeyId,
      }),
      apiOrigin: desktopConfigurationValues.apiOrigin,
      environment: process.env.CLAIMGUARD_ENVIRONMENT || process.env.NODE_ENV || "production",
      enrollmentLifetimeDays: Number(process.env.DESKTOP_ENROLLMENT_LIFETIME_DAYS || 365),
    })
  : null;
const desktopDeviceProofVerifier = desktopEnrollmentService
  ? createDesktopDeviceProofVerifier({
      desktopEnrollmentRepository: controlPlaneRepositories.desktopEnrollment,
      maximumClockSkewSeconds: Number(process.env.DESKTOP_PROOF_MAXIMUM_CLOCK_SKEW_SECONDS || 300),
    })
  : null;
const desktopSyncService = desktopEnrollmentService
  ? createDesktopSyncService({
      cursorSecret: desktopConfigurationValues.cursorSecret,
      cursorLifetimeDays: Number(process.env.DESKTOP_SYNC_CURSOR_LIFETIME_DAYS || 30),
      retentionDays: Number(process.env.DESKTOP_CACHE_RETENTION_DAYS || 90),
    })
  : null;

const reportStorage = await createReportStorageFromEnvironment({
  reportStorageBackend: process.env.REPORT_STORAGE_BACKEND,
  reportPath: process.env.DETECTION_REPORT_PATH,
  repoRoot,
});

const app = createBackendApp({
  reportStorage,
  authenticationConfiguration,
  authenticationService,
  controlPlaneConfigurationRepository: controlPlaneRepositories.configuration,
  controlPlaneRepositories,
  controlPlaneService,
  dataPlaneRuntime,
  desktopEnrollmentService,
  desktopDeviceProofVerifier,
  desktopSyncService,
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
    hasDatabase: true,
    hasTenantRepository: true,
    reportStorageBackend: (process.env.REPORT_STORAGE_BACKEND || "file").toLowerCase(),
    authenticationMode: authenticationConfiguration.mode,
    explicitDataPlaneRouting: true,
    supportedDataPlaneSchemaVersions,
    desktopEnrollmentConfigured: Boolean(desktopEnrollmentService),
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

process.on("SIGINT", async () => {
  await controlPlanePool.end();
  process.exit(0);
});
