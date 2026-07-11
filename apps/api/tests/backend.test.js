import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

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

test("trpc ping endpoint returns pong", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/trpc/ping");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.result.data.service, "api");
  assert.equal(json.result.data.message, "pong");
});

function createReportStorageStub(report) {
  return {
    async getLatestReport() {
      return {
        report,
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

  const response = await app.request("http://localhost/detection/report");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.report.schemes[0].scheme_id, "scheme_a");
  assert.equal(json.report.detection.risk_score.riskScore, 87);
});

test("detection report endpoint includes runtime ledger reference when available", async () => {
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

  const response = await app.request("http://localhost/detection/report");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.report.detection.ledger_reference.available, true);
  assert.equal(json.report.detection.ledger_reference.entry.sequenceNumber, 9);
});

test("detection graph endpoint returns graph payload", async () => {
  const app = createBackendApp({
    reportStorage: createReportStorageStub({
      detection: {
        graph_summary: {
          entity_count: 3,
          relationship_count: 4,
        },
        entities: [{ entity_id: "claimant:M1" }],
        relationships: [{ source_entity_id: "claimant:M1", target_entity_id: "device:D1" }],
      },
    }),
  });

  const response = await app.request("http://localhost/detection/graph");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.graph.summary.entity_count, 3);
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

  const response = await app.request("http://localhost/detection/risk");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.risk.riskScore, 72);
  assert.equal(json.risk.severity, "High");
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

  const response = await app.request("http://localhost/detection/report");
  const json = await response.json();

  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});