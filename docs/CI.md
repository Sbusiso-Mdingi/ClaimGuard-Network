**CI Validation Guide**

- **Purpose:** Validate builds and tests for the monorepo on every push and pull request to `main`.
- **Workflow file:** [.github/workflows/ci.yml](.github/workflows/ci.yml)

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
- The workflow does not perform any deployments or modify Azure resources.

Notes & Troubleshooting:
- This workflow uses `pnpm` at the workspace root to avoid duplicated installs for each package.
- If you prefer `npm` locally, you can still run the scripts in the `apps/web` folder using `npm run build`/`npm test` — but CI uses `pnpm`.
