# ClaimGuard Threat Model

Methodology: STRIDE

This threat model covers the current ClaimGuard surface and the future production-shaped foundation. It records the major trust boundaries and the mitigations that should be evidenced by tests, configuration, and operations runbooks.

## Assets

- browser session and CSRF tokens;
- control-plane and tenant databases;
- Azure Key Vault secrets;
- Doppler source configuration;
- GitHub Actions workflow credentials;
- managed identities and RBAC assignments;
- report artifacts and storage pointers;
- audit logs and telemetry;
- worker runtime secrets and job inputs.

## Trust Boundaries

- Browser -> web app;
- web proxy -> API;
- API -> control-plane database;
- API -> tenant data plane;
- API/worker -> Key Vault;
- API/worker -> Storage account;
- GitHub Actions -> Azure;
- Doppler -> runtime delivery;
- support/admin access -> operational records.

## Top Threats

### Spoofing

- forged demo headers or tenant headers;
- fake browser session tokens;
- worker or service identity impersonation;
- spoofed origin or CSRF context.

Mitigations:

- session mode and opaque server-side sessions;
- CSRF enforcement;
- origin allow-listing;
- managed identity where possible;
- avoid browser-controlled tenant selection.

### Tampering

- route metadata tampering;
- report pointer tampering;
- CI artifact tampering;
- secret/config drift;
- database row tampering.

Mitigations:

- immutable route generation checks;
- bounded storage pointer contract;
- artifact packaging and hash/verification discipline;
- migration discipline;
- parameterized SQL and schema validation.

### Repudiation

- inability to attribute privileged changes;
- missing correlation IDs;
- missing audit history for support actions.

Mitigations:

- structured logs with request IDs;
- privileged-operation audit events;
- operational runbooks;
- future immutable audit records.

### Information Disclosure

- cross-tenant data leakage;
- secrets in logs or artifacts;
- public network exposure;
- Key Vault or storage misconfiguration;
- backup leakage.

Mitigations:

- tenant-scoped authorization and routing;
- safe 404/403 behavior;
- log redaction;
- key vault and storage hardening;
- backup/restore access controls.

### Denial of Service

- unbounded query/page sizes;
- heap exhaustion from large transforms;
- login throttling bypass;
- repeated expensive requests;
- worker saturation.

Mitigations:

- bounded pagination;
- request-body and resource limits;
- rate limiting;
- connection pool bounds;
- timeout and cancellation discipline;
- memory telemetry and alerting.

### Elevation of Privilege

- platform admin reading private claims;
- scheme admin escalating into platform access;
- header spoofing bypassing tenant boundaries;
- CI/CD over-permission;
- worker secret reuse as user privileges.

Mitigations:

- explicit permission checks;
- tenant isolation tests;
- least-privilege identities and RBAC;
- OIDC-based deployment;
- separated worker and browser authorities.

## Deferred / Required Evidence

- independent penetration test;
- restore and DR exercises;
- load and capacity tests;
- access review;
- incident response exercise;
- privacy/POPIA assessment;
- supply-chain evidence;
- secret-rotation rehearsal.
