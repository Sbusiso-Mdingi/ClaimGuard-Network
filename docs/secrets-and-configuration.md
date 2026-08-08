# ClaimGuard Secrets and Configuration

This document records the current secret-governance model and the known secret/configuration surface without printing secret values.

## Governing Model

Preferred production flow:

`provider rotation -> Azure Key Vault version -> managed identity / Key Vault reference -> workload`

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
| `MYSQL_URL` | API operational DB connection | Platform / API ops | prod-like | secret | Key Vault secret `claimguard--api--mysql-url` | API, migrations, report worker | App Service Key Vault reference or job secret | periodic, not evidenced | migrated to Key Vault reference in Phase 12A | restore prior App Service setting value if rollback required | yes | no |
| `CONTROL_PLANE_MYSQL_URL` | control-plane DB connection | Platform / control-plane ops | prod-like | secret | Key Vault secret `claimguard--api--control-plane-mysql-url` | API control-plane/session code and report-worker route verification | App Service Key Vault reference or job secret | periodic, not evidenced | migrated to Key Vault reference in Phase 12A | restore prior App Service setting value if rollback required | yes | no |
| tenant DB credential refs | private tenant route access | Platform | prod-like | secret | Azure Key Vault references stored in the control-plane route | API and report worker for the assigned organisation | route-managed secret reference resolved by managed identity | route-dependent | four secret references per private route | restore previous route secret mapping | no | no |
| session signing material | opaque session secret | API platform | session/local/prod | secret | control-plane/session storage; runtime boundary pending normalization | API session middleware | secret store / session service | periodic | implemented in code, live delivery not fully inventoried | revert session version | unknown | no |
| CSRF config | CSRF and origin checks | API platform | session/local/prod | sensitive config | App settings and session config | API session middleware | config/env | per policy | live config exists | revert origin/cookie config | yes | no |
| internal worker tokens | service-to-service auth | Platform ops | internal | secret | service config | API and workers | env / secret reference | periodic | used by session-mode worker paths in code | revert token secret | unknown | yes |
| report storage config | storage backend, container, pointer | Platform / reporting | prod-like | sensitive config | env + storage account | API, producer, workers | env / secret reference | change-driven | live config exists | revert storage pointer/config | yes | yes |
| `REPORT_STORAGE_CONNECTION_STRING` | optional local report-storage access | reporting ops | local development only | secret | local approved secret provider | local producer | environment | periodic | Azure deployment uses managed identity instead | no | yes |
| `APPROVED_MODEL_DEPLOYMENT_IDS` | allowlist of model deployments permitted for scoring | Platform ML operations | prod-like | config | approved deployment registry | API and report worker | environment | deployment-driven | required by model-selection validation | restore previous allowlist | yes | no |
| `CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID` | currently promoted ClaimGuard-managed fraud model | Platform ML operations | prod-like | config | ClaimGuard model promotion process | API model-selection boundary | environment | model-promotion driven | schemes cannot override this value | restore previous promoted deployment | no | no |
| `SCHEME_MODEL_DEPLOYMENTS_JSON` | maps operational tenant IDs to proprietary deployments registered for that scheme | Platform and scheme ML governance | prod-like | sensitive config | approved model ownership registry | API model-selection boundary | environment or generated config reference | registration-driven | fail-closed ownership enforcement | restore previous ownership map | no | replace with model registry |
| `SENTRY_DSN_API` | API error telemetry | observability | production | secret-ish | Key Vault `claimguard--observability--sentry-api-dsn` | API | managed-identity Key Vault reference | after exposure or provider change | governed alias | restore previous enabled Key Vault version | no | no |
| `SENTRY_DSN_WEB` | browser error telemetry | observability | production | public client identifier / secret-ish | Key Vault `claimguard--observability--sentry-web-dsn` | web | managed-identity Key Vault reference, then runtime HTML injection | after exposure or provider change | governed alias | restore previous enabled Key Vault version | no | no |
| `NEW_RELIC_LICENSE_KEY` | API APM ingest authentication | observability | production | secret | Key Vault `claimguard--observability--new-relic-license-key` | API | managed-identity Key Vault reference | periodic and after exposure | governed alias | restore previous enabled Key Vault version | no | no |
| `NEW_RELIC_APP_NAME` | APM entity name | observability | production | config | deployment configuration | API | App Service setting | change-driven | `ClaimGuard API` | restore prior name | no | no |
| `AZURE_CLIENT_ID` / tenant / subscription | OIDC deployment identity | CI | CI | identity metadata | workflow env | GitHub Actions | workflow env | change-driven | live values present in workflows | revert workflow env | yes | no |
| `DESKTOP_ACTIVATION_KEY_PEPPER` | HMAC activation keys before storage | API security | production | secret | Key Vault | API desktop enrollment service | managed-identity secret reference | periodic / exposure | implementation ready; delivery deferred | restore prior enabled version during overlap | no | no |
| `DESKTOP_ENROLLMENT_SIGNING_PRIVATE_KEY` | sign organisation/device enrollment | API security | production | private signing key | HSM/Key Vault governed source | API desktop enrollment service | protected runtime secret | planned key transition | implementation ready; provisioning deferred | retain old verifier through transition | no | no |
| `DESKTOP_SYNC_CURSOR_SECRET` | sign bounded opaque cursors | API security | production | secret | Key Vault | API desktop sync service | managed-identity secret reference | periodic / exposure | implementation ready; delivery deferred | old cursors may require bootstrap | no | no |
| `TAURI_SIGNING_PRIVATE_KEY` | sign automatic-update payloads | Desktop release engineering | protected CI | private signing key | protected `desktop-signing` environment / HSM target | signed desktop build | job-scoped environment | planned transition | workflow ready; secret not provisioned here | old-key transition or reinstall | no | no |
| `WINDOWS_SIGNING_CERTIFICATE_BASE64` / password | Authenticode application/installer signing | Desktop release engineering | protected CI | certificate private key | protected `desktop-signing` environment; HSM target preferred | Tauri Windows bundler | ephemeral runner certificate store | before expiry / exposure | workflow ready; certificate not provisioned here | revoke and replace certificate | no | replace with Trusted Signing |

Desktop public configuration (`DESKTOP_API_ORIGIN`, `DESKTOP_ENROLLMENT_SIGNING_KEY_ID`, `CLAIMGUARD_ACTIVATION_ORIGIN`, `CLAIMGUARD_ENROLLMENT_VERIFYING_JWK`, and `TAURI_UPDATER_PUBLIC_KEY`) is not secret, but changes are security-sensitive and require review. Private signing material must never be placed in repository variables, build logs, artifacts, or desktop binaries. See [desktop-architecture.md](desktop-architecture.md) and [desktop-signing-and-updater-runbook.md](desktop-signing-and-updater-runbook.md).

## Detection Model Selection

Scheme administrators may choose only one of two ML-backed options:

- **ClaimGuard managed:** the API resolves `CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID`. The scheme cannot submit or pin a different ClaimGuard deployment.
- **Scheme managed:** the submitted deployment must be listed for the authenticated operational tenant in `SCHEME_MODEL_DEPLOYMENTS_JSON` and must also appear in `APPROVED_MODEL_DEPLOYMENT_IDS`.

When ClaimGuard promotes a newer managed deployment, an active approved
deployment that is not owned by any scheme remains classified as
ClaimGuard-managed. The API reports the promoted deployment as an available
update, and an authorised scheme administrator can create the audited strategy
transition. The transition is prospective: existing claim versions, detection
results, and historical outbox jobs remain pinned to their original strategy
and deployment.

The model-promotion process must retain an earlier managed deployment in
`APPROVED_MODEL_DEPLOYMENT_IDS` until every scheme still using it has completed
or explicitly deferred the rollout. Removing it sooner correctly blocks new
claim ingestion for that stale strategy instead of silently choosing another
model.

Example ownership-map shape, using non-secret identifiers only:

```json
{
  "operational-tenant-id": [
    "scheme-proprietary-model:production"
  ]
}
```

Model endpoints, credentials and authentication material must not be stored in this JSON value. They remain in the model-service registry and approved secret-delivery boundary.

## Current Live Settings by Name Only

### `claimguard-api`

- `MYSQL_URL`
- `SENTRY_DSN_API` (Key Vault reference)
- `NEW_RELIC_LICENSE_KEY` (Key Vault reference)
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
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY` (Key Vault reference)
- `CLERK_WEB_ORIGIN`
- `CLERK_ENTERPRISE_SSO_ENABLED`

### `claimguard-web`

- `SENTRY_DSN_WEB` (Key Vault reference)
- `NODE_ENV`
- `CLAIMGUARD_API_BASE_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_PROXY_URL`
- `CLERK_SECRET_KEY` (Key Vault reference; server-side Frontend API proxy only)
- `SCM_DO_BUILD_DURING_DEPLOYMENT`
- `WEBSITE_RUN_FROM_PACKAGE`

### GitHub Actions references

- OIDC values are present in workflow env blocks.
- The producer workflow references database secrets through Azure Key Vault and uses managed identity for report storage; database or storage credentials are not copied into GitHub secrets.
- The report worker discovers only active medical-scheme routes that are schema-compatible and marked ready in the control plane.
- Its managed identity receives read access to exactly the four Key Vault secrets for each provisioned private route; it has no vault-wide secret-read role.
- New claim producers receive a per-organisation bearer credential from the platform-admin onboarding page. ClaimGuard stores only the credential hash and shows the raw token once.
- Codecov uploads use GitHub OIDC rather than a repository token.
- Production telemetry secrets are not copied from GitHub Actions. App Services resolve them directly from Key Vault.

## Doppler Inventory Status

External Doppler metadata could not be fully enumerated from this environment. The repository still documents a Doppler-first development posture, but the live project/config/token inventory should be captured in the next operational pass before any migration from plaintext App Service settings is attempted.

## Required Governance Actions

- Normalize each secret to a single named owner and delivery path.
- Prefer Key Vault references or managed identity at runtime for Azure workloads.
- Rotate observability credentials provider-by-provider and retain the old credential until replacement ingestion is verified.
- Keep rollback values and validation paths documented before any live cutover.

## Phase 12A Reconciled Runtime Posture

- API managed identity principal `fd83880b-4452-4bda-9a27-5142b49172fc` retains `Key Vault Secrets User` at vault scope for runtime reads.
- The web app receives a system-assigned managed identity and secret-scoped read access for only the web Sentry DSN through the supported observability configuration operation.
- Temporary operator write role used during migration was removed after successful cutover.
- CI run `29609437005` failed in deploy at `Run database migrations`; CI secret-scope read assignment checks for principal `fe7b2935-7f00-4996-a0c6-7f3be2390dbb` returned no matching assignment and require follow-up.
- Local secret-exposure risk was detected in workstation artifacts (Copilot chat resource files and shell history). No matching leaked string was found in tracked repository files.
