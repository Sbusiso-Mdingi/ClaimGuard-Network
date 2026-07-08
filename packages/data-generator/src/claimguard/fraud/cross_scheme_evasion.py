"""
Cross-scheme evasion mechanic (spec §8) — the mechanic Phase 3 onward is
built to catch.

Takes providers already planted as up_coding or ghost_claiming in Scheme A
(§7), and for a subset of them: truncates their Scheme-A activity at
`exit_month`, then creates a *new* provider identity in Scheme B or C
starting `reappearance_offset_months` later, with:
  - different name, practice_number, provider_id (the disguise)
  - the SAME synthetic_banking_detail (exact copy — the easy signal)
  - a highly similar (not identical) billing fingerprint and severity
    pattern, carried forward via a Dirichlet draw centered tightly on the
    original's own fingerprint (the harder, behavioral signal)
  - practice_location either carried over (with small jitter) or moved,
    decided per-case, so Phase 3 can't rely on location alone

If the original was a ghost_claiming provider, its new identity is also
added to the target scheme's ghost_claiming allocation, so the excess-
volume behavior continues under the new identity rather than only the
severity pattern — otherwise "the fraud continues" would be true for
up-coding but silently false for ghost-claiming.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import RunContext
from ..geography import Location, sample_location
from ..identifiers import synthetic_practice_number
from ..providers import Provider, generate_practice_name, next_provider_id_start
from .allocation import FraudAllocation


@dataclass
class EvasionCase:
    original_provider_id: str
    original_archetype: str
    new_provider: Provider
    target_scheme: str
    exit_month: int
    reappearance_month: int
    location_carried_over: bool


def apply_cross_scheme_evasion(
    ctx: RunContext,
    scheme_a_providers: list[Provider],
    scheme_a_allocation: FraudAllocation,
    target_scheme_providers: dict[str, list[Provider]],
    target_scheme_allocations: dict[str, FraudAllocation],
    cfg: dict,
) -> list[EvasionCase]:
    rng = ctx.rng
    providers_by_id = {p.provider_id: p for p in scheme_a_providers}

    eligible_ids = list(scheme_a_allocation.up_coding_provider_ids) + \
        list(scheme_a_allocation.ghost_claiming_provider_ids)
    chosen_idx = rng.choice(len(eligible_ids), size=cfg["count"], replace=False)
    chosen_ids = [eligible_ids[i] for i in chosen_idx]

    exit_month = cfg["exit_month"]
    offsets = cfg["reappearance_offset_months"]
    target_schemes = cfg["target_schemes"]

    # running per-target-scheme id counters, so multiple new providers landing
    # in the same scheme don't collide
    next_id_counter = {
        s: next_provider_id_start(target_scheme_providers[s]) for s in target_schemes
    }

    cases: list[EvasionCase] = []

    for original_id in chosen_ids:
        original = providers_by_id[original_id]
        original_archetype = (
            "up_coding" if original_id in scheme_a_allocation.up_coding_provider_ids else "ghost_claiming"
        )

        original.active_until_month = exit_month

        target_scheme = target_schemes[int(rng.integers(len(target_schemes)))]
        offset = int(offsets[int(rng.integers(len(offsets)))])
        reappearance_month = exit_month + offset

        new_n = next_id_counter[target_scheme]
        next_id_counter[target_scheme] += 1
        new_provider_id = f"{target_scheme}-P{new_n:04d}"

        keep_location = rng.random() < cfg["location_carryover_probability"]
        if keep_location:
            new_location = Location(
                region=original.practice_location.region,
                lat=original.practice_location.lat + rng.normal(0, 0.01),
                lon=original.practice_location.lon + rng.normal(0, 0.01),
            )
        else:
            new_location = sample_location(rng, scatter_sigma_deg=0.08)

        codes = list(original.billing_fingerprint.keys())
        center = np.array([original.billing_fingerprint[c] for c in codes])
        alpha = np.clip(center * cfg["fingerprint_similarity_concentration"], 1e-3, None)
        new_weights = rng.dirichlet(alpha)
        new_fingerprint = dict(zip(codes, new_weights))

        jitter = float(rng.normal(1.0, cfg["severity_jitter_pct"]))
        new_severity_avg = original.severity_avg * max(jitter, 0.5)

        new_provider = Provider(
            provider_id=new_provider_id,
            scheme_id=target_scheme,
            practice_number=synthetic_practice_number(rng),
            specialty=original.specialty,
            practice_name=generate_practice_name(rng, ctx.fake, original.specialty),
            synthetic_banking_detail=original.synthetic_banking_detail,  # exact copy — the easy signal
            practice_location=new_location,
            billing_fingerprint=new_fingerprint,
            severity_avg=new_severity_avg,
            capacity_weight=original.capacity_weight * float(max(rng.normal(1.0, 0.1), 0.3)),
            active_from_month=reappearance_month,
            active_until_month=9999,
        )
        target_scheme_providers[target_scheme].append(new_provider)

        if original_archetype == "ghost_claiming":
            target_scheme_allocations[target_scheme].ghost_claiming_provider_ids.append(new_provider_id)

        cases.append(EvasionCase(
            original_provider_id=original.provider_id,
            original_archetype=original_archetype,
            new_provider=new_provider,
            target_scheme=target_scheme,
            exit_month=exit_month,
            reappearance_month=reappearance_month,
            location_carried_over=keep_location,
        ))

    return cases


def evasion_cases_to_ground_truth(cases: list[EvasionCase]) -> list[dict]:
    records = []
    for case in cases:
        preserved = ["synthetic_banking_detail", "billing_fingerprint", "claim_severity_pattern"]
        changed = ["name", "practice_number", "provider_id"]
        (preserved if case.location_carried_over else changed).append("practice_location")

        records.append({
            "original": {"scheme_id": "A", "provider_id": case.original_provider_id},
            "reappeared_as": {"scheme_id": case.target_scheme, "provider_id": case.new_provider.provider_id},
            "original_archetype": case.original_archetype,
            "preserved_attributes": preserved,
            "changed_attributes": changed,
            "exit_month": case.exit_month,
            "reappearance_month": case.reappearance_month,
        })
    return records
