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
    eventWorker: read("infra/event-report-worker.bicep"),
    recoveryBootstrap: read("infra/recovery-job-bootstrap.bicep"),
    recoveryBootstrapScript: read("infra/bootstrap-report-recovery-job.sh"),
    apiHealthScript: read("infra/verify-api-health.sh"),
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

test("worker recovery cannot regain a live recurring schedule", () => {
  const workflows = repositoryWorkflows();
  workflows.worker = workflows.worker.replaceAll(
    "0 0 1 1 *",
    "*/15 * * * *",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Report-worker deployment authorization is missing/,
  );
});

test("event-worker infrastructure keeps recovery parked", () => {
  const workflows = repositoryWorkflows();
  workflows.eventWorker = workflows.eventWorker.replace(
    "param recoveryScheduleCron string = '0 0 1 1 *'",
    "param recoveryScheduleCron string = '*/15 * * * *'",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Event-worker parked recovery is missing/,
  );
});

test("first recovery-job bootstrap cannot acquire a schedule", () => {
  const workflows = repositoryWorkflows();
  workflows.recoveryBootstrap = workflows.recoveryBootstrap.replace(
    "triggerType: 'Manual'",
    "triggerType: 'Schedule'\n      cronExpression: '*/5 * * * *'",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Recovery-job identity bootstrap/,
  );
});

test("first recovery-job bootstrap cannot contain an identity", () => {
  const workflows = repositoryWorkflows();
  workflows.recoveryBootstrap = workflows.recoveryBootstrap.replace(
    "properties: {",
    "identity: {\n    type: 'UserAssigned'\n  }\n  properties: {",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Recovery-job identity bootstrap/,
  );
});

test("recovery bootstrap must attach identity after shell creation", () => {
  const workflows = repositoryWorkflows();
  workflows.recoveryBootstrapScript =
    workflows.recoveryBootstrapScript.replace(
      "create_identity_free_shell_if_absent\n",
      "attach_expected_identity_if_missing \"$recovery_job\" \"$worker_identity_id\"\n",
    );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /operation order is unsafe/,
  );
});

test("recovery bootstrap cannot omit the supported identity attachment", () => {
  const workflows = repositoryWorkflows();
  workflows.recoveryBootstrapScript =
    workflows.recoveryBootstrapScript.replace(
      "az containerapp job identity assign",
      "az containerapp job update",
    );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Recovery-job bootstrap script is missing/,
  );
});

test("worker deployment cannot move RBAC verification after deployment", () => {
  const workflows = repositoryWorkflows();
  workflows.worker = workflows.worker
    .replace(
      "Verify queue-scoped runtime RBAC before deployment",
      "TEMPORARY_STEP_NAME",
    )
    .replace(
      "Build and push immutable report-worker image",
      "Verify queue-scoped runtime RBAC before deployment",
    )
    .replace(
      "TEMPORARY_STEP_NAME",
      "Build and push immutable report-worker image",
    );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /step order is unsafe/,
  );
});

test("worker deployment must verify API health after its restart", () => {
  const workflows = repositoryWorkflows();
  workflows.worker = workflows.worker
    .replace(
      "Configure API claim-scoring wake-ups",
      "TEMPORARY_STEP_NAME",
    )
    .replace(
      "Verify API health after claim-scoring restart",
      "Configure API claim-scoring wake-ups",
    )
    .replace(
      "TEMPORARY_STEP_NAME",
      "Verify API health after claim-scoring restart",
    );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /step order is unsafe/,
  );
});

test("worker API health verification cannot omit readiness", () => {
  const workflows = repositoryWorkflows();
  workflows.apiHealthScript = workflows.apiHealthScript.replace(
    "https://${API_NAME}.azurewebsites.net/ready",
    "https://${API_NAME}.azurewebsites.net/health",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Post-restart API health script is missing/,
  );
});

test("worker API health verification must bound each HTTP request", () => {
  const workflows = repositoryWorkflows();
  workflows.apiHealthScript = workflows.apiHealthScript.replace(
    '--max-time "$REQUEST_TIMEOUT_SECONDS"',
    "--connect-timeout 10",
  );
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Post-restart API health script is missing/,
  );
});

test("worker API health verification cannot mutate App Service", () => {
  const workflows = repositoryWorkflows();
  workflows.apiHealthScript += "\n# az webapp restart\n";
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Post-restart API health script still contains/,
  );
});

test("worker deployment cannot start a scoring or recovery execution", () => {
  const workflows = repositoryWorkflows();
  workflows.worker += "\n# az containerapp job start\n";
  assert.throws(
    () => validateDeploymentBoundaries(workflows),
    /Report-worker deployment still contains/,
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
