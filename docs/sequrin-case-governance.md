# Sequrin case governance (PR 2)

## Scope and safety boundary

Sequrin PR 2 establishes a governed investigation-case lifecycle. Detection models, deterministic rules, graph relationships and network results create investigative signals only. Neither detection nor a governed case action may pause, reject, delay, redirect, recover, terminate or sanction a claim or benefit payment.

The legacy `investigations` workflow contains the historical statuses `OPEN`, `UNDER_REVIEW`, `AWAITING_EVIDENCE`, `CONFIRMED_FRAUD`, `REVERSED`, `NO_FRAUD_FOUND` and `CLOSED`. It also contains historical fraud-confirmation timestamps, ledger terminology and registry-publication code. Those values remain audit and compatibility data; they are not authoritative Sequrin outcomes.

## Permission-gated case state machine

Every action has a fixed server-side target state and required permission. A role name alone never grants authority, and a client never supplies a target state.

| From | Permitted target(s) | Required permission class |
|---|---|---|
| `SIGNAL_GENERATED` | `TRIAGE_PENDING` | triage |
| `TRIAGE_PENDING` | `DISMISSED`, `MONITORING`, `INVESTIGATION_OPEN` | triage/dismiss/monitor/open investigation |
| `MONITORING` | `TRIAGE_PENDING`, `INVESTIGATION_OPEN` | triage/open investigation |
| `INVESTIGATION_OPEN` | `NOTICE_RECORDED` | record notice |
| `NOTICE_RECORDED` | `RESPONSE_PENDING`, `EVIDENCE_REVIEW` | record response/review evidence |
| `RESPONSE_PENDING` | `EVIDENCE_REVIEW` | review evidence |
| `EVIDENCE_REVIEW` | `INVESTIGATION_REPORT_COMPLETED` | complete report |
| `INVESTIGATION_REPORT_COMPLETED` | `OUTCOME_REVIEW_PENDING` | submit outcome review |
| `OUTCOME_REVIEW_PENDING` | `OUTCOME_APPROVED`, `CLOSED_UNSUBSTANTIATED`, `EVIDENCE_REVIEW` | approve/close/return for evidence |
| `OUTCOME_APPROVED`, `CLOSED_UNSUBSTANTIATED` | `APPEAL_OR_REVIEW` | open appeal/review |
| `APPEAL_OR_REVIEW` | `EVIDENCE_REVIEW`, `OUTCOME_REVIEW_PENDING`, `CLOSED_UNSUBSTANTIATED`, `OUTCOME_APPROVED` | bounded review permissions |

The repository independently enforces the permission, state graph, expected version, process requirements and separation of duties even when a client displays an action. Displayed actions are not an authorization token.

## Separation of duties

The investigator who completes a report cannot approve that report's outcome. Platform administrators have no implicit medical-scheme outcome authority. Detection and report-producing service actors cannot perform human governance actions. Trusted effective permissions come from authenticated server context, not a client role string or payload.

Outcome approval requires a configured bounded outcome code, recorded reasons, identity-match review, supporting report/evidence references and completed process checks. `CONFIRMED_FRAUD`, `RED`, `VERIFIED`, `BLACKLISTED` and `NETWORK_NOTICE_ACTIVE` are not valid Sequrin outcome codes.

## Server-derived allowed actions

The case detail service derives `allowedActions` from:

1. the authoritative current case state;
2. trusted effective permissions;
3. report-completer/reviewer independence; and
4. the fixed server action policy.

Deferred network and registry actions are never returned. Legacy role names do not add actions. Every submitted action is reauthorized by the action service and repository.

## Case detail APIs

PR 2 exposes:

```text
GET /api/v1/cases/:caseId
GET /api/v1/cases/by-legacy-investigation/:investigationId
POST /api/v1/cases/:caseId/actions/:action
```

Direct case lookup is tenant-scoped. A tenant mismatch is represented as `CASE_NOT_FOUND` so the response does not disclose foreign-tenant existence.

Legacy-investigation lookup returns an existing governed case when present. When no case exists, an actor with trusted `case.triage` permission may trigger neutral first access. The route propagates the trusted middleware request ID as the correlation ID; query, body and client-supplied authority fields are ignored or rejected.

The service uses explicit capability checks for direct reads, legacy reads, neutral first access and actions so a partially composed repository cannot appear fully configured.

## Neutral legacy first access

Every historical status resolves neutrally to:

```text
currentState = TRIAGE_PENDING
stateVersion = 2
migrationReviewStatus = REVIEW_REQUIRED
```

The migration records exactly one neutral transition and one `LEGACY_MIGRATION_AUTHORIZATION` process check. It does not create an outcome, registry publication, network notice, claim mutation or payment/adjudication instruction. `fraud_confirmed_at` remains unchanged.

Missing, malformed, cross-tenant, stale, wrong-claim or ambiguous signal/investigation linkage fails closed. A replay is accepted only when the complete canonical tenant, claim, signal, neutral state, transition, process-check, idempotency-result and zero-outcome invariant set is present.

## Concurrency, retry and idempotency

Every governed action supplies a positive bounded expected state version. The repository locks the tenant-scoped case and performs an atomic state/version update. Stale requests fail with `CASE_STATE_VERSION_CONFLICT`; last-write-wins behavior is not used.

Each tenant-scoped idempotency key stores a hash of the intended action and its original result. An exact replay returns the original result. Reusing the key for different intent fails with `CASE_IDEMPOTENCY_MISMATCH`.

Legacy first access retries only verified MySQL deadlocks and lock timeouts. The implementation rolls back, releases the failed connection and reruns the complete operation a maximum of three attempts. It never treats a deadlock as proof that another transaction committed. The diagnosed race was `ER_LOCK_DEADLOCK`, errno `1213`, SQLSTATE `40001`, while loading the legacy investigation and claim.

A duplicate-key race is resolved only after rollback and a complete canonical replay check. An absent or partial canonical migration fails with the stable incomplete-migration domain error rather than leaking raw SQL.

## Rollback guarantees

Real-MySQL failure injection covers failure after case insertion, after legacy linkage, after the neutral transition, after the migration process check and immediately before commit. Every stage proves full rollback: no partial case, orphan transition, process check, outcome or registry mutation; unchanged claim, signal and historical investigation; and a subsequent clean retry that creates exactly one neutral migration.

## Web compatibility

The investigator workspace resolves the governed case from the historical investigation, displays the authoritative governed state separately from read-only historical status and renders only server-returned actions. It sends a generated `Idempotency-Key` header and the loaded expected state version. It never sends target state, tenant, actor, role or permissions.

After success, the web client refreshes authoritative detail. On `CASE_STATE_VERSION_CONFLICT`, it refreshes without automatically repeating the user's decision. Legacy generic status, confirmation and reversal controls are hidden. Priority, notes and evidence remain supported. `OUTCOME_APPROVED` is explicitly described as separate from registry publication.

## Desktop compatibility

Commit `183a2810aacff609f93f067994cdfffe07c7b673` makes historical investigation status read-only in the desktop client. The bridge throws `LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED` before any native invocation when a status payload is attempted, while priority, assignment, notes and evidence remain supported.

The native governed case-action transport and desktop governed-action panel remain an explicit PR 2 completion item. Until that transport is present and validated on Windows, PR #138 must remain draft.

## Registry and network-notice separation

`OUTCOME_APPROVED` records only a scheme-governed case outcome. It does not insert into `shared_fraud_registry_entries`, set a publication-required flag, activate a notice or change claim/payment state.

Production operational composition exposes the historical shared registry as read-only. Its publication methods are not injected into production services. Complete correctable network-notice governance, publication approval and lifecycle controls remain deferred to PR 5.

## Stable disabled contracts

The following remain distinct:

```text
LEGACY_FRAUD_CONFIRMATION_DISABLED
LEGACY_FRAUD_REVERSAL_DISABLED
LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED
NETWORK_NOTICE_GOVERNANCE_REQUIRED
```

They must not be collapsed into a generic error because each identifies a different containment boundary.

## Reachability audit

The maintained production and historical write-surface classification is in:

```text
docs/governance/legacy-write-bypass-classification.md
```

The document distinguishes governed paths, read-only compatibility, explicit disabling, isolated historical repositories, migrations, fixtures, false positives and PR5-deferred code. It must be updated whenever a relevant dependency-injection or write surface changes.
