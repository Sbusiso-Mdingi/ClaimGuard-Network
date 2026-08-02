import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_OPERATIONAL_MIGRATION_ID,
  CANONICAL_OPERATIONAL_MIGRATION_VERSION,
  CANONICAL_OPERATIONAL_SCHEMA_VERSION,
  defaultMigrationPaths,
} from "../src/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function repoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("canonical operational schema bindings and deployment inputs do not drift", async () => {
  assert.match(CANONICAL_OPERATIONAL_SCHEMA_VERSION, /^[1-9]\d*$/);
  assert.equal(
    CANONICAL_OPERATIONAL_MIGRATION_VERSION,
    Number(CANONICAL_OPERATIONAL_SCHEMA_VERSION),
  );

  const canonicalMigrationPath = defaultMigrationPaths.at(-1);
  assert.equal(
    path.basename(canonicalMigrationPath),
    `${CANONICAL_OPERATIONAL_MIGRATION_ID}.sql`,
  );

  const migrationSql = await readFile(canonicalMigrationPath, "utf8");
  assert.match(
    migrationSql,
    new RegExp(
      `SET\\s+schema_version\\s*=\\s*'${CANONICAL_OPERATIONAL_SCHEMA_VERSION}'`
      + `\\s*,\\s*migration_version\\s*=\\s*${CANONICAL_OPERATIONAL_MIGRATION_VERSION}`,
      "i",
    ),
  );

  const pythonBinding = await repoFile(
    "services/report-producer/src/claimguard_report_producer/operational_schema.py",
  );
  assert.match(
    pythonBinding,
    new RegExp(
      `CANONICAL_OPERATIONAL_SCHEMA_VERSION = "${CANONICAL_OPERATIONAL_SCHEMA_VERSION}"`,
    ),
  );

  for (const bicepPath of [
    "infra/event-report-worker.bicep",
    "infra/report-worker.bicep",
    "infra/recovery-job-bootstrap.bicep",
  ]) {
    const bicep = await repoFile(bicepPath);
    assert.match(bicep, /param operationalSchemaVersion string/);
    assert.doesNotMatch(bicep, /schemaVersion:\s*'[1-9]\d*'/);
  }

  const releaseWorkflow = await repoFile(
    ".github/workflows/report-worker-deploy.yml",
  );
  assert.match(releaseWorkflow, /CANONICAL_OPERATIONAL_SCHEMA_VERSION/);
  assert.match(releaseWorkflow, /operationalSchemaVersion="\$OPERATIONAL_SCHEMA_VERSION"/);

  const recoveryBootstrap = await repoFile(
    "infra/bootstrap-report-recovery-job.sh",
  );
  assert.match(recoveryBootstrap, /CANONICAL_OPERATIONAL_SCHEMA_VERSION/);
  assert.match(recoveryBootstrap, /operationalSchemaVersion="\$OPERATIONAL_SCHEMA_VERSION"/);

  const provisioningManifest = await repoFile(
    "apps/provisioning-worker/aca-job.phase11e.yaml",
  );
  assert.doesNotMatch(provisioningManifest, /PRIVATE_TENANT_SCHEMA_VERSION/);

  for (const consumerPath of [
    "apps/api/tests/desktop-tenant-enforcement.test.js",
    "apps/provisioning-worker/tests/mysql.integration.test.js",
    "packages/control-plane-database/test-support/phase11d-fixtures.js",
    "packages/database/tests/claims-read-repository.test.js",
    "packages/database/tests/prospective-claims-read-repository.test.js",
    "tools/diagnose-investigation-queue.mjs",
    "tools/prospective-production-verification.mjs",
  ]) {
    const consumer = await repoFile(consumerPath);
    assert.match(consumer, /CANONICAL_OPERATIONAL_SCHEMA_VERSION/);
    assert.doesNotMatch(
      consumer,
      /(?:const|let|var)\s+CANONICAL_OPERATIONAL_SCHEMA_VERSION\s*=/,
    );
    assert.doesNotMatch(consumer, /schemaVersion:\s*["'][1-9]\d*["']/);
  }
});
