import { TenantReportNotFoundError } from "../application-errors.js";
import { parseDetectionReport } from "@claimguard/shared-schema";
import { CLAIM_PROCESSING_STATUS } from "@claimguard/database";

function reportStorageFailure() {
  return {
    ok: false,
    status: 503,
    body: {
      available: false,
      code: "REPORT_STORAGE_UNAVAILABLE",
      message: "The configured report storage could not be read yet.",
    },
  };
}

function reportContractFailure() {
  return {
    ok: false,
    status: 422,
    body: {
      available: false,
      code: "REPORT_CONTRACT_UNSUPPORTED",
      message: "The latest report does not satisfy the supported detection contract.",
    },
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

export function createReportService({
  reportStorage,
  ledgerRepository = null,
  generationRepository = null,
} = {}) {
  const reportCacheTtlMsRaw = Number.parseInt(process.env.REPORT_CACHE_TTL_MS || "15000", 10);
  const reportCacheTtlMs = Number.isFinite(reportCacheTtlMsRaw) && reportCacheTtlMsRaw >= 0 ? reportCacheTtlMsRaw : 15000;

  const reportCache = new Map();
  const latestCacheKeyByTenant = new Map();
  const inflightLoadByTenant = new Map();
  const cacheGenerationByTenant = new Map();

  const readFromStorage = async (tenantContext) => {
    try {
      const loaded = await reportStorage.getLatestReport({ tenantContext });
      if (!loaded || !loaded.report) {
        const error = new TenantReportNotFoundError();
        return {
          ok: false,
          status: error.status,
          body: {
            available: false,
            code: error.code,
            message: error.message,
          },
        };
      }

      const storageTenant = loaded.metadata?.tenant || null;
      const allowedStorageTenants = new Set([
        tenantContext.tenant_id,
        tenantContext.tenant_slug,
      ].filter(Boolean));

      if (storageTenant && !allowedStorageTenants.has(storageTenant)) {
        const error = new Error("Report storage returned data outside the authenticated tenant partition.");
        error.code = "REPORT_TENANT_MISMATCH";
        throw error;
      }

      let report;
      try {
        report = parseDetectionReport(loaded.report, tenantContext.tenant_id);
        const pointerReportId = loaded.metadata?.reportId || loaded.metadata?.version || null;
        if (pointerReportId && /^[a-f0-9]{64}$/.test(pointerReportId) && pointerReportId !== report.metadata.reportId) {
          return reportContractFailure();
        }
        if (loaded.metadata?.sourceWatermark && loaded.metadata.sourceWatermark !== report.metadata.source.watermark) {
          return reportContractFailure();
        }
      } catch {
        return reportContractFailure();
      }

      return {
        ok: true,
        report,
        metadata: loaded.metadata || null,
      };
    } catch (error) {
      return reportStorageFailure(error);
    }
  };

  return {
    async loadReportOrFail(tenantContext) {
      const tenantId = tenantContext?.tenant_id || null;
      if (!tenantId) {
        return {
          ok: false,
          status: 403,
          body: {
            available: false,
            code: "TENANT_CONTEXT_REQUIRED",
            message: "Tenant authorization failed for this request.",
          },
        };
      }

      const now = Date.now();
      const latestCacheKey = latestCacheKeyByTenant.get(tenantId) || null;
      const cachedEntry = latestCacheKey ? reportCache.get(latestCacheKey) : null;
      const cacheIsFresh = cachedEntry && reportCacheTtlMs > 0 && now - cachedEntry.cachedAt <= reportCacheTtlMs;

      if (cacheIsFresh) {
        return cachedEntry.result;
      }

      if (!inflightLoadByTenant.has(tenantId)) {
        const generation = cacheGenerationByTenant.get(tenantId) || 0;
        const loadPromise = readFromStorage(tenantContext).finally(() => {
          if (inflightLoadByTenant.get(tenantId)?.promise === loadPromise) {
            inflightLoadByTenant.delete(tenantId);
          }
        });
        inflightLoadByTenant.set(tenantId, { generation, promise: loadPromise });
      }

      const inflightLoad = inflightLoadByTenant.get(tenantId);
      const result = await inflightLoad.promise;

      if (
        result?.ok &&
        inflightLoad.generation === (cacheGenerationByTenant.get(tenantId) || 0)
      ) {
        const pointerIdentity =
          result.metadata?.version ||
          result.metadata?.pointer ||
          result.metadata?.pointerBlob ||
          result.metadata?.reportBlob ||
          result.metadata?.location ||
          "unversioned";
        const cacheKey = `${tenantId}:${pointerIdentity}`;
        const previousCacheKey = latestCacheKeyByTenant.get(tenantId);
        if (previousCacheKey && previousCacheKey !== cacheKey) {
          reportCache.delete(previousCacheKey);
        }
        reportCache.set(cacheKey, {
          cachedAt: Date.now(),
          result,
        });
        latestCacheKeyByTenant.set(tenantId, cacheKey);
      }

      return result;
    },

    invalidateReportCache(tenantId = null) {
      if (!tenantId) {
        reportCache.clear();
        latestCacheKeyByTenant.clear();
        for (const activeTenantId of inflightLoadByTenant.keys()) {
          cacheGenerationByTenant.set(
            activeTenantId,
            (cacheGenerationByTenant.get(activeTenantId) || 0) + 1,
          );
        }
        inflightLoadByTenant.clear();
        return;
      }

      const cacheKey = latestCacheKeyByTenant.get(tenantId);
      if (cacheKey) {
        reportCache.delete(cacheKey);
      }
      latestCacheKeyByTenant.delete(tenantId);
      cacheGenerationByTenant.set(
        tenantId,
        (cacheGenerationByTenant.get(tenantId) || 0) + 1,
      );
      inflightLoadByTenant.delete(tenantId);
    },

    async checkReadiness() {
      const checks = {
        reportStorageConfigured: Boolean(reportStorage),
        reportStorageReachable: false,
        reportAvailable: false,
        databaseConfigured: Boolean(ledgerRepository),
        databaseReachable: null,
      };

      try {
        if (typeof reportStorage?.checkReadiness === "function") {
          const readiness = await reportStorage.checkReadiness();
          checks.reportStorageReachable = readiness?.reachable !== false;
          checks.reportAvailable = Boolean(readiness?.available);
        } else {
          const loaded = await reportStorage.getLatestReport();
          checks.reportStorageReachable = true;
          checks.reportAvailable = Boolean(loaded?.report);
        }
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
    },

    async getDetectionReport(tenantContext) {
      const loaded = await this.loadReportOrFail(tenantContext);
      if (!loaded.ok) {
        return loaded;
      }

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          report: loaded.report,
        },
      };
    },

    async getDetectionGraph(tenantContext) {
      const loaded = await this.loadReportOrFail(tenantContext);
      if (!loaded.ok) {
        return loaded;
      }

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          graph: loaded.report.graph,
        },
      };
    },

    async getDetectionRisk(tenantContext) {
      const loaded = await this.loadReportOrFail(tenantContext);
      if (!loaded.ok) {
        return loaded;
      }

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          risk: loaded.report.risk,
        },
      };
    },

    async getDetectionStatus(tenantContext) {
      const tenantId = tenantContext?.tenant_id || null;
      if (!tenantId) {
        return {
          ok: false,
          status: 403,
          body: {
            available: false,
            code: "TENANT_CONTEXT_REQUIRED",
            message: "Tenant authorization failed for this request.",
          },
        };
      }
      if (!generationRepository?.getLatestGenerationStatus) {
        return {
          ok: false,
          status: 503,
          body: {
            available: false,
            code: "GENERATION_STATUS_UNAVAILABLE",
            message: "Detection generation status is not configured.",
          },
        };
      }

      try {
        const [generation, loaded] = await Promise.all([
          generationRepository.getLatestGenerationStatus({ tenantId }),
          this.loadReportOrFail(tenantContext),
        ]);
        const reportWatermark = loaded.ok
          ? loaded.report.metadata.source.watermark
          : null;
        const targetWatermark = generation?.coveredWatermark
          || generation?.failedWatermark
          || null;
        let freshness = "unknown";
        if (!generation) freshness = reportWatermark ? "current" : "not_generated";
        else if (
          generation.status === CLAIM_PROCESSING_STATUS.COMPLETED
          && generation.coveredWatermark === reportWatermark
        ) freshness = "current";
        else if (targetWatermark && targetWatermark !== reportWatermark) freshness = "stale";
        else if (["pending", "processing", "retry"].includes(generation.status)) freshness = "pending";
        else if (generation.status === "dead_letter") freshness = "stale";

        return {
          ok: true,
          status: 200,
          body: {
            available: true,
            report: {
              available: Boolean(loaded.ok),
              watermark: reportWatermark,
              freshness,
            },
            generation: generation ? {
              jobId: generation.id,
              status: generation.status,
              attemptCount: generation.attemptCount,
              maxAttempts: generation.maxAttempts,
              failureCode: generation.failureCode,
              failedWatermark: generation.failedWatermark,
              coveredReportId: generation.coveredReportId,
              coveredWatermark: generation.coveredWatermark,
              updatedAt: generation.updatedAt,
              completedAt: generation.completedAt,
            } : null,
          },
        };
      } catch {
        return {
          ok: false,
          status: 503,
          body: {
            available: false,
            code: "GENERATION_STATUS_UNAVAILABLE",
            message: "Detection generation status could not be read.",
          },
        };
      }
    },
  };
}
