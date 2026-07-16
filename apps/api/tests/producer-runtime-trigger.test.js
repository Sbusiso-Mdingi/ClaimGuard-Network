import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProducerTriggerArgs,
  createProducerRuntimeTriggerFromEnvironment,
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

test("scopeClaimsForTenant overrides untrusted claim tenant values with canonical tenant", () => {
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

  assert.equal(scoped[0].tenant_id, "tenant_alpha");
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

test("producer trigger fails closed without canonical tenant context", async () => {
  const trigger = createProducerRuntimeTriggerFromEnvironment({ repoRoot: process.cwd() });

  await assert.rejects(
    () => trigger.triggerAfterIngestion({ claims: [], tenantContext: null }),
    (error) => error?.code === "TENANT_CONTEXT_REQUIRED",
  );
});
