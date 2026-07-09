"""
Orchestrates a full Phase 1 run, end to end, in the order the fraud
mechanics actually require:

  1. generate members + providers for every scheme (base volumes)
  2. allocate disjoint fraud entity sets per scheme (§7)
  3. apply up-coding severity overrides (must precede claim generation,
     and precede evasion so the carried-over severity is the final one)
  4. cross-scheme evasion: truncate Scheme A originals, spawn reappeared
     identities in B/C (must precede normal claim generation, so the new
     providers are eligible to be selected like any other provider from
     their reappearance month onward)
  5. generate normal claims for every scheme (ring members excluded)
  6. inject collusion-ring, membership-substitution, and ghost-claiming
     claims per scheme
  7. write CSVs, ground truth JSON, data dictionary, and a config copy

Every claim-producing step shares one global `claim_id` counter, so IDs
stay unique across all 3 schemes regardless of generation order.
"""
from __future__ import annotations

import shutil

import pandas as pd

from .config import Config, RunContext
from .data_dictionary import write_data_dictionary
from .fraud.allocation import FraudAllocation, allocate_fraud_entities
from .fraud.collusion_ring import apply_collusion_rings
from .fraud.cross_scheme_evasion import apply_cross_scheme_evasion, evasion_cases_to_ground_truth
from .fraud.ghost_claiming import apply_ghost_claiming
from .fraud.membership_substitution import apply_membership_substitution
from .fraud.up_coding import apply_up_coding
from .claims import generate_normal_claims
from .ground_truth import build_ground_truth, write_ground_truth
from .identifiers import SequentialId
from .members import Member, generate_members
from .providers import Provider, generate_providers


class SchemeState:
    def __init__(self, scheme_id: str, name: str):
        self.scheme_id = scheme_id
        self.name = name
        self.members: list[Member] = []
        self.providers: list[Provider] = []
        self.allocation: FraudAllocation | None = None
        self.claim_rows: list[dict] = []
        self.single_scheme_fraud_records: list[dict] = []
        self.collusion_ring_records: list[dict] = []


def run_pipeline(config: Config, verbose: bool = True) -> dict:
    ctx = RunContext(config)
    claim_id_seq = SequentialId("CLM-{n:08d}")

    def log(msg):
        if verbose:
            print(msg)

    # --- 1. members + providers ---
    states: dict[str, SchemeState] = {}
    for scheme in config.schemes:
        st = SchemeState(scheme.id, scheme.name)
        st.members = generate_members(ctx, scheme.id, config.members_per_scheme)
        st.providers = generate_providers(ctx, scheme.id, config.providers_per_scheme)
        states[scheme.id] = st
        log(f"[{scheme.id}] generated {len(st.members)} members, {len(st.providers)} providers")

    # --- 2. allocate fraud entities (disjoint sets, per scheme) ---
    for st in states.values():
        st.allocation = allocate_fraud_entities(ctx.rng, st.providers, st.members, config.fraud)
        log(f"[{st.scheme_id}] fraud allocation: "
            f"{len(st.allocation.all_fraud_provider_ids)} providers, "
            f"{len(st.allocation.all_fraud_member_ids)} members")

    # --- 3. up-coding severity overrides ---
    for st in states.values():
        recs = apply_up_coding(ctx, st.providers, st.allocation, config.fraud["up_coding"])
        st.single_scheme_fraud_records.extend(recs)
        log(f"[{st.scheme_id}] up-coding applied to {len(recs)} providers")

    # --- 4. cross-scheme evasion (source: Scheme A only, per spec §8) ---
    source_id = config.cross_scheme_evasion["source_scheme"]
    target_ids = config.cross_scheme_evasion["target_schemes"]
    target_provider_lists = {s: states[s].providers for s in target_ids}
    target_allocations = {s: states[s].allocation for s in target_ids}

    evasion_cases = apply_cross_scheme_evasion(
        ctx, states[source_id].providers, states[source_id].allocation,
        target_provider_lists, target_allocations, config.cross_scheme_evasion,
    )
    cross_scheme_evasion_records = evasion_cases_to_ground_truth(evasion_cases)
    log(f"cross-scheme evasion: {len(evasion_cases)} cases "
        f"({', '.join(c.original_provider_id + '->' + c.new_provider.provider_id for c in evasion_cases)})")

    # --- 5. normal claims (ring members excluded; provider active windows respected) ---
    for st in states.values():
        ring_member_ids = {m for ring in st.allocation.collusion_ring_member_ids for m in ring}
        rows = generate_normal_claims(
            ctx, st.scheme_id, st.members, st.providers, claim_id_seq,
            excluded_member_ids=ring_member_ids,
        )
        st.claim_rows.extend(rows)
        log(f"[{st.scheme_id}] normal claims: {len(rows)}")

    # --- 6. fraud claim injections ---
    for st in states.values():
        ring_rows, ring_recs = apply_collusion_rings(
            ctx, st.scheme_id, st.providers, st.members, st.allocation,
            claim_id_seq, config.fraud["collusion_ring"],
        )
        st.claim_rows.extend(ring_rows)
        st.collusion_ring_records.extend(ring_recs)

        sub_rows, sub_recs = apply_membership_substitution(
            ctx, st.scheme_id, st.members, st.providers, st.allocation,
            claim_id_seq, config.fraud["membership_substitution"],
        )
        st.claim_rows.extend(sub_rows)
        st.single_scheme_fraud_records.extend(sub_recs)

        ghost_rows, ghost_recs = apply_ghost_claiming(
            ctx, st.scheme_id, st.providers, st.members, st.allocation,
            claim_id_seq, config.fraud["ghost_claiming"],
        )
        st.claim_rows.extend(ghost_rows)
        st.single_scheme_fraud_records.extend(ghost_recs)

        log(f"[{st.scheme_id}] fraud claims injected: "
            f"{len(ring_rows)} ring, {len(sub_rows)} substitution, {len(ghost_rows)} ghost "
            f"| total claims now {len(st.claim_rows)}")

    # --- 7. write outputs ---
    data_dir = config.data_dir
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)

    for st in states.values():
        scheme_dir = data_dir / f"scheme_{st.scheme_id.lower()}"
        scheme_dir.mkdir(parents=True, exist_ok=True)
        pd.DataFrame([m.to_row() for m in st.members]).to_csv(scheme_dir / "members.csv", index=False)
        pd.DataFrame([p.to_row() for p in st.providers]).to_csv(scheme_dir / "providers.csv", index=False)
        claims_df = pd.DataFrame(st.claim_rows).sort_values("service_date").reset_index(drop=True)
        claims_df.to_csv(scheme_dir / "claims.csv", index=False)
        log(f"[{st.scheme_id}] wrote {len(st.members)} members, {len(st.providers)} providers "
            f"(incl. reappeared), {len(claims_df)} claims -> {scheme_dir}")

    all_single_scheme = [r for st in states.values() for r in st.single_scheme_fraud_records]
    all_collusion = [r for st in states.values() for r in st.collusion_ring_records]
    ground_truth = build_ground_truth(all_single_scheme, all_collusion, cross_scheme_evasion_records)
    write_ground_truth(ground_truth, data_dir / "ground_truth" / "planted_fraud.json")

    write_data_dictionary(data_dir / "docs" / "data_dictionary.md")

    # snapshot the config actually used, for provenance (matches spec §10's tree,
    # which lists generation_config.yaml as a sibling of scheme_*/ inside /data)
    shutil.copy(config._config_source_path, data_dir / "generation_config.yaml")

    log(f"\nDone. Output written to {data_dir.resolve()}")
    return {"states": states, "ground_truth": ground_truth, "evasion_cases": evasion_cases}
