# ClaimGuard Access Control Matrix

This matrix captures the current and intended least-privilege model for ClaimGuard.

## Identity Classes

| Identity | Scope | May do | Must not do |
| --- | --- | --- | --- |
| Browser user | verified Clerk workforce session plus internal membership | read authorised tenant-scoped data | self-enrol, choose tenant database, route, role, or secret source |
| Platform Administrator | platform operations | manage platform metadata and supported ops | read private scheme claims by virtue of admin role |
| Scheme Administrator | scheme operations | manage scheme-scoped records | gain access to other schemes or platform-only data |
| Worker identity | service runtime | perform bounded machine tasks | act as an interactive user |
| Provisioning worker identity | provisioning | create/maintain provisioning artifacts and secrets within scope | manage unrelated Azure resources or subscription-wide RBAC |
| Future external ingestion identity | scoped integration | ingest only for one organisation and one operation set | cross-tenant access or broad administrative privileges |
| Enrolled desktop device | one immutable medical-scheme organisation | prove possession, authenticate scheme users including scheme administrators, sync authorised summaries, force reauthentication when server-side authority becomes stale | authenticate ClaimGuard platform administrators, choose an organisation/tenant route, act without a matching user, continue on a stale authority version, or write offline |

## Current Azure Identity Snapshot

| Resource | Identity state | Notes |
| --- | --- | --- |
| `claimguard-api` | system-assigned managed identity present | Key Vault runtime reads, report storage read, claim-scoring queue send, and provisioning-job operator roles |
| `claimguard-web` | system-assigned managed identity | secret-scoped Key Vault read for only the web Sentry DSN |
| `claimguard-provisioning-worker` | user-assigned managed identity `claimguard-provisioner-identity` | intended for provisioning runtime |

## Current Application Controls

- Clerk invitation-only workforce authentication is the runtime mode; local-password session mode is test-only.
- Origin validation and Clerk session-token verification are present in code.
- Tenant routing and data-plane scoping are present in code.
- Authorization roles and permissions are evaluated in code.
- Browser-controlled identity headers and consumer social identities are rejected.
- Scheme/platform administrators have `desktop.devices.manage`; scheme administrators are restricted to their own organisation. Only platform administrators have `desktop.fleet_policy.manage`, which sets the licensed allowance without granting private-claims access.
- Medical-scheme users, including scheme administrators, may use an organisation-enrolled Windows client branded as Sequrin. ClaimGuard platform administrators are web-only and are rejected by desktop authentication.
- Scheme device/fleet management remains web-only. The Windows desktop exposes no activation-key, device-policy, revocation, or platform-governance commands; its reset is a local destructive recovery action.
- Fleet-policy changes, activation-key issuance, and key/device revocation require Clerk strict re-verification, exact typed confirmation, and audit history.

## Required Constraints

- Browser input must never select tenant database, route, secret, Azure resource, or role.
- Platform Administrator must remain unable to read private scheme claims.
- Scheme Administrator must not gain claims access from admin privileges alone.
- Worker identities must not gain interactive user privileges.
- Rate limits are required for authentication, invitation, session, ingestion, and high-cost endpoints.
- Safe 401, 403, and 404 responses must avoid cross-tenant existence disclosure.

## Current Gaps

- A full Azure RBAC review is still required for managed identities and current secret-delivery boundaries.
- Observability credentials require provider-side rotation evidence after their Key Vault migration.
- Production-ready access review evidence is not yet present.
