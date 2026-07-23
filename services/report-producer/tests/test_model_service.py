from __future__ import annotations

import json
from unittest import TestCase
from unittest.mock import patch

from claimguard_report_producer.contract import validate_detection_report
from claimguard_report_producer.model_report import build_model_detection_report
from claimguard_report_producer.model_service import (
    ANALYSIS_MODE,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    RESPONSE_SCHEMA_VERSION,
    ModelHttpResponse,
    ModelServiceClient,
    ModelServiceContractError,
    ModelServiceExpectations,
    ModelServiceUnavailable,
)
from claimguard_report_producer.snapshot import TenantSnapshot
from claimguard_report_producer.sources import build_report_from_tenant_snapshot


DEPLOYMENT_ID = "claim-fraud-ensemble-1.1.0"


def snapshot(*, strategy: str = "approved_model") -> TenantSnapshot:
    return TenantSnapshot(
        tenant_id="tenant-raw-alpha",
        tenant_slug="alpha",
        tenant_display_name="Alpha",
        detection_strategy=strategy,
        model_deployment_id=DEPLOYMENT_ID if strategy == "approved_model" else None,
        captured_at="2026-07-23T08:00:00+00:00",
        watermark="claims-updated:test-watermark",
        schemes=[{"scheme_id": "scheme-raw-1", "scheme_name": "Alpha"}],
        members=[{"member_id": "member-raw-1", "scheme_id": "scheme-raw-1"}],
        providers=[{
            "provider_id": "provider-raw-1",
            "scheme_id": "scheme-raw-1",
            "specialty": "GP",
            "provider_kind": "INDIVIDUAL",
            "provider_category": "GENERAL_PRACTITIONER",
        }],
        claims=[{
            "claim_id": "claim-raw-1",
            "scheme_id": "scheme-raw-1",
            "member_id": "member-raw-1",
            "provider_id": "provider-raw-1",
            "service_date": "2026-07-20",
            "received_date": "2026-07-21",
            "billing_code": "0190",
            "amount": 650.0,
            "quantity": 1,
            "benefit_option": "COMPREHENSIVE",
            "network_type": "IN_NETWORK",
            "line_type": "PROFESSIONAL",
            "tariff_discipline": "MEDICAL",
            "diagnosis_code": "Z00.0",
            "rendering_practitioner_id": None,
            "rendering_practitioner_category": "NONE",
            "rendering_known_to_billing_provider": False,
        }],
    )


class FakeTokenProvider:
    def get_token(self, audience: str) -> str:
        if audience != "api://claim-review":
            raise AssertionError("Unexpected audience.")
        return "workload-access-token"


class EchoModelTransport:
    def __init__(self, *, changed_threshold: bool = False) -> None:
        self.changed_threshold = changed_threshold
        self.request = None
        self.headers = None

    def post(self, *, url, body, headers, timeout_seconds):
        if url != "https://models.example/v2/review-windows":
            raise AssertionError("Unexpected endpoint.")
        if timeout_seconds != 30:
            raise AssertionError("Unexpected timeout.")
        self.request = json.loads(body)
        self.headers = headers
        scores = []
        for claim in self.request["claims"]:
            baseline_threshold = (
                0.2 if self.changed_threshold else 0.08760971001434723
            )
            scores.append({
                "claimId": claim["claimId"],
                "baselineFraudProbability": 0.9,
                "baselinePredictedClass": "FRAUD",
                "baselineThreshold": baseline_threshold,
                "ringProbability": 0.01,
                "ringReviewHit": False,
                "ringThreshold": 0.148,
                "phantomProbability": 0.1,
                "phantomReviewHit": False,
                "phantomThreshold": 0.8138303120761656,
                "compositeReviewRecommended": True,
            })
        response = {
            "schemaVersion": RESPONSE_SCHEMA_VERSION,
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "ensembleId": ENSEMBLE_ID,
            "ensembleVersion": ENSEMBLE_VERSION,
            "analysisMode": ANALYSIS_MODE,
            "tenantId": self.request["tenantId"],
            "requestId": self.request["requestId"],
            "windowWatermark": self.request["window"]["watermark"],
            "scores": scores,
        }
        return ModelHttpResponse(
            status=200,
            body=json.dumps(response, sort_keys=True).encode(),
        )


def client(transport) -> ModelServiceClient:
    return ModelServiceClient(
        base_url="https://models.example",
        audience="api://claim-review",
        pseudonymization_key="a" * 32,
        expectations=ModelServiceExpectations(deployment_id=DEPLOYMENT_ID),
        token_provider=FakeTokenProvider(),
        transport=transport,
        timeout_seconds=30,
    )


class ModelServiceTests(TestCase):
    def test_request_is_pseudonymized_and_report_is_model_authoritative(self) -> None:
        transport = EchoModelTransport()
        tenant_snapshot = snapshot()
        review = client(transport).review(tenant_snapshot)

        serialized = json.dumps(transport.request, sort_keys=True)
        for raw_identifier in (
            "tenant-raw-alpha",
            "member-raw-1",
            "provider-raw-1",
            "claim-raw-1",
        ):
            self.assertNotIn(raw_identifier, serialized)
        self.assertEqual(
            transport.headers["Authorization"],
            "Bearer workload-access-token",
        )
        self.assertNotIn("x-ms-client-principal-id", transport.headers)
        self.assertEqual(review.scores[0].claim_id, "claim-raw-1")

        report = build_model_detection_report(
            tenant_snapshot,
            review,
            correlation_id="correlation-1",
        )
        validate_detection_report(
            report,
            expected_tenant_id="tenant-raw-alpha",
        )
        self.assertEqual(report["history"]["ruleExecution"]["notExecuted"], True)
        self.assertEqual(report["claims"][0]["ruleHits"], [])
        self.assertEqual(
            report["metadata"]["model"]["deploymentId"],
            DEPLOYMENT_ID,
        )

    def test_threshold_change_is_rejected_fail_closed(self) -> None:
        with self.assertRaises(ModelServiceContractError) as captured:
            client(EchoModelTransport(changed_threshold=True)).review(snapshot())
        self.assertEqual(captured.exception.code, "MODEL_SERVICE_UNAVAILABLE")
        self.assertEqual(
            captured.exception.watermark,
            "claims-updated:test-watermark",
        )

    def test_approved_model_has_no_deterministic_fallback(self) -> None:
        with patch(
            "claimguard_report_producer.sources._detection_imports",
        ) as detection_imports:
            with self.assertRaises(ModelServiceUnavailable):
                build_report_from_tenant_snapshot(
                    snapshot(),
                    correlation_id="correlation-1",
                    model_client=None,
                )
        detection_imports.assert_not_called()

    def test_approved_model_branch_never_loads_deterministic_engine(self) -> None:
        transport = EchoModelTransport()
        with patch(
            "claimguard_report_producer.sources._detection_imports",
        ) as detection_imports:
            report = build_report_from_tenant_snapshot(
                snapshot(),
                correlation_id="correlation-1",
                model_client=client(transport),
            )
        detection_imports.assert_not_called()
        self.assertEqual(
            report["claims"][0]["processingStatus"],
            "REVIEW_RECOMMENDED",
        )
