# ClaimGuard Control-Plane Database

This package owns the control-plane schema, migration history, repositories, authentication/session service, identity management, model deployments, release governance, provisioning, security, and diagnostics.

Clerk is authoritative for workforce authentication, verified email, MFA, recovery, and external session state. This package remains authoritative for internal organisations, users, memberships, roles, permissions, identity bindings, opaque desktop sessions, and audit history. Operational claims data and database routing remain owned by `@claimguard/database`.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `CONTROL_PLANE_MYSQL_URL` | Yes | Connection URL for the control-plane database. Never inferred from `MYSQL_URL`. |
| `CONTROL_PLANE_SHADOW_ENABLED` | No | Defaults to `false`. Must be exactly `true` for inventory `--apply`. |
| `MYSQL_URL` | Conditional | Read only by the legacy-tenant inventory command as the current operational source. |
| `CLAIMGUARD_APP_VERSION` | No | Optional migration-history application version. |
| `AUTHENTICATION_MODE` | Yes | Runtime authority mode: exactly `clerk`; `session` is accepted only under `NODE_ENV=test`. |

The control-plane database may be a separate database on the same local MySQL server, but must have a distinct URL and database name.

## Commands

```bash
pnpm --filter @claimguard/control-plane-database migrate
pnpm --filter @claimguard/control-plane-database status
pnpm --filter @claimguard/control-plane-database diagnose
pnpm --filter @claimguard/control-plane-database inventory -- --dry-run
CONTROL_PLANE_SHADOW_ENABLED=true \
  pnpm --filter @claimguard/control-plane-database inventory -- --apply --deployment-class demo
```

Inventory never modifies operational tenant rows. Apply mode writes only unambiguous shadow organisations and mappings to the control plane.

## Modules

| Module | Description |
|--------|-------------|
| `authentication-repository.js` | Clerk identity resolution and opaque internal/desktop session records; legacy password records are test compatibility only |
| `authentication-service.js` | External-identity resolution, current-authority validation, and opaque session lifecycle |
| `identity-repository.js` | Users, roles, and organisation membership |
| `organisations-repository.js` | Organisation CRUD and lifecycle |
| `routes-repository.js` | Data-plane route management |
| `legacy-mapping-repository.js` | Legacy tenant ↔ organisation mapping |
| `provisioning-repository.js` | Automated provisioning workflow state |
| `model-deployment-repository.js` | ML model deployment tracking and strategy management |
| `release-governance-repository.js` | Release staging, finalization, and rollback |
| `integration-credentials-repository.js` | Machine-to-machine API credential lifecycle |
| `security-repository.js` | Security audit and compliance records |
| `configuration-repository.js` | Platform configuration key-value store |
| `control-plane-service.js` | Unified service layer for control-plane operations |
| `credential-guarded-control-plane-service.js` | Credential-guarded wrapper enforcing integration-credential boundaries |
| `role-required-control-plane-service.js` | Role-enforcing wrapper for the control-plane service |
| `route-aware-authentication-repository.js` | Authentication with data-plane route awareness |
| `development-platform-admin-bootstrap.js` | Local development bootstrap for platform admin accounts |
| `diagnostics.js` | Control-plane health checks |
| `migrate.js` | Schema migration runner |
| `projections.js` | Read-model projections for API consumers |
| `validation.js` | Input validation and constraint checking |

## Authority Boundary

Clerk authenticates the person and active Clerk organisation. This package resolves the immutable Clerk subject and organisation mapping to an active internal user, membership, role set, and current authorization version. Operational request admission then separately resolves authoritative `data_plane_routes` metadata.

At runtime, exactly one active `data_plane_routes` record is resolved for the authenticated immutable organisation ID before operational access. Non-production provisioning creates active `legacy_shared` routes and links verified mappings; the platform organisation receives `platform_none`. Database credentials remain outside route projections and control-plane responses.

## Prohibited Data

The control plane must not contain claims, members, providers, diagnoses, prescriptions, investigation notes, evidence bodies, private fraud reasons, report bodies, plaintext passwords, raw session tokens, raw connection strings, or database secret values.
