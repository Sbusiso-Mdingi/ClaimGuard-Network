# Phase 11C authentication operations

Phase 11C replaces browser-controlled identity headers with organisation-aware local-password login and opaque server-side sessions. It does not implement tenant connection routing: the shared operational database remains authoritative and the session organisation is bridged to one verified legacy tenant ID.

## Session mode

Configure the API and web shell consistently:

```text
AUTHENTICATION_MODE=session
CONTROL_PLANE_MYSQL_URL=mysql://.../claimguard_control
MYSQL_URL=mysql://.../claimguard_operational
AUTH_ALLOWED_ORIGINS=https://claimguard-web.example
TRUST_PROXY=false
DEPLOYMENT_CLASS=demo|pilot|production
SESSION_IDLE_TIMEOUT_MINUTES=30
SESSION_ABSOLUTE_TIMEOUT_HOURS=8
LOGIN_THROTTLE_WINDOW_MINUTES=15
LOGIN_THROTTLE_MAX_ATTEMPTS=8
LOGIN_THROTTLE_BASE_DELAY_MS=500
LOGIN_THROTTLE_MAX_DELAY_MS=30000
LOGIN_THROTTLE_LOCKOUT_MINUTES=15
SESSION_COOKIE_SECURE=true
PUBLIC_ORGANISATION_URL_SCHEME=https
PUBLIC_ORGANISATION_HOST=claimguard-web.example
```

Production requires session mode, Secure cookies, and an explicit allowed-origin list. The browser receives `__Host-cg_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`. JavaScript receives only a rotating synchronizer CSRF token.

Login throttling is shared through control-plane `login_throttle_buckets`, keyed only by hashes of source network, organisation slug, and username. The window, attempt bound, progressive-delay ceiling, and temporary-lock duration are configurable with the values above; client failures remain generic.

`TRUST_PROXY` is explicit and defaults to `false`. Set it to `true` only when the web/API services are behind a proxy that overwrites forwarding headers; otherwise the web proxy replaces caller-supplied source headers with its socket address before forwarding.

For explicit HTTP localhost development only, use `DEPLOYMENT_CLASS=local` and `SESSION_COOKIE_SECURE=false`. The cookie is then named `cg_session_local`, because browsers reject an insecure cookie with the reserved `__Host-` prefix. Never use this setting in production.

Apply migrations before cutover, verify inventory, and provision demo accounts when applicable:

```bash
pnpm --filter @claimguard/control-plane-database migrate
pnpm --filter @claimguard/control-plane-database inventory -- --dry-run
DEPLOYMENT_CLASS=demo pnpm --filter @claimguard/control-plane-database provision-demo -- --confirm=PROVISION_DEMO_ACCOUNTS
```

The provisioner prints generated passwords once. Put only approved ephemeral demo values in the deployment secret `DEMO_CREDENTIALS_JSON`. Demo display additionally requires both `DEPLOYMENT_CLASS=demo` and `DEMO_CREDENTIALS_VISIBLE=true`; visibility is off by default and refused in production.

External claim producers use the separate internal-service bearer mechanism documented in `claim-ingestion.md`; they never use browser identity headers.

## Rollback

For isolated non-production rollback, set `AUTHENTICATION_MODE=demo_headers` consistently on API and web, then restart both. Do not leave a session-mode instance and header-mode instance behind the same load balancer: that creates competing authorities. Production startup rejects header mode.

Before returning to session mode:

1. Reapply/verify control-plane migration status.
2. Run legacy inventory dry-run and resolve every conflict.
3. Confirm active medical-scheme organisations have verified mappings and active memberships.
4. Return both services to `AUTHENTICATION_MODE=session` and verify login, CSRF, logout, and private-route denial for the platform organisation.

Never use rollback mode to infer database names, accept browser tenant selection, or grant a platform-wide tenant bypass.
