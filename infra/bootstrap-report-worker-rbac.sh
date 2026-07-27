#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-ClaimGuard}"
ACR_NAME="${REPORT_WORKER_ACR_NAME:-claimguardacr11e}"
KEY_VAULT_NAME="${AZURE_KEYVAULT_NAME:-claimguard-kv-ufs}"
WORKER_IDENTITY_NAME="${REPORT_WORKER_IDENTITY_NAME:-claimguard-report-worker-identity}"
API_APP_NAME="${AZURE_WEBAPP_API:-claimguard-api}"
STORAGE_ACCOUNT_NAME="${REPORT_STORAGE_ACCOUNT_NAME:-cgrpt0715sa}"
STORAGE_CONTAINER_NAME="${REPORT_STORAGE_CONTAINER:-claimguard-reports}"
CLAIM_SCORING_QUEUE_NAME="${CLAIM_SCORING_QUEUE_NAME:-claimguard-claim-scoring}"
CONTROL_PLANE_SECRET_NAME="${CONTROL_PLANE_MYSQL_URL_SECRET_NAME:-claimguard--api--control-plane-mysql-url}"
OPERATIONAL_SECRET_NAME="${MYSQL_URL_SECRET_NAME:-claimguard--api--mysql-url}"
MODEL_PSEUDONYM_SECRET_NAME="${MODEL_PSEUDONYM_SECRET_NAME:-claimguard--report-worker--model-pseudonymization-key}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

ensure_assignment() {
  local principal_id="$1"
  local role="$2"
  local scope="$3"
  local count

  count="$(az role assignment list \
    --assignee-object-id "$principal_id" \
    --scope "$scope" \
    --query "[?roleDefinitionName=='${role}'] | length(@)" \
    --output tsv)"

  if [ "$count" = "0" ]; then
    az role assignment create \
      --assignee-object-id "$principal_id" \
      --assignee-principal-type ServicePrincipal \
      --role "$role" \
      --scope "$scope" \
      --output none
    echo "Created: $role on $scope"
  else
    echo "Exists:  $role on $scope"
  fi
}

require_command az

SUBSCRIPTION_NAME="$(az account show --query name --output tsv)"
SUBSCRIPTION_ID="$(az account show --query id --output tsv)"
echo "Subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"
echo "Resource group: $RESOURCE_GROUP"

if ! az identity show --resource-group "$RESOURCE_GROUP" --name "$WORKER_IDENTITY_NAME" >/dev/null 2>&1; then
  az identity create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$WORKER_IDENTITY_NAME" \
    --output none
fi

WORKER_PRINCIPAL_ID="$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WORKER_IDENTITY_NAME" \
  --query principalId \
  --output tsv)"

API_PRINCIPAL_ID="$(az webapp identity assign \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP_NAME" \
  --query principalId \
  --output tsv)"

ACR_ID="$(az acr show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --query id \
  --output tsv)"

KEY_VAULT_ID="$(az keyvault show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$KEY_VAULT_NAME" \
  --query id \
  --output tsv)"

STORAGE_ACCOUNT_ID="$(az storage account show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$STORAGE_ACCOUNT_NAME" \
  --query id \
  --output tsv)"
CONTAINER_SCOPE="${STORAGE_ACCOUNT_ID}/blobServices/default/containers/${STORAGE_CONTAINER_NAME}"
QUEUE_SCOPE="${STORAGE_ACCOUNT_ID}/queueServices/default/queues/${CLAIM_SCORING_QUEUE_NAME}"

ensure_assignment "$WORKER_PRINCIPAL_ID" "AcrPull" "$ACR_ID"
ensure_assignment "$WORKER_PRINCIPAL_ID" "Key Vault Secrets User" "${KEY_VAULT_ID}/secrets/${CONTROL_PLANE_SECRET_NAME}"
ensure_assignment "$WORKER_PRINCIPAL_ID" "Key Vault Secrets User" "${KEY_VAULT_ID}/secrets/${OPERATIONAL_SECRET_NAME}"
ensure_assignment "$WORKER_PRINCIPAL_ID" "Key Vault Secrets User" "${KEY_VAULT_ID}/secrets/${MODEL_PSEUDONYM_SECRET_NAME}"
ensure_assignment "$WORKER_PRINCIPAL_ID" "Storage Blob Data Contributor" "$CONTAINER_SCOPE"
ensure_assignment "$WORKER_PRINCIPAL_ID" "Storage Queue Data Contributor" "$QUEUE_SCOPE"
ensure_assignment "$API_PRINCIPAL_ID" "Storage Blob Data Reader" "$CONTAINER_SCOPE"
ensure_assignment "$API_PRINCIPAL_ID" "Storage Queue Data Message Sender" "$QUEUE_SCOPE"

echo
echo "Report-worker RBAC bootstrap complete."
echo "Worker principal: $WORKER_PRINCIPAL_ID"
echo "API principal:    $API_PRINCIPAL_ID"
