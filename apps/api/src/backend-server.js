import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, createLedgerRepository } from "@claimguard/database";

import { createBackendApp } from "./backend.js";
import { createReportStorageFromEnvironment } from "./report-storage.js";

const port = Number(process.env.PORT || process.env.WEBSITES_PORT || 3004);
const databaseUrl = process.env.MYSQL_URL;
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(moduleDir, "../../..");
const detectionAnalyzeProxyUrl = process.env.DETECTION_ANALYZE_PROXY_URL || null;

let ledgerRepository = null;
let databasePool = null;

if (databaseUrl) {
  const database = createDatabase(databaseUrl);
  ledgerRepository = createLedgerRepository(database.db);
  databasePool = database.pool;
}

const reportStorage = await createReportStorageFromEnvironment({
  reportStorageBackend: process.env.REPORT_STORAGE_BACKEND,
  reportPath: process.env.DETECTION_REPORT_PATH,
  repoRoot,
});

const app = createBackendApp({ ledgerRepository, reportStorage, detectionAnalyzeProxyUrl });

serve({
  fetch: app.fetch,
  port,
});

console.log(`ClaimGuard API backend listening on :${port}`);

if (databasePool) {
  process.on("SIGINT", async () => {
    await databasePool.end();
    process.exit(0);
  });
}