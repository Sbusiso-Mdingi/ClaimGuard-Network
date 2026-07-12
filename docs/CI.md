**CI Validation Guide**

- **Purpose:** Validate builds/tests for the monorepo and deploy API/web artifacts on pushes to `main`.
- **Workflow file:** [.github/workflows/ci.yml](.github/workflows/ci.yml)
- **Producer deploy workflow:** [.github/workflows/producer-deploy.yml](.github/workflows/producer-deploy.yml)

What the CI does:
- Checks out the repository and installs JavaScript dependencies using `pnpm` at the workspace root.
- Caches the pnpm store to speed subsequent runs.
- Installs Python dependencies for the `packages/data-generator` using `uv sync`.
- Runs `pnpm turbo run lint test build --filter=...[origin/${BASE_REF}]` to run lint/test/build for affected packages relative to the PR base.
- Explicitly builds and tests the web app:
  - `pnpm --filter ./apps/web run build`
  - `pnpm --filter ./apps/web run test -- --run`
- Explicitly builds and tests the API package (if `apps/api/package.json` exists):
  - `pnpm --filter ./apps/api run build`
  - `pnpm --filter ./apps/api run test`
- Uploads `apps/web/dist` as an artifact for inspection (no deploy)
- Runs Python tests and uploads coverage to Codecov (if `CODECOV_TOKEN` present).
- On `push` to `main`, packages deployable zip artifacts for `apps/web` and `apps/api`, then deploys both via Azure Web App ZipDeploy.
- Retains CI artifacts (`web-dist`, deploy zips) for 14 days to support incident forensics and fast rollback packaging.
- Verifies post-deploy runtime health with endpoint probes:
  - API `GET /health`
  - API `GET /ready`
  - web root `GET /`

Local validation (recommended before opening PR):

1. Install workspace deps:

```bash
pnpm install
```

2. Build the web app:

```bash
pnpm --filter ./apps/web run build
```

3. Run the web tests:

```bash
pnpm --filter ./apps/web run test -- --run
```

4. Build and test the API (if relevant):

```bash
pnpm --filter ./apps/api run build
pnpm --filter ./apps/api run test
```

Quality gates:
- Any build, test, or lint failure will fail CI.
- On pull requests, the workflow is validation-only (no deployment).
- On pushes to `main`, the workflow deploys API and web resources in Azure.
- The deploy job fails if health verification probes fail after retries.

Notes & Troubleshooting:
- This workflow uses `pnpm` at the workspace root to avoid duplicated installs for each package.
- If you prefer `npm` locally, you can still run the scripts in the `apps/web` folder using `npm run build`/`npm test` — but CI uses `pnpm`.
- Producer runtime deployment is intentionally separated into a manual workflow to avoid coupling API/web deploy cadence with batch producer releases.
