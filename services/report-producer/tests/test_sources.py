from __future__ import annotations

import copy
from dataclasses import replace
from unittest import TestCase
from unittest.mock import patch

import claimguard_report_producer.sources as sources
from claimguard_report_producer.detection_results import (
    DetectionResultContractError,
    DetectionResultIntegrityError,
    RESULT_PAYLOAD_SCHEMA_VERSION,
)
from claimguard_report_producer.model_service import (
    ANALYSIS_MODE,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    ClaimReviewResult,
    ModelServiceUnavailable,
    ReviewWindowResult,
)
from claimguard_report_producer.snapshot import (
    ProspectiveScoringSnapshot,
)
from claimguard_report_producer.sources import (
    build_report_from_tenant_snapshot,
)


TENANT_ID = "tenant_alpha"
SOURCE_JOB_ID = "job-1"

DEPLOYMENT_ID = (
    "claimguard-claim-fraud-ensemble:1.1.0"
)

WATERMARK = (
    "prospective:"
    "2026-07-23T12:00:00+00:00:"
    "targets:2:"
    f"sha256:{'a' * 64}"
)

CAPTURED_AT = (
    "2026-07-23T12:00:01+00:00"
)

CONTEXT_CUTOFF = (
    "2026-07-23T12:00:00+00:00"
)

MODEL_REQUEST_ID = (
    "screen-" + ("b" * 64)
)


def _claim(
    claim_id: str,
    claim_version: int,
    member_id: str,
    provider_id: str,
    amount: float,
) -> dict[str, object]:
    return {
        "claim_id":
            claim_id,

        "claim_version":
            claim_version,

        "scheme_id":
            "SCHEME-1",

        "member_id":
            member_id,

        "provider_id":
            provider_id,

        "service_date":
            "2026-07-22",

        "received_date":
            "2026-07-23",

        "billing_code":
            "0190",

        "amount":
            amount,

        "quantity":
            1,

        "benefit_option":
            "COMPREHENSIVE",

        "network_type":
            "IN_NETWORK",

        "line_type":
            "PROFESSIONAL",

        "tariff_discipline":
            "MEDICAL",

        "diagnosis_code":
            "Z00.0",

        "rendering_practitioner_id":
            None,

        "rendering_practitioner_category":
            "NONE",

        "rendering_known_to_billing_provider":
            False,
    }


def _snapshot(
    *,
    strategy: str = "approved_model",
    deployment_id: str | None = (
        DEPLOYMENT_ID
    ),
) -> ProspectiveScoringSnapshot:
    return ProspectiveScoringSnapshot(
        tenant_id=TENANT_ID,

        tenant_slug="alpha",

        tenant_display_name=(
            "Tenant Alpha"
        ),

        detection_strategy_id=29,

        detection_strategy=strategy,

        model_deployment_id=(
            deployment_id
        ),

        captured_at=CAPTURED_AT,

        context_cutoff_at=(
            CONTEXT_CUTOFF
        ),

        watermark=WATERMARK,

        source_job_ids=(
            SOURCE_JOB_ID,
        ),

        schemes=[
            {
                "scheme_id":
                    "SCHEME-1",

                "scheme_name":
                    "Alpha Scheme",
            }
        ],

        members=[
            {
                "member_id":
                    "MEMBER-B",

                "scheme_id":
                    "SCHEME-1",
            },
            {
                "member_id":
                    "MEMBER-A",

                "scheme_id":
                    "SCHEME-1",
            },
        ],

        providers=[
            {
                "provider_id":
                    "PROVIDER-B",

                "scheme_id":
                    "SCHEME-1",

                "specialty":
                    (
                        "GENERAL_"
                        "PRACTITIONER"
                    ),
            },
            {
                "provider_id":
                    "PROVIDER-A",

                "scheme_id":
                    "SCHEME-1",

                "specialty":
                    (
                        "GENERAL_"
                        "PRACTITIONER"
                    ),
            },
        ],

        target_claims=[
            _claim(
                "CLAIM-B",
                1,
                "MEMBER-B",
                "PROVIDER-B",
                200.0,
            ),
            _claim(
                "CLAIM-A",
                2,
                "MEMBER-A",
                "PROVIDER-A",
                100.0,
            ),
        ],

        context_features=[
            {
                "claim_id":
                    "CLAIM-B",

                "claim_version":
                    1,

                "features": {
                    "historicalClaimCount":
                        9,
                },
            },
            {
                "claim_id":
                    "CLAIM-A",

                "claim_version":
                    2,

                "features": {
                    "historicalClaimCount":
                        3,
                },
            },
        ],
    )


def _score(
    claim_id: str,
    claim_version: int,
    recommended: bool,
) -> ClaimReviewResult:
    return ClaimReviewResult(
        claim_id=claim_id,

        claim_version=claim_version,

        baseline_fraud_probability=(
            0.9
            if recommended
            else 0.01
        ),

        baseline_predicted_class=(
            "FRAUD"
            if recommended
            else "LEGITIMATE"
        ),

        baseline_threshold=0.1,

        ring_probability=0.05,

        ring_review_hit=False,

        ring_threshold=0.2,

        phantom_probability=0.1,

        phantom_review_hit=False,

        phantom_threshold=0.8,

        composite_review_recommended=(
            recommended
        ),
    )


def _review(
    *,
    request_id: str = (
        MODEL_REQUEST_ID
    ),
) -> ReviewWindowResult:
    return ReviewWindowResult(
        deployment_id=DEPLOYMENT_ID,

        ensemble_id=ENSEMBLE_ID,

        ensemble_version=(
            ENSEMBLE_VERSION
        ),

        feature_schema_version=(
            FEATURE_SCHEMA_VERSION
        ),

        analysis_mode=ANALYSIS_MODE,

        request_id=request_id,

        watermark=WATERMARK,

        scores=(
            _score(
                "CLAIM-B",
                1,
                True,
            ),
            _score(
                "CLAIM-A",
                2,
                False,
            ),
        ),
    )


def _model_rows(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
) -> list[
    dict[
        str,
        object,
    ]
]:
    scores = {
        (
            item.claim_id,
            item.claim_version,
        ):
            item
        for item
        in review.scores
    }

    rows: list[
        dict[
            str,
            object,
        ]
    ] = []

    for claim in (
        snapshot.target_claims
    ):
        claim_id = str(
            claim[
                "claim_id"
            ]
        )

        claim_version = int(
            claim[
                "claim_version"
            ]
        )

        score = scores[
            (
                claim_id,
                claim_version,
            )
        ]

        payload = {
            "schemaVersion":
                (
                    RESULT_PAYLOAD_SCHEMA_VERSION
                ),

            "tenantId":
                snapshot.tenant_id,

            "claimId":
                claim_id,

            "claimVersion":
                claim_version,

            "sourceJobId":
                snapshot
                .source_job_ids[0],

            "requestId":
                review.request_id,

            "watermark":
                snapshot.watermark,

            "analysisMode":
                review.analysis_mode,

            "strategy": {
                "detectionStrategyId":
                    snapshot
                    .detection_strategy_id,

                "strategyType":
                    "approved_model",

                "modelDeploymentId":
                    snapshot
                    .model_deployment_id,
            },

            "model": {
                "deploymentId":
                    review.deployment_id,

                "ensembleId":
                    review.ensemble_id,

                "ensembleVersion":
                    review
                    .ensemble_version,

                "featureSchemaVersion":
                    review
                    .feature_schema_version,
            },

            "score": {
                "baselineFraudProbability":
                    score
                    .baseline_fraud_probability,

                "baselinePredictedClass":
                    score
                    .baseline_predicted_class,

                "baselineThreshold":
                    score
                    .baseline_threshold,

                "ringProbability":
                    score
                    .ring_probability,

                "ringReviewHit":
                    score
                    .ring_review_hit,

                "ringThreshold":
                    score
                    .ring_threshold,

                "phantomProbability":
                    score
                    .phantom_probability,

                "phantomReviewHit":
                    score
                    .phantom_review_hit,

                "phantomThreshold":
                    score
                    .phantom_threshold,

                "compositeReviewRecommended":
                    score
                    .composite_review_recommended,
            },
        }

        rows.append(
            {
                "tenant_id":
                    snapshot.tenant_id,

                "claim_id":
                    claim_id,

                "claim_version":
                    claim_version,

                "detection_strategy_id":
                    snapshot
                    .detection_strategy_id,

                "strategy_type":
                    "approved_model",

                "model_deployment_id":
                    snapshot
                    .model_deployment_id,

                "source_job_id":
                    snapshot
                    .source_job_ids[0],

                "request_id":
                    review.request_id,

                "analysis_mode":
                    review.analysis_mode,

                "ensemble_id":
                    review.ensemble_id,

                "ensemble_version":
                    review
                    .ensemble_version,

                "feature_schema_version":
                    review
                    .feature_schema_version,

                "result_payload":
                    payload,

                "result_hash":
                    "0" * 64,

                "scored_at":
                    CAPTURED_AT,
            }
        )

    return rows


def _deterministic_report(
    snapshot: ProspectiveScoringSnapshot,
) -> dict[str, object]:
    return {
        "contractVersion":
            "1.0",

        "metadata": {
            "reportId":
                "d" * 64,

            "tenant": {
                "tenantId":
                    snapshot.tenant_id,
            },

            "generatedAt":
                snapshot.captured_at,

            "snapshotCutoff":
                snapshot
                .context_cutoff_at,

            "source": {
                "watermark":
                    snapshot.watermark,

                "sourceJobIds":
                    list(
                        snapshot
                        .source_job_ids
                    ),
            },
        },

        "summary": {
            "totalClaims":
                2,

            "totalClaimedAmount":
                300.0,
        },

        "claims": [
            {
                "claimId":
                    "CLAIM-A",

                "amount":
                    100.0,

                "processingStatus":
                    "NO_REVIEW",

                "ruleHits":
                    [],
            },
            {
                "claimId":
                    "CLAIM-B",

                "amount":
                    200.0,

                "processingStatus":
                    (
                        "REVIEW_"
                        "RECOMMENDED"
                    ),

                "ruleHits": [
                    "HIGH_AMOUNT",
                ],
            },
        ],

        "providers":
            [],

        "members":
            [],

        "graph": {
            "nodes":
                [],

            "edges":
                [],
        },

        "risk":
            {},

        "history": {
            "ruleExecution": {
                "notExecuted":
                    False,
            },
        },
    }


class FakeResultsRepository:
    def __init__(
        self,
    ) -> None:
        self.records: dict[
            tuple[
                str,
                str,
                int,
            ],
            dict[
                str,
                object,
            ],
        ] = {}

        self.load_calls = []

        self.save_model_calls = []

        self.save_record_calls = []

        self.stored_model_request_id: (
            str | None
        ) = None

    def _store(
        self,
        rows,
    ) -> None:
        for row in rows:
            key = (
                str(
                    row[
                        "tenant_id"
                    ]
                ),
                str(
                    row[
                        "claim_id"
                    ]
                ),
                int(
                    row[
                        "claim_version"
                    ]
                ),
            )

            self.records[
                key
            ] = copy.deepcopy(
                row
            )

    def results_exist(
        self,
        tenant_id: str,
        claim_id: str,
        claim_version: int,
    ) -> bool:
        return (
            tenant_id,
            claim_id,
            claim_version,
        ) in self.records

    def load_results_for_report(
        self,
        tenant_id: str,
        targets,
    ):
        references = tuple(
            (
                str(
                    target[0]
                    if isinstance(
                        target,
                        tuple,
                    )
                    else target[
                        "claim_id"
                    ]
                ),
                int(
                    target[1]
                    if isinstance(
                        target,
                        tuple,
                    )
                    else target[
                        "claim_version"
                    ]
                ),
            )
            for target
            in targets
        )

        self.load_calls.append(
            (
                tenant_id,
                references,
            )
        )

        return [
            copy.deepcopy(
                self.records[
                    (
                        tenant_id,
                        claim_id,
                        claim_version,
                    )
                ]
            )
            for (
                claim_id,
                claim_version,
            )
            in references
        ]

    def save_results(
        self,
        *,
        snapshot: (
            ProspectiveScoringSnapshot
        ),
        review: ReviewWindowResult,
    ):
        self.save_model_calls.append(
            (
                snapshot,
                review,
            )
        )

        stored_review = (
            replace(
                review,
                request_id=(
                    self
                    .stored_model_request_id
                ),
            )
            if (
                self
                .stored_model_request_id
            )
            else review
        )

        rows = _model_rows(
            snapshot,
            stored_review,
        )

        self._store(
            rows
        )

        return tuple(
            rows
        )

    def save_result_records(
        self,
        records,
    ):
        rows = copy.deepcopy(
            list(
                records
            )
        )

        self.save_record_calls.append(
            rows
        )

        self._store(
            rows
        )

        return tuple(
            rows
        )


class FakeModelClient:
    def __init__(
        self,
        result: (
            ReviewWindowResult
            | None
        ) = None,
        *,
        error: (
            Exception
            | None
        ) = None,
    ) -> None:
        self.result = (
            result
            or _review()
        )

        self.error = error

        self.calls = []

    def review(
        self,
        snapshot: (
            ProspectiveScoringSnapshot
        ),
    ) -> ReviewWindowResult:
        self.calls.append(
            snapshot
        )

        if self.error is not None:
            raise self.error

        return self.result


class FakeDetectionSnapshot:
    def __init__(
        self,
        **kwargs,
    ) -> None:
        self.__dict__.update(
            kwargs
        )


class FakeDeterministicEngine:
    def __init__(
        self,
        report: dict[
            str,
            object,
        ],
    ) -> None:
        self.report = report

        self.bundle_calls = []

        self.run_calls = []

    def build_bundle(
        self,
        **kwargs,
    ):
        self.bundle_calls.append(
            copy.deepcopy(
                kwargs
            )
        )

        return {
            "claims":
                copy.deepcopy(
                    kwargs[
                        "claims"
                    ]
                ),
        }

    def detection_snapshot(
        self,
        **kwargs,
    ):
        return (
            FakeDetectionSnapshot(
                **kwargs
            )
        )

    def run(
        self,
        snapshot,
        *,
        top_n: int,
    ):
        self.run_calls.append(
            (
                snapshot,
                top_n,
            )
        )

        return copy.deepcopy(
            self.report
        )

    def imports(
        self,
    ):
        return (
            self.build_bundle,
            self.detection_snapshot,
            self.run,
        )


class SourcesTests(
    TestCase,
):
    def test_entrypoint_validation_fails_closed(
        self,
    ) -> None:
        repository = (
            FakeResultsRepository()
        )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            (
                "prospective scoring "
                "snapshot"
            ),
        ):
            build_report_from_tenant_snapshot(
                object(),
                correlation_id=(
                    "correlation-1"
                ),
                results_repository=(
                    repository
                ),
            )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            (
                "immutable detection-results "
                "repository"
            ),
        ):
            build_report_from_tenant_snapshot(
                _snapshot(),
                correlation_id=(
                    "correlation-1"
                ),
            )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            (
                "correlation_id "
                "is required"
            ),
        ):
            build_report_from_tenant_snapshot(
                _snapshot(),
                correlation_id="",
                results_repository=(
                    repository
                ),
            )

        for top_n in (
            0,
            -1,
            True,
            1.5,
            "invalid",
        ):
            with self.subTest(
                top_n=top_n,
            ):
                with self.assertRaises(
                    DetectionResultContractError
                ):
                    build_report_from_tenant_snapshot(
                        _snapshot(),
                        correlation_id=(
                            "correlation-1"
                        ),
                        top_n=top_n,
                        results_repository=(
                            repository
                        ),
                    )

        unsupported = replace(
            _snapshot(),
            detection_strategy=(
                "experimental"
            ),
        )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            "unsupported",
        ):
            build_report_from_tenant_snapshot(
                unsupported,
                correlation_id=(
                    "correlation-1"
                ),
                results_repository=(
                    repository
                ),
            )

        deterministic = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            (
                "cannot use a "
                "model client"
            ),
        ):
            build_report_from_tenant_snapshot(
                deterministic,
                correlation_id=(
                    "correlation-1"
                ),
                model_client=(
                    FakeModelClient()
                ),
                results_repository=(
                    repository
                ),
            )

    def test_absent_model_results_are_saved_reloaded_and_reported_from_storage(
        self,
    ) -> None:
        snapshot = _snapshot()

        repository = (
            FakeResultsRepository()
        )

        repository.stored_model_request_id = (
            "stored-request-id"
        )

        client = FakeModelClient(
            _review(
                request_id=(
                    "transient-request-id"
                )
            )
        )

        captured = {}

        def builder(
            snapshot_arg,
            review_arg,
            *,
            correlation_id,
        ):
            captured[
                "snapshot"
            ] = snapshot_arg

            captured[
                "review"
            ] = review_arg

            captured[
                "correlation_id"
            ] = correlation_id

            return {
                "kind":
                    "model",

                "requestId":
                    review_arg
                    .request_id,
            }

        with patch.object(
            sources,
            (
                "build_model_"
                "detection_report"
            ),
            side_effect=builder,
        ):
            report = (
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-1"
                    ),
                    model_client=(
                        client
                    ),
                    results_repository=(
                        repository
                    ),
                )
            )

        self.assertEqual(
            len(
                client.calls
            ),
            1,
        )

        self.assertEqual(
            len(
                repository
                .save_model_calls
            ),
            1,
        )

        self.assertEqual(
            repository
            .save_model_calls[0][1]
            .request_id,
            "transient-request-id",
        )

        self.assertEqual(
            captured[
                "review"
            ].request_id,
            "stored-request-id",
        )

        self.assertEqual(
            report,
            {
                "kind":
                    "model",

                "requestId":
                    "stored-request-id",
            },
        )

    def test_complete_model_results_bypass_model_service_and_save(
        self,
    ) -> None:
        snapshot = _snapshot()

        repository = (
            FakeResultsRepository()
        )

        repository._store(
            _model_rows(
                snapshot,
                _review(
                    request_id=(
                        "already-stored-"
                        "request"
                    )
                ),
            )
        )

        client = FakeModelClient(
            error=AssertionError(
                (
                    "The model must "
                    "not be called."
                )
            )
        )

        with patch.object(
            sources,
            (
                "build_model_"
                "detection_report"
            ),
            return_value={
                "kind":
                    "stored-model",
            },
        ) as builder:
            report = (
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-1"
                    ),
                    model_client=(
                        client
                    ),
                    results_repository=(
                        repository
                    ),
                )
            )

        self.assertEqual(
            client.calls,
            [],
        )

        self.assertEqual(
            repository
            .save_model_calls,
            [],
        )

        self.assertEqual(
            report,
            {
                "kind":
                    "stored-model",
            },
        )

        self.assertEqual(
            builder
            .call_args
            .args[1]
            .request_id,
            (
                "already-stored-"
                "request"
            ),
        )

    def test_absent_model_without_client_and_partial_state_fail_correctly(
        self,
    ) -> None:
        snapshot = _snapshot()

        repository = (
            FakeResultsRepository()
        )

        with self.assertRaises(
            ModelServiceUnavailable
        ) as captured:
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-1"
                ),
                results_repository=(
                    repository
                ),
            )

        self.assertEqual(
            captured
            .exception
            .watermark,
            WATERMARK,
        )

        repository._store(
            _model_rows(
                snapshot,
                _review(),
            )[:1]
        )

        client = (
            FakeModelClient()
        )

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            "Only part",
        ):
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-1"
                ),
                model_client=(
                    client
                ),
                results_repository=(
                    repository
                ),
            )

        self.assertEqual(
            client.calls,
            [],
        )

        self.assertEqual(
            repository
            .save_model_calls,
            [],
        )

    def test_model_failure_never_falls_back_to_deterministic_rules(
        self,
    ) -> None:
        client = FakeModelClient(
            error=ModelServiceUnavailable(
                "model unavailable",
                watermark=WATERMARK,
            )
        )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                AssertionError(
                    (
                        "No deterministic "
                        "fallback is allowed."
                    )
                )
            ),
        ):
            with self.assertRaises(
                ModelServiceUnavailable
            ):
                build_report_from_tenant_snapshot(
                    _snapshot(),
                    correlation_id=(
                        "correlation-1"
                    ),
                    model_client=(
                        client
                    ),
                    results_repository=(
                        FakeResultsRepository()
                    ),
                )

    def test_stored_model_identity_payload_and_decisions_are_verified(
        self,
    ) -> None:
        snapshot = _snapshot()

        base_rows = _model_rows(
            snapshot,
            _review(),
        )

        mutations = [
            (
                lambda rows:
                    rows[0].__setitem__(
                        "source_job_id",
                        "wrong-job",
                    ),
                "identity differs",
            ),
            (
                lambda rows:
                    rows[0][
                        "result_payload"
                    ].__setitem__(
                        "watermark",
                        "wrong-watermark",
                    ),
                "payload differs",
            ),
            (
                lambda rows:
                    rows[1][
                        "result_payload"
                    ].__setitem__(
                        "requestId",
                        "different-request",
                    ),
                "execution identity",
            ),
            (
                lambda rows:
                    rows[0][
                        "result_payload"
                    ][
                        "score"
                    ].__setitem__(
                        (
                            "compositeReview"
                            "Recommended"
                        ),
                        False,
                    ),
                "decisions differ",
            ),
        ]

        for mutate, message in (
            mutations
        ):
            with self.subTest(
                message=message,
            ):
                rows = copy.deepcopy(
                    base_rows
                )

                mutate(
                    rows
                )

                repository = (
                    FakeResultsRepository()
                )

                repository._store(
                    rows
                )

                with self.assertRaisesRegex(
                    DetectionResultIntegrityError,
                    message,
                ):
                    build_report_from_tenant_snapshot(
                        snapshot,
                        correlation_id=(
                            "correlation-1"
                        ),
                        results_repository=(
                            repository
                        ),
                    )

    def test_deterministic_engine_receives_only_triggering_claim_versions(
        self,
    ) -> None:
        snapshot = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        repository = (
            FakeResultsRepository()
        )

        engine = (
            FakeDeterministicEngine(
                _deterministic_report(
                    snapshot
                )
            )
        )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                engine.imports
            ),
        ):
            report = (
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-1"
                    ),
                    top_n=7,
                    results_repository=(
                        repository
                    ),
                )
            )

        bundle = (
            engine.bundle_calls[0]
        )

        self.assertEqual(
            bundle[
                "claims"
            ],
            snapshot.target_claims,
        )

        self.assertNotIn(
            "context_features",
            bundle,
        )

        self.assertEqual(
            engine
            .run_calls[0][1],
            7,
        )

        self.assertEqual(
            len(
                repository
                .save_record_calls
            ),
            1,
        )

        saved = (
            repository
            .save_record_calls[0]
        )

        self.assertEqual(
            len(
                saved
            ),
            2,
        )

        self.assertEqual(
            sum(
                (
                    "report"
                    in row[
                        "result_payload"
                    ]
                )
                for row
                in saved
            ),
            1,
        )

        self.assertEqual(
            [
                (
                    claim[
                        "claimId"
                    ],
                    claim[
                        "claimVersion"
                    ],
                )
                for claim
                in report[
                    "claims"
                ]
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

    def test_deterministic_retry_reuses_stored_anchor(
        self,
    ) -> None:
        snapshot = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        repository = (
            FakeResultsRepository()
        )

        engine = (
            FakeDeterministicEngine(
                _deterministic_report(
                    snapshot
                )
            )
        )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                engine.imports
            ),
        ):
            first = (
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-first"
                    ),
                    results_repository=(
                        repository
                    ),
                )
            )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                AssertionError(
                    (
                        "Stored retry must "
                        "not rerun rules."
                    )
                )
            ),
        ):
            second = (
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-second"
                    ),
                    results_repository=(
                        repository
                    ),
                )
            )

        self.assertEqual(
            first,
            second,
        )

        self.assertEqual(
            len(
                engine.run_calls
            ),
            1,
        )

        self.assertEqual(
            len(
                repository
                .save_record_calls
            ),
            1,
        )

    def test_partial_deterministic_state_fails_before_rule_execution(
        self,
    ) -> None:
        snapshot = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        repository = (
            FakeResultsRepository()
        )

        engine = (
            FakeDeterministicEngine(
                _deterministic_report(
                    snapshot
                )
            )
        )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                engine.imports
            ),
        ):
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-1"
                ),
                results_repository=(
                    repository
                ),
            )

        repository.records.pop(
            next(
                iter(
                    repository.records
                )
            )
        )

        with patch.object(
            sources,
            "_detection_imports",
            side_effect=(
                AssertionError(
                    (
                        "Partial state must "
                        "not rerun rules."
                    )
                )
            ),
        ):
            with self.assertRaisesRegex(
                DetectionResultIntegrityError,
                "Only part",
            ):
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-2"
                    ),
                    results_repository=(
                        repository
                    ),
                )

    def test_deterministic_engine_coverage_is_strict(
        self,
    ) -> None:
        snapshot = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        base = _deterministic_report(
            snapshot
        )

        missing = copy.deepcopy(
            base
        )

        missing[
            "claims"
        ] = missing[
            "claims"
        ][:1]

        duplicate = copy.deepcopy(
            base
        )

        duplicate[
            "claims"
        ][1][
            "claimId"
        ] = "CLAIM-A"

        unknown = copy.deepcopy(
            base
        )

        unknown[
            "claims"
        ][1][
            "claimId"
        ] = "CLAIM-X"

        invalid = copy.deepcopy(
            base
        )

        invalid[
            "claims"
        ] = {}

        for report, message in [
            (
                missing,
                "coverage differs",
            ),
            (
                duplicate,
                (
                    "coverage is "
                    "incompatible"
                ),
            ),
            (
                unknown,
                (
                    "coverage is "
                    "incompatible"
                ),
            ),
            (
                invalid,
                "no claims array",
            ),
        ]:
            with self.subTest(
                message=message,
            ):
                repository = (
                    FakeResultsRepository()
                )

                engine = (
                    FakeDeterministicEngine(
                        report
                    )
                )

                with patch.object(
                    sources,
                    "_detection_imports",
                    side_effect=(
                        engine.imports
                    ),
                ):
                    with self.assertRaisesRegex(
                        DetectionResultContractError,
                        message,
                    ):
                        build_report_from_tenant_snapshot(
                            snapshot,
                            correlation_id=(
                                "correlation-1"
                            ),
                            results_repository=(
                                repository
                            ),
                        )

                self.assertEqual(
                    repository
                    .save_record_calls,
                    [],
                )

    def test_stored_deterministic_anchor_and_decisions_are_verified(
        self,
    ) -> None:
        snapshot = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        def populated(
        ) -> FakeResultsRepository:
            repository = (
                FakeResultsRepository()
            )

            engine = (
                FakeDeterministicEngine(
                    _deterministic_report(
                        snapshot
                    )
                )
            )

            with patch.object(
                sources,
                "_detection_imports",
                side_effect=(
                    engine.imports
                ),
            ):
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-1"
                    ),
                    results_repository=(
                        repository
                    ),
                )

            return repository

        no_anchor = populated()

        for row in (
            no_anchor
            .records
            .values()
        ):
            row[
                "result_payload"
            ].pop(
                "report",
                None,
            )

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            (
                "exactly one "
                "report anchor"
            ),
        ):
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-2"
                ),
                results_repository=(
                    no_anchor
                ),
            )

        duplicate_anchor = (
            populated()
        )

        anchor = next(
            row[
                "result_payload"
            ][
                "report"
            ]
            for row
            in duplicate_anchor
            .records
            .values()
            if (
                "report"
                in row[
                    "result_payload"
                ]
            )
        )

        for row in (
            duplicate_anchor
            .records
            .values()
        ):
            row[
                "result_payload"
            ][
                "report"
            ] = copy.deepcopy(
                anchor
            )

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            (
                "exactly one "
                "report anchor"
            ),
        ):
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-2"
                ),
                results_repository=(
                    duplicate_anchor
                ),
            )

        mismatch = populated()

        first = next(
            iter(
                mismatch
                .records
                .values()
            )
        )

        first[
            "result_payload"
        ][
            "decision"
        ][
            "processingStatus"
        ] = "TAMPERED"

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            (
                "differs from its "
                "claim decisions"
            ),
        ):
            build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=(
                    "correlation-2"
                ),
                results_repository=(
                    mismatch
                ),
            )

    def test_deterministic_request_id_is_stable_and_version_bound(
        self,
    ) -> None:
        base = _snapshot(
            strategy=(
                "deterministic_rules"
            ),
            deployment_id=None,
        )

        def request_id_for(
            snapshot: (
                ProspectiveScoringSnapshot
            ),
        ) -> str:
            repository = (
                FakeResultsRepository()
            )

            engine = (
                FakeDeterministicEngine(
                    _deterministic_report(
                        snapshot
                    )
                )
            )

            with patch.object(
                sources,
                "_detection_imports",
                side_effect=(
                    engine.imports
                ),
            ):
                build_report_from_tenant_snapshot(
                    snapshot,
                    correlation_id=(
                        "correlation-1"
                    ),
                    results_repository=(
                        repository
                    ),
                )

            request_ids = {
                row[
                    "request_id"
                ]
                for row
                in repository
                .records
                .values()
            }

            self.assertEqual(
                len(
                    request_ids
                ),
                1,
            )

            return request_ids.pop()

        first = request_id_for(
            base
        )

        repeated = request_id_for(
            copy.deepcopy(
                base
            )
        )

        changed_claims = (
            copy.deepcopy(
                base.target_claims
            )
        )

        changed_claims[1][
            "claim_version"
        ] = 3

        changed = request_id_for(
            replace(
                base,
                target_claims=(
                    changed_claims
                ),
            )
        )

        self.assertEqual(
            first,
            repeated,
        )

        self.assertNotEqual(
            first,
            changed,
        )

        self.assertRegex(
            first,
            r"^[0-9a-f]{64}$",
        )
