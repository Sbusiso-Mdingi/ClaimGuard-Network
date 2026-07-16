import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createClaimIngestionRepository,
  createDatabase,
  createInvestigationRepository,
  createLedgerRepository,
  createSharedFraudRegistryRepository,
  createTenantRepository,
} from "@claimguard/database";

import { createBackendApp } from "./backend.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";
import {
  createLiveDemoBootstrapFromDatabase,
  createLiveDemoSimulator,
  parseLiveDemoConfigFromEnvironment,
} from "./simulation/live-demo-simulator.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const detectionAnalyzeProxyUrl = process.env.DETECTION_ANALYZE_PROXY_URL || null;

let ledgerRepository = null;
let investigationRepository = null;
let sharedFraudRegistryRepository = null;
let claimIngestionService = null;
let tenantRepository = null;
let databasePool = null;
let liveDemoSimulator = null;

if (databaseUrl) {
  const database = createDatabase(databaseUrl);
  ledgerRepository = createLedgerRepository(database.db);
  investigationRepository = createInvestigationRepository(database.pool);
  sharedFraudRegistryRepository = createSharedFraudRegistryRepository(database.pool);
  claimIngestionService = createClaimIngestionRepository(database.pool);
  tenantRepository = createTenantRepository(database.pool);
  databasePool = database.pool;
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
  claimIngestionService,
  tenantRepository,
  reportStorage,
  detectionAnalyzeProxyUrl,
});

const liveDemoConfig = parseLiveDemoConfigFromEnvironment(process.env);

if (databasePool && liveDemoConfig.enabled) {
  const bootstrap = createLiveDemoBootstrapFromDatabase({
    pool: databasePool,
    configuredTenantIds: liveDemoConfig.configuredTenantIds,
    seed: liveDemoConfig.seed,
    logger(level, event, details = {}) {
      const payload = {
        timestamp: new Date().toISOString(),
        level,
        service: "api",
        event,
        ...details,
      };

      const rendered = JSON.stringify(payload);
      if (level === "error") {
        console.error(rendered);
      } else {
        console.log(rendered);
      }
    },
  });

  liveDemoSimulator = createLiveDemoSimulator({
    enabled: true,
    mode: liveDemoConfig.mode,
    staticMode: liveDemoConfig.staticMode,
    seed: liveDemoConfig.seed,
    tickIntervalMs: liveDemoConfig.tickIntervalMs,
    maxRecentClaims: liveDemoConfig.maxRecentClaims,
    maxActiveInvestigations: liveDemoConfig.maxActiveInvestigations,
    storyMode: liveDemoConfig.storyMode,
    fraudRate: liveDemoConfig.fraudRate,
    bootstrap,
    apiClient: {
      async request({ path, method = "GET", headers = {}, body = null }) {
        const response = await app.request(`http://localhost${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        let json = null;
        try {
          json = await response.json();
        } catch {
          json = null;
        }

        return {
          status: response.status,
          json,
        };
      },
    },
    logger(level, event, details = {}) {
      const payload = {
        timestamp: new Date().toISOString(),
        level,
        service: "api",
        event,
        ...details,
      };

      const rendered = JSON.stringify(payload);
      if (level === "error") {
        console.error(rendered);
      } else {
        console.log(rendered);
      }
    },
  });

  await liveDemoSimulator.start();
}

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
    liveDemoMode: liveDemoConfig.mode,
    liveDemoEnabled: Boolean(liveDemoSimulator),
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
    liveDemoSimulator?.stop();
    await databasePool.end();
    process.exit(0);
  });
}
