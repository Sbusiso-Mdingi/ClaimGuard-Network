# ClaimGuard Environment Matrix

ClaimGuard uses explicit environment separation so that synthetic and real medical-scheme data never share operational routes, identities, credentials, queues, storage, telemetry, or backups.

The application code, versioned schema migrations, approved model catalogue, and approved reference/configuration records move toward production. Synthetic claim history does not.

## Environment Definitions

| Environment | Purpose | Data classification | Claim source | Reset policy | Approval |
|---|---|---|---|---|---|
| Development | Developer inner loop | Generated fixtures only | Local authenticated producer | Disposable | None |
| Automated test | CI validation | Bounded synthetic fixtures | Test harness through production-shaped contracts | Disposable | Pipeline gates |
| Staging | Integration, model, migration, and release qualification | Synthetic or explicitly approved scrubbed data | Ubuntu and other synthetic schemes | Controlled reset | Release owner |
| Production | Real medical-scheme operation | Real scheme data only | Approved scheme integrations | No reset | Formal go-live approval |
| Production canary | Non-destructive verification inside production infrastructure | Synthetic-only internal data | Dedicated internal canary producer | Controlled synthetic reset | Operations/change approval |

## Current Azure Classification

The current Azure environment is classified as **staging**, notwithstanding any historical resource names or `NODE_ENV=production` runtime setting. It must not become the authoritative production medical-scheme environment by relabelling or by replacing a connection string.

Ubuntu and all existing synthetic schemes remain staging tenants unless an explicitly isolated production-canary tenant is separately provisioned.

## Required Environment Separation

Each environment has separate:

- MySQL server and databases;
- control-plane database;
- Service Bus namespace and queues;
- Container App and App Service managed identities;
- Key Vault and secrets;
- storage accounts, containers, reports, and latest pointers;
- telemetry and Application Insights destinations;
- API ingestion credentials;
- backups and restore targets;
- DNS endpoints or deployment environment;
- CI/CD approvals and deployment identities.

The staging scorer is technically incapable of accessing production queues, databases, storage, or secrets. Production workloads are likewise incapable of accessing staging tenant routes.

A separate production database combined with a shared staging queue is not an acceptable boundary because jobs could still cross environments.

## Environment Matrix

| Dimension | Development | Test | Staging | Production | Production canary |
|---|---|---|---|---|---|
| Data | Generated | Synthetic fixtures | Synthetic/scrubbed approved | Real schemes only | Synthetic-only internal |
| Control plane | Local | Ephemeral | Staging control plane | Production control plane | Production control plane with canary classification |
| Tenant database | Local/disposable | Ephemeral | Staging tenant routes | Clean production routes | Isolated canary database route |
| Queue | Local emulator or dev | Ephemeral | Staging queues | Production queues | Isolated canary queue |
| Storage | Local | Ephemeral | Staging storage | Production storage | Isolated canary prefix/account |
| Identity | Developer | CI | Staging managed identities | Production managed identities | Dedicated canary producer identity |
| Secrets | Local secret store | CI secret store | Staging Key Vault | Production Key Vault | Canary-scoped production secrets |
| Telemetry | Local console | CI logs | Staging destination | Production destination | Production destination with canary classification |
| Claim effects | None | None | None | Scheme-controlled only | None |
| External network notices | Disabled | Disabled | Synthetic testing only | Approved participants only | Disabled |
| Reset | Allowed | Allowed | Controlled | Prohibited | Controlled synthetic reset |

## Production Seed Boundary

Production may be seeded only with approved non-transactional records:

- database schema and migrations;
- ICD-10, tariff, and other approved reference data;
- provider-type definitions;
- model catalogue entries;
- default roles and permissions;
- approved production configuration.

Production must not receive:

- Ubuntu claims, members, or providers;
- existing outbox jobs;
- detection results or investigation cases;
- synthetic provider identities;
- staging audit records;
- staging API credentials;
- database dumps containing development or staging rows.

An explicit idempotent seed operation inserts only approved reference/configuration records. Production is never initialised from a staging database dump.

## Dynamic Tenant Routing

The control plane maintains an environment-aware route for each tenant:

```text
tenant_id
environment
operational_database_route
queue_route
storage_route
active_strategy_id
status
```

Every incoming identity resolves to exactly one tenant and one environment-specific route. The API, worker, and administrative operations fail closed when:

- the authenticated tenant does not match the route tenant;
- the authenticated environment does not match the route environment;
- a database, queue, storage, or model strategy belongs to another environment;
- the route is inactive, incomplete, or ambiguous.

Ubuntu is never embedded in deployment, migration, or seed scripts. A new scheme is onboarded through an audited control-plane operation without application code changes.

For real schemes, the platform supports a dedicated database per scheme and, where independently approved, a rigorously isolated shared production data plane for smaller schemes. Database-per-scheme is preferred for sensitive or higher-risk deployments.

## Production Canary

The production canary uses a tenant similar to:

```text
tenant: claimguard-internal-canary
classification: synthetic-only
database route: isolated
queue route: isolated
storage route: isolated
reports/export/billing: disabled
external sharing: disabled
```

The canary verifies authentication, routing, ingestion, outbox processing, scoring, report publication, and audit events without contaminating a real scheme's route.

Ubuntu remains a staging tenant unless there is a specific migration decision to replace it with a separately provisioned canary. Existing Ubuntu data is never copied into production.

## Promotion Rule

Promote:

- code;
- schema migrations;
- approved model definitions;
- approved reference data;
- approved configuration.

Do not promote:

- synthetic claims or identities;
- transactional rows;
- outbox or dead-letter work;
- reports and scoring outputs;
- investigation records;
- audit histories;
- environment credentials or secrets.

The complete go-live, rollback, backup, and retention rules are documented in `production-data-boundary.md`.