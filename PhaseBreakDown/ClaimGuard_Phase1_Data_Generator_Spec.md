# ClaimGuard Network — Phase 1 Technical Specification
## Synthetic Multi-Scheme Claims Data Generator

This is the detailed build spec for Phase 1 only, referenced in the main technical spec (§6 and §16). Everything here should be specific enough to start building without having to make ad-hoc decisions along the way. No code — this is the design.

---

## 1. Purpose and scope

Phase 1 produces the dataset every later phase depends on: synthetic claims data for multiple "medical schemes," with known fraud cases deliberately planted inside it. Because you plant the fraud yourself, you know exactly where it is — which means later phases (detection, entity resolution, graph analytics) can be scored against ground truth instead of just "does this look plausible."

This phase produces **data only**. Nothing here touches hashing, matching, graphs, or a UI — that starts in Phase 2 onward.

---

## 2. Out of scope for Phase 1

Explicitly not part of this phase, so you don't scope-creep while building it:
- No hashing or tokenization of identifiers (that's Phase 3)
- No entity resolution or matching logic
- No graph database or graph construction
- No API, dashboard, or any UI
- No real statistical model fitting — distributions are chosen and hand-set, not fitted to real data (there is no real data)

---

## 3. Deliverables

1. A generator (config-driven, so it's rerunnable with different seeds/volumes)
2. Three synthetic scheme datasets (Scheme A, B, C), each with members, providers, and claims
3. A ground-truth file documenting every planted fraud case and every cross-scheme link — this is the answer key later phases get scored against
4. A short data dictionary (field names, types, meaning) — effectively §5 below, exported alongside the data

---

## 4. Data volumes at a glance

| Parameter | Value |
|---|---|
| Number of schemes | 3 (A, B, C) |
| Members per scheme | 3,000 |
| Providers per scheme | 250 |
| Time period covered | 24 months |
| Avg. claims per active member per month | ~0.4 (most members don't claim every month) |
| Approx. total claims per scheme | ~28,000 over 24 months |
| Planted single-scheme fraud entities per scheme | 35 (see §7) |
| Planted cross-scheme evasion cases (total, not per scheme) | 5 |
| Random seed | Fixed and recorded (for reproducible demos) |

These numbers are deliberately modest — big enough to be convincing, small enough to generate fast and be visually manageable once it hits a graph in Phase 4. Scale up later if you want a more impressive number to quote.

---

## 5. Entity schemas

### `Scheme`
| Field | Type | Notes |
|---|---|---|
| scheme_id | string | "A", "B", "C" |
| scheme_name | string | e.g. "Scheme A Medical Fund" |

### `Member`
| Field | Type | Notes |
|---|---|---|
| member_id | string | scheme-local, e.g. `A-M00001` |
| first_name, last_name | string | synthetic, via a fake-data library |
| date_of_birth | date | drives age-appropriate claim plausibility |
| synthetic_id_number | string | fake ID-number-like string, clearly synthetic, consistent format within the dataset |
| synthetic_banking_detail | string | fake bank name + account number pairing |
| home_location | string or lat/long | used later for proximity checks |
| join_date | date | when they joined this scheme |

### `Provider`
| Field | Type | Notes |
|---|---|---|
| provider_id | string | scheme-local, e.g. `A-P0001` |
| practice_number | string | synthetic, scheme-local |
| specialty | categorical | drawn from a fixed list (GP, dentist, physio, specialist, pharmacy, etc.) |
| practice_location | string or lat/long | |
| synthetic_banking_detail | string | same format as Member's, used for the collusion/evasion mechanics |

### `Claim`
| Field | Type | Notes |
|---|---|---|
| claim_id | string | globally unique |
| scheme_id | string | |
| member_id | string | references Member |
| provider_id | string | references Provider |
| service_date | date | within the 24-month window |
| billing_code | categorical | drawn from a fixed code list, distribution varies by specialty |
| amount | float | see §6 for how this is generated |

Keep one billing code per claim for v1 — multi-line claims add realism but also complexity you don't need yet.

---

## 6. "Normal" data generation logic

The point of this section: fraud should look anomalous *relative to a believable baseline*, not just different from arbitrary noise. A few concrete choices:

- **Claim frequency** per member per month: Poisson-distributed, mean depending on age band (older members claim slightly more often).
- **Claim severity** (amount): log-normal per specialty — this mirrors how real claims severity distributions behave (many small claims, a long right tail of expensive ones), and it's a distribution you already know well from pricing work.
- **Provider claim volume**: each provider's expected monthly claim count is a function of specialty (a GP sees more patients than a specialist) plus some individual variation — this baseline is what up-coding and ghost-claiming will later deviate from.
- **Billing code distribution per specialty**: each specialty should have a characteristic "fingerprint" of which codes it uses and how often — this fingerprint is what the entity-resolution fuzzy matching in Phase 3 will later compare across schemes.

---

## 7. Fraud archetypes to plant

All counts are **per scheme** unless stated otherwise.

| Archetype | Count | Mechanic |
|---|---|---|
| Up-coding provider | 6 | Provider's average claim severity is set 2.5–4 standard deviations above the peer mean for their specialty, while claim frequency stays normal (i.e., not more patients, just higher-value codes per visit) |
| Membership substitution | 12 members | Member has claims registered at providers implausibly far apart within short time windows (e.g., two locations >200km apart on the same day), or has procedure codes inconsistent with their age/gender |
| Provider–member collusion ring | 2 rings (1 provider + 6 members each) | The 6 members' claims cluster at unusually similar amounts and unusually regular intervals, all through the one ring provider, well above that provider's plausible patient capacity for the specialty |
| Ghost / high-volume claiming | 3 providers | Provider's claim count per day exceeds a plausible patient capacity for their specialty (e.g., a GP "seeing" 80 patients a day) |

That's 35 planted entities per scheme (11 providers, 24 members) — roughly 4% of providers and under 1% of members, which keeps the base rate realistically low while still being enough to compute meaningful precision/recall later.

---

## 8. Cross-scheme evasion mechanic (the critical one)

This is what Phase 3 onward is actually built to catch, so it needs to be precise.

**Mechanic:** take 5 of the provider-side entities already planted in §7 (a mix of up-coding and ghost-claiming providers works well) from Scheme A. For each:

1. **Exit event**: the provider's claims in Scheme A stop abruptly at a defined month (e.g., month 15 of 24) — simulating being caught and blacklisted.
2. **Reappearance**: starting 1–2 months later, a **new** provider record appears in Scheme B or C with:
   - A **different** name, practice number, and provider_id (the disguise)
   - The **same** `synthetic_banking_detail` as the original (fraudsters reusing a bank account is a real and common evasion failure point — changing banks is friction they often skip)
   - A **highly similar** billing-code fingerprint and claim-severity pattern to their original identity (same underlying behavior, new identity)
   - Optionally, the same or a very close `practice_location`

This gives Phase 3's entity resolution exactly two independent signals to work with — an exact hash match on the reused banking detail, and a fuzzy behavioral match on billing pattern — so you can demonstrate both the easy case and the harder case where only behavioral similarity gives it away.

Record, for every one of these 5 cases: original scheme + provider_id, new scheme + provider_id, which linking attributes were preserved vs. changed, and the exit/reappearance dates.

---

## 9. Ground truth output

A single structured file (JSON is cleanest) that later phases use to score themselves:

```
{
  "single_scheme_fraud": [
    {"scheme_id": "A", "entity_type": "provider", "entity_id": "A-P0031", "archetype": "up_coding"},
    ...
  ],
  "collusion_rings": [
    {"scheme_id": "B", "ring_provider": "B-P0114", "ring_members": ["B-M00812", "..."]}
  ],
  "cross_scheme_evasion": [
    {
      "original": {"scheme_id": "A", "provider_id": "A-P0031"},
      "reappeared_as": {"scheme_id": "B", "provider_id": "B-P0198"},
      "preserved_attributes": ["synthetic_banking_detail", "billing_fingerprint"],
      "changed_attributes": ["name", "practice_number", "provider_id"],
      "exit_month": 15,
      "reappearance_month": 17
    },
    ...
  ]
}
```

This file is what makes §15 of the main spec (recall, false positive rate, ring detection) measurable rather than a vibes-based claim.

---

## 10. File/folder output structure

```
/data
  /scheme_a
    members.csv
    providers.csv
    claims.csv
  /scheme_b
    members.csv
    providers.csv
    claims.csv
  /scheme_c
    members.csv
    providers.csv
    claims.csv
  /ground_truth
    planted_fraud.json
  /docs
    data_dictionary.md
  generation_config.yaml
```

---

## 11. Configuration parameters

Everything that should be adjustable without touching generation logic, in one config file:
- Random seed (fixed value, recorded — reproducibility matters for a demo you'll show more than once)
- Members/providers per scheme
- Date range
- Fraud archetype counts (§7)
- Cross-scheme evasion count and which attributes are preserved vs. changed (§8)

Keeping these as config rather than hard-coded means you can regenerate a bigger or smaller dataset later without rewriting the generator.

---

## 12. Suggested tooling

Given your existing Python/R background: Python is the better fit specifically for this phase because of library support for exactly this kind of synthetic-identity generation —
- **Faker** for names, addresses, and ID/banking-detail-shaped strings
- **numpy / scipy.stats** for the Poisson/log-normal distributions in §6
- **pandas** for assembling and exporting the tabular CSVs
- Fixed seeding (`numpy.random.default_rng(seed)`) throughout, so the same config always reproduces the same dataset

---

## 13. Acceptance criteria — how you know Phase 1 is done

- [ ] All three scheme datasets generated with the volumes in §4
- [ ] Referential integrity holds: every claim's member_id and provider_id exist in that scheme's member/provider files
- [ ] All 35×3 single-scheme fraud entities are present and match the mechanics in §7
- [ ] All 5 cross-scheme evasion cases are present and correctly recorded in ground truth, with preserved vs. changed attributes exactly as specified
- [ ] Plotting claim severity and frequency distributions for "normal" members/providers looks plausible on visual inspection (no obviously broken distributions)
- [ ] The generator is rerunnable from `generation_config.yaml` and produces identical output given the same seed
