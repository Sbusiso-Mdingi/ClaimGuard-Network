#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CI_PATH = ".github/workflows/ci.yml";
const WORKER_PATH = ".github/workflows/report-worker-deploy.yml";
const EVENT_WORKER_PATH = "infra/event-report-worker.bicep";
const RECOVERY_BOOTSTRAP_PATH = "infra/recovery-job-bootstrap.bicep";
const LEGACY_API_PATH = ".github/workflows/main_claimguard-api.yml";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function fail(message) {
  throw new Error(message);
}

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    fail(`${label} is missing ${JSON.stringify(expected)}.`);
  }
}

function forbidText(source, forbidden, label) {
  if (source.includes(forbidden)) {
    fail(`${label} still contains ${JSON.stringify(forbidden)}.`);
  }
}

export function validateDeploymentBoundaries({
  ci,
  worker,
  eventWorker,
  recoveryBootstrap,
  legacyApi,
}) {
  for (const required of [
    "workflow_dispatch:",
    "expected_main_sha:",
    "production_confirmation:",
    'test "$GITHUB_REF" = "refs/heads/main"',
    '[[ "$EXPECTED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'test "$EXPECTED_MAIN_SHA" = "$GITHUB_SHA"',
    'test "$PRODUCTION_CONFIRMATION" = "DEPLOY_PRODUCTION"',
  ]) {
    requireText(ci, required, "CI production authorization");
  }

  const deploymentGuard =
    "github.event_name == 'workflow_dispatch' "
    + "&& github.ref == 'refs/heads/main' "
    + "&& inputs.production_confirmation == 'DEPLOY_PRODUCTION' "
    + "&& inputs.expected_main_sha == github.sha";
  const guardedStepCount = ci.split(deploymentGuard).length - 1;
  if (guardedStepCount !== 5) {
    fail(
      "CI must apply the exact production guard to four packaging steps "
      + `and the deploy job; found ${guardedStepCount}.`,
    );
  }

  forbidText(
    ci,
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    "CI workflow",
  );

  for (const required of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.event == 'workflow_dispatch'",
    "claimguard-report-recovery",
    "REPORT_WORKER_RECOVERY_CRON || '0 0 1 1 *'",
    'test "$REPORT_WORKER_RECOVERY_CRON" = "0 0 1 1 *"',
    'test "${#REPORT_WORKER_RECOVERY_JOB_NAME}" -le 32',
    "infra/recovery-job-bootstrap.bicep",
    "Verify queue-scoped runtime RBAC before deployment",
    "EVENT_EXECUTION_COUNT_BEFORE",
    "RECOVERY_EXECUTION_COUNT_BEFORE",
    "QUEUE_PEEK_COUNT_BEFORE",
    "QUEUE_PEEK_COUNT_AFTER",
    "MODEL_SETTINGS_BEFORE",
  ]) {
    requireText(worker, required, "Report-worker deployment authorization");
  }
  for (const forbidden of [
    "az containerapp job start",
    "az containerapp job execution start",
  ]) {
    forbidText(worker, forbidden, "Report-worker deployment");
  }

  const workerStepOrder = [
    "Capture deployment safety baseline",
    "Bootstrap first recovery-job identity association",
    "Verify queue-scoped runtime RBAC before deployment",
    "Build and push immutable report-worker image",
    "Deploy event scorer and scheduled recovery job",
    "Configure API claim-scoring wake-ups",
    "Verify event-driven production configuration",
  ];
  let previousStepIndex = -1;
  for (const stepName of workerStepOrder) {
    const stepIndex = worker.indexOf(stepName);
    if (stepIndex <= previousStepIndex) {
      fail(
        `Report-worker deployment step order is unsafe at ${JSON.stringify(stepName)}.`,
      );
    }
    previousStepIndex = stepIndex;
  }

  for (const required of [
    "param recoveryJobName string = 'claimguard-report-recovery'",
    "param recoveryScheduleCron string = '0 0 1 1 *'",
  ]) {
    requireText(eventWorker, required, "Event-worker parked recovery");
  }

  for (const required of [
    "param recoveryJobName string = 'claimguard-report-recovery'",
    "triggerType: 'Manual'",
    "manual-identity-bootstrap",
    "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
  ]) {
    requireText(
      recoveryBootstrap,
      required,
      "Recovery-job identity bootstrap",
    );
  }
  for (const forbidden of [
    "triggerType: 'Schedule'",
    "cronExpression",
    "worker drain-all",
  ]) {
    forbidText(
      recoveryBootstrap,
      forbidden,
      "Recovery-job identity bootstrap",
    );
  }

  for (const forbidden of [
    "azure/login",
    "azure/webapps-deploy",
    "az webapp deploy",
  ]) {
    forbidText(legacyApi, forbidden, "Retired direct API workflow");
  }
  requireText(
    legacyApi,
    "claimguard-api-deploy-retired",
    "Retired direct API workflow",
  );
}

export function validateRepositoryDeploymentBoundaries() {
  validateDeploymentBoundaries({
    ci: read(CI_PATH),
    worker: read(WORKER_PATH),
    eventWorker: read(EVENT_WORKER_PATH),
    recoveryBootstrap: read(RECOVERY_BOOTSTRAP_PATH),
    legacyApi: read(LEGACY_API_PATH),
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateRepositoryDeploymentBoundaries();
  process.stdout.write(
    "Production deployment boundaries are explicit and fail closed.\n",
  );
}
