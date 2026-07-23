from __future__ import annotations

import copy
import json
import re
from dataclasses import replace
from unittest import TestCase

from claimguard_report_producer.model_service import (
    ANALYSIS_MODE,
    DEFAULT_ENDPOINT_PATH,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    REQUEST_SCHEMA_VERSION,
    RESPONSE_SCHEMA_VERSION,
    ModelHttpResponse,
    ModelServiceClient,
    ModelServiceContractError,
    ModelServiceExpectations,
    ModelServiceUnavailable,
)
from claimguard_report_producer.snapshot import (
    ProspectiveScoringSnapshot,
)


DEPLOYMENT_ID = (
    "claim-fraud-ensemble-1.1.0"
)

WATERMARK = (
    "prospective:test-watermark"
)

CAPTURED_AT = (
    "2026-07-23T08:00:00+00:00"
)

CONTEXT_CUTOFF = (
    "2026-07-23T07:59:59+00:00"
)


def target_claim(
    *,
    claim_id: str,
    claim_version: int,
    member_id: str,
    provider_id: str,
    amount: float,
    billing_code: str,
) -> dict[str, object]:
    return {
        "claim_id":
            claim_id,

        "claim_version":
            claim_version,

        "scheme_id":
            "scheme-raw-1",

        "member_id":
            member_id,

        "provider_id":
            provider_id,

        "service_date":
            "2026-07-20",

        "received_date":
            "2026-07-21",

        "billing_code":
            billing_code,

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


def snapshot(
    *,
    deployment_id: str = DEPLOYMENT_ID,
    target_claims: (
        list[dict[str, object]]
        | None
    ) = None,
    context_features: (
        list[dict[str, object]]
        | None
    ) = None,
    watermark: str = WATERMARK,
) -> ProspectiveScoringSnapshot:
    claims = (
        target_claims
        or [
            target_claim(
                claim_id="claim-raw-b",
                claim_version=1,
                member_id="member-raw-b",
                provider_id="provider-raw-b",
                amount=450.0,
                billing_code="0191",
            ),
            target_claim(
                claim_id="claim-raw-a",
                claim_version=2,
                member_id="member-raw-a",
                provider_id="provider-raw-a",
                amount=650.0,
                billing_code="0190",
            ),
        ]
    )

    features = (
        context_features
        if context_features is not None
        else [
            {
                "claim_id":
                    claim["claim_id"],

                "claim_version":
                    claim["claim_version"],

                "features": {
                    "historyWindowDays":
                        365,

                    "member": {
                        "claimCount30d":
                            index + 1,

                        "claimAmount30d":
                            float(
                                100
                                * (
                                    index
                                    + 1
                                )
                            ),
                    },

                    "provider": {
                        "claimCount30d":
                            index + 2,
                    },
                },
            }
            for index, claim
            in enumerate(
                claims
            )
        ]
    )

    provider_ids = {
        str(
            claim["provider_id"]
        )
        for claim in claims
    }

    providers = [
        {
            "provider_id":
                provider_id,

            "scheme_id":
                "scheme-raw-1",

            "specialty":
                "GP",

            "provider_kind":
                "INDIVIDUAL",

            "provider_category":
                "GENERAL_PRACTITIONER",
        }
        for provider_id
        in sorted(
            provider_ids
        )
    ]

    return ProspectiveScoringSnapshot(
        tenant_id="tenant-raw-alpha",
        tenant_slug="alpha",
        tenant_display_name="Alpha",
        detection_strategy_id=29,
        detection_strategy="approved_model",
        model_deployment_id=deployment_id,
        captured_at=CAPTURED_AT,
        context_cutoff_at=CONTEXT_CUTOFF,
        watermark=watermark,
        source_job_ids=(
            "job-model-1",
        ),
        schemes=[
            {
                "scheme_id":
                    "scheme-raw-1",

                "scheme_name":
                    "Alpha",
            }
        ],
        members=[],
        providers=providers,
        target_claims=claims,
        context_features=features,
    )


class FakeTokenProvider:
    def __init__(
        self,
        *,
        token: str = (
            "workload-access-token"
        ),
        error: Exception | None = None,
    ) -> None:
        self.token = token
        self.error = error
        self.audiences = []

    def get_token(
        self,
        audience: str,
    ) -> str:
        self.audiences.append(
            audience
        )

        if self.error is not None:
            raise self.error

        return self.token


class EchoModelTransport:
    def __init__(
        self,
        *,
        status: int = 200,
        error: Exception | None = None,
        response_mutator=None,
        body_override: bytes | None = None,
    ) -> None:
        self.status = status
        self.error = error
        self.response_mutator = (
            response_mutator
        )
        self.body_override = (
            body_override
        )

        self.calls = []

    @staticmethod
    def response_for(
        request: dict[str, object],
    ) -> dict[str, object]:
        scores = []

        for claim in request[
            "targetClaims"
        ]:
            scores.append(
                {
                    "claimId":
                        claim["claimId"],

                    "claimVersion":
                        claim[
                            "claimVersion"
                        ],

                    "baselineFraudProbability":
                        0.9,

                    "baselinePredictedClass":
                        "FRAUD",

                    "baselineThreshold":
                        0.08760971001434723,

                    "ringProbability":
                        0.01,

                    "ringReviewHit":
                        False,

                    "ringThreshold":
                        0.148,

                    "phantomProbability":
                        0.1,

                    "phantomReviewHit":
                        False,

                    "phantomThreshold":
                        0.8138303120761656,

                    "compositeReviewRecommended":
                        True,
                }
            )

        return {
            "schemaVersion":
                RESPONSE_SCHEMA_VERSION,

            "featureSchemaVersion":
                FEATURE_SCHEMA_VERSION,

            "deploymentId":
                DEPLOYMENT_ID,

            "ensembleId":
                ENSEMBLE_ID,

            "ensembleVersion":
                ENSEMBLE_VERSION,

            "analysisMode":
                ANALYSIS_MODE,

            "tenantId":
                request["tenantId"],

            "requestId":
                request["requestId"],

            "windowWatermark":
                request[
                    "window"
                ][
                    "watermark"
                ],

            "scores":
                scores,
        }

    def post(
        self,
        *,
        url,
        body,
        headers,
        timeout_seconds,
    ):
        if self.error is not None:
            raise self.error

        request = json.loads(
            body.decode(
                "utf-8"
            )
        )

        self.calls.append(
            {
                "url":
                    url,

                "request":
                    request,

                "headers":
                    dict(
                        headers
                    ),

                "timeout_seconds":
                    timeout_seconds,
            }
        )

        if self.body_override is not None:
            body_result = (
                self.body_override
            )

        else:
            response = (
                self.response_for(
                    request
                )
            )

            if (
                self.response_mutator
                is not None
            ):
                self.response_mutator(
                    response,
                    request,
                )

            body_result = json.dumps(
                response,
                sort_keys=True,
                separators=(
                    ",",
                    ":",
                ),
                allow_nan=False,
            ).encode(
                "utf-8"
            )

        return ModelHttpResponse(
            status=self.status,
            body=body_result,
        )


def client(
    transport,
    *,
    token_provider=None,
    deployment_id: str = DEPLOYMENT_ID,
    endpoint_path: str = (
        DEFAULT_ENDPOINT_PATH
    ),
) -> ModelServiceClient:
    return ModelServiceClient(
        base_url=(
            "https://models.example"
        ),
        audience=(
            "api://claim-review"
        ),
        pseudonymization_key=(
            "a" * 32
        ),
        expectations=(
            ModelServiceExpectations(
                deployment_id=(
                    deployment_id
                )
            )
        ),
        token_provider=(
            token_provider
            or FakeTokenProvider()
        ),
        transport=transport,
        timeout_seconds=30,
        endpoint_path=(
            endpoint_path
        ),
    )


class ModelServiceTests(
    TestCase,
):
    def test_v3_request_is_target_only_pseudonymized_and_version_bound(
        self,
    ) -> None:
        transport = (
            EchoModelTransport()
        )

        token_provider = (
            FakeTokenProvider()
        )

        review = client(
            transport,
            token_provider=(
                token_provider
            ),
        ).review(
            snapshot()
        )

        self.assertEqual(
            len(
                transport.calls
            ),
            1,
        )

        call = transport.calls[0]

        self.assertEqual(
            call["url"],
            (
                "https://models.example"
                "/v3/claim-screening"
            ),
        )

        self.assertEqual(
            call[
                "timeout_seconds"
            ],
            30,
        )

        self.assertEqual(
            token_provider
            .audiences,
            [
                "api://claim-review",
            ],
        )

        self.assertEqual(
            call["headers"][
                "Authorization"
            ],
            (
                "Bearer "
                "workload-access-token"
            ),
        )

        self.assertEqual(
            call["headers"][
                "Content-Type"
            ],
            "application/json",
        )

        self.assertEqual(
            call["headers"][
                "Accept"
            ],
            "application/json",
        )

        self.assertNotIn(
            "x-ms-client-principal-id",
            call["headers"],
        )

        request = call[
            "request"
        ]

        self.assertEqual(
            set(
                request
            ),
            {
                "schemaVersion",
                "featureSchemaVersion",
                "deploymentId",
                "tenantId",
                "analysisMode",
                "window",
                "targetClaims",
                "contextFeatures",
                "requestId",
            },
        )

        self.assertEqual(
            request[
                "schemaVersion"
            ],
            REQUEST_SCHEMA_VERSION,
        )

        self.assertEqual(
            request[
                "featureSchemaVersion"
            ],
            FEATURE_SCHEMA_VERSION,
        )

        self.assertEqual(
            request[
                "deploymentId"
            ],
            DEPLOYMENT_ID,
        )

        self.assertEqual(
            request[
                "analysisMode"
            ],
            ANALYSIS_MODE,
        )

        self.assertEqual(
            request["window"],
            {
                "capturedAt":
                    CAPTURED_AT,

                "contextCutoffAt":
                    CONTEXT_CUTOFF,

                "watermark":
                    WATERMARK,
            },
        )

        self.assertRegex(
            request[
                "requestId"
            ],
            (
                r"^screen-"
                r"[0-9a-f]{64}$"
            ),
        )

        self.assertEqual(
            call["headers"][
                "x-request-id"
            ],
            request[
                "requestId"
            ],
        )

        self.assertEqual(
            [
                claim[
                    "claimVersion"
                ]
                for claim
                in request[
                    "targetClaims"
                ]
            ],
            [
                2,
                1,
            ],
        )

        self.assertTrue(
            all(
                str(
                    claim[
                        "claimId"
                    ]
                ).startswith(
                    "claim-version-"
                )
                for claim
                in request[
                    "targetClaims"
                ]
            )
        )

        serialized = json.dumps(
            request,
            sort_keys=True,
        )

        for raw_identifier in (
            "tenant-raw-alpha",
            "member-raw-a",
            "member-raw-b",
            "provider-raw-a",
            "provider-raw-b",
            "claim-raw-a",
            "claim-raw-b",
        ):
            self.assertNotIn(
                raw_identifier,
                serialized,
            )

        self.assertNotIn(
            "historicalClaims",
            serialized,
        )

        self.assertNotIn(
            '"claims"',
            serialized,
        )

        target_identity = [
            (
                claim["claimId"],
                claim[
                    "claimVersion"
                ],
            )
            for claim
            in request[
                "targetClaims"
            ]
        ]

        context_identity = [
            (
                entry["claimId"],
                entry[
                    "claimVersion"
                ],
            )
            for entry
            in request[
                "contextFeatures"
            ][
                "targets"
            ]
        ]

        self.assertEqual(
            context_identity,
            target_identity,
        )

        self.assertEqual(
            [
                (
                    score.claim_id,
                    score.claim_version,
                )
                for score
                in review.scores
            ],
            [
                (
                    "claim-raw-a",
                    2,
                ),
                (
                    "claim-raw-b",
                    1,
                ),
            ],
        )

    def test_request_identity_is_stable_and_changes_with_version_or_features(
        self,
    ) -> None:
        first_transport = (
            EchoModelTransport()
        )

        second_transport = (
            EchoModelTransport()
        )

        first_review = client(
            first_transport
        ).review(
            snapshot()
        )

        second_review = client(
            second_transport
        ).review(
            snapshot()
        )

        self.assertEqual(
            first_review.request_id,
            second_review.request_id,
        )

        self.assertEqual(
            first_transport.calls[0][
                "request"
            ][
                "requestId"
            ],
            second_transport.calls[0][
                "request"
            ][
                "requestId"
            ],
        )

        changed_features = (
            snapshot()
        )

        changed_features = replace(
            changed_features,
            context_features=[
                {
                    **entry,
                    "features": {
                        **entry[
                            "features"
                        ],
                        "newAggregate":
                            99,
                    },
                }
                for entry
                in changed_features
                .context_features
            ],
        )

        feature_transport = (
            EchoModelTransport()
        )

        client(
            feature_transport
        ).review(
            changed_features
        )

        self.assertNotEqual(
            first_review.request_id,
            feature_transport.calls[0][
                "request"
            ][
                "requestId"
            ],
        )

        version_one = snapshot(
            target_claims=[
                target_claim(
                    claim_id=(
                        "claim-same"
                    ),
                    claim_version=1,
                    member_id=(
                        "member-same"
                    ),
                    provider_id=(
                        "provider-same"
                    ),
                    amount=100,
                    billing_code="0190",
                )
            ]
        )

        version_two = snapshot(
            target_claims=[
                target_claim(
                    claim_id=(
                        "claim-same"
                    ),
                    claim_version=2,
                    member_id=(
                        "member-same"
                    ),
                    provider_id=(
                        "provider-same"
                    ),
                    amount=100,
                    billing_code="0190",
                )
            ]
        )

        version_one_transport = (
            EchoModelTransport()
        )

        version_two_transport = (
            EchoModelTransport()
        )

        client(
            version_one_transport
        ).review(
            version_one
        )

        client(
            version_two_transport
        ).review(
            version_two
        )

        first_target = (
            version_one_transport
            .calls[0][
                "request"
            ][
                "targetClaims"
            ][0]
        )

        second_target = (
            version_two_transport
            .calls[0][
                "request"
            ][
                "targetClaims"
            ][0]
        )

        self.assertNotEqual(
            first_target[
                "claimId"
            ],
            second_target[
                "claimId"
            ],
        )

        self.assertNotEqual(
            version_one_transport
            .calls[0][
                "request"
            ][
                "requestId"
            ],
            version_two_transport
            .calls[0][
                "request"
            ][
                "requestId"
            ],
        )

    def test_response_contract_failures_are_terminal_contract_errors(
        self,
    ) -> None:
        def changed_threshold(
            response,
            _request,
        ):
            response[
                "scores"
            ][0][
                "baselineThreshold"
            ] = 0.2

        def changed_claim_version(
            response,
            _request,
        ):
            response[
                "scores"
            ][0][
                "claimVersion"
            ] += 1

        def reversed_scores(
            response,
            _request,
        ):
            response[
                "scores"
            ].reverse()

        def missing_score(
            response,
            _request,
        ):
            response[
                "scores"
            ].pop()

        def extra_root_key(
            response,
            _request,
        ):
            response[
                "unexpected"
            ] = True

        cases = [
            (
                "threshold",
                changed_threshold,
            ),
            (
                "claim version",
                changed_claim_version,
            ),
            (
                "ordering",
                reversed_scores,
            ),
            (
                "coverage",
                missing_score,
            ),
            (
                "extra root field",
                extra_root_key,
            ),
        ]

        for name, mutator in cases:
            with self.subTest(
                case=name,
            ):
                with self.assertRaises(
                    ModelServiceContractError
                ) as captured:
                    client(
                        EchoModelTransport(
                            response_mutator=(
                                mutator
                            )
                        )
                    ).review(
                        snapshot()
                    )

                self.assertEqual(
                    captured
                    .exception
                    .code,
                    (
                        "MODEL_SERVICE_"
                        "CONTRACT_ERROR"
                    ),
                )

                self.assertEqual(
                    captured
                    .exception
                    .watermark,
                    WATERMARK,
                )

    def test_decisions_must_match_probabilities_and_thresholds(
        self,
    ) -> None:
        def inconsistent_decision(
            response,
            _request,
        ):
            response[
                "scores"
            ][0][
                "baselinePredictedClass"
            ] = "LEGITIMATE"

        with self.assertRaises(
            ModelServiceContractError
        ) as captured:
            client(
                EchoModelTransport(
                    response_mutator=(
                        inconsistent_decision
                    )
                )
            ).review(
                snapshot()
            )

        self.assertEqual(
            captured
            .exception
            .code,
            (
                "MODEL_SERVICE_"
                "CONTRACT_ERROR"
            ),
        )

        self.assertIn(
            "decisions",
            str(
                captured.exception
            ),
        )

    def test_pinned_deployment_mismatch_fails_before_authentication_or_transport(
        self,
    ) -> None:
        token_provider = (
            FakeTokenProvider()
        )

        transport = (
            EchoModelTransport()
        )

        with self.assertRaises(
            ModelServiceContractError
        ) as captured:
            client(
                transport,
                token_provider=(
                    token_provider
                ),
            ).review(
                snapshot(
                    deployment_id=(
                        "unapproved-deployment"
                    )
                )
            )

        self.assertEqual(
            captured
            .exception
            .watermark,
            WATERMARK,
        )

        self.assertEqual(
            token_provider
            .audiences,
            [],
        )

        self.assertEqual(
            transport.calls,
            [],
        )

    def test_raw_historical_claims_are_rejected_from_context_features(
        self,
    ) -> None:
        tenant_snapshot = (
            snapshot()
        )

        invalid_context = [
            {
                "claim_id":
                    entry["claim_id"],

                "claim_version":
                    entry[
                        "claim_version"
                    ],

                "features": {
                    "historicalClaims":
                        [
                            {
                                "claim_id":
                                    "raw-history",
                            }
                        ]
                },
            }
            for entry
            in tenant_snapshot
            .context_features
        ]

        transport = (
            EchoModelTransport()
        )

        with self.assertRaises(
            ModelServiceContractError
        ) as captured:
            client(
                transport
            ).review(
                replace(
                    tenant_snapshot,
                    context_features=(
                        invalid_context
                    ),
                )
            )

        self.assertIn(
            "Raw historical claims",
            str(
                captured.exception
            ),
        )

        self.assertEqual(
            transport.calls,
            [],
        )

    def test_http_and_transport_failures_are_retryable_unavailability_errors(
        self,
    ) -> None:
        cases = [
            (
                "HTTP failure",
                EchoModelTransport(
                    status=503,
                ),
            ),
            (
                "transport failure",
                EchoModelTransport(
                    error=TimeoutError(
                        "model timeout"
                    ),
                ),
            ),
        ]

        for name, transport in cases:
            with self.subTest(
                case=name,
            ):
                with self.assertRaises(
                    ModelServiceUnavailable
                ) as captured:
                    client(
                        transport
                    ).review(
                        snapshot()
                    )

                self.assertNotIsInstance(
                    captured.exception,
                    ModelServiceContractError,
                )

                self.assertEqual(
                    captured
                    .exception
                    .code,
                    (
                        "MODEL_SERVICE_"
                        "UNAVAILABLE"
                    ),
                )

                self.assertEqual(
                    captured
                    .exception
                    .watermark,
                    WATERMARK,
                )

    def test_missing_access_token_is_retryable_unavailability(
        self,
    ) -> None:
        token_provider = (
            FakeTokenProvider(
                token="",
            )
        )

        transport = (
            EchoModelTransport()
        )

        with self.assertRaises(
            ModelServiceUnavailable
        ) as captured:
            client(
                transport,
                token_provider=(
                    token_provider
                ),
            ).review(
                snapshot()
            )

        self.assertEqual(
            captured
            .exception
            .code,
            (
                "MODEL_SERVICE_"
                "UNAVAILABLE"
            ),
        )

        self.assertEqual(
            captured
            .exception
            .watermark,
            WATERMARK,
        )

        self.assertEqual(
            transport.calls,
            [],
        )

    def test_invalid_or_nonfinite_json_is_contract_failure(
        self,
    ) -> None:
        invalid_bodies = [
            b"\xff",
            b'{"value":NaN}',
            b'{"not":"the response contract"}',
        ]

        for body in invalid_bodies:
            with self.subTest(
                body=repr(
                    body
                ),
            ):
                with self.assertRaises(
                    ModelServiceContractError
                ) as captured:
                    client(
                        EchoModelTransport(
                            body_override=body,
                        )
                    ).review(
                        snapshot()
                    )

                self.assertEqual(
                    captured
                    .exception
                    .watermark,
                    WATERMARK,
                )

    def test_client_configuration_rejects_unsafe_endpoint_settings(
        self,
    ) -> None:
        common = {
            "audience":
                "api://claim-review",

            "expectations":
                ModelServiceExpectations(
                    deployment_id=(
                        DEPLOYMENT_ID
                    )
                ),

            "token_provider":
                FakeTokenProvider(),

            "transport":
                EchoModelTransport(),
        }

        with self.assertRaisesRegex(
            ValueError,
            "HTTPS origin",
        ):
            ModelServiceClient(
                base_url=(
                    "http://models.example"
                ),
                pseudonymization_key=(
                    "a" * 32
                ),
                **common,
            )

        with self.assertRaisesRegex(
            ValueError,
            "at least 32 bytes",
        ):
            ModelServiceClient(
                base_url=(
                    "https://models.example"
                ),
                pseudonymization_key=(
                    "too-short"
                ),
                **common,
            )

        with self.assertRaisesRegex(
            ValueError,
            "ENDPOINT_PATH",
        ):
            ModelServiceClient(
                base_url=(
                    "https://models.example"
                ),
                pseudonymization_key=(
                    "a" * 32
                ),
                endpoint_path=(
                    "/v3/../unsafe"
                ),
                **common,
            )

        with self.assertRaisesRegex(
            ValueError,
            "between 1 and 240",
        ):
            ModelServiceClient(
                base_url=(
                    "https://models.example"
                ),
                pseudonymization_key=(
                    "a" * 32
                ),
                timeout_seconds=0,
                **common,
            )
