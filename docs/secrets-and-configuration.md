# ClaimGuard Secrets and Configuration

This document records the current secret-governance model and the known secret/configuration surface without printing secret values.

## Governing Model

Preferred flow:

`Doppler governed source -> approved synchronization/deployment process -> Azure Key Vault runtime boundary -> managed identity / Key Vault reference -> workload`

Local development:

`Doppler dev config -> doppler run -> local process`

CI/CD:

- Prefer GitHub OIDC for Azure authentication.
- Prefer the narrowest practical Doppler identity if Doppler access is required.
- Avoid long-lived credentials where identity-based integrations are available.
- Do not echo imported secrets.
- Do not place production secrets in repository-visible workflow variables.

## Known Secret / Config Inventory

| Canonical name | Purpose | Owner | Environment | Sensitivity | Source of truth | Runtime consumer | Delivery method | Rotation | Last known state | Rollback | Duplicated | Removable later |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MYSQL_URL` | API operational DB connection | Platform / API ops | prod-like | secret | live App Service setting today; intended to be governed via Doppler/Key Vault | API, migrations, worker jobs | plaintext App Service setting today | periodic, not evidenced | live and duplicated with control-plane URL | restore prior DB URL setting | yes | yes, after migration |
| `CONTROL_PLANE_MYSQL_URL` | control-plane DB connection | Platform / control-plane ops | prod-like | secret | live App Service setting today | API control-plane/session code | plaintext App Service setting today | periodic, not evidenced | live | restore prior DB URL setting | yes | yes, after migration |
| tenant DB credential refs | private tenant route access | Platform | prod-like | secret | control plane / runtime secret boundary | routed data-plane code | route-managed secret reference | route-dependent | documented in code, not fully normalized live | restore previous route secret mapping | possible | maybe |
| session signing material | opaque session secret | API platform | session/local/prod | secret | control-plane/session storage; runtime boundary pending normalization | API session middleware | secret store / session service | periodic | implemented in code, live delivery not fully inventoried | revert session version | unknown | no |
| CSRF config | CSRF and origin checks | API platform | session/local/prod | sensitive config | App settings and session config | API session middleware | config/env | per policy | live config exists | revert origin/cookie config | yes | no |
| internal worker tokens | service-to-service auth | Platform ops | internal | secret | service config | API and workers | env / secret reference | periodic | used by session-mode worker paths in code | revert token secret | unknown | yes |
| report storage config | storage backend, container, pointer | Platform / reporting | prod-like | sensitive config | env + storage account | API, producer, workers | env / secret reference | change-driven | live config exists | revert storage pointer/config | yes | yes |
| `REPORT_STORAGE_CONNECTION_STRING` | report producer storage access | reporting ops | GitHub Actions / job runtime | secret | GitHub secret today | producer workflow | GitHub secret | periodic | workflow references it | revert to previous secret | yes | yes |
| `SENTRY_DSN_API` | API error telemetry | observability | prod-like | secret-ish | live App Service setting / future Doppler | API | env | rarely | live | revert DSN | yes | yes |
| `SENTRY_DSN_WEB` | web error telemetry | observability | prod-like | secret-ish | live App Service setting / future Doppler | web | env | rarely | live | revert DSN | yes | yes |
| `NEW_RELIC_LICENSE_KEY` | APM auth | observability | prod-like | secret | live App Service setting / future Doppler | API | env | periodically | live | revert key | yes | yes |
| `NEW_RELIC_APP_NAME` | APM name | observability | prod-like | config | live App Service setting / future Doppler | API | env | rarely | live | revert name | yes | yes |
| Application Insights connection | Azure telemetry | observability | prod-like | secret-ish | code/workflow config pending | API/web/worker | env/config | change-driven | referenced in docs/code, not fully inventoried live | revert connection string | unknown | yes |
| `CODECOV_TOKEN` | test coverage upload | CI | CI | secret | GitHub secret | CI workflow | GitHub secret | periodic | referenced in CI | revert token | yes | yes |
| `AZURE_CLIENT_ID` / tenant / subscription | OIDC deployment identity | CI | CI | identity metadata | workflow env | GitHub Actions | workflow env | change-driven | live values present in workflows | revert workflow env | yes | no |

## Current Live Settings by Name Only

### `claimguard-api`

- `MYSQL_URL`
- `SENTRY_DSN_API`
- `NEW_RELIC_LICENSE_KEY`
- `NEW_RELIC_APP_NAME`
- `NODE_ENV`
- `COSMOSDB_CONNECTION_STRING`
- `DETECTION_REPORT_PATH`
- `SCM_DO_BUILD_DURING_DEPLOYMENT`
- `WEBSITE_HTTPLOGGING_RETENTION_DAYS`
- `WEBSITES_PORT`
- `WEBSITE_RUN_FROM_PACKAGE`
- `REPORT_STORAGE_CONTAINER`
- `REPORT_STORAGE_REPORT_BLOB`
- `REPORT_STORAGE_BACKEND`
- `REPORT_STORAGE_ACCOUNT_URL`
- `CONTROL_PLANE_MYSQL_URL`
- `AUTH_ALLOWED_ORIGINS`
- `AUTHENTICATION_MODE`

### `claimguard-web`

- `SENTRY_DSN_WEB`
- `NODE_ENV`
- `CLAIMGUARD_API_BASE_URL`
- `SCM_DO_BUILD_DURING_DEPLOYMENT`
- `WEBSITE_RUN_FROM_PACKAGE`

### GitHub Actions references

- OIDC values are present in workflow env blocks.
- `CLAIMGUARD_MYSQL_URL` and `REPORT_STORAGE_CONNECTION_STRING` are referenced by the producer workflow.
- `CODECOV_TOKEN` is referenced by the main CI workflow.

## Doppler Inventory Status

External Doppler metadata could not be fully enumerated from this environment. The repository still documents a Doppler-first development posture, but the live project/config/token inventory should be captured in the next operational pass before any migration from plaintext App Service settings is attempted.

## Required Governance Actions

- Normalize each secret to a single named owner and delivery path.
- Prefer Key Vault references or managed identity at runtime for Azure workloads.
- Migrate non-critical telemetry settings before operational database secrets.
- Keep rollback values and validation paths documented before any live cutover.
