# Observability and Credential Rotation

This document is the production source of truth for ClaimGuard's external
diagnostic integrations. It records connection boundaries without recording
credential values.

## Supported integration map

| Platform | Responsibility | Authentication and delivery | Production status |
| --- | --- | --- | --- |
| GitHub Actions | CI and explicitly authorized deployment | Entra workload identity federation (OIDC), no client secret | Connected |
| Codecov | JavaScript and Python coverage reporting | GitHub OIDC in `ci.yml`, no repository upload token | Connected |
| Sentry | API and browser error reporting only | DSNs held in Key Vault and delivered through App Service Key Vault references | Connected |
| New Relic | API APM, distributed tracing, and obfuscated SQL timing | ingest license key held in Key Vault and delivered through an App Service Key Vault reference | Connected |
| Azure Monitor / Log Analytics | App Service and Container Apps platform/application logs and metrics | Azure managed identity/RBAC and diagnostic settings | Connected |
| BrowserStack / Percy | Browser testing | No repository workflow, webhook, or credential consumer exists | Not connected |
| Doppler | Local developer convenience | Local `doppler run`; not a production source of truth | Local only |
| Application Insights | None | No resource or runtime connection exists | Not connected by design |
| AstraSecurity | None | Mentioned only in the early technical specification | Not connected |

Sentry and New Relic deliberately do not duplicate responsibilities:

- Sentry captures errors with PII disabled and performance sampling set to zero.
- New Relic owns API performance tracing. SQL text is obfuscated, request
  parameters and headers are excluded, and application-log forwarding is
  disabled.
- Azure Log Analytics owns structured application and platform logs and Azure
  metrics.

## Deployment boundary

`infra/configure-app-service-observability.sh` is the only supported production
operation for App Service observability configuration. It:

1. stops unless the exact subscription, resource group location, apps, Key
   Vault, workspace, and secret names exist;
2. assigns system-managed identities where absent;
3. grants only the required Key Vault secret reads (the API retains its
   separately governed runtime access); missing RBAC fails closed during CI,
   while a one-time authorized operator must explicitly set
   `ALLOW_OBSERVABILITY_RBAC_CHANGES=true`;
4. applies Key Vault references without retrieving secret values;
5. preloads New Relic and its ESM loader before `mysql2`;
6. aligns deployment packaging and production on Node.js 22;
7. routes selected application, console, platform, authentication, audit, and
   IPSec logs plus metrics to Log Analytics;
8. refreshes and verifies every Key Vault reference.

The deploy job is bound to GitHub's `production` environment and must still
pass the exact-SHA `DEPLOY_PRODUCTION` guard. Ordinary pushes cannot deploy.

## Secret names

The production Key Vault contains these observability aliases:

- `claimguard--observability--sentry-api-dsn`
- `claimguard--observability--sentry-web-dsn`
- `claimguard--observability--new-relic-license-key`

Workloads reference the alias without a version so a rotation can publish a new
version, refresh App Service references, verify ingestion, and only then revoke
the old provider credential.

## Rotation procedure

Perform one provider at a time.

1. Create a replacement provider credential in the provider dashboard. Do not
   revoke the current credential.
2. Store the replacement as a new version of the matching Key Vault secret
   without printing it.
3. refresh the App Service Key Vault references;
4. verify that the reference status is `Resolved`, health/readiness remains
   healthy, and a bounded synthetic diagnostic reaches the expected provider
   project/entity;
5. wait through the provider's documented ingestion interval and confirm that
   normal telemetry uses the new credential;
6. revoke the old provider credential;
7. remove any obsolete GitHub repository secret and record the date, actor, Key
   Vault version identifier, and provider credential identifier (never the
   value) in the operational audit record.

If verification fails, restore the prior enabled Key Vault version and refresh
references. Never revoke the prior credential before the replacement is
verified.

### Codecov

Codecov upload authentication is keyless. If a legacy repository upload token
exists in Codecov, revoke it in the Codecov UI; no GitHub secret replacement is
required. Both coverage uploads must continue to show GitHub OIDC
authentication and successful JavaScript/Python flag ingestion.

### Sentry

Rotate the API and web project DSNs independently. A DSN can be present in
browser code and is not equivalent to a Sentry user authentication token, but
rotation is still required after unintended publication. Sentry user auth
tokens must never be stored in this repository or App Service.

### New Relic

Create a new `INGEST - LICENSE` key, update the Key Vault alias, verify APM
harvest from the `ClaimGuard API` entity, then delete the superseded ingest key.
If the account uses an undeletable original license key, contact New Relic
support and record that exception.

### Model-service EasyAuth

The model-service application credential is a separate authentication boundary,
not an observability credential. Rotate it atomically across every Container
App that references `microsoft-provider-authentication-secret`; verify EasyAuth
health and the exact allowed worker principal before deleting either previous
application password. Do not invoke scoring as part of credential rotation.

## Preventive controls

- GitHub secret scanning and push protection are enabled where the repository
  plan supports them.
- `node tools/audit-credential-history.mjs --fail-on-findings` scans every Git
  history diff and reports metadata only, never the matched value.
- CI rejects telemetry secrets copied directly from GitHub into App Service.
- CI uses Codecov OIDC and Azure OIDC.
- Local agent logs and environment files are ignored.
- Provider dashboard access tokens are operator credentials and remain outside
  source control, GitHub Actions, and workload configuration.
