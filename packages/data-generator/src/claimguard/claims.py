"""
Normal claim generation engine (spec §5 `Claim`, §6 "normal" generation logic).

Demand is member-driven: each member-month draws a Poisson number of
claims (mean by age band). Supply-side provider selection is weighted by
each provider's individual capacity and geographic proximity to the
member's home — this is what makes a provider's *observed* claim volume
emerge as "a function of specialty plus individual variation" (§6)
without double-counting against the member-side total, and it's what
makes the >200km membership-substitution fraud (§7) a genuine anomaly
against a baseline where most members mostly see nearby providers.

Members flagged for the collusion-ring archetype are excluded here
entirely (`excluded_member_ids`) — their whole claim history is generated
by fraud/collusion_ring.py instead, so that history is dominated by the
ring pattern rather than being + drowned in unrelated normal claims.
"""
from __future__ import annotations

import numpy as np

from .config import RunContext
from .identifiers import SequentialId
from .members import Member
from .providers import Provider
from .reference_data import SPECIALTIES, lambda_for_age

PROXIMITY_DECAY_KM = 40.0


def build_affinity_matrix(members: list[Member], providers: list[Provider],
                           decay_km: float = PROXIMITY_DECAY_KM) -> np.ndarray:
    """(n_members, n_providers) selection-weight matrix: capacity * proximity."""
    R = 6371.0
    m_lat = np.radians(np.array([m.home_location.lat for m in members]))[:, None]
    m_lon = np.radians(np.array([m.home_location.lon for m in members]))[:, None]
    p_lat = np.radians(np.array([p.practice_location.lat for p in providers]))[None, :]
    p_lon = np.radians(np.array([p.practice_location.lon for p in providers]))[None, :]

    dlat = p_lat - m_lat
    dlon = p_lon - m_lon
    h = np.sin(dlat / 2) ** 2 + np.cos(m_lat) * np.cos(p_lat) * np.sin(dlon / 2) ** 2
    dist_km = 2 * R * np.arcsin(np.sqrt(np.clip(h, 0, 1)))

    capacity = np.array([p.capacity_weight for p in providers])[None, :]
    return capacity * np.exp(-dist_km / decay_km)


def _eligible_codes_for_member(spec_codes, age: int, gender: str, fingerprint: dict):
    codes, weights = [], []
    for c in spec_codes:
        if c.gender_restriction is not None and c.gender_restriction != gender:
            continue
        if c.min_age is not None and age < c.min_age:
            continue
        if c.max_age is not None and age > c.max_age:
            continue
        codes.append(c.code)
        weights.append(fingerprint.get(c.code, 0.0))
    total = sum(weights)
    if total <= 0:
        # fall back to fully unrestricted codes only
        codes = [c.code for c in spec_codes if c.gender_restriction is None and c.min_age is None]
        weights = [fingerprint.get(c, 1.0) for c in codes]
        total = sum(weights)
    weights = [w / total for w in weights]
    return codes, weights


def generate_normal_claims(
    ctx: RunContext,
    scheme_id: str,
    members: list[Member],
    providers: list[Provider],
    claim_id_seq: SequentialId,
    excluded_member_ids: set[str] | None = None,
) -> list[dict]:
    rng = ctx.rng
    excluded_member_ids = excluded_member_ids or set()
    num_months = ctx.config.num_months

    specialty_names = list(SPECIALTIES.keys())
    specialty_claim_weights = [SPECIALTIES[s].claim_share for s in specialty_names]
    provider_specialty = np.array([p.specialty for p in providers])
    provider_active_from = np.array([p.active_from_month for p in providers])
    provider_active_until = np.array([p.active_until_month for p in providers])

    active_members = [m for m in members if m.member_id not in excluded_member_ids]
    affinity = build_affinity_matrix(active_members, providers)

    rows = []
    for mi, member in enumerate(active_members):
        join_month = _month_of_date(ctx, member.join_date)
        first_month = max(1, join_month)
        if first_month > num_months:
            continue

        for month in range(first_month, num_months + 1):
            age = member.age_on(ctx.month_start(month))
            lam = lambda_for_age(age)
            n_claims = rng.poisson(lam)
            if n_claims == 0:
                continue

            for _ in range(n_claims):
                specialty = specialty_names[rng.choice(len(specialty_names), p=specialty_claim_weights)]

                elig = (provider_specialty == specialty) & \
                       (provider_active_from <= month) & (provider_active_until >= month)
                if not elig.any():
                    continue
                w = affinity[mi] * elig
                if w.sum() <= 0:
                    w = elig.astype(float)
                p = w / w.sum()
                prov_idx = rng.choice(len(providers), p=p)
                provider = providers[prov_idx]

                spec_def = SPECIALTIES[specialty]
                codes, weights = _eligible_codes_for_member(
                    spec_def.codes, age, member.gender, provider.billing_fingerprint
                )
                code = codes[rng.choice(len(codes), p=weights)]

                mu, sigma = provider.severity_mu_sigma()
                amount = float(rng.lognormal(mu, sigma))

                rows.append({
                    "claim_id": claim_id_seq.next(),
                    "scheme_id": scheme_id,
                    "member_id": member.member_id,
                    "provider_id": provider.provider_id,
                    "service_date": ctx.random_date_in_month(month).isoformat(),
                    "billing_code": code,
                    "amount": round(amount, 2),
                })
    return rows


def _month_of_date(ctx: RunContext, date) -> int:
    """1-indexed month number of `date` relative to the run's start_date. Can be <=0
    (joined before the window) or >num_months (joined after it, handled by caller)."""
    start = ctx.config.start_date
    return (date.year - start.year) * 12 + (date.month - start.month) + 1
