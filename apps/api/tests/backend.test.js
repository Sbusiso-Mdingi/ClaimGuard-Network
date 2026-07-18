import assert from "node:assert/strict";
import test from "node:test";
import { createFraudWorkflowRepositoryStub } from "./helpers/fraud-workflow-stub.js";
import { createCanonicalDetectionReport } from "./helpers/detection-report.js";

import { createBackendApp } from "../src/backend.js";
import { createAuthenticatedAuthContext } from "../src/middleware/auth-context.js";

function developmentAuthHeaders({
  user = "scheme-user",
  role = "scheme_user",
  tenantId = "tenant_default",
} = {}) {
  return {
    "x-claimguard-user": user,
    "x-claimguard-role": role,
    "x-claimguard-user-tenant": tenantId,
  };
}

function createLedgerRepositoryStub(entry) {
  return {
    async getLatestEntry() {
      return entry;
    },
  };
}

test("health endpoint returns phase 3 payload", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/health");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.service, "api");
  assert.equal(json.phase, "3");
});

test("live endpoint returns liveness payload", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/live");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.live, true);
  assert.equal(json.service, "api");
});

test("ready endpoint returns readiness details when dependencies are healthy", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        risk_score: {
          riskScore: 44,
          severity: "Medium",
          reasons: ["test"],
        },
      },
    }),
    ledgerRepository: {
      async getLatestEntry() {
        return null;
      },
      async getLatestConfirmedFraudEntry() {
        return null;
      },
    },
  });

  const response = await app.request("http://localhost/ready");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ready, true);
  assert.equal(json.status, "ok");
  assert.equal(json.checks.reportStorageReachable, true);
  assert.equal(json.checks.databaseReachable, true);
});

test("ready endpoint returns 200 degraded when report storage is unreachable", async () => {
  const app = createBackendApp({
    reportStorage: {
      async getLatestReport() {
        throw new Error("unreachable");
      },
    },
  });

  const response = await app.request("http://localhost/ready");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ready, true);
  assert.equal(json.status, "degraded");
  assert.equal(json.checks.reportStorageReachable, false);
});

test("internal data-plane health is a platform diagnostic and does not require private route resolution", async () => {
  let resolveCalls = 0;
  const app = createBackendApp({
    authenticationProvider: {
      async resolveAuthContext() {
        return createAuthenticatedAuthContext({
          userId: "platform-admin",
          organisationId: "org-platform",
          tenantId: null,
          roles: ["platform_administrator"],
          permissions: ["platform_health.view"],
          organisation: { organisationId: "org-platform", organisationType: "platform" },
          source: "session",
        });
      },
    },
    dataPlaneRuntime: {
      routeResolver: {
        async resolve() {
          resolveCalls += 1;
          throw new Error("internal data-plane health should not invoke route resolver");
        },
      },
      connectionManager: {
        async acquire() {
          throw new Error("internal data-plane health should not acquire a private pool");
        },
        metrics() {
          return {
            pools: [
              {
                activeRequests: 0,
                retiring: false,
                lastSuccessfulConnectionAt: "2026-07-18T00:00:00.000Z",
                lastFailureCategory: null,
              },
            ],
          };
        },
      },
      async checkReadiness() {
        return {
          ready: true,
          checks: {
            controlPlaneReachable: true,
            legacySharedBaselineReachable: true,
            schemaCompatible: true,
          },
        };
      },
      logger() {},
    },
  });

  const response = await app.request("http://localhost/internal/data-plane/health", {
    headers: { accept: "application/json" },
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.route.type, "platform_diagnostic");
  assert.equal(json.readiness.ready, true);
  assert.equal(resolveCalls, 0);
});

test("api sets x-request-id response header", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/health");
  const requestId = response.headers.get("x-request-id");

  assert.ok(requestId);
  assert.ok(requestId.length > 0);
});

test("trpc ping endpoint returns pong", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/trpc/ping");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.result.data.service, "api");
  assert.equal(json.result.data.message, "pong");
});

function createReportStorageStub(report) {
  const risk = report?.detection?.risk_score || {};
  const canonicalReport = report?.contractVersion ? report : createCanonicalDetectionReport({
    riskScore: Number.isFinite(risk.riskScore) ? risk.riskScore : null,
    severity: risk.severity || null,
    reasons: risk.reasons || [],
    nodes: report?.detection?.entities || [],
    edges: report?.detection?.relationships || [],
  });
  return {
    async getLatestReport() {
      return {
        report: canonicalReport,
        metadata: {
          source: "test",
          version: "test-v1",
        },
      };
    },
  };
}

test("detection report endpoint returns a configured report", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      data_dir: "/tmp/data",
      detection: {
        risk_score: {
          riskScore: 87,
          severity: "High",
          reasons: ["sample reason"],
        },
        graph_summary: {
          entity_count: 12,
          relationship_count: 18,
        },
        entities: [],
        relationships: [],
      },
      schemes: [
        {
          scheme_id: "scheme_a",
          provider_findings: [],
          member_findings: [],
        },
      ],
    }),
  });

  const response = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.report.contractVersion, "1.0");
  assert.equal(json.report.risk.riskScore, 87);
});

test("detection report endpoint does not mutate the detection artifact with runtime ledger data", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        risk_score: {
          riskScore: 25,
          severity: "Low",
          reasons: ["sample reason"],
        },
        ledger_reference: {
          type: "runtime-ledger",
          available: false,
        },
      },
    }),
    ledgerRepository: createLedgerRepositoryStub({
      sequenceNumber: 9,
      entryType: "YELLOW_FLAG",
      previousHash: "0".repeat(64),
      entryHash: "b".repeat(64),
      payload: { source: "runtime" },
    }),
  });

  const response = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.report.ledgerReference, undefined);
});

test("detection report endpoint does not invent a ledger reference when none exists", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        risk_score: {
          riskScore: 12,
          severity: "Low",
          reasons: ["none"],
        },
      },
    }),
    ledgerRepository: {
      async getLatestConfirmedFraudEntry() {
        return null;
      },
    },
  });

  const response = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.report.ledgerReference, undefined);
});

test("detection graph endpoint returns graph payload", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        graph_summary: {
          entity_count: 3,
          relationship_count: 4,
        },
        entities: [{ entity_id: "claimant:M1" }, { entity_id: "device:D1" }],
        relationships: [{ source_entity_id: "claimant:M1", target_entity_id: "device:D1" }],
      },
    }),
  });

  const response = await app.request("http://localhost/detection/graph", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.graph.summary.entity_count, 2);
});

test("detection risk endpoint returns deterministic risk payload", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        risk_score: {
          riskScore: 72,
          severity: "High",
          reasons: ["shared devices"],
        },
      },
    }),
  });

  const response = await app.request("http://localhost/detection/risk", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.risk.riskScore, 72);
  assert.equal(json.risk.severity, "High");
});

test("unsupported detection report contract returns a typed unavailable response", async () => {
  const report = createCanonicalDetectionReport();
  report.contractVersion = "2.0";
  const app = createBackendApp({ reportStorage: createReportStorageStub(report) });
  const response = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();
  assert.equal(response.status, 422);
  assert.equal(json.available, false);
  assert.equal(json.code, "REPORT_CONTRACT_UNSUPPORTED");
});

test("detection analyze endpoint is deprecated when no producer proxy is configured", async () => {
  const app = createBackendApp();
  const payload = {
    claims: [
      {
        claim_id: "C1",
        member_id: "M1",
        provider_id: "P1",
        phone: "555-1000",
        email: "shared@example.com",
        address: "ADDR-1",
        bank_account: "BANK-1",
        device_id: "DEVICE-1",
        ip_address: "10.0.0.1",
      },
      {
        claim_id: "C2",
        member_id: "M2",
        provider_id: "P2",
        phone: "555-1000",
        email: "shared@example.com",
        address: "ADDR-1",
        bank_account: "BANK-1",
        device_id: "DEVICE-1",
        ip_address: "10.0.0.2",
      },
    ],
  };

  const response = await app.request("http://localhost/detection/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...developmentAuthHeaders({ role: "scheme_administrator" }),
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json();

  assert.equal(response.status, 410);
  assert.equal(json.available, false);
  assert.equal(json.deprecated, true);
});

test("detection analyze endpoint proxies to producer when configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        available: true,
        detection: {
          risk_score: {
            riskScore: 54,
            severity: "Medium",
            reasons: ["proxied"],
          },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  try {
    const app = createBackendApp({ detectionAnalyzeProxyUrl: "http://producer.local/detection/analyze" });
    const response = await app.request("http://localhost/detection/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...developmentAuthHeaders({ role: "scheme_administrator" }),
      },
      body: JSON.stringify({ claims: [{ claim_id: "C1" }] }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.available, true);
    assert.equal(json.detection.risk_score.riskScore, 54);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detection report endpoint is unavailable without configured report storage data", async () => {
  const app = createBackendApp({
    reportStorage: {
      async getLatestReport() {
        return null;
      },
    },
  });

  const response = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const json = await response.json();

  assert.equal(response.status, 404);
  assert.equal(json.available, false);
});

test("claims ingestion endpoint requires configured ingestion service", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...developmentAuthHeaders(),
    },
    body: JSON.stringify({ claims: [{ claim_id: "C1" }] }),
  });

  const json = await response.json();
  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});

test("claims ingestion endpoint accepts claims via ingestion service", async () => {
  const app = createBackendApp({
    claimIngestionService: {
      async ingestClaims({ claims, source }) {
        return {
          received: claims.length,
          inserted: claims.length,
          updated: 0,
          source,
          processing: {
            status: "queued",
            asynchronous: true,
            jobId: "job-200",
            correlationId: "request-200",
            reused: false,
          },
        };
      },
    },
  });

  const response = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...developmentAuthHeaders(),
    },
    body: JSON.stringify({
      source: "synthetic-loader",
      claims: [
        {
          claim_id: "C-200",
          scheme_id: "scheme_a",
          member_id: "M-10",
          provider_id: "P-20",
          service_date: "2025-02-01",
          billing_code: "CONSULT",
          amount: 91.4,
        },
      ],
    }),
  });

  const json = await response.json();
  assert.equal(response.status, 202);
  assert.equal(json.available, true);
  assert.equal(json.committed, true);
  assert.equal(json.processing.status, "queued");
  assert.equal(json.processing.asynchronous, true);
  assert.equal(json.processing.jobId, "job-200");
  assert.equal(json.ingestion.received, 1);
  assert.equal(json.ingestion.source, "synthetic-loader");
});

test("claims list endpoint requires configured read repository", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/claims", {
    headers: developmentAuthHeaders(),
  });

  const json = await response.json();
  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});

test("claims list and details endpoints return authoritative claim payloads", async () => {
  const claimsReadRepository = {
    async listClaims({ page, pageSize }) {
      assert.equal(page, "1");
      assert.equal(pageSize, "10");
      return {
        claims: [{
          claimId: "C-300",
          schemeId: "scheme_a",
          memberId: "M-300",
          providerId: "P-300",
          status: "SUBMITTED",
          riskScore: null,
          riskLevel: null,
          submittedAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          triggeredRules: [],
          evidence: [],
        }],
        pagination: {
          page: 1,
          pageSize: 10,
          requestedPageSize: 10,
          maxPageSize: 100,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      };
    },
    async getClaimById(claimId) {
      if (claimId === "C-300") {
        return {
          claimId: "C-300",
          schemeId: "scheme_a",
          memberId: "M-300",
          providerId: "P-300",
          status: "SUBMITTED",
          riskScore: null,
          riskLevel: null,
          submittedAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          triggeredRules: [],
          evidence: [],
        };
      }
      return null;
    },
  };

  const app = createBackendApp({ claimReadRepository: claimsReadRepository });

  const listResponse = await app.request("http://localhost/claims?page=1&pageSize=10", {
    headers: developmentAuthHeaders(),
  });
  const listJson = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listJson.available, true);
  assert.equal(listJson.claims.length, 1);
  assert.equal(listJson.claims[0].claimId, "C-300");

  const detailResponse = await app.request("http://localhost/claims/C-300", {
    headers: developmentAuthHeaders(),
  });
  const detailJson = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailJson.available, true);
  assert.equal(detailJson.claim.claimId, "C-300");

  const missingResponse = await app.request("http://localhost/claims/C-404", {
    headers: developmentAuthHeaders(),
  });
  const missingJson = await missingResponse.json();
  assert.equal(missingResponse.status, 404);
  assert.equal(missingJson.available, false);
});

test("investigation confirm-fraud endpoint writes confirmed ledger entry", async () => {
  const app = createBackendApp({
    fraudWorkflowRepository: createFraudWorkflowRepositoryStub(),
    investigationRepository: {
      async getInvestigationById(investigationId) {
        if (investigationId !== "investigation-300") {
          return null;
        }

        return {
          investigationId,
          tenantId: "tenant_default",
          claimId: "C-300",
          status: "CONFIRMED_FRAUD",
          fraudConfirmedAt: null,
        };
      },
      async markFraudPublished(investigationId) {
        assert.equal(investigationId, "investigation-300");
        return true;
      },
    },
  });

  const response = await app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...developmentAuthHeaders({
        user: "INV-1",
        role: "investigator",
      }),
    },
    body: JSON.stringify({
      investigationId: "investigation-300",
      claimId: "C-300",
      investigatorId: "INV-1",
      reason: "Patient denied receiving treatment",
      schemeId: "scheme_a",
      reportVersion: "v20250101",
    }),
  });

  const json = await response.json();
  assert.equal(response.status, 201);
  assert.equal(json.available, true);
  assert.equal(json.entry.entryType, "INVESTIGATOR_CONFIRMED_FRAUD");
  assert.equal(json.entry.payload.claimId, "C-300");
});

test("confirmation route uses authenticated actor and returns 200 for an idempotent replay", async () => {
  const seen = new Map();
  const workflow = createFraudWorkflowRepositoryStub({
    async confirm(input, helpers) {
      const existing = seen.get(input.idempotencyKey);
      if (existing) {
        return { ...existing, replayed: true };
      }
      const ledgerEntry = helpers.entry("INVESTIGATOR_CONFIRMED_FRAUD", input, 1);
      const result = {
        entry: ledgerEntry,
        registryEntry: helpers.registry(input, ledgerEntry, "ACTIVE"),
        replayed: false,
      };
      seen.set(input.idempotencyKey, result);
      return result;
    },
  });
  const app = createBackendApp({ fraudWorkflowRepository: workflow });
  const request = () => app.request("http://localhost/investigations/confirm-fraud", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route-key-1",
      ...developmentAuthHeaders({ user: "authenticated-investigator", role: "investigator" }),
    },
    body: JSON.stringify({
      investigationId: "investigation-route",
      claimId: "claim-route",
      investigatorId: "untrusted-body-user",
      registryMetadata: { investigatorReference: "untrusted-body-user" },
      reason: "Persisted evidence confirms fraud.",
    }),
  });

  const first = await request();
  const replay = await request();
  const replayBody = await replay.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.replayed, true);
  assert.equal(workflow.confirmations[0].actorId, "authenticated-investigator");
  assert.equal(workflow.confirmations[0].idempotencyKey, "route-key-1");
  assert.equal(Object.hasOwn(workflow.confirmations[0], "registryMetadata"), false);
});

test("claims ingestion never runs the legacy producer trigger and remains committed when it would fail", async () => {
  const state = {
    ingestedClaims: [],
    triggerCount: 0,
  };

  const claimIngestionService = {
    async ingestClaims({ claims, source }) {
      state.ingestedClaims = claims.map((claim) => ({
        ...claim,
        billing_code: claim.billing_code || "UNKNOWN",
      }));

      return {
        received: claims.length,
        inserted: claims.length,
        updated: 0,
        source,
        processing: {
          status: "queued",
          asynchronous: true,
          jobId: "job-500",
          correlationId: "request-500",
          reused: false,
        },
      };
    },
  };

  const producerRuntimeTrigger = {
    async triggerAfterIngestion() {
      state.triggerCount += 1;
      throw new Error("legacy producer failure must be unreachable");
    },
  };

  const reportStorage = {
    async getLatestReport() {
      return null;
    },
  };

  const app = createBackendApp({
    claimIngestionService,
    producerRuntimeTrigger,
    reportStorage,
  });

  const ingestResponse = await app.request("http://localhost/claims/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...developmentAuthHeaders(),
    },
    body: JSON.stringify({
      source: "api-runtime-flow",
      claims: [
        {
          claim_id: "C-500",
          scheme_id: "scheme_a",
          member_id: "M-500",
          provider_id: "P-500",
          service_date: "2026-01-15",
          billing_code: "CONSULT",
          amount: 321.11,
        },
      ],
    }),
  });

  const ingestJson = await ingestResponse.json();
  assert.equal(ingestResponse.status, 202);
  assert.equal(ingestJson.available, true);
  assert.equal(ingestJson.committed, true);
  assert.equal(ingestJson.processing.status, "queued");
  assert.equal(ingestJson.processing.jobId, "job-500");
  assert.equal(state.triggerCount, 0);

  const reportResponse = await app.request("http://localhost/detection/report", {
    headers: developmentAuthHeaders(),
  });
  const reportJson = await reportResponse.json();
  assert.equal(reportResponse.status, 404);
  assert.equal(reportJson.available, false);
});
