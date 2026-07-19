# ClaimGuard Access Control Matrix

This matrix captures the current and intended least-privilege model for ClaimGuard.

## Identity Classes

| Identity | Scope | May do | Must not do |
| --- | --- | --- | --- |
| Browser user | authenticated session | read authorized tenant-scoped data | choose tenant database, route, or secret source |
| Platform Administrator | platform operations | manage platform metadata and supported ops | read private scheme claims by virtue of admin role |
| Scheme Administrator | scheme operations | manage scheme-scoped records | gain access to other schemes or platform-only data |
| Worker identity | service runtime | perform bounded machine tasks | act as an interactive user |
| Provisioning worker identity | provisioning | create/maintain provisioning artifacts and secrets within scope | manage unrelated Azure resources or subscription-wide RBAC |
| Future external ingestion identity | scoped integration | ingest only for one organisation and one operation set | cross-tenant access or broad administrative privileges |

## Current Azure Identity Snapshot

| Resource | Identity state | Notes |
| --- | --- | --- |
| `claimguard-api` | system-assigned managed identity present | no role assignments were returned in the live query |
| `claimguard-web` | no managed identity | browser-facing only |
| `claimguard-provisioning-worker` | user-assigned managed identity `claimguard-provisioner-identity` | intended for provisioning runtime |

## Current Application Controls

- Session mode is supported in code.
- CSRF middleware is present in code.
- Tenant routing and data-plane scoping are present in code.
- Authorization roles and permissions are evaluated in code.
- Header-based authentication remains available only for isolated local rollback; production startup rejects it.

## Required Constraints

- Browser input must never select tenant database, route, secret, Azure resource, or role.
- Platform Administrator must remain unable to read private scheme claims.
- Scheme Administrator must not gain claims access from admin privileges alone.
- Worker identities must not gain interactive user privileges.
- Rate limits are required for login, session, ingestion, and high-cost endpoints.
- Safe 401, 403, and 404 responses must avoid cross-tenant existence disclosure.

## Current Gaps

- A full Azure RBAC review is still required for managed identities and current secret-delivery boundaries.
- The repository has code-level controls, but some live App Service settings still carry secrets directly.
- Production-ready access review evidence is not yet present.
