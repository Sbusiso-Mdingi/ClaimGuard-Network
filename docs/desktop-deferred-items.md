# Desktop Deferred Items

The following are intentionally outside this implementation and must not be represented as production-complete:

- publish/host the updater manifest and artifacts; current workflows only build/upload inspection artifacts;
- provision protected GitHub environment values, enterprise certificate, updater key, enrollment key, API peppers/secrets, and rotation ownership;
- choose and integrate Azure Trusted Signing/HSM-backed Authenticode instead of an exportable PFX;
- production migration execution for `0016_desktop_device_enrollment.sql`;
- production API configuration/deployment and activation endpoint exposure;
- execution of the protected live-API pilot procedure in `desktop-production-readiness.md`; the workflow exists, but its environment values and server trust group are not yet provisioned;
- MSI enterprise packaging (NSIS `.exe` is the required artifact; MSI is optional);
- true hardware device attestation; current proof demonstrates possession of a Windows-user-protected Ed25519 key;
- system-browser Authorization Code + PKCE integration when ClaimGuard adopts an external identity provider; the current deployment preserves its existing local-password/session authority through the Rust network boundary;
- remote cache destruction while a device is offline; enforcement is bounded by signed offline grace;
- full-database page encryption; payloads are record-level AEAD and require BitLocker for whole-volume coverage;
- background Windows service/push synchronization; the app uses foreground/background jittered polling;
- broad offline workflows or mutation queues; offline remains read-only by policy;
- desktop case creation, assignment, note/evidence writes, and final fraud confirmation/reversal; the current desktop workspace reviews notes/evidence and performs only optimistic status/priority updates;
- accessibility, privacy/POPIA, independent penetration, SmartScreen reputation, managed-software-distribution, and incident exercises;
- production Windows end-to-end activation/sync/update tests against a dedicated non-production scheme;
- updater key transition support beyond the current single pinned key.
