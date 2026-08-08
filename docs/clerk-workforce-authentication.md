# Clerk workforce authentication

Sequrin delegates workforce authentication, verified-email ownership, MFA, recovery, session management, and invitation delivery to Clerk. ClaimGuard remains the internal repository/package namespace and the authority for organisations, memberships, roles, permissions, data-plane routes, and audit history.

## Access policy

- Access is invitation-only. Users cannot create a Sequrin organisation or self-enrol into one.
- Password authentication is disabled. Sequrin never accepts, stores, proxies, or changes a workforce login password.
- Google, GitHub, and other consumer social identities are rejected at the API even if a provider is accidentally enabled in Clerk.
- A verified work email, active Clerk organisation, and MFA are required.
- Enterprise SSO is rejected unless `CLERK_ENTERPRISE_SSO_ENABLED=true` is deliberately configured after governance review.
- Clerk identity proves who authenticated. Internal active user, membership, role, permission, authentication-version, and authorization-version records decide what that identity may do.
- Platform administrators are web-only and cannot authenticate to the Windows desktop.

## Governed invitations and identity binding

Scheme and platform administrators create invitations through Sequrin. The API first records a governed internal invitation, ensures the internal organisation has an active Clerk organisation mapping, then asks Clerk to deliver the invitation. Raw internal invitation tokens are never returned to the web client.

If Clerk delivery fails, the pending internal invitation is revoked. If Clerk delivery succeeds but binding its invitation ID fails, the API revokes both sides. Platform-administrator acceptance revalidates that the accountable inviter is still an active platform administrator and that the new identity is distinct.

At first authenticated use, the API binds only a verified Clerk identity that has an active governed invitation or an existing active internal account. It creates an OIDC credential containing the Clerk user subject, disables local credentials for the same user/organisation, consumes the invitation, and records a security audit event. Repeated requests resolve the existing immutable binding.

## Browser and sensitive actions

The React application renders Clerk's sign-in and invitation-acceptance components. It has no local login, password-change, recovery, or open sign-up form. Sensitive actions—including platform-administrator invitations, release governance, desktop key/fleet changes, and desktop browser approval—use Clerk strict re-verification plus the existing exact typed confirmation and server audit.

The API rejects the retired local login, sign-up, and password-management endpoints in Clerk mode with `410 CLERK_MANAGED_AUTHENTICATION`.

## Windows desktop sign-in

The Windows application never receives a Clerk password or browser session token.

1. A device with a valid signed enrollment and DPoP-style proof asks the API to start sign-in.
2. The API creates independent browser and polling secrets, persists only their SHA-256 hashes, binds the request to the enrolled device and organisation, and expires prior pending requests.
3. Tauri opens the system browser on the configured Sequrin web origin. The browser secret is carried in a URL fragment, removed before telemetry starts, atomically rotated once into a distinct short-lived `HttpOnly`, `Secure`, host-only cookie, and never stored in JavaScript-accessible browser storage.
4. Clerk authenticates the invited workforce user. The API requires the selected internal organisation to match the device licence and rejects platform identities.
5. Clerk strict re-verification is required before the user approves the workstation.
6. The device polls with its separate secret and device proof. A compare-and-set transition permits a single exchange.
7. The API revalidates current internal authority, issues an opaque Sequrin desktop session, renews the signed enrollment, and marks the request consumed. Failure marks the exchange failed; it is not replayable.

Ordinary browser requests cannot use the opaque desktop cookie. It is considered only when a valid device-proof flow is present, after which the existing tenant and route boundaries still apply.

## Runtime configuration

```text
AUTHENTICATION_MODE=clerk
CONTROL_PLANE_MYSQL_URL=mysql://.../claimguard_control
CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=<secret reference>
CLERK_WEB_ORIGIN=https://work.sequrin.example
AUTH_ALLOWED_ORIGINS=https://work.sequrin.example,https://api.sequrin.example
CLERK_ENTERPRISE_SSO_ENABLED=false
SESSION_COOKIE_SECURE=true
TRUST_PROXY=false
```

`CLERK_WEB_ORIGIN` must be an exact origin in `AUTH_ALLOWED_ORIGINS`. It is the only origin used to generate Clerk invitation redirects and desktop browser-approval URLs. Production requires HTTPS through the existing origin and cookie policy.

The publishable key may be injected into the web shell. The secret key must come from the deployment secret store and must never be committed, logged, returned to a client, or placed in a desktop build.

## Clerk instance policy

Before production deployment, verify the production Clerk instance—not only development—has:

- restricted/invitation-only sign-up;
- passwords disabled;
- verified email-code authentication enabled;
- MFA required, with authenticator and governed recovery methods;
- no consumer OAuth providers;
- organisations enabled and required;
- user organisation creation and automatic domain enrolment disabled;
- approved production application and invitation redirect domains.

Do not deploy the production Clerk instance until the final web and API domains exist and exact-origin validation passes. After configuration, execute web sign-in, invite acceptance, role denial, strict re-verification, sign-out, desktop system-browser approval, replay rejection, organisation mismatch, platform-desktop rejection, and user-disable/session invalidation tests.

## Incident response

There is no production local-password fallback. Disable or revoke the affected Clerk user/session or internal membership, rotate Clerk secret material through the secret store when necessary, verify the internal audit trail, and restore the failed dependency. Keep the application fail closed throughout the incident.
