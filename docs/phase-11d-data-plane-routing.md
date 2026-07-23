# Phase 11D data-plane routing operations

Phase 11D makes control-plane route metadata authoritative for operational access while every medical-scheme organisation still uses the existing physical shared database. It does not provision or activate `private_database` routes.

## Runtime flow

Session authentication resolves an immutable organisation ID. Private route prefixes then perform a fresh control-plane organisation and active-route read, validate the verified legacy mapping, create an immutable `DataPlaneContext`, acquire a route-generation-specific pool, verify `data_plane_metadata`, and construct explicit operational repositories pinned to the mapped tenant. Tenant-column predicates remain mandatory defense in depth.

Route metadata has a zero-staleness policy for request admission: every private request rechecks current organisation and route state. A control-plane failure therefore blocks new private requests. Existing in-flight operations may finish on a retiring pool, but new requests cannot enter it. Public liveness and authentication endpoints do not resolve routes.

## Configuration

```text
AUTHENTICATION_MODE=session
CONTROL_PLANE_MYSQL_URL=mysql://.../claimguard_control
MYSQL_URL=mysql://.../claimguard_operational
DATA_PLANE_ENVIRONMENT=legacy
DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS=10
DATA_PLANE_MAX_POOLS=32
DATA_PLANE_POOL_CONNECTION_LIMIT=5
DATA_PLANE_POOL_IDLE_MS=600000
DATA_PLANE_POOL_CREATION_TIMEOUT_MS=10000
DATA_PLANE_POOL_DRAIN_TIMEOUT_MS=10000
```

`MYSQL_URL` is consumed only by the explicit `legacy_shared` adapter in session runtime. It is not a fallback route. The operational database must contain all migrations through `0010_production_ingestion.sql`; its singleton marker must match route type, logical database identity, schema version, migration version, and environment before a pool is published.

The API exposes only safe public readiness fields. Authenticated `/internal/data-plane/health` diagnostics include compatibility and pool state but omit route IDs, generations, database names, hosts, usernames, and secrets.

## Route preparation

Every active medical-scheme organisation needs exactly one active `legacy_shared` route with:

- logical database identifier `legacy-operational-shared`;
- schema version `13`;
- monotonically increasing route generation;
- a verified legacy mapping linked to that route;
- provisioning status `active` and a non-suspended health state.

The platform organisation needs one active `platform_none` route and no legacy mapping. Demo provisioning creates or validates these records. `private_database` routes remain unsupported for request admission.

## Workers

The original Phase 11D worker mode requires exactly one `REPORT_WORKER_ORGANISATION_ID`. The production scheduled job now discovers active, worker-ready organisations and creates one independently verified worker scope for each route. Job payload tenant values still cannot expand a resolved scope or reuse another organisation's routed connection.

Internal API service authentication additionally requires `INTERNAL_SERVICE_ORGANISATION_IDS`; caller-supplied organisation scope must be in that server configuration.

## Administrative commands

Operational migrations are deliberately outside browser/session routing. They require explicit shared-administration mode:

```bash
OPERATIONAL_ADMIN_MODE=legacy_shared MYSQL_URL=mysql://... pnpm --filter @claimguard/database migrate
```

Apply all migrations through `0010` before enabling routed session runtime, then explicitly create or activate routes and link verified mappings. Never derive a database name from an organisation slug or hostname.

## Invalidation and rollback

Pool cache keys are `organisationId:routeId:routeGeneration`. A new generation retires only the old organisation pool; new requests use the new pool and the old pool closes after active requests drain. Explicit organisation and route invalidation hooks support suspension, retirement, credential rotation, and health remediation.

Non-production rollback remains `AUTHENTICATION_MODE=demo_headers`, which uses the isolated deprecated global-pool compatibility path. Production refuses that mode. Do not mix routed session instances with rollback instances behind one load balancer.
