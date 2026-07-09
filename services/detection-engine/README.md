# ClaimGuard Detection Engine

Phase 4 detection slice for the ClaimGuard Network monorepo.

This service analyzes the synthetic Phase 1 CSV output and produces a ranked
JSON report of suspicious providers and members. It is intentionally simple
at first: a stdlib-only heuristic engine that can be replaced later with a
GLM/graph pipeline without changing the CLI contract.

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

## Current scope

The first version focuses on cheap, explainable heuristics:

- provider average claim amount outliers
- unusually dense provider claim volume
- members with same-day activity across multiple providers

That is enough to validate the data flow now and gives the later model-based
version a stable place to land.