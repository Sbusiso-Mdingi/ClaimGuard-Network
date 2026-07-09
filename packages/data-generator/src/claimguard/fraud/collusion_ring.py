"""
Provider-member collusion ring archetype (spec §7): a small set of members
whose claims cluster at unusually similar amounts and unusually regular
intervals, all through one ring provider, well above that provider's
plausible patient capacity for the specialty.

Ring members are excluded from normal claim generation entirely
(claims.py's `excluded_member_ids`) — their whole history here *is* the
ring pattern, rather than the pattern being one thread buried in
otherwise-normal claims. Amounts cluster tightly around the ring
provider's own severity_avg; each ring uses a single dominant billing
code (that provider's highest-weight code) rather than the provider's
full fingerprint, to make the "same code, same amount, same rhythm"
signal unambiguous.
"""
from __future__ import annotations

import datetime as dt

from ..config import RunContext
from ..identifiers import SequentialId
from ..members import Member
from ..providers import Provider
from .allocation import FraudAllocation

RING_START_MONTH = 3   # give some runway before the ring pattern begins
RING_END_MONTH_MARGIN = 2  # months of tail room left at the end of the run


def apply_collusion_rings(
    ctx: RunContext,
    scheme_id: str,
    providers: list[Provider],
    members: list[Member],
    allocation: FraudAllocation,
    claim_id_seq: SequentialId,
    cfg: dict,
) -> tuple[list[dict], list[dict]]:
    rng = ctx.rng
    providers_by_id = {p.provider_id: p for p in providers}
    members_by_id = {m.member_id: m for m in members}

    interval_min = cfg["visit_interval_days_min"]
    interval_max = cfg["visit_interval_days_max"]
    noise = cfg["amount_relative_noise"]
    ring_end_month = ctx.config.num_months - RING_END_MONTH_MARGIN

    window_start = ctx.month_start(RING_START_MONTH)
    window_end = ctx.month_start(ring_end_month + 1) - dt.timedelta(days=1)

    rows: list[dict] = []
    records: list[dict] = []

    for ring_provider_id, ring_member_ids in zip(
        allocation.collusion_ring_provider_ids, allocation.collusion_ring_member_ids
    ):
        provider = providers_by_id[ring_provider_id]
        target_amount = provider.severity_avg
        dominant_code = max(provider.billing_fingerprint, key=provider.billing_fingerprint.get)

        ring_visit_dates: dict[str, list[str]] = {}
        total_visits = 0
        for member_id in ring_member_ids:
            member = members_by_id[member_id]
            phase_offset = int(rng.integers(0, interval_max))
            current = window_start + dt.timedelta(days=phase_offset)
            visit_dates = []
            while current <= window_end:
                amount = float(rng.normal(target_amount, target_amount * noise))
                amount = max(amount, 1.0)
                rows.append({
                    "claim_id": claim_id_seq.next(),
                    "scheme_id": scheme_id,
                    "member_id": member.member_id,
                    "provider_id": provider.provider_id,
                    "service_date": current.isoformat(),
                    "billing_code": dominant_code,
                    "amount": round(amount, 2),
                })
                visit_dates.append(current.isoformat())
                total_visits += 1
                interval = int(rng.integers(interval_min, interval_max + 1))
                current += dt.timedelta(days=interval)
            ring_visit_dates[member_id] = visit_dates

        records.append({
            "scheme_id": scheme_id,
            "ring_provider": provider.provider_id,
            "ring_members": list(ring_member_ids),
            "archetype": "collusion_ring",
            "dominant_billing_code": dominant_code,
            "target_amount": round(target_amount, 2),
            "total_ring_visits": total_visits,
            "active_window": [window_start.isoformat(), window_end.isoformat()],
        })

    return rows, records
