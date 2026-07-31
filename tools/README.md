# ClaimGuard Tools

Utility scripts for operating, verifying, and testing the ClaimGuard Network in production and development environments.

## Desktop Simulator (`simulate_medical_aids.py`)

Simulates multiple South African medical aid schemes submitting claims to the ClaimGuard API. Designed to run on a separate machine (e.g. an old desktop) that acts as the claims server for demonstration purposes.

### Quick Start

```bash
# 1. Set bearer tokens (created via Platform Admin → Integration Credentials)
export CLAIMGUARD_BONITAS_TOKEN="eyJ..."
export CLAIMGUARD_DISCOVERY_TOKEN="eyJ..."
export CLAIMGUARD_GEMS_TOKEN="eyJ..."

# 2. Set the HMAC key for POPIA-compliant PII tokenization
export CLAIMGUARD_SCHEME_KEY="your-scheme-secret-key"

# 3. Run a single batch for all schemes
python simulate_medical_aids.py \
    --api-url https://claimguard-api.example.com \
    --scheme all

# 4. Or run continuously (batch every 30s)
python simulate_medical_aids.py \
    --api-url https://claimguard-api.example.com \
    --scheme all \
    --continuous --interval 30

# 5. Dry-run (preview without calling the API)
python simulate_medical_aids.py \
    --api-url https://example.com \
    --scheme bonitas \
    --dry-run
```

### Included Medical Aids

| Scheme | Env Variable | Members | Providers |
|--------|-------------|---------|-----------|
| Bonitas | `CLAIMGUARD_BONITAS_TOKEN` | 4 | 3 |
| Discovery Health | `CLAIMGUARD_DISCOVERY_TOKEN` | 3 | 2 |
| GEMS | `CLAIMGUARD_GEMS_TOKEN` | 2 | 1 |

---

## Production Verification & Operations

### Guarded Prospective-Production Verification (`prospective-production-verification.mjs`)

Fail-closed, scheme-neutral production operator. Pins the expected Azure subscription, private-route type, schema, approved model deployment, and parked worker cron. The target organisation, canonical slug, scheme ID, and synthetic claim prefix are explicit command-line inputs.

Resolve the target through the control plane first:

```bash
node tools/prospective-production-verification.mjs resolve \
  --organisation-id <organisation-uuid> \
  --model-deployment-id <name:version>
```

Run each later phase separately and inspect its JSON result before continuing:

```bash
node tools/prospective-production-verification.mjs <phase> \
  --organisation-id <organisation-uuid> \
  --organisation-slug <exact-canonical-slug> \
  --scheme-id <scheme-id> \
  --claim-prefix <2-to-5-uppercase-characters> \
  --model-deployment-id <name:version>
```

`<phase>` is one of `audit`, `inspect`, `activate`, `ingest`, `verify-job`, `start-worker`, `recover-worker`, `worker-status`, or `verify-results`.

The read-only `audit` phase additionally requires `--expected-current-model-deployment-id`. It returns strategy history, outbox counts grouped by pinned deployment, and organisation-scoped control-plane audit metadata without returning secrets or claim payloads.

The `activate` phase requires both `--expected-current-strategy-id` and `--expected-current-model-deployment-id`. The repository locks the active row and rejects the transition if either expectation is stale.

The ingestion phase creates exactly three fresh claims through the production API using an audited, one-hour integration credential that is revoked immediately after the request. The worker phase submits an execution-only template for the existing Container Apps Job with:

- the explicitly selected organisation as the only route
- the same organisation as the internal-service identity allowlist
- `worker once`
- `REPORT_WORKER_BATCH_SIZE=1`
- `REPORT_WORKER_MAX_BATCHES_PER_RUN=1`

`recover-worker` is a narrow exception for an execution that failed before leasing its exact job because the single-route service-identity allowlist was missing.

---

### Deployment Boundary Validation (`validate-deployment-boundaries.mjs`)

Validates architectural deployment boundaries across the monorepo. Runs automatically as part of `pnpm lint` to enforce separation between apps, services, and packages.

```bash
node tools/validate-deployment-boundaries.mjs
```

---

### Credential History Audit (`audit-credential-history.mjs`)

Audits integration credential lifecycle history for compliance. Runs as a workspace-level command:

```bash
pnpm audit:credential-history
# or directly:
node tools/audit-credential-history.mjs --fail-on-findings
```

---

## Ensemble & Model Verification

### Ensemble Canary Verification (`verify-ensemble2-canary.mjs`)

Verifies ensemble v2 canary deployments by running structured validation against the canary endpoint. Includes test coverage in `verify-ensemble2-canary.test.mjs`.

```bash
node tools/verify-ensemble2-canary.mjs
```

---

### Production Model Candidate Verification (`verify-production-model-candidate.mjs`)

Validates a model candidate before it is approved for production activation. Checks deployment configuration, endpoint readiness, and contract compatibility.

```bash
node tools/verify-production-model-candidate.mjs \
  --deployment-id <name:version>
```

---

### Production Model Activation Verification (`verify-production-model-activation.mjs`)

Verifies that a model activation completed correctly by checking the active strategy, deployment state, and worker readiness.

```bash
node tools/verify-production-model-activation.mjs \
  --deployment-id <name:version>
```

---

## Diagnostics

### Investigation Queue Diagnostics (`diagnose-investigation-queue.mjs`)

Diagnoses the investigation queue state, identifying stuck items, stale locks, or processing anomalies.

```bash
node tools/diagnose-investigation-queue.mjs
```

---

### Container Apps Canary Diagnostic (`containerapp-canary-diagnostic.py`)

Python diagnostic script for Azure Container Apps canary deployments. Used alongside `containerapp-canary-exec.exp` (Expect script for interactive canary execution).

```bash
python tools/containerapp-canary-diagnostic.py
```

---

## Release & Packaging

### Release Manifest (`create-release-manifest.mjs`)

Creates a structured release manifest for versioned deployments.

```bash
node tools/create-release-manifest.mjs
```

---

### Package Release Artifacts (`package-release-artifacts.sh`)

Shell script that packages release artifacts for distribution.

```bash
bash tools/package-release-artifacts.sh
```

---

## Scheme Simulator (`tools/scheme-simulator/`)

Subdirectory containing the scheme simulation framework for end-to-end testing scenarios.

---

## Privacy Compliance (POPIA / GDPR / HIPAA)

All PII in the simulator and SDK is tokenized **locally** using HMAC-SHA256 before leaving the desktop. No raw names, ID numbers, or banking details are transmitted.

| Field | Transformation |
|-------|---------------|
| Names | `HMAC(name, key, "NAME")` |
| ID numbers | `HMAC(id, key, "ID")` |
| Banking details | `HMAC(bank, key, "BANK")` |
| Practice numbers | `HMAC(pcns, key, "PCNS")` |
| Date of birth | Minimized to `YYYY-01-01` |
| GPS coordinates | Rounded to 1 decimal (~11 km) |
