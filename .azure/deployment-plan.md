# ClaimGuard report-worker Azure deployment plan

> **Status:** Validated

Generated: 2026-07-19
Approved by user: 2026-07-19

## 1. Objective

Deploy the existing production report-processing worker as a scheduled Azure Container Apps Job. This worker drains durable claim outbox records, runs the detection pipeline, and publishes report artifacts. It is not a claim simulator and it does not generate claims.

This is a narrow update to existing ClaimGuard infrastructure. The API, web application, databases, registry, Key Vault, storage account, Container Apps environment, and observability workspace remain unchanged.

### 2026-07-19 onboarding and tenant-promotion extension

Promote the three existing medical-aid private databases from schema 8 to schema 10, retain ClaimGuard as an active route-less platform organisation, and complete the web-admin onboarding path. Platform administrators can create, provision, upgrade, activate, issue one-time per-server ingestion credentials, review sync instructions, and revoke credentials without using Azure Portal.

The provisioning controller receives the built-in `Key Vault Data Access Administrator` role on the existing vault. Azure constrains that role with ABAC to approved Key Vault data roles. The controller uses it only to assign `Key Vault Secrets User` to the fixed report-worker principal on each tenant route's four exact secrets; the report worker receives no vault-wide secret-read role.

## 2. Requirements and Azure context

| Attribute | Value |
|---|---|
| Path | Modify existing Azure application |
| Classification | Production-shaped |
| Scale | Small initial workload; bounded single-replica scheduled drain |
| Budget | Cost-optimized within the existing Azure for Students subscription |
| Subscription | Azure for Students (`896d3c72-d979-4bdc-a37f-060988d12032`) |
| Tenant | `8efc1bb9-b90f-4a48-bf6c-ba0686193b80` |
| Resource group | `ClaimGuard` |
| Location | South Africa North (`southafricanorth`) |
| Policy constraint | Subscription policy permits `southafricanorth` |
| Data classification | Medical-claim data; credentials remain in Key Vault and reports remain in a private blob container |

The subscription and location are the existing production context and were included in the exact deployment scope approved by the user.

## 3. Components

| Component | Type | Technology | Deployment target |
|---|---|---|---|
| Report producer | Background worker | Python 3.12 container | Azure Container Apps scheduled job |
| Detection engine | Worker dependency | Python | Included in worker image |
| Durable outbox | Operational data | Azure Database for MySQL | Existing service; Key Vault reference only |
| Data-plane routing | Control-plane data | Azure Database for MySQL | Existing service; Key Vault reference only |
| Report artifacts | Blob storage | Azure Storage | Existing private `claimguard-reports` container |

## 4. Recipe

**Selected:** AZCLI with Bicep-managed identity and RBAC bootstrap.

The repository already deploys through GitHub Actions and Azure CLI. Bicep is added for the security-sensitive, reproducible identity and least-privilege role assignments; the workflow remains responsible for immutable image build, job create/update, and smoke verification.

## 5. Architecture and security boundaries

| Item | Existing or new | Configuration |
|---|---|---|
| Container Apps environment | Existing | `claimguard-env-11e` |
| Container registry | Existing | `claimguardacr11e`; admin credentials disabled |
| Worker managed identity | New | `claimguard-report-worker-identity` |
| Scheduled job | New | `claimguard-report-producer`; `*/5 * * * *` UTC |
| Key Vault | Existing | `claimguard-kv-ufs`; RBAC authorization |
| Blob container | Existing | `cgrpt0715sa/claimguard-reports`; public access disabled |

The worker identity receives only:

- `AcrPull` on the exact registry.
- `Key Vault Secrets User` on the exact operational database secret.
- `Key Vault Secrets User` on the exact control-plane database secret.
- `Storage Blob Data Contributor` on the exact report container.

For a selected `private_database` organisation, the plan can add `Key Vault Secrets User` on exactly the four secret names referenced by that route. The parameter is intentionally empty until the user selects an organisation and its schema is compatible; vault-wide access is not permitted.

The GitHub Actions OIDC service principal receives `Key Vault Secrets User` only on the exact control-plane database secret so the existing CI deployment can run the control-plane migration. No credentials or secret values are committed.

## 6. Provisioning limits and capacity

| Resource type | New | Current | Total after deployment | Limit/capacity | Result and source |
|---|---:|---:|---:|---:|---|
| `Microsoft.ManagedIdentity/userAssignedIdentities` | 1 | 3 | 4 | No customer-adjustable regional quota exposed | Pass; live Azure inventory |
| `Microsoft.App/jobs` | 1 | 1 | 2 | Uses existing environment capacity | Pass; live Azure inventory |
| Managed Environment Consumption Cores | 1 during execution | 0 | 1 | 100 | Pass; `az containerapp env list-usages` |
| `Microsoft.App/managedEnvironments` | 0 | 1 | 1 | 1 | Pass; no new environment; Azure Quota Management |

Azure Quota Management provider registration was enabled to perform the subscription-level check. No quota increase is required.

## 7. Research and implementation decisions

- Container Apps scheduled jobs use five-field UTC cron expressions; `*/5 * * * *` runs every five minutes.
- A user-assigned managed identity is used for deterministic Key Vault, ACR, and Blob authentication.
- Role assignments set `principalType: ServicePrincipal` and use deterministic names.
- Existing Key Vault secrets and the existing blob container are referenced, not recreated.
- The job drains a bounded number of batches per execution to prevent overlapping unbounded work.
- The worker follows the API's authoritative route contract for both `legacy_shared` and `private_database`, resolves private credentials from Key Vault in memory, and detects route or credential rotation between batches.
- The GitHub workflow builds an immutable image tagged with the commit SHA and verifies one job execution after deployment.

## 8. Functional verification

- Worker unit and CLI behavior: verified locally.
- Complete monorepo lint, build, and test suite: passed locally.
- Deployment workflow YAML: parsed locally.
- Live end-to-end check: pending deployment; the workflow must start a job execution and observe `Succeeded`.
- A successful empty drain is acceptable when no claims are queued. A real-claim processing cycle belongs to the later claims-stream task.

## 9. Execution checklist

### Planning and preparation

- [x] Scan the existing workspace and Azure deployment model.
- [x] Confirm the existing subscription, resource group, location, and policy constraint.
- [x] Check live Container Apps capacity and resource counts.
- [x] Select the AZCLI recipe for the existing custom GitHub Actions deployment.
- [x] Define the identity and exact least-privilege scopes.
- [x] Receive user approval for the exact Azure changes.
- [x] Generate and compile the identity/RBAC Bicep.
- [x] Update status to `Ready for Validation`.

### Validation

- [x] Authenticate to the approved subscription.
- [x] Compile Bicep.
- [x] Validate the resource-group deployment.
- [x] Run an Azure what-if preview and confirm only approved changes.
- [x] Build the report-worker container.
- [x] Run repository lint, build, tests, YAML parse, and diff checks.
- [x] Perform static role and scope verification.
- [x] Revalidate the final private-route-capable worker, dependency lock, image, Bicep, and workflows.
- [x] Record the post-diagnosis validation proof and update status to `Validated`.

### Deployment

- [x] Complete the pre-deployment subscription, location, conflict, and RBAC checks.
- [x] Deploy the identity and five baseline role assignments.
- [x] Verify live role assignments at exact scopes.
- [x] Temporarily grant the signed-in user read access to the one control-plane secret, query eligible organisation metadata without printing credentials, and immediately revoke that temporary assignment.
- [ ] Deploy the constrained provisioning-controller role.
- [ ] Commit, push, and update the existing pull request.
- [ ] Upgrade Bonitas, Discovery Health, and Momentum Health to schema 10 and activate their generation-2 routes.
- [ ] Merge after CI passes.
- [ ] Deploy the API, web interface, and auto-discovering report-producer workflow from `main`.
- [ ] Verify the job schedule, managed identity, secrets, storage scope, and a successful execution.
- [ ] Update status to `Deployed`.

## 10. Validation proof

| Check | Command | Result | Timestamp |
|---|---|---|---|
| Azure CLI and context | `az version`; `az account show` | Pass: CLI 2.88.0; approved subscription and tenant | 2026-07-19 15:48 SAST |
| Bicep compilation | `az bicep build`; `az bicep build-params` | Pass | 2026-07-19 15:48 SAST |
| ARM validation | `az deployment group validate` | Pass: `Succeeded` | 2026-07-19 15:49 SAST |
| What-if preview | `az deployment group what-if` | Pass: six creates only (one identity and five role assignments); no updates or deletes | 2026-07-19 15:50 SAST |
| Azure policy | `az policy assignment list` | Pass: `southafricanorth` is in the allowed-locations policy | 2026-07-19 15:30 SAST |
| Azure capacity | `az quota list`; `az quota usage list`; `az containerapp env list-usages` | Pass: no new environment; 1 of 100 consumption cores required | 2026-07-19 15:41 SAST |
| Worker image | `docker build --tag claimguard-report-producer:validation --file services/report-producer/Dockerfile .` | Pass | 2026-07-19 15:54 SAST |
| Application verification | `pnpm turbo run lint build test` | Pass: 27 of 27 tasks | 2026-07-19 15:56 SAST |
| Workflow and diff validation | Ruby YAML parse; `git diff --check` | Pass | 2026-07-19 15:56 SAST |
| Static role verification | Inspect all `Microsoft.Authorization/roleAssignments` scopes | Pass: exact ACR, Key Vault secret, and blob-container scopes; no resource-group or subscription scopes | 2026-07-19 15:56 SAST |
| Private-route worker tests | `uv run --project services/report-producer --frozen python -m unittest discover ...` | Pass: 32 tests; schema 8 fails closed before secret resolution | 2026-07-19 16:17 SAST |
| Post-diagnosis application verification | `pnpm turbo run lint build test` | Pass: 27 of 27 tasks | 2026-07-19 16:14 SAST |
| Post-diagnosis ARM validation | Bicep compile, parameter compile, `az deployment group validate`, and what-if | Pass: template valid and no unapproved live changes with private-secret list empty | 2026-07-19 16:10 SAST |
| Post-diagnosis worker image | `docker build --tag claimguard-report-producer:validation ...` | Pass with `azure-keyvault-secrets==4.11.0` | 2026-07-19 16:16 SAST |
| Tenant-activation extension | Bicep compile, parameter compile, ARM validation, and what-if | Pass: one new constrained Key Vault role; dynamic managed-identity references only; no deletes or resource replacements | 2026-07-19 16:59 SAST |
| Final application verification | `pnpm turbo run lint build test --output-logs=errors-only --summarize` | Pass: 27 of 27 tasks | 2026-07-19 16:58 SAST |

### Static role assignment verification

- Identity checked: `claimguard-report-worker-identity`.
- Confirmed: `AcrPull` on `claimguardacr11e`.
- Confirmed: `Key Vault Secrets User` separately on the control-plane and operational secret resources.
- Confirmed: `Storage Blob Data Contributor` on only `cgrpt0715sa/claimguard-reports`.
- GitHub Actions OIDC principal confirmed: `Key Vault Secrets User` on only the control-plane secret.
- No generic `Owner`, `Contributor`, or resource-group-wide application data access is introduced.

**Validated by:** Azure validation workflow

**Validation timestamp:** 2026-07-19 16:59 SAST

## 10A. Live deployment and routing discovery

- Baseline deployment `claimguard-report-worker-security-20260719` succeeded at 2026-07-19 15:58 SAST.
- Worker identity principal: `7d7b986b-2984-4aba-925c-9a009ee56c67`.
- All five baseline roles were verified live at the exact ACR, secret, and blob-container scopes.
- Temporary operator secret access was removed and a clean role query returned no remaining assignment.
- No currently active organisation meets the worker's canonical schema-10 gate. Bonitas, Discovery Health, and Momentum Health each have an active `private_database` route recorded as schema `8`; their legacy mappings are not linked to those private routes, as expected for private routing.
- The worker job and GitHub organisation variables remain undeployed/unset. Selecting an organisation and resolving the schema-8-to-10 route promotion require explicit user direction and separate validation.

## 11. Files

| File | Purpose | Status |
|---|---|---|
| `.azure/deployment-plan.md` | Deployment source of truth | Updated |
| `infra/main.bicep` | Worker identity and exact RBAC scopes | Validated |
| `infra/main.bicepparam` | Non-secret environment parameters | Validated |
| `.github/workflows/producer-deploy.yml` | Build, deploy, schedule, and smoke-test worker | Validated |
| `.github/workflows/ci.yml` | Apply both control-plane and operational migrations | Validated |

## 12. Rollback

- Application rollback: redeploy the prior immutable worker image or remove/disable the scheduled job.
- RBAC rollback: remove only the role assignments created by `infra/main.bicep` after the job is disabled.
- Data rollback: no database data is generated or deleted by infrastructure deployment; migrations remain forward-only and are handled by the existing migration process.
