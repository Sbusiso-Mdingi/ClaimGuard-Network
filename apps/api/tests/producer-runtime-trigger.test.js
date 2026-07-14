import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProducerTriggerArgs,
  scopeClaimsForTenant,
} from "../src/producer-runtime-trigger.js";

test("scopeClaimsForTenant injects tenant_id when missing", () => {
  const scoped = scopeClaimsForTenant(
    [
      {
        claim_id: "C-1",
        scheme_id: "scheme_a",
      },
    ],
    "tenant_alpha",
  );

  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].tenant_id, "tenant_alpha");
});

test("scopeClaimsForTenant preserves existing tenant_id values", () => {
  const scoped = scopeClaimsForTenant(
    [
      {
        claim_id: "C-2",
        scheme_id: "scheme_b",
        tenant_id: "tenant_beta",
      },
    ],
    "tenant_alpha",
  );

  assert.equal(scoped[0].tenant_id, "tenant_beta");
});

test("buildProducerTriggerArgs includes tenant-id and file output options", () => {
  const args = buildProducerTriggerArgs({
    baseArgs: ["run", "claimguard-produce-report"],
    claimsPath: "/tmp/claims.json",
    tenantId: "tenant_alpha",
    backend: "file",
    topN: "10",
    source: "api",
    outputDir: "/tmp/out",
  });

  assert.deepEqual(args, [
    "run",
    "claimguard-produce-report",
    "--claims-json",
    "/tmp/claims.json",
    "--tenant-id",
    "tenant_alpha",
    "--backend",
    "file",
    "--top-n",
    "10",
    "--trigger",
    "api",
    "--output-dir",
    "/tmp/out",
  ]);
});

test("buildProducerTriggerArgs omits file output flag for non-file backends", () => {
  const args = buildProducerTriggerArgs({
    baseArgs: ["run", "claimguard-produce-report"],
    claimsPath: "/tmp/claims.json",
    tenantId: "tenant_default",
    backend: "azure_blob",
    topN: "10",
    source: "ingest",
    outputDir: "/tmp/out",
  });

  assert.equal(args.includes("--output-dir"), false);
  assert.equal(args.includes("--tenant-id"), true);
});
