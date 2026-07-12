import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClaimIngestionRepository, createDatabase, createLedgerRepository } from "@claimguard/database";

import { createBackendApp } from "./backend.js";
import { createProducerRuntimeTriggerFromEnvironment } from "./producer-runtime-trigger.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const detectionAnalyzeProxyUrl = process.env.DETECTION_ANALYZE_PROXY_URL || null;

let ledgerRepository = null;
let claimIngestionService = null;
let producerRuntimeTrigger = null;
let databasePool = null;

if (databaseUrl) {
  const database = createDatabase(databaseUrl);
  ledgerRepository = createLedgerRepository(database.db);
  claimIngestionService = createClaimIngestionRepository(database.pool);
  producerRuntimeTrigger = createProducerRuntimeTriggerFromEnvironment({ repoRoot });
  databasePool = database.pool;
}

const reportStorage = await createReportStorageFromEnvironment({
  reportStorageBackend: process.env.REPORT_STORAGE_BACKEND,
  reportPath: process.env.DETECTION_REPORT_PATH,
  repoRoot,
});

const app = createBackendApp({
  ledgerRepository,
  claimIngestionService,
  producerRuntimeTrigger,
  reportStorage,
  detectionAnalyzeProxyUrl,
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
    hasProducerTrigger: Boolean(producerRuntimeTrigger),
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