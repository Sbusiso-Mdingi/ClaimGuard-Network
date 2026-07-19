# Phase 6 Alert Definitions

This document defines production alert policies for ClaimGuard using telemetry and checks that already exist.

No Azure resources are provisioned by this document; it is an operations definition for configuring alerts in the current observability platform.

## Alert 1: API Unavailable

- Condition: `GET /health` or `GET /live` fails continuously for 5 minutes
- Signal source: API endpoint probes and/or `http_request` failures for health endpoints
- Severity: Critical
- Notify: On-call operations channel
- Runbook: `docs/operations-runbook.md` (API outage flow)

## Alert 2: Producer Failure

- Condition: any `producer_run_failed` event, failed Container Apps job execution, or `outbox_job_dead_lettered` event
- Signal source: Producer structured logs and Azure Container Apps job execution status
- Severity: High
- Notify: Data operations + platform on-call
- Runbook: `docs/operations-runbook.md` (failed producer run)

## Alert 3: No Report Generated in Expected Interval

- Condition: pending/retry outbox depth is non-zero while no `outbox_job_completed` event occurs within the agreed processing interval
- Signal source: Producer structured logs and outbox status telemetry
- Severity: High
- Notify: Data operations + on-call
- Runbook: `docs/operations-runbook.md` (missing report)

## Alert 4: Detection Report Unavailable

- Condition: sustained non-200 responses on `GET /detection/report` or repeated `status=503` for that path
- Signal source: API `http_request` logs
- Severity: High
- Notify: API on-call
- Runbook: `docs/operations-runbook.md` (missing report)

## Alert 5: Deployment Failure

- Condition: failed deploy job in `.github/workflows/ci.yml` or failed producer deployment run in `.github/workflows/producer-deploy.yml`
- Signal source: GitHub Actions run status
- Severity: High
- Notify: Release engineering + on-call
- Runbook: `docs/CI.md` and `docs/operations-runbook.md`

## Alert 6: Health Endpoint Failure After Deploy

- Condition: CI deploy verification step fails endpoint probes (`/health`, `/ready`, `/`)
- Signal source: CI deploy verification step result
- Severity: Critical during release window
- Notify: Release engineering + on-call
- Runbook: `docs/CI.md`

## Alert 7: Excessive API Errors

- Condition: error ratio threshold breach (for example, >= 5% status >= 500 over 10 minutes)
- Signal source: API `http_request` log stream
- Severity: High
- Notify: API on-call
- Runbook: `docs/operations-runbook.md` (API outage and failed ingestion triage)

## Alert 8: Repeated Ingestion Failures

- Condition: repeated `claims_ingestion_failed` events above agreed threshold (for example, >= 5 in 15 minutes)
- Signal source: API structured logs
- Severity: Medium to High
- Notify: Operations + fraud platform owners
- Runbook: `docs/operations-runbook.md` (failed ingestion)

## Implementation Notes

- Alert thresholds should be finalized with on-call teams for current load profile.
- Alert routes should use environment-specific notification channels.
- All alert configurations should reference `requestId` and `event` fields for rapid triage.
