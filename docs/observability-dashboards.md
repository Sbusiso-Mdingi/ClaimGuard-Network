# Phase 6 Dashboard Definitions

This document defines production dashboards for the current ClaimGuard runtime using only telemetry already emitted by the application and CI workflows.

## Data Sources

- API structured logs (events from `apps/api/src/backend.js` and `apps/api/src/backend-server.js`)
- Producer structured logs (events from `services/report-producer/src/claimguard_report_producer/worker.py` and `cli.py`)
- API health endpoint probes (CI deploy verification)
- GitHub Actions workflow runs (`ci.yml`, `producer-deploy.yml`)

## Common Log Fields

- `timestamp`
- `level`
- `service`
- `event`
- `requestId` (API request correlation)

## Dashboard 1: API Availability and Latency

Purpose: Validate API uptime and route latency for investigator-facing endpoints.

Widgets:

1. API request volume over time
- Source: `event=http_request`
- Group by: `path`, `method`

2. API latency p50/p95/p99
- Source: `event=http_request`
- Metric: `durationMs`
- Group by: `path`

3. Failed requests (4xx/5xx)
- Source: `event=http_request`
- Filter: `status >= 400`
- Group by: `path`, `status`

4. Health and readiness checks
- Source: `event=http_request`
- Filter: `path in (/health, /live, /ready)`
- Group by: `status`

## Dashboard 2: Ingestion and Fraud Operations

Purpose: Track ingestion throughput and investigator fraud confirmation operations.

Widgets:

1. Claims ingested per interval
- Source: `event=claims_ingested`
- Metric: `received`

2. Inserted vs updated claims
- Source: `event=claims_ingested`
- Metrics: `inserted`, `updated`

3. Ingestion failures
- Source: `event=claims_ingestion_failed`
- Group by: `message`

4. Fraud confirmations count
- Source: `event=fraud_confirmed`
- Group by: `schemeId`

5. Fraud confirmation failures
- Source: `event=fraud_confirmation_failed`
- Group by: `message`

## Dashboard 3: Producer Runtime Health

Purpose: Validate queue draining, report publication, retries, and worker failures.

Widgets:

1. Outbox batches leased
- Source: `event=outbox_batch_leased`
- Metric: `job_count`
- Group by: `worker_id`

2. Producer drain completions
- Source: `event=outbox_drain_completed OR event=producer_run_completed`
- Metrics: `job_count`, `batch_count`, count of runs

3. Producer run failures and dead letters
- Source: `event=producer_run_failed OR event=outbox_job_dead_lettered`
- Group by: `error_type`, `tenant_id`, `job_type`

4. Retry activity
- Source: `event=outbox_job_retry_scheduled`
- Metric: `retry_delay_seconds`
- Group by: `error_type`, `tenant_id`

5. Report publication confirmations
- Source: `event=outbox_job_completed`
- Fields: `covered_report_id`, `covered_watermark`, `tenant_id`, `correlation_id`

## Dashboard 4: Deployment and Release Health

Purpose: Track CI/CD execution health and deploy stability.

Widgets:

1. CI pipeline pass/fail trend
- Source: GitHub Actions runs for `.github/workflows/ci.yml`

2. Deploy job pass/fail trend
- Source: `ci.yml` deploy job history

3. Producer deployment history
- Source: `producer-deploy.yml` run history

4. Post-deploy probe failures
- Source: CI logs for deployment verification step (`/health`, `/ready`, `/` probes)

## Minimum Dashboard Review Cadence

- During active incidents: every 5 minutes
- Normal production operation: at least daily
- Release windows: during each deployment and 30 minutes post-release
