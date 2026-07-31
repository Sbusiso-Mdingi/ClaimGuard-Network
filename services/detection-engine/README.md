# ClaimGuard Detection Engine

[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)

Tenant-scoped fraud detection service for the ClaimGuard Network monorepo.

This service analyzes tenant-scoped claim snapshots and produces a structured detection report with graph entities, graph relationships, modular rule hits, and deterministic risk scoring. Production snapshots are loaded from the operational database by `services/report-producer`.

## Quick Start

```bash
uv sync
uv run python -m unittest discover -s tests -p 'test_*.py'
```

## Output

The report worker invokes the engine with one authoritative tenant snapshot and receives:

- Provider findings ranked by anomaly score
- Member findings ranked by anomaly score
- Summary metrics for the scheme
- Detection pipeline output:
  - Entities
  - Relationships
  - Triggered rules
  - Risk score (0–100)
  - Evidence
  - Graph summary
  - Ledger reference placeholder

## Modules

| Module | Description |
|--------|-------------|
| `loader.py` | Validates and adapts authoritative tenant snapshot records into typed `DataBundle` records |
| `analytics.py` | Scheme-level provider/member scoring, network evaluation, and anomaly detection |
| `pipeline.py` | Raw-claim normalization, entity extraction, relationship graph construction, and detection report assembly |
| `rule_engine.py` | Modular detection rules: shared devices, shared addresses, reused bank accounts, reused phone numbers, reused emails, suspicious chains, unusually connected entities, repeat offenders, circular relationships |
| `graph_store.py` | Storage abstraction (`InMemoryGraphStore`, `GremlinGraphStore`) so detection logic is not coupled to a concrete graph database |
| `orchestration.py` | End-to-end detection run orchestration. Defines `DetectionSnapshot`, severity classification, and full report assembly with contract versioning |
| `reference_data.py` | Static reference data: billing codes, specialty definitions (GP, Dentist, Radiology, etc.), claim/provider share ratios, and severity distributions |

## Determinism

Given the same input claims, the detection pipeline returns byte-for-byte identical JSON content for:

- Normalized entities and relationships
- Triggered rules
- Risk score and severity
- Evidence ordering

This supports reproducible test runs and stable CI assertions.
