import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateDeploymentBoundaries,
} from "../validate-deployment-boundaries.mjs";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function repositoryWorkflows() {
  return {
    ci: read(".github/workflows/ci.yml"),
    worker: read(".github/workflows/report-worker-deploy.yml"),
    legacyApi: read(".github/workflows/main_claimguard-api.yml"),
  };
}

test("current production deployment boundaries pass", () => {
  assert.doesNotThrow(() =>
    validateDeploymentBoundaries(repositoryWorkflows()));
});

test("ordinary main pushes cannot regain a deploy condition", () => {
  const workflows = repositoryWorkflows();
  const deploymentGuard =
    "github.event_name == 'workflow_dispatch' "
    + "&& github.ref == 'refs/heads/main' "
    + "&& inputs.production_confirmation == 'DEPLOY_PRODUCTION' "
    + "&& inputs.expected_main_sha == github.sha";
  workflows.ci = workflows.ci.replace(
    deploymentGuard,
    "github.event_name == 'push' && github.ref == 'refs/heads/main'",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /found 4/,
  );
});

test("worker deployment requires a manually dispatched CI run", () => {
  const workflows = repositoryWorkflows();
  workflows.worker = workflows.worker.replace(
    "github.event.workflow_run.event == 'workflow_dispatch'",
    "github.event.workflow_run.event == 'push'",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Report-worker deployment authorization is missing/,
  );
});

test("legacy API workflow cannot regain Azure deployment actions", () => {
  const workflows = repositoryWorkflows();
  workflows.legacyApi += "\n# azure/webapps-deploy\n";
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Retired direct API workflow still contains/,
  );
});
