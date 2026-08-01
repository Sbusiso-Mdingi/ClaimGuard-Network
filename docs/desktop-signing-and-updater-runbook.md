# Desktop Signing and Updater Runbook

## Trust Material

The protected GitHub environment `desktop-signing` owns:

- secret `TAURI_SIGNING_PRIVATE_KEY`;
- secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the updater key is password protected;
- secret `WINDOWS_SIGNING_CERTIFICATE_BASE64` (PFX bytes);
- secret `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`;
- variable `TAURI_UPDATER_PUBLIC_KEY`;
- variable `DESKTOP_ACTIVATION_ORIGIN`;
- variable `DESKTOP_ENROLLMENT_VERIFYING_JWK`.

Require reviewers for that environment. Prefer a hardware-backed enterprise signing service over an exportable PFX when available; migrating to Azure Trusted Signing is deferred.

## Build (Does Not Publish)

1. Confirm the target is the exact reviewed commit on `main`.
2. Trigger `desktop-signed-build` with its full SHA and exact confirmation.
3. The workflow imports the certificate into the ephemeral runner user store, injects only public keys/config into Tauri, runs tests, Authenticode-signs via the bundler, creates a Tauri-signed updater payload, verifies Authenticode, uploads artifacts, and removes the imported certificate.
4. Independently verify SHA-256, Authenticode subject/chain/timestamp, the detached updater signature, version, and source SHA before approving publication.

The workflow intentionally has `contents: read` and no release/cloud deployment step.

## Publication Contract

The HTTPS updater service at the configured endpoint must return the Tauri v2 update manifest for `{{target}}`, `{{arch}}`, and `{{current_version}}`. For the NSIS target, its URL must identify the exact uploaded `ClaimGuard-Setup.exe`; its signature must be the matching `ClaimGuard-Setup.exe.sig` content. Never modify or re-sign the executable after Tauri creates the detached updater signature.

Roll out in rings. Confirm install/update on a non-production scheme device, then pilot, then broader deployment. Preserve the prior signed payload/manifest for rollback; do not allow downgrade unless incident governance explicitly approves it.

## Updater-Key Rotation

An installed client trusts its compiled public key. A safe rotation requires an update signed by the old key that contains transition logic or a new trusted public key, followed by releases signed with the new key. Losing the old private key without a prepared transition requires reinstalling a newly signed application; do not silently replace the endpoint key.

## Certificate Rotation

Renew the Authenticode certificate before expiry, keep publisher identity stable, test SmartScreen/enterprise deployment, and update the protected secret. Timestamped existing binaries remain verifiable after certificate expiry. Revoke and stop distribution immediately if the certificate or PFX password is exposed.

## Incident Actions

- Updater key exposure: remove/hold manifests, disable endpoint responses, preserve logs, rotate through the old-key transition if safe, otherwise require reinstall.
- Authenticode certificate exposure: revoke with the CA, remove signing environment access, rotate certificate, assess every artifact signed during the exposure window.
- Malicious/incorrect manifest: remove it, serve no-update responses, compare object hashes and access logs, and notify affected organisations.
- Build-runner compromise: quarantine artifacts, revoke all material exposed to that run, and rebuild from a reviewed SHA on a clean runner.
