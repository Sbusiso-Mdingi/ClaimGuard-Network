# Sequrin PR 1 implementation audit

## Source of truth

This PR follows the implementation change plan's highest-priority requirement: detection output is an investigative signal with no payment effect, and investigator report completion cannot activate a shared network notice.

## Current implementation findings

- `packages/database/src/fraud-workflow-repository.js` couples `confirmFraud` to all of the following in one transaction: a `CONFIRMED_FRAUD` lifecycle check, fraud-confirmation fields, `registry_publication_required = 1`, an investigator-confirmed ledger entry, and an `ACTIVE` row in `shared_fraud_registry_entries`.
- `apps/api/src/services/fraud-confirmation-service.js` previously delegated directly to that unsafe operation and logged the resulting registry entry.
- Migration `0014_prospective_claim_detection.sql` already provides the good foundations this PR extends: immutable claim versions, strategy-pinned jobs, immutable `claim_detection_results`, tenant-scoped keys, correlation/request identifiers, and data-plane schema compatibility metadata.
- Detection-result persistence occurs in `services/report-producer/src/claimguard_report_producer/detection_results.py` within an explicit transaction and is already idempotent by exact tenant/claim/version identity.
- Existing historical fraud and registry tables are deeply embedded in repositories, API tests, web investigation pages, and desktop investigation views. They are therefore preserved for read compatibility instead of destructively renamed or rewritten.

## Implemented boundary

- Migration 0016 adds immutable, tenant-scoped `detection_signals` records referencing exact immutable detection results.
- An `AFTER INSERT` trigger creates exactly one `SIGNAL_GENERATED` signal in the same database transaction as result persistence.
- A detection-result guard rejects executable adverse-action or publication commands with `DOMAIN_SAFETY_PROHIBITED_DETECTION_COMMAND`.
- The public confirmation service fails closed with `NETWORK_NOTICE_GOVERNANCE_REQUIRED` and never delegates to the legacy repository.
- A database trigger independently blocks new `ACTIVE` shared-registry inserts.
- Historical fraud and registry rows remain readable and are not converted into Sequrin network notices.

## Deferred work

PR 2 should introduce the complete case/outcome-review model and independent human decision boundary. PR 3 should introduce the bounded, correctable network-notice model with sharing-authority approval, correction, withdrawal, suspension, expiry, propagation, and appeal semantics. Privacy-preserving linkage, environment separation, production provisioning, POPIA artefacts, and broad UI terminology migration remain separate workstreams.
