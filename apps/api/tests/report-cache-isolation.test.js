import assert from "node:assert/strict";
import test from "node:test";

import { createReportService } from "../src/services/report-service.js";
import { createCanonicalDetectionReport } from "./helpers/detection-report.js";

const alphaTenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
};

const betaTenant = {
  tenant_id: "tenant_beta",
  tenant_slug: "beta",
};

function reportFor(tenantId, version) {
  return {
    report: createCanonicalDetectionReport({
      tenantId,
      version,
      riskScore: tenantId === "tenant_alpha" ? 91 : 12,
      severity: tenantId === "tenant_alpha" ? "High" : "Low",
    }),
    metadata: {
      tenant: tenantId,
      version,
    },
  };
}

test("report cache and in-flight reads are isolated by immutable tenant ID", async () => {
  const originalTtl = process.env.REPORT_CACHE_TTL_MS;
  process.env.REPORT_CACHE_TTL_MS = "15000";
  const reads = [];
  const pending = new Map();

  try {
    const service = createReportService({
      reportStorage: {
        async getLatestReport({ tenantContext }) {
          reads.push(tenantContext.tenant_id);
          return new Promise((resolve) => pending.set(tenantContext.tenant_id, resolve));
        },
      },
    });

    const alphaPromise = service.getDetectionReport(alphaTenant);
    const betaPromise = service.getDetectionReport(betaTenant);
    await Promise.resolve();

    assert.deepEqual(reads.sort(), ["tenant_alpha", "tenant_beta"]);

    pending.get("tenant_beta")(reportFor("tenant_beta", "beta-v1"));
    const beta = await betaPromise;
    assert.equal(beta.body.report.metadata.tenant.tenantId, "tenant_beta");

    pending.get("tenant_alpha")(reportFor("tenant_alpha", "alpha-v1"));
    const alpha = await alphaPromise;
    assert.equal(alpha.body.report.metadata.tenant.tenantId, "tenant_alpha");

    const [cachedAlpha, cachedBeta] = await Promise.all([
      service.getDetectionReport(alphaTenant),
      service.getDetectionReport(betaTenant),
    ]);
    assert.equal(cachedAlpha.body.report.metadata.tenant.tenantId, "tenant_alpha");
    assert.equal(cachedBeta.body.report.metadata.tenant.tenantId, "tenant_beta");
    assert.equal(reads.filter((tenantId) => tenantId === "tenant_alpha").length, 1);
    assert.equal(reads.filter((tenantId) => tenantId === "tenant_beta").length, 1);
  } finally {
    if (originalTtl === undefined) delete process.env.REPORT_CACHE_TTL_MS;
    else process.env.REPORT_CACHE_TTL_MS = originalTtl;
  }
});

test("expired alpha cache and invalidation never evict or replace beta", async () => {
  const originalTtl = process.env.REPORT_CACHE_TTL_MS;
  const originalNow = Date.now;
  process.env.REPORT_CACHE_TTL_MS = "10";
  let now = 1_000;
  Date.now = () => now;
  const readCounts = new Map();

  try {
    const service = createReportService({
      reportStorage: {
        async getLatestReport({ tenantContext }) {
          const nextCount = (readCounts.get(tenantContext.tenant_id) || 0) + 1;
          readCounts.set(tenantContext.tenant_id, nextCount);
          return reportFor(tenantContext.tenant_id, `${tenantContext.tenant_id}-v${nextCount}`);
        },
      },
    });

    await service.getDetectionReport(alphaTenant);
    now = 1_005;
    await service.getDetectionReport(betaTenant);
    now = 1_011;

    const refreshedAlpha = await service.getDetectionReport(alphaTenant);
    const cachedBeta = await service.getDetectionReport(betaTenant);

    assert.equal(refreshedAlpha.body.report.metadata.tenant.tenantId, "tenant_alpha");
    assert.equal(cachedBeta.body.report.metadata.tenant.tenantId, "tenant_beta");
    assert.equal(readCounts.get("tenant_alpha"), 2);
    assert.equal(readCounts.get("tenant_beta"), 1);

    service.invalidateReportCache("tenant_alpha");
    await service.getDetectionReport(alphaTenant);
    await service.getDetectionReport(betaTenant);
    assert.equal(readCounts.get("tenant_alpha"), 3);
    assert.equal(readCounts.get("tenant_beta"), 1);
  } finally {
    Date.now = originalNow;
    if (originalTtl === undefined) delete process.env.REPORT_CACHE_TTL_MS;
    else process.env.REPORT_CACHE_TTL_MS = originalTtl;
  }
});

test("tenant invalidation prevents an older in-flight read from repopulating cache", async () => {
  const originalTtl = process.env.REPORT_CACHE_TTL_MS;
  process.env.REPORT_CACHE_TTL_MS = "15000";
  const pendingReads = [];

  try {
    const service = createReportService({
      reportStorage: {
        async getLatestReport() {
          return new Promise((resolve) => pendingReads.push(resolve));
        },
      },
    });

    const staleRequest = service.getDetectionReport(alphaTenant);
    await Promise.resolve();
    service.invalidateReportCache("tenant_alpha");
    const currentRequest = service.getDetectionReport(alphaTenant);
    await Promise.resolve();

    assert.equal(pendingReads.length, 2);
    pendingReads[1](reportFor("tenant_alpha", "alpha-v2"));
    assert.equal((await currentRequest).body.report.metadata.tenant.tenantId, "tenant_alpha");
    pendingReads[0](reportFor("tenant_alpha", "alpha-v1"));
    await staleRequest;

    const cached = await service.getDetectionReport(alphaTenant);
    assert.equal(cached.body.report.metadata.source.watermark, "alpha-v2");
    assert.equal(pendingReads.length, 2);
  } finally {
    if (originalTtl === undefined) delete process.env.REPORT_CACHE_TTL_MS;
    else process.env.REPORT_CACHE_TTL_MS = originalTtl;
  }
});
