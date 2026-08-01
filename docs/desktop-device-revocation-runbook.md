# Desktop Activation, Revocation, and Recovery Runbook

## Issue an Activation Key

1. Scheme administrator opens Desktop device management for the current scheme.
2. Review device limit, active count, key lifetime, and offline-grace policy.
3. Re-enter the administrator password and type `ISSUE DESKTOP KEY`.
4. Transfer the displayed key through an approved one-time channel. It is never shown again.
5. Verify a `desktop_device.activated` success event and the expected installation/device entry.

Keys default to one use and expire according to policy. ClaimGuard stores only an HMAC-SHA-256 digest. Do not paste raw keys into tickets, chat, logs, or audit notes.

## Revoke an Unused Key

Use the key ID shown in administration, reauthenticate, type `REVOKE KEY <activation-key-id>`, and provide a non-sensitive reason. Verify the `activation_key.revoked` audit event. Already enrolled devices require separate revocation.

## Revoke a Device

1. Confirm organisation, device enrollment ID, activation/last-seen time, and incident scope.
2. Reauthenticate and type `REVOKE DEVICE <device-enrollment-id>`.
3. Verify `desktop_device.revoked` in audit history.
4. The next online proof fails. Offline access locks no later than the signed grace expiry.
5. If the Windows device is available, perform confirmed reset and validate deletion of local app data/Credential Manager entries.

An active device that merely exceeded offline grace can recover by reconnecting and signing in. The API renews grace only after device proof and organisation-bound user authentication succeed; revocation or licence expiry still fails closed.

## Lost or Stolen Device

Revoke immediately; do not wait for the device to reconnect. Invalidate affected user sessions/passwords according to identity incident policy. Record the last seen/offline-grace expiry, ensure device encryption/EDR remote actions are applied, and assess whether process memory, pagefile, backups, or an unlocked Windows session may have exposed data.

## Local Cache Failure or Organisation Change

Organisation change is never an in-place edit. Preserve evidence if corruption/tampering is suspected; otherwise type `RESET CLAIMGUARD`, obtain a new activation key, activate, authenticate, and allow bounded bootstrap to finish. An administrator cannot bypass a cache binding mismatch with an organisation selector.

## Enrollment-Signing Key Rotation

Keep old verifying public keys available to the API issuance/transition process until all active clients have received a document signed under a trusted replacement strategy. Because the current desktop pins one enrollment public JWK, changing it requires a signed desktop update before server cutover. Treat unplanned loss/exposure as a coordinated desktop reinstall/update incident.
