# Phase 12 Production-Shaped Hardening Foundation

This phase establishes ClaimGuard as production-shaped while explicitly stopping short of any formal production-ready claim.

## What This Phase Does

- documents the current live Azure and repository inventory;
- separates production-shaped controls from formal readiness gates;
- records the current secret/config surface and governance model;
- defines the environment matrix and ownership boundaries;
- captures the current access-control, threat, risk, incident, and backup baseline;
- publishes the future production-readiness qualification plan.

## What This Phase Does Not Do

- it does not begin Scenario Lab implementation;
- it does not generate or reseed claims;
- it does not migrate tenant data;
- it does not begin Phase 11F cutover;
- it does not claim production readiness;
- it does not delete or overwrite Azure resources or databases;
- it does not expose secrets;
- it does not change live production access controls without a tested rollback path.

## Required Follow-On Work

1. Normalize secret delivery from live App Service settings into a governed path.
2. Complete explicit Azure RBAC review for identities and runtime access.
3. Add or verify live tests for tenant isolation, auth, rate limits, and secret redaction.
4. Complete the backup, restore, and DR qualification exercises.
5. Complete the formal production-readiness gates in the qualification plan.

## Phase 12A Execution Reconciliation

Validated outcomes from the narrow Phase 12A run:

- Documentation tranche and workflow alignment were pushed to main (`1e9968e`, `47fd1f7`).
- `MYSQL_URL` and `CONTROL_PLANE_MYSQL_URL` were migrated from plaintext app settings to Key Vault references on `claimguard-api`.
- Key Vault secrets were updated and enabled:
	- `claimguard--api--mysql-url` version `c605b82ca3c7497c8eebaa3c0d740177`
	- `claimguard--api--control-plane-mysql-url` version `9b592b1aa42842fdab1e6ac09fa478ef`
- Temporary operator write elevation at vault scope (`Key Vault Secrets Officer`) was removed after migration.
- Runtime read path remained least-privilege for API: `Key Vault Secrets User` at vault scope for API managed identity principal `fd83880b-4452-4bda-9a27-5142b49172fc`.
- Web app remained without managed identity principal and therefore without Key Vault runtime access.
- Post-restart recovery met narrow availability expectations (`/health` and `/ready` recovered to HTTP 200 in about 6 seconds).

Open items and blockers captured during the same run:

- Authentication smoke remains blocked for target users on proxy path (`AUTHENTICATION_FAILED`, HTTP 401).
- Direct API login without allowed origin continues to fail with `CSRF_REJECTED` (HTTP 403), which is expected policy behavior.
- CI run for commit `47fd1f7` completed with failure at deploy job step `Run database migrations` (run `29609437005`).
- CI secret-scope read assignment verification for principal `fe7b2935-7f00-4996-a0c6-7f3be2390dbb` remained unresolved in returned role-assignment queries.
