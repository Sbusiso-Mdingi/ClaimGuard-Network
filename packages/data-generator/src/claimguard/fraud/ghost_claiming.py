"""
Ghost / high-volume claiming archetype (spec §7): claim count per day
exceeds a plausible patient capacity for the specialty.

Implemented as additive injection rather than reweighting normal demand,
because reweighting can only redistribute a scheme's existing (modest,
member-driven) daily claim pool — it can never push a single provider's
day past what real "invented visit" ghost-billing looks like. Spike-day
volume is set as a multiple of *that specialty's own* capacity baseline
(reference_data.WORKING_DAYS_PER_MONTH), so the anomaly is proportionate
regardless of which specialty gets selected — a pharmacy spike and a
psychologist spike are both equally implausible relative to their peers.

Ghost claims reference real (random) members of the scheme who never
actually visited — that's what makes them "ghost" claims rather than a
volume-only anomaly.
"""
from __future__ import annotations

import datetime as dt

import numpy as np

from ..config import RunContext
from ..identifiers import SequentialId
from ..members import Member
from ..providers import Provider
from ..reference_data import SPECIALTIES, WORKING_DAYS_PER_MONTH
from .allocation import FraudAllocation


def apply_ghost_claiming(
    ctx: RunContext,
    scheme_id: str,
    providers: list[Provider],
    members: list[Member],
    allocation: FraudAllocation,
    claim_id_seq: SequentialId,
    cfg: dict,
) -> tuple[list[dict], list[dict]]:
    rng = ctx.rng
    by_id = {p.provider_id: p for p in providers}
    member_ids_pool = [m.member_id for m in members]
    num_months = ctx.config.num_months

    rows: list[dict] = []
    records: list[dict] = []

    for pid in allocation.ghost_claiming_provider_ids:
        provider = by_id[pid]
        spec_def = SPECIALTIES[provider.specialty]
        daily_baseline = spec_def.monthly_capacity_baseline / WORKING_DAYS_PER_MONTH

        active_from = provider.active_from_month
        active_until = min(provider.active_until_month, num_months)
        n_spike_days = int(rng.integers(cfg["spike_days_min"], cfg["spike_days_max"] + 1))

        spike_day_log = []
        total_extra = 0
        codes = list(provider.billing_fingerprint.keys())
        code_weights = list(provider.billing_fingerprint.values())
        mu, sigma = provider.severity_mu_sigma()

        for _ in range(n_spike_days):
            month = int(rng.integers(active_from, active_until + 1))
            spike_date = ctx.random_date_in_month(month)
            multiplier = rng.uniform(cfg["spike_multiplier_min"], cfg["spike_multiplier_max"])
            n_extra = max(1, int(round(daily_baseline * multiplier)))

            for _ in range(n_extra):
                member_id = member_ids_pool[rng.integers(len(member_ids_pool))]
                code = codes[rng.choice(len(codes), p=code_weights)]
                amount = float(rng.lognormal(mu, sigma))
                rows.append({
                    "claim_id": claim_id_seq.next(),
                    "scheme_id": scheme_id,
                    "member_id": member_id,
                    "provider_id": provider.provider_id,
                    "service_date": spike_date.isoformat(),
                    "billing_code": code,
                    "amount": round(amount, 2),
                })
            spike_day_log.append({"date": spike_date.isoformat(), "claim_count": n_extra})
            total_extra += n_extra

        records.append({
            "scheme_id": scheme_id,
            "entity_type": "provider",
            "entity_id": provider.provider_id,
            "archetype": "ghost_claiming",
            "specialty": provider.specialty,
            "daily_capacity_baseline": round(daily_baseline, 2),
            "spike_days": spike_day_log,
            "total_extra_claims": total_extra,
        })

    return rows, records
