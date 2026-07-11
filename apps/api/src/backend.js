import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import crypto from "node:crypto";

import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";

import { FileReportStorage } from "./report-storage.js";
import { backendRouter, backendRouterPath } from "./trpc.js";

const genesisPreviousHash = "0".repeat(64);

function createLedgerEntry({ sequenceNumber, previousHash = genesisPreviousHash, entryType, payload }) {
  const digest = crypto.createHash("sha256");
  digest.update(previousHash);
  digest.update("|");
  digest.update(entryType);
  digest.update("|");
  digest.update(JSON.stringify(payload));

  return {
    sequenceNumber,
    entryType,
    previousHash,
    entryHash: digest.digest("hex"),
    payload,
  };
}

async function loadReportOrFail(reportStorage) {
  try {
    const loaded = await reportStorage.getLatestReport();
    if (!loaded || !loaded.report) {
      return {
        ok: false,
        status: 503,
        body: {
          available: false,
          message: "No detection report is available from the configured report storage.",
        },
      };
    }

    return {
      ok: true,
      report: loaded.report,
      metadata: loaded.metadata || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      body: {
        available: false,
        message: `The configured report storage could not be read yet.${error?.message ? ` ${error.message}` : ""}`,
      },
    };
  }
}

async function proxyDetectionAnalyze(detectionAnalyzeProxyUrl, payload) {
  const response = await fetch(detectionAnalyzeProxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({
    available: false,
    message: "Detection producer proxy returned a non-JSON response.",
  }));

  return {
    status: response.status,
    body,
  };
}

async function buildRuntimeLedgerReference(ledgerRepository) {
  if (!ledgerRepository) {
    return null;
  }

  const latestEntry =
    typeof ledgerRepository.getLatestConfirmedFraudEntry === "function"
      ? await ledgerRepository.getLatestConfirmedFraudEntry()
      : await ledgerRepository.getLatestEntry();

  if (!latestEntry) {
    return {
      type: "runtime-ledger",
      available: false,
      entry: null,
      message: "No investigator-confirmed fraud entries exist yet.",
    };
  }

  return {
    type: "runtime-ledger",
    available: true,
    entry: latestEntry,
  };
}

export function createBackendApp({
  ledgerRepository = null,
  claimIngestionService = null,
  reportStorage = null,
  detectionAnalyzeProxyUrl = null,
  detectionReportPath = null,
} = {}) {
  const resolvedReportStorage =
    reportStorage ||
    new FileReportStorage({
      reportPath: detectionReportPath,
    });

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
    const loaded = await loadReportOrFail(resolvedReportStorage);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    const runtimeLedgerReference = await buildRuntimeLedgerReference(ledgerRepository);
    const report = runtimeLedgerReference
      ? {
          ...loaded.report,
          detection: {
            ...(loaded.report?.detection || {}),
            ledger_reference: runtimeLedgerReference,
          },
        }
      : loaded.report;

    return c.json({ available: true, report }, 200);
  });

  app.get("/detection/graph", async (c) => {
    const loaded = await loadReportOrFail(resolvedReportStorage);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    const graph = loaded.report?.detection?.graph_summary
      ? {
          summary: loaded.report.detection.graph_summary,
          entities: loaded.report.detection.entities || [],
          relationships: loaded.report.detection.relationships || [],
        }
      : {
          summary: {
            entity_count: (loaded.report.network?.network_nodes || []).length,
            relationship_count:
              (loaded.report.network?.exact_banking_links || []).length +
              (loaded.report.network?.behavioral_provider_links || []).length,
          },
          entities: loaded.report.network?.network_nodes || [],
          relationships: [
            ...(loaded.report.network?.exact_banking_links || []),
            ...(loaded.report.network?.behavioral_provider_links || []),
          ],
        };

    return c.json({ available: true, graph }, 200);
  });

  app.get("/detection/risk", async (c) => {
    const loaded = await loadReportOrFail(resolvedReportStorage);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    const risk = loaded.report?.detection?.risk_score || {
      riskScore: 0,
      severity: "Low",
      reasons: ["Detection risk is unavailable in the current report."],
    };

    return c.json({ available: true, risk }, 200);
  });

  app.post("/detection/analyze", async (c) => {
    const payload = await c.req.json().catch(() => null);
    if (!payload || !Array.isArray(payload.claims)) {
      return c.json(
        {
          available: false,
          message: "Request body must include a claims array.",
        },
        400,
      );
    }

    if (!detectionAnalyzeProxyUrl) {
      return c.json(
        {
          available: false,
          deprecated: true,
          message: "Detection analysis moved to the report producer runtime. Configure DETECTION_ANALYZE_PROXY_URL to proxy this compatibility route.",
        },
        410,
      );
    }

    try {
      const proxied = await proxyDetectionAnalyze(detectionAnalyzeProxyUrl, payload);
      return c.json(proxied.body, proxied.status);
    } catch {
      return c.json(
        {
          available: false,
          message: "Detection producer proxy is unavailable.",
        },
        502,
      );
    }
  });

  app.post("/claims/ingest", async (c) => {
    const payload = await c.req.json().catch(() => null);
    const claims = payload?.claims;

    if (!Array.isArray(claims) || claims.length === 0) {
      return c.json(
        {
          available: false,
          message: "Request body must include a non-empty claims array.",
        },
        400,
      );
    }

    if (!claimIngestionService || typeof claimIngestionService.ingestClaims !== "function") {
      return c.json(
        {
          available: false,
          message: "Claim ingestion service is not configured.",
        },
        503,
      );
    }

    try {
      const summary = await claimIngestionService.ingestClaims({
        claims,
        source: payload?.source || "api",
      });

      return c.json({ available: true, ingestion: summary }, 202);
    } catch (error) {
      return c.json(
        {
          available: false,
          message: error?.message || "Claim ingestion failed.",
        },
        400,
      );
    }
  });

  app.post("/investigations/confirm-fraud", async (c) => {
    if (!ledgerRepository || typeof ledgerRepository.createConfirmedFraudEntry !== "function") {
      return c.json(
        {
          available: false,
          message: "Ledger repository is not configured for investigator confirmation writes.",
        },
        503,
      );
    }

    const payload = await c.req.json().catch(() => null);
    const claimId = payload?.claimId;
    const investigatorId = payload?.investigatorId;
    const reason = payload?.reason;

    if (!claimId || !investigatorId || !reason) {
      return c.json(
        {
          available: false,
          message: "claimId, investigatorId, and reason are required.",
        },
        400,
      );
    }

    try {
      const entry = await ledgerRepository.createConfirmedFraudEntry({
        claimId,
        investigatorId,
        reason,
        schemeId: payload?.schemeId || null,
        reportVersion: payload?.reportVersion || null,
        notes: payload?.notes || null,
      });

      return c.json({ available: true, entry }, 201);
    } catch (error) {
      return c.json(
        {
          available: false,
          message: error?.message || "Failed to persist confirmed fraud decision.",
        },
        400,
      );
    }
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