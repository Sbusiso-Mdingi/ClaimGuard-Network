# ClaimGuard control-plane database

This package owns the Phase 11B control-plane schema, migration history, repositories, shadow inventory, and diagnostics. It is deliberately separate from `@claimguard/database`, which remains the authoritative operational database package.

## Configuration

- `CONTROL_PLANE_MYSQL_URL`: required by control-plane database commands. It is never inferred from `MYSQL_URL`.
- `CONTROL_PLANE_SHADOW_ENABLED`: defaults to `false`. It must be exactly `true` for inventory `--apply`.
- `MYSQL_URL`: read only by the legacy-tenant inventory command as the current operational source.
- `CLAIMGUARD_APP_VERSION`: optional migration-history application version.

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

## Non-authoritative status

Phase 11B does not connect this package to active API authentication or operational routing. It issues no sessions, verifies no passwords, and does not replace demo headers. Missing control-plane configuration cannot block current application requests.

## Prohibited data

The control plane must not contain claims, members, providers, diagnoses, prescriptions, investigation notes, evidence bodies, private fraud reasons, report bodies, plaintext passwords, raw session tokens, raw connection strings, or database secret values.
