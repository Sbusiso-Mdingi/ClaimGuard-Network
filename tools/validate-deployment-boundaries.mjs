#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CI_PATH = ".github/workflows/ci.yml";
const WORKER_PATH = ".github/workflows/report-worker-deploy.yml";
const EVENT_WORKER_PATH = "infra/event-report-worker.bicep";
const RECOVERY_BOOTSTRAP_PATH = "infra/recovery-job-bootstrap.bicep";
const RECOVERY_BOOTSTRAP_SCRIPT_PATH =
  "infra/bootstrap-report-recovery-job.sh";
const API_HEALTH_SCRIPT_PATH = "infra/verify-api-health.sh";
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
  recoveryBootstrapScript,
  apiHealthScript,
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
    "infra/bootstrap-report-recovery-job.sh",
    "infra/verify-api-health.sh",
    "Verify queue-scoped runtime RBAC before deployment",
    "EVENT_EXECUTION_COUNT_BEFORE",
    "RECOVERY_EXECUTION_COUNT_BEFORE",
    "QUEUE_PEEK_COUNT_BEFORE",
    "QUEUE_PEEK_COUNT_AFTER",
    "MODEL_SETTINGS_BEFORE",
    'API_HEALTH_DEADLINE_SECONDS: "300"',
    'API_HEALTH_REQUEST_TIMEOUT_SECONDS: "10"',
    'API_HEALTH_RETRY_SECONDS: "5"',
  ]) {
    requireText(worker, required, "Report-worker deployment authorization");
  }
  for (const forbidden of [
    "az containerapp job start",
    "az containerapp job execution start",
  ]) {
    forbidText(worker, forbidden, "Report-worker deployment");
    forbidText(
      recoveryBootstrapScript,
      forbidden,
      "Recovery-job bootstrap script",
    );
  }

  const workerStepOrder = [
    "Capture deployment safety baseline",
    "Bootstrap identity-free recovery job and attach identity",
    "Verify queue-scoped runtime RBAC before deployment",
    "Build and push immutable report-worker image",
    "Deploy event scorer and scheduled recovery job",
    "Configure API claim-scoring wake-ups",
    "Verify API health after claim-scoring restart",
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
    'API_NAME="${AZURE_WEBAPP_API:?AZURE_WEBAPP_API is required}"',
    "https://${API_NAME}.azurewebsites.net/health",
    "https://${API_NAME}.azurewebsites.net/ready",
    "DEADLINE_SECONDS >= 1 && DEADLINE_SECONDS <= 300",
    "REQUEST_TIMEOUT_SECONDS >= 1 && REQUEST_TIMEOUT_SECONDS <= 10",
    '--max-time "$REQUEST_TIMEOUT_SECONDS"',
    "--write-out '%{http_code}'",
    "Post-restart API health passed",
  ]) {
    requireText(apiHealthScript, required, "Post-restart API health script");
  }
  for (const forbidden of [
    "az webapp restart",
    "az webapp config",
    "az containerapp",
    "az deployment",
  ]) {
    forbidText(apiHealthScript, forbidden, "Post-restart API health script");
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
    "manual-identity-free-bootstrap",
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
    "identity:",
    "Microsoft.ManagedIdentity",
    "workerIdentityName",
    "userAssignedIdentities",
    "registries:",
    "secretRef:",
  ]) {
    forbidText(
      recoveryBootstrap,
      forbidden,
      "Recovery-job identity bootstrap",
    );
  }

  for (const required of [
    "create_identity_free_shell_if_absent",
    "attach_expected_identity_if_missing",
    "assert_exact_user_identity",
    "assert_manual_shell",
    "assert_scheduled_recovery",
    "az containerapp job identity assign",
    'RECOVERY_CRON="${REPORT_WORKER_RECOVERY_CRON:-0 0 1 1 *}"',
    'MODEL_DEPLOYMENT_ID="${MODEL_DEPLOYMENT_ID:-claimguard-claim-fraud-baseline:1.0.0}"',
    'assert_execution_count_unchanged',
  ]) {
    requireText(
      recoveryBootstrapScript,
      required,
      "Recovery-job bootstrap script",
    );
  }
  const recoveryBootstrapMainOrder = [
    "create_identity_free_shell_if_absent\n",
    'recovery_job="$(show_recovery_job)"',
    'attach_expected_identity_if_missing "$recovery_job" "$worker_identity_id"',
    'assert_exact_user_identity "$recovery_job" "$worker_identity_id"',
  ];
  const mainStart = recoveryBootstrapScript.indexOf("main() {");
  const mainEnd = recoveryBootstrapScript.indexOf('\n}\n\nmain "$@"', mainStart);
  if (mainStart === -1 || mainEnd === -1) {
    fail("Recovery-job bootstrap script main function is missing.");
  }
  const recoveryBootstrapMain = recoveryBootstrapScript.slice(
    mainStart,
    mainEnd,
  );
  let previousBootstrapIndex = -1;
  for (const operation of recoveryBootstrapMainOrder) {
    const operationIndex = recoveryBootstrapMain.indexOf(
      operation,
      previousBootstrapIndex + 1,
    );
    if (operationIndex <= previousBootstrapIndex) {
      fail(
        "Recovery-job bootstrap operation order is unsafe at "
        + JSON.stringify(operation),
      );
    }
    previousBootstrapIndex = operationIndex;
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
    recoveryBootstrapScript: read(RECOVERY_BOOTSTRAP_SCRIPT_PATH),
    apiHealthScript: read(API_HEALTH_SCRIPT_PATH),
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
