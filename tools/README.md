# ClaimGuard Tools

Utility scripts for operating and testing the ClaimGuard Network.

## Desktop Simulator (`simulate_medical_aids.py`)

Simulates multiple South African medical aid schemes submitting claims to the
ClaimGuard API.  Designed to run on a separate machine (e.g. an old desktop)
that acts as the claims servers for demonstration purposes.

### Quick start

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

### Included medical aids

| Scheme | Env Variable | Members | Providers |
|--------|-------------|---------|-----------|
| Bonitas | `CLAIMGUARD_BONITAS_TOKEN` | 4 | 3 |
| Discovery Health | `CLAIMGUARD_DISCOVERY_TOKEN` | 3 | 2 |
| GEMS | `CLAIMGUARD_GEMS_TOKEN` | 2 | 1 |

## Guarded prospective-production verification

`prospective-production-verification.mjs` is a fail-closed, scheme-neutral
production operator. It pins the expected Azure subscription, private-route
type, schema, approved model deployment, and parked worker cron. The target
organisation, canonical slug, scheme ID, and synthetic claim prefix are
explicit command-line inputs. The expected model deployment is also explicit,
so the same guardrails can be reused for a later approved deployment.

Resolve the target through the control plane first. This read-only phase
returns the canonical slug that must be supplied to every later phase:

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

`<phase>` is one of `inspect`, `activate`, `ingest`, `verify-job`,
`start-worker`, `worker-status`, or `verify-results`.

The ingestion phase creates exactly three fresh claims through the production
API using an audited, one-hour integration credential that is revoked
immediately after the request. The worker phase submits an execution-only
template for the existing Container Apps Job with:

- the explicitly selected organisation as the only route;
- `worker once`;
- `REPORT_WORKER_BATCH_SIZE=1`;
- `REPORT_WORKER_MAX_BATCHES_PER_RUN=1`.

It does not update the recurring job definition, modify historical outbox
rows, or retry a second worker execution. Local run state contains only record
identifiers, is isolated by organisation and scheme, and is ignored by Git.

### Privacy compliance (POPIA / GDPR / HIPAA)

All PII is tokenized **locally** using HMAC-SHA256 before leaving the desktop.
No raw names, ID numbers, or banking details are transmitted.

- Names → `HMAC(name, key, "NAME")`
- ID numbers → `HMAC(id, key, "ID")`
- Banking details → `HMAC(bank, key, "BANK")`
- Practice numbers → `HMAC(pcns, key, "PCNS")`
- Date of birth → minimized to `YYYY-01-01`
- GPS coordinates → rounded to 1 decimal (~11 km)
