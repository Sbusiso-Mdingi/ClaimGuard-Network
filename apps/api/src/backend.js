import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";

import { createLedgerEntry, genesisPreviousHash } from "@claimguard/database";
import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";

import { backendRouter, backendRouterPath } from "./trpc.js";

async function readDetectionReport(detectionReportPath) {
  if (!detectionReportPath) {
    return null;
  }

  const content = await readFile(detectionReportPath, "utf-8");
  return JSON.parse(content);
}

export function createBackendApp({ ledgerRepository = null, detectionReportPath = null } = {}) {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json(createBackendHealth());
  });

  app.get("/meta", (c) => {
    return c.json(createBackendInfo());
  });

  app.get("/ledger/preview", (c) => {
    const entry = createLedgerEntry({
      sequenceNumber: 1,
      previousHash: genesisPreviousHash,
      entryType: "API_BOOT",
      payload: {
        service: "api",
        phase: "3",
      },
    });

    return c.json({
      chainReady: true,
      entry,
    });
  });

  app.get("/ledger/latest", async (c) => {
    if (!ledgerRepository) {
      return c.json(
        {
          available: false,
          message: "MYSQL_URL is not configured, so the runtime ledger is not available yet.",
        },
        503,
      );
    }

    const latestEntry = await ledgerRepository.getLatestEntry();

    if (!latestEntry) {
      return c.json({ available: true, entry: null }, 200);
    }

    return c.json({ available: true, entry: latestEntry }, 200);
  });

  app.get("/detection/report", async (c) => {
    let report = null;

    try {
      report = await readDetectionReport(detectionReportPath);
    } catch {
      return c.json(
        {
          available: false,
          message: "The configured detection report could not be read yet.",
        },
        503,
      );
    }

    if (!report) {
      return c.json(
        {
          available: false,
          message: "DETECTION_REPORT_PATH is not configured, so the detection report is not available yet.",
        },
        503,
      );
    }

    return c.json({ available: true, report }, 200);
  });

  app.all(`${backendRouterPath}/*`, (c) => {
    return fetchRequestHandler({
      endpoint: backendRouterPath,
      req: c.req.raw,
      router: backendRouter,
      createContext: async () => ({
        requestId: c.req.header("x-request-id") || null,
      }),
    });
  });

  return app;
}