from __future__ import annotations

from pathlib import Path
import sys

from .model_report import build_model_detection_report
from .model_service import ModelServiceClient, ModelServiceUnavailable
from .snapshot import TenantSnapshot


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
    model_client: ModelServiceClient | None = None,
) -> dict[str, object]:
    if snapshot.detection_strategy == "approved_model":
        if model_client is None:
            raise ModelServiceUnavailable(watermark=snapshot.watermark)
        review = model_client.review(snapshot)
        return build_model_detection_report(
            snapshot,
            review,
            correlation_id=correlation_id,
        )

    if snapshot.detection_strategy != "deterministic_rules":
        raise ModelServiceUnavailable(
            "The selected detection strategy is unsupported.",
            watermark=snapshot.watermark,
        )

    # The deterministic engine is loaded only for an explicitly selected
    # deterministic strategy. It is never a fallback for an approved model.
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
            producer_version="report-producer-0.3.0",
        ),
        top_n=top_n,
    )
