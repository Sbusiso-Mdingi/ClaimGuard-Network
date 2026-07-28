# Ensemble 2.1.1 isolated Azure canary deployment plan

> **Status:** Canary passed — candidate remains inactive and unrouted
>
> **Scope:** Azure for Students (`896d3c72-d979-4bdc-a37f-060988d12032`),
> resource group `ClaimGuard`, South Africa North.

Prepared: 2026-07-28

## 1. Objective

Deploy `claimguard-claim-fraud-ensemble:2.1.1` as a separate, digest-pinned
Container App for controlled health, authentication, and scoring-contract
validation.

This canary is a platform model-release check. It is not specific to Ubuntu or
any other medical scheme. No scheme route, strategy, claim, outbox job, report,
or persisted detection result participates in this validation.

## 2. Explicit exclusions

This plan does not authorise:

- replacing or updating `claimguard-ml-prospective`;
- replacing or updating `claimguard-ml-inference`;
- changing API model allow-list or managed-model settings;
- changing the model catalogue lifecycle state;
- activating the candidate for ClaimGuard or any scheme;
- changing an organisation's active detection strategy;
- creating or processing real claims;
- editing historical outbox jobs or detection results;
- starting `claimguard-report-producer`;
- changing the report-worker trigger or schedule;
- directing production traffic to the canary;
- merging, pushing, or running a production deployment workflow.

Any later production release, scheme strategy change, claim smoke, or worker
batch requires separate explicit approval.

## 3. Immutable candidate identity

| Property | Required value |
|---|---|
| Deployment ID | `claimguard-claim-fraud-ensemble:2.1.1` |
| Model ID | `claimguard-claim-fraud-ensemble` |
| Model version | `2.1.1` |
| Lifecycle before and after this canary | `candidate` |
| Source repository | `Sbusiso-Mdingi/ClaimGuard-Scenario-Lab` |
| Source commit | `09ab85e20ab1ce7122f157fa1b045cc0f8a3424b` |
| Accepted artifact SHA-256 | `644bbefaf14ac13c7eeb69965d6d53d29d150b632ec485b4bf9fd47297773d62` |
| Decision threshold | `0.049236234887246655` |
| Feature schema | `claim-feature-schema-2026.2` |
| Analysis mode | `PROSPECTIVE_CLAIM_SCREENING` |
| Image | `claimguardacr11e.azurecr.io/claimguard/ensemble2-prospective-model-service@sha256:423a6f88b8fb28580c47950676714237f72b73f7273acbad21806afd06c8fd1a` |
| Automatic adverse action | `false` |
| Deterministic fallback | disabled |

The accepted image workflow:

1. downloaded GitHub artifact `8677487075`;
2. verified archive SHA-256
   `7ef69514059712c2d41bdba246be0b6e91efae607f86875089af7a9901d2b00c`;
3. loaded and verified the release bundle;
4. asserted the accepted artifact SHA, deployment ID, 51 predictors, and
   threshold;
5. built the dedicated Ensemble 2.1.1 Dockerfile;
6. passed readiness, OpenAPI, and synthetic scoring checks;
7. pushed the image tagged with the exact source commit;
8. recorded the immutable ACR digest without deploying or activating it.

## 4. Verified production baseline

Verified read-only on 2026-07-28:

| Control | Current state | Canary invariant |
|---|---|---|
| Azure subscription | `896d3c72-d979-4bdc-a37f-060988d12032` | Must match exactly |
| Azure directory tenant | `8efc1bb9-b90f-4a48-bf6c-ba0686193b80` | Must match exactly |
| Resource group | `ClaimGuard` | Must match exactly |
| Container Apps environment | `claimguard-env-11e` | Reuse; do not modify |
| Registry | `claimguardacr11e` | Exact digest pull only |
| Baseline model app | `claimguard-ml-prospective` | No changes |
| Baseline deployment | `claimguard-claim-fraud-baseline:1.0.0` | No changes |
| API approved IDs | baseline `1.0.0` only | No changes |
| API managed model | baseline `1.0.0` | No changes |
| Worker | `claimguard-report-producer` | No changes or execution |
| Worker trigger | `Event`; no schedule configuration | Must remain parked |
| Active worker executions | `0` | Must remain `0` |
| Candidate catalogue row | `candidate`, no validation/activation timestamp | Must remain unchanged |

The Ubuntu application tenant ID
`b5dcdcb0-ba34-4de1-bea0-d14a178ab68e` is intentionally absent from this
platform-level canary. Tenant routing is out of scope.

## 5. Isolated canary design

Create only these new resources:

| Resource | Name | Configuration |
|---|---|---|
| User-assigned identity | `claimguard-ensemble-211-canary-identity` | `AcrPull` on `claimguardacr11e` only |
| Container App | `claimguard-ensemble-211-canary` | Separate app, single revision, exact digest, port 8000 |
| Container App auth config | `current` child of the canary | Existing model audience, HTTPS, unauthenticated scoring rejected |

The Container App must use:

- `claimguard-env-11e`;
- `minReplicas: 0`;
- `maxReplicas: 1`;
- external HTTPS ingress only so EasyAuth is exercised;
- no traffic association with either production model app;
- `/health/live` and `/health/ready` as the only auth-excluded paths;
- `CLAIMGUARD_MODEL_AUTH_MODE=entra_proxy`;
- `CLAIMGUARD_MODEL_DEPLOYMENT_ID=claimguard-claim-fraud-ensemble:2.1.1`;
- `CLAIMGUARD_BASELINE_PATH=/opt/claimguard/model`;
- the canary identity's own principal ID as
  `CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID`.

Using the canary identity as its own caller allows an in-container probe to
obtain a real managed-identity token and traverse the public EasyAuth endpoint.
It avoids Azure CLI user-consent changes and does not grant the production
worker access to an unvalidated candidate.

The auth config may reuse the existing single-tenant model-service application:

- client ID `58019e2d-cfd0-4bdf-b757-bc96876f2f25`;
- audience `api://58019e2d-cfd0-4bdf-b757-bc96876f2f25`;
- issuer
  `https://login.microsoftonline.com/8efc1bb9-b90f-4a48-bf6c-ba0686193b80/v2.0`.

EasyAuth validates the issuer and audience. The model service then enforces the
exact canary identity through `CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID`, matching
the live baseline's proven separation of authentication and workload
authorization.

The existing authentication secret must be passed as a secure deployment
parameter directly from the current model app. It must never be printed,
written to the repository, persisted in a temporary file, or included in
deployment output.

## 6. Repository artifacts to create after approval

Implementation must use small, reviewable, checked-in artifacts:

- `infra/ensemble2-canary.bicep`
  - creates only the dedicated identity, exact `AcrPull` assignment, canary
    Container App, and canary auth child resource;
  - parameterises the immutable image and auth secret;
  - emits the canary identity principal ID and HTTPS origin;
  - contains no API, worker, database, route, or catalogue resources.
- `infra/ensemble2-canary-auth.bicep`
  - updates only the existing canary's `authConfigs/current` child resource;
  - is used for isolated auth-policy corrections without redeploying the
    Container App, identity, or role assignment.
- `tools/verify-ensemble2-canary.mjs`
  - asserts subscription, resource group, resource names, image digest,
    identity, scale, ingress, probes, and auth policy;
  - verifies public health responses;
  - verifies unauthenticated `/v3/claim-screening` returns `401`;
  - executes a bounded in-container managed-identity self-probe;
  - sends one synthetic, non-scheme, non-persisted claim-screening request;
  - verifies deployment ID, model ID/version, schema, analysis mode, one-to-one
    score coverage, finite probability, threshold, and no fallback;
  - re-runs `tools/verify-production-model-candidate.mjs` after the probe.

The synthetic request must use identifiers explicitly prefixed `canary-` and
must not be sent through ClaimGuard ingestion.

## 7. Validation and deployment sequence

Execution stops immediately if any assertion differs.

1. Re-run the production candidate verifier.
2. Confirm no canary resource already exists.
3. Add the two checked-in canary artifacts and their unit/static tests.
4. Run repository lint, targeted tests, Bicep lint, and Bicep build.
5. Run `az deployment group validate`.
6. Run a structured `az deployment group what-if`.
7. Inspect the what-if and require:
   - exactly the new canary identity;
   - exactly one ACR-scoped `AcrPull` assignment;
   - exactly the new canary app and auth config;
   - no delete, replace, or modification of existing resources.
8. Re-confirm worker trigger, absent schedule, and zero active executions.
9. Deploy the validated Bicep with the immutable digest.
10. Wait for `provisioningState=Succeeded` and a ready revision.
11. Run the checked-in canary verifier exactly once.
12. Re-run the production candidate verifier.
13. Confirm API settings, candidate lifecycle, production model apps, worker
    configuration, worker execution count, and tenant state are unchanged.
14. Stop. Do not activate, reroute, create claims, or run a worker batch.

## 8. Required canary evidence

The canary passes only if all checks are true:

| Check | Required result |
|---|---|
| Image reference | Exact approved ACR digest |
| Runtime deployment ID | `claimguard-claim-fraud-ensemble:2.1.1` |
| Ready response | HTTP 200 and model version `2.1.1` |
| Unauthenticated scoring | HTTP 401 |
| Authenticated scoring | HTTP 200 through EasyAuth and managed identity |
| Response schema | `claimguard.claim-screening-response.v3` |
| Feature schema | `claim-feature-schema-2026.2` |
| Analysis mode | `PROSPECTIVE_CLAIM_SCREENING` |
| Threshold | `0.049236234887246655` |
| Score coverage | Exactly one result for the one synthetic target |
| Probability | Finite and within `[0, 1]` |
| Deterministic fallback | `false` |
| Production API model selection | Baseline `1.0.0`, unchanged |
| Candidate lifecycle | `candidate`, timestamps unchanged |
| Worker | Event-triggered, no schedule, zero new executions |
| Existing model apps | Names, images, ingress, and traffic unchanged |
| Tenant/data plane | No operation performed |

### Pre-deployment validation proof

| Check | Result | Timestamp |
|---|---|---|
| Canary verifier unit tests | 5 passed, 0 failed | 2026-07-28 |
| JavaScript syntax | Pass | 2026-07-28 |
| ClaimGuard workspace lint | 9 packages passed | 2026-07-28 |
| Bicep lint and build | Pass with Bicep `0.45.15.27210` | 2026-07-28 |
| ARM group validation | `Succeeded`; no error | 2026-07-28 |
| ARM structured what-if | 4 creates, 20 ignores, 0 modifies, 0 replaces, 0 deletes | 2026-07-28 |
| Candidate/runtime/worker preflight | Pass; candidate inactive, baseline selected, worker parked, 0 active executions | 2026-07-28 |

### Post-deployment evidence

| Check | Result | Timestamp |
|---|---|---|
| ARM deployment | `Succeeded`; deployment `ensemble2-211-isolated-canary-20260728` | 2026-07-28 07:35 UTC |
| Canary revision | `claimguard-ensemble-211-canary--6tdmftc`; provisioning succeeded | 2026-07-28 |
| Canary image | Exact approved digest | 2026-07-28 |
| Scale | `minReplicas=0`, `maxReplicas=1` | 2026-07-28 |
| Readiness | Passed exact deployment, model, schema, analysis-mode, and no-fallback assertions | 2026-07-28 |
| Unauthenticated scoring | Correctly denied with HTTP 401 | 2026-07-28 |
| Initial authenticated probe attempts | No scoring request reached the model before the final approved attempt | 2026-07-28 |
| Verifier 401 correction | Approved and fixed; 7 regression tests pass | 2026-07-28 |
| Azure exec attempt | Automatic WebSocket targeting returned HTTP 404 before container command execution | 2026-07-28 |
| Revision and replica | Healthy, one ready replica, both `model-service` and `http-auth` ready, zero restarts | 2026-07-28 |
| Exec transport correction | Exact target selection, pseudo-terminal allocation, connection wait, and 2 KB chunk streaming; 10 regression tests pass | 2026-07-28 |
| Identity diagnostic | Managed-identity bearer token acquired; `oid` equals the exact canary principal; artifact 2.1.1 with 51 predictors loaded | 2026-07-28 |
| Auth root cause | Redundant EasyAuth `defaultAuthorizationPolicy` returned HTTP 500 before FastAPI | 2026-07-28 |
| Auth-only correction | Deployment `ensemble2-211-canary-auth-only-fix-20260728` succeeded; only `authConfigs/current` changed | 2026-07-28 08:16 UTC |
| Authenticated OpenAPI | HTTP 200 with `/v3/claim-screening` POST present | 2026-07-28 |
| Final unauthenticated scoring check | HTTP 401 | 2026-07-28 |
| Final authenticated synthetic scoring | HTTP 200; one result; probability `0.004750630311078858`; threshold `0.049236234887246655` | 2026-07-28 |
| Final verifier state | `ENSEMBLE_2_1_1_CANARY_PASSED` | 2026-07-28 |
| Console observability | Direct console tail did not expose the structured score event; harden score-event telemetry before production activation | 2026-07-28 |
| Production invariant recheck | Pass; baseline selected, candidate inactive, worker event-triggered with no schedule and 0 active executions | 2026-07-28 |

No further canary request is authorised or required. Production activation,
catalogue validation, API allow-list changes, worker changes, scheme strategy
changes, and real claim processing remain outside this completed plan.

## 9. Failure and rollback

Before deployment, any validation or what-if mismatch stops with no Azure write.

After deployment, a failed probe must:

1. collect only non-sensitive revision state and logs;
2. make no catalogue, API, worker, scheme, claim, or database change;
3. leave `minReplicas` at `0` so the isolated canary scales down;
4. stop for a new decision.

The canary will not be deleted automatically because deletion is destructive.
Removal or repair requires explicit approval after the failure evidence is
reviewed.

## 10. Approval checkpoint

Approval of this plan authorises only:

- creation of the two repository artifacts in section 6;
- validation and what-if;
- creation of the isolated canary resources in section 5;
- one bounded synthetic canary verification;
- read-only post-verification.

It does not authorise production activation or any excluded action in section 2.
