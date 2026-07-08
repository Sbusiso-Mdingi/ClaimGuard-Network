# ClaimGuard Network — Phase 0 Technical Specification
## Environment Setup: CI/CD, Observability, Secrets & Monorepo Foundation

This is the detailed build spec for Phase 0, expanding the one-line roadmap entry in the main technical spec's build roadmap (§10): *"Environment Setup: GitHub Actions, Codecov, Sentry, New Relic, Doppler, monorepo setup."* No code — this is the design, in the same spirit as the Phase 1 spec, which was itself expanded from its own one-line roadmap entry the same way.

**Revision note:** this replaces an earlier draft of this document, written without the main spec in hand. That draft scoped Phase 0 around data-generation conventions — seeded reproducibility, entity modeling, config/reference-data separation — that turn out to be good internal practice for the data-generator package specifically (§14), not what Phase 0 actually is. §10 settles that: Phase 0 is environment setup. This is a full rewrite around that, not a patch.

---

## 1. Purpose and scope

Phase 0 wires in the tooling every later phase depends on but none of them should have to set up for itself: CI that runs on every PR, a coverage gate, error tracking, an APM shell, a secrets manager, and — the structural piece underneath all of it — one monorepo instead of a repo per phase.

Two things worth stating up front, since "environment setup" could otherwise sprawl into either neighboring phase:

- **It's not the full observability build.** §9 of the main spec describes a mature state — release tracking, custom dashboards, business metrics like "Entity Resolution Accuracy" — that requires a real backend and detection engine to exist first. That maturity is explicitly Phase 6 (*"Observability & CI/CD: Sentry release tracking, AstraSecurity scanning, custom dashboards"*). Phase 0 wires the tools in and proves each one works; Phase 6 makes them useful.
- **It's not a greenfield setup.** Phase 1 already exists, built and working, as its own standalone repo. Phase 0 has to absorb it into the monorepo this spec establishes, not pretend it isn't there yet — §14 is the concrete migration checklist for exactly that.

---

## 2. Out of scope for Phase 0

- Any backend/API code — tRPC, Hono, Drizzle schema, MySQL, the hash-chained ledger. That's Phase 3.
- The Python Edge SDK itself (the HMAC tokenization logic). Phase 2.
- GLM anomaly scoring, graph analytics, entity resolution. Phase 4.
- The investigator frontend. Phase 5.
- AstraSecurity scanning, Sentry release tracking, custom dashboards, and other observability maturity beyond a working baseline. Phase 6 — Phase 0 only does initial account/SDK wiring, not the full build described in §9 of the main spec.
- The data-generation logic itself. Already built in Phase 1; unaffected by anything in this document except where §14 says otherwise.

---

## 3. Deliverables

1. A single monorepo (`claimguard-network`) replacing the current one-repo-per-phase pattern, with Phase 1's existing code migrated in, history intact.
2. A root-level polyglot task-runner configuration wiring Python and TypeScript packages into one `lint`/`test`/`build` surface (§5).
3. A GitHub Actions workflow running on every PR, scoped to only the packages a given change actually touches (§6).
4. Codecov wired into that workflow, gating PRs below the 70% threshold stated in §9 of the main spec, with Python and TypeScript coverage tracked separately (§7).
5. Sentry projects created and SDK initialization verified end-to-end with a deliberately-thrown test error, for both the eventual frontend and backend targets (§8).
6. A New Relic APM application shell, ready for the Node backend on day one of Phase 3 (§9).
7. A Doppler project with dev/staging/production configs and placeholder secrets — explicitly excluding any scheme-held key material (§10).
8. A migration checklist (§14) covering exactly what changes for Phase 1 as a result of all of the above, and what doesn't.

---

## 4. Monorepo structure & migration

This is a real structural change, not tidying. Phase 1's README documents initializing `claimguard-phase1` as its own independent repo. The main spec's roadmap calls for a monorepo instead — a deliberate choice for this stack, not just preference: the backend (Phase 3, TypeScript), the Edge SDK (Phase 2, Python), the detection engine (Phase 4, Python), and the frontend (Phase 5, TypeScript) all need to share types, schemas, and CI infrastructure in ways that are painful across separate repos and natural inside one.

Recommended top-level shape:

```
claimguard-network/
  apps/
    api/                    # tRPC + Hono backend — Phase 3
    web/                    # React 19 investigator dashboard — Phase 5
  services/
    detection-engine/       # Python GLM + graph analytics, containerized for DigitalOcean — Phase 4
  packages/
    claimguard-sdk/         # Python Edge SDK for local tokenization — Phase 2
    data-generator/         # Phase 1's existing generator, migrated in as-is (§14)
    shared-schema/          # Drizzle schema + tRPC router types, shared between api and web
  .github/workflows/
  docs/                     # this spec, the Phase 1 spec, and every later phase spec
  turbo.json
  pnpm-workspace.yaml
  package.json
  README.md
```

`apps/` vs. `services/` vs. `packages/` is worth being deliberate about rather than decorative: `apps/` = user- or externally-triggered deployables, `services/` = internal deployables nothing user-facing talks to directly, `packages/` = shared libraries that aren't independently deployed. Revisit the split once Phase 3/4 exist for real if it doesn't fit, but pick one now rather than letting folder names drift per PR.

**Migrating Phase 1 in:** `claimguard-phase1` has real git history worth keeping. `git subtree add --prefix packages/data-generator <path-or-url> main` (or `git filter-repo` first, if history needs rewriting before the merge) preserves it, rather than a flat copy-paste that discards it. Once migrated, archive the standalone `claimguard-phase1` repo — don't leave two writable copies of the same code sitting side by side, which is worse than the one-repo-per-phase pattern it's replacing.

---

## 5. Package & dependency management across the polyglot stack

The stack is genuinely polyglot — Python for the data generator, SDK, and detection engine; TypeScript for the API and frontend — so the monorepo's tooling has to manage both, not just the half that's easy.

**JS/TS side — pnpm workspaces + Turborepo.** pnpm workspaces defines the package graph (`apps/*`, `packages/*`); Turborepo orchestrates `build`/`test`/`lint` across it with caching and, the feature that matters most here, affected-package detection — a PR touching only `packages/claimguard-sdk` shouldn't trigger a full rebuild of `apps/web`. (Nx is a reasonable alternative with similar capabilities; Turborepo's lighter footprint fits a solo-to-small-team build better, but either is a defensible, explicit choice.)

**Python side — `uv`, one `pyproject.toml` per package.** Each Python package (`packages/data-generator`, `packages/claimguard-sdk`, `services/detection-engine`) gets its own `pyproject.toml` and lockfile, managed with `uv` rather than bare `pip` + `requirements.txt` — this closes a gap flagged in the earlier draft of this document (Phase 1 currently has no lockfile-based dependency pinning) and is materially faster in CI than pip. `uv`'s workspace support lets these packages share a lockfile root without forcing lockstep versions between them, similar in spirit to what pnpm workspaces does on the TS side.

**Tying the two together:** Turborepo doesn't natively understand Python, but it can still orchestrate it — each Python package gets a thin `package.json` whose `scripts` shell out to `uv run pytest`, `uv run ruff check`, etc., so Turborepo's task graph and caching treat Python and TS packages uniformly from the top level even though the tooling underneath differs per language.

---

## 6. Continuous Integration (GitHub Actions)

One workflow, path-filtered so a change to one package doesn't re-run every package's checks:

- **Trigger:** every pull request.
- **Job scope:** Turborepo's affected-package detection (§5) — `turbo run lint test build --filter=...[origin/main]` is the standard pattern for "only what changed since the base branch."
- **Python packages:** `uv run ruff check`, `uv run pytest --cov`.
- **TypeScript packages:** `pnpm lint`, `pnpm test -- --coverage` (Vitest, given React 19 + Vite is already the stated frontend tooling per §10 of the main spec).
- Coverage from both uploaded to Codecov (§7) as separate flags, not merged into one blind number.

---

## 7. Coverage gating (Codecov)

§9 of the main spec states the threshold explicitly: PRs are blocked below 70% coverage. Phase 0's job is wiring this up, not deciding the number — that's already decided.

- Codecov GitHub App installed on the monorepo.
- `codecov.yml` at the repo root setting the 70% project-level target, with `flags` splitting Python and TypeScript coverage so a strong number on one side can't mask a weak number on the other — a single blended 70% would let one half of the stack coast on the other's coverage.
- Coverage upload step added to the GitHub Actions workflow (§6) for both ecosystems.

---

## 8. Error tracking (Sentry) — baseline setup

Full release tracking and source-mapped stack traces are Phase 6's job. Phase 0's job is narrower: prove the wiring works before there's real application code generating real errors.

- A Sentry organization with at least two projects — one for `apps/web` (React), one for `apps/api` (Node/Hono). Separate projects rather than one shared one, since frontend and backend errors need different triage owners and different source-map handling.
- SDK initialization stubbed into both app shells, environment-tagged (`development` / `staging` / `production`) via the Doppler config (§10).
- The actual acceptance test (§13) is behavioral, not "Sentry is installed": a deliberately-thrown error in each app shell shows up in its corresponding Sentry project within a few minutes.

---

## 9. Application performance monitoring (New Relic) — baseline setup

New Relic's real job, per §9 of the main spec, is tracking tRPC endpoint p99 latency and business metrics like Entity Resolution Accuracy — none of which exist until Phase 3/4. Phase 0's job is standing up the APM shell so Phase 3 reports into it from day one, rather than retrofitting observability after the backend already exists.

- A New Relic APM application created for the eventual `apps/api` service.
- Node agent installation groundwork documented now, even with no Node service to attach it to yet, so Phase 3 wires it in immediately instead of as an afterthought.

---

## 10. Secrets management (Doppler)

- A Doppler project (`claimguard-network`) with `dev` / `staging` / `production` configs.
- Placeholder secrets for what's already known to be needed — MySQL credentials, Cosmos DB connection string, Sentry DSNs, New Relic license key — populated with real values as each later phase actually needs them, not all at once.
- **Explicit boundary, matching §4 of the main spec:** Doppler manages ClaimGuard's *own* platform secrets. It must never hold a scheme's `Scheme_Key`. Those are generated and held entirely within each scheme's own local secret store per §4's tokenization design — ClaimGuard receiving one at all, through Doppler or any other channel, would defeat the entire point of the Edge SDK. Worth stating explicitly in the setup docs rather than assuming it's obvious, since "just add it to the secrets manager" is exactly the kind of well-intentioned shortcut that would quietly undermine §4's model.

---

## 11. Configuration & environment conventions

- Three environments throughout — `development`, `staging`, `production` — matching Doppler's config naming (§10) so names don't need translating at each tool's boundary.
- Every service reads config from environment variables injected by Doppler at runtime (`doppler run -- <command>`), never from a committed `.env` file. This is the one hard rule worth stating explicitly, since it's the entire reason to use a secrets manager at all.

---

## 12. Suggested tooling summary

| Concern | Tool | Notes |
|---|---|---|
| JS/TS workspace graph | pnpm workspaces | Defines `apps/*` and `packages/*` |
| Polyglot task orchestration | Turborepo | Caching + affected-package filtering; Python packages included via thin `package.json` wrappers |
| Python dependency management | `uv` | One `pyproject.toml` + lockfile per Python package |
| CI | GitHub Actions | Path-filtered via Turborepo's `--filter` |
| Coverage | Codecov | 70% gate per §9 of the main spec, split by flag |
| Error tracking | Sentry (React + Node SDKs) | Separate projects per app |
| APM | New Relic (Node agent) | Shell only until Phase 3 |
| Secrets | Doppler | Platform secrets only — never scheme keys (§4) |

---

## 13. Acceptance criteria — how you know Phase 0 is done

- [ ] `claimguard-network` monorepo exists with the §4 structure, and Phase 1's code lives at `packages/data-generator` with its original git history preserved
- [ ] The standalone `claimguard-phase1` repo is archived, not left as a second writable copy of the same code
- [ ] `pnpm install && pnpm turbo build` succeeds from a fresh clone with no manual steps beyond installing `pnpm`/`uv` themselves
- [ ] `packages/data-generator` runs under `uv` with a lockfile, closing the Phase-1-README-documented `sys.path.insert` workaround and unpinned `requirements.txt`
- [ ] A GitHub Actions run on a trivial PR shows only the affected package's jobs executing, not the full matrix
- [ ] Codecov comments on that PR with separate Python and TypeScript coverage numbers, and a PR dropping either below 70% is blocked
- [ ] A deliberately-thrown test error in each Sentry-wired app shell appears in its corresponding Sentry project
- [ ] The New Relic APM application shell is visible in the New Relic dashboard, even with zero real traffic
- [ ] `doppler run -- env` inside any package prints the expected placeholder secrets for its environment, and no `.env` file with real secrets exists anywhere in the repo
- [ ] No scheme-held key material exists in Doppler, committed config, or anywhere outside a scheme's own systems

---

## 14. Relationship to the existing Phase 1 build

**Stays exactly as-is:**
- Every entity schema, distribution choice, fraud archetype mechanic, and the cross-scheme evasion design (Phase 1 spec §5–§9) — none of this is touched by environment/infra changes.
- The `RunContext` seeded-reproducibility pattern, `SequentialId`, the dataclass-entity/`to_row()` convention, and the config/reference-data split. These remain good internal practice for the data-generator package specifically — the correction from the earlier draft of this document is that they're Phase 1's own engineering discipline, not a platform-wide Phase 0 mandate.

**Changes:**
- Repo location: `claimguard-phase1` → `claimguard-network/packages/data-generator` (§4).
- Dependency management: `requirements.txt` → `uv` + `pyproject.toml` + lockfile (§5).
- `generate.py`'s `sys.path.insert` workaround → a proper package install via `uv`.
- CI: whatever ran manually before now runs in GitHub Actions on every PR touching this package, with coverage reported to Codecov.

**Confirmed, not a discrepancy:** §10's *"Kaggle standard datasets"* wording is a loose description of the target realism level, not a literal dependency — the from-scratch generator (Faker + numpy distributions, already built per the Phase 1 spec) is the one actually used, full stop. Worth tightening that roadmap line at some point so a future reader doesn't misread it as a real dependency the way I did, but that's a wording fix in the main spec whenever it's convenient, not a build task.
