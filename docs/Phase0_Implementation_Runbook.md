# ClaimGuard Network - Phase 0 Implementation Runbook

This runbook captures what has been implemented in-repo and what must be done in external systems.

## 1) Local prerequisites

Install required tools:

```bash
brew install pnpm
brew install uv
brew install dopplerhq/cli/doppler
brew install gh
```

## 2) Monorepo structure

The repository now uses this structure:

```text
apps/
  api/
  web/
services/
  detection-engine/
packages/
  data-generator/
  claimguard-sdk/
  shared-schema/
.github/workflows/
```

## 3) Root commands

From repository root:

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## 4) Data generator package (Phase 1) under uv

Run from `packages/data-generator`:

```bash
uv sync --all-groups
uv run claimguard-generate --config generation_config.yaml
uv run pytest tests --cov=src/claimguard --cov-report=xml
```

## 5) CI and coverage

- GitHub Actions workflow: `.github/workflows/ci.yml`
- Codecov config: `codecov.yml`
- Coverage target: 70%
- Separate flags: `python`, `typescript`

## 6) External setup (manual, outside repo)

### GitHub

1. Open repository settings.
2. Enable branch protection for `main`.
3. Require passing checks from CI workflow.
4. Require pull requests before merge.

### Codecov

1. Install Codecov GitHub app for this repository.
2. If token-based upload is required, add `CODECOV_TOKEN` in repository secrets.

### Doppler

1. Create project: `claimguard-network`.
2. Create configs: `dev`, `staging`, `production`.
3. Add placeholder secrets:
   - `MYSQL_URL`
   - `COSMOSDB_CONNECTION_STRING`
   - `SENTRY_DSN_WEB`
   - `SENTRY_DSN_API`
   - `NEW_RELIC_LICENSE_KEY`
   - `NEW_RELIC_APP_NAME`
   - `NODE_ENV`
4. Validate locally:

```bash
doppler setup
doppler configs
doppler run -- env
```

### Sentry

1. Create org and two projects: `claimguard-web`, `claimguard-api`.
2. Add DSNs to Doppler (`SENTRY_DSN_WEB`, `SENTRY_DSN_API`).
3. Trigger API test error:

```bash
node apps/api/src/index.js
# open /test-error on localhost:3001
```

4. Trigger web test error by wiring SDK in the future web framework and raising one error event.

### New Relic

1. Create an APM app entity for API service.
2. Add license/app values to Doppler.
3. Wire Node agent when Phase 3 API framework is introduced.

## 7) Security boundary

Do not store scheme-held tokenization keys in this repo or in Doppler.
Those keys remain in each scheme's own environment.
