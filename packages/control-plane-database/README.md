# ClaimGuard control-plane database

This package owns the control-plane schema, migration history, repositories, authentication/session service, inventory, diagnostics, and demo provisioning. Phase 11C makes its identity and session records authoritative only when the API is explicitly started with `AUTHENTICATION_MODE=session`. Operational claims data and database routing remain owned by `@claimguard/database`.

## Configuration

- `CONTROL_PLANE_MYSQL_URL`: required by control-plane database commands. It is never inferred from `MYSQL_URL`.
- `CONTROL_PLANE_SHADOW_ENABLED`: defaults to `false`. It must be exactly `true` for inventory `--apply`.
- `MYSQL_URL`: read only by the legacy-tenant inventory command as the current operational source.
- `CLAIMGUARD_APP_VERSION`: optional migration-history application version.
- `AUTHENTICATION_MODE`: API authority mode; exactly `session` or `demo_headers`.

The control-plane database may be a separate database on the same local MySQL server, but must have a distinct URL and database name.

## Commands

```bash
pnpm --filter @claimguard/control-plane-database migrate
pnpm --filter @claimguard/control-plane-database status
pnpm --filter @claimguard/control-plane-database diagnose
pnpm --filter @claimguard/control-plane-database inventory -- --dry-run
CONTROL_PLANE_SHADOW_ENABLED=true \
  pnpm --filter @claimguard/control-plane-database inventory -- --apply --deployment-class demo
DEPLOYMENT_CLASS=demo \
  pnpm --filter @claimguard/control-plane-database provision-demo -- \
  --confirm=PROVISION_DEMO_ACCOUNTS
```

Inventory never modifies operational tenant rows. Apply mode writes only unambiguous shadow organisations and mappings to the control plane.

Demo provisioning reads current tenants without modifying them, creates verified control-plane mappings, hashes generated credentials with Argon2id, and prints generated passwords once to the invoking terminal. Supply approved ephemeral display credentials separately through `DEMO_CREDENTIALS_JSON`; they are never recovered from the database.

## Phase 11C authority boundary

Session mode authenticates local passwords and server-side sessions through this package. `demo_headers` is an isolated rollback/development mode and is refused in production. The modes cannot be combined. Authentication itself bridges an authenticated medical-scheme organisation only through a verified `legacy_tenant_mappings` record; operational request admission then separately resolves authoritative `data_plane_routes` metadata.

Phase 11D runtime additionally resolves exactly one active `data_plane_routes` record for the authenticated immutable organisation ID before operational access. Non-production provisioning creates active `legacy_shared` routes at schema version 13 and links verified mappings; the platform organisation receives `platform_none`. Database credentials remain outside route projections and control-plane responses.

## Prohibited data

The control plane must not contain claims, members, providers, diagnoses, prescriptions, investigation notes, evidence bodies, private fraud reasons, report bodies, plaintext passwords, raw session tokens, raw connection strings, or database secret values.
