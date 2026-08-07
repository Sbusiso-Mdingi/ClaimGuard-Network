from __future__ import annotations

import json
from unittest import TestCase

from claimguard_report_producer.model_service import ModelHttpResponse
from claimguard_report_producer.ordered_prospective_model_service import (
    ProspectiveModelServiceClient,
)
from claimguard_report_producer.prospective_model_service import (
    ANALYSIS_MODE,
    FEATURE_SCHEMA_VERSION,
    MODEL_ID,
    MODEL_VERSION,
    ProspectiveModelContractError,
    ProspectiveModelServiceExpectations,
)
from claimguard_report_producer.prospective_snapshot import PREDICTOR_NAMES
from claimguard_report_producer.snapshot import ProspectiveScoringSnapshot


class StaticTokenProvider:
    def get_token(self, _audience: str) -> str:
        return "access-token"


class CapturingTransport:
    def __init__(
        self,
        expectations: ProspectiveModelServiceExpectations | None = None,
    ) -> None:
        self.request: dict[str, object] | None = None
        self.expectations = (
            expectations
            or ProspectiveModelServiceExpectations.baseline(
                "claimguard-claim-fraud-baseline:1.0.0"
            )
        )

    def post(self, *, url, body, headers, timeout_seconds):
        self.request = json.loads(body.decode("utf-8"))
        target = self.request["targetClaims"][0]
        response = {
            "schemaVersion": "claimguard.claim-screening-response.v3",
            "featureSchemaVersion": self.expectations.feature_schema_version,
            "deploymentId": self.expectations.deployment_id,
            "modelId": self.expectations.model_id,
            "modelVersion": self.expectations.model_version,
            "analysisMode": self.expectations.analysis_mode,
            "tenantId": self.request["tenantId"],
            "requestId": self.request["requestId"],
            "windowWatermark": self.request["window"]["watermark"],
            "scores": [
                {
                    "claimId": target["claimId"],
                    "claimVersion": target["claimVersion"],
                    "fraudProbability": 0.9,
                    "predictedClass": "FRAUD",
                    "threshold": self.expectations.threshold,
                    "reviewRecommended": True,
                }
            ],
        }
        return ModelHttpResponse(
            status=200,
            body=json.dumps(response).encode("utf-8"),
        )


def _snapshot(
    features: dict[str, object] | None = None,
    *,
    deployment_id: str = "claimguard-claim-fraud-baseline:1.0.0",
) -> ProspectiveScoringSnapshot:
    exact = {
        name: (
            "CATEGORY"
            if name
            in {
                "benefit_option",
                "network_type",
                "line_type",
                "billing_code",
                "tariff_discipline",
                "diagnosis_code",
                "billing_provider_kind",
                "billing_provider_category",
                "rendering_practitioner_category",
            }
            else 0.0
        )
        for name in PREDICTOR_NAMES
    }
    return ProspectiveScoringSnapshot(
        assessment_id="test-assessment-id",
        tenant_id="tenant-1",
        tenant_slug="ubuntu",
        tenant_display_name="Ubuntu Medical Aid",
        detection_strategy_id=2,
        detection_strategy="approved_model",
        model_deployment_id=deployment_id,
        captured_at="2026-07-25T20:00:00+00:00",
        context_cutoff_at="2026-07-25T20:00:00+00:00",
        watermark="prospective:test",
        source_job_ids=("job-1",),
        schemes=[{"scheme_id": "U1", "scheme_name": "Ubuntu"}],
        members=[{"member_id": "M1", "scheme_id": "U1"}],
        providers=[
            {
                "provider_id": "P1",
                "scheme_id": "U1",
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
                "features": exact if features is None else features,
            }
        ],
    )


def _client(
    transport: CapturingTransport,
    expectations: ProspectiveModelServiceExpectations | None = None,
) -> ProspectiveModelServiceClient:
    return ProspectiveModelServiceClient(
        base_url="https://model.example.test",
        audience="api://claim-model",
        pseudonymization_key="x" * 32,
        expectations=(
            expectations
            or ProspectiveModelServiceExpectations.baseline(
                "claimguard-claim-fraud-baseline:1.0.0"
            )
        ),
        token_provider=StaticTokenProvider(),
        transport=transport,
    )


class ProspectiveModelServiceTests(TestCase):
    def test_screen_sends_exact_contract_and_restores_claim_identity(self) -> None:
        transport = CapturingTransport()
        result = _client(transport).screen(_snapshot())

        self.assertEqual(result.model_id, MODEL_ID)
        self.assertEqual(result.model_version, MODEL_VERSION)
        self.assertEqual(result.analysis_mode, ANALYSIS_MODE)
        self.assertEqual(result.scores[0].claim_id, "C1")
        self.assertEqual(result.scores[0].claim_version, 1)
        self.assertTrue(result.scores[0].review_recommended)

        self.assertIsNotNone(transport.request)
        assert transport.request is not None
        self.assertEqual(
            transport.request["schemaVersion"],
            "claimguard.claim-screening-request.v3",
        )
        self.assertEqual(transport.request["analysisMode"], ANALYSIS_MODE)
        self.assertEqual(
            list(transport.request["contextFeatures"]["targets"][0]["features"]),
            list(PREDICTOR_NAMES),
        )
        self.assertNotEqual(transport.request["targetClaims"][0]["claimId"], "C1")

    def test_screen_rejects_incomplete_predictor_vector(self) -> None:
        incomplete = {name: 0.0 for name in PREDICTOR_NAMES[:-1]}
        with self.assertRaisesRegex(
            ProspectiveModelContractError,
            "sealed model contract",
        ):
            _client(CapturingTransport()).screen(_snapshot(incomplete))

    def test_screen_accepts_registered_model_identity_without_baseline_constants(
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
        transport = CapturingTransport(expectations)

        result = _client(transport, expectations).screen(
            _snapshot(deployment_id=expectations.deployment_id)
        )

        self.assertEqual(result.deployment_id, expectations.deployment_id)
        self.assertEqual(result.model_id, expectations.model_id)
        self.assertEqual(result.model_version, expectations.model_version)
        self.assertEqual(result.scores[0].threshold, expectations.threshold)

    def test_screen_rejects_response_from_a_different_registered_model(
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

        with self.assertRaisesRegex(
            ProspectiveModelContractError,
            "identity is incompatible",
        ):
            _client(
                CapturingTransport(),
                expectations,
            ).screen(
                _snapshot(deployment_id=expectations.deployment_id)
            )

    def test_screen_rejects_threshold_drift(self) -> None:
        class ThresholdDriftTransport(CapturingTransport):
            def post(self, *, url, body, headers, timeout_seconds):
                response = super().post(
                    url=url,
                    body=body,
                    headers=headers,
                    timeout_seconds=timeout_seconds,
                )
                payload = json.loads(response.body.decode("utf-8"))
                payload["scores"][0]["threshold"] = 0.5
                payload["scores"][0]["predictedClass"] = "FRAUD"
                payload["scores"][0]["reviewRecommended"] = True
                return ModelHttpResponse(
                    status=200,
                    body=json.dumps(payload).encode("utf-8"),
                )

        with self.assertRaisesRegex(
            ProspectiveModelContractError,
            "threshold changed",
        ):
            _client(ThresholdDriftTransport()).screen(_snapshot())
