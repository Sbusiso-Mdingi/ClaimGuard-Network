"""
Membership substitution archetype (spec §7), two variants:

- geographic: the member has claims at two providers >200km apart on the
  same day (identity/card sharing across distant locations).
- demographic: the member has a claim for a procedure code that's
  inconsistent with their age/gender (e.g. an obstetric code on a man).

Distance is checked against the *actual computed* haversine distance
between the two chosen providers (not inferred from region labels), so
this holds regardless of which regions happen to get drawn.
"""
from __future__ import annotations

import datetime as dt

import numpy as np

from ..config import RunContext
from ..geography import haversine_km
from ..identifiers import SequentialId
from ..members import Member
from ..providers import Provider
from ..reference_data import SPECIALTIES
from .allocation import FraudAllocation

RESTRICTED_CODES = [
    (spec_name, code)
    for spec_name, spec in SPECIALTIES.items()
    for code in spec.codes
    if code.gender_restriction is not None or code.min_age is not None or code.max_age is not None
]


def _member_fails_restriction(member: Member, code, as_of: dt.date) -> bool:
    age = member.age_on(as_of)
    if code.gender_restriction is not None and code.gender_restriction != member.gender:
        return True
    if code.min_age is not None and age < code.min_age:
        return True
    if code.max_age is not None and age > code.max_age:
        return True
    return False


def _find_far_provider_pair(rng: np.random.Generator, providers: list[Provider],
                             min_distance_km: float, max_tries: int = 300):
    n = len(providers)
    for _ in range(max_tries):
        i, j = rng.choice(n, size=2, replace=False)
        d = haversine_km(providers[i].practice_location, providers[j].practice_location)
        if d >= min_distance_km:
            return providers[i], providers[j], d
    raise RuntimeError(
        "Could not find two providers >min_distance_km apart after many tries — "
        "check reference_data.REGIONS spread."
    )


def _random_active_month(rng: np.random.Generator, member: Member, ctx: RunContext) -> int:
    from .. import claims as claims_mod
    join_month = max(1, claims_mod._month_of_date(ctx, member.join_date))
    join_month = min(join_month, ctx.config.num_months)
    return int(rng.integers(join_month, ctx.config.num_months + 1))


def _draw_claim_for_provider(rng, ctx, scheme_id, member, provider, service_date, claim_id_seq) -> dict:
    codes = list(provider.billing_fingerprint.keys())
    weights = list(provider.billing_fingerprint.values())
    code = codes[rng.choice(len(codes), p=weights)]
    mu, sigma = provider.severity_mu_sigma()
    amount = float(rng.lognormal(mu, sigma))
    return {
        "claim_id": claim_id_seq.next(),
        "scheme_id": scheme_id,
        "member_id": member.member_id,
        "provider_id": provider.provider_id,
        "service_date": service_date.isoformat(),
        "billing_code": code,
        "amount": round(amount, 2),
    }


def apply_membership_substitution(
    ctx: RunContext,
    scheme_id: str,
    members: list[Member],
    providers: list[Provider],
    allocation: FraudAllocation,
    claim_id_seq: SequentialId,
    cfg: dict,
) -> tuple[list[dict], list[dict]]:
    rng = ctx.rng
    members_by_id = {m.member_id: m for m in members}
    rows: list[dict] = []
    records: list[dict] = []

    # --- geographic variant ---
    for member_id in allocation.membership_substitution_geo_member_ids:
        member = members_by_id[member_id]
        p1, p2, dist = _find_far_provider_pair(rng, providers, cfg["min_distance_km"])
        month = _random_active_month(rng, member, ctx)
        service_date = ctx.random_date_in_month(month)

        rows.append(_draw_claim_for_provider(rng, ctx, scheme_id, member, p1, service_date, claim_id_seq))
        rows.append(_draw_claim_for_provider(rng, ctx, scheme_id, member, p2, service_date, claim_id_seq))

        records.append({
            "scheme_id": scheme_id,
            "entity_type": "member",
            "entity_id": member.member_id,
            "archetype": "membership_substitution",
            "variant": "geographic",
            "provider_ids": [p1.provider_id, p2.provider_id],
            "service_date": service_date.isoformat(),
            "distance_km": round(dist, 1),
        })

    # --- demographic (age/gender-inconsistent code) variant ---
    for member_id in allocation.membership_substitution_demo_member_ids:
        member = members_by_id[member_id]
        month = _random_active_month(rng, member, ctx)
        service_date = ctx.random_date_in_month(month)

        order = rng.permutation(len(RESTRICTED_CODES))
        chosen = None
        for idx in order:
            spec_name, code = RESTRICTED_CODES[idx]
            if _member_fails_restriction(member, code, service_date):
                chosen = (spec_name, code)
                break
        if chosen is None:
            continue  # extremely unlikely; skip rather than force an invalid case
        spec_name, code = chosen

        candidate_providers = [p for p in providers if p.specialty == spec_name]
        provider = candidate_providers[rng.integers(len(candidate_providers))]
        mu, sigma = provider.severity_mu_sigma()
        amount = float(rng.lognormal(mu, sigma))

        rows.append({
            "claim_id": claim_id_seq.next(),
            "scheme_id": scheme_id,
            "member_id": member.member_id,
            "provider_id": provider.provider_id,
            "service_date": service_date.isoformat(),
            "billing_code": code.code,
            "amount": round(amount, 2),
        })

        records.append({
            "scheme_id": scheme_id,
            "entity_type": "member",
            "entity_id": member.member_id,
            "archetype": "membership_substitution",
            "variant": "demographic",
            "provider_id": provider.provider_id,
            "service_date": service_date.isoformat(),
            "billing_code": code.code,
            "inconsistency": f"code {code.code} ({code.description}) restricted to "
                              f"gender={code.gender_restriction or 'any'}, "
                              f"age={code.min_age}-{code.max_age}; "
                              f"member is gender={member.gender}, age={member.age_on(service_date)}",
        })

    return rows, records
