# Governed production release plans

> **Status:** Validated — web/API recovery
>
> **Scope:** Azure for Students
> (`896d3c72-d979-4bdc-a37f-060988d12032`), resource group `ClaimGuard`,
> South Africa North.
>
> **Recipe:** CI/CD (`.github/workflows/ci.yml`)

## Web/API recovery and Clerk release — 2026-08-08

The user explicitly authorised recovery and deployment of the existing Sequrin
web and API App Services. No new Azure resource, region, subscription, pricing
tier, role assignment, data-plane route, or production claim mutation is in
scope.

Targets:

- `https://claimguard-web.azurewebsites.net`
- `https://claimguard-api.azurewebsites.net`
- exact `main` release through the governed GitHub `production` environment;
- Clerk workforce authentication configured for the exact Azure origins;
- production deployment remains subject to immutable artifacts, exact SHA,
  successful CI/security evidence, and the existing independent platform-admin
  approval rule.

Recovery finding: the operational migration package script invoked
`src/migrate.js`, but that module exported migrations without executing them.
Consequently the operational database remained at schema 15 while later API
releases required schema 17, leaving `/health` live but `/ready` fail-closed.
The focused recovery adds an explicit, guarded migration entry point and a
regression test. The production database will be migrated only through the
validated `OPERATIONAL_ADMIN_MODE=legacy_shared` boundary.

Web/API validation proof is recorded in the addendum at the end of this plan.

### Web/API recovery validation proof

Validated on 2026-08-08:

| Check | Result |
|---|---|
| Azure context | Subscription `896d3c72-d979-4bdc-a37f-060988d12032`, tenant `8efc1bb9-b90f-4a48-bf6c-ba0686193b80`, resource group `ClaimGuard`, South Africa North |
| Live endpoints before recovery | Web `/` 200; API `/health` 200; API `/ready` 503 fail-closed on operational schema incompatibility |
| Database provenance | Operational database is the approved `legacy_shared` target at schema 15; the currently deployed API requires schema 17 |
| Focused migration tests | 10/10 passed, including fail-closed mode/URL gates and connection cleanup |
| Monorepo lint | 10/10 packages passed |
| Monorepo build | 10/10 packages passed |
| Monorepo tests | 13/13 tasks passed; API 267 passed + 1 expected skip; web 116/116 |
| Workflow YAML | Parsed successfully |
| Bicep build | `infra/main.bicep` compiled successfully |
| Authenticated ARM validation | `Succeeded`; correlation `849e5df6-01db-4e92-afc5-037eedf9d089` |
| Structured ARM what-if | `Succeeded`; existing drift detected, so no infrastructure template deployment is in scope |
| Live managed identities | API and web identities resolved; existing Key Vault, blob, queue, and worker roles match the application boundaries |
| GitHub release boundary | OIDC settings present; immutable exact-SHA and independent platform-admin approval gates remain unchanged |

The recovery migration may advance only schema 15 to schema 17 while the old
API is deployed. Schema 18 remains reserved for the subsequently approved exact
`main` release. No application data, approval record, role assignment, or
deployment authorization may be fabricated or bypassed.

## Ensemble 2.1.1 governed production release

Prepared: 2026-07-28

## Objective

Release `claimguard-claim-fraud-ensemble:2.1.1` for prospective ClaimGuard
traffic through an audited, fail-closed transition. The service scales from
zero and runs only when requests arrive. Existing scheme-owned model choices
remain selectable and old outbox jobs retain their originally pinned model.

## Immutable release evidence

| Property | Required value |
|---|---|
| Deployment | `claimguard-claim-fraud-ensemble:2.1.1` |
| Accepted artifact SHA-256 | `644bbefaf14ac13c7eeb69965d6d53d29d150b632ec485b4bf9fd47297773d62` |
| Governed candidate image | `claimguardacr11e.azurecr.io/claimguard/ensemble2-prospective-model-service@sha256:423a6f88b8fb28580c47950676714237f72b73f7273acbad21806afd06c8fd1a` |
| Telemetry-hardened release image | `claimguardacr11e.azurecr.io/claimguard/ensemble2-prospective-model-service@sha256:0a4b771e8453b6f891e35b5a2921c2c840325ffd29bf773aa7989f5ef4241b2c` |
| Threshold | `0.049236234887246655` |
| Feature schema | `claim-feature-schema-2026.2` |
| Analysis mode | `PROSPECTIVE_CLAIM_SCREENING` |
| Automatic adverse action | `false` |
| Test gate | Accepted 9/9; test set remains sealed |
| Canary | `ENSEMBLE_2_1_1_CANARY_PASSED` |

The image change is part of activation evidence: the model artifact is
unchanged, while the serving wrapper contains the approved telemetry hardening.
The catalogue transition must verify both image digests.

## Guarded changes

1. Deploy `claimguard-ml-ensemble-211` with the existing prospective-model
   identity, exact release digest, EasyAuth, the exact report-worker caller,
   and scale `0–2`.
2. Configure both worker jobs to understand the baseline and Ensemble 2.1.1.
   Keep the baseline as the worker primary so already-pinned baseline jobs
   remain valid.
3. Stage immutable release evidence in the API while keeping API selection on
   baseline.
4. A platform administrator activates the exact candidate through
   `POST /admin/platform/model-deployments/:deploymentId/activate`. One
   transaction locks the candidate, verifies evidence, retires only prior
   ClaimGuard-managed active catalogue rows, activates 2.1.1, and writes the
   platform audit.
5. An exact-SHA finalizer records the audit event ID, selects 2.1.1 for future
   ClaimGuard-managed ingestion, verifies API health, and stops.

The final API allow-list is:

`claimguard-claim-fraud-baseline:1.0.0,claimguard-claim-fraud-ensemble:2.1.1`

The final managed deployment is:

`claimguard-claim-fraud-ensemble:2.1.1`

## Invariants and stop conditions

- Azure subscription, directory tenant, resource group, and region must match
  exactly.
- `claimguard-report-producer` remains `Event`, min `0`, max `1`, with
  `worker event`.
- `claimguard-report-recovery` remains `Schedule`, exactly `0 0 1 1 *`, with
  `worker drain-all` and zero lifetime executions.
- No workflow starts a worker job or requires the normal scoring queue to be
  empty.
- No claims, outbox rows, routes, tenant strategies, or historical detection
  results are edited.
- The baseline model app remains deployed for jobs already pinned to baseline
  and for rollback.
- No scheme-owned deployment is retired or modified.
- Ubuntu is a test medical scheme, not a hard-coded release target; tenant
  routing is outside this platform release.
- Stop without retry on any unexpected identity, model digest, job trigger,
  recovery schedule/execution, API selector, tenant, route, or deployment
  state.

## Validation checks

- [x] Core validation
  - [x] Azure CLI installed and authenticated
  - [x] Exact subscription, directory tenant, resource group, and location
  - [x] Bicep compilation
  - [x] Authenticated ARM group validation
  - [x] Structured ARM what-if
- [x] Repository boundary lint and regression tests
- [x] Monorepo lint
- [x] Monorepo build
- [x] Monorepo tests, including forced concurrent web tests
- [x] Workflow YAML parse
- [x] Static and live least-privilege role verification
- [x] Azure Policy assignment review
- [x] Read-only production-state preflight

## Validation proof

Validated on 2026-07-28:

| Check | Result |
|---|---|
| Deployment boundary validator | Pass; 19/19 boundary tests |
| Focused API/database tests | Pass; 19/19 |
| Focused platform-admin UI tests | Pass; 5/5 |
| Monorepo lint | 9/9 packages |
| Monorepo build | 9/9 packages |
| Monorepo tests | 12/12 tasks; API 155 passed + 1 expected skip; web 63/63 |
| Workflow YAML | Four changed workflows parsed successfully |
| Bicep build | Both templates compiled; no errors |
| Production model ARM validation | `Succeeded` |
| Production model what-if | 2 creates, 22 ignores, 0 deletes, 0 replacements |
| Worker ARM validation | `Succeeded` |
| Worker what-if | Expected deployment of event job, recovery job, and existing queue declaration; 0 deletes/replacements |
| Model identity | `bd2ee6f4-166b-494e-9e53-96c2e9a27c00`; exactly one ACR Pull assignment on `claimguardacr11e` |
| Worker identity | `7d7b986b-2984-4aba-925c-9a009ee56c67`; exactly one queue-scoped Storage Queue Data Contributor assignment |
| Azure Policy | Subscription region-restriction policy enforced; ARM validation accepted South Africa North |
| Production preflight | Baseline API selectors exact; event 0–1; recovery schedule exact; recovery executions 0; release app absent |
| Cold-start verifier regression | 35/35 focused infrastructure and boundary tests; first-request timeout retry covered |
| Follow-up workflow YAML | Stage, finalizer, and infrastructure-validation workflows parsed successfully |
| Follow-up Bicep build | Ensemble production template compiled without errors; infrastructure is unchanged |
| Follow-up monorepo lint/build/tests | Lint 9/9; build 9/9; tests 12/12 (API 155 pass + 1 expected skip; web 63/63) |

The existing model identity performs only an ACR image pull in this template.
The worker retains its existing secret-, blob-, and queue-scoped roles; no RBAC
mutation is part of this release.

## Staging incident and retry gate

Guarded staging run
[`30439634510`](https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/30439634510)
deployed the exact release resource, then stopped because its one-shot readiness
request received no bytes within 30 seconds. Azure system logs show the immutable
image pull began at `2026-07-29T09:27:50Z`, the container started at
`09:28:03Z`, and application startup completed at `09:28:08Z`. A subsequent
readiness request returned `ready` with deployment ID
`claimguard-claim-fraud-ensemble:2.1.1`.

Read-only post-stop verification confirmed:

- provisioning `Succeeded`, exact release digest, scale `0–2`;
- the sole model identity is `claimguard-prospective-model-identity`;
- internal caller restriction remains the exact report-worker principal;
- event scoring remains `0–1` with baseline primary;
- recovery remains parked at `0 0 1 1 *` with zero lifetime executions;
- API selectors remain on the baseline.

The follow-up verifier uses individually bounded 10-second requests, a bounded
five-minute warm-up window, and a five-second retry interval. Success requires
both HTTP 200 and the exact `ready` state and deployment ID. It has no Azure or
GitHub mutation commands. No staging retry, catalogue activation, repository
selector change, or worker execution was performed after the stop.

## Rollout and rollback

The stage and finalization workflows require exact main SHAs and confirmation
phrases. Catalogue activation is a separate authenticated platform-admin
operation and returns its audit event ID. Finalization is forbidden until that
ID is supplied and the repository variables already preserve the intended
post-release selectors.

Before runtime finalization, rollback is to leave API selection on baseline and
stop; the scale-to-zero 2.1.1 app may remain staged. After finalization, rollback
requires a separately approved audited release transition. Historical jobs are
never repinned.

## Approval

The user explicitly approved Release 2.1.1 and authorised the required code,
merge, and production workflow operations. This plan does not authorise claim
creation, a manual worker batch, historical outbox mutation, route changes, or
unparking the recovery worker.
