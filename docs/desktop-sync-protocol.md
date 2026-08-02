# Desktop Sync Protocol

## Contract

The current schema is `1`. Clients send `schemaVersion=1` (an equivalent `x-claimguard-desktop-schema: 1` header is also accepted) and the server returns `schemaVersion: 1`. Unsupported versions receive `409 DESKTOP_SCHEMA_UNSUPPORTED` with supported versions.

| Endpoint | Purpose | Bound |
| --- | --- | --- |
| `GET /desktop/sync/bootstrap?limit=500` | first page or expired-cursor recovery | 1–500 changes |
| `GET /desktop/sync/changes?cursor=…&limit=500` | changes after durable per-resource watermarks | 1–500 changes |
| `GET /desktop/claims/:claimId` | encrypted on-demand detail | one claim |
| `GET /desktop/investigators` | active same-organisation assignment candidates | bounded organisation directory |
| `POST /desktop/investigations` | connected-only versioned creation | one investigation |
| `GET /desktop/investigations/:id` | encrypted on-demand case, notes, and evidence metadata | one investigation |
| `PATCH /desktop/investigations/:id` | connected-only optimistic update | one investigation |
| `POST /desktop/investigations/:id/notes` | connected-only versioned note creation | one note |
| `POST /desktop/investigations/:id/evidence` | connected-only private evidence upload | one file, maximum 10 MiB |

All endpoints require an active enrolled-device proof and an authenticated session for the same organisation. The API resolves the operational route from authenticated control-plane state; request routing overrides are invalid.

## Cursor Schema

The client treats cursors as opaque. The server cursor is a base64url JSON body plus HMAC-SHA-256 signature containing:

```text
version, organisationId, tenantId, scopeStart,
watermarks.claims.{updatedAt,id},
watermarks.investigations.{updatedAt,id},
investigationsVisible,
issuedAt, expiresAt
```

Watermarks use stable `(updatedAt, id)` ordering. The server rejects a modified cursor, another organisation/tenant, an unsupported version, or an expired cursor. Investigation visibility is part of the signed cursor scope; a login whose capability differs receives `410 DESKTOP_CURSOR_CAPABILITY_CHANGED`, and the client performs a bounded replacement bootstrap. Cursor lifetime defaults to 30 days.

## Change and Tombstone Shape

```json
{
  "resource": "claim|investigation",
  "operation": "upsert|delete",
  "id": "stable identifier",
  "version": "authoritative version",
  "updatedAt": "RFC 3339 timestamp",
  "record": {}
}
```

Closed investigations are delete tombstones. Dashboard and suspicious-network projections use `operation: "replace"` and stable ID `current`. Claim changes contain only summary fields; member/provider identifiers, detailed detection evidence, and full claim payloads are retrieved on demand.

Investigation changes are emitted only when the authenticated account has `investigations.view`. The server still advances the signed investigation watermark over records hidden by that capability filter, so a claims-only account does not repeatedly receive the same inaccessible page. A later permission grant or removal changes the signed cursor scope and forces a fresh bounded bootstrap.

## Transaction and Replay Rules

The client applies every page in one SQLite transaction:

1. verify schema and organisation scope;
2. authenticate/decrypt the existing cache binding;
3. apply upserts and tombstone deletes;
4. replace projections;
5. encrypt and store the next cursor and freshness metadata;
6. prune completed-scope retention records;
7. commit.

If any decode, encryption, SQL, or validation step fails, the transaction rolls back and the previous cursor remains durable. Replaying the same page is idempotent because resources upsert by organisation-derived record key and tombstones delete the same key. An investigation change invalidates its on-demand detail so stale notes, evidence, or version state cannot survive an authoritative compact update.

An expired cursor returns `410 DESKTOP_CURSOR_EXPIRED` with recovery `bootstrap`. The desktop requests a bounded bootstrap and replaces claim/investigation scope in the same transaction as the first replacement page. A cursor scope mismatch requires confirmed device reset, not an organisation override.

## Freshness and Polling

Responses provide `claimsSeconds` (15), `dashboardSeconds` (60), `referenceDataSeconds` (3600), and `generatedAt`. The UI states are:

- **Synchronizing** while one bounded page is in flight;
- **Fresh** while the last successful claim sync is within `claimsSeconds`;
- **Stale** when cached data is readable but outside that target;
- **Offline** after a network failure while signed offline grace remains valid.

Visible/active polling starts around 15 seconds and backs off with jitter to 120 seconds. Background polling starts around 60 seconds and backs off to 15 minutes. `hasMore` pages are requested promptly, one page per command, without concurrent syncs.

## Write Semantics

All operational changes are online-only. Offline or stale mode blocks investigation creation, notes, evidence changes, status transitions, fraud decisions, and administration.

Investigation creation requires `If-Match: W/"claim-<currentClaimVersion>"`. Assignment, status or priority updates, notes, and evidence uploads require `If-Match: W/"investigation-<recordVersion>"`. Each successful investigation write increments `recordVersion`; a race returns `412 STALE_RECORD_VERSION`, and the client must refresh and let the user reconcile instead of overwriting.

The desktop mutation surface supports investigation creation, assignment, status, priority, notes, and private evidence upload. The server evaluates `investigations.create`, `investigations.assign`, `investigations.update_status`, `investigations.change_priority`, `investigations.add_note`, and `investigations.upload_evidence` independently from the operation and fields present. Successful updates replace the encrypted compact case and invalidate cached detail; closing a case removes it from the active local queue. Case detail, notes, and evidence integrity metadata remain available offline only when that case was opened online within the 24-hour detail-cache window.
