# Synthetic Demo Scenarios for Investigator Workflow

This document defines the synthetic demonstration dataset used for ClaimGuard proof-of-concept walkthroughs.

All entities, names, identifiers, and outcomes are fictional.

## Fictional schemes

- Nedbank Health (`A`)
- MedSecure (`B`)
- HealthFirst (`C`)

Each claim, member, and provider remains scheme-scoped. Scheme isolation is preserved.

## Seeded fraud scenario catalog

The data generator plants deterministic cases that map to existing detection behavior:

- Duplicate billing style abuse (high-frequency repeated billing patterns)
- Impossible treatment timelines (same-day geographically implausible events)
- Provider/member collusion rings
- Shared bank-account artifacts across linked entities
- Shared address clusters
- Repeat-offender members
- Circular relationship components in graph topology
- Cross-scheme provider reappearance/evasion
- Legitimate baseline claims that should resolve as dismissed after review

## Investigation outcome scenarios

The generator now emits synthetic investigation reports at:

- `packages/data-generator/data/ground_truth/investigation_reports.json`
- `packages/data-generator/data/docs/investigation_scenarios.md`

Each report includes:

- investigation ID
- investigator
- scheme
- provider
- member(s)
- evidence summary
- triggered rules
- investigation status
- final decision
- decision date

Status coverage:

- `CONFIRMED_FRAUD`
- `UNDER_INVESTIGATION`
- `DISMISSED`

## Ledger behavior expectations

Confirmed fraud reports are seeded into runtime ledger entries as `INVESTIGATOR_CONFIRMED_FRAUD` entries.

Under-investigation and dismissed reports are not written to ledger entries.

This preserves the Phase 5 workflow boundary:

- confirmed fraud => ledger evidence exists
- open/dismissed => no ledger evidence

## Why this dataset exists

This dataset is designed to support:

- realistic proof-of-concept demos
- repeatable investigator walkthroughs
- benchmark-ready synthetic cases for future Phase 7 evaluation work

No architecture, API contract, report schema, detection algorithm, or producer/consumer flow is changed by this dataset preparation.
