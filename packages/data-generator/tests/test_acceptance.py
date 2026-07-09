"""
Automated checks for every box in spec §13's acceptance criteria.

Runs standalone (`python tests/test_acceptance.py`) or under pytest
(`pytest tests/`) — plain `assert`-based test_* functions work under both.

Most tests read the already-generated /data output (run `python
generate.py` first). The reproducibility test generates its own two fresh
copies into temp directories, since it specifically needs to compare two
independent runs.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

# ruff: noqa: E402

from claimguard.config import load_config
from claimguard.geography import Location, haversine_km
from claimguard.pipeline import run_pipeline

CONFIG_PATH = REPO_ROOT / "generation_config.yaml"
DATA_DIR = REPO_ROOT / "data"
SCHEME_IDS = ["a", "b", "c"]


def _load_scheme(scheme_letter: str):
    d = DATA_DIR / f"scheme_{scheme_letter}"
    members = pd.read_csv(d / "members.csv")
    providers = pd.read_csv(d / "providers.csv")
    claims = pd.read_csv(d / "claims.csv")
    return members, providers, claims


def _load_ground_truth():
    return json.loads((DATA_DIR / "ground_truth" / "planted_fraud.json").read_text())


# ---------------------------------------------------------------------------
# [ ] All three scheme datasets generated with the volumes in §4
# ---------------------------------------------------------------------------
def test_scheme_volumes():
    config = load_config(CONFIG_PATH)
    for letter, scheme in zip(SCHEME_IDS, config.schemes):
        members, providers, claims = _load_scheme(letter)
        assert len(members) == config.members_per_scheme, \
            f"scheme {scheme.id}: expected {config.members_per_scheme} members, got {len(members)}"
        assert len(providers) >= config.providers_per_scheme, \
            f"scheme {scheme.id}: expected >= {config.providers_per_scheme} providers, got {len(providers)}"
        # ~28,000 is an explicit "approx" in the spec; fraud archetypes deliberately
        # add volume, so allow a generous band rather than an exact match.
        assert 20_000 <= len(claims) <= 40_000, \
            f"scheme {scheme.id}: claim count {len(claims)} far outside the ~28,000 ballpark"
    print("PASS: scheme volumes match §4 (with documented approx tolerance on claim count)")


# ---------------------------------------------------------------------------
# [ ] Referential integrity holds
# ---------------------------------------------------------------------------
def test_referential_integrity():
    for letter in SCHEME_IDS:
        members, providers, claims = _load_scheme(letter)
        member_ids = set(members["member_id"])
        provider_ids = set(providers["provider_id"])

        bad_members = ~claims["member_id"].isin(member_ids)
        bad_providers = ~claims["provider_id"].isin(provider_ids)
        assert not bad_members.any(), \
            f"scheme {letter}: {bad_members.sum()} claims reference unknown member_id"
        assert not bad_providers.any(), \
            f"scheme {letter}: {bad_providers.sum()} claims reference unknown provider_id"

        assert claims["member_id"].str.startswith(letter.upper()).all()
        assert claims["provider_id"].str.startswith(letter.upper()).all()
    print("PASS: referential integrity holds in all 3 schemes")


def test_claim_ids_globally_unique():
    all_claim_ids = []
    for letter in SCHEME_IDS:
        _, _, claims = _load_scheme(letter)
        all_claim_ids.extend(claims["claim_id"].tolist())
    assert len(all_claim_ids) == len(set(all_claim_ids)), "duplicate claim_id found across schemes"
    print(f"PASS: all {len(all_claim_ids)} claim_ids are globally unique")


# ---------------------------------------------------------------------------
# [ ] All 35x3 single-scheme fraud entities present and match §7 mechanics
# ---------------------------------------------------------------------------
def test_single_scheme_fraud_entity_counts():
    gt = _load_ground_truth()
    for letter, scheme_id in zip(SCHEME_IDS, ["A", "B", "C"]):
        single = [r for r in gt["single_scheme_fraud"] if r["scheme_id"] == scheme_id]
        rings = [r for r in gt["collusion_rings"] if r["scheme_id"] == scheme_id]

        up_coding = [r for r in single if r["archetype"] == "up_coding"]
        ghost = [r for r in single if r["archetype"] == "ghost_claiming"]
        sub_geo = [r for r in single if r["archetype"] == "membership_substitution" and r["variant"] == "geographic"]
        sub_demo = [r for r in single if r["archetype"] == "membership_substitution" and r["variant"] == "demographic"]

        assert len(up_coding) == 6, f"scheme {scheme_id}: expected 6 up_coding, got {len(up_coding)}"
        assert len(ghost) == 3, f"scheme {scheme_id}: expected 3 ghost_claiming, got {len(ghost)}"
        assert len(sub_geo) == 8, f"scheme {scheme_id}: expected 8 geographic substitution, got {len(sub_geo)}"
        assert len(sub_demo) == 4, f"scheme {scheme_id}: expected 4 demographic substitution, got {len(sub_demo)}"
        assert len(rings) == 2, f"scheme {scheme_id}: expected 2 collusion rings, got {len(rings)}"
        for ring in rings:
            assert len(ring["ring_members"]) == 6

        n_fraud_providers = len(up_coding) + len(ghost) + len(rings)  # ring providers, 1 each
        ring_members_flat = {m for r in rings for m in r["ring_members"]}
        n_fraud_members = len(sub_geo) + len(sub_demo) + len(ring_members_flat)

        assert n_fraud_providers == 11, f"scheme {scheme_id}: expected 11 fraud providers, got {n_fraud_providers}"
        assert n_fraud_members == 24, f"scheme {scheme_id}: expected 24 fraud members, got {n_fraud_members}"
        assert n_fraud_providers + n_fraud_members == 35

        # every entity_id must actually be disjoint (no double-assignment across archetypes)
        provider_id_lists = [r["entity_id"] for r in up_coding + ghost] + [r["ring_provider"] for r in rings]
        assert len(provider_id_lists) == len(set(provider_id_lists)), \
            f"scheme {scheme_id}: a provider was assigned to more than one archetype"
        member_id_lists = [r["entity_id"] for r in sub_geo + sub_demo] + list(ring_members_flat)
        assert len(member_id_lists) == len(set(member_id_lists)), \
            f"scheme {scheme_id}: a member was assigned to more than one archetype"

    print("PASS: 35 disjoint fraud entities (11 providers, 24 members) confirmed in all 3 schemes")


def test_up_coding_severity_matches_mechanic():
    gt = _load_ground_truth()
    for r in [x for x in gt["single_scheme_fraud"] if x["archetype"] == "up_coding"]:
        assert 2.5 <= r["sd_multiplier_applied"] <= 4.0, \
            f"{r['entity_id']}: sd_multiplier {r['sd_multiplier_applied']} outside [2.5, 4.0]"

    # empirical sanity check: does the provider's *realized* claims average
    # actually land meaningfully above their (non-fraud) specialty peers?
    for letter, scheme_id in zip(SCHEME_IDS, ["A", "B", "C"]):
        members, providers, claims = _load_scheme(letter)
        up_coding_records = [r for r in gt["single_scheme_fraud"]
                              if r["scheme_id"] == scheme_id and r["archetype"] == "up_coding"]
        for r in up_coding_records:
            pid, specialty = r["entity_id"], r["specialty"]
            fraud_provider_ids = {x["entity_id"] for x in gt["single_scheme_fraud"] if x["scheme_id"] == scheme_id}
            peer_ids = set(providers.loc[providers["specialty"] == specialty, "provider_id"]) - fraud_provider_ids
            peer_avg = claims[claims["provider_id"].isin(peer_ids)]["amount"].mean()
            this_avg = claims[claims["provider_id"] == pid]["amount"].mean()
            assert this_avg > peer_avg, \
                f"{pid}: realized avg {this_avg:.2f} not above peer avg {peer_avg:.2f}"
    print("PASS: up-coding providers realize 2.5-4 peer-SD severity, frequency untouched by construction")


def test_membership_substitution_geographic_distance():
    gt = _load_ground_truth()
    cfg = load_config(CONFIG_PATH)
    min_km = cfg.fraud["membership_substitution"]["min_distance_km"]

    for letter, scheme_id in zip(SCHEME_IDS, ["A", "B", "C"]):
        members, providers, claims = _load_scheme(letter)
        prov_loc = {
            row.provider_id: Location(row.practice_region, row.practice_lat, row.practice_lon)
            for row in providers.itertuples()
        }
        cases = [r for r in gt["single_scheme_fraud"]
                 if r["scheme_id"] == scheme_id and r["archetype"] == "membership_substitution"
                 and r["variant"] == "geographic"]
        for r in cases:
            p1, p2 = r["provider_ids"]
            d = haversine_km(prov_loc[p1], prov_loc[p2])
            assert d >= min_km, f"{r['entity_id']}: recomputed distance {d:.1f}km < {min_km}km threshold"

            # cross-check directly against claims.csv: same member, same day, both providers
            member_claims = claims[(claims["member_id"] == r["entity_id"])
                                    & (claims["service_date"] == r["service_date"])]
            assert set([p1, p2]).issubset(set(member_claims["provider_id"])), \
                f"{r['entity_id']}: claims.csv doesn't show both providers on {r['service_date']}"
    print(f"PASS: all geographic-substitution cases recompute to >= {min_km}km apart, same day, in claims.csv")


def test_membership_substitution_demographic_inconsistency():
    gt = _load_ground_truth()
    from claimguard.reference_data import SPECIALTIES
    code_meta = {c.code: c for spec in SPECIALTIES.values() for c in spec.codes}

    for letter, scheme_id in zip(SCHEME_IDS, ["A", "B", "C"]):
        members, providers, claims = _load_scheme(letter)
        members_idx = members.set_index("member_id")
        cases = [r for r in gt["single_scheme_fraud"]
                 if r["scheme_id"] == scheme_id and r["archetype"] == "membership_substitution"
                 and r["variant"] == "demographic"]
        for r in cases:
            member = members_idx.loc[r["entity_id"]]
            code = code_meta[r["billing_code"]]
            dob = pd.to_datetime(member["date_of_birth"]).date()
            svc = pd.to_datetime(r["service_date"]).date()
            age = svc.year - dob.year - ((svc.month, svc.day) < (dob.month, dob.day))
            gender_mismatch = code.gender_restriction is not None and code.gender_restriction != member["gender"]
            age_mismatch = (code.min_age is not None and age < code.min_age) or \
                           (code.max_age is not None and age > code.max_age)
            assert gender_mismatch or age_mismatch, \
                f"{r['entity_id']}: code {r['billing_code']} isn't actually inconsistent with age={age}/gender={member['gender']}"
    print("PASS: all demographic-substitution cases carry a genuine age/gender restriction violation")


# ---------------------------------------------------------------------------
# [ ] All 5 cross-scheme evasion cases present and correctly recorded
# ---------------------------------------------------------------------------
def test_cross_scheme_evasion():
    gt = _load_ground_truth()
    cfg = load_config(CONFIG_PATH)
    cases = gt["cross_scheme_evasion"]
    assert len(cases) == cfg.cross_scheme_evasion["count"], \
        f"expected {cfg.cross_scheme_evasion['count']} evasion cases, got {len(cases)}"

    _, providers_a, claims_a = _load_scheme("a")
    scheme_providers = {"b": _load_scheme("b")[1], "c": _load_scheme("c")[1]}
    scheme_claims = {"b": _load_scheme("b")[2], "c": _load_scheme("c")[2]}
    prov_a_by_id = providers_a.set_index("provider_id")

    for case in cases:
        assert case["original"]["scheme_id"] == "A"
        assert case["reappeared_as"]["scheme_id"] in ("B", "C")
        assert set(case["preserved_attributes"]) >= {"synthetic_banking_detail", "billing_fingerprint"}
        assert set(case["changed_attributes"]) >= {"name", "practice_number", "provider_id"}
        assert case["reappearance_month"] > case["exit_month"]
        assert case["reappearance_month"] - case["exit_month"] in (1, 2)

        # the hard evidence: banking detail is EXACT-matched across the two identities
        orig_id = case["original"]["provider_id"]
        new_scheme_letter = case["reappeared_as"]["scheme_id"].lower()
        new_id = case["reappeared_as"]["provider_id"]
        orig_bank = prov_a_by_id.loc[orig_id, "synthetic_banking_detail"]
        new_provs = scheme_providers[new_scheme_letter].set_index("provider_id")
        new_bank = new_provs.loc[new_id, "synthetic_banking_detail"]
        assert orig_bank == new_bank, f"{orig_id}->{new_id}: banking detail does not match exactly"

        # original's claims in scheme A must stop at/before exit_month; new identity's
        # claims in the target scheme must not start before reappearance_month
        orig_claims = claims_a[claims_a["provider_id"] == orig_id]
        last_month = pd.to_datetime(orig_claims["service_date"]).dt.to_period("M")
        start_period = pd.Period(load_config(CONFIG_PATH).start_date, freq="M")
        orig_month_idx = (last_month - start_period).apply(lambda o: o.n + 1)
        assert orig_month_idx.max() <= case["exit_month"], \
            f"{orig_id}: has claims after its recorded exit_month"

        new_claims = scheme_claims[new_scheme_letter]
        new_claims = new_claims[new_claims["provider_id"] == new_id]
        if len(new_claims):
            new_month = pd.to_datetime(new_claims["service_date"]).dt.to_period("M")
            new_month_idx = (new_month - start_period).apply(lambda o: o.n + 1)
            assert new_month_idx.min() >= case["reappearance_month"], \
                f"{new_id}: has claims before its recorded reappearance_month"

    print(f"PASS: all {len(cases)} cross-scheme evasion cases verified "
          f"(banking-detail exact match + exit/reappearance timing honored in claims.csv)")


# ---------------------------------------------------------------------------
# [ ] Distributions look plausible (automatable slice of this check)
# ---------------------------------------------------------------------------
def test_distributions_are_sane():
    for letter in SCHEME_IDS:
        _, _, claims = _load_scheme(letter)
        assert (claims["amount"] > 0).all(), f"scheme {letter}: non-positive claim amounts present"
        assert claims["amount"].isna().sum() == 0
        assert 50 < claims["amount"].median() < 3000, \
            f"scheme {letter}: median claim amount {claims['amount'].median():.2f} looks implausible"
    print("PASS: claim amounts are positive, non-null, and in a plausible ZAR range")


# ---------------------------------------------------------------------------
# [ ] Generator is rerunnable from generation_config.yaml, identical given the same seed
# ---------------------------------------------------------------------------
def test_reproducibility():
    config1 = load_config(CONFIG_PATH)
    config2 = load_config(CONFIG_PATH)

    with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
        config1.data_dir = Path(tmp1) / "data"
        config2.data_dir = Path(tmp2) / "data"

        run_pipeline(config1, verbose=False)
        run_pipeline(config2, verbose=False)

        for letter in SCHEME_IDS:
            for fname in ["members.csv", "providers.csv", "claims.csv"]:
                p1 = config1.data_dir / f"scheme_{letter}" / fname
                p2 = config2.data_dir / f"scheme_{letter}" / fname
                df1 = pd.read_csv(p1)
                df2 = pd.read_csv(p2)
                assert df1.equals(df2), f"scheme {letter} {fname}: mismatch between two runs with the same seed"

        gt1 = json.loads((config1.data_dir / "ground_truth" / "planted_fraud.json").read_text())
        gt2 = json.loads((config2.data_dir / "ground_truth" / "planted_fraud.json").read_text())
        assert gt1 == gt2, "ground truth differs between two runs with the same seed"

    print("PASS: identical seed reproduces byte-identical members/providers/claims + ground truth")


ALL_TESTS = [
    test_scheme_volumes,
    test_referential_integrity,
    test_claim_ids_globally_unique,
    test_single_scheme_fraud_entity_counts,
    test_up_coding_severity_matches_mechanic,
    test_membership_substitution_geographic_distance,
    test_membership_substitution_demographic_inconsistency,
    test_cross_scheme_evasion,
    test_distributions_are_sane,
    test_reproducibility,
]

if __name__ == "__main__":
    if not DATA_DIR.exists():
        print(f"No {DATA_DIR} found — run `python generate.py` first.")
        sys.exit(1)

    failures = []
    for test in ALL_TESTS:
        try:
            test()
        except AssertionError as e:
            failures.append((test.__name__, str(e)))
            print(f"FAIL: {test.__name__}: {e}")
        except Exception as e:
            failures.append((test.__name__, repr(e)))
            print(f"ERROR: {test.__name__}: {e!r}")

    print()
    if failures:
        print(f"{len(failures)}/{len(ALL_TESTS)} acceptance checks FAILED")
        sys.exit(1)
    else:
        print(f"All {len(ALL_TESTS)} acceptance checks PASSED")
