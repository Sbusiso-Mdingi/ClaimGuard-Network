from __future__ import annotations

import json
from pathlib import Path
import sys


def load_claims_from_json(claims_json_path: Path) -> list[dict[str, object]]:
    payload = json.loads(claims_json_path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("claims"), list):
        return payload["claims"]
    if isinstance(payload, list):
        return payload
    raise ValueError("Claims source JSON must be an array or an object containing a claims array.")


def build_report_from_ingested_claims(claims: list[dict[str, object]]) -> dict[str, object]:
    try:
        from claimguard_detection_engine.pipeline import run_detection_pipeline
    except ModuleNotFoundError:
        repo_root = Path(__file__).resolve().parents[4]
        detection_engine_src = repo_root / "services" / "detection-engine" / "src"
        if str(detection_engine_src) not in sys.path:
            sys.path.append(str(detection_engine_src))
        from claimguard_detection_engine.pipeline import run_detection_pipeline

    detection = run_detection_pipeline(
        claims,
        ledger_reference={
            "type": "runtime-ledger",
            "available": False,
            "note": "Attach runtime ledger entries from the API service when database-backed ledger is enabled.",
        },
    )

    return {
        "data_dir": "ingested-claims",
        "schemes": [],
        "network": {
            "exact_banking_links": [],
            "behavioral_provider_links": [],
            "resolved_entities": [],
            "network_nodes": [],
        },
        "evaluation": {
            "available": False,
            "single_scheme": {
                "detected": 0,
                "total": 0,
                "recall": 0.0,
            },
            "cross_scheme": {
                "detected": 0,
                "total": 0,
                "recall": 0.0,
            },
        },
        "detection": detection,
    }
