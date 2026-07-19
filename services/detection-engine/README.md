# ClaimGuard Detection Engine

Phase 4 detection slice for the ClaimGuard Network monorepo.

This service analyzes tenant-scoped claim snapshots and produces a structured
detection report with graph entities, graph relationships, modular rule hits,
and deterministic risk scoring. Production snapshots are loaded from the operational database by `services/report-producer`.

## Quick start

```bash
uv sync
uv run python -m unittest discover -s tests -p 'test_*.py'
```

## Output

The report worker invokes the engine with one authoritative tenant snapshot and receives:

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

- `loader.py`: validates and adapts authoritative tenant snapshot records into typed records.
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
