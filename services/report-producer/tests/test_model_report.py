from __future__ import annotations

import copy
import json
from dataclasses import replace
from unittest import TestCase

from claimguard_report_producer.contract import (
    validate_detection_report,
)
from claimguard_report_producer.model_report import (
    DEFAULT_PRODUCER_VERSION,
    MODEL_REPORT_ENGINE_VERSION,
    REPORT_CONTRACT_VERSION,
    RISK_SCORE_BASIS,
    SOURCE_TYPE,
    ModelReportContractError,
    build_model_detection_report,
)
from claimguard_report_producer.model_service import (
    ANALYSIS_MODE,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    ClaimReviewResult,
    ReviewWindowResult,
)
from claimguard_report_producer.snapshot import (
    ProspectiveScoringSnapshot,
)


TENANT_ID = "tenant_alpha"

DEPLOYMENT_ID = (
    "claimguard-claim-fraud-ensemble:1.1.0"
)

WATERMARK = (
    "prospective:"
    "2026-07-23T12:00:00+00:00:"
    "targets:2:"
    f"sha256:{'a' * 64}"
)

CAPTURED_AT = "2026-07-23T12:00:01+00:00"

CONTEXT_CUTOFF = "2026-07-23T12:00:00+00:00"

SOURCE_JOB_ID = "job-model-1"

REQUEST_ID = "screen-" + ("b" * 64)


def claim(
    *,
    claim_id: str,
    claim_version: int,
    scheme_id: str,
    member_id: str,
    provider_id: str,
    service_date: str,
    amount: object,
) -> dict[str, object]:
    return {
        "claim_id": claim_id,
        "claim_version": claim_version,
        "scheme_id": scheme_id,
        "member_id": member_id,
        "provider_id": provider_id,
        "service_date": service_date,
        "received_date": "2026-07-23",
        "billing_code": "0190",
        "amount": amount,
        "quantity": 1,
        "benefit_option": "COMPREHENSIVE",
        "network_type": "IN_NETWORK",
        "line_type": "PROFESSIONAL",
        "tariff_discipline": "MEDICAL",
        "diagnosis_code": "Z00.0",
        "rendering_practitioner_id": None,
        "rendering_practitioner_category": "NONE",
        "rendering_known_to_billing_provider": False,
    }


def snapshot() -> ProspectiveScoringSnapshot:
    return ProspectiveScoringSnapshot(
        tenant_id=TENANT_ID,
        tenant_slug="alpha",
        tenant_display_name="Tenant Alpha",
        detection_strategy_id=29,
        detection_strategy="approved_model",
        model_deployment_id=DEPLOYMENT_ID,
        captured_at=CAPTURED_AT,
        context_cutoff_at=CONTEXT_CUTOFF,
        watermark=WATERMARK,
        source_job_ids=(
            SOURCE_JOB_ID,
        ),
        schemes=[
            {
                "scheme_id": "SCHEME-1",
                "scheme_name": "Alpha Scheme",
            }
        ],
        members=[
            {
                "member_id": "MEMBER-B",
                "scheme_id": "SCHEME-1",
            },
            {
                "member_id": "MEMBER-A",
                "scheme_id": "SCHEME-1",
            },
        ],
        providers=[
            {
                "provider_id": "PROVIDER-B",
                "scheme_id": "SCHEME-1",
                "specialty": "GENERAL_PRACTITIONER",
            },
            {
                "provider_id": "PROVIDER-A",
                "scheme_id": "SCHEME-1",
                "specialty": "GENERAL_PRACTITIONER",
            },
        ],
        target_claims=[
            claim(
                claim_id="CLAIM-B",
                claim_version=1,
                scheme_id="SCHEME-1",
                member_id="MEMBER-B",
                provider_id="PROVIDER-B",
                service_date="2026-07-22",
                amount="200.34",
            ),
            claim(
                claim_id="CLAIM-A",
                claim_version=2,
                scheme_id="SCHEME-1",
                member_id="MEMBER-A",
                provider_id="PROVIDER-A",
                service_date="2026-07-20",
                amount="100.12",
            ),
        ],
        context_features=[
            {
                "claim_id": "CLAIM-B",
                "claim_version": 1,
                "features": {
                    "historyWindowDays": 365,
                    "member": {
                        "claimCount30d": 5,
                    },
                },
            },
            {
                "claim_id": "CLAIM-A",
                "claim_version": 2,
                "features": {
                    "historyWindowDays": 365,
                    "member": {
                        "claimCount30d": 1,
                    },
                },
            },
        ],
    )


def score(
    *,
    claim_id: str,
    claim_version: int,
    baseline_probability: float,
    baseline_class: str,
    ring_probability: float,
    ring_hit: bool,
    phantom_probability: float,
    phantom_hit: bool,
    recommended: bool,
    baseline_threshold: float = 0.1,
    ring_threshold: float = 0.2,
    phantom_threshold: float = 0.8,
) -> ClaimReviewResult:
    return ClaimReviewResult(
        claim_id=claim_id,
        claim_version=claim_version,
        baseline_fraud_probability=(
            baseline_probability
        ),
        baseline_predicted_class=(
            baseline_class
        ),
        baseline_threshold=(
            baseline_threshold
        ),
        ring_probability=(
            ring_probability
        ),
        ring_review_hit=ring_hit,
        ring_threshold=ring_threshold,
        phantom_probability=(
            phantom_probability
        ),
        phantom_review_hit=(
            phantom_hit
        ),
        phantom_threshold=(
            phantom_threshold
        ),
        composite_review_recommended=(
            recommended
        ),
    )


def review() -> ReviewWindowResult:
    return ReviewWindowResult(
        deployment_id=DEPLOYMENT_ID,
        ensemble_id=ENSEMBLE_ID,
        ensemble_version=ENSEMBLE_VERSION,
        feature_schema_version=(
            FEATURE_SCHEMA_VERSION
        ),
        analysis_mode=ANALYSIS_MODE,
        request_id=REQUEST_ID,
        watermark=WATERMARK,
        scores=(
            score(
                claim_id="CLAIM-B",
                claim_version=1,
                baseline_probability=0.2,
                baseline_class="FRAUD",
                ring_probability=0.1,
                ring_hit=False,
                phantom_probability=0.1,
                phantom_hit=False,
                recommended=True,
            ),
            score(
                claim_id="CLAIM-A",
                claim_version=2,
                baseline_probability=0.01,
                baseline_class="LEGITIMATE",
                ring_probability=0.02,
                ring_hit=False,
                phantom_probability=0.08,
                phantom_hit=False,
                recommended=False,
            ),
        ),
    )


def build(
    tenant_snapshot: ProspectiveScoringSnapshot | None = None,
    model_review: ReviewWindowResult | None = None,
    *,
    correlation_id: str = "correlation-1",
    producer_version: str = (
        DEFAULT_PRODUCER_VERSION
    ),
) -> dict[str, object]:
    return build_model_detection_report(
        tenant_snapshot or snapshot(),
        model_review or review(),
        correlation_id=correlation_id,
        producer_version=producer_version,
    )


class ModelReportTests(TestCase):
    def test_valid_report_is_prospective_versioned_and_contract_compliant(
        self,
    ) -> None:
        report = build()

        validated = validate_detection_report(
            report,
            expected_tenant_id=TENANT_ID,
        )

        self.assertIs(
            validated,
            report,
        )

        self.assertEqual(
            report["contractVersion"],
            REPORT_CONTRACT_VERSION,
        )

        metadata = report["metadata"]

        self.assertEqual(
            metadata["tenant"],
            {
                "tenantId": TENANT_ID,
                "tenantSlug": "alpha",
                "displayName": "Tenant Alpha",
            },
        )

        self.assertEqual(
            metadata["generatedAt"],
            CAPTURED_AT,
        )

        self.assertEqual(
            metadata["snapshotCutoff"],
            CONTEXT_CUTOFF,
        )

        self.assertEqual(
            metadata[
                "detectionEngineVersion"
            ],
            MODEL_REPORT_ENGINE_VERSION,
        )

        self.assertEqual(
            metadata["producerVersion"],
            DEFAULT_PRODUCER_VERSION,
        )

        self.assertEqual(
            metadata[
                "generationCorrelationId"
            ],
            "correlation-1",
        )

        self.assertEqual(
            metadata["source"],
            {
                "type": SOURCE_TYPE,
                "watermark": WATERMARK,
                "historicalWindow": {
                    "mode": (
                        "aggregate_features_only"
                    ),
                    "contextCutoffAt": (
                        CONTEXT_CUTOFF
                    ),
                },
                "sourceJobIds": [
                    SOURCE_JOB_ID,
                ],
            },
        )

        self.assertEqual(
            metadata["detectionStrategy"],
            {
                "detectionStrategyId": 29,
                "strategyType": "approved_model",
            },
        )

        self.assertEqual(
            metadata["model"],
            {
                "deploymentId": DEPLOYMENT_ID,
                "ensembleId": ENSEMBLE_ID,
                "ensembleVersion": (
                    ENSEMBLE_VERSION
                ),
                "featureSchemaVersion": (
                    FEATURE_SCHEMA_VERSION
                ),
                "analysisMode": ANALYSIS_MODE,
                "requestId": REQUEST_ID,
                "riskScoreBasis": (
                    RISK_SCORE_BASIS
                ),
            },
        )

        self.assertRegex(
            metadata["reportId"],
            r"^[0-9a-f]{64}$",
        )

    def test_claim_rows_are_sorted_and_preserve_exact_versions(
        self,
    ) -> None:
        report = build()

        claims = report["claims"]

        self.assertEqual(
            [
                (
                    item["claimId"],
                    item["claimVersion"],
                )
                for item in claims
            ],
            [
                (
                    "CLAIM-A",
                    2,
                ),
                (
                    "CLAIM-B",
                    1,
                ),
            ],
        )

        claim_a = claims[0]
        claim_b = claims[1]

        self.assertEqual(
            claim_a["amount"],
            100.12,
        )

        self.assertEqual(
            claim_b["amount"],
            200.34,
        )

        self.assertEqual(
            claim_a["riskScore"],
            7.0,
        )

        self.assertEqual(
            claim_a["severity"],
            "Low",
        )

        self.assertEqual(
            claim_a["processingStatus"],
            "NO_MODEL_REVIEW",
        )

        self.assertEqual(
            claim_a["reasons"],
            [],
        )

        self.assertEqual(
            claim_b["riskScore"],
            100.0,
        )

        self.assertEqual(
            claim_b["severity"],
            "High",
        )

        self.assertEqual(
            claim_b["processingStatus"],
            "REVIEW_RECOMMENDED",
        )

        self.assertEqual(
            claim_b["reasons"],
            [
                (
                    "Baseline learned detector "
                    "reached its review threshold"
                )
            ],
        )

        self.assertEqual(
            claim_a["ruleHits"],
            [],
        )

        self.assertEqual(
            claim_b["ruleHits"],
            [],
        )

        self.assertEqual(
            claim_b["modelReview"][
                "compositeReviewRecommended"
            ],
            True,
        )

    def test_summary_provider_member_and_graph_aggregates_are_consistent(
        self,
    ) -> None:
        report = build()

        self.assertEqual(
            report["summary"],
            {
                "totalClaims": 2,
                "totalClaimedAmount": 300.46,
                "highRiskClaims": 1,
                "flaggedProviders": 1,
                "flaggedMembers": 1,
                "activeFraudPatterns": 1,
                "averageRiskScore": 53.5,
                "riskDistribution": {
                    "low": 1,
                    "medium": 0,
                    "high": 1,
                },
            },
        )

        self.assertEqual(
            [
                provider["providerId"]
                for provider
                in report["providers"]
            ],
            [
                "PROVIDER-A",
                "PROVIDER-B",
            ],
        )

        self.assertEqual(
            [
                member["memberId"]
                for member
                in report["members"]
            ],
            [
                "MEMBER-A",
                "MEMBER-B",
            ],
        )

        providers = {
            provider["providerId"]:
                provider
            for provider
            in report["providers"]
        }

        self.assertEqual(
            providers[
                "PROVIDER-B"
            ][
                "claimStatistics"
            ][
                "review_recommended_count"
            ],
            1,
        )

        self.assertEqual(
            providers[
                "PROVIDER-A"
            ][
                "claimStatistics"
            ][
                "review_recommended_count"
            ],
            0,
        )

        members = {
            member["memberId"]:
                member
            for member
            in report["members"]
        }

        self.assertEqual(
            members[
                "MEMBER-B"
            ][
                "utilizationStatistics"
            ][
                "review_recommended_count"
            ],
            1,
        )

        graph = report["graph"]

        self.assertEqual(
            graph["summary"],
            {
                "entity_count": 4,
                "relationship_count": 2,
                "claimant_count": 2,
                "provider_count": 2,
            },
        )

        self.assertEqual(
            [
                (
                    edge["claim_id"],
                    edge["claim_version"],
                )
                for edge
                in graph["edges"]
            ],
            [
                (
                    "CLAIM-A",
                    2,
                ),
                (
                    "CLAIM-B",
                    1,
                ),
            ],
        )

    def test_history_identifies_model_execution_and_no_rule_execution(
        self,
    ) -> None:
        history = build()[
            "history"
        ]

        self.assertEqual(
            history["schemeMetrics"],
            [
                {
                    "schemeId": "SCHEME-1",
                    "targetClaimCount": 2,
                }
            ],
        )

        self.assertEqual(
            history["ruleExecution"],
            {
                "triggeredRules": [],
                "triggeredRuleCount": 0,
                "notExecuted": True,
            },
        )

        self.assertEqual(
            history["modelExecution"],
            {
                "deploymentId": DEPLOYMENT_ID,
                "ensembleId": ENSEMBLE_ID,
                "ensembleVersion": (
                    ENSEMBLE_VERSION
                ),
                "featureSchemaVersion": (
                    FEATURE_SCHEMA_VERSION
                ),
                "analysisMode": ANALYSIS_MODE,
                "requestId": REQUEST_ID,
                "windowWatermark": WATERMARK,
                "reviewRecommendedClaims": 1,
                "baselineThreshold": 0.1,
                "ringThreshold": 0.2,
                "phantomThreshold": 0.8,
            },
        )

        self.assertEqual(
            history["evaluation"],
            {
                "available": False,
                "message": (
                    "Production tenant reports "
                    "do not contain ground truth."
                ),
            },
        )

        self.assertIsNone(
            history["timings"]
        )

    def test_report_does_not_embed_context_features_or_raw_claim_payloads(
        self,
    ) -> None:
        report = build()

        serialized = json.dumps(
            report,
            sort_keys=True,
        )

        self.assertNotIn(
            "context_features",
            serialized,
        )

        self.assertNotIn(
            "historyWindowDays",
            serialized,
        )

        self.assertNotIn(
            "diagnosis_code",
            serialized,
        )

        self.assertNotIn(
            "billing_code",
            serialized,
        )

        self.assertNotIn(
            "rendering_practitioner_id",
            serialized,
        )

        self.assertNotIn(
            "historicalClaims",
            serialized,
        )

    def test_repeated_build_is_stable_and_does_not_mutate_inputs(
        self,
    ) -> None:
        tenant_snapshot = snapshot()
        model_review = review()

        original_snapshot = copy.deepcopy(
            tenant_snapshot
        )

        original_review = copy.deepcopy(
            model_review
        )

        first = build(
            tenant_snapshot,
            model_review,
        )

        second = build(
            tenant_snapshot,
            model_review,
        )

        self.assertEqual(
            first,
            second,
        )

        self.assertEqual(
            tenant_snapshot,
            original_snapshot,
        )

        self.assertEqual(
            model_review,
            original_review,
        )

        self.assertEqual(
            first["metadata"][
                "generatedAt"
            ],
            CAPTURED_AT,
        )

    def test_report_id_excludes_delivery_metadata_but_changes_with_scoring_identity(
        self,
    ) -> None:
        first = build(
            correlation_id="correlation-1",
            producer_version="producer-a",
        )

        second = build(
            correlation_id="correlation-2",
            producer_version="producer-b",
        )

        self.assertEqual(
            first["metadata"]["reportId"],
            second["metadata"]["reportId"],
        )

        self.assertNotEqual(
            first["metadata"][
                "generationCorrelationId"
            ],
            second["metadata"][
                "generationCorrelationId"
            ],
        )

        changed_snapshot = replace(
            snapshot(),
            watermark=(
                "prospective:"
                "different-watermark"
            ),
        )

        changed_review = replace(
            review(),
            watermark=(
                "prospective:"
                "different-watermark"
            ),
        )

        changed = build(
            changed_snapshot,
            changed_review,
        )

        self.assertNotEqual(
            first["metadata"]["reportId"],
            changed["metadata"]["reportId"],
        )

        versioned_claims = copy.deepcopy(
            snapshot().target_claims
        )

        versioned_claims[1][
            "claim_version"
        ] = 3

        versioned_snapshot = replace(
            snapshot(),
            target_claims=versioned_claims,
        )

        versioned_scores = list(
            review().scores
        )

        versioned_scores[1] = replace(
            versioned_scores[1],
            claim_version=3,
        )

        versioned_review = replace(
            review(),
            scores=tuple(
                versioned_scores
            ),
        )

        versioned = build(
            versioned_snapshot,
            versioned_review,
        )

        self.assertNotEqual(
            first["metadata"]["reportId"],
            versioned["metadata"]["reportId"],
        )

    def test_review_must_match_snapshot_watermark_deployment_coverage_and_order(
        self,
    ) -> None:
        cases = [
            (
                replace(
                    review(),
                    watermark=(
                        "different-watermark"
                    ),
                ),
                "watermark differs",
            ),
            (
                replace(
                    review(),
                    deployment_id=(
                        "different-deployment"
                    ),
                ),
                "deployment differs",
            ),
            (
                replace(
                    review(),
                    scores=tuple(
                        reversed(
                            review().scores
                        )
                    ),
                ),
                "coverage or ordering",
            ),
            (
                replace(
                    review(),
                    scores=(
                        review().scores[0],
                    ),
                ),
                "coverage or ordering",
            ),
            (
                replace(
                    review(),
                    scores=(
                        review().scores[0],
                        review().scores[0],
                    ),
                ),
                "duplicate score",
            ),
        ]

        for model_review, message in cases:
            with self.subTest(
                message=message,
            ):
                with self.assertRaisesRegex(
                    ModelReportContractError,
                    message,
                ):
                    build(
                        model_review=(
                            model_review
                        )
                    )

    def test_review_decisions_and_thresholds_must_be_consistent(
        self,
    ) -> None:
        inconsistent_decision = (
            replace(
                review().scores[0],
                baseline_predicted_class=(
                    "LEGITIMATE"
                ),
            )
        )

        with self.assertRaisesRegex(
            ModelReportContractError,
            "decisions differ",
        ):
            build(
                model_review=replace(
                    review(),
                    scores=(
                        inconsistent_decision,
                        review().scores[1],
                    ),
                )
            )

        different_threshold = replace(
            review().scores[1],
            baseline_threshold=0.2,
        )

        with self.assertRaisesRegex(
            ModelReportContractError,
            "thresholds differ",
        ):
            build(
                model_review=replace(
                    review(),
                    scores=(
                        review().scores[0],
                        different_threshold,
                    ),
                )
            )

        invalid_probability = replace(
            review().scores[0],
            ring_probability=(
                float("nan")
            ),
        )

        with self.assertRaises(
            ModelReportContractError
        ):
            build(
                model_review=replace(
                    review(),
                    scores=(
                        invalid_probability,
                        review().scores[1],
                    ),
                )
            )

    def test_snapshot_requires_approved_model_single_job_and_unambiguous_targets(
        self,
    ) -> None:
        cases = [
            (
                replace(
                    snapshot(),
                    detection_strategy=(
                        "deterministic_rules"
                    ),
                    model_deployment_id=None,
                ),
                "approved_model",
            ),
            (
                replace(
                    snapshot(),
                    source_job_ids=(
                        "job-1",
                        "job-2",
                    ),
                ),
                "exactly one source job",
            ),
            (
                replace(
                    snapshot(),
                    target_claims=[],
                ),
                "must contain target",
            ),
        ]

        duplicate_targets = copy.deepcopy(
            snapshot().target_claims
        )

        duplicate_targets[1][
            "claim_id"
        ] = "CLAIM-B"

        cases.append(
            (
                replace(
                    snapshot(),
                    target_claims=(
                        duplicate_targets
                    ),
                ),
                "duplicate or ambiguous",
            )
        )

        for tenant_snapshot, message in cases:
            with self.subTest(
                message=message,
            ):
                with self.assertRaisesRegex(
                    ModelReportContractError,
                    message,
                ):
                    build(
                        tenant_snapshot=(
                            tenant_snapshot
                        )
                    )

    def test_claim_entity_references_must_be_valid_for_the_same_scheme(
        self,
    ) -> None:
        mutations = [
            (
                "scheme_id",
                "UNKNOWN-SCHEME",
                "unknown scheme",
            ),
            (
                "member_id",
                "UNKNOWN-MEMBER",
                "invalid member",
            ),
            (
                "provider_id",
                "UNKNOWN-PROVIDER",
                "invalid provider",
            ),
        ]

        for field, value, message in mutations:
            with self.subTest(
                field=field,
            ):
                target_claims = copy.deepcopy(
                    snapshot().target_claims
                )

                target_claims[0][field] = value

                with self.assertRaisesRegex(
                    ModelReportContractError,
                    message,
                ):
                    build(
                        tenant_snapshot=replace(
                            snapshot(),
                            target_claims=(
                                target_claims
                            ),
                        )
                    )

        wrong_scheme_members = (
            copy.deepcopy(
                snapshot().members
            )
        )

        wrong_scheme_members[0][
            "scheme_id"
        ] = "SCHEME-OTHER"

        with self.assertRaisesRegex(
            ModelReportContractError,
            "invalid member",
        ):
            build(
                tenant_snapshot=replace(
                    snapshot(),
                    members=(
                        wrong_scheme_members
                    ),
                )
            )

        wrong_scheme_providers = (
            copy.deepcopy(
                snapshot().providers
            )
        )

        wrong_scheme_providers[0][
            "scheme_id"
        ] = "SCHEME-OTHER"

        with self.assertRaisesRegex(
            ModelReportContractError,
            "invalid provider",
        ):
            build(
                tenant_snapshot=replace(
                    snapshot(),
                    providers=(
                        wrong_scheme_providers
                    ),
                )
            )

    def test_invalid_claim_amount_date_and_generation_metadata_fail_closed(
        self,
    ) -> None:
        invalid_claim_values = [
            (
                "amount",
                0,
                "positive monetary amount",
            ),
            (
                "amount",
                float("nan"),
                "positive monetary amount",
            ),
            (
                "service_date",
                "not-a-date",
                "ISO calendar date",
            ),
        ]

        for field, value, message in (
            invalid_claim_values
        ):
            with self.subTest(
                field=field,
                value=value,
            ):
                target_claims = copy.deepcopy(
                    snapshot().target_claims
                )

                target_claims[0][field] = value

                with self.assertRaisesRegex(
                    ModelReportContractError,
                    message,
                ):
                    build(
                        tenant_snapshot=replace(
                            snapshot(),
                            target_claims=(
                                target_claims
                            ),
                        )
                    )

        with self.assertRaisesRegex(
            ModelReportContractError,
            "correlation_id is required",
        ):
            build(
                correlation_id="",
            )

        with self.assertRaisesRegex(
            ModelReportContractError,
            "producer_version is required",
        ):
            build(
                producer_version="",
            )

    def test_duplicate_scheme_member_and_provider_identifiers_fail(
        self,
    ) -> None:
        cases = [
            (
                "schemes",
                snapshot().schemes
                + copy.deepcopy(
                    snapshot().schemes
                ),
                "duplicate schemes identifier",
            ),
            (
                "members",
                snapshot().members
                + [
                    copy.deepcopy(
                        snapshot().members[0]
                    )
                ],
                "duplicate members identifier",
            ),
            (
                "providers",
                snapshot().providers
                + [
                    copy.deepcopy(
                        snapshot().providers[0]
                    )
                ],
                "duplicate providers identifier",
            ),
        ]

        for field, values, message in cases:
            with self.subTest(
                field=field,
            ):
                with self.assertRaisesRegex(
                    ModelReportContractError,
                    message,
                ):
                    build(
                        tenant_snapshot=replace(
                            snapshot(),
                            **{
                                field: values,
                            },
                        )
                    )
