"""
Assembles the ground-truth answer key (spec §9) from the records collected
across every fraud module during the run.
"""
from __future__ import annotations

import json
from pathlib import Path


def build_ground_truth(
    single_scheme_fraud_records: list[dict],
    collusion_ring_records: list[dict],
    cross_scheme_evasion_records: list[dict],
) -> dict:
    return {
        "single_scheme_fraud": single_scheme_fraud_records,
        "collusion_rings": collusion_ring_records,
        "cross_scheme_evasion": cross_scheme_evasion_records,
    }


def write_ground_truth(ground_truth: dict, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(ground_truth, f, indent=2, default=str)
