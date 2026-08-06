# Sequrin legacy write-bypass classification

Status: maintained for PR 2 (`sequrin/case-state-machine`).

This document classifies meaningful repository matches for legacy fraud verdicts, investigation status writes, registry publication, claim/payment disposition language, generic update helpers, dependency injection, web capabilities, desktop commands, detection outputs, report outputs, migrations and test fixtures.

The public product is Sequrin. Historical internal names remain unchanged where a rename is not part of this PR.

## Classification rules

- `SAFE_GOVERNED_PATH`: reachable production behavior constrained by the permission-gated case policy and optimistic concurrency.
- `READ_ONLY_LEGACY_COMPATIBILITY`: historical data may be displayed or queried but cannot drive a governed outcome.
- `EXPLICITLY_DISABLED`: reachable entry point returns a stable disabled error before a write.
- `ISOLATED_HISTORICAL_REPOSITORY`: writable legacy implementation exists for migration/tests but is not exposed by production operational composition.
- `MIGRATION_ONLY`: schema or data migration occurrence, not a runtime authority path.
- `TEST_FIXTURE_ONLY`: test-only construction or assertion.
- `DEFERRED_TO_PR5`: shared-network governance implementation intentionally excluded from PR 2.
- `FALSE_POSITIVE`: textual match with no relevant write authority.
- `UNSAFE_REACHABLE_BYPASS`: reachable production write outside the governed boundary. PR 2 may not leave an entry in this class.

## Production reachability matrix

| Path | Symbol / match | Reachability | Write capability | Classification | Current containment / proving evidence | Remaining action / owner |
|---|---|---:|---:|---|---|---|
| `packages/database/src/case-transition-policy.js` | `CASE_ACTION_POLICY`, `assertCaseTransition`, `OUTCOME_APPROVED` | Production | Governed case only | `SAFE_GOVERNED_PATH` | Fixed action-to-state mapping, permission checks, state graph, reviewer independence and deferred-state rejection. Policy and repository tests cover state skipping and self-approval. | Maintain in case-governance PRs. |
| `packages/database/src/case-workflow-repository.js` | `performAction`, optimistic version, outcomes | Production | Governed case/event/outcome | `SAFE_GOVERNED_PATH` | Tenant-scoped locks, bounded retry, idempotency, authoritative target resolution, process checks and no claim/payment update SQL. | Maintain in PR 2. |
| `apps/api/src/routes/case-routes.js` | case detail and action routes | Production | Governed action route | `SAFE_GOVERNED_PATH` | Trusted auth/tenant/request ID only; prohibited client context fields rejected; `Idempotency-Key` required; deferred network actions return `NETWORK_NOTICE_GOVERNANCE_REQUIRED`. Route tests cover tampering. | Maintain in PR 2. |
| `apps/api/src/services/case-workflow-service.js` | `allowedActionsFor`, direct and legacy reads | Production | No write except delegated governed action/neutral migration | `SAFE_GOVERNED_PATH` | Uses trusted effective permissions and authoritative state; roles do not confer authority; self-approval filtered; action endpoint independently reauthorizes. | Maintain in PR 2. |
| `packages/database/src/legacy-case-adapter.js` | neutral first access, historical statuses | Production | Neutral case/event/check only | `SAFE_GOVERNED_PATH` | All seven statuses migrate to `TRIAGE_PENDING` and `REVIEW_REQUIRED`; bounded complete-operation retry for verified MySQL deadlocks/timeouts; strict replay completeness; exactly one signal, transition and authorization check; zero outcomes; no registry, claim, payment or historical timestamp mutation. Real-MySQL matrix, repeated race, negative and rollback gates. | Maintain in PR 2. |
| `packages/database/src/legacy-case-read-repository.js` | lookup by legacy investigation | Production | None | `READ_ONLY_LEGACY_COMPATIBILITY` | Tenant-scoped read only; used by governed case detail service. | None. |
| `packages/database/src/operational-repositories.js` | `fraudWorkflow.confirmFraud`, `reverseFraud` | Production | None | `EXPLICITLY_DISABLED` | Stable `LEGACY_FRAUD_CONFIRMATION_DISABLED` and `LEGACY_FRAUD_REVERSAL_DISABLED`; tenant mismatch fails first. | Preserve distinct errors. |
| `packages/database/src/operational-repositories.js` | wrapped `investigations.updateInvestigation` with `status` | Production | Priority/assignment only | `EXPLICITLY_DISABLED` | Any supplied legacy status throws `LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED`; desktop bridge also blocks before native invocation. | Preserve. |
| `packages/database/src/operational-repositories.js` | `registry` composition | Production | Read only | `READ_ONLY_LEGACY_COMPATIBILITY` | Operational bundle exposes only `searchRegistry`, `getRegistryHistory`, and `getRegistryRecordById`; publication methods are not composed. | PR5 owns governed notice/publication design. |
| `apps/api/src/routes/registry-routes.js` | registry search/history/detail | Production | None | `READ_ONLY_LEGACY_COMPATIBILITY` | GET-only route set with operational authorization. | PR5. |
| `apps/api/src/services/registry-service.js` | registry methods | Production | None | `READ_ONLY_LEGACY_COMPATIBILITY` | Service delegates only the three read methods. | PR5. |
| `apps/api/src/routes/investigations-routes.js` | generic `PATCH /investigations/:id`, confirm/reverse routes | Production | Priority/assignment; legacy verdict calls disabled | `EXPLICITLY_DISABLED` | Operational repository rejects status; fraud workflow adapter rejects confirmation/reversal with stable errors. | Remove compatibility routes in a later cleanup only after clients migrate. |
| `apps/api/src/routes/legacy-case-write-guards.js` | legacy verdict/status route guards | Production | None | `EXPLICITLY_DISABLED` | Status and confirmation guards return stable disabled contracts before legacy handlers. Reversal is independently disabled in production composition. | Preserve distinct contracts. |
| `packages/database/src/investigation-repository.js` | `CONFIRMED_FRAUD`, `fraud_confirmed_at`, `updateInvestigation` | Not directly composed for status writes | Historical write implementation | `ISOLATED_HISTORICAL_REPOSITORY` | Production operational wrapper rejects status. Direct repository is retained for migrations, fixtures and historical tests. | Later removal/archival after compatibility retirement. |
| `packages/database/src/fraud-workflow-repository.js` | `confirmFraud`, reversal, `FRAUD_CONFIRMATION` | Not production composed | Historical verdict/ledger behavior | `ISOLATED_HISTORICAL_REPOSITORY` | Production receives disabled adapter instead of this repository. | Later archival after migration evidence is retained. |
| `packages/database/src/shared-fraud-registry-repository.js` | `publishConfirmedFraud`, `publishFraudReversal`, `ACTIVE` | Not production composed for writes | Historical registry publication | `DEFERRED_TO_PR5` | Operational composition strips publication methods; only isolated tests instantiate the writable repository. | PR5 must replace this with governed network-notice lifecycle and separation of duties. |
| `apps/api/src/backend.js` | dependency injection for case, fraud and registry services | Production | Depends on composed repository | `SAFE_GOVERNED_PATH` | Data-plane runtime composes governed cases, disabled fraud workflow and read-only registry. Explicit test injection remains possible only in test-created app instances. | Maintain composition tests. |
| `apps/api/src/operational-service-context.js` | generic dependency proxy | Production | No authority itself | `FALSE_POSITIVE` | Proxy selects request-scoped verified operational bundle; does not add methods or permissions. | Maintain DI tests. |
| `apps/api/src/middleware/auth-context.js`, `desktop-device-proof.js` | governed native DPoP outside `/desktop/*` | Production | Trusted native context only after proof verification | `SAFE_GOVERNED_PATH` | Valid enrolled proof is bound to method, origin/path, exact body digest, nonce, expiry, session and organisation. Invalid or merely present proof creates no desktop context, grants no CSRF exemption and does not reach the governed service. Browser authentication and CSRF behavior remain unchanged. | Do not broaden without equivalent negative tests. |
| `apps/web/src/features/investigator/GovernedCaseActionPanel.jsx` | server actions and case state | Production client | Calls governed API only | `SAFE_GOVERNED_PATH` | Uses server `allowedActions`, fresh idempotency key and loaded version; submits no target state/trusted context; refreshes after success; stale conflict refreshes without replay; pending state suppresses duplicate submission. | Maintain tests. |
| `apps/web/src/features/investigator/InvestigationWorkspacePage.jsx` | historical `status`, old capabilities | Production client | Priority/notes/evidence only | `READ_ONLY_LEGACY_COMPATIBILITY` | Historical status displayed separately; generic status, confirmation and reversal controls removed. | Maintain. |
| `apps/web/src/lib/capabilities.js` and role context | `investigations.update_status`, confirm/reverse names | Production client metadata | No server authority | `READ_ONLY_LEGACY_COMPATIBILITY` | Old capability strings may remain in session/profile compatibility, but no web control invokes legacy lifecycle writes. Server enforcement remains authoritative. | Remove in later identity-policy cleanup. |
| `apps/desktop/src/desktopBridge.js` | legacy status guard plus governed command bridge | Production client | Governed API only; priority/assignment compatibility | `SAFE_GOVERNED_PATH` and `EXPLICITLY_DISABLED` | Status mutation throws `LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED` before invoke. Governed detail/action methods invoke only `desktop_governed_case_details` and `desktop_perform_case_action`; no renderer fetch or arbitrary header interface. | Preserve tests and typed boundary. |
| `apps/desktop/src/GovernedDesktopCasePanel.jsx`, `DesktopWorkspace.jsx` | governed panel and historical status | Production client | Calls governed native bridge only | `SAFE_GOVERNED_PATH` and `READ_ONLY_LEGACY_COMPATIBILITY` | Real workspace mounts the panel; renders server `allowedActions`; sends loaded version and fresh key; refreshes after success/stale conflict without replay; disables while pending; historical status is read-only; deferred registry/network actions are hidden; priority, assignment, notes and evidence remain available. | Maintain desktop integration tests. |
| `apps/desktop/src-tauri/src/governed_case.rs`, `http_client.rs`, `lib.rs` | typed request, native commands, DPoP transport | Native production | Governed case API only | `SAFE_GOVERNED_PATH` | Commands are implemented and registered. `serde(deny_unknown_fields)` rejects authority/target fields. Rust serializes once, signs exact method/path/body, preserves session cookie and inserts only the validated Rust-owned `Idempotency-Key`; stable server codes cross the bridge. Exact-SHA Windows run `31024861630` passed for implementation head `6c61845b…`. | Maintain native security-boundary and Windows gates. |
| `apps/desktop/src-tauri/src/lib.rs` | `desktop_update_investigation` optional status | Native production compatibility command | Native validation exists, but JS bridge always sends null and blocks status | `EXPLICITLY_DISABLED` | Bridge-level zero-call guard and server operational rejection provide two independent boundaries. | Remove native status parameter in later desktop protocol version. |
| `services/detection-engine/**`, detection routes and detection repositories | risk, flags, `RED`/`YELLOW` labels | Production | Investigative signal/result only | `SAFE_GOVERNED_PATH` | Detection outputs persist signals/results; no case outcome, claim disposition, payment or registry write authority is composed. | Maintain detection-domain tests. |
| `services/report-producer/**`, report service/storage | report/verdict wording | Production | Report artifacts only | `SAFE_GOVERNED_PATH` | Report output is evidence/input; report service has no case transition, registry, claim or payment repository. | Continue terminology cleanup without changing authority. |
| claim ingestion/read/outbox repositories | `status`, adjudication wording | Production | Claim ingestion/version/outbox only | `FALSE_POSITIVE` | No governed action changes claim/payment disposition; first-access tests compare complete claim rows before/after. | Future claim-adjudication integration must remain separate. |
| payment pause/hold/rejection/withholding/recovery/sanction searches | prose, tests, prohibited request fields | No production executor found | None | `FALSE_POSITIVE` | Case request schema explicitly rejects payment/adjudication context; database race/rollback tests prove unchanged claims. | Re-run audit when a payment subsystem is introduced. |

## Migration and fixture matches

| Path group | Match | Classification | Reason |
|---|---|---|---|
| `packages/database/migrations/0002_investigations.sql`, `0014_prospective_claim_detection.sql`, `0016_domain_safety_foundation.sql`, `0017_case_state_machine.sql` | statuses, `fraud_confirmed_at`, registry table, triggers | `MIGRATION_ONLY` | Defines historical schema, safety triggers, case schema and immutable signal constraints; not an application authority path. |
| `packages/database/tests/**`, `apps/api/tests/**`, `apps/web/src/__tests__/**`, `apps/desktop/src/**/*.test.*` | legacy verdicts, registry writes, red/yellow labels | `TEST_FIXTURE_ONLY` | Direct historical repository instantiation and malformed-row attempts exist to prove containment, migration and rollback behavior. |
| `packages/database/out.txt` and generated coverage/build output | symbol text | `FALSE_POSITIVE` | Generated or captured output; no runtime reachability. |

## Search coverage

The audit explicitly searched and reviewed meaningful results for:

`CONFIRMED_FRAUD`, `fraud_confirmed_at`, `shared_fraud_registry_entries`, `confirmFraud`, `publishConfirmedFraud`, `publishFraudReversal`, `FRAUD_CONFIRMATION`, `registry_publication_required`, `registryPublicationRequired`, `updateInvestigation`, `update_status`, `status:`, `ACTIVE`, `VERIFIED`, `RED`, `YELLOW`, `blacklist`, `RED FLAG`, `VERIFIED MATCH`, `payment pause`, `payment hold`, `payment rejection`, `payment withholding`, `payment recovery`, `sanction`, and `adjudication`.

Generic update helpers, API dependency injection, web capability maps, desktop bridge/native commands, detection output, report output, migrations, triggers and tests that construct historical repositories were reviewed separately because text search alone cannot establish reachability.

## Current conclusion

This audit records **no remaining `UNSAFE_REACHABLE_BYPASS` within PR 2's server, web or native desktop safety boundary**.

This is not a claim that shared-network governance is complete. Registry publication and network-notice activation remain explicitly deferred to PR 5, and the writable historical registry repository remains isolated rather than endorsed as a production path.
