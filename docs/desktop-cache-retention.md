# Desktop Cache Retention and Cleanup

## Minimum Necessary Set

The default server scope is claims updated in the most recent 90 days plus claims with an active investigation regardless of age. Cached claim records are reduced summaries: claim/version, dates, amount/code, workflow/risk status, and compact investigation status. Full member/provider/detection/evidence data is not part of the change feed.

The cache additionally holds compact investigations, current dashboard/suspicious-network projections, an opaque cursor, freshness values, and claim or investigation details that a user explicitly opened.

## Cleanup Rules

- A bounded bootstrap atomically replaces cached claim and investigation scope.
- At the final page of a sync sequence, claims older than `scope.claimsFrom` are deleted unless their compact investigation status is active.
- Closed investigation tombstones delete the local investigation record.
- On-demand claim and investigation details expire after 24 hours and are pruned during sync. Any compact investigation update invalidates its cached detail immediately.
- Dashboard and suspicious-network projections replace a single `current` record.
- Confirmed reset deletes the SQLite database, WAL/SHM files, cache key, device key, signed enrollment, installation ID, and session cookie for the current Windows user.
- Revocation prevents the next device proof; offline data remains readable only until the last signed `offlineGraceExpiresAt`, then the client locks it.

## Encryption and User Scope

Each payload uses AES-256-GCM with a fresh 96-bit nonce. AAD binds the organisation, resource, digested record key, cache schema, and authoritative version. Sync metadata uses separate organisation-bound AAD. Record keys are SHA-256 digests rather than plaintext IDs.

The cache key is never stored in SQLite. Windows Credential Manager and the per-user local app-data directory provide Windows-user scoping. Full-device encryption (BitLocker or Windows device encryption) is required to cover database metadata, pagefile/hibernation, backups, crash dumps, and an attacker with offline disk access.

## Failure Handling

SQLite `integrity_check` runs when the cache opens. A binding mismatch, failed AEAD tag, malformed ciphertext, or integrity failure returns no cached records. Operators must preserve the file only if incident evidence is required; normal recovery is confirmed reset, new activation, and bounded bootstrap.

## Memory Handling Limitations

Activation keys and opaque session material are moved into Rust `Zeroizing` buffers immediately after IPC receipt and are never persisted in the WebView or logged. Clerk authentication occurs only in the system browser. Network serialization and Tauri/allocator internals can create short-lived copies that cannot be reliably zeroized from application code. Do not enable request-body logging, heap dumps, or routine crash dumps on production workstations. Treat any captured process memory as sensitive and revoke affected Clerk sessions and unused activation keys.
