# ClaimGuard Network

Monorepo foundation for ClaimGuard phases.

## Workspace scripts

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## Phase 1 data generator

```bash
cd packages/data-generator
uv sync --all-groups
uv run claimguard-generate --config generation_config.yaml
uv run pytest tests --cov=src/claimguard --cov-report=xml
```

## Runbook

See `docs/Phase0_Implementation_Runbook.md` for complete Phase 0 setup details, including external setup steps for GitHub, Codecov, Doppler, Sentry, and New Relic.
