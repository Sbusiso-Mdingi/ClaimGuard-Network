# ClaimGuard Operations Runbook

This runbook captures production operational checks for the current architecture without changing product behavior.

## Runtime Health Endpoints

API endpoints:

- `GET /health`: basic service heartbeat
- `GET /live`: process liveness
- `GET /ready`: dependency readiness details (report storage and database reachability)

Recommended quick check:

```bash
curl -fsS https://claimguard-api.azurewebsites.net/health
curl -fsS https://claimguard-api.azurewebsites.net/live
curl -fsS https://claimguard-api.azurewebsites.net/ready
```

## Logging Signals

API now emits structured JSON logs for:

- `http_request`
- `claims_ingested`
- `producer_trigger_completed`
- `claims_ingestion_failed`
- `fraud_confirmed`
- `fraud_confirmation_failed`
- `api_server_started`
- `unhandled_rejection`
- `uncaught_exception`

Each request includes or propagates `x-request-id` so operators can correlate ingestion, confirmation, and error paths.

Producer runtime emits structured JSON logs for:

- `producer_attempt_started`
- `producer_attempt_succeeded`
- `producer_attempt_failed`
- `producer_run_completed`
- `producer_run_failed`

## Deployment Verification

GitHub Actions CI deploy step verifies runtime after deployment:

- API `GET /health`
- API `GET /ready`
- web root `GET /`

Deployment is marked failed if probes do not recover within retries.

## Incident Triage Flow

1. Check deployment status in GitHub Actions.
2. Probe API/web health endpoints.
3. Inspect recent API logs by `requestId` and event type.
4. Inspect producer runtime logs for failed attempts and durations.
5. If report read fails, verify report storage pointer (`latest.json`) and blob accessibility.

## Investigation Playbooks

### Failed Ingestion

1. Filter API logs for `event=claims_ingestion_failed`.
2. Group by `message` and `requestId` to isolate the dominant failure mode.
3. Confirm corresponding HTTP records from `event=http_request` and `path=/claims/ingest`.
4. Verify database connectivity via `GET /ready` checks (`databaseReachable`).
5. If ingestion succeeded but no downstream report was produced, continue with failed producer run playbook.

### Failed Producer Run

The deployed report producer is a native Azure Container Apps scheduled job named `claimguard-report-producer`. GitHub Actions builds, configures, and smoke-verifies the job; Azure runs the queue drain every five minutes.

1. Inspect the latest Container Apps job execution and filter logs for `event=producer_run_failed`, `event=outbox_job_retry_scheduled`, and `event=outbox_job_dead_lettered`.
2. Confirm that `event=data_plane_scope_verified` precedes outbox leasing; if it does not, inspect organisation, route, schema, and Key Vault configuration.
3. Validate report storage configuration (`REPORT_STORAGE_*` values), the worker identity's blob role, and blob accessibility.
4. Confirm whether a later execution emitted `event=producer_run_completed` and `event=outbox_drain_completed`.
5. Escalate dead-lettered jobs for operator review rather than replaying them blindly.

### Missing Report

1. Check API request logs for `path=/detection/report` and high `status=503` rates.
2. Confirm latest producer completion (`event=producer_run_completed`).
3. Verify report publication event fields (`version`, `latest_pointer_path`).
4. Validate `latest.json` pointer and target report blob accessibility.
5. Re-run producer deployment trigger if no successful completion exists in expected interval.

### Failed Deployment

1. Review `.github/workflows/ci.yml` run summary for failed deploy steps.
2. Inspect deploy verification probe output (`/health`, `/ready`, `/`).
3. If API probe fails, inspect startup logs for `event=api_server_started`, `unhandled_rejection`, or `uncaught_exception`.
4. Validate artifact integrity and deploy packaging output from CI artifacts.
5. Roll back to last successful artifact/deployment run according to `docs/azure-production-architecture.md`.

### API Outage

1. Check API liveness and readiness:
	- `GET /health`
	- `GET /live`
	- `GET /ready`
2. Inspect API logs for spike in `status>=500` from `event=http_request`.
3. Correlate failed requests by `requestId` to recent ingestion or confirmation operations.
4. Check dependency state from readiness checks (`reportStorageReachable`, `databaseReachable`).
5. Recover service or perform rollback using the deployment runbook.

## Current Known Limits (Out of Scope)

- Alert rules are not codified in this repository.
- Dashboards are not codified in this repository.
- Managed identity assignment for App Service is not currently enabled.
- API authorization and rate limiting are not currently enabled.

These are tracked as technical debt and require environment-level policy decisions.
