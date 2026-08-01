# Desktop Production Readiness

## Intended Users

The Windows application is distributed to medical schemes. Scheme users, including scheme administrators, may authenticate on a device enrolled to their immutable medical-scheme organisation and receive only their server-authorised operational capabilities.

ClaimGuard platform administrators are web-only. Desktop login rejects a platform organisation or `platform_administrator` role with the generic desktop authentication response. Activation-key issuance, device policy, fleet revocation, and audit management remain in the browser application.

## Live API

The canonical production origin is:

```text
https://claimguard-api.azurewebsites.net
```

The origin is public configuration, but it is security-sensitive. The same exact origin must be configured as `DESKTOP_API_ORIGIN` on the API and compiled as `CLAIMGUARD_ACTIVATION_ORIGIN` in the Windows client. The desktop rejects editable origins, paths, queries, fragments, non-TLS origins, and signed enrollments that name a different origin.

Operators must verify the endpoint immediately before a deployment:

```bash
curl -fsS https://claimguard-api.azurewebsites.net/health
curl -fsS https://claimguard-api.azurewebsites.net/ready | jq .checks.desktopEnrollmentConfigured
```

The generic health endpoint proves only that the API process is running. A desktop-capable deployment requires `checks.desktopEnrollmentConfigured` to be `true`. The governed production deployment now treats any other value as a failed verification.

## Server Trust Group

The following settings are all-or-none. Partial configuration fails API startup.

| Setting | Delivery | Requirement |
| --- | --- | --- |
| `DESKTOP_ACTIVATION_KEY_PEPPER` | version-pinned Key Vault reference | random secret, at least 32 bytes |
| `DESKTOP_ENROLLMENT_SIGNING_PRIVATE_KEY` | version-pinned Key Vault reference | Ed25519 PKCS#8 private PEM |
| `DESKTOP_ENROLLMENT_SIGNING_KEY_ID` | App Service setting | stable reviewed key/version identifier |
| `DESKTOP_SYNC_CURSOR_SECRET` | version-pinned Key Vault reference | random secret, at least 32 bytes |
| `DESKTOP_API_ORIGIN` | App Service setting | canonical HTTPS origin above |

Do not put the private key, pepper, cursor secret, session material, or database credentials in repository variables, workflow inputs, logs, artifacts, or desktop binaries. Generate the enrollment key under an approved operator boundary, retain its public Ed25519 JWK with the same `kid`, and store the private material in Key Vault.

## Ordered Cutover

1. Generate and escrow the activation pepper, cursor secret, and Ed25519 enrollment key under the production operator boundary.
2. Add the three secrets to the production Key Vault and bind version-pinned Key Vault references plus the public origin/key ID to `claimguard-api` as one reviewed change.
3. Mark PR 117 ready, obtain the required independent approval, and merge it to `main`.
4. Run the governed production deployment for the exact reviewed main SHA. It applies control-plane migration `0016_desktop_device_enrollment.sql`, deploys the API, and requires desktop readiness to become true.
5. Create the protected `desktop-pilot` GitHub environment with required reviewers and these public variables:
   - `DESKTOP_ACTIVATION_ORIGIN=https://claimguard-api.azurewebsites.net`
   - `DESKTOP_ENROLLMENT_VERIFYING_JWK=<matching public Ed25519 JWK including kid>`
6. Dispatch `desktop-live-pilot` for the exact main SHA with `BUILD LIVE DESKTOP PILOT`.
7. A scheme administrator uses the web application to issue a one-time activation key. Install the pilot on a controlled scheme Windows device and verify activation, scheme-admin login, analyst login, platform-admin rejection, sync, offline expiry, reset, and web-driven revocation.
8. Discard the pilot before broad distribution. It is deliberately not Authenticode signed and uses a disposable updater key, so it cannot transition into the production updater chain.

## Production Distribution

The protected `desktop-signed-build` workflow is the production artifact path. Before it can run, provision the `desktop-signing` environment, persistent updater key, matching public updater key, enterprise Authenticode certificate, certificate password, live origin, and enrollment public JWK. It builds but does not publish.

Publishing still requires an HTTPS updater manifest/artifact service, independent hash/signature verification, a pilot ring, rollback retention, and an explicit release decision. A live API pilot is not a production-signed release.
