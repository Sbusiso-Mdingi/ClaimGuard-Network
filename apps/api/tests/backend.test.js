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