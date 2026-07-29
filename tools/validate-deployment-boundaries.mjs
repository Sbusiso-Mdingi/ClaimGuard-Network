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
const MODEL_READINESS_SCRIPT_PATH = "infra/verify-model-readiness.sh";
const OBSERVABILITY_SCRIPT_PATH =
  "infra/configure-app-service-observability.sh";
const LEGACY_API_PATH = ".github/workflows/main_claimguard-api.yml";
const ENSEMBLE_STAGE_PATH =
  ".github/workflows/ensemble211-release-stage.yml";
const ENSEMBLE_FINALIZE_PATH =
  ".github/workflows/ensemble211-release-finalize.yml";
const ENSEMBLE_PRODUCTION_PATH = "infra/ensemble211-production.bicep";

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
  modelReadinessScript,
  observabilityScript,
  legacyApi,
  ensembleStage,
  ensembleFinalize,
  ensembleProduction,
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
    "environment: production",
    "node-version: 22",
    "bash infra/configure-app-service-observability.sh",
    "CLAIMGUARD_RELEASE: ${{ github.sha }}",
  ]) {
    requireText(ci, required, "CI observability deployment");
  }
  for (const forbidden of [
    "${{ secrets.SENTRY_DSN_API }}",
    "${{ secrets.SENTRY_DSN_WEB }}",
    "${{ secrets.NEW_RELIC_LICENSE_KEY }}",
  ]) {
    forbidText(ci, forbidden, "CI observability deployment");
  }
  const apiDeploymentIndex = ci.indexOf("Deploy API app with retry");
  const observabilityConfigurationIndex = ci.indexOf(
    "Configure production observability boundaries",
  );
  const healthVerificationIndex = ci.indexOf(
    "Verify deployment health endpoints",
  );
  if (
    apiDeploymentIndex < 0
    || observabilityConfigurationIndex <= apiDeploymentIndex
    || healthVerificationIndex <= observabilityConfigurationIndex
  ) {
    fail(
      "CI observability configuration must run after API deployment and before health verification.",
    );
  }

  for (const required of [
    "896d3c72-d979-4bdc-a37f-060988d12032",
    "southafricanorth",
    "claimguard--observability--sentry-api-dsn",
    "claimguard--observability--sentry-web-dsn",
    "claimguard--observability--new-relic-license-key",
    "az webapp identity assign",
    "ALLOW_OBSERVABILITY_RBAC_CHANGES",
    '--role "Key Vault Secrets User"',
    "@Microsoft.KeyVault(SecretUri=",
    '--startup-file "node --experimental-loader newrelic/esm-loader.mjs -r newrelic src/backend-server.js"',
    "az monitor diagnostic-settings create",
    "AppServiceConsoleLogs",
    "AppServicePlatformLogs",
    "AllMetrics",
    "/config/configreferences/appsettings/refresh",
    "verify_reference",
  ]) {
    requireText(
      observabilityScript,
      required,
      "App Service observability configuration",
    );
  }
  for (const forbidden of [
    "az keyvault secret set",
    "az webapp config appsettings delete",
    "az webapp delete",
    "az monitor diagnostic-settings delete",
    "az containerapp job start",
    "--query value",
  ]) {
    forbidText(
      observabilityScript,
      forbidden,
      "App Service observability configuration",
    );
  }

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
    "claimguard-claim-fraud-baseline:1.0.0,claimguard-claim-fraud-ensemble:2.1.1",
    "CLAIMGUARD_CLAIM_FRAUD_ENSEMBLE_2_1_1_E0652D762C0E",
    "CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256",
    "CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST",
    "CLAIMGUARD_RELEASE_IMAGE_DIGEST",
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
    'READINESS_URL="${MODEL_READINESS_URL:?MODEL_READINESS_URL is required}"',
    "EXPECTED_MODEL_DEPLOYMENT_ID is required",
    "southafricanorth\\.azurecontainerapps\\.io/health/ready",
    "DEADLINE_SECONDS >= 1 && DEADLINE_SECONDS <= 300",
    "REQUEST_TIMEOUT_SECONDS >= 1 && REQUEST_TIMEOUT_SECONDS <= 10",
    '--max-time "$REQUEST_TIMEOUT_SECONDS"',
    "--write-out '%{http_code}'",
    '.status == "ready" and .deploymentId == $deployment_id',
    "Model readiness passed",
  ]) {
    requireText(
      modelReadinessScript,
      required,
      "Model readiness verification script",
    );
  }
  for (const forbidden of [
    "az webapp",
    "az containerapp",
    "az deployment",
    "gh workflow",
  ]) {
    forbidText(
      modelReadinessScript,
      forbidden,
      "Model readiness verification script",
    );
  }

  for (const required of [
    "param recoveryJobName string = 'claimguard-report-recovery'",
    "param recoveryScheduleCron string = '0 0 1 1 *'",
    "param ensembleDeploymentId string = 'claimguard-claim-fraud-ensemble:2.1.1'",
    "param ensembleRuntimeConfigKey string = 'CLAIMGUARD_CLAIM_FRAUD_ENSEMBLE_2_1_1_E0652D762C0E'",
    "param ensembleThreshold string = '0.049236234887246655'",
    "MODEL_SERVICE_BASE_URL_${ensembleRuntimeConfigKey}",
    "MODEL_SERVICE_PSEUDONYMIZATION_KEY_${ensembleRuntimeConfigKey}",
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

  for (const required of [
    "workflow_dispatch:",
    "inputs.confirmation == 'STAGE_ENSEMBLE_2_1_1'",
    "inputs.commit_sha == github.sha",
    '[[ "$INPUT_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]',
    "git ls-remote origin refs/heads/main",
    "896d3c72-d979-4bdc-a37f-060988d12032",
    "8efc1bb9-b90f-4a48-bf6c-ba0686193b80",
    "southafricanorth",
    "claimguard-claim-fraud-ensemble:2.1.1",
    "sha256:0a4b771e8453b6f891e35b5a2921c2c840325ffd29bf773aa7989f5ef4241b2c",
    "--show-values",
    "infra/verify-model-readiness.sh",
    'MODEL_READINESS_DEADLINE_SECONDS: "300"',
    'MODEL_READINESS_REQUEST_TIMEOUT_SECONDS: "10"',
    'MODEL_READINESS_RETRY_SECONDS: "5"',
    "0 0 1 1 *",
    "Runtime traffic remains on the baseline",
  ]) {
    requireText(ensembleStage, required, "Ensemble release staging");
  }
  for (const required of [
    "workflow_dispatch:",
    "inputs.confirmation == 'ACTIVATE_ENSEMBLE_2_1_1_RUNTIME'",
    "inputs.commit_sha == github.sha",
    "ACTIVATION_AUDIT_EVENT_ID",
    "git ls-remote origin refs/heads/main",
    '[[ "$ACTIVATION_AUDIT_EVENT_ID" =~ ^[0-9a-fA-F-]{36}$ ]]',
    'test "$CONFIGURED_APPROVED_MODEL_DEPLOYMENT_IDS" = "$FINAL_APPROVED_MODEL_DEPLOYMENT_IDS"',
    'test "$CONFIGURED_MANAGED_MODEL_DEPLOYMENT_ID" = "$ENSEMBLE_DEPLOYMENT_ID"',
    "Verify exact audited catalogue activation",
    "tools/verify-production-model-activation.mjs",
    '--audit-event-id "$ACTIVATION_AUDIT_EVENT_ID"',
    "infra/verify-model-readiness.sh",
    'MODEL_READINESS_DEADLINE_SECONDS: "300"',
    'MODEL_READINESS_REQUEST_TIMEOUT_SECONDS: "10"',
    'MODEL_READINESS_RETRY_SECONDS: "5"',
    "APPROVED_MODEL_DEPLOYMENT_IDS=\"$FINAL_APPROVED_MODEL_DEPLOYMENT_IDS\"",
    "CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID=\"$ENSEMBLE_DEPLOYMENT_ID\"",
    "0 0 1 1 *",
    "No worker job was started by this workflow.",
  ]) {
    requireText(ensembleFinalize, required, "Ensemble release finalization");
  }
  const catalogueAuditIndex = ensembleFinalize.indexOf(
    "Verify exact audited catalogue activation",
  );
  const runtimeSelectionIndex = ensembleFinalize.indexOf(
    "Select the audited model for future claims",
  );
  if (
    catalogueAuditIndex < 0
    || runtimeSelectionIndex < 0
    || catalogueAuditIndex >= runtimeSelectionIndex
  ) {
    fail(
      "Ensemble release finalization audit verification order is unsafe.",
    );
  }
  for (const forbidden of [
    "az containerapp job start",
    "az containerapp job execution start",
    "az containerapp job update",
    "az containerapp job create",
    "az containerapp job delete",
  ]) {
    forbidText(ensembleStage, forbidden, "Ensemble release staging");
    forbidText(ensembleFinalize, forbidden, "Ensemble release finalization");
  }
  for (const forbidden of [
    "az deployment group create",
    "az containerapp update",
    "az containerapp create",
    "az containerapp delete",
  ]) {
    forbidText(
      ensembleFinalize,
      forbidden,
      "Ensemble release finalization",
    );
  }

  for (const required of [
    "param modelContainerAppName string = 'claimguard-ml-ensemble-211'",
    "var deploymentId = 'claimguard-claim-fraud-ensemble:2.1.1'",
    "param modelIdentityName string = 'claimguard-prospective-model-identity'",
    "CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID",
    "minReplicas: 0",
    "maxReplicas: 2",
    "unauthenticatedClientAction: 'Return401'",
    "'/health/live'",
    "'/health/ready'",
  ]) {
    requireText(
      ensembleProduction,
      required,
      "Ensemble production model infrastructure",
    );
  }
}

export function validateRepositoryDeploymentBoundaries() {
  validateDeploymentBoundaries({
    ci: read(CI_PATH),
    worker: read(WORKER_PATH),
    eventWorker: read(EVENT_WORKER_PATH),
    recoveryBootstrap: read(RECOVERY_BOOTSTRAP_PATH),
    recoveryBootstrapScript: read(RECOVERY_BOOTSTRAP_SCRIPT_PATH),
    apiHealthScript: read(API_HEALTH_SCRIPT_PATH),
    modelReadinessScript: read(MODEL_READINESS_SCRIPT_PATH),
    observabilityScript: read(OBSERVABILITY_SCRIPT_PATH),
    legacyApi: read(LEGACY_API_PATH),
    ensembleStage: read(ENSEMBLE_STAGE_PATH),
    ensembleFinalize: read(ENSEMBLE_FINALIZE_PATH),
    ensembleProduction: read(ENSEMBLE_PRODUCTION_PATH),
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
