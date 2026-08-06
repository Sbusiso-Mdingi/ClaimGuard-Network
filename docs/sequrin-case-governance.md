# Sequrin case governance (PR 2)

## Scope and safety boundary

Sequrin PR 2 establishes a governed investigation-case lifecycle. Detection models, deterministic rules, graph relationships and network results create immutable investigative signals only. Neither detection nor a governed case action may pause, reject, delay, redirect, recover, terminate or sanction a claim or benefit payment.

The legacy `investigations` workflow contains the historical statuses `OPEN`, `UNDER_REVIEW`, `AWAITING_EVIDENCE`, `CONFIRMED_FRAUD`, `REVERSED`, `NO_FRAUD_FOUND` and `CLOSED`. It also contains historical fraud-confirmation timestamps, ledger terminology and registry-publication code. Those values remain audit and compatibility data; they are not authoritative Sequrin outcomes.

## Permission-gated case state machine

Every action has a fixed server-side target state and required permission. A role name alone never grants authority, and a client never supplies a target state or transition matrix.

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

## Case detail and action APIs

PR 2 exposes:

```text
GET /api/v1/cases/:caseId
GET /api/v1/cases/by-legacy-investigation/:investigationId
POST /api/v1/cases/:caseId/actions/:action
```

Direct case lookup is tenant-scoped. A tenant mismatch is represented as `CASE_NOT_FOUND` so the response does not disclose foreign-tenant existence.

Legacy-investigation lookup returns an existing governed case when present. When no case exists, an actor with trusted `case.triage` permission may trigger neutral first access. The route propagates the trusted middleware request ID as the correlation ID; query, body and client-supplied authority fields are ignored or rejected.

The action name determines the target state through the fixed server policy. The request body carries a positive `expectedStateVersion` and action-specific evidence or reason fields, never `targetState`, tenant, actor, role or permissions. The service uses explicit capability checks for direct reads, legacy reads, neutral first access and actions so a partially composed repository cannot appear fully configured.

## Neutral legacy first access

Every historical status resolves neutrally to:

```text
currentState = TRIAGE_PENDING
stateVersion = 2
migrationReviewStatus = REVIEW_REQUIRED
```

The migration records exactly one neutral transition and one `LEGACY_MIGRATION_AUTHORIZATION` process check. It links exactly one immutable authoritative signal and creates zero governed outcomes. It does not publish a registry entry, activate a network notice, mutate a claim, or create a payment/adjudication instruction. The historical `fraud_confirmed_at` value remains unchanged.

Missing, malformed, cross-tenant, stale, wrong-claim or ambiguous signal/investigation linkage fails closed. A replay is accepted only when the complete canonical tenant, claim, signal, neutral state, transition, process-check, idempotency-result and zero-outcome invariant set is present.

## Concurrency, retry and idempotency

Every governed action supplies a positive bounded expected state version. The repository locks the tenant-scoped case and performs an atomic state/version update. Stale requests fail with `CASE_STATE_VERSION_CONFLICT`; last-write-wins behavior is not used.

Each tenant-scoped idempotency key stores a hash of the complete intended action and its original result. An exact replay returns the authoritative original result. Reusing the key for different intent fails with `CASE_IDEMPOTENCY_MISMATCH`.

Legacy first access retries only verified MySQL deadlocks and lock timeouts. The implementation rolls back, releases the failed connection and reruns the complete operation a maximum of three attempts. It never treats a deadlock as proof that another transaction committed. The diagnosed race was `ER_LOCK_DEADLOCK`, errno `1213`, SQLSTATE `40001`, while loading the legacy investigation and claim.

A duplicate-key race is resolved only after rollback and a complete canonical replay check. An absent or partial canonical migration fails with the stable incomplete-migration domain error rather than leaking raw SQL.

## Rollback guarantees

Real-MySQL failure injection covers failure after case insertion, after legacy linkage, after the neutral transition, after the migration process check and immediately before commit. Every stage proves full rollback: no partial case, orphan transition, process check, outcome or registry mutation; unchanged claim, signal and historical investigation; and a subsequent clean retry that creates exactly one neutral migration.

## Web client contract

The investigator workspace resolves the authoritative governed case from the historical investigation, displays governed state separately from read-only historical status and renders only server-returned actions. It generates a fresh `Idempotency-Key` and sends the loaded `expectedStateVersion`. It never sends target state, tenant, actor, role or permissions.

After success, the web client refreshes authoritative detail. On `CASE_STATE_VERSION_CONFLICT`, it refreshes without automatically replaying the user's decision. While a request is pending, the action control is disabled. Legacy generic status, confirmation, reversal, registry-publication and network-notice controls are absent. Priority, notes and evidence remain supported. `OUTCOME_APPROVED` is explicitly separate from registry publication.

Browser authentication and CSRF behavior are unchanged. Browser mutating requests continue to require the existing authenticated session and CSRF token. Merely attaching a `DPoP` header does not create trusted desktop context or grant a CSRF exemption.

## Native desktop contract

Historical investigation status is read-only in the desktop workspace. The bridge throws `LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED` before any native invocation when a status payload is attempted, while priority, assignment, notes and evidence remain available.

The completed native governed path uses exactly these registered Tauri commands:

```text
desktop_governed_case_details
desktop_perform_case_action
```

The JavaScript bridge invokes those exact names and does not use renderer `fetch()` for governed case traffic. The real investigation workspace mounts `GovernedDesktopCasePanel`, which resolves authoritative case detail, renders only server-returned allowed actions, displays historical status separately as read-only compatibility data, refreshes after success, and refreshes after `CASE_STATE_VERSION_CONFLICT` without replaying the stale decision. Submission is disabled while pending, preventing duplicate clicks, and native command unavailability fails safely.

The Tauri request type uses `serde(deny_unknown_fields)` and contains no target state, tenant, actor, role, permissions or legacy status field. Rust validates the action and request values, serializes the JSON body once, and transmits those exact bytes. The loaded `expectedStateVersion` remains in that JSON body.

Rust owns the governed HTTP boundary. It preserves the authenticated session cookie, inserts the fixed `Idempotency-Key` header through a specialized governed-action method, and does not accept arbitrary renderer-selected header names. The DPoP proof is bound to the exact HTTP method, origin, path and digest of the transmitted body. Stable server error codes survive the native bridge.

On the API, valid enrolled native DPoP is verified for governed GET and POST routes outside `/desktop/*`. Verification covers signature, method, path, origin, body digest, expiry, nonce replay, enrollment status, session binding and organisation binding. Invalid or merely present proof does not create trusted desktop context, does not exempt CSRF and does not invoke the governed service. Browser requests without DPoP retain their existing behavior.

The native implementation head `6c61845b5100396815db059ee1effd7d22390ddd` passed the exact-SHA `desktop-windows` run `31024861630`, including desktop frontend verification, server/web integration verification, native security-boundary verification and offline-capable NSIS packaging.

## Registry and network-notice separation

`OUTCOME_APPROVED` records only a scheme-governed case outcome. It does not insert into `shared_fraud_registry_entries`, set a publication-required flag, activate a notice or change claim/payment state.

Production operational composition exposes the historical shared registry as read-only. Its publication methods are not injected into production services. Complete correctable network-notice governance, publication approval and lifecycle controls remain deferred to PR 5; PR 2 must not be interpreted as completing that work.

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
