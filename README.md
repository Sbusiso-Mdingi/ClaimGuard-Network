# ClaimGuard Network

[![CI](https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/workflows/ci.yml/badge.svg)](https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/Sbusiso-Mdingi/ClaimGuard-Network/graph/badge.svg)](https://codecov.io/gh/Sbusiso-Mdingi/ClaimGuard-Network)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-orange)](https://pnpm.io/)

**Author:** [Sbusiso Mdingi](https://github.com/Sbusiso-Mdingi)

Tenant-isolated medical-claim ingestion, fraud detection, investigation, and reporting platform for South African medical schemes. ClaimGuard allows multiple schemes to contribute claims signals to a shared fraud-detection graph **without exposing raw member or provider PII to each other**.

---

## Repository Map

This is a [pnpm workspace](https://pnpm.io/workspaces) monorepo orchestrated by [Turborepo](https://turbo.build/).

### Applications (`apps/`)

| Package | Language | Description |
|---------|----------|-------------|
| `@claimguard/api` | JavaScript | Authenticated claim-ingestion boundary, detection/report consumer, and platform administration API (Hono + tRPC) |
| `@claimguard/web` | React / JSX | Investigator dashboard, scheme admin, and platform admin UI (React 19, React Router, Tailwind CSS) |
| `@claimguard/provisioning-worker` | JavaScript | Azure Container Apps Job for automated medical-aid provisioning and route promotion |
| `apps/simulator-worker` | — | Build-only stub for the simulator worker |

### Packages (`packages/`)

| Package | Language | Description |
|---------|----------|-------------|
| `@claimguard/database` | JavaScript | Operational data-plane: claim ingestion, outbox, investigations, fraud workflow, ledger, tenant connection management (Drizzle ORM + MySQL) |
| `@claimguard/control-plane-database` | JavaScript | Control-plane schema, migrations, authentication/session service, identity, model deployments, release governance, provisioning, and diagnostics |
| `@claimguard/shared-schema` | JavaScript | Shared Zod validation schemas consumed by the API and web app |
| `@claimguard/claimguard-sdk` | Python | POPIA-compliant edge SDK for local PII tokenization and authenticated claim ingestion |

### Services (`services/`)

| Package | Language | Description |
|---------|----------|-------------|
| `claimguard-report-producer` | Python | Durable worker for outbox-driven report production, prospective model scoring, and report publishing |
| `claimguard-detection-engine` | Python | Tenant-scoped fraud detection: entity extraction, relationship graph construction, modular rule engine, and deterministic risk scoring |

### Tooling (`tools/`)

Operator scripts for production verification, deployment validation, canary testing, diagnostics, and medical-aid simulation. See [`tools/README.md`](tools/README.md).

### Infrastructure (`infra/`)

Azure Bicep templates for the API, report worker, event-driven worker, recovery job, and ensemble canary infrastructure.

---

## Quick Start

```bash
# Install all workspace dependencies
pnpm install

# Build every package
pnpm build

# Run all tests (JavaScript + Python)
pnpm test

# Lint (includes deployment-boundary validation)
pnpm lint
```

Python services use [uv](https://docs.astral.sh/uv/) for dependency management. Inside each Python service or package:

```bash
uv sync
uv run pytest tests
```

---

## Architecture Overview

ClaimGuard follows a strict producer/consumer boundary:

```
Medical-Aid Server ──► Edge SDK (tokenize PII) ──► POST /claims/ingest
                                                          │
                                                    ┌─────▼──────┐
                                                    │   API       │
                                                    │  (Hono +    │
                                                    │   tRPC)     │
                                                    └──────┬──────┘
                                                           │ atomic commit
                                                    ┌──────▼──────┐
                                                    │  Operational │
                                                    │  Database    │
                                                    │  (MySQL)     │
                                                    └──────┬──────┘
                                                           │ outbox job
                                                    ┌──────▼──────┐
                                                    │   Report     │
                                                    │   Producer   │◄──► Model Service
                                                    │   (Worker)   │     (ML Ensemble)
                                                    └──────┬──────┘
                                                           │ invokes
                                                    ┌──────▼──────┐
                                                    │  Detection   │
                                                    │  Engine      │
                                                    └──────┬──────┘
                                                           │ publishes
                                                    ┌──────▼──────┐
                                                    │  Report      │
                                                    │  Storage     │
                                                    │  (Blob/File) │
                                                    └──────────────┘
```

- **`apps/api`** — authenticated claim-ingestion boundary and read-only report/detection consumer.
- **`apps/web`** — consumes API endpoints only; never accesses databases directly.
- **`services/report-producer`** — leases outbox jobs and orchestrates detection runs from authoritative tenant snapshots. Integrates with an external ML model service for prospective claim screening.
- **`services/detection-engine`** — stateless fraud analysis; produces structured detection reports with graph entities, relationships, rule hits, and risk scores.
- **`apps/provisioning-worker`** — automated provisioning of medical-aid organisations, database routes, and Key Vault RBAC.

---

## Runtime Data Flow

ClaimGuard does not generate runtime claims. Medical-aid systems and approved test producers submit tenant-scoped batches to `POST /claims/ingest`. The API commits reference records and claims atomically, writes an outbox job in the same transaction, and the report worker reloads the authoritative tenant snapshot before detection.

See `docs/claim-ingestion.md` for the request contract, machine-to-machine authentication, limits, and the desktop-producer handoff.

Platform administrators can create, provision, upgrade, and activate medical aids from the web interface. After activation, the same page issues a per-server credential and displays the bounded claim-sync instructions; routine onboarding does not require Azure Portal access.
The Windows host baseline is documented in `docs/desktop-producer-windows.md`.

---

## Report Producer Worker

```bash
cd services/report-producer
uv sync
CONTROL_PLANE_MYSQL_URL='mysql://...' \
MYSQL_URL='mysql://...' \
REPORT_WORKER_ORGANISATION_ID='organisation-id' \
INTERNAL_SERVICE_ORGANISATION_IDS='organisation-id' \
uv run claimguard-produce-report worker once --backend file --output-dir reports
```

For Azure mode, use backend `azure_blob` with storage configuration and managed identity.

---

## Web Application

The investigator dashboard is a React 19 SPA built with React Router, Tailwind CSS, and shadcn-style primitives. Authentication uses server-side sessions (session mode) or demo headers (development).

### Pages

| Page | Description |
|------|-------------|
| **Dashboard** | KPI overview and recent detections |
| **Claims Explorer** | Searchable, sortable, paginated claim table |
| **Claim Details** | Entity/relationship context and claim risk panel |
| **Network Graph** | Interactive zoom/pan/select graph view (React Flow) |
| **Risk Panel** | Severity, explainability, triggered rules, and evidence |
| **Detection History** | Timeline of captured detection snapshots |
| **Investigations** | Investigation case management and workflow |
| **Investigation Workspace** | Individual investigation detail with evidence and notes |
| **Committee Registry** | Fraud committee membership management |
| **Scheme Admin** | Scheme-level administration |
| **Platform Admin** | Platform-wide administration, lifecycle management, and release governance |

### Refresh Behaviour

- **Live Refresh** — polls claims and detection endpoints every 15 seconds.
- **Refresh Off** — freezes auto-refresh until re-enabled.
- **Refresh Now** — performs an immediate fetch in both modes.

---

## Infrastructure & CI

| Tool | Purpose |
|------|---------|
| **GitHub Actions** | CI (`ci.yml`), infrastructure validation, report-worker deploy, ensemble release staging/finalization, CodeQL |
| **Codecov** | Coverage gating at 70% target for both Python and JavaScript flags |
| **Azure Bicep** | Infrastructure-as-code for API, report worker, recovery job, and ensemble canary |
| **Sentry** | Error tracking with PII scrubbing (API and web) |
| **New Relic** | API performance tracing and APM |
| **Azure Key Vault** | Secrets management via managed identity |

---

## Documentation Index

### Architecture & Design

- `docs/azure-production-architecture.md`
- `docs/production-shaped-architecture.md`
- `docs/architecture-migration-blueprint.md`
- `docs/claim-ingestion.md`

### Operations

- `docs/operations-runbook.md`
- `docs/backup-and-restore-runbook.md`
- `docs/environment-matrix.md`
- `docs/desktop-producer-windows.md`

### Security & Access Control

- `docs/secrets-and-configuration.md`
- `docs/access-control-matrix.md`
- `docs/threat-model.md`
- `docs/risk-register.md`
- `docs/incident-response-plan.md`

### Observability

- `docs/observability-dashboards.md`
- `docs/observability-and-credential-rotation.md`
- `docs/alert-definitions.md`

### Authentication & Routing

- `docs/phase-11c-authentication.md`
- `docs/phase-11d-data-plane-routing.md`
- `docs/phase11e-provisioner-rbac.md`

### Production Readiness

- `docs/phase-12-production-shaped-hardening.md`
- `docs/production-readiness-qualification-plan.md`

### CI

- `docs/CI.md`

---

## Runbook

For production operations and incident checks, see `docs/operations-runbook.md`.
