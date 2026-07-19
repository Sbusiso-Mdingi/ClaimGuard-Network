# Claim ingestion boundary

ClaimGuard receives claims from external medical-aid systems. No runtime component creates, mutates, or replays fabricated claims.

## End-to-end path

1. An authenticated producer sends a bounded JSON batch to `POST /claims/ingest`.
2. The API resolves the producer to one tenant through the control plane and active data-plane route.
3. Supplied scheme, member, and provider reference records are upserted in the same transaction as the claims.
4. Tenant ownership is immutable. Reusing any reference or claim identifier across tenants returns `409`.
5. The API writes a report-production outbox job before committing and returns `202`.
6. The report worker leases the outbox job, reloads the complete authoritative tenant snapshot, runs detection, and publishes the new report.
7. The web application reads claims and published reports through the API.

## Machine authentication

Production uses session authentication for people and a separate bearer credential for ingestion producers. Configure the API with:

- `INTERNAL_SERVICE_TOKEN`: at least 32 random characters, stored in the approved secret manager.
- `INTERNAL_SERVICE_ORGANISATION_IDS`: comma-separated organisation IDs the credential may access.
- `INTERNAL_SERVICE_ALLOWED_ROLES=claims_analyst`: the least-privilege default.

The producer sends:

- `Authorization: Bearer <secret>`
- `x-cg-service-actor: <stable-producer-id>`
- `x-cg-service-role: claims_analyst`
- `x-cg-service-tenant: <tenant-id>`
- `x-cg-service-organisation: <organisation-id>`
- `Content-Type: application/json`
- a unique `x-request-id` for trace correlation

The server derives the recorded ingestion source from the authenticated service actor. Browser identity headers are rejected in session mode.

## Batch contract

Reference arrays are optional when their records already exist. A clean tenant should send them before, or atomically with, the first claims that reference them.

```json
{
  "source": "desktop-claim-feed",
  "schemes": [
    { "scheme_id": "medical-aid-1", "scheme_name": "Medical Aid 1" }
  ],
  "members": [
    {
      "member_id": "member-1",
      "scheme_id": "medical-aid-1",
      "first_name": "Encrypted-or-tokenized",
      "last_name": "Encrypted-or-tokenized",
      "date_of_birth": "1985-01-01",
      "gender": "unspecified",
      "identity_number": "tokenized-identity-1",
      "banking_detail": "tokenized-bank-1",
      "home_region": "Gauteng",
      "home_lat": -26.2041,
      "home_lon": 28.0473,
      "join_date": "2020-01-01"
    }
  ],
  "providers": [
    {
      "provider_id": "provider-1",
      "scheme_id": "medical-aid-1",
      "practice_number": "practice-1",
      "specialty": "general-practitioner",
      "practice_name": "Practice 1",
      "banking_detail": "tokenized-bank-2",
      "practice_region": "Gauteng",
      "practice_lat": -26.2041,
      "practice_lon": 28.0473
    }
  ],
  "claims": [
    {
      "claim_id": "claim-1",
      "scheme_id": "medical-aid-1",
      "member_id": "member-1",
      "provider_id": "provider-1",
      "service_date": "2026-07-19",
      "billing_code": "CONSULT",
      "amount": 450.0
    }
  ]
}
```

Objects are strict: unknown fields such as caller-supplied `tenant_id` are rejected. Identical claim batches are safe to retry; claim upserts and the content-derived outbox idempotency key prevent duplicate processing jobs.

## Responses

- `202 Accepted`: the transaction committed and durable report processing was queued.
- `400 Bad Request`: malformed JSON or a payload that does not satisfy the contract.
- `409 Conflict`: a claim or reference identifier is already owned by another tenant.
- `413 Content Too Large`: the request exceeds the configured body limit.
- `415 Unsupported Media Type`: the request is not JSON.
- `422 Unprocessable Content`: a claim references a missing entity, a different tenant, or a different scheme.
- `503 Service Unavailable`: ingestion dependencies are not configured.

Treat `202` as the only successful ingestion response. Retry transient `5xx` and connection failures, but quarantine `400`, `409`, `413`, `415`, and `422` batches for operator review rather than retrying them unchanged.

## Limits

- `CLAIM_INGESTION_MAX_BATCH_SIZE` defaults to `500` claims and is capped at `5000`.
- `CLAIM_INGESTION_MAX_REFERENCE_RECORDS` defaults to `2000` per reference collection and is capped at `20000`.
- `CLAIM_INGESTION_MAX_BODY_BYTES` defaults to `2000000` bytes and is capped at `20000000`.

The desktop producer should buffer transient failures, use exponential backoff with jitter, keep the same batch contents for a retry, and retain the returned job and correlation IDs. Credential rotation and Azure Entra workload identity are the next hardening step before real medical-aid connectivity.

See `desktop-producer-windows.md` for the Windows host baseline and the distinction between a producer-only machine and a full development workstation.
