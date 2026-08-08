# ClaimGuard Network

[![CI](https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/workflows/ci.yml/badge.svg)](https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/Sbusiso-Mdingi/ClaimGuard-Network/graph/badge.svg)](https://codecov.io/gh/Sbusiso-Mdingi/ClaimGuard-Network)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-orange)](https://pnpm.io/)

**Author:** [Sbusiso Mdingi](https://github.com/Sbusiso-Mdingi)

> **Naming note:** ClaimGuard is an internal project name, not a cleared commercial trademark.
>
> **Maturity note:** This repository describes a production-shaped prototype. It is not evidence of regulatory approval, a live medical-scheme integration, or production readiness.

ClaimGuard is a privacy-preserving claims-risk, investigation, and cross-scheme intelligence platform for South African medical schemes. It identifies suspicious claims, explains the signals to authorised scheme personnel, and supports the scheme's own investigation process.

ClaimGuard does **not** determine guilt, stop payments, reject claims, impose recoveries, or instruct another scheme to take adverse action. A scheme decides whether to investigate, its authorised investigators conduct the investigation, and an authorised human decision-maker records the outcome. Where an eligible substantiated outcome is shared, other schemes receive a bounded investigative lead and remain responsible for their own assessment and decisions.

The platform uses an append-only, tamper-evident history while allowing active network notices to be corrected, withdrawn, appealed, superseded, and expired. It does not maintain a permanent, uncorrectable blacklist.

See:

- [`ClaimGuard_Technical_Spec.md`](ClaimGuard_Technical_Spec.md) for the product and governance model;
- [`docs/production-data-boundary.md`](docs/production-data-boundary.md) for environment separation and safe go-live rules;
- [`docs/environment-matrix.md`](docs/environment-matrix.md) for the approved environment structure;
- [`docs/versioned-assessment-context.md`](docs/versioned-assessment-context.md) for immutable reference versions, assessment provenance, correction review, and signal supersession;
- [`docs/production-readiness-qualification-plan.md`](docs/production-readiness-qualification-plan.md) for the evidence required before live use.

---

## Repository Map

This is a [pnpm workspace](https://pnpm.io/workspaces) monorepo orchestrated by [Turborepo](https://turbo.build/).

### Applications (`apps/`)

| Package | Language | Description |
|---|---|---|
| `@claimguard/api` | JavaScript | Authenticated claim-ingestion boundary, report/detection consumer, investigation workflow, and platform administration API |
| `@claimguard/web` | React / JSX | Investigator, scheme-admin, and platform-admin UI |
| `@claimguard/provisioning-worker` | JavaScript | Azure Container Apps Job for audited organisation and route provisioning |
| `apps/simulator-worker` | — | Build-only stub for simulation work |

### Packages (`packages/`)

| Package | Language | Description |
|---|---|---|
| `@claimguard/database` | JavaScript | Claims, outbox, investigations, human decision workflow, audit events, and tenant routing |
| `@claimguard/control-plane-database` | JavaScript | Organisations, authentication, route governance, model deployments, releases, and diagnostics |
| `@claimguard/shared-schema` | JavaScript | Shared validation schemas |
| `@claimguard/claimguard-sdk` | Python | Edge pseudonymisation and authenticated ingestion |

### Services (`services/`)

| Package | Language | Description |
|---|---|---|
| `claimguard-report-producer` | Python | Durable scoring/report orchestration from authoritative tenant snapshots |
| `claimguard-detection-engine` | Python | Tenant-scoped entity extraction, relationship graphs, rules, and deterministic risk scoring |

### Tooling and infrastructure

- `tools/` contains verification, deployment, canary, diagnostics, and simulation scripts.
- `infra/` contains Azure Bicep and deployment support.
- `docs/` contains architecture, privacy, security, operations, and qualification records.

---

## Architecture Overview

```text
Medical-aid system
      |
      v
Edge SDK: pseudonymise + authenticate
      |
      v
POST /claims/ingest
      |
      v
Tenant-routed operational database + transactional outbox
      |
      v
Report producer -> detection engine -> versioned report storage
      |
      v
Scheme analyst triage -> scheme investigation -> authorised human outcome
      |
      v
Optional bounded network notice, subject to approved sharing governance
```

A model or rule result is a risk signal only. It has no direct payment, recovery, sanction, or contracting effect.

---

## Environment Boundary

### Development

- Local resources and generated claims.
- Disposable identities and databases.
- No real patient or scheme data.

### Staging

- The current Azure environment and synthetic schemes, including Ubuntu.
- Synthetic claims, model tests, migration rehearsals, and release qualification.

### Production

- Separate databases, queues, identities, secrets, storage, telemetry, ingestion credentials, backups, and endpoints.
- Real medical schemes only.
- Empty operational stores plus approved schema, model catalogue, reference data, roles, and configuration.
- Never initialised from a staging database dump.

### Production canary

- An isolated internal synthetic-only tenant.
- Separate database, queue, storage, identity, and credential route.
- No external sharing, exports, billing, or scheme data.
- Used only for non-destructive production verification.

Code, schema migrations, approved models, and approved reference/configuration data move toward production. Synthetic claims, members, providers, outbox jobs, reports, staging audit records, and credentials do not.

---

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Python services use `uv`:

```bash
uv sync
uv run pytest tests
```

---

## Runtime Data Flow

ClaimGuard does not generate runtime claims inside the platform. Medical-aid systems and approved test producers submit bounded tenant-scoped batches. The API commits reference records, claims, and an outbox job atomically. The report worker reloads the authoritative tenant snapshot before scoring.

Every authenticated identity resolves to one tenant and one environment-specific database, queue, storage, and strategy route. The API, workers, and administration operations fail closed if the authenticated tenant or environment disagrees with the resolved route.

Ubuntu is a staging tenant and is not embedded in deployment, migration, or production seed logic.

---

## Human-Supervised Investigation Model

The target lifecycle is:

```text
SIGNAL_GENERATED
-> TRIAGE_PENDING
-> DISMISSED / MONITORING / INVESTIGATION_OPEN
-> NOTICE_RECORDED / RESPONSE_PENDING / EVIDENCE_REVIEW
-> INVESTIGATION_REPORT_COMPLETED
-> OUTCOME_REVIEW_PENDING
-> OUTCOME_APPROVED
-> NETWORK_NOTICE_ACTIVE (when authorised)
-> CORRECTED / WITHDRAWN / APPEAL_OR_REVIEW / EXPIRED_OR_SUPERSEDED
```

The investigation report does not automatically activate a network notice. A separate authorised decision and sharing approval are required. Active notices can be corrected or removed while the append-only historical event remains auditable.

---

## Production Readiness

The repository is production-shaped, not production-ready. Live medical-scheme use requires, among other things:

- legal and POPIA assessment;
- responsible-party/operator allocation and agreements;
- prior-authorisation analysis where applicable;
- independent security and cryptographic review;
- penetration test and remediation;
- backup restoration and disaster-recovery exercises;
- access review;
- model validation, reproducibility, fairness, and drift controls;
- incident-response exercise;
- retention and deletion tests;
- a silent-mode single-scheme pilot;
- scheme governance approval and appropriate regulator engagement.

No repository test, cloud deployment, or model result alone establishes production readiness.
