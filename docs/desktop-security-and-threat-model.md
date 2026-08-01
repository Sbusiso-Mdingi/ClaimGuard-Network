# Desktop Security and Threat Model

Method: STRIDE, extending the repository-wide [threat model](threat-model.md).

## Assets and Boundaries

Assets include one-time activation keys, device Ed25519 keys, enrollment signing keys, signed enrollment documents, user sessions, cursor HMAC secrets, encrypted claim summaries/details, administrative audit records, updater signing keys, and Authenticode certificates.

Boundaries are WebView-to-Rust IPC, desktop-to-API TLS, API-to-control plane, API-to-server-resolved operational data plane, Windows Credential Manager, per-user app data, GitHub `desktop-signing` environment, and the HTTPS update endpoint.

## Threats and Controls

| Threat | Primary controls |
| --- | --- |
| Stolen/copied enrollment | Ed25519 private-key proof; public-key thumbprint in signed document; replay nonce consumed once |
| Organisation switch/cross-tenant query | no selector; signed immutable org; triple org check before reads; request overrides rejected |
| Activation brute force | 256-bit random keys, HMAC-at-rest, expiry/use limits, per-source exponential blocking, generic errors/audit categories |
| Raw key disclosure | one-time admin response, no persistence/list/log field, step-up auth and exact confirmation |
| Cache theft/tampering | AES-256-GCM, random nonce, AAD binding, key outside DB, integrity check, fail closed, BitLocker requirement |
| Cursor tampering/replay | server HMAC, org/tenant scope, expiry, stable watermarks, idempotent upsert/delete, cursor committed last |
| Offline unauthorised writes | all operational writes blocked unless connected/fresh; server remains authoritative |
| Stale overwrite | `If-Match`, conditional SQL update, HTTP 412 recovery |
| WebView compromise | strict CSP; bundled content only; no network/fs/shell/updater capability; eight manifest commands |
| Malicious update | HTTPS endpoint, mandatory Tauri signature, compile-time public key, Authenticode signed production installer |
| Signing-key exposure | protected GitHub environment/secrets, explicit main SHA/confirmation, no publication in build workflow, rotation runbook |
| Revoked device remaining offline | bounded signed offline grace; cache locks at expiry; reset removes all local material |

## Security Invariants with Tests

- one activation key maps to one organisation and raw key material never appears in persistence projections;
- single-use, expiry, device-limit, and brute-force controls;
- copied enrollment without the private key fails;
- replayed, expired, or revoked device proof fails;
- user/device/data-plane organisation mismatch fails before a repository read;
- signed cursor pages are bounded/idempotent and expired cursors recover via bootstrap;
- tombstones delete records and a failed page never advances the cursor;
- corrupted ciphertext returns no plaintext;
- first launch and login expose no organisation/API selector;
- offline state is visible and write-disabled.

## Residual Risk / Non-Goals

- Application encryption does not defeat a fully compromised Windows account while ClaimGuard is unlocked.
- JavaScript/IPC/network buffers and OS crash/page files may retain transient credential copies; application-level zeroization is best effort.
- Windows Credential Manager is user-scoped secret storage, not hardware-backed device attestation.
- The updater endpoint/manifest hosting and enterprise certificate lifecycle are operational dependencies, not implemented as an application deployment in this change.
- A privacy/POPIA review, independent penetration test, Windows EDR policy, code-signing HSM/Trusted Signing evaluation, and offline revocation-window approval remain required before production rollout.
