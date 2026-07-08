"""
Picks *disjoint* provider and member sets for each fraud archetype so a
single entity never gets double-assigned to two archetypes at once (which
would make the ground truth ambiguous). Sampling is done once, up front,
before any archetype-specific logic runs.

Per scheme, this draws exactly:
  providers: up_coding + ghost_claiming + collusion_ring (rings) = 6+3+2 = 11
  members:   substitution (geo+demo) + collusion_ring (rings*size) = 8+4+12 = 24
matching spec §7's "35 planted entities per scheme (11 providers, 24 members)".
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..members import Member
from ..providers import Provider


@dataclass
class FraudAllocation:
    up_coding_provider_ids: list[str]
    ghost_claiming_provider_ids: list[str]
    collusion_ring_provider_ids: list[str]        # one per ring
    collusion_ring_member_ids: list[list[str]]     # members per ring, same order as above
    membership_substitution_geo_member_ids: list[str]
    membership_substitution_demo_member_ids: list[str]

    @property
    def all_fraud_provider_ids(self) -> set[str]:
        return set(self.up_coding_provider_ids) | set(self.ghost_claiming_provider_ids) \
            | set(self.collusion_ring_provider_ids)

    @property
    def all_fraud_member_ids(self) -> set[str]:
        ring_members = {m for ring in self.collusion_ring_member_ids for m in ring}
        return set(self.membership_substitution_geo_member_ids) \
            | set(self.membership_substitution_demo_member_ids) | ring_members


def allocate_fraud_entities(rng: np.random.Generator, providers: list[Provider],
                             members: list[Member], fraud_config: dict) -> FraudAllocation:
    provider_ids = [p.provider_id for p in providers]
    member_ids = [m.member_id for m in members]

    n_up = fraud_config["up_coding"]["count_per_scheme"]
    n_ghost = fraud_config["ghost_claiming"]["count_per_scheme"]
    n_rings = fraud_config["collusion_ring"]["rings_per_scheme"]
    ring_size = fraud_config["collusion_ring"]["members_per_ring"]
    n_sub_geo = fraud_config["membership_substitution"]["geographic_count"]
    n_sub_demo = fraud_config["membership_substitution"]["demographic_count"]

    total_providers_needed = n_up + n_ghost + n_rings
    prov_choice = rng.choice(len(providers), size=total_providers_needed, replace=False)
    up_ids = [provider_ids[i] for i in prov_choice[:n_up]]
    ghost_ids = [provider_ids[i] for i in prov_choice[n_up:n_up + n_ghost]]
    ring_provider_ids = [provider_ids[i] for i in prov_choice[n_up + n_ghost:]]

    total_members_needed = n_sub_geo + n_sub_demo + n_rings * ring_size
    mem_choice = rng.choice(len(members), size=total_members_needed, replace=False)
    sub_geo_ids = [member_ids[i] for i in mem_choice[:n_sub_geo]]
    sub_demo_ids = [member_ids[i] for i in mem_choice[n_sub_geo:n_sub_geo + n_sub_demo]]
    ring_flat = mem_choice[n_sub_geo + n_sub_demo:]
    ring_member_ids = [
        [member_ids[i] for i in ring_flat[k * ring_size:(k + 1) * ring_size]]
        for k in range(n_rings)
    ]

    return FraudAllocation(
        up_coding_provider_ids=up_ids,
        ghost_claiming_provider_ids=ghost_ids,
        collusion_ring_provider_ids=ring_provider_ids,
        collusion_ring_member_ids=ring_member_ids,
        membership_substitution_geo_member_ids=sub_geo_ids,
        membership_substitution_demo_member_ids=sub_demo_ids,
    )
