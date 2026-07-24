# Phase 11D data-plane routing operations

Phase 11D makes control-plane route metadata authoritative for operational database access. Phase 11E extends that foundation by supporting provisioned `private_database` routes alongside the existing `legacy_shared` route.

The current canonical operational schema is **schema 14**, represented by migrations `0001` through `0014`. Both route types must expose metadata compatible with schema and migration version 14 before a connection pool is made available to API or worker code.

## Runtime routing flow

Session authentication resolves an immutable organisation ID and its current authority before any private operational route is accessed.

For each admitted operational request, the API:

1. Loads the organisation from the control plane.
2. Requires the organisation to be `active` and `activated`.
3. Requires exactly one active data-plane route.
4. Validates the route type, generation, provisioning status, health status, and supported schema version.
5. Resolves the operational tenant identity.
6. Acquires a pool keyed by immutable route identity.
7. Verifies the target database’s `data_plane_metadata`.
8. Constructs request-scoped repositories pinned to the verified operational tenant.

Route metadata follows a zero-staleness admission policy. New private requests recheck the current organisation and route state rather than relying on a long-lived route cache.

A control-plane outage, missing route, unsupported schema, suspended route, or incompatible database therefore blocks new operational requests. Existing in-flight work may finish while a retired pool drains, but no new request may enter that pool.

Public liveness and authentication endpoints do not require private data-plane resolution.

## Supported route types

The runtime recognises three route types:

- `legacy_shared`
- `private_database`
- `platform_none`

### `legacy_shared`

A `legacy_shared` route uses the existing shared operational MySQL database.

It requires:

- an active medical-scheme organisation;
- exactly one active route;
- logical database identifier `legacy-operational-shared`;
- schema version `14`;
- a positive, monotonically increasing route generation;
- provisioning status `active`;
- a health status other than `suspended` or `unreachable`;
- a verified legacy tenant mapping linked to the active route;
- operational metadata identifying the database as `legacy_shared`;
- migration version `14`;
- the configured legacy environment, normally `legacy`.

The verified legacy mapping provides the operational tenant ID and slug used by tenant-scoped repositories.

`MYSQL_URL` is consumed only by the explicit `legacy_shared` adapter. It is not a fallback used when route resolution fails.

### `private_database`

A `private_database` route uses a separately provisioned operational database for one medical-scheme organisation.

It requires:

- an active medical-scheme organisation;
- exactly one active private route;
- logical database identifier `private:<organisationId>`;
- schema version `14`;
- migration version `14`;
- a positive route generation;
- provisioning status `active`;
- a health status other than `suspended` or `unreachable`;
- operational metadata identifying the database as `private_database`;
- the configured private environment, normally `production`;
- exactly four Key Vault secret references for:
  - username;
  - password;
  - host;
  - database name.

The organisation ID is also the operational tenant ID in its private database. A legacy tenant mapping is not required.

The private adapter resolves route secrets through Azure managed identity, constructs the MySQL connection, and verifies that database metadata matches the active route before publishing the pool.

Provisioning initially registers a private route as `ready` and inactive. It does not become available for request admission until an explicit activation operation marks the route active.

### `platform_none`

The platform organisation uses `platform_none`.

A platform organisation:

- has no operational tenant;
- cannot use `legacy_shared` or `private_database`;
- cannot receive private medical-data access through its platform role;
- does not require a legacy mapping.

Medical-scheme organisations cannot use `platform_none`.

## API configuration

The API session runtime uses:

```text
AUTHENTICATION_MODE=session

CONTROL_PLANE_MYSQL_URL=mysql://.../claimguard_control
MYSQL_URL=mysql://.../claimguard_operational

DATA_PLANE_ENVIRONMENT=legacy
DATA_PLANE_PRIVATE_ENVIRONMENT=production
DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS=14

DATA_PLANE_MAX_POOLS=32
DATA_PLANE_POOL_CONNECTION_LIMIT=5
DATA_PLANE_POOL_IDLE_MS=600000
DATA_PLANE_POOL_CREATION_TIMEOUT_MS=10000
DATA_PLANE_POOL_DRAIN_TIMEOUT_MS=10000
```

`CONTROL_PLANE_MYSQL_URL` and `MYSQL_URL` must identify different databases.

The API supports both `legacy_shared` and `private_database` adapters in session mode. Route resolution determines which adapter is used; callers cannot select a database or route through request headers, hostnames, slugs, or payload fields.

The API’s supported schema allowlist is controlled by `DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS` and currently defaults to `14`.

## Database compatibility verification

A pool is not published until `data_plane_metadata` is verified.

For `legacy_shared`, verification includes:

- database mode;
- logical database identifier;
- schema version;
- migration version;
- environment.

For `private_database`, verification includes:

- database mode `private_database`;
- logical database identifier matching the route;
- schema version matching the route;
- migration version derived from that schema version;
- configured private environment.

Schema metadata must describe the database that actually exists. Merely changing the metadata marker without applying migrations is not considered compatible.

## Schema-14 prospective claim processing

Migration `0014_prospective_claim_detection.sql` establishes prospective-only claim scoring.

Its principal invariants are:

1. Existing claims become immutable baseline version 1 records.
2. Existing baseline claims are not retrospectively enqueued for scoring.
3. A newly submitted claim creates immutable claim version 1.
4. A materially changed claim creates the next immutable claim version.
5. An identical retry creates neither a false amendment nor another processing job.
6. Each scoring job targets exact `claim_id` and `claim_version` pairs.
7. The active detection strategy is pinned when ingestion commits.
8. Detection results are immutable for the targeted claim version and strategy.
9. Legacy retrospective `report_production` work is not processed by the prospective worker.

Every tenant must have exactly one valid active detection strategy:

- `deterministic_rules`; or
- `approved_model` with an approved immutable deployment identifier.

Claim ingestion, immutable version creation, the current-version pointer, strategy selection, and outbox enqueueing commit in one transaction.

The outbox payload does not contain mutable full claim objects. It contains exact target references and the strategy identity needed to reproduce the prospective decision.

## Report-worker routing

The scheduled report producer uses control-plane routing and supports both:

- `legacy_shared`;
- `private_database`.

It accepts only schema 14 by default.

The worker discovers eligible organisations, resolves each route independently, verifies its operational metadata, and creates a tenant-pinned processing scope. A job payload cannot expand that scope or redirect processing to another tenant.

For private routes, the worker resolves the same four Key Vault-backed database values used by the API:

- username;
- password;
- host;
- database name.

The report worker uses a user-assigned managed identity. Secret access is granted at the individual secret level during private-database provisioning.

The scheduled Container Apps Job currently runs every five minutes with one replica and drains bounded outbox batches. Retry limits and lease durations are configured through environment variables.

Relevant worker configuration includes:

```text
CONTROL_PLANE_MYSQL_URL=...
MYSQL_URL=...

DATA_PLANE_ENVIRONMENT=legacy
DATA_PLANE_PRIVATE_ENVIRONMENT=production
DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS=14

REPORT_WORKER_BATCH_SIZE=10
REPORT_WORKER_MAX_BATCHES_PER_RUN=100
REPORT_WORKER_LEASE_SECONDS=300
REPORT_WORKER_MAX_ATTEMPTS=5
REPORT_WORKER_RETRY_INITIAL_SECONDS=30
REPORT_WORKER_RETRY_MAX_SECONDS=900
```

## Private-database provisioning

Private onboarding is performed by the provisioning worker, not by the API request path.

The provisioning workflow:

1. Validates the organisation and approved Azure policy.
2. Allocates a deterministic organisation-safe database name.
3. Creates the database.
4. Creates a least-privilege runtime MySQL principal.
5. Stores database connection values as separate secrets.
6. Applies all canonical operational migrations through `0014`.
7. Converts migration bootstrap tenant foundations into the organisation-scoped private tenant.
8. Writes private `data_plane_metadata`.
9. Verifies that the runtime principal has no cross-database access.
10. Creates the report-storage partition.
11. Registers worker routing.
12. Registers a schema-14 private route as `ready` and inactive.
13. Grants the report worker access to the four route secrets.
14. Records schema compatibility.
15. Confirms that a scheme administrator exists.
16. Runs activation checks.
17. Marks the organisation `ready_for_activation`.

The generated MySQL runtime principal receives only:

```text
SELECT, INSERT, UPDATE, DELETE
```

on its own database. It does not receive server-wide, schema-management, or cross-database privileges.

Provisioning steps are resumable. Completed steps are not replayed unnecessarily, and persisted credentials are reused during a safe retry.

An explicit activation operation is required after provisioning succeeds. Provisioning alone must not make the private route active.

## Administrative migrations

Operational migrations are deliberately outside browser and session routing.

Shared operational migrations require explicit administration mode:

```bash
OPERATIONAL_ADMIN_MODE=legacy_shared \
MYSQL_URL=mysql://... \
pnpm --filter @claimguard/database exec node src/migrate.js
```

Control-plane migrations use:

```bash
CONTROL_PLANE_MYSQL_URL=mysql://... \
pnpm --filter @claimguard/control-plane-database migrate
```

Apply all operational migrations through `0014` before allowing schema-14 routes to become active.

Do not:

- change the checksum of an already applied migration;
- derive a private database name directly at request time;
- manually mark a database compatible without applying migrations;
- store database credentials in control-plane route rows;
- treat `MYSQL_URL` as a fallback for a failed private route;
- activate a private route before provisioning and isolation checks complete.

## Health and diagnostics

The API exposes safe public readiness information.

Authenticated `/internal/data-plane/health` diagnostics may expose compatibility and pool state, but must omit:

- route secret references;
- database passwords;
- connection strings;
- resolved hosts and usernames;
- private claim data.

Operational requests fail closed when:

- the organisation is inactive;
- no active route exists;
- multiple active routes exist;
- the route is retired or unavailable;
- the route type is incompatible with the organisation;
- the schema is unsupported;
- legacy mapping verification fails;
- private secrets cannot be resolved;
- database metadata differs from route metadata;
- pool creation or verification times out.

## Pool invalidation and route rotation

Pool cache identity includes:

```text
organisationId:routeId:routeGeneration
```

A new route generation produces a distinct pool identity.

Organisation- and route-specific invalidation supports:

- suspension;
- route retirement;
- credential rotation;
- schema remediation;
- health remediation;
- route promotion.

An invalidation for one organisation must not evict another organisation’s pool.

Old pools close only after active requests drain or the configured drain timeout expires.

## CI and deployment gate

The CI workflow runs a dedicated MySQL 8.4 integration job against isolated databases.

The real-MySQL gate verifies:

1. control-plane migrations and constraints;
2. operational schema-14 migrations and prospective-scoring foundations;
3. Phase 11D routed API tenant isolation and prospective claim-version behaviour;
4. Phase 11E private-database provisioning, retry safety, and database isolation.

Production deployment depends on both:

- the normal validation job;
- the real-MySQL integration job.

A push to `main` cannot enter the deployment job unless both gates pass.

The deployment migration step retrieves control-plane and operational database URLs from Key Vault, applies both migration sets, and uses `OPERATIONAL_ADMIN_MODE=legacy_shared` for the shared operational database.

## Rollback

Non-production rollback may use:

```text
AUTHENTICATION_MODE=demo_headers
```

That mode uses the isolated deprecated global-pool compatibility path.

Production refuses the demo-header authentication mode.

Do not mix routed session instances and rollback instances behind the same load balancer. Do not use rollback mode as a substitute for repairing an incompatible route, database, mapping, or schema.
