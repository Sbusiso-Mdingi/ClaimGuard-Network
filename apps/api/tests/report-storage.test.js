import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";

import { runWithTenantContext } from "@claimguard/database";

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

test("FileReportStorage loads tenant-scoped report using tenant latest pointer", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claimguard-tenant-report-storage-"));
  const tenantDir = path.join(tempDir, "tenant-alpha");
  const tenantReportPath = path.join(tenantDir, "versions", "report-v1.json");

  await mkdir(path.join(tenantDir, "versions"), { recursive: true });
  await writeFile(path.join(tenantDir, "latest.json"), JSON.stringify({ reportPath: "tenant-alpha/versions/report-v1.json", version: "v1" }), "utf-8");
  await writeFile(tenantReportPath, JSON.stringify({ schemes: [{ scheme_id: "S-alpha" }] }), "utf-8");

  const storage = new FileReportStorage({ tenantReportsRoot: tempDir });
  const loaded = await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "tenant-alpha",
      scheme_id: null,
      source: "header",
    },
    () => storage.getLatestReport(),
  );

  assert.ok(loaded);
  assert.equal(loaded.report.schemes[0].scheme_id, "S-alpha");
  assert.equal(loaded.metadata.tenant, "tenant-alpha");
  assert.equal(loaded.metadata.version, "v1");
});

test("FileReportStorage falls back to default tenant partition", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "claimguard-tenant-fallback-"));
  const defaultTenantDir = path.join(tempDir, "default");
  const defaultReportPath = path.join(defaultTenantDir, "versions", "report-default.json");

  await mkdir(path.join(defaultTenantDir, "versions"), { recursive: true });
  await writeFile(path.join(defaultTenantDir, "latest.json"), JSON.stringify({ reportPath: "default/versions/report-default.json", version: "v-default" }), "utf-8");
  await writeFile(defaultReportPath, JSON.stringify({ schemes: [{ scheme_id: "S-default" }] }), "utf-8");

  const storage = new FileReportStorage({ tenantReportsRoot: tempDir });
  const loaded = await runWithTenantContext(
    {
      tenant_id: "tenant_missing",
      tenant_slug: "tenant-missing",
      scheme_id: null,
      source: "header",
    },
    () => storage.getLatestReport(),
  );

  assert.ok(loaded);
  assert.equal(loaded.report.schemes[0].scheme_id, "S-default");
  assert.equal(loaded.metadata.tenant, "default");
});

test("AzureBlobReportStorage enforces tenant-specific report isolation", async () => {
  const containerClient = createFakeContainerClient({
    "tenant-alpha/latest.json": JSON.stringify({ reportBlobName: "tenant-alpha/versions/report-v1.json", version: "alpha-v1" }),
    "tenant-alpha/versions/report-v1.json": JSON.stringify({ detection: { risk_score: { riskScore: 91 } } }),
    "tenant-beta/latest.json": JSON.stringify({ reportBlobName: "tenant-beta/versions/report-v1.json", version: "beta-v1" }),
    "tenant-beta/versions/report-v1.json": JSON.stringify({ detection: { risk_score: { riskScore: 12 } } }),
  });

  const storage = new AzureBlobReportStorage({ containerClient });

  const alphaLoaded = await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "tenant-alpha",
      scheme_id: null,
      source: "header",
    },
    () => storage.getLatestReport(),
  );

  const betaLoaded = await runWithTenantContext(
    {
      tenant_id: "tenant_beta",
      tenant_slug: "tenant-beta",
      scheme_id: null,
      source: "header",
    },
    () => storage.getLatestReport(),
  );

  assert.ok(alphaLoaded);
  assert.ok(betaLoaded);
  assert.equal(alphaLoaded.report.detection.risk_score.riskScore, 91);
  assert.equal(betaLoaded.report.detection.risk_score.riskScore, 12);
  assert.equal(alphaLoaded.metadata.tenant, "tenant-alpha");
  assert.equal(betaLoaded.metadata.tenant, "tenant-beta");
});

test("AzureBlobReportStorage falls back to default tenant when tenant-specific pointer is absent", async () => {
  const containerClient = createFakeContainerClient({
    "default/latest.json": JSON.stringify({ reportBlobName: "default/versions/report-v1.json", version: "default-v1" }),
    "default/versions/report-v1.json": JSON.stringify({ detection: { risk_score: { riskScore: 44 } } }),
  });

  const storage = new AzureBlobReportStorage({ containerClient });
  const loaded = await runWithTenantContext(
    {
      tenant_id: "tenant_gamma",
      tenant_slug: "tenant-gamma",
      scheme_id: null,
      source: "header",
    },
    () => storage.getLatestReport(),
  );

  assert.ok(loaded);
  assert.equal(loaded.report.detection.risk_score.riskScore, 44);
  assert.equal(loaded.metadata.tenant, "default");
});
