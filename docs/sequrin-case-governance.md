# Sequrin case governance (PR 2)

## Audit of the pre-PR 2 lifecycle

The legacy `investigations` workflow uses `OPEN`, `UNDER_REVIEW`, `AWAITING_EVIDENCE`, `CONFIRMED_FRAUD`, `REVERSED`, `NO_FRAUD_FOUND` and `CLOSED`. Its generic update method owns a separate transition map and writes status directly to `investigations`. The legacy fraud workflow additionally contains `confirmFraud` and `reverseFraud` operations, fraud-confirmation timestamps, registry-publication metadata and historical ledger terminology.

PR 1 independently blocks insertion of a new `ACTIVE` shared-registry row. Those legacy records and APIs remain available only for historical read compatibility and safe failure. They are not authoritative Sequrin case outcomes.

The authoritative application roles currently available are `fraud_analyst`, `investigator`, `applications_committee_member`, `scheme_administrator` and `platform_administrator`, among others. For this PR, `applications_committee_member` is the existing neutral role used for independent outcome review. A new client-supplied role is never trusted.

## Case states and permitted transitions

| From | Permitted target(s) | Authoritative role |
|---|---|---|
| `SIGNAL_GENERATED` | `TRIAGE_PENDING` | `fraud_analyst` |
| `TRIAGE_PENDING` | `DISMISSED`, `MONITORING`, `INVESTIGATION_OPEN` | `fraud_analyst` |
| `MONITORING` | `TRIAGE_PENDING`, `INVESTIGATION_OPEN` | `fraud_analyst` |
| `INVESTIGATION_OPEN` | `NOTICE_RECORDED` | `investigator` |
| `NOTICE_RECORDED` | `RESPONSE_PENDING`, `EVIDENCE_REVIEW` | `investigator` |
| `RESPONSE_PENDING` | `EVIDENCE_REVIEW` | `investigator` |
| `EVIDENCE_REVIEW` | `INVESTIGATION_REPORT_COMPLETED` | assigned `investigator` |
| `INVESTIGATION_REPORT_COMPLETED` | `OUTCOME_REVIEW_PENDING` | `investigator` |
| `OUTCOME_REVIEW_PENDING` | `OUTCOME_APPROVED`, `CLOSED_UNSUBSTANTIATED`, `EVIDENCE_REVIEW` | `applications_committee_member` |
| `OUTCOME_APPROVED`, `CLOSED_UNSUBSTANTIATED` | `APPEAL_OR_REVIEW` | `applications_committee_member` |
| `APPEAL_OR_REVIEW` | `EVIDENCE_REVIEW`, `OUTCOME_REVIEW_PENDING`, `CLOSED_UNSUBSTANTIATED`, `OUTCOME_APPROVED` | `applications_committee_member` |

Evidence review may begin directly after notice recording when the existing process does not require waiting for a response. Returning a matter from outcome review preserves the completed report and records a new append-only transition event explaining the further work.

## Prohibited transitions

The central policy rejects undocumented transitions, unrecognised roles, investigator outcome approval, platform-administrator outcome approval, detection/report-producer human transitions and every deferred network-notice state. `NETWORK_NOTICE_ACTIVE`, `CORRECTED_OR_WITHDRAWN` and `EXPIRED_OR_SUPERSEDED` are deliberately absent from the database state constraint and fail with `NETWORK_NOTICE_GOVERNANCE_REQUIRED` in policy code.

## Concurrency and idempotency

Every transition supplies the expected `state_version`. The repository locks the tenant-scoped case, verifies the expected version and performs an atomic state-and-version update. A stale or competing request fails with `CASE_STATE_VERSION_CONFLICT`; last-write-wins behaviour is not used.

Each tenant-scoped idempotency key stores a hash of the transition intent and its original result. An exact replay returns that result with `replayed: true`. Reusing the key for different intent fails with `CASE_IDEMPOTENCY_MISMATCH`.

## Process and independence requirements

Report completion requires the assigned investigator, persisted evidence references or an explicit no-evidence reason, a report reference or immutable digest, a completion reason, correlation ID and current state version. Submission for review requires the report-completion event, investigator identity and process-check references.

Outcome approval requires a different authorised reviewer, a configured bounded outcome code, reasons, identity-match review, report/evidence reference, completed process checks, expected state version, idempotency key and correlation ID. Outcome records are immutable. Corrections and reviews create later events/outcomes rather than overwriting history.

No authoritative neutral production outcome catalogue exists in the repository. Therefore approval is disabled unless `SEQURIN_CASE_OUTCOME_CODES` is explicitly configured. `CONFIRMED_FRAUD`, `RED`, `VERIFIED` and `NETWORK_NOTICE_ACTIVE` are prohibited outcome codes.

## Legacy compatibility

Migration 0017 is additive. It does not alter or delete legacy investigations, `fraud_confirmed_at`, historical registry rows, detection results or ledger entries. A legacy case can retain `legacy_investigation_id`, `legacy_status` and `migration_review_status`; no legacy status automatically becomes `OUTCOME_APPROVED`.

## Network-notice separation

`OUTCOME_APPROVED` records only a scheme-governed case outcome. It does not insert into `shared_fraud_registry_entries`, set a publication-required flag, activate a notice or change claim payment/adjudication state. Sharing approval and the complete correctable network-notice lifecycle are deferred to PR 3.
