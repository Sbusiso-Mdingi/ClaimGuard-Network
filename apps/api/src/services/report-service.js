function reportStorageFailure(error) {
  return {
    ok: false,
    status: 503,
    body: {
      available: false,
      message: `The configured report storage could not be read yet.${error?.message ? ` ${error.message}` : ""}`,
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

export function createReportService({
  reportStorage,
  ledgerRepository = null,
  producerRuntimeTrigger = null,
  detectionAnalyzeProxyUrl = null,
} = {}) {
  const reportCacheTtlMsRaw = Number.parseInt(process.env.REPORT_CACHE_TTL_MS || "15000", 10);
  const reportCacheTtlMs = Number.isFinite(reportCacheTtlMsRaw) && reportCacheTtlMsRaw >= 0 ? reportCacheTtlMsRaw : 15000;

  let cachedReport = null;
  let cachedReportAt = 0;
  let inflightLoadPromise = null;

  const readFromStorage = async () => {
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
      return reportStorageFailure(error);
    }
  };

  return {
    async loadReportOrFail() {
      const now = Date.now();
      const cacheIsFresh =
        cachedReport && reportCacheTtlMs > 0 && now - cachedReportAt <= reportCacheTtlMs;

      if (cacheIsFresh) {
        return cachedReport;
      }

      if (!inflightLoadPromise) {
        inflightLoadPromise = readFromStorage().finally(() => {
          inflightLoadPromise = null;
        });
      }

      const result = await inflightLoadPromise;

      if (result?.ok) {
        cachedReport = result;
        cachedReportAt = Date.now();
      }

      return result;
    },

    async checkReadiness() {
      const checks = {
        reportStorageConfigured: Boolean(reportStorage),
        reportStorageReachable: false,
        reportAvailable: false,
        databaseConfigured: Boolean(ledgerRepository),
        databaseReachable: null,
        producerTriggerConfigured: Boolean(producerRuntimeTrigger),
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

    async getDetectionReport() {
      const loaded = await this.loadReportOrFail();
      if (!loaded.ok) {
        return loaded;
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

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          report,
        },
      };
    },

    async getDetectionGraph() {
      const loaded = await this.loadReportOrFail();
      if (!loaded.ok) {
        return loaded;
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

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          graph,
        },
      };
    },

    async getDetectionRisk() {
      const loaded = await this.loadReportOrFail();
      if (!loaded.ok) {
        return loaded;
      }

      const risk = loaded.report?.detection?.risk_score || {
        riskScore: 0,
        severity: "Low",
        reasons: ["Detection risk is unavailable in the current report."],
      };

      return {
        ok: true,
        status: 200,
        body: {
          available: true,
          risk,
        },
      };
    },

    async analyze(payload) {
      if (!detectionAnalyzeProxyUrl) {
        return {
          ok: true,
          status: 410,
          body: {
            available: false,
            deprecated: true,
            message: "Detection analysis moved to the report producer runtime. Configure DETECTION_ANALYZE_PROXY_URL to proxy this compatibility route.",
          },
        };
      }

      try {
        const proxied = await proxyDetectionAnalyze(detectionAnalyzeProxyUrl, payload);
        return {
          ok: true,
          status: proxied.status,
          body: proxied.body,
        };
      } catch {
        return {
          ok: true,
          status: 502,
          body: {
            available: false,
            message: "Detection producer proxy is unavailable.",
          },
        };
      }
    },
  };
}
