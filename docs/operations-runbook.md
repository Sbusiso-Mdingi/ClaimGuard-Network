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

## Current Known Limits (Out of Scope)

- Alert rules are not codified in this repository.
- Dashboards are not codified in this repository.
- Managed identity assignment for App Service is not currently enabled.
- API authorization and rate limiting are not currently enabled.

These are tracked as technical debt and require environment-level policy decisions.
