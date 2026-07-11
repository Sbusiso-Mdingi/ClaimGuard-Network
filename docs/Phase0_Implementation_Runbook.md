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
  database/
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
- API packaging rule: keep the untouched `pnpm --filter ./apps/api deploy` output, zip it with `zip -y`, and do not flatten pnpm symlinks with `rsync -aL`. Flattening caused runtime `ERR_MODULE_NOT_FOUND` failures for workspace and transitive packages such as `mysql2`.
- Only `.github/workflows/ci.yml` should deploy on push; the legacy API workflow stays manual-only via `workflow_dispatch`.

## 6) External setup (manual, outside repo)

### GitHub

1. Open repository settings.
2. Enable branch protection for `main`.
3. Require passing checks from CI workflow.
4. Require pull requests before merge.

### Codecov

1. Install Codecov GitHub app for this repository.
2. Add the repository secret `CODECOV_TOKEN` in GitHub Actions secrets and variables.
3. The CI workflow uploads `packages/data-generator/coverage.xml` to Codecov after tests run.

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
4. If you use Azure for MySQL, set `MYSQL_URL` to the Azure Database for MySQL connection string and keep it pointed at the synthetic seed data for now.
5. If `COSMOSDB_CONNECTION_STRING` is not needed for your current phase, leave it empty until you actually add a Cosmos-backed service.
6. Validate locally:

```bash
doppler setup
doppler configs
doppler run -- env
```

### Azure Database for MySQL

1. Create an Azure Database for MySQL Flexible Server.
2. Create a database for ClaimGuard and a dedicated user.
3. Allow your local IP address through the Azure firewall so you can run migrations and seed data.
4. Copy the Azure MySQL connection string into Doppler as `MYSQL_URL`.
5. Run the database setup from `packages/database`:

```bash
pnpm migrate
pnpm seed
```

6. Start the API with `MYSQL_URL` set and check `GET /ledger/latest`.

### Sentry

1. Create org and two projects: `claimguard-web`, `claimguard-api`.
2. Add DSNs to Doppler (`SENTRY_DSN_WEB`, `SENTRY_DSN_API`).
3. Trigger API test error:

```bash
node apps/api/src/index.js
# open /test-error on localhost:3001
```

4. Trigger web test error:

```bash
cd apps/web
doppler run -- node src/server.js
# open http://127.0.0.1:3002/
# click "Throw Test Error"
```

### New Relic

1. Create an APM app entity for API service.
2. Add license/app values to Doppler.
3. Run the smoke server through Doppler:

```bash
cd apps/api
doppler run -- node src/newrelic-smoke.cjs
```

4. In another terminal, trigger the smoke transaction:

```bash
curl -i http://127.0.0.1:3003/newrelic-test
```

5. Check the New Relic APM UI for the `ClaimGuard API` app and the custom `ClaimGuardSmoke` event.

## 8) Phase 3 backend foundation

The Phase 3 backend slice now includes a shared contract package and a persistence-focused API foundation:

- `packages/shared-schema/` for shared backend response shapes
- `packages/database/` for Drizzle schema and hash-chained ledger helpers
- `apps/api/` for Hono, tRPC, and the `/ledger/preview` route

Local validation commands:

```bash
cd packages/database
pnpm test

cd apps/api
pnpm test:backend
```

Useful backend endpoints:

- `GET /health`
- `GET /meta`
- `GET /ledger/preview`
- `GET /trpc/ping`

## 9) Phase 3 MySQL migration and seed flow

The development MySQL database is meant to be populated from the Phase 1 synthetic exports for now, then swapped later for real client or medical-aid integrations when the project matures.

Database package commands:

```bash
cd packages/database
pnpm migrate
pnpm seed
```

What the seed flow does:

- applies the initial MySQL schema from `packages/database/migrations/0001_initial.sql`
- loads `packages/data-generator/data/scheme_*/` CSV exports
- inserts schemes, members, providers, claims, and a bootstrap ledger entry
- keeps the data source synthetic until real integrations replace it later

### Manual steps for the runtime MySQL path

You need to do these by hand before the API can read from the seeded database:

1. Provision a MySQL database. If you are using Azure, use Azure Database for MySQL Flexible Server.
2. Paste its connection string into `MYSQL_URL`.
3. Run the migration and seed commands from `packages/database`:

```bash
pnpm migrate
pnpm seed
```

4. Start the API with `MYSQL_URL` set so `/ledger/latest` can use the runtime repository.
5. If you change the synthetic CSV exports later, rerun `pnpm seed` to refresh the MySQL data.

## 7) Security boundary

Do not store scheme-held tokenization keys in this repo or in Doppler.
Those keys remain in each scheme's own environment.
