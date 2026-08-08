# Sequrin versioned assessment context (PR 4)

## Scope and invariant

PR 4 separates changes to a claim from changes to the context used to assess it:

> A claim version means the claim changed. An assessment version means the information or strategy used to assess that claim changed.

Correcting a member or provider therefore creates a new immutable reference version. It does not create a claim version merely to force rescoring. A replacement assessment can continue to point to the same claim version while pinning the corrected member or provider version.

Sequrin is the public product name. Existing `ClaimGuard` / `claimguard` repository, package, schema, environment and internal identifiers remain unchanged; PR 4 is not a mass rename.

## Immutable reference versions and current pointers

`member_versions` and `provider_versions` are append-only histories. The stable `members` and `providers` rows retain the current-version pointer used for new work. Existing version rows cannot be updated or deleted.

The tenant-scoped history routes are:

```text
GET /assessment/members/:memberId/versions
GET /assessment/providers/:providerId/versions
```

They require the fixed `member.read` and `provider.read` permissions respectively. Member history intentionally excludes banking details. A tenant mismatch is indistinguishable from a missing entity.

## Assessment provenance

Every schema-18 assessment pins:

- tenant, claim identity and claim version;
- member identity and immutable member version;
- provider identity and immutable provider version;
- detection strategy identity and type;
- model deployment, model/rule version, feature-schema version and reference-data version;
- the immutable input snapshot and its SHA-256 hash;
- reason, creator, lineage and optional source correction event.

`COMPLETE` means those values were captured as authoritative immutable provenance. `LEGACY_PARTIAL` marks a historical result created before schema 18, where the actual member, provider or strategy context was not fully pinned. Migration 0018 preserves such results without pretending that current reference data was their historical input.

New schema-3 worker execution accepts only `COMPLETE` assessments. Before scoring it verifies the snapshot hash and cross-checks the pinned claim, member version, provider version and complete strategy provenance against the assessment row. Snapshot hashes use canonical UTF-8 JSON with raw Unicode characters, matching JavaScript `JSON.stringify` output rather than an ASCII-escaped representation. Current mutable member/provider rows are not scoring authority, and banking data is excluded from the scoring snapshot.

New detection-result writes are assessment-addressed and fail closed when `assessment_id` is missing or inconsistent. The old claim/version lookup is not a new-write fallback.

The non-sensitive provenance route is:

```text
GET /assessment/versions/:assessmentId
```

It requires `assessment.read`. It exposes identifiers, pinned version numbers, strategy fingerprints, `inputHash`, reason, creator, lineage and derived signal-supersession records. It never returns the input snapshot.

## Governed correction commands

The correction routes are:

```text
POST /assessment/members/:memberId/correction
POST /assessment/providers/:providerId/correction
```

They require `member.correct` or `provider.correct`, a server-derived tenant and actor, an `Idempotency-Key` header, and a positive body `expected_version`. The body entity identifier must match the URL.

Correction operations are durable and immutable:

- the same tenant, key and complete intent returns the original result;
- reusing the key for different intent fails closed;
- a caller whose `expected_version` is no longer current receives a stale-writer conflict;
- the stable member or provider row is locked before the idempotency record is inspected, serializing concurrent commands for the same entity without relying on a missing-row gap lock;
- concurrent same-key, same-intent submissions converge on one authoritative write and one replay result;
- no-op corrections are recorded and replayable without creating a reference version;
- material corrections append a reference version and correction event;
- the original reference version, claim and historical assessment remain unchanged.

Correction classification determines assessment impact. A material scoring-context correction can create replacement assessments for affected `COMPLETE` assessments. Context that cannot be safely resolved automatically creates a governed impact-review item instead of silently changing case or sharing state.

## Correction-impact review

The fixed `correction.review_impact` permission gates all review routes:

```text
GET  /assessment/correction-impact-reviews
GET  /assessment/correction-impact-reviews/:reviewId
POST /assessment/correction-impact-reviews/:reviewId/claim
POST /assessment/correction-impact-reviews/:reviewId/complete
```

The state path is append-audited and optimistic-concurrency guarded:

```text
PENDING -> IN_REVIEW -> COMPLETED
```

Every transition appends an immutable `correction_impact_review_events` record containing the before/after status and state version, actor, correlation identifier and bounded event payload. Event rows cannot be updated or deleted. Review reads return this history with the current review state.

Claim and completion commands require the last positive `expected_state_version`. The actor who submitted the underlying correction cannot claim or complete its impact review. Completion is limited to the independently assigned actor and records a bounded `review_result`. A stale state version, wrong tenant, wrong state, correction submitter or different assigned actor fails closed.

Completing a correction-impact review does not transition a governed case, approve or reverse an outcome, publish a registry record, or activate, correct, suspend, withdraw, expire or supersede a network notice. Those decisions remain in their separately governed workflows.

## Reassessment and signal supersession

Explicit reassessment uses:

```text
POST /assessment/versions/:assessmentId/reassess
```

It requires `assessment.request_reassessment`, an `Idempotency-Key`, trusted tenant/actor context and a `COMPLETE` source assessment. It creates an immutable replacement assessment and schema-3 outbox job; an exact retry returns the original operation result.

When both assessment results exist, the runtime appends one `detection_signal_supersessions` record for the old/replacement signal pair. Insertion is order-independent and idempotent, so it works whether the source or replacement result arrives first. The supersession record carries assessment lineage, reason, correlation and actor provenance. A correction event is present for correction-driven replacements and nullable for an explicit reassessment.

Signals themselves remain immutable `SIGNAL_GENERATED` evidence. Supersession is derived through the append-only relationship; it does not rewrite or delete the historical signal. One historical signal may have multiple independently requested replacement assessments, while each old/replacement pair is unique.

## Safety boundaries preserved

PR 4 does not:

- permit detection output to command payment, adjudication, rejection, withholding, recovery, sanction, fraud confirmation, registry publication or network-notice activation;
- mutate the PR 2 case-state machine or bypass its expected-version, idempotency, permission or separation-of-duties checks;
- fabricate complete provenance for historical results;
- allow a correction, review or reassessment to mutate a case, outcome or notice automatically;
- implement the PR 5 network-notice lifecycle;
- migrate staging, Azure or any shared deployed database.

## Schema and deployment boundary

The repository's canonical operational schema after PR 4 is **18**, implemented by `packages/database/migrations/0018_versioned_assessment_context.sql`.

The deployed or staging schema may still be **15**. A green repository build or migration test does not authorize deployment. Environment migration remains a separately approved, rehearsed and observable operation under the production data boundary and release process.
