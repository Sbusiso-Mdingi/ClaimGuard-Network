# CI validation guide

- **Purpose:** Validate builds/tests for the monorepo and deploy API/web artifacts on pushes to `main`.
- **Workflow file:** [.github/workflows/ci.yml](.github/workflows/ci.yml)
- **Producer deploy workflow:** [.github/workflows/producer-deploy.yml](.github/workflows/producer-deploy.yml)

What the CI does:

- Checks out the repository and installs JavaScript dependencies using `pnpm` at the workspace root.
- Uses lockfile-backed Node.js 24, pnpm, Python 3.12, and `uv` toolchains with dependency caching.
- Runs the complete monorepo lint and build graph.
- Runs JavaScript tests under V8 coverage and Python tests under `coverage.py` for the edge SDK, detection engine, and report worker.
- Uploads separate JavaScript and Python coverage artifacts to Codecov using GitHub OIDC.
- Uploads `apps/web/dist` as an inspection artifact.
- On `push` to `main`, packages deployable zip artifacts for `apps/web` and `apps/api`, then deploys both via Azure Web App ZipDeploy.
- Retains CI artifacts (`web-dist`, deploy zips) for 14 days to support incident forensics and fast rollback packaging.
- Runs operational database migrations from the repository lockfile before deployment.
- Verifies post-deploy runtime health with endpoint probes:
  - API `GET /health`
  - API `GET /ready`
  - web root `GET /` (accepts 200/301/302)
  - web index fallback `GET /index.html` (expects 200 if root is non-200)

Local validation (recommended before opening a PR):

1. Install workspace deps:

```bash
pnpm install
```

2. Run the same workspace gates used by CI:

```bash
pnpm lint
pnpm test
pnpm build
```

Quality gates:
- Any build, test, or lint failure will fail CI.
- On pull requests, the workflow is validation-only (no deployment).
- On pushes to `main`, the workflow deploys API and web resources in Azure.
- The deploy job fails if health verification probes fail after retries.

Notes & Troubleshooting:

- This workflow uses `pnpm` at the workspace root to avoid duplicated installs for each package.
- The report-worker deployment is intentionally separate so its container and durable outbox drain can be released independently.
- The producer workflow requires the control-plane and operational database secrets plus one explicitly allow-listed organisation scope.
