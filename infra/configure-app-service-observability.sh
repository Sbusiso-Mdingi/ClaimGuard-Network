#!/usr/bin/env bash
set -euo pipefail

# Idempotently connects ClaimGuard App Services to their production telemetry
# boundaries. Secret values are never read or printed by this script.

EXPECTED_SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-896d3c72-d979-4bdc-a37f-060988d12032}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-ClaimGuard}"
API_APP="${AZURE_WEBAPP_API:-claimguard-api}"
WEB_APP="${AZURE_WEBAPP_WEB:-claimguard-web}"
KEY_VAULT="${AZURE_KEYVAULT_NAME:-claimguard-kv-ufs}"
LOG_ANALYTICS_WORKSPACE="${AZURE_LOG_ANALYTICS_WORKSPACE:-claimguard-logs-11e}"
SENTRY_API_SECRET="${SENTRY_API_SECRET_NAME:-claimguard--observability--sentry-api-dsn}"
SENTRY_WEB_SECRET="${SENTRY_WEB_SECRET_NAME:-claimguard--observability--sentry-web-dsn}"
NEW_RELIC_SECRET="${NEW_RELIC_SECRET_NAME:-claimguard--observability--new-relic-license-key}"
RELEASE="${CLAIMGUARD_RELEASE:-}"
ALLOW_RBAC_CHANGES="${ALLOW_OBSERVABILITY_RBAC_CHANGES:-false}"
DIAGNOSTIC_SETTING_NAME="claimguard-app-service-observability"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

current_subscription="$(az account show --query id --output tsv)"
[[ "$current_subscription" == "$EXPECTED_SUBSCRIPTION_ID" ]] \
  || fail "Expected subscription $EXPECTED_SUBSCRIPTION_ID, found $current_subscription."

resource_group_location="$(az group show \
  --name "$RESOURCE_GROUP" \
  --query location \
  --output tsv)"
[[ "$resource_group_location" == "southafricanorth" ]] \
  || fail "Expected $RESOURCE_GROUP in southafricanorth, found $resource_group_location."

vault_uri="$(az keyvault show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$KEY_VAULT" \
  --query properties.vaultUri \
  --output tsv)"
[[ -n "$vault_uri" ]] || fail "Key Vault $KEY_VAULT was not found."
vault_resource_id="$(az keyvault show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$KEY_VAULT" \
  --query id \
  --output tsv)"

workspace_id="$(az monitor log-analytics workspace show \
  --resource-group "$RESOURCE_GROUP" \
  --workspace-name "$LOG_ANALYTICS_WORKSPACE" \
  --query id \
  --output tsv)"
[[ -n "$workspace_id" ]] \
  || fail "Log Analytics workspace $LOG_ANALYTICS_WORKSPACE was not found."

for secret_name in "$SENTRY_API_SECRET" "$SENTRY_WEB_SECRET" "$NEW_RELIC_SECRET"; do
  az keyvault secret show \
    --vault-name "$KEY_VAULT" \
    --name "$secret_name" \
    --query id \
    --output tsv >/dev/null \
    || fail "Required Key Vault secret $secret_name is absent."
done

ensure_identity() {
  local app_name="$1"
  local principal_id
  principal_id="$(az webapp identity show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --query principalId \
    --output tsv 2>/dev/null || true)"

  if [[ -z "$principal_id" ]]; then
    principal_id="$(az webapp identity assign \
      --resource-group "$RESOURCE_GROUP" \
      --name "$app_name" \
      --query principalId \
      --output tsv)"
  fi

  [[ -n "$principal_id" ]] || fail "Managed identity assignment failed for $app_name."
  printf '%s' "$principal_id"
}

grant_secret_read() {
  local principal_id="$1"
  local secret_name="$2"
  local secret_scope
  secret_scope="${vault_resource_id}/secrets/${secret_name}"

  local assignment_count
  assignment_count="$(az role assignment list \
    --assignee-object-id "$principal_id" \
    --scope "$secret_scope" \
    --include-inherited \
    --query "length([?roleDefinitionName=='Key Vault Secrets User' || roleDefinitionName=='Key Vault Secrets Officer'])" \
    --output tsv)"
  if [[ "$assignment_count" != "0" ]]; then
    return
  fi

  [[ "$ALLOW_RBAC_CHANGES" == "true" ]] \
    || fail "Missing Key Vault read for $principal_id on $secret_name. Run once with ALLOW_OBSERVABILITY_RBAC_CHANGES=true under an authorized operator."

  az role assignment create \
    --assignee-object-id "$principal_id" \
    --assignee-principal-type ServicePrincipal \
    --role "Key Vault Secrets User" \
    --scope "$secret_scope" \
    --output none
}

configure_diagnostics() {
  local app_name="$1"
  local app_id
  app_id="$(az webapp show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --query id \
    --output tsv)"

  az webapp log config \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --application-logging filesystem \
    --level information \
    --detailed-error-messages false \
    --failed-request-tracing false \
    --web-server-logging off \
    --output none

  az monitor diagnostic-settings create \
    --name "$DIAGNOSTIC_SETTING_NAME" \
    --resource "$app_id" \
    --workspace "$workspace_id" \
    --logs '[
      {"category":"AppServiceConsoleLogs","enabled":true},
      {"category":"AppServiceAppLogs","enabled":true},
      {"category":"AppServicePlatformLogs","enabled":true},
      {"category":"AppServiceAuthenticationLogs","enabled":true},
      {"category":"AppServiceAuditLogs","enabled":true},
      {"category":"AppServiceIPSecAuditLogs","enabled":true}
    ]' \
    --metrics '[{"category":"AllMetrics","enabled":true}]' \
    --output none
}

verify_reference() {
  local app_name="$1"
  local setting_name="$2"
  local expected_reference="$3"
  local app_id="$4"
  local actual_reference
  local reference_status

  actual_reference="$(az webapp config appsettings list \
    --resource-group "$RESOURCE_GROUP" \
    --name "$app_name" \
    --query "[?name=='$setting_name'].value | [0]" \
    --output tsv)"
  [[ "$actual_reference" == "$expected_reference" ]] \
    || fail "$app_name $setting_name is not the approved Key Vault reference."

  reference_status=""
  for _ in {1..12}; do
    reference_status="$(az rest \
      --method get \
      --url "https://management.azure.com${app_id}/config/configreferences/appsettings/${setting_name}?api-version=2025-03-01" \
      --query "properties.status" \
      --output tsv)"
    if [[ "$reference_status" == "Resolved" ]]; then
      break
    fi
    sleep 5
  done
  [[ "$reference_status" == "Resolved" ]] \
    || fail "$app_name $setting_name Key Vault reference status is $reference_status."
}

api_principal_id="$(ensure_identity "$API_APP")"
web_principal_id="$(ensure_identity "$WEB_APP")"

grant_secret_read "$api_principal_id" "$SENTRY_API_SECRET"
grant_secret_read "$api_principal_id" "$NEW_RELIC_SECRET"
grant_secret_read "$web_principal_id" "$SENTRY_WEB_SECRET"

sentry_api_reference="@Microsoft.KeyVault(SecretUri=${vault_uri}secrets/${SENTRY_API_SECRET})"
sentry_web_reference="@Microsoft.KeyVault(SecretUri=${vault_uri}secrets/${SENTRY_WEB_SECRET})"
new_relic_reference="@Microsoft.KeyVault(SecretUri=${vault_uri}secrets/${NEW_RELIC_SECRET})"

api_settings=(
  "WEBSITE_RUN_FROM_PACKAGE=1"
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false"
  "NODE_ENV=production"
  "CLAIMGUARD_ENVIRONMENT=production"
  "SENTRY_DSN_API=$sentry_api_reference"
  "NEW_RELIC_LICENSE_KEY=$new_relic_reference"
  "NEW_RELIC_APP_NAME=ClaimGuard API"
  "NEW_RELIC_LOG=stdout"
  "NEW_RELIC_LOG_LEVEL=info"
)
web_settings=(
  "WEBSITE_RUN_FROM_PACKAGE=1"
  "SCM_DO_BUILD_DURING_DEPLOYMENT=false"
  "NODE_ENV=production"
  "CLAIMGUARD_ENVIRONMENT=production"
  "SENTRY_DSN_WEB=$sentry_web_reference"
)

if [[ -n "$RELEASE" ]]; then
  api_settings+=("CLAIMGUARD_RELEASE=$RELEASE")
  web_settings+=("CLAIMGUARD_RELEASE=$RELEASE")
fi

az webapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --linux-fx-version "NODE|22-lts" \
  --startup-file "node --experimental-loader newrelic/esm-loader.mjs -r newrelic src/backend-server.js" \
  --output none
az webapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP" \
  --linux-fx-version "NODE|22-lts" \
  --startup-file "node src/server.js" \
  --output none

az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --settings "${api_settings[@]}" \
  --output none
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEB_APP" \
  --settings "${web_settings[@]}" \
  --output none

configure_diagnostics "$API_APP"
configure_diagnostics "$WEB_APP"

api_id="$(az webapp show --resource-group "$RESOURCE_GROUP" --name "$API_APP" --query id --output tsv)"
web_id="$(az webapp show --resource-group "$RESOURCE_GROUP" --name "$WEB_APP" --query id --output tsv)"

for app_id in "$api_id" "$web_id"; do
  az rest \
    --method post \
    --url "https://management.azure.com${app_id}/config/configreferences/appsettings/refresh?api-version=2022-03-01" \
    --output none
done

verify_reference "$API_APP" "SENTRY_DSN_API" "$sentry_api_reference" "$api_id"
verify_reference "$API_APP" "NEW_RELIC_LICENSE_KEY" "$new_relic_reference" "$api_id"
verify_reference "$WEB_APP" "SENTRY_DSN_WEB" "$sentry_web_reference" "$web_id"

api_startup="$(az webapp config show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$API_APP" \
  --query appCommandLine \
  --output tsv)"
[[ "$api_startup" == "node --experimental-loader newrelic/esm-loader.mjs -r newrelic src/backend-server.js" ]] \
  || fail "Unexpected API startup command: $api_startup"

for app_name in "$API_APP" "$WEB_APP"; do
  diagnostic_count="$(az monitor diagnostic-settings list \
    --resource "$(az webapp show --resource-group "$RESOURCE_GROUP" --name "$app_name" --query id --output tsv)" \
    --query "length([?name=='$DIAGNOSTIC_SETTING_NAME'])" \
    --output tsv)"
  [[ "$diagnostic_count" == "1" ]] \
    || fail "Expected one diagnostic setting on $app_name, found $diagnostic_count."
done

printf 'Observability configuration verified for %s and %s.\n' "$API_APP" "$WEB_APP"
