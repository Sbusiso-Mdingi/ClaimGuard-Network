from __future__ import annotations

import json
from pathlib import Path
import sys

from .snapshot import TenantSnapshot


def load_claims_from_json(claims_json_path: Path) -> list[dict[str, object]]:
    payload = json.loads(claims_json_path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("claims"), list):
        return payload["claims"]
    if isinstance(payload, list):
        return payload
    raise ValueError("Claims source JSON must be an array or an object containing a claims array.")


def build_report_from_ingested_claims(claims: list[dict[str, object]]) -> dict[str, object]:
    raise ValueError(
        "Claim-only runtime detection is unsupported; authoritative members, providers, and schemes are required."
    )


def _detection_imports():
    try:
        from claimguard_detection_engine.loader import build_data_bundle_from_records
        from claimguard_detection_engine.orchestration import DetectionSnapshot, run_detection_orchestration
    except ModuleNotFoundError:
        repo_root = Path(__file__).resolve().parents[4]
        detection_engine_src = repo_root / "services" / "detection-engine" / "src"
        if str(detection_engine_src) not in sys.path:
            sys.path.append(str(detection_engine_src))
        from claimguard_detection_engine.loader import build_data_bundle_from_records
        from claimguard_detection_engine.orchestration import DetectionSnapshot, run_detection_orchestration
    return build_data_bundle_from_records, DetectionSnapshot, run_detection_orchestration


def build_report_from_tenant_snapshot(
    snapshot: TenantSnapshot,
    *,
    correlation_id: str,
    top_n: int = 10,
) -> dict[str, object]:
    build_data_bundle_from_records, DetectionSnapshot, run_detection_orchestration = _detection_imports()
    bundle = build_data_bundle_from_records(
        schemes=snapshot.schemes,
        members=snapshot.members,
        providers=snapshot.providers,
        claims=snapshot.claims,
        data_dir=Path("tenant-snapshot"),
    )
    return run_detection_orchestration(
        DetectionSnapshot(
            bundle=bundle,
            tenant_id=snapshot.tenant_id,
            tenant_slug=snapshot.tenant_slug,
            tenant_display_name=snapshot.tenant_display_name,
            snapshot_cutoff=snapshot.captured_at,
            source_type="mysql_tenant_snapshot",
            source_watermark=snapshot.watermark,
            generation_correlation_id=correlation_id,
            producer_version="report-producer-0.2.0",
        ),
        top_n=top_n,
    )


def filter_claims_for_tenant(
    claims: list[dict[str, object]],
    *,
    tenant_id: str,
) -> list[dict[str, object]]:
    if not tenant_id:
        raise ValueError("tenant_id is required to filter claims.")

    has_explicit_tenant = any(claim.get("tenant_id") for claim in claims)

    if not has_explicit_tenant:
        return [
            {
                **claim,
                "tenant_id": tenant_id,
            }
            for claim in claims
        ]

    return [
        claim
        for claim in claims
        if str(claim.get("tenant_id") or "") == tenant_id
    ]
