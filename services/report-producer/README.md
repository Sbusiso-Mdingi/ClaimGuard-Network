# ClaimGuard Report Producer

Durable worker for publishing detection reports from authoritative tenant snapshots.

## Responsibilities

- Trigger handling (manual/scheduled/event)
- Detection invocation (delegates to detection-engine)
- Report publishing (versioned artifacts + latest pointer + metadata)
- Retry handling and telemetry hooks

## Durable worker

```bash
uv sync
CONTROL_PLANE_MYSQL_URL='mysql://...' \
MYSQL_URL='mysql://...' \
REPORT_WORKER_ORGANISATION_ID='organisation-id' \
INTERNAL_SERVICE_ORGANISATION_IDS='organisation-id' \
uv run claimguard-produce-report worker once --backend file --output-dir reports
```

The worker leases claim-ingestion outbox jobs and always analyzes a fresh tenant-scoped database snapshot. It has no filesystem or generated-claims ingestion mode. Before leasing, it resolves the organisation's one active control-plane route:

- `legacy_shared` uses `MYSQL_URL` and requires a verified legacy tenant mapping.
- `private_database` resolves the route's username, password, host, and database Key Vault references with managed identity; it never logs or persists the assembled connection URL.

Both paths verify the database's singleton data-plane metadata and fail closed on an inactive organisation, unsupported schema, changed route generation, changed credentials, or mismatched logical database identity.

Scheduled deployments use `worker drain`: each execution processes bounded batches until the queue is empty, then exits. `REPORT_WORKER_MAX_BATCHES_PER_RUN` defaults to `100` so an unexpectedly busy queue cannot make one execution run forever.

## Azure-ready mode

Use backend `azure_blob` with:

- `REPORT_STORAGE_ACCOUNT_URL`
- `REPORT_STORAGE_CONTAINER`
- optional `AZURE_STORAGE_CONNECTION_STRING` for local development

Managed identity is used automatically when no connection string is set.

## Deployment automation

Producer deployment is handled by GitHub Actions workflow:

- `.github/workflows/producer-deploy.yml`

This workflow:

- builds and pushes producer image to Azure Container Registry
- creates or updates a native five-minute Azure Container Apps scheduled job
- verifies a worker execution before considering deployment successful
- resolves `CONTROL_PLANE_MYSQL_URL` and `MYSQL_URL` through Key Vault references
- uses a dedicated managed identity for ACR pull, Key Vault read, and report-blob write access
- supplies an explicit single-organisation scope
- supports only canonical schema version `10` by default

Required Azure bootstrap:

- user-assigned identity: `claimguard-report-worker-identity`
- `AcrPull` on `claimguardacr11e`
- `Key Vault Secrets User` on the API control-plane and operational database secrets
- for a `private_database` worker, `Key Vault Secrets User` on exactly that route's four referenced secrets
- `Storage Blob Data Contributor` on only the `claimguard-reports` container in `cgrpt0715sa`

`infra/main.bicepparam` intentionally leaves `reportWorkerPrivateSecretNames` empty until an organisation is selected and its route has been verified at schema version `10`. Do not grant vault-wide access to make private routing work.

Required non-secret GitHub variables:

- `REPORT_WORKER_ORGANISATION_ID`
- `INTERNAL_SERVICE_ORGANISATION_IDS`

Database and storage credentials must not be copied into GitHub secrets.
