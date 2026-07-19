# ClaimGuard Network

Tenant-isolated medical-claim ingestion, fraud detection, investigation, and reporting platform.

## Workspace scripts

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## Runtime data flow

ClaimGuard does not generate runtime claims. Medical-aid systems and approved test producers submit tenant-scoped batches to `POST /claims/ingest`. The API commits reference records and claims atomically, writes an outbox job in the same transaction, and the report worker reloads the authoritative tenant snapshot before detection.

See `docs/claim-ingestion.md` for the request contract, machine-to-machine authentication, limits, and the future desktop-producer handoff.

Platform administrators can create, provision, upgrade, and explicitly activate medical aids from the web interface. After activation, the same page issues a per-server credential once and displays the bounded claim-sync instructions; routine onboarding does not require Azure Portal access.
The Windows host baseline is documented in `docs/desktop-producer-windows.md`.

## Runbook

For production operations and incident checks, see `docs/operations-runbook.md`.

Phase 12 production-shaped hardening artifacts:

- `docs/phase-12-production-shaped-hardening.md`
- `docs/production-shaped-architecture.md`
- `docs/secrets-and-configuration.md`
- `docs/environment-matrix.md`
- `docs/access-control-matrix.md`
- `docs/threat-model.md`
- `docs/risk-register.md`
- `docs/incident-response-plan.md`
- `docs/backup-and-restore-runbook.md`
- `docs/production-readiness-qualification-plan.md`

Observability deliverables for Phase 6:

- `docs/observability-dashboards.md`
- `docs/alert-definitions.md`

## Production Architecture Direction

ClaimGuard follows a strict producer/consumer boundary:

- `services/detection-engine` performs fraud analysis only.
- `services/report-producer` orchestrates runs and publishes report artifacts.
- `apps/api` is the authenticated claim-ingestion boundary and a read-only report consumer.
- `apps/web` consumes API endpoints only.

### Report producer worker

```bash
cd services/report-producer
uv sync
CONTROL_PLANE_MYSQL_URL='mysql://...' \
MYSQL_URL='mysql://...' \
REPORT_WORKER_ORGANISATION_ID='organisation-id' \
INTERNAL_SERVICE_ORGANISATION_IDS='organisation-id' \
uv run claimguard-produce-report worker once --backend file --output-dir reports
```

For Azure mode, use backend `azure_blob` with storage configuration and managed identity.

## Phase 5 Investigator UI

The web app now exposes an investigator workspace built on React Router + Tailwind/shadcn-style primitives and backed by the existing detection APIs:

- `GET /detection/report`
- `GET /detection/graph`
- `GET /detection/risk`

### Navigation

- `Dashboard` - KPI overview and recent detections
- `Claims Explorer` - searchable, sortable claim table
- `Claim Details` - entity/relationship context plus claim risk panel
- `Network Graph` - zoom/pan/select graph view with connected node highlight
- `Risk Panel` - severity, explainability, triggered rules, and evidence
- `Detection History` - timeline of captured snapshots

### Refresh behavior

- `Live Refresh` polls the claims and detection endpoints every 15 seconds.
- `Refresh Off` freezes auto-refresh until it is enabled again.
- `Refresh now` performs an immediate fetch in both modes.

### Screenshot Placeholder

Add Phase 5 UI screenshots to this section during release packaging.
