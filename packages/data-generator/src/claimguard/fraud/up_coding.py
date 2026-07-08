"""
Up-coding archetype (spec §7): severity set 2.5-4 SD above the peer mean
for the provider's specialty; claim frequency is deliberately left alone
("not more patients, just higher-value codes per visit").

Peer mean/SD are computed from the *non-fraud* providers of the same
specialty (i.e. excluding every entity in this scheme's fraud allocation,
not just the up-coding targets) so the injected outliers can't
contaminate the very peer statistics they're being defined relative to.
"""
from __future__ import annotations

import numpy as np

from ..config import RunContext
from ..providers import Provider
from .allocation import FraudAllocation


def apply_up_coding(ctx: RunContext, providers: list[Provider],
                     allocation: FraudAllocation, cfg: dict) -> list[dict]:
    rng = ctx.rng
    by_id = {p.provider_id: p for p in providers}
    exclude_ids = allocation.all_fraud_provider_ids
    records = []

    for pid in allocation.up_coding_provider_ids:
        provider = by_id[pid]
        peers = [p for p in providers if p.specialty == provider.specialty and p.provider_id not in exclude_ids]
        peer_avgs = np.array([p.severity_avg for p in peers])
        peer_mean = float(peer_avgs.mean())
        peer_sd = float(peer_avgs.std(ddof=1)) if len(peer_avgs) > 1 else peer_mean * 0.15

        k = float(rng.uniform(cfg["severity_sd_multiplier_min"], cfg["severity_sd_multiplier_max"]))
        provider.severity_avg = peer_mean + k * peer_sd

        records.append({
            "scheme_id": provider.scheme_id,
            "entity_type": "provider",
            "entity_id": provider.provider_id,
            "archetype": "up_coding",
            "specialty": provider.specialty,
            "peer_mean_amount": round(peer_mean, 2),
            "peer_sd_amount": round(peer_sd, 2),
            "sd_multiplier_applied": round(k, 3),
        })
    return records
