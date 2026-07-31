# ClaimGuard Report Producer

[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)

Durable worker for publishing detection reports from authoritative tenant snapshots, with integrated prospective model scoring via an external ML ensemble.

## Responsibilities

- Outbox-driven trigger handling (manual / scheduled / event)
- Tenant-scoped database snapshot loading with full schema validation
- Detection invocation (delegates to `claimguard-detection-engine`)
- Prospective claim screening through an external model service (ML ensemble)
- Report publishing (versioned artifacts + latest pointer + metadata)
- Retry handling, bounded batching, and telemetry hooks

## Quick Start

```bash
uv sync
CONTROL_PLANE_MYSQL_URL='mysql://...' \
MYSQL_URL='mysql://...' \
REPORT_WORKER_ORGANISATION_ID='organisation-id' \
INTERNAL_SERVICE_ORGANISATION_IDS='organisation-id' \
uv run claimguard-produce-report worker once --backend file --output-dir reports
```

## Worker Modes

The worker leases claim-ingestion outbox jobs and always analyzes a fresh tenant-scoped database snapshot. It has no filesystem or generated-claims ingestion mode. Before leasing, it resolves the organisation's one active control-plane route:

- **`legacy_shared`** — uses `MYSQL_URL` and requires a verified legacy tenant mapping.
- **`private_database`** — resolves the route's username, password, host, and database Key Vault references with managed identity; it never logs or persists the assembled connection URL.

Both paths verify the database's singleton data-plane metadata and fail closed on an inactive organisation, unsupported schema, changed route generation, changed credentials, or mismatched logical database identity.

| Command | Description |
|---------|-------------|
| `worker once` | Process a single outbox batch and exit |
| `worker drain` | Process bounded batches until the queue is empty, then exit. `REPORT_WORKER_MAX_BATCHES_PER_RUN` defaults to `100`. |
| `worker drain-all` | Production scheduled mode. Discovers active, schema-compatible, worker-ready medical aids and drains each route independently. |

## Modules

### Core Worker

| Module | Description |
|--------|-------------|
| `cli.py` | CLI entry point (`claimguard-produce-report`) |
| `worker.py` | Durable worker loop, outbox lease, route resolution, and batch orchestration |
| `outbox.py` | Transactional outbox management and job lifecycle |
| `sources.py` | Tenant-scoped data source resolution and connection management |
| `snapshot.py` | Authoritative tenant snapshot loading with schema validation |
| `contract.py` | Report contract definitions and versioning |
| `publisher.py` | Report publishing to file or Azure Blob Storage |
| `data_plane.py` | Data-plane route resolution and connection validation |
| `event_queue.py` | Event-driven trigger queue |

### Detection Results

| Module | Description |
|--------|-------------|
| `detection_results.py` | Structured detection result processing and report assembly |

### Prospective Model Scoring

| Module | Description |
|--------|-------------|
| `model_service.py` | External ML model service client (claim screening request/response, ensemble integration) |
| `model_report.py` | Model-enriched report generation with scoring results |
| `model_registry.py` | Model deployment and detection-strategy registry |
| `prospective_model_service.py` | Prospective screening orchestration |
| `ordered_prospective_model_service.py` | Ordered prospective screening with deterministic sequencing |
| `prospective_worker.py` | Prospective worker loop |
| `prospective_report.py` | Prospective report assembly |
| `prospective_results.py` | Prospective result aggregation |
| `prospective_snapshot.py` | Prospective scoring snapshot construction |

## Azure-Ready Mode

Use backend `azure_blob` with:

| Variable | Description |
|----------|-------------|
| `REPORT_STORAGE_ACCOUNT_URL` | Azure Storage account URL |
| `REPORT_STORAGE_CONTAINER` | Blob container name |
| `AZURE_STORAGE_CONNECTION_STRING` | Optional — for local development only |

Managed identity is used automatically when no connection string is set.

## Deployment Automation

Deployment is handled by the GitHub Actions workflow `.github/workflows/report-worker-deploy.yml`.

This workflow:

- Builds and pushes the producer image to Azure Container Registry
- Creates or updates a native five-minute Azure Container Apps scheduled job
- Verifies a worker execution before considering deployment successful
- Resolves `CONTROL_PLANE_MYSQL_URL` and `MYSQL_URL` through Key Vault references
- Uses a dedicated managed identity for ACR pull, Key Vault read, and report-blob write access
- Discovers the control plane's active, worker-ready medical-aid routes and drains them independently

### Required Azure Bootstrap

| Resource | Role |
|----------|------|
| User-assigned identity: `claimguard-report-worker-identity` | — |
| `claimguardacr11e` | `AcrPull` |
| API control-plane and operational database secrets | `Key Vault Secrets User` |
| Per `private_database` route (4 secrets each) | `Key Vault Secrets User` |
| `claimguard-reports` container in `cgrpt0715sa` | `Storage Blob Data Contributor` |

The provisioning controller assigns the exact four per-tenant secret roles when onboarding or upgrading a medical aid. Its `Key Vault Data Access Administrator` role is constrained by Azure's built-in ABAC condition to Key Vault data roles; the report worker itself never receives vault-wide secret access.

Database and storage credentials must not be copied into GitHub secrets.
