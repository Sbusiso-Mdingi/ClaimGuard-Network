# ClaimGuard approved-model Azure deployment plan

> **Status:** Repository implementation and database integration validated; Azure workload rollout pending
>
> **Approved scope:** Azure for Students (`896d3c72-d979-4bdc-a37f-060988d12032`), resource group `ClaimGuard`, South Africa North.

Prepared: 2026-07-23  
Updated: 2026-07-24

## 1. Objective

Deploy the sealed `claimguard-claim-fraud-ensemble:1.1.0` as ClaimGuard’s approved plug-and-play model and deploy the schema-14 report producer that consumes it.

The implementation uses prospective-only claim scoring:

- historical claims are retained as unscored baseline versions;
- newly submitted claims create immutable version 1 records;
- materially changed claims create subsequent immutable versions;
- identical retries create no artificial amendments or additional scoring jobs;
- scoring jobs target exact claim-version and strategy identities.

The `approved_model` strategy has no deterministic runtime fallback. Model unavailability, authentication failure, contract mismatch, incomplete claim coverage, or result-integrity failure is recorded as a typed model-processing failure.

Deterministic rules are executed only when the tenant’s explicitly active strategy is `deterministic_rules`.

## 2. Repository and ownership boundary

The model source remains a standalone, non-Git project at:

```text
/Users/sbusisomdingi/Downloads/ClaimGuard-Scenario-Lab
```

It is not copied into ClaimGuard and is not uploaded through the ClaimGuard GitHub repository.

Azure Container Registry receives a local model build context directly from the Scenario Lab project.

ClaimGuard owns:

- the typed model-service client;
- the schema-14 prospective snapshot adapter;
- model request and response contracts;
- deterministic pseudonymisation;
- detection-strategy configuration and audit history;
- immutable claim-version detection results;
- outbox-backed prospective processing;
- report construction and publication;
- control-plane data-plane routing;
- the scheduled report-worker job;
- approved deployment allowlisting.

ClaimGuard tenant configuration may select only an infrastructure-approved deployment identifier. A tenant cannot provide:

- a model endpoint;
- an image reference;
- a service URL;
- a credential;
- a secret;
- an arbitrary feature schema;
- an arbitrary threshold.

## 3. Canonical implementation baseline

The deployment baseline is:

| Component | Required baseline |
|---|---|
| Operational schema | Schema 14 |
| Operational migrations | `0001` through `0014` |
| Control-plane migrations | Complete current migration inventory |
| Supported operational routes | `legacy_shared`, `private_database` |
| Platform route | `platform_none` |
| Approved model deployment | `claimguard-claim-fraud-ensemble:1.1.0` |
| Model endpoint contract | `/v3/claim-screening` |
| Processing mode | Prospective claim-version scoring |
| Report worker | Scheduled Container Apps Job |
| Worker schema allowlist | `14` |
| API schema allowlist | `14` |

Schema and migration version 14 must be present in `data_plane_metadata` before an operational pool is published.

Metadata changes alone are not sufficient. The database must contain the actual schema-14 tables, columns, indexes, constraints, triggers, and migration history.

## 4. Current Azure state

The following table reflects the last verified Azure planning state from 2026-07-23. It does not claim that the pending deployment actions have already been completed.

| Resource | Last verified state | Required state |
|---|---|---|
| `claimguard-ml-inference` Container App | Public hello-world image; no model authentication; target port 80 | Sealed model image by digest; target port 8000; Entra authentication; health probes |
| `claimguard-report-producer` Container Apps Job | Not deployed | Scheduled schema-14 prospective drain every five minutes |
| `claimguard-report-worker-identity` | Exists with scoped roles | Reused by the job and accepted as the model-service caller |
| Model-service identity | Not deployed | Dedicated AcrPull-only user-assigned identity |
| Model Entra application | Not deployed | Dedicated single-tenant audience for bearer-token validation |
| API approved deployment allowlist | Not enabled | `claimguard-claim-fraud-ensemble:1.1.0` |
| Shared operational database | Existing | Migrated through `0014` before schema-14 runtime admission |
| Private tenant databases | Provisioning support implemented | Provisioned individually, verified, and explicitly activated |

The deployed state must be re-read from Azure immediately before execution. This document must not be treated as proof that an unchecked resource already exists or is configured correctly.

## 5. Deployment recipe

**Recipe:** Bicep plus Azure CLI, executed locally or by an explicitly approved deployment workflow.

Source-of-truth templates:

- Scenario Lab model service: `deployment/model-service/azure.bicep`
- ClaimGuard report worker: `infra/report-worker.bicep`
- ClaimGuard report-worker parameters: `infra/report-worker.bicepparam`
- ClaimGuard application deployment: `.github/workflows/ci.yml`

The obsolete ClaimGuard custom-model image-secret seam has been removed.

The report-worker infrastructure defines:

- a scheduled Container Apps Job;
- a user-assigned managed identity;
- immutable image configuration;
- Key Vault secret references;
- model-service audience configuration;
- the approved deployment ID;
- model contract expectations;
- schema-14 routing;
- report-storage configuration;
- bounded leases and retries.

## 6. Data-plane architecture

### 6.1 Shared operational route

A `legacy_shared` route:

- uses the existing shared operational MySQL database;
- requires a verified organisation-to-tenant mapping;
- uses logical database identifier `legacy-operational-shared`;
- requires schema version `14`;
- requires migration version `14`;
- normally uses environment `legacy`.

`MYSQL_URL` is used only by this explicit adapter. It is not a fallback for failed private routing.

### 6.2 Private operational route

A `private_database` route:

- uses one provisioned database for one medical-scheme organisation;
- uses logical database identifier `private:<organisationId>`;
- uses the organisation ID as the operational tenant ID;
- requires schema and migration version `14`;
- normally uses environment `production`;
- resolves username, password, host, and database name from four separate Key Vault secrets.

Private provisioning creates the route as `ready` and inactive. An explicit activation operation is required before request admission.

### 6.3 Platform route

The platform organisation uses `platform_none`.

Platform authority does not grant access to a medical scheme’s operational data. Private API authorization must reject platform-only callers before operational pool acquisition.

## 7. Prospective-only processing contract

Schema 14 establishes immutable claim-version scoring.

### 7.1 Claim ingestion

Ingestion commits the following in one transaction:

1. tenant-scoped reference validation;
2. active detection-strategy resolution;
3. new or amended claim persistence;
4. immutable claim-version insertion;
5. current-version pointer update;
6. exact-target outbox enqueue.

A new claim produces:

```text
claim_version = 1
version_reason = initial_submission
```

A materially changed claim produces:

```text
claim_version = previous_version + 1
version_reason = claim_amendment
```

An identical retry produces:

```text
no new claim version
no new scoring job
processing status = not_queued
reason = no_claim_changes
```

### 7.2 Outbox identity

The outbox payload contains exact immutable targets rather than mutable full claims:

```json
{
  "schema_version": 2,
  "dataset_scope": "triggering_claim_versions",
  "source": "api",
  "context_cutoff_at": "2026-07-24T00:00:00.000Z",
  "targets": [
    {
      "claim_id": "C1",
      "claim_version": 1
    }
  ]
}
```

The processing identity includes:

- tenant;
- target claim IDs and versions;
- strategy ID;
- strategy type;
- model deployment ID, when applicable;
- context cutoff.

Changing target order must not change idempotency. Changing the target version or strategy identity must change it.

### 7.3 Snapshot and model boundary

The worker loads:

- exact target claim versions;
- only context available on or before the immutable cutoff;
- no future claim data;
- no retrospective target expansion.

Raw claim, member, provider, and practitioner identifiers do not cross the model boundary.

Identifiers are HMAC-pseudonymised using dedicated random Key Vault material and are bound to immutable claim-version identity.

The approved model request is sent to:

```text
/v3/claim-screening
```

The response must match:

- the expected deployment ID;
- ensemble ID and version;
- feature-schema version;
- configured thresholds;
- exact target claim coverage;
- exact claim versions;
- expected result ordering and identity;
- finite numeric and valid JSON requirements.

### 7.4 Detection results

Detection results are immutable per:

- tenant;
- claim ID;
- claim version;
- strategy;
- source job.

An exact retry may reuse the previously stored result.

A mismatched retry must fail closed rather than overwrite or mutate an earlier decision.

## 8. Security and identity

| Principal | Permission | Scope |
|---|---|---|
| `claimguard-model-service-identity` | `AcrPull` | Exact ACR |
| `claimguard-report-worker-identity` | `AcrPull` | Exact ACR |
| `claimguard-report-worker-identity` | `Key Vault Secrets User` | Required individual model, shared-route, control-plane, and tenant-route secrets |
| `claimguard-report-worker-identity` | `Storage Blob Data Contributor` | Exact report container |
| Private tenant MySQL principal | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | Its own private database only |

The model Container App must use built-in authentication with:

- a dedicated single-tenant audience;
- bearer-token validation;
- the report-worker principal as the permitted caller;
- unauthenticated inference denied.

Only health endpoints may be excluded from model authentication:

```text
/health/live
/health/ready
```

They must expose service status only.

No generic application-data role may be granted at:

- subscription scope;
- resource-group scope;
- all-registries scope;
- whole-vault scope where individual-secret scope is available;
- whole-storage-account scope where container scope is sufficient;
- MySQL server-wide scope.

Private MySQL principals must not receive:

- `CREATE`;
- `ALTER`;
- `DROP`;
- `GRANT OPTION`;
- global `*.*` privileges;
- access to another tenant database.

## 9. Required application configuration

### 9.1 API

```text
AUTHENTICATION_MODE=session

CONTROL_PLANE_MYSQL_URL=<Key Vault resolved>
MYSQL_URL=<Key Vault resolved shared operational database>

DATA_PLANE_ENVIRONMENT=legacy
DATA_PLANE_PRIVATE_ENVIRONMENT=production
DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS=14

APPROVED_MODEL_DEPLOYMENT_IDS=claimguard-claim-fraud-ensemble:1.1.0
```

The exact approved-model allowlist variable name must match the deployed API implementation. The deployment process must verify the resulting App Service setting rather than assuming it was applied.

### 9.2 Report worker

```text
CONTROL_PLANE_MYSQL_URL=<secret reference>
MYSQL_URL=<shared operational secret reference>

AZURE_CLIENT_ID=<report-worker managed identity client ID>

DATA_PLANE_ENVIRONMENT=legacy
DATA_PLANE_PRIVATE_ENVIRONMENT=production
DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS=14

MODEL_SERVICE_BASE_URL=<HTTPS model-service origin>
MODEL_SERVICE_AUDIENCE=<dedicated Entra audience>
MODEL_SERVICE_DEPLOYMENT_ID=claimguard-claim-fraud-ensemble:1.1.0
MODEL_SERVICE_PSEUDONYMIZATION_KEY=<Key Vault secret>

MODEL_SERVICE_EXPECTED_ENSEMBLE_ID=claimguard-claim-fraud-ensemble
MODEL_SERVICE_EXPECTED_ENSEMBLE_VERSION=1.1.0
MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION=claim-feature-schema-2026.2

MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD=0.08760971001434723
MODEL_SERVICE_EXPECTED_RING_THRESHOLD=0.148
MODEL_SERVICE_EXPECTED_PHANTOM_THRESHOLD=0.8138303120761656
MODEL_SERVICE_TIMEOUT_SECONDS=120

REPORT_STORAGE_BACKEND=azure_blob
REPORT_STORAGE_ACCOUNT_URL=<storage account URL>
REPORT_STORAGE_CONTAINER=claimguard-reports

REPORT_WORKER_BATCH_SIZE=10
REPORT_WORKER_MAX_BATCHES_PER_RUN=100
REPORT_WORKER_LEASE_SECONDS=300
REPORT_WORKER_MAX_ATTEMPTS=5
REPORT_WORKER_RETRY_INITIAL_SECONDS=30
REPORT_WORKER_RETRY_MAX_SECONDS=900
```

The scheduled job currently targets:

```text
cron: */5 * * * *
parallelism: 1
replicaCompletionCount: 1
replicaRetryLimit: 0
replicaTimeout: 1800 seconds
```

## 10. Database migration procedure

### 10.1 Control plane

```bash
export CONTROL_PLANE_MYSQL_URL="<resolved control-plane URL>"

pnpm \
  --filter @claimguard/control-plane-database \
  migrate
```

### 10.2 Shared operational database

```bash
export MYSQL_URL="<resolved operational URL>"
export OPERATIONAL_ADMIN_MODE=legacy_shared

pnpm \
  --filter @claimguard/database \
  exec node src/migrate.js
```

The operational migration must complete through `0014`.

Do not modify the contents of an already applied migration. Migration checksums are enforced.

### 10.3 Private databases

Private databases are migrated by the provisioning worker using the canonical operational migration inventory.

The worker must:

1. create or identify the private database;
2. apply migrations through `0014`;
3. convert bootstrap tenant foundations to the organisation tenant;
4. create the organisation’s chain head;
5. create its explicit active deterministic strategy;
6. remove the bootstrap `tenant_default` foundations;
7. write private metadata;
8. verify runtime-principal isolation;
9. register the route as ready but inactive.

## 11. CI and release gates

Production deployment is gated by both:

```text
validate
mysql-integration
```

The real-MySQL job runs against MySQL 8.4 and verifies:

1. control-plane migration replay and constraints;
2. operational schema-14 migrations;
3. data-plane metadata compatibility;
4. prospective claim-version ingestion;
5. identical-retry idempotency;
6. amendment versioning;
7. tenant isolation;
8. API route admission and authorization;
9. private-database provisioning;
10. private-principal database isolation;
11. provisioning retry safety;
12. inactive-route behaviour before activation.

The production `deploy` job cannot run on `main` unless both jobs succeed.

The deployment migration step retrieves database URLs from Key Vault and sets:

```text
OPERATIONAL_ADMIN_MODE=legacy_shared
```

before applying operational migrations.

## 12. Deployment sequence

### Repository and database readiness

- [x] Implement the strict schema-14 model client and report contract.
- [x] Implement prospective-only immutable claim-version scoring.
- [x] Implement exact-target outbox processing.
- [x] Implement immutable detection-result persistence.
- [x] Implement audited tenant strategy changes.
- [x] Implement schema-14 shared and private routing.
- [x] Implement private-database provisioning and retry isolation.
- [x] Add the real-MySQL CI deployment gate.
- [x] Pass ClaimGuard unit, integration, lint, build, and coverage checks.
- [x] Pass the complete real-MySQL integration job.
- [x] Validate exact parity against the sealed Gate F/H corpus.
- [x] Validate regenerated ingestion batches against ClaimGuard contracts.
- [x] Pass Scenario Lab tests, lint, and type checks.
- [x] Build and smoke-test non-root Linux model and report-worker images locally.
- [x] Replace the obsolete custom-model infrastructure seam.
- [x] Complete Bicep compile, ARM validation, what-if, policy, and static RBAC checks.

### Azure rollout

- [ ] Re-read the current Azure resource state.
- [ ] Confirm the approved subscription, resource group, and region.
- [ ] Build and push immutable images to the existing ACR.
- [ ] Record final model and worker image digests.
- [ ] Create or verify the model-service managed identity.
- [ ] Verify exact ACR `AcrPull` propagation.
- [ ] Create the dedicated single-tenant Entra model audience.
- [ ] Configure model Container Apps authentication.
- [ ] Update `claimguard-ml-inference` in place.
- [ ] Verify model liveness and readiness.
- [ ] Verify unauthenticated inference is rejected.
- [ ] Verify authenticated `/v3/claim-screening`.
- [ ] Create or verify the model-pseudonymisation Key Vault secret.
- [ ] Deploy `claimguard-report-producer`.
- [ ] Verify the report-worker managed identity.
- [ ] Verify exact secret-level and blob-container RBAC.
- [ ] Add the approved model deployment ID to API configuration.
- [ ] Apply current control-plane migrations.
- [ ] Apply operational migrations through `0014`.
- [ ] Confirm shared `data_plane_metadata` reports schema and migration version 14.
- [ ] Restart or redeploy the API only after migration success.
- [ ] Run one report-worker execution.
- [ ] Verify a typed successful result or legitimate empty drain.
- [ ] Verify immutable detection-result persistence.
- [ ] Verify tenant report publication.
- [ ] Verify live image digests, identities, RBAC scopes, auth policy, and environment variables.

Private tenant routes must remain inactive unless their independent provisioning and activation workflows complete.

## 13. Validation proof

| Check | Command or evidence | Result | Timestamp |
|---|---|---|---|
| ClaimGuard application suites | JavaScript and Python test, lint, build, coverage, and diff checks | Pass | 2026-07-24 |
| Real MySQL control-plane gate | Current migration inventory applied and replayed on MySQL 8.4 | Pass | 2026-07-24 |
| Real MySQL operational gate | Migrations through schema 14, metadata, constraints, and immutable foundations | Pass | 2026-07-24 |
| Real MySQL routed API gate | Schema-14 route admission, tenant isolation, prospective insert/retry/amendment behaviour | Pass | 2026-07-24 |
| Real MySQL provisioning gate | Private schema creation, tenant conversion, retry safety, route inactivity, and cross-database denial | Pass | 2026-07-24 |
| Report-worker image | Narrow-context Docker build, non-root inspection, package-import smoke | Pass: linux/amd64, UID/GID 10001 | 2026-07-23 |
| Model image | Pinned Docker build, readiness and inference smoke | Pass: linux/amd64, UID 10001, local digest `sha256:65360d57ac90aea446c36effe50125122710cc3b3178cd8c95c99cdf04c94605` | 2026-07-23 |
| Model Bicep compile | `az bicep build`; `az bicep build-params` | Pass | 2026-07-23 |
| Worker Bicep compile | `az bicep build`; `az bicep build-params` | Pass | 2026-07-23 |
| Model ARM validation | `az deployment group validate` | Pass against `ClaimGuard` | 2026-07-23 12:18 SAST |
| Model structured what-if | `az deployment group what-if --result-format ResourceIdOnly` | Pass: identity, exact AcrPull, auth configuration, no deletes | 2026-07-23 12:19 SAST |
| Worker ARM validation | `az deployment group validate` | Pass against `ClaimGuard` | 2026-07-23 12:20 SAST |
| Worker structured what-if | `az deployment group what-if --result-format ResourceIdOnly` | Pass: job, pseudonym secret, exact secret role, no deletes | 2026-07-23 12:21 SAST |
| Azure policy | `az policy assignment list` | Pass: `southafricanorth` allowed | 2026-07-23 12:22 SAST |
| Bicep lint and final compile | `az bicep lint`; `az bicep build` | Pass for model, report worker, and bootstrap templates | 2026-07-23 12:25 SAST |
| Static RBAC verification | Inspect each role assignment principal, role, and scope | Pass for planned infrastructure | 2026-07-23 12:26 SAST |
| Workflow and diff safety | YAML parse, removed-seam search, `git diff --check` | Pass | 2026-07-24 |

The local model-image digest above is not automatically proof of the final ACR digest. Record and verify the registry digest after pushing the image.

## 14. Production verification

After Azure rollout, verify all of the following before enabling an approved model for any tenant:

### Model service

- image is referenced by immutable digest;
- target port is 8000;
- liveness and readiness probes pass;
- unauthenticated inference is rejected;
- the dedicated audience is enforced;
- only the report-worker identity is permitted;
- `/v3/claim-screening` returns the expected contract;
- response metadata matches the approved deployment.

### Report worker

- job uses the intended immutable image digest;
- schedule is enabled;
- managed identity is attached;
- control-plane and shared operational secrets resolve;
- private tenant secrets are readable only when granted;
- pseudonymisation secret resolves;
- report container is writable;
- one execution completes without untyped failure;
- no raw identifiers appear in model requests or logs.

### API and data plane

- API supports schema 14;
- control-plane and operational URLs are distinct;
- shared metadata reports schema and migration version 14;
- active routes report schema 14;
- private routes remain inactive until activation;
- platform users receive no private-route bypass;
- approved deployment ID is available in the strategy UI;
- strategy changes require an actor and audit reason.

### Prospective processing

- a new claim creates version 1 and one job;
- an identical retry creates no new version or job;
- an amendment creates version 2 and another job;
- historical baselines are not retrospectively enqueued;
- results are linked to the exact claim version;
- exact retries reuse results;
- conflicting retries fail closed;
- reports contain only targeted prospective claim versions.

## 15. Rollback

### Model rollback

Disable the report-worker schedule before changing the model revision.

Restore a previously approved immutable model image only when its:

- deployment ID;
- contract version;
- feature schema;
- thresholds;
- authentication configuration

remain compatible with ClaimGuard.

The previous hello-world placeholder is not an acceptable operating fallback.

### Worker rollback

Disable the scheduled job or redeploy a previously approved immutable worker image.

Do not deploy a worker that:

- supports only schema 13;
- uses retrospective review windows;
- sends raw identifiers;
- reads mutable latest claim state;
- overwrites detection results;
- processes legacy `report_production` jobs.

### Strategy rollback

Select `deterministic_rules` explicitly for the affected tenant and provide an audit reason.

This is an administrative strategy change. It is not an automatic runtime fallback.

Already committed approved-model results remain immutable.

### API rollback

A non-production rollback may use:

```text
AUTHENTICATION_MODE=demo_headers
```

Production must not use that mode.

Do not mix routed session instances and rollback instances behind one load balancer.

### Identity rollback

Remove newly introduced identities or role assignments only after the associated workloads have been disabled.

Do not remove shared baseline roles used by another deployed workload.

### Database rollback

Database migrations are forward-only.

Do not:

- edit migration `0014` after application;
- delete claim-version history;
- reset `current_claim_version`;
- delete detection results;
- re-enable retrospective legacy jobs;
- downgrade route metadata to schema 13 without a complete, separately designed migration;
- drop private databases as an ordinary rollback action.

## 16. Prohibited deployment actions

This deployment does not authorise:

- resource-group deletion;
- database deletion;
- secret purge;
- broad RBAC replacement;
- subscription-wide application-data roles;
- disabling tenant isolation;
- bypassing the real-MySQL gate;
- manually setting schema metadata without migrations;
- activating an unverified private route;
- exposing the model endpoint without authentication;
- supplying tenant-controlled model URLs or credentials;
- retrospective scoring of historical baseline claims.

Any emergency deviation requires a separately reviewed and documented change plan.
