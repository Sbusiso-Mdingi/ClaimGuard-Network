from __future__ import annotations

from pathlib import Path

from claimguard_report_producer.model_schema_compatibility import (
    COMPATIBLE_OPERATIONAL_SCHEMA_VERSIONS,
    FEATURE_SCHEMA_VERSION,
    supports_operational_schema,
)
from claimguard_report_producer.prospective_snapshot import PREDICTOR_NAMES


def test_operational_schema_15_preserves_the_sealed_model_contract() -> None:
    assert FEATURE_SCHEMA_VERSION == "claim-feature-schema-2026.2"
    assert COMPATIBLE_OPERATIONAL_SCHEMA_VERSIONS == frozenset({"14", "15"})
    assert supports_operational_schema("14")
    assert supports_operational_schema(15)
    assert not supports_operational_schema("16")

    # Any predictor addition, removal, rename, or reordering is a model-contract
    # change and must be reviewed separately from an operational DB migration.
    assert len(PREDICTOR_NAMES) == 51
    assert PREDICTOR_NAMES[0] == "claimed_amount"
    assert PREDICTOR_NAMES[-1] == "rendering_practitioner_category"


def test_report_worker_keeps_schema_domains_separate() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    bicep = (repo_root / "infra" / "report-worker.bicep").read_text(
        encoding="utf-8"
    )

    assert (
        "param modelCompatibleOperationalSchemaVersions string = '14,15'"
        in bicep
    )
    assert (
        "name: 'DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS'\n"
        "              value: modelCompatibleOperationalSchemaVersions"
        in bicep
    )
    assert bicep.count(
        "name: 'MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION'"
    ) == 1
    assert "value: prospectiveFeatureSchemaVersion" in bicep
