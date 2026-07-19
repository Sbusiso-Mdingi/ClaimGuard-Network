# ClaimGuard Architecture Migration Blueprint

## Objective

Transition ClaimGuard to a strict producer/consumer architecture while preserving existing API/UI contracts and maintaining deployment safety.

## Current Implementation Status

Completed:

- API now reads reports through storage abstraction:
  - File adapter for development fallback
  - Azure Blob adapter for production mode
- Detection computation removed from API runtime path.
- The ad hoc `POST /detection/analyze` compatibility route has been removed.
- Durable outbox worker introduced under `services/report-producer`.
- Report publisher abstraction implemented with file and Azure Blob variants.
- Producer tests and API storage tests added.

Remaining architecture tasks:

- Replace the initial shared bearer secret with workload identity or per-producer credentials.
- Separate confirmed-fraud ledger writes from detection automation.
- Add producer deployment automation in GitHub Actions.
- Finalize Azure infra templates for Container Apps Job and Blob RBAC.

## Target Responsibility Boundaries

- Claim Ingestion: accepts claims only, no fraud logic.
- Detection Engine: fraud analysis domain only.
- Report Producer: orchestration, retries, publishing, versioning, telemetry.
- Report Storage: report artifacts only.
- API: read-only consumer.
- UI: API consumer only.
- Fraud Ledger: confirmed outcomes only (human decision stage).

## Incremental Migration Order

1. Baseline stabilization (completed)
- Keep existing endpoint contracts and UI behavior.
- Ensure report retrieval through abstractions only.

2. Producer runtime hardening
- Add structured telemetry spans/log dimensions.
- Add idempotency key strategy and publish conflict handling.
- Add explicit retry policy configuration.

3. Deployment boundary completion
- Introduce producer deployment workflow (Container Apps Job).
- Assign managed identity and Blob data-plane RBAC.
- Configure Key Vault references.

4. Claim ingestion boundary (completed)
- Validate bounded external reference and claim batches.
- Persist reference data, claims, and outbox work atomically.
- Run detection only from an authoritative tenant snapshot.

5. Ledger lifecycle correction
- Move ledger writes out of automated detection path.
- Add investigation-confirmed write path only.
- Keep read endpoints and UI indicators stable while write lifecycle shifts.

6. Observability convergence
- Standardize telemetry across API and producer with Application Insights.
- Correlate producer run IDs to API report metadata.

## Risk Controls

- Keep file storage adapter available for local fallback.
- Reject ad hoc analysis payloads outside the authenticated ingestion boundary.
- Version report artifacts and latest pointer updates atomically.
- Roll out producer deployment independently from API/web deployments.

## Rollback Strategy

- Roll back producer deployment independently.
- Repoint API storage backend to known-good report source.
- Restore previous latest pointer version in Blob.
- Preserve backward-compatible response envelopes during rollback.

## Verification Gates Per Phase

- Unit and integration tests must pass for touched packages.
- `pnpm test` full monorepo pass required before phase merge.
- Endpoint schema snapshots unchanged for:
  - `GET /detection/report`
  - `GET /detection/graph`
  - `GET /detection/risk`
- UI smoke tests pass with unchanged contract inputs.
