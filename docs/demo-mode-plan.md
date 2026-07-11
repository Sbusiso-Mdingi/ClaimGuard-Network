# ClaimGuard Demo Mode Plan

## Goal
Show a convincing, non-empty pilot demo without requiring real-time production data.

The demo should reuse the real API and web dashboard shapes so the pilot behaves like the future product, but all data comes from controlled synthetic scenarios.

## Approach

### 1. Seeded data source
Use the existing synthetic generator output as the base dataset.

- Reuse the Phase 1 synthetic schemes, members, providers, claims, and ledger entries.
- Keep the data source deterministic so the demo is repeatable.
- Prefer scenario-driven seed sets over random generation during the demo.

### 2. Replay layer
Add a lightweight replay mechanism that advances the dataset over time.

- Periodically add or update claims.
- Rotate a few claims between statuses such as `received`, `reviewing`, `flagged`, and `resolved`.
- Emit visible changes in counts, alerts, and trend charts.
- Keep the timing predictable so the demo is easy to narrate.

### 3. API contract
Expose the same endpoints the dashboard will use in real operation.

- Serve `GET /health` and `GET /meta` from the live API as usual.
- Add or extend read endpoints so the dashboard can fetch:
  - claim summaries
  - recent alerts
  - scheme trend metrics
  - latest ledger activity
- Include `updatedAt` timestamps so the UI can show motion.

### 4. Web dashboard behavior
The UI should never default to empty panels during a demo.

- Render a helpful empty state only when data is genuinely missing.
- Poll the API or refresh on a short interval so widgets visibly change.
- Show at least one chart, one alert feed, and one list with active rows.
- Use the same component structure as the real product so the demo is credible.

## Demo scenarios
Use a small set of scripted states instead of random noise.

1. Stable baseline
- low alert volume
- mostly normal claim flow
- charts show modest activity

2. Investigation spike
- a burst of suspicious claims
- new alerts appear
- one scheme or provider becomes a focus area

3. Resolved incident
- flagged claims move to closed states
- alert volume drops
- dashboard shows recovery

## Success criteria

- The dashboard always shows meaningful data.
- The API stays on the real app shape used by later phases.
- The demo can be repeated from a known starting snapshot.
- The state changes are visible enough to narrate live.
- No fake production claims are presented as real claims.

## Implementation order for the next phase

1. Add a demo scenario selector or fixed scenario mode.
2. Build the replay/update loop in the API layer.
3. Wire the dashboard to refresh from the same endpoints.
4. Add a small regression test so demo artifacts remain deterministic.
5. Document the demo start commands and demo reset procedure.
