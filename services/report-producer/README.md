# ClaimGuard Report Producer

Producer runtime for publishing detection reports into storage.

## Responsibilities

- Trigger handling (manual/scheduled/event)
- Detection invocation (delegates to detection-engine)
- Report publishing (versioned artifacts + latest pointer + metadata)
- Retry handling and telemetry hooks

## Quick start

```bash
uv sync
uv run claimguard-produce-report --data-dir ../../packages/data-generator/data --backend file --output-dir reports
```

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
