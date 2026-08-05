import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("supported operational construction excludes the writable legacy fraud repository", async () => {
  const source = await readFile(
    path.join(repoRoot, "packages/database/src/operational-repositories.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /createFraudWorkflowRepository/);
  assert.match(source, /createDisabledLegacyFraudWorkflowAdapter/);
  assert.match(source, /LEGACY_FRAUD_CONFIRMATION_DISABLED/);
  assert.match(source, /LEGACY_FRAUD_REVERSAL_DISABLED/);
  assert.match(source, /fraudWorkflow:\s*createDisabledLegacyFraudWorkflowAdapter\(\)/);
});
