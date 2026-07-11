import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

import { AzureBlobReportStorage, FileReportStorage } from "../src/report-storage.js";

function createFakeBlobClient(store, blobName) {
  return {
    async exists() {
      return store.has(blobName);
    },
    async download() {
      const value = store.get(blobName);
      return {
        readableStreamBody: value == null ? null : Readable.from([Buffer.from(value, "utf-8")]),
      };
    },
  };
}

function createFakeContainerClient(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    containerName: "reports",
    getBlobClient(blobName) {
      return createFakeBlobClient(store, blobName);
    },
    _store: store,
  };
}

test("FileReportStorage returns latest report payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claimguard-report-storage-"));
  const reportPath = path.join(tempDir, "latest-report.json");
  await writeFile(reportPath, JSON.stringify({ schemes: [{ scheme_id: "S1" }] }), "utf-8");

  const storage = new FileReportStorage({ reportPath });
  const loaded = await storage.getLatestReport();

  assert.ok(loaded);
  assert.equal(loaded.report.schemes[0].scheme_id, "S1");
  assert.equal(loaded.metadata.source, "file");
});

test("FileReportStorage returns null without configured path", async () => {
  const storage = new FileReportStorage();
  const loaded = await storage.getLatestReport();
  assert.equal(loaded, null);
});

test("AzureBlobReportStorage loads report using latest pointer", async () => {
  const containerClient = createFakeContainerClient({
    "latest.json": JSON.stringify({ reportBlobName: "reports/report-v1.json", version: "v1" }),
    "reports/report-v1.json": JSON.stringify({ detection: { risk_score: { riskScore: 88 } } }),
  });

  const storage = new AzureBlobReportStorage({ containerClient });
  const loaded = await storage.getLatestReport();

  assert.ok(loaded);
  assert.equal(loaded.report.detection.risk_score.riskScore, 88);
  assert.equal(loaded.metadata.source, "azure_blob");
  assert.equal(loaded.metadata.version, "v1");
});

test("AzureBlobReportStorage falls back to configured report blob", async () => {
  const containerClient = createFakeContainerClient({
    "reports/report-v2.json": JSON.stringify({ detection: { risk_score: { riskScore: 25 } } }),
  });

  const storage = new AzureBlobReportStorage({
    containerClient,
    latestPointerBlobName: "latest.json",
    fallbackReportBlobName: "reports/report-v2.json",
  });

  const loaded = await storage.getLatestReport();

  assert.ok(loaded);
  assert.equal(loaded.report.detection.risk_score.riskScore, 25);
});
