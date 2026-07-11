import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

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

test("detection report endpoint returns a configured report", async () => {
  const tempDir = await fsMkdirTemp();
  const reportPath = path.join(tempDir, "report.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
    "utf-8",
  );

  const app = createBackendApp({ detectionReportPath: reportPath });
  const response = await app.request("http://localhost/detection/report");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.report.schemes[0].scheme_id, "scheme_a");
  assert.equal(json.report.detection.risk_score.riskScore, 87);
});

test("detection graph endpoint returns graph payload", async () => {
  const tempDir = await fsMkdirTemp();
  const reportPath = path.join(tempDir, "report.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      {
        detection: {
          graph_summary: {
            entity_count: 3,
            relationship_count: 4,
          },
          entities: [{ entity_id: "claimant:M1" }],
          relationships: [{ source_entity_id: "claimant:M1", target_entity_id: "device:D1" }],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const app = createBackendApp({ detectionReportPath: reportPath });
  const response = await app.request("http://localhost/detection/graph");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.graph.summary.entity_count, 3);
});

test("detection risk endpoint returns deterministic risk payload", async () => {
  const tempDir = await fsMkdirTemp();
  const reportPath = path.join(tempDir, "report.json");

  await writeFile(
    reportPath,
    JSON.stringify(
      {
        detection: {
          risk_score: {
            riskScore: 72,
            severity: "High",
            reasons: ["shared devices"],
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const app = createBackendApp({ detectionReportPath: reportPath });
  const response = await app.request("http://localhost/detection/risk");
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.available, true);
  assert.equal(json.risk.riskScore, 72);
  assert.equal(json.risk.severity, "High");
});

test("detection analyze endpoint accepts claims and returns deterministic output", async () => {
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

  const responseA = await app.request("http://localhost/detection/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseB = await app.request("http://localhost/detection/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const jsonA = await responseA.json();
  const jsonB = await responseB.json();

  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal(jsonA.available, true);
  assert.deepEqual(jsonA, jsonB);
  assert.ok(Array.isArray(jsonA.detection.triggered_rules));
  assert.equal(typeof jsonA.detection.risk_score.riskScore, "number");
});

test("detection report endpoint is unavailable without a configured path", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/detection/report");
  const json = await response.json();

  assert.equal(response.status, 503);
  assert.equal(json.available, false);
});

async function fsMkdirTemp() {
  const tempRoot = await import("node:fs/promises").then((module) => module.mkdtemp(path.join(os.tmpdir(), "claimguard-api-")));
  return tempRoot;
}