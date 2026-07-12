# ClaimGuard Network — Phase 1: Synthetic Multi-Scheme Claims Data Generator

Implements `ClaimGuard_Phase1_Data_Generator_Spec.md` in full: three synthetic
medical scheme datasets (members, providers, claims) with known fraud cases
planted deliberately inside them, plus a ground-truth answer key so Phase 2+
(hashing, entity resolution, graph analytics) can be scored against known
truth instead of a vibes-based "does this look plausible."

The default fictional schemes used for demo runs are:

- Nedbank Health (`A`)
- MedSecure (`B`)
- HealthFirst (`C`)

Phase 1 produces **data only** — no hashing, matching, graphs, or UI. See
§2 of the spec for the full out-of-scope list.

## Quick start

```bash
uv sync --all-groups
uv run claimguard-generate --config generation_config.yaml  # writes ./data (see structure below)
uv run python tests/test_acceptance.py                      # or: uv run pytest tests/
uv run python diagnostics.py --scheme a                     # optional: visual sanity-check plots
```

Re-running `python generate.py` with an unchanged `generation_config.yaml`
reproduces byte-identical output — `test_reproducibility` in the acceptance
suite checks this directly by running the pipeline twice and diffing every
output file.

## Project layout

```
generation_config.yaml     # every tunable knob (spec §11) — edit this, not the code
generate.py                 # CLI entry point
diagnostics.py               # optional: severity/frequency/volume plots (spec §13's visual check)
src/claimguard/
  config.py                  # config loading + seeded RNG/Faker (the ONE place the seed is applied)
  reference_data.py           # specialties, billing-code fingerprints, regions, banks
  geography.py                 # location scatter + haversine distance
  identifiers.py                # synthetic ID numbers, banking details, sequential IDs
  members.py                     # Member generation
  providers.py                    # Provider generation (+ internal fingerprint/severity/capacity)
  claims.py                        # normal (non-fraud) claim generation engine
  fraud/
    allocation.py                   # picks disjoint entity sets per archetype (no double-assignment)
    up_coding.py                     # §7 archetype 1
    membership_substitution.py        # §7 archetype 2 (geographic + demographic variants)
    collusion_ring.py                  # §7 archetype 3
    ghost_claiming.py                   # §7 archetype 4
    cross_scheme_evasion.py              # §8 — the mechanic Phase 3+ is built to catch
  ground_truth.py                        # assembles the §9 answer key
  data_dictionary.py                      # writes docs/data_dictionary.md
  pipeline.py                              # orchestrates all of the above in dependency order
tests/test_acceptance.py    # every §13 checkbox, automated (runs standalone or under pytest)
```

## Output (`/data`, matches spec §10 exactly)

```
data/
  scheme_a/{members,providers,claims}.csv
  scheme_b/{members,providers,claims}.csv
  scheme_c/{members,providers,claims}.csv
  ground_truth/planted_fraud.json     # spec §9 structure
  ground_truth/investigation_reports.json  # synthetic demo investigation outcomes
  docs/data_dictionary.md
  docs/investigation_scenarios.md
  generation_config.yaml              # snapshot of the config that produced this run
```

`/data` is gitignored — it's fully regenerable from the config, and Phase 2+
will likely want to regenerate at different seeds/volumes rather than diff
megabytes of CSV in version control.

## Key assumptions made building this

The spec is unambiguous everywhere it commits to specifics; a handful of
implementation details were left as "designer's choice" and are recorded
here rather than buried in code:

- **Locale / currency**: the spec's own vocabulary — medical "**scheme**",
  provider "**practice number**" — is South African terminology, so
  identifiers use Faker's `zu_ZA` locale (the SA locale with real name
  coverage; there's no `en_ZA` name provider) and amounts are in ZAR. Both
  are one-line changes in `generation_config.yaml` if you want a different
  flavor — nothing downstream depends on it.
- **Two small, explicitly-flagged schema extensions** (both documented
  in `docs/data_dictionary.md` and in the relevant module docstrings):
  - `Member.gender` — not in the spec's §5 table. Needed for
    gender-appropriate names and for the age/gender-inconsistent variant
    of membership substitution (§7).
  - `Provider.practice_name` — §5's Provider table has no name field at
    all, but §8 explicitly requires "a different name" as part of the
    evasion disguise. Added as a practice/business name (providers don't
    have first/last name fields to draw a personal name from).
- **Ghost-claiming spike size scales with specialty**, not a flat count —
  a spike is defined as a multiple of *that specialty's own* daily
  capacity baseline, so a pharmacy spike and a psychologist spike are
  equally implausible relative to their own peers, rather than a flat
  "70 claims" being unremarkable for a pharmacy and impossible for a
  psychologist.
- **Membership substitution (§7) is split 8 geographic / 4 demographic**
  per scheme (both configurable) — the spec describes both variants
  joined by "or", so both are implemented rather than picking one.
  Geographic cases are verified against *actual recomputed* haversine
  distance between the two providers, not inferred from region labels.
- **Total claims land ~28,000-32,000 per scheme**, a little above the
  spec's stated "~28,000" — the fraud archetypes (ghost-claiming excess
  volume, collusion-ring visit frequency) deliberately inflate volume for
  the entities they target, which is part of what makes them detectable.
  `avg_claims_per_active_member_per_month` in the config is the lever if
  you want the baseline tighter or looser.
- **scipy dropped from requirements** — numpy's `Generator` already
  provides Poisson, log-normal, normal, and Dirichlet draws directly, so
  the spec's suggested scipy.stats dependency (§12) turned out to be
  unnecessary in practice.

## Design notes worth knowing if you extend this

- **Reproducibility**: every random draw goes through one seeded
  `np.random.default_rng(seed)` and one seeded Faker instance
  (`RunContext` in `config.py`). If you add new randomness anywhere,
  pull it from `ctx.rng` / `ctx.fake` rather than instantiating your own
  — otherwise the reproducibility test will start failing.
- **Fraud entities are disjoint by construction**: `fraud/allocation.py`
  samples all archetypes' entity sets from the same pool up front, so a
  provider or member can never be double-assigned to two archetypes. This
  is asserted directly in `test_single_scheme_fraud_entity_counts`.
- **Provider "capacity"** is a relative selection weight, not an
  independent claim-generation process — total claim volume is entirely
  member-driven (Poisson per member-month), and provider-side generation
  just decides who absorbs each claim (weighted by capacity × geographic
  proximity to the member). This is what keeps the ~28,000-claim total
  from double-counting against a separate provider-side volume model.
- **Cross-scheme evasion ordering matters**: providers must be
  exited/spawned (`fraud/cross_scheme_evasion.py`) *before* normal claims
  are generated, so the reappeared identity is eligible for selection
  like any other provider from its `reappearance_month` onward, and the
  exited original stops being selectable after `exit_month`. See
  `pipeline.py`'s docstring for the full dependency order.
- **Billing-code fingerprints and severity are internal generation
  parameters**, not exported CSV columns (the spec's Provider schema
  doesn't list them) — they live on the `Provider` object in memory and
  drive `claims.py`. If Phase 3's entity resolution wants the ground-truth
  fingerprint vectors directly (e.g. to validate a fuzzy-matching score
  against a known similarity), that's a one-line addition to
  `ground_truth.py` — deliberately not added now, to avoid scope creep
  into Phase 3's territory.

## Using GitHub

This directory is ready to become a repo as-is:

```bash
cd claimguard-phase1
git init
git add .
git commit -m "Phase 1: synthetic multi-scheme claims data generator"
gh repo create claimguard-phase1 --private --source=. --push
# or, without the GitHub CLI:
git remote add origin git@github.com:<you>/claimguard-phase1.git
git branch -M main
git push -u origin main
```
