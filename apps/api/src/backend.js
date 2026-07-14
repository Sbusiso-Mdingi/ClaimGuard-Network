import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import crypto from "node:crypto";

import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";
import {
  INVESTIGATION_STATUS,
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
  isFraudConfirmationPermitted,
  FraudRegistryValidationError,
  FraudRegistryNotFoundError,
  FraudRegistryConflictError,
  normalizeRegistryPublicationMetadata,
} from "@claimguard/database";

import {
  authorizeTenantScopedRequest,
  authorizePermissions,
  createAuthenticationMiddleware,
  createRequireAnyPermissionMiddleware,
  createRequirePermissionMiddleware,
} from "./authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS } from "./authorization-policy.js";
import { FileReportStorage } from "./report-storage.js";
import { createTenantContextMiddleware } from "./tenant-context-middleware.js";
import { backendRouter, backendRouterPath } from "./trpc.js";

const genesisPreviousHash = "0".repeat(64);

function logEvent(level, event, details = {}) {
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
}

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

async function checkApiReadiness({ ledgerRepository, reportStorage, producerRuntimeTrigger }) {
  const checks = {
    reportStorageConfigured: Boolean(reportStorage),
    reportStorageReachable: false,
    reportAvailable: false,
    databaseConfigured: Boolean(ledgerRepository),
    databaseReachable: null,
    producerTriggerConfigured: Boolean(producerRuntimeTrigger),
  };

  try {
    const loaded = await reportStorage.getLatestReport();
    checks.reportStorageReachable = true;
    checks.reportAvailable = Boolean(loaded?.report);
  } catch {
    checks.reportStorageReachable = false;
  }

  if (ledgerRepository) {
    try {
      await ledgerRepository.getLatestEntry();
      checks.databaseReachable = true;
    } catch {
      checks.databaseReachable = false;
    }
  }

  const degradedChecks = {
    reportStorageReachable: checks.reportStorageReachable === false,
  };

  const blockingFailures = {
    databaseReachable: checks.databaseConfigured && checks.databaseReachable === false,
  };

  const ready = !Object.values(blockingFailures).some(Boolean);
  const degraded = Object.values(degradedChecks).some(Boolean);

  return {
    ready,
    degraded,
    checks,
  };
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

function investigationRepositoryUnavailable(c) {
  return c.json(
    {
      available: false,
      message: "Investigation persistence is not configured.",
    },
    503,
  );
}

function investigationErrorResponse(c, error) {
  if (error instanceof InvestigationNotFoundError || error?.code === "investigation_not_found") {
    return c.json({ available: false, message: error.message }, 404);
  }

  if (
    error instanceof InvestigationConflictError ||
    error?.code === "invalid_status_transition" ||
    error?.code === "confirmation_status_not_permitted" ||
    error?.code === "fraud_already_confirmed" ||
    error?.code === "ER_DUP_ENTRY"
  ) {
    return c.json({ available: false, message: error.message }, 409);
  }

  if (error instanceof InvestigationValidationError) {
    return c.json({ available: false, message: error.message }, 400);
  }

  return c.json(
    {
      available: false,
      message: error?.message || "Investigation operation failed.",
    },
    400,
  );
}

async function loadInvestigationOrFail(c, investigationRepository, investigationId) {
  const investigation = await investigationRepository.getInvestigationById(investigationId);
  if (!investigation) {
    return {
      ok: false,
      response: c.json(
        {
          available: false,
          message: "The investigation was not found in the active tenant.",
        },
        404,
      ),
    };
  }

  return {
    ok: true,
    investigation,
  };
}

function registryErrorResponse(c, error) {
  if (error instanceof FraudRegistryNotFoundError || error?.code === "fraud_registry_not_found") {
    return c.json({ available: false, message: error.message }, 404);
  }

  if (error instanceof FraudRegistryConflictError) {
    return c.json({ available: false, message: error.message }, 409);
  }

  if (error instanceof FraudRegistryValidationError) {
    return c.json({ available: false, message: error.message }, 400);
  }

  return c.json(
    {
      available: false,
      message: error?.message || "Registry operation failed.",
    },
    400,
  );
}

export function createBackendApp({
  ledgerRepository = null,
  investigationRepository = null,
  sharedFraudRegistryRepository = null,
  claimIngestionService = null,
  producerRuntimeTrigger = null,
  tenantRepository = null,
  authenticationProvider = null,
  defaultTenantId = process.env.DEFAULT_TENANT_ID || null,
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

  app.use(
    "*",
    createTenantContextMiddleware({
      tenantRepository,
      defaultTenantId,
    }),
  );

  app.use(
    "*",
    createAuthenticationMiddleware({
      authenticationProvider: authenticationProvider || undefined,
    }),
  );

  app.use("*", async (c, next) => {
    const requestStart = Date.now();
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);

    try {
      await next();
    } finally {
      logEvent("info", "http_request", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - requestStart,
      });
    }
  });

  app.get("/live", (c) => {
    return c.json({
      status: "ok",
      service: "api",
      live: true,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ready", async (c) => {
    const readiness = await checkApiReadiness({
      ledgerRepository,
      reportStorage: resolvedReportStorage,
      producerRuntimeTrigger,
    });

    const statusCode = readiness.ready ? 200 : 503;
    const status = readiness.ready ? (readiness.degraded ? "degraded" : "ok") : "degraded";
    return c.json(
      {
        status,
        service: "api",
        ready: readiness.ready,
        checks: readiness.checks,
        timestamp: new Date().toISOString(),
      },
      statusCode,
    );
  });

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

  app.post(
    "/claims/ingest",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST,
    }),
    async (c) => {
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

    const schemeIds = claims
      .map((claim) => (typeof claim?.scheme_id === "string" ? claim.scheme_id.trim() : null))
      .filter(Boolean);

    const tenantDecision = await authorizeTenantScopedRequest({
      c,
      tenantRepository,
      resourceSchemeIds: schemeIds,
    });

    if (!tenantDecision.ok) {
      return tenantDecision.response;
    }

    try {
      const requestId = c.get("requestId") || null;
      const summary = await claimIngestionService.ingestClaims({
        claims,
        source: payload?.source || "api",
      });

      logEvent("info", "claims_ingested", {
        requestId,
        source: payload?.source || "api",
        received: summary.received,
        inserted: summary.inserted,
        updated: summary.updated,
      });

      if (producerRuntimeTrigger && typeof producerRuntimeTrigger.triggerAfterIngestion === "function") {
        const triggerStart = Date.now();
        await producerRuntimeTrigger.triggerAfterIngestion({
          claims,
          source: payload?.source || "api",
          ingestion: summary,
          tenantContext: c.get("tenantContext") || null,
        });
        logEvent("info", "producer_trigger_completed", {
          requestId,
          source: payload?.source || "api",
          durationMs: Date.now() - triggerStart,
          claimCount: claims.length,
        });
      }

      return c.json({ available: true, ingestion: summary }, 202);
    } catch (error) {
      logEvent("error", "claims_ingestion_failed", {
        requestId: c.get("requestId") || null,
        message: error?.message || "Claim ingestion failed.",
      });
      return c.json(
        {
          available: false,
          message: error?.message || "Claim ingestion failed.",
        },
        400,
      );
    }
    },
  );

  app.post(
    "/investigations",
    createRequireAnyPermissionMiddleware({
      permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE],
    }),
    async (c) => {
      if (!investigationRepository || typeof investigationRepository.createInvestigation !== "function") {
        return investigationRepositoryUnavailable(c);
      }

      const payload = await c.req.json().catch(() => null);
      const assignedBy = c.get("authContext")?.user_id || null;

      try {
        const investigation = await investigationRepository.createInvestigation({
          claimId: payload?.claimId,
          assignedInvestigator: payload?.assignedInvestigator || null,
          assignedBy,
          priority: payload?.priority,
        });

        return c.json({ available: true, investigation }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/investigations/:id",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW,
    }),
    async (c) => {
      if (!investigationRepository || typeof investigationRepository.getInvestigationDetails !== "function") {
        return investigationRepositoryUnavailable(c);
      }

      try {
        const investigation = await investigationRepository.getInvestigationDetails(c.req.param("id"));
        if (!investigation) {
          return c.json(
            {
              available: false,
              message: "The investigation was not found in the active tenant.",
            },
            404,
          );
        }

        return c.json({ available: true, investigation }, 200);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.patch("/investigations/:id", async (c) => {
    if (!investigationRepository || typeof investigationRepository.updateInvestigation !== "function") {
      return investigationRepositoryUnavailable(c);
    }

    const payload = await c.req.json().catch(() => null);
    const hasStatus = payload && Object.hasOwn(payload, "status");
    const hasPriority = payload && Object.hasOwn(payload, "priority");

    if (!hasStatus && !hasPriority) {
      return c.json(
        {
          available: false,
          message: "status or priority must be provided.",
        },
        400,
      );
    }

    const requiredPermissions = [
      ...(hasStatus ? [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS] : []),
      ...(hasPriority ? [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY] : []),
    ];
    const permissionDecision = authorizePermissions({
      c,
      permissions: requiredPermissions,
      mode: "all",
    });

    if (!permissionDecision.ok) {
      return permissionDecision.response;
    }

    try {
      const investigation = await investigationRepository.updateInvestigation({
        investigationId: c.req.param("id"),
        status: hasStatus ? payload.status : undefined,
        priority: hasPriority ? payload.priority : undefined,
      });

      return c.json({ available: true, investigation }, 200);
    } catch (error) {
      return investigationErrorResponse(c, error);
    }
  });

  app.post(
    "/investigations/:id/notes",
    createRequireAnyPermissionMiddleware({
      permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE],
    }),
    async (c) => {
      if (
        !investigationRepository ||
        typeof investigationRepository.getInvestigationById !== "function" ||
        typeof investigationRepository.addNote !== "function"
      ) {
        return investigationRepositoryUnavailable(c);
      }

      const investigationId = c.req.param("id");
      const loaded = await loadInvestigationOrFail(c, investigationRepository, investigationId);
      if (!loaded.ok) {
        return loaded.response;
      }

      const payload = await c.req.json().catch(() => null);
      try {
        const note = await investigationRepository.addNote({
          investigationId,
          author: c.get("authContext")?.user_id || null,
          text: payload?.text,
          noteType: payload?.noteType,
        });

        return c.json({ available: true, note }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.post(
    "/investigations/:id/evidence",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPLOAD_EVIDENCE,
    }),
    async (c) => {
      if (
        !investigationRepository ||
        typeof investigationRepository.getInvestigationById !== "function" ||
        typeof investigationRepository.registerEvidence !== "function"
      ) {
        return investigationRepositoryUnavailable(c);
      }

      const investigationId = c.req.param("id");
      const loaded = await loadInvestigationOrFail(c, investigationRepository, investigationId);
      if (!loaded.ok) {
        return loaded.response;
      }

      const payload = await c.req.json().catch(() => null);
      try {
        const evidence = await investigationRepository.registerEvidence({
          investigationId,
          filename: payload?.filename,
          description: payload?.description,
          uploadedBy: c.get("authContext")?.user_id || null,
          evidenceType: payload?.evidenceType,
        });

        return c.json({ available: true, evidence }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.post(
    "/investigations/confirm-fraud",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD,
    }),
    async (c) => {
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
    const investigationId = payload?.investigationId;
    const claimId = payload?.claimId;
    const investigatorId = payload?.investigatorId;
    const reason = payload?.reason;

    if (!investigationId || !claimId || !investigatorId || !reason) {
      return c.json(
        {
          available: false,
          message: "investigationId, claimId, investigatorId, and reason are required.",
        },
        400,
      );
    }

    if (!investigationRepository || typeof investigationRepository.getInvestigationById !== "function") {
      return investigationRepositoryUnavailable(c);
    }

    let investigation;
    try {
      const loaded = await loadInvestigationOrFail(c, investigationRepository, investigationId);
      if (!loaded.ok) {
        return loaded.response;
      }

      investigation = loaded.investigation;
    } catch (error) {
      return investigationErrorResponse(c, error);
    }

    if (investigation.claimId !== claimId) {
      return c.json(
        {
          available: false,
          message: "claimId must match the investigation claim.",
        },
        400,
      );
    }

    if (!isFraudConfirmationPermitted(investigation)) {
      return c.json(
        {
          available: false,
          message:
            investigation.status === INVESTIGATION_STATUS.CONFIRMED_FRAUD
              ? "This investigation has already published a fraud decision."
              : "Investigation status must be CONFIRMED_FRAUD before fraud can be confirmed.",
        },
        409,
      );
    }

    const tenantDecision = await authorizeTenantScopedRequest({
      c,
      tenantRepository,
      resourceTenantIds: [investigation.tenantId],
      resourceSchemeIds: [payload?.schemeId].filter(Boolean),
    });

    if (!tenantDecision.ok) {
      return tenantDecision.response;
    }

    try {
      const requestId = c.get("requestId") || null;
      const entry = await ledgerRepository.createConfirmedFraudEntry({
        claimId,
        investigatorId,
        reason,
        schemeId: payload?.schemeId || null,
        reportVersion: payload?.reportVersion || null,
        notes: payload?.notes || null,
      });

      if (typeof investigationRepository.markFraudPublished !== "function") {
        throw new Error("Investigation persistence does not support fraud publication tracking.");
      }
      await investigationRepository.markFraudPublished(investigationId);

      let registryEntry = null;
      if (
        sharedFraudRegistryRepository &&
        typeof sharedFraudRegistryRepository.publishConfirmedFraud === "function" &&
        payload?.registryMetadata
      ) {
        try {
          registryEntry = await sharedFraudRegistryRepository.publishConfirmedFraud({
            ledgerEntry: entry,
            investigation,
            metadata: payload.registryMetadata,
          });

          logEvent("info", "fraud_registry_published", {
            requestId,
            registryEntryId: registryEntry.registryEntryId,
            investigationId,
            subjectToken: registryEntry.subjectToken,
          });
        } catch (registryError) {
          logEvent("error", "fraud_registry_publication_failed", {
            requestId,
            investigationId,
            message: registryError?.message || "Registry publication failed.",
          });
        }
      }

      logEvent("info", "fraud_confirmed", {
        requestId,
        claimId,
        investigatorId,
        schemeId: payload?.schemeId || null,
        reportVersion: payload?.reportVersion || null,
        ledgerSequenceNumber: entry.sequenceNumber,
      });

      return c.json({ available: true, entry, registryEntry }, 201);
    } catch (error) {
      logEvent("error", "fraud_confirmation_failed", {
        requestId: c.get("requestId") || null,
        message: error?.message || "Failed to persist confirmed fraud decision.",
      });
      return c.json(
        {
          available: false,
          message: error?.message || "Failed to persist confirmed fraud decision.",
        },
        400,
      );
    }
    },
  );

  app.post(
    "/investigations/reverse-fraud",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD,
    }),
    async (c) => {
      if (!ledgerRepository || typeof ledgerRepository.createReversedFraudEntry !== "function") {
        return c.json(
          {
            available: false,
            message: "Ledger repository is not configured for fraud reversal writes.",
          },
          503,
        );
      }

      if (
        !sharedFraudRegistryRepository ||
        typeof sharedFraudRegistryRepository.getActiveRegistryFindingForInvestigation !== "function"
      ) {
        return c.json(
          {
            available: false,
            message: "Shared fraud registry is not configured.",
          },
          503,
        );
      }

      const payload = await c.req.json().catch(() => null);
      const investigationId = payload?.investigationId;
      const claimId = payload?.claimId;
      const investigatorId = payload?.investigatorId;
      const reason = payload?.reason;

      if (!investigationId || !claimId || !investigatorId || !reason) {
        return c.json(
          {
            available: false,
            message: "investigationId, claimId, investigatorId, and reason are required.",
          },
          400,
        );
      }

      if (!investigationRepository || typeof investigationRepository.getInvestigationById !== "function") {
        return investigationRepositoryUnavailable(c);
      }

      let investigation;
      try {
        const loaded = await loadInvestigationOrFail(c, investigationRepository, investigationId);
        if (!loaded.ok) {
          return loaded.response;
        }

        investigation = loaded.investigation;
      } catch (error) {
        return investigationErrorResponse(c, error);
      }

      if (investigation.claimId !== claimId) {
        return c.json(
          {
            available: false,
            message: "claimId must match the investigation claim.",
          },
          400,
        );
      }

      const tenantDecision = await authorizeTenantScopedRequest({
        c,
        tenantRepository,
        resourceTenantIds: [investigation.tenantId],
      });

      if (!tenantDecision.ok) {
        return tenantDecision.response;
      }

      try {
        const requestId = c.get("requestId") || null;

        const originalRegistryEntry =
          await sharedFraudRegistryRepository.getActiveRegistryFindingForInvestigation({
            investigationId,
            tenantId: investigation.tenantId,
          });

        if (!originalRegistryEntry) {
          return c.json(
            {
              available: false,
              message: "No active registry finding exists for this investigation.",
            },
            409,
          );
        }

        const reversalLedgerEntry = await ledgerRepository.createReversedFraudEntry({
          claimId,
          investigatorId,
          reason,
          schemeId: payload?.schemeId || null,
          notes: payload?.notes || null,
          originalLedgerHash: originalRegistryEntry.ledgerHash,
        });

        const reversalRegistryEntry = await sharedFraudRegistryRepository.publishFraudReversal({
          ledgerEntry: reversalLedgerEntry,
          investigation,
          originalRegistryEntry,
          investigatorReference: investigatorId,
        });

        logEvent("info", "fraud_reversed", {
          requestId,
          claimId,
          investigatorId,
          investigationId,
          originalRegistryEntryId: originalRegistryEntry.registryEntryId,
          reversalRegistryEntryId: reversalRegistryEntry.registryEntryId,
          ledgerSequenceNumber: reversalLedgerEntry.sequenceNumber,
        });

        return c.json(
          {
            available: true,
            entry: reversalLedgerEntry,
            registryEntry: reversalRegistryEntry,
          },
          201,
        );
      } catch (error) {
        logEvent("error", "fraud_reversal_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Failed to reverse fraud decision.",
        });

        if (
          error instanceof FraudRegistryConflictError ||
          error instanceof FraudRegistryValidationError
        ) {
          return registryErrorResponse(c, error);
        }

        return c.json(
          {
            available: false,
            message: error?.message || "Failed to reverse fraud decision.",
          },
          400,
        );
      }
    },
  );

  app.get(
    "/registry/search",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH,
    }),
    async (c) => {
      if (
        !sharedFraudRegistryRepository ||
        typeof sharedFraudRegistryRepository.searchRegistry !== "function"
      ) {
        return c.json(
          {
            available: false,
            message: "Shared fraud registry is not configured.",
          },
          503,
        );
      }

      const subjectToken = c.req.query("subjectToken");
      if (!subjectToken || !subjectToken.trim()) {
        return c.json(
          {
            available: false,
            message: "subjectToken query parameter is required.",
          },
          400,
        );
      }

      try {
        const fraudSubjectType = c.req.query("fraudSubjectType") || null;
        const results = await sharedFraudRegistryRepository.searchRegistry({
          subjectToken: subjectToken.trim(),
          fraudSubjectType,
        });

        return c.json({ available: true, results }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/registry/history/:subjectToken",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
    }),
    async (c) => {
      if (
        !sharedFraudRegistryRepository ||
        typeof sharedFraudRegistryRepository.getRegistryHistory !== "function"
      ) {
        return c.json(
          {
            available: false,
            message: "Shared fraud registry is not configured.",
          },
          503,
        );
      }

      const subjectToken = c.req.param("subjectToken");
      if (!subjectToken || !subjectToken.trim()) {
        return c.json(
          {
            available: false,
            message: "subjectToken path parameter is required.",
          },
          400,
        );
      }

      try {
        const history = await sharedFraudRegistryRepository.getRegistryHistory(subjectToken.trim());
        return c.json({ available: true, history }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/registry/:id",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW,
    }),
    async (c) => {
      if (
        !sharedFraudRegistryRepository ||
        typeof sharedFraudRegistryRepository.getRegistryRecordById !== "function"
      ) {
        return c.json(
          {
            available: false,
            message: "Shared fraud registry is not configured.",
          },
          503,
        );
      }

      const registryEntryId = c.req.param("id");
      if (!registryEntryId || !registryEntryId.trim()) {
        return c.json(
          {
            available: false,
            message: "Registry entry ID is required.",
          },
          400,
        );
      }

      try {
        const record = await sharedFraudRegistryRepository.getRegistryRecordById(registryEntryId.trim());
        if (!record) {
          return c.json(
            {
              available: false,
              message: "The shared fraud registry record was not found.",
            },
            404,
          );
        }

        return c.json({ available: true, record }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );

  app.all(`${backendRouterPath}/*`, (c) => {
    return fetchRequestHandler({
      endpoint: backendRouterPath,
      req: c.req.raw,
      router: backendRouter,
      createContext: async () => ({
        requestId: c.req.header("x-request-id") || null,
        tenantContext: c.get("tenantContext") || null,
      }),
    });
  });

  return app;
}
