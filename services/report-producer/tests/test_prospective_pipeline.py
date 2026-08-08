from __future__ import annotations

from dataclasses import replace
from unittest import TestCase

from claimguard_report_producer.contract import validate_detection_report
from claimguard_report_producer.prospective_model_service import (
    ANALYSIS_MODE,
    FEATURE_SCHEMA_VERSION,
    MODEL_ID,
    MODEL_VERSION,
    ProspectiveClaimScore,
    ProspectiveModelServiceExpectations,
    ProspectiveScreeningResult,
)
from claimguard_report_producer.prospective_report import (
    build_prospective_detection_report,
)
from claimguard_report_producer.prospective_results import (
    load_or_score_prospective_result,
)
from claimguard_report_producer.snapshot import ProspectiveScoringSnapshot


class StaticClient:
    def __init__(
        self,
        result: ProspectiveScreeningResult,
        expectations: ProspectiveModelServiceExpectations | None = None,
    ) -> None:
        self.result = result
        self.expectations = (
            expectations
            or ProspectiveModelServiceExpectations.baseline(
                result.deployment_id,
                threshold=result.scores[0].threshold,
            )
        )
        self.calls = 0

    def screen(self, _snapshot: ProspectiveScoringSnapshot) -> ProspectiveScreeningResult:
        self.calls += 1
        return self.result


class MemoryResultsRepository:
    def __init__(self) -> None:
        self.records: dict[tuple[str, str, int], dict[str, object]] = {}

    def results_exist(self, tenant_id: str, claim_id: str, claim_version: int) -> bool:
        return (tenant_id, claim_id, claim_version) in self.records

    def save_result_records(self, records):
        stored = []
        for record in records:
            item = dict(record)
            key = (
                str(item["tenant_id"]),
                str(item["claim_id"]),
                int(item["claim_version"]),
            )
            self.records[key] = item
            stored.append(item)
        return tuple(stored)

    def load_results_for_report(self, tenant_id: str, targets):
        return [
            self.records[(tenant_id, claim_id, claim_version)]
            for claim_id, claim_version in targets
        ]


def snapshot() -> ProspectiveScoringSnapshot:
    return ProspectiveScoringSnapshot(
        assessment_id="test-assessment-id",
        tenant_id="tenant-1",
        tenant_slug="ubuntu",
        tenant_display_name="Ubuntu Medical Aid",
        detection_strategy_id=2,
        detection_strategy="approved_model",
        model_deployment_id="claimguard-claim-fraud-baseline:1.0.0",
        captured_at="2026-07-26T04:00:00+00:00",
        context_cutoff_at="2026-07-26T04:00:00+00:00",
        watermark="prospective:test-watermark",
        source_job_ids=("job-1",),
        schemes=[
            {
                "scheme_id": "U1",
                "scheme_name": "Ubuntu Medical Aid",
            }
        ],
        members=[
            {
                "member_id": "M1",
                "scheme_id": "U1",
            }
        ],
        providers=[
            {
                "provider_id": "P1",
                "scheme_id": "U1",
                "specialty": "General Practice",
                "provider_kind": "PRACTITIONER",
                "provider_category": "GP",
            }
        ],
        target_claims=[
            {
                "claim_id": "C1",
                "claim_version": 1,
                "scheme_id": "U1",
                "member_id": "M1",
                "provider_id": "P1",
                "service_date": "2026-07-20",
                "received_date": "2026-07-21",
                "amount": "650.00",
                "quantity": "1.000",
                "benefit_option": "CORE",
                "network_type": "IN_NETWORK",
                "line_type": "CONSULTATION",
                "billing_code": "0190",
                "tariff_discipline": "014",
                "diagnosis_code": "Z00.0",
                "rendering_practitioner_id": None,
                "rendering_practitioner_category": "NONE",
                "rendering_known_to_billing_provider": False,
            }
        ],
        context_features=[
            {
                "claim_id": "C1",
                "claim_version": 1,
                "features": {},
            }
        ],
    )


def result() -> ProspectiveScreeningResult:
    return ProspectiveScreeningResult(
        deployment_id="claimguard-claim-fraud-baseline:1.0.0",
        model_id=MODEL_ID,
        model_version=MODEL_VERSION,
        feature_schema_version=FEATURE_SCHEMA_VERSION,
        analysis_mode=ANALYSIS_MODE,
        request_id="screen-request-1",
        watermark="prospective:test-watermark",
        scores=(
            ProspectiveClaimScore(
                claim_id="C1",
                claim_version=1,
                fraud_probability=0.9,
                predicted_class="FRAUD",
                threshold=0.08760971001434723,
                review_recommended=True,
            ),
        ),
    )


class ProspectivePipelineTests(TestCase):
    def test_ml_result_is_persisted_reloaded_and_published_without_ensemble_fields(self) -> None:
        repository = MemoryResultsRepository()
        client = StaticClient(result())
        scoring_snapshot = snapshot()

        stored_result = load_or_score_prospective_result(
            snapshot=scoring_snapshot,
            client=client,
            repository=repository,
        )
        report = build_prospective_detection_report(
            scoring_snapshot,
            stored_result,
            correlation_id="correlation-1",
        )
        validated = validate_detection_report(
            report,
            expected_tenant_id="tenant-1",
        )

        self.assertEqual(client.calls, 1)
        self.assertEqual(stored_result.model_id, MODEL_ID)
        self.assertEqual(
            validated["metadata"]["model"]["analysisMode"],
            ANALYSIS_MODE,
        )
        self.assertEqual(
            validated["claims"][0]["modelReview"]["fraudProbability"],
            0.9,
        )
        self.assertNotIn(
            "ringProbability",
            validated["claims"][0]["modelReview"],
        )
        stored_payload = repository.records[("tenant-1", "C1", 1)]["result_payload"]
        self.assertEqual(
            stored_payload["inputDrift"]["status"],
            "PROFILE_UNAVAILABLE",
        )

        stored_again = load_or_score_prospective_result(
            snapshot=scoring_snapshot,
            client=client,
            repository=repository,
        )
        self.assertEqual(client.calls, 1)
        self.assertEqual(stored_again, stored_result)

    def test_registered_non_baseline_result_is_persisted_and_reloaded(
        self,
    ) -> None:
        expectations = ProspectiveModelServiceExpectations(
            deployment_id="claimguard-claim-fraud-ensemble:2.0.0",
            model_id="claimguard-claim-fraud-ensemble",
            model_version="2.0.0",
            feature_schema_version=FEATURE_SCHEMA_VERSION,
            analysis_mode=ANALYSIS_MODE,
            threshold=0.19,
        )
        scoring_snapshot = replace(
            snapshot(),
            model_deployment_id=expectations.deployment_id,
        )
        candidate_result = replace(
            result(),
            deployment_id=expectations.deployment_id,
            model_id=expectations.model_id,
            model_version=expectations.model_version,
            scores=(
                replace(
                    result().scores[0],
                    threshold=expectations.threshold,
                ),
            ),
        )
        repository = MemoryResultsRepository()
        client = StaticClient(candidate_result, expectations)

        stored_result = load_or_score_prospective_result(
            snapshot=scoring_snapshot,
            client=client,
            repository=repository,
        )
        stored_again = load_or_score_prospective_result(
            snapshot=scoring_snapshot,
            client=client,
            repository=repository,
        )

        self.assertEqual(stored_result.model_id, expectations.model_id)
        self.assertEqual(stored_result.model_version, expectations.model_version)
        self.assertEqual(stored_again, stored_result)
        self.assertEqual(client.calls, 1)
