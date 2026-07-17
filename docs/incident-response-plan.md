# ClaimGuard Incident Response Plan

## Scope

This plan covers API outages, authentication issues, tenant-isolation concerns, report-storage failures, worker failures, and deployment regressions.

## Triage Order

1. Determine whether the issue is availability, authorization, or data-plane related.
2. Check health endpoints and current deployment status.
3. Confirm whether the issue is isolated to one tenant or cross-cutting.
4. Inspect recent structured logs using correlation IDs.
5. Validate storage, database, and Key Vault dependencies.
6. Decide whether rollback is safe and documented.

## Playbooks

### API outage

- Probe `/health`, `/live`, and `/ready`.
- Check for crash loops or startup failures.
- Validate deployment history and the latest artifact.
- Roll back only if a known-good artifact and path exist.

### Authentication or session failure

- Confirm auth mode.
- Check cookie and CSRF settings.
- Validate origin allow-listing.
- Confirm login throttling and session storage behavior.

### Tenant isolation concern

- Verify the affected tenant route and data-plane metadata.
- Check for header spoofing or routing bypass.
- Treat any cross-tenant read/write as a stop-the-line event.

### Report storage failure

- Validate report storage backend configuration.
- Confirm the latest pointer object and container access.
- Check producer completion logs and worker state.

### Worker failure

- Confirm identity and secret delivery.
- Validate job execution status against control-plane source of truth.
- Check retries, container start state, and dependency errors.

## Communication

- Notify platform, API, and data-operations owners according to the impacted component.
- Preserve correlation IDs and timestamps.
- Avoid exposing claim payloads in status updates.

## Recovery and Rollback

- Every live change requires a rollback path.
- Revert one control surface at a time.
- Revalidate health and tenant-isolation checks after rollback.
