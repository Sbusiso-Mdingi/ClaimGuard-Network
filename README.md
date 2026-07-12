# ClaimGuard Network

Monorepo foundation for ClaimGuard phases.

## Workspace scripts

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## Phase 1 data generator

```bash
cd packages/data-generator
uv sync --all-groups
uv run claimguard-generate --config generation_config.yaml
uv run pytest tests --cov=src/claimguard --cov-report=xml
```

## Runbook

See `docs/Phase0_Implementation_Runbook.md` for complete Phase 0 setup details, including external setup steps for GitHub, Codecov, Doppler, Sentry, and New Relic.

For production operations and incident checks, see `docs/operations-runbook.md`.

## Production Architecture Direction

ClaimGuard follows a strict producer/consumer boundary:

- `services/detection-engine` performs fraud analysis only.
- `services/report-producer` orchestrates runs and publishes report artifacts.
- `apps/api` is a read-only report consumer.
- `apps/web` consumes API endpoints only.

### Report producer runtime

```bash
cd services/report-producer
uv sync
uv run claimguard-produce-report --data-dir ../../packages/data-generator/data --backend file --output-dir reports
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

### Demo Mode

- `Live Replay` polls all detection endpoints every 15 seconds.
- `Static Snapshot` freezes auto-refresh and keeps the current dataset until manual refresh.
- `Refresh now` performs an immediate fetch in both modes.

### Screenshot Placeholder

Add Phase 5 UI screenshots to this section during release packaging.
