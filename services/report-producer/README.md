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
uv run claimguard-produce-report worker --once --backend file --output-dir reports
```

The worker leases claim-ingestion outbox jobs and always analyzes a fresh tenant-scoped database snapshot. It has no filesystem or generated-claims ingestion mode.

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
- creates or updates an Azure Container Apps Job
- starts a producer execution
- supplies `CONTROL_PLANE_MYSQL_URL`, `MYSQL_URL`, and an explicit single-organisation scope

Required GitHub configuration:

- secrets: `CLAIMGUARD_CONTROL_PLANE_MYSQL_URL`, `CLAIMGUARD_MYSQL_URL`, `REPORT_STORAGE_CONNECTION_STRING`
- variables: `REPORT_STORAGE_CONTAINER`, `REPORT_WORKER_ORGANISATION_ID`, `INTERNAL_SERVICE_ORGANISATION_IDS`
