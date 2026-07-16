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
  createSimulationStateRepository,
  createTenantRepository,
} from "@claimguard/database";

import { createBackendApp } from "./backend.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const detectionAnalyzeProxyUrl = process.env.DETECTION_ANALYZE_PROXY_URL || null;

let ledgerRepository = null;
let investigationRepository = null;
let sharedFraudRegistryRepository = null;
let fraudWorkflowRepository = null;
let claimIngestionService = null;
let tenantRepository = null;
let databasePool = null;
let simulationStateRepository = null;

if (databaseUrl) {
  const database = createDatabase(databaseUrl);
  ledgerRepository = createLedgerRepository(database.db, database.pool);
  investigationRepository = createInvestigationRepository(database.pool);
  sharedFraudRegistryRepository = createSharedFraudRegistryRepository(database.pool);
  fraudWorkflowRepository = createFraudWorkflowRepository(database.pool);
  claimIngestionService = createClaimIngestionRepository(database.pool);
  tenantRepository = createTenantRepository(database.pool);
  databasePool = database.pool;
  simulationStateRepository = createSimulationStateRepository(database.pool);
  const legacyMode = String(process.env.LIVE_DEMO_MODE || "off").toLowerCase();
  const legacyStoryMode = String(process.env.LIVE_DEMO_STORY_MODE || "").trim();
  const configuredMode = String(
    process.env.SIMULATOR_DEFAULT_MODE || (legacyMode === "on" ? (legacyStoryMode ? "story" : "live") : legacyMode),
  ).toLowerCase();
  await simulationStateRepository.ensureDefaultInstance({
    createdBy: "api-startup",
    mode: ["off", "static", "live", "story"].includes(configuredMode) ? configuredMode : "off",
    seed: Number(process.env.LIVE_DEMO_SEED || 42),
    tickIntervalMs: Number(process.env.LIVE_DEMO_TICK_MS || 8000),
    storyKey: legacyStoryMode || null,
    config: {
      maxRecentClaims: Number(process.env.LIVE_DEMO_MAX_RECENT_CLAIMS || 500),
      fraudRate: Number(process.env.LIVE_DEMO_FRAUD_RATE || 0.04),
    },
  });
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
  detectionAnalyzeProxyUrl,
  simulationStateRepository,
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
    simulatorControlConfigured: Boolean(simulationStateRepository),
    reportStorageBackend: (process.env.REPORT_STORAGE_BACKEND || "file").toLowerCase(),
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

if (databasePool) {
  process.on("SIGINT", async () => {
    await databasePool.end();
    process.exit(0);
  });
}
