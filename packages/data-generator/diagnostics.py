#!/usr/bin/env python3
"""
Generates the visual sanity-check plots spec §13 asks for:
"Plotting claim severity and frequency distributions for 'normal'
members/providers looks plausible on visual inspection."

Usage:
    python diagnostics.py [--scheme a|b|c] [--out diagnostics_output]

Requires `python generate.py` to have been run first.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

DATA_DIR = Path(__file__).parent / "data"


def load_scheme(letter: str):
    d = DATA_DIR / f"scheme_{letter}"
    members = pd.read_csv(d / "members.csv")
    providers = pd.read_csv(d / "providers.csv")
    claims = pd.read_csv(d / "claims.csv")
    return members, providers, claims


def fraud_provider_ids(scheme_id: str) -> set[str]:
    gt = json.loads((DATA_DIR / "ground_truth" / "planted_fraud.json").read_text())
    ids = {r["entity_id"] for r in gt["single_scheme_fraud"]
           if r["scheme_id"] == scheme_id and r["entity_type"] == "provider"}
    ids |= {r["ring_provider"] for r in gt["collusion_rings"] if r["scheme_id"] == scheme_id}
    return ids


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scheme", default="a", choices=["a", "b", "c"])
    parser.add_argument("--out", default="diagnostics_output")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(exist_ok=True)

    members, providers, claims = load_scheme(args.scheme)
    scheme_id = args.scheme.upper()
    fraud_ids = fraud_provider_ids(scheme_id)
    normal_claims = claims[~claims["provider_id"].isin(fraud_ids)]

    # 1) claim severity distribution per specialty (normal claims only)
    claims_with_specialty = normal_claims.merge(
        providers[["provider_id", "specialty"]], on="provider_id", how="left"
    )
    specialties = sorted(claims_with_specialty["specialty"].dropna().unique())
    fig, axes = plt.subplots(2, 4, figsize=(18, 8))
    for ax, specialty in zip(axes.flat, specialties):
        vals = claims_with_specialty.loc[claims_with_specialty["specialty"] == specialty, "amount"]
        ax.hist(vals, bins=40, color="#3b6ea5")
        ax.set_title(f"{specialty} (n={len(vals)})")
        ax.set_xlabel("claim amount (ZAR)")
    for ax in axes.flat[len(specialties):]:
        ax.axis("off")
    fig.suptitle(f"Scheme {scheme_id}: claim severity by specialty (normal claims only)")
    fig.tight_layout()
    fig.savefig(out_dir / f"scheme_{args.scheme}_severity_by_specialty.png", dpi=120)
    plt.close(fig)

    # 2) claim frequency per member (normal members only, fraud members excluded via ring/substitution ids optional)
    claims_per_member = normal_claims.groupby("member_id").size()
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.hist(claims_per_member, bins=range(0, int(claims_per_member.max()) + 2), color="#5aa06a")
    ax.set_title(f"Scheme {scheme_id}: claims per member over 24 months (normal providers only)")
    ax.set_xlabel("number of claims")
    ax.set_ylabel("number of members")
    fig.tight_layout()
    fig.savefig(out_dir / f"scheme_{args.scheme}_claims_per_member.png", dpi=120)
    plt.close(fig)

    # 3) provider monthly claim volume: fraud vs normal, log scale — the plot
    #    that should make ghost-claiming/up-coding providers visually pop out
    claims["month"] = pd.to_datetime(claims["service_date"]).dt.to_period("M")
    monthly = claims.groupby(["provider_id", "month"]).size().reset_index(name="claim_count")
    provider_avg_monthly = monthly.groupby("provider_id")["claim_count"].mean()
    is_fraud = provider_avg_monthly.index.isin(fraud_ids)

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.hist(provider_avg_monthly[~is_fraud], bins=30, alpha=0.7, label="normal providers", color="#3b6ea5")
    ax.hist(provider_avg_monthly[is_fraud], bins=30, alpha=0.9, label="planted fraud providers", color="#d1495b")
    ax.set_title(f"Scheme {scheme_id}: avg monthly claim volume per provider")
    ax.set_xlabel("avg claims / month")
    ax.set_ylabel("number of providers")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_dir / f"scheme_{args.scheme}_provider_volume_fraud_vs_normal.png", dpi=120)
    plt.close(fig)

    print(f"Wrote 3 diagnostic plots to {out_dir.resolve()}")


if __name__ == "__main__":
    main()
