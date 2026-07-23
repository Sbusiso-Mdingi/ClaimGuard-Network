# ClaimGuard approved-model Azure deployment plan

> **Status:** Validated
>
> **Approved scope:** Azure for Students (`896d3c72-d979-4bdc-a37f-060988d12032`), resource group `ClaimGuard`, South Africa North.

Prepared: 2026-07-23

## 1. Objective

Deploy the sealed `claimguard-claim-fraud-ensemble:1.1.0` as ClaimGuard's approved plug-and-play model and deploy the schema-13 report producer that consumes it.

The approved-model strategy has no deterministic fallback. Model unavailability, authentication failure, contract mismatch, or incomplete claim coverage is recorded as `MODEL_SERVICE_UNAVAILABLE`; deterministic rules are not executed on that path.

## 2. Repository and ownership boundary

The model source remains a standalone, non-Git project at:

`/Users/sbusisomdingi/Downloads/ClaimGuard-Scenario-Lab`

It is not copied into ClaimGuard and is not uploaded through GitHub. Azure Container Registry receives a local build context directly from the Downloads project.

ClaimGuard owns only the typed model client, schema-13 snapshot adapter, report contract, detection-strategy deployment ID, and scheduled report-worker job.

## 3. Current Azure state

| Resource | Current state | Required state |
|---|---|---|
| `claimguard-ml-inference` Container App | Public hello-world image; no auth; target port 80 | Sealed model image by digest; target port 8000; Entra auth; health probes |
| `claimguard-report-producer` Container Apps Job | Absent | Scheduled schema-13 drain every five minutes |
| `claimguard-report-worker-identity` | Exists with exact ACR, Key Vault, and Blob roles | Reused by the job and accepted as the only model caller |
| Model-service identity | Absent | Dedicated AcrPull-only user-assigned identity |
| Model Entra application | Absent | Dedicated single-tenant audience for bearer-token validation |
| API approved deployment allowlist | Absent | `claimguard-claim-fraud-ensemble:1.1.0` |

## 4. Deployment recipe

**Recipe:** Bicep plus Azure CLI, executed locally.

Source-of-truth templates:

- Scenario Lab: `deployment/model-service/azure.bicep`
- ClaimGuard: `infra/report-worker.bicep`

The legacy ClaimGuard `customModelImageSecret` block has been removed. Tenant configuration may select only an allow-listed deployment ID and cannot supply a URL, image, endpoint, credential, or secret.

## 5. Security and identity

| Principal | Permission | Scope |
|---|---|---|
| `claimguard-model-service-identity` | `AcrPull` | Exact ACR |
| `claimguard-report-worker-identity` | `AcrPull` | Exact ACR |
| `claimguard-report-worker-identity` | `Key Vault Secrets User` | Exact operational, control-plane, tenant-route, and model-pseudonym secrets |
| `claimguard-report-worker-identity` | `Storage Blob Data Contributor` | Exact report container |

Container Apps built-in authentication validates the dedicated Entra audience and rejects unauthenticated traffic. Its authorization policy and the model application both allow only the report-worker principal. `/health/live` and `/health/ready` are excluded from authentication and expose status only.

Raw member, provider, practitioner, and claim identifiers never cross the model boundary. The report worker HMAC-pseudonymizes them using a dedicated random Key Vault secret.

No generic subscription-, resource-group-, registry-, vault-, or storage-wide application data access is introduced.

## 6. Deployment sequence

- [x] Implement strict schema-13 model client and report contract.
- [x] Validate exact parity against the sealed Gate F/H corpus.
- [x] Validate regenerated ingestion batches against ClaimGuard's shared schema.
- [x] Pass Scenario Lab tests, lint, and type checks.
- [x] Pass ClaimGuard tests, lint, build, and diff checks.
- [x] Build and smoke-test both non-root Linux model and report-worker images locally.
- [x] Replace the obsolete model infrastructure seam.
- [x] Complete fresh Bicep compile, ARM validation, what-if, policy, and static RBAC checks.
- [ ] Build and push immutable images directly to the existing ACR.
- [ ] Create the model identity and verify AcrPull propagation.
- [ ] Create the dedicated single-tenant Entra model audience and short-lived Container Apps auth credential.
- [ ] Update `claimguard-ml-inference` in place and verify readiness plus authenticated scoring.
- [ ] Create the model-pseudonym Key Vault secret and deploy `claimguard-report-producer`.
- [ ] Add the approved deployment ID to the API environment.
- [ ] Apply schema-13 operational/control-plane migrations before enabling model selection.
- [ ] Start one report-worker execution and verify typed success or a legitimate empty drain.
- [ ] Verify live identities, exact RBAC scopes, auth policy, image digests, and environment variables.

The API/web application deployment is separately gated because the local ClaimGuard worktree contains unrelated user changes. Those changes must not be shipped as a side effect of this model deployment.

## 7. Validation proof

| Check | Command | Result | Timestamp |
|---|---|---|---|
| Local application suites | `pnpm test`; `pnpm lint`; `pnpm build`; Scenario Lab pytest/ruff/mypy | Pass | 2026-07-23 |
| Report-worker image | Narrow-context `docker build`; non-root image inspect; package import smoke | Pass: linux/amd64, UID/GID 10001 | 2026-07-23 |
| Model image | Pinned Docker build; readiness and inference smoke | Pass: linux/amd64, UID 10001, digest `sha256:65360d57ac90aea446c36effe50125122710cc3b3178cd8c95c99cdf04c94605` | 2026-07-23 |
| Model Bicep local compile | `az bicep build`; `az bicep build-params` | Pass | 2026-07-23 |
| Worker Bicep local compile | `az bicep build`; `az bicep build-params` | Pass | 2026-07-23 |
| Model ARM validation | Azure validation helper: `az deployment group validate` | Pass against `ClaimGuard` | 2026-07-23 12:18 SAST |
| Model structured what-if | `az deployment group what-if --result-format ResourceIdOnly` | Pass: create identity, exact AcrPull, and auth config; deploy existing model app; no deletes | 2026-07-23 12:19 SAST |
| Worker ARM validation | Azure validation helper: `az deployment group validate` | Pass against `ClaimGuard` | 2026-07-23 12:20 SAST |
| Worker structured what-if | `az deployment group what-if --result-format ResourceIdOnly` | Pass: create job, pseudonym secret, and exact secret role; existing AcrPull unchanged; no deletes | 2026-07-23 12:21 SAST |
| Azure policy | `az policy assignment list` | Pass: `southafricanorth` is in the enforced allowed-location set | 2026-07-23 12:22 SAST |
| Bicep lint and final compile | `az bicep lint`; `az bicep build` | Pass for model, report worker, and legacy bootstrap templates | 2026-07-23 12:25 SAST |
| Static RBAC verification | Inspect every `Microsoft.Authorization/roleAssignments` principal, role, and scope | Pass: model identity has exact-ACR `AcrPull`; worker addition is exact-secret `Key Vault Secrets User`; baseline roles remain resource/secret/container scoped | 2026-07-23 12:26 SAST |
| Workflow and diff safety | YAML parse; removed-seam search; `git diff --check` | Pass; unsafe schema-10 workflow retired | 2026-07-23 12:26 SAST |

**Validated by:** Azure validation workflow

**Validation timestamp:** 2026-07-23 12:27 SAST

## 8. Rollback

- Model rollback: restore the prior Container App revision/image only after disabling the report job. The hello-world placeholder is not an acceptable operating fallback.
- Worker rollback: disable the scheduled job or redeploy the prior immutable worker image.
- Strategy rollback: select `deterministic_rules` explicitly per tenant. This is an administrative strategy change, not an automatic runtime fallback.
- Identity rollback: remove only newly introduced model identity/role assignments after both workloads are disabled.
- Database migrations are forward-only and are not rolled back automatically.

No resource deletion, database drop, secret purge, or broad RBAC removal is part of this deployment.
