# ClaimGuard Detection Engine

Phase 4 detection slice for the ClaimGuard Network monorepo.

This service analyzes the synthetic Phase 1 CSV output and produces a structured
detection report with graph entities, graph relationships, modular rule hits,
and deterministic risk scoring.

## Quick start

```bash
uv sync
uv run claimguard-detect --data-dir ../../packages/data-generator/data --top-n 10
uv run python -m unittest discover -s tests -p 'test_*.py'
```

## Output

The CLI writes JSON with one section per scheme directory:

- provider findings ranked by anomaly score
- member findings ranked by anomaly score
- summary metrics for the scheme
- detection pipeline output:
	- entities
	- relationships
	- triggered rules
	- risk score (0-100)
	- evidence
	- graph summary
	- ledger reference placeholder

## Modules

- `loader.py`: reads Phase 1 CSV exports into typed records.
- `analytics.py`: scheme-level provider/member scoring and network evaluation.
- `pipeline.py`: raw-claim normalization, entity extraction, relationship graph construction, and detection report assembly.
- `rule_engine.py`: modular detection rules (shared devices, shared addresses, reused bank accounts, reused phone numbers, reused emails, suspicious chains, unusually connected entities, repeat offenders, circular relationships).
- `graph_store.py`: storage abstraction (`InMemoryGraphStore`, `GremlinGraphStore`) so detection logic is not coupled to a concrete graph database implementation.

## Determinism

Given the same input claims, the detection pipeline returns byte-for-byte identical JSON content for:

- normalized entities and relationships
- triggered rules
- risk score and severity
- evidence ordering

This supports reproducible test runs and stable CI assertions.