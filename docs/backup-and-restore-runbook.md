# ClaimGuard Backup and Restore Runbook

## Backup Inventory

| Asset | Backup / protection expectation | Current evidence |
| --- | --- | --- |
| MySQL Flexible Server | automated backups with retention | retention is configured in Azure, but restore has not been exercised here |
| Storage account | versioning / soft delete where applicable | needs explicit confirmation in next pass |
| Key Vault | soft delete and purge protection | soft delete is enabled; purge protection state should be verified operationally |
| Control-plane state | database backup and migration discipline | code exists; restore exercise pending |
| Deployment artifacts | retained CI artifacts | CI retains deployable zips for 14 days |

## Targets

- Demo RPO/RTO: short, operator-managed, and tolerant of reset.
- Staging RPO/RTO: bounded enough for release qualification.
- Production RPO/RTO: only after later qualification evidence.

## Restore Procedure

1. Identify the restore target and point-in-time.
2. Restore into an isolated environment first.
3. Validate schema and control-plane metadata.
4. Run tenant-isolation checks against the restored data.
5. Confirm report pointer and storage access.
6. Only then consider promotion or replacement.

## Rollback Procedure

- Roll back application deployment independently from secret rotation.
- Keep the previous secret or key version valid until the new path is proven.
- Reconfirm health endpoints after rollback.

## Non-Destructive Restore Test Plan

- Restore a non-production copy.
- Verify read-only access, route ownership, and report retrieval.
- Confirm no cross-tenant contamination.
- Record results as evidence for the later qualification plan.
