#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-ClaimGuard}"
CONTAINER_APPS_ENVIRONMENT="${REPORT_WORKER_ENVIRONMENT_NAME:-claimguard-env-11e}"
WORKER_IDENTITY_NAME="${REPORT_WORKER_IDENTITY_NAME:-claimguard-report-worker-identity}"
RECOVERY_JOB_NAME="${REPORT_WORKER_RECOVERY_JOB_NAME:-claimguard-report-recovery}"
RECOVERY_CRON="${REPORT_WORKER_RECOVERY_CRON:-0 0 1 1 *}"
ACR_NAME="${REPORT_WORKER_ACR_NAME:-claimguardacr11e}"
MODEL_DEPLOYMENT_ID="${MODEL_DEPLOYMENT_ID:-claimguard-claim-fraud-baseline:1.0.0}"
OPERATIONAL_SCHEMA_VERSION=""
BOOTSTRAP_IMAGE="mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
BOOTSTRAP_CONTAINER="recovery-bootstrap"
EXPECTED_EXECUTION_COUNT="${RECOVERY_EXECUTION_COUNT_BEFORE:?RECOVERY_EXECUTION_COUNT_BEFORE is required}"
VALIDATED_SHA="${VALIDATED_MAIN_SHA:?VALIDATED_MAIN_SHA is required}"

fail() {
  echo "Recovery bootstrap safety check failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

show_recovery_job() {
  az containerapp job show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$RECOVERY_JOB_NAME" \
    --output json \
    --only-show-errors
}

recovery_execution_count() {
  az containerapp job execution list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$RECOVERY_JOB_NAME" \
    --query 'length(@)' \
    --output tsv \
    --only-show-errors
}

assert_execution_count_unchanged() {
  local actual
  actual="$(recovery_execution_count)"
  [ "$actual" = "$EXPECTED_EXECUTION_COUNT" ] \
    || fail "execution count changed from $EXPECTED_EXECUTION_COUNT to $actual"
}

assert_exact_user_identity() {
  local job_json="$1" expected_identity_id="$2"
  local identity_type actual_ids expected_ids normalized_identity_id

  identity_type="$(jq -r '.identity.type // "None"' <<<"$job_json")"
  [ "$identity_type" = "UserAssigned" ] \
    || fail "identity type is $identity_type, expected UserAssigned"

  normalized_identity_id="$(tr '[:upper:]' '[:lower:]' <<<"$expected_identity_id")"
  actual_ids="$(
    jq -c \
      '(.identity.userAssignedIdentities // {}) | keys | map(ascii_downcase) | sort' \
      <<<"$job_json"
  )"
  expected_ids="$(jq -cn --arg id "$normalized_identity_id" '[$id] | sort')"
  [ "$actual_ids" = "$expected_ids" ] \
    || fail "job has an unexpected user-assigned identity set"
}

assert_manual_shell() {
  local job_json="$1"
  [ "$(jq -r '.properties.configuration.triggerType' <<<"$job_json")" = "Manual" ] \
    || fail "bootstrap job is not Manual"
  [ "$(jq -r '.properties.configuration.scheduleTriggerConfig // null' <<<"$job_json")" = "null" ] \
    || fail "manual bootstrap unexpectedly has a schedule"
  [ "$(jq -r '(.properties.configuration.registries // []) | length' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap unexpectedly has a private registry"
  [ "$(jq -r '(.properties.configuration.secrets // []) | length' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap unexpectedly has secrets"
  [ "$(jq -r '.properties.configuration.manualTriggerConfig.parallelism' <<<"$job_json")" = "1" ] \
    || fail "manual bootstrap parallelism is unexpected"
  [ "$(jq -r '.properties.configuration.manualTriggerConfig.replicaCompletionCount' <<<"$job_json")" = "1" ] \
    || fail "manual bootstrap completion count is unexpected"
  [ "$(jq -r '.properties.configuration.replicaTimeout' <<<"$job_json")" = "300" ] \
    || fail "manual bootstrap timeout is unexpected"
  [ "$(jq -r '.properties.configuration.replicaRetryLimit' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap retry limit is unexpected"
  [ "$(jq -r '.properties.template.containers | length' <<<"$job_json")" = "1" ] \
    || fail "manual bootstrap does not have exactly one container"
  [ "$(jq -r '(.properties.template.volumes // []) | length' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap unexpectedly has volumes"
  [ "$(jq -r '.properties.template.containers[0].name' <<<"$job_json")" = "$BOOTSTRAP_CONTAINER" ] \
    || fail "manual bootstrap container name is unexpected"
  [ "$(jq -r '.properties.template.containers[0].image' <<<"$job_json")" = "$BOOTSTRAP_IMAGE" ] \
    || fail "manual bootstrap image is unexpected"
  [ "$(jq -r '.properties.template.containers[0].command // null' <<<"$job_json")" = "null" ] \
    || fail "manual bootstrap unexpectedly has a command"
  [ "$(jq -r '.properties.template.containers[0].args // null' <<<"$job_json")" = "null" ] \
    || fail "manual bootstrap unexpectedly has arguments"
  [ "$(jq -r '(.properties.template.containers[0].env // []) | length' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap unexpectedly has environment settings"
  [ "$(jq -r '(.properties.template.containers[0].volumeMounts // []) | length' <<<"$job_json")" = "0" ] \
    || fail "manual bootstrap unexpectedly has volume mounts"
  [ "$(jq -r '.properties.template.containers[0].resources.cpu | tonumber' <<<"$job_json")" = "0.25" ] \
    || fail "manual bootstrap CPU is unexpected"
  [ "$(jq -r '.properties.template.containers[0].resources.memory' <<<"$job_json")" = "0.5Gi" ] \
    || fail "manual bootstrap memory is unexpected"
}

assert_scheduled_recovery() {
  local job_json="$1" expected_identity_id="$2"
  local image
  [ "$(jq -r '.properties.configuration.triggerType' <<<"$job_json")" = "Schedule" ] \
    || fail "existing recovery job has an unexpected trigger"
  [ "$(jq -r '.properties.configuration.scheduleTriggerConfig.cronExpression' <<<"$job_json")" = "$RECOVERY_CRON" ] \
    || fail "existing recovery schedule is not parked"
  [ "$(jq -r '.properties.template.containers | length' <<<"$job_json")" = "1" ] \
    || fail "scheduled recovery does not have exactly one container"
  [ "$(jq -r '.properties.template.containers[0].name' <<<"$job_json")" = "report-producer-recovery" ] \
    || fail "scheduled recovery container name is unexpected"
  [ "$(jq -r '.properties.template.containers[0].args | join(" ")' <<<"$job_json")" = "worker drain-all" ] \
    || fail "scheduled recovery arguments are unexpected"
  [ "$(
    jq -r \
      '.properties.template.containers[0].env[] | select(.name == "MODEL_SERVICE_DEPLOYMENT_ID") | .value' \
      <<<"$job_json"
  )" = "$MODEL_DEPLOYMENT_ID" ] \
    || fail "scheduled recovery model deployment is unexpected"
  image="$(jq -r '.properties.template.containers[0].image' <<<"$job_json")"
  case "$image" in
    "${ACR_NAME}.azurecr.io/claimguard/report-producer:"*) ;;
    *) fail "scheduled recovery image is outside the expected immutable repository" ;;
  esac
  assert_exact_user_identity "$job_json" "$expected_identity_id"
}

create_identity_free_shell_if_absent() {
  local matching_jobs
  matching_jobs="$(
    az containerapp job list \
      --resource-group "$RESOURCE_GROUP" \
      --query "[?name == '$RECOVERY_JOB_NAME'] | length(@)" \
      --output tsv \
      --only-show-errors
  )"
  case "$matching_jobs" in
    0) ;;
    1) return ;;
    *) fail "recovery-job inventory returned unexpected count: $matching_jobs" ;;
  esac

  az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --name "recovery-job-bootstrap-${VALIDATED_SHA:0:12}" \
    --template-file infra/recovery-job-bootstrap.bicep \
    --parameters \
      containerAppsEnvironmentName="$CONTAINER_APPS_ENVIRONMENT" \
      operationalSchemaVersion="$OPERATIONAL_SCHEMA_VERSION" \
      recoveryJobName="$RECOVERY_JOB_NAME" \
    --only-show-errors \
    --output none
}

attach_expected_identity_if_missing() {
  local job_json="$1" expected_identity_id="$2"
  local identity_type identity_count
  identity_type="$(jq -r '.identity.type // "None"' <<<"$job_json")"
  identity_count="$(jq -r '(.identity.userAssignedIdentities // {}) | length' <<<"$job_json")"

  if [ "$identity_type" = "None" ] && [ "$identity_count" = "0" ]; then
    az containerapp job identity assign \
      --resource-group "$RESOURCE_GROUP" \
      --name "$RECOVERY_JOB_NAME" \
      --user-assigned "$expected_identity_id" \
      --only-show-errors \
      --output none
    return
  fi

  assert_exact_user_identity "$job_json" "$expected_identity_id"
}

main() {
  local worker_identity_id recovery_job recovery_trigger
  require_command az
  require_command jq
  require_command node

  OPERATIONAL_SCHEMA_VERSION="$(
    node --input-type=module --eval \
      "import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from './packages/database/src/operational-schema.js'; process.stdout.write(CANONICAL_OPERATIONAL_SCHEMA_VERSION)"
  )"

  [ "$RECOVERY_CRON" = "0 0 1 1 *" ] \
    || fail "recovery cron is not the exact parked value"
  [ "$MODEL_DEPLOYMENT_ID" = "claimguard-claim-fraud-baseline:1.0.0" ] \
    || fail "model deployment is not the approved baseline"
  [ "$RESOURCE_GROUP" = "ClaimGuard" ] \
    || fail "resource group is unexpected"
  [ "$CONTAINER_APPS_ENVIRONMENT" = "claimguard-env-11e" ] \
    || fail "Container Apps environment is unexpected"
  [ "$WORKER_IDENTITY_NAME" = "claimguard-report-worker-identity" ] \
    || fail "worker identity name is unexpected"
  [ "$RECOVERY_JOB_NAME" = "claimguard-report-recovery" ] \
    || fail "recovery job name is unexpected"
  [ "$ACR_NAME" = "claimguardacr11e" ] \
    || fail "container registry name is unexpected"

  worker_identity_id="$(
    az identity show \
      --resource-group "$RESOURCE_GROUP" \
      --name "$WORKER_IDENTITY_NAME" \
      --query id \
      --output tsv \
      --only-show-errors
  )"
  [ -n "$worker_identity_id" ] || fail "worker identity resource ID is empty"

  create_identity_free_shell_if_absent
  recovery_job="$(show_recovery_job)"
  recovery_trigger="$(jq -r '.properties.configuration.triggerType' <<<"$recovery_job")"

  case "$recovery_trigger" in
    Manual)
      assert_manual_shell "$recovery_job"
      assert_execution_count_unchanged
      attach_expected_identity_if_missing "$recovery_job" "$worker_identity_id"
      recovery_job="$(show_recovery_job)"
      assert_manual_shell "$recovery_job"
      assert_exact_user_identity "$recovery_job" "$worker_identity_id"
      ;;
    Schedule)
      assert_scheduled_recovery "$recovery_job" "$worker_identity_id"
      ;;
    *)
      fail "existing recovery trigger is $recovery_trigger"
      ;;
  esac

  assert_execution_count_unchanged
  echo "Recovery job bootstrap is safe, identity-bound, and execution-neutral."
}

main "$@"
