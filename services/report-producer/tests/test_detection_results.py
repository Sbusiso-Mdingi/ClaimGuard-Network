from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from unittest import TestCase

from claimguard_report_producer.detection_results import (
    RESULT_PAYLOAD_SCHEMA_VERSION,
    DetectionResultConflictError,
    DetectionResultContractError,
    DetectionResultIntegrityError,
    PyMySqlDetectionResultsRepository,
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

SOURCE_JOB_ID = "job-model-1"

REQUEST_ID = "screen-" + ("a" * 64)

WATERMARK = (
    "prospective:"
    "2026-07-23T12:00:00+00:00:"
    "targets:2:"
    f"sha256:{'b' * 64}"
)

SCORED_AT = datetime(
    2026,
    7,
    23,
    12,
    1,
    0,
    tzinfo=UTC,
)


class DuplicateEntryError(
    RuntimeError,
):
    code = 1062

    def __init__(
        self,
    ) -> None:
        super().__init__(
            1062,
            "Duplicate entry",
        )


def deterministic_payload(
    *,
    claim_id: str,
    claim_version: int,
    recommendation: bool = False,
) -> dict[str, object]:
    return {
        "schemaVersion":
            RESULT_PAYLOAD_SCHEMA_VERSION,

        "tenantId":
            TENANT_ID,

        "claimId":
            claim_id,

        "claimVersion":
            claim_version,

        "sourceJobId":
            "job-deterministic-1",

        "requestId":
            "deterministic-request-1",

        "watermark":
            WATERMARK,

        "analysisMode":
            "PROSPECTIVE_DETERMINISTIC_RULES",

        "strategy": {
            "detectionStrategyId":
                17,

            "strategyType":
                "deterministic_rules",

            "modelDeploymentId":
                None,
        },

        "score": {
            "reviewRecommended":
                recommendation,

            "riskScore":
                (
                    0.8
                    if recommendation
                    else 0.1
                ),

            "ruleHits":
                (
                    [
                        "HIGH_AMOUNT",
                    ]
                    if recommendation
                    else []
                ),
        },
    }


def deterministic_record(
    *,
    claim_id: str = "CLAIM-1",
    claim_version: int = 1,
    tenant_id: str = TENANT_ID,
    source_job_id: str = (
        "job-deterministic-1"
    ),
    request_id: str = (
        "deterministic-request-1"
    ),
    payload: (
        dict[str, object]
        | None
    ) = None,
) -> dict[str, object]:
    return {
        "tenant_id":
            tenant_id,

        "claim_id":
            claim_id,

        "claim_version":
            claim_version,

        "detection_strategy_id":
            17,

        "strategy_type":
            "deterministic_rules",

        "model_deployment_id":
            None,

        "source_job_id":
            source_job_id,

        "request_id":
            request_id,

        "analysis_mode":
            "PROSPECTIVE_DETERMINISTIC_RULES",

        "ensemble_id":
            None,

        "ensemble_version":
            None,

        "feature_schema_version":
            None,

        "result_payload":
            (
                payload
                if payload is not None
                else deterministic_payload(
                    claim_id=claim_id,
                    claim_version=(
                        claim_version
                    ),
                )
            ),
    }


def target_claim(
    *,
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


def model_snapshot(
) -> ProspectiveScoringSnapshot:
    return ProspectiveScoringSnapshot(
        tenant_id=TENANT_ID,
        tenant_slug="alpha",
        tenant_display_name="Alpha",
        detection_strategy_id=29,
        detection_strategy="approved_model",
        model_deployment_id=(
            DEPLOYMENT_ID
        ),
        captured_at=(
            "2026-07-23T12:00:00+00:00"
        ),
        context_cutoff_at=(
            "2026-07-23T12:00:00+00:00"
        ),
        watermark=WATERMARK,
        source_job_ids=(
            SOURCE_JOB_ID,
        ),
        schemes=[],
        members=[],
        providers=[],
        target_claims=[
            target_claim(
                claim_id="CLAIM-B",
                claim_version=1,
                member_id="MEMBER-B",
                provider_id="PROVIDER-B",
                amount=200,
            ),
            target_claim(
                claim_id="CLAIM-A",
                claim_version=2,
                member_id="MEMBER-A",
                provider_id="PROVIDER-A",
                amount=100,
            ),
        ],
        context_features=[],
    )


def model_score(
    *,
    claim_id: str,
    claim_version: int,
    recommended: bool,
) -> ClaimReviewResult:
    baseline_probability = (
        0.9
        if recommended
        else 0.01
    )

    return ClaimReviewResult(
        claim_id=claim_id,
        claim_version=claim_version,
        baseline_fraud_probability=(
            baseline_probability
        ),
        baseline_predicted_class=(
            "FRAUD"
            if recommended
            else "LEGITIMATE"
        ),
        baseline_threshold=(
            0.08760971001434723
        ),
        ring_probability=0.01,
        ring_review_hit=False,
        ring_threshold=0.148,
        phantom_probability=0.1,
        phantom_review_hit=False,
        phantom_threshold=(
            0.8138303120761656
        ),
        composite_review_recommended=(
            recommended
        ),
    )


def model_review(
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
        request_id=REQUEST_ID,
        watermark=WATERMARK,
        scores=(
            model_score(
                claim_id="CLAIM-A",
                claim_version=2,
                recommended=False,
            ),
            model_score(
                claim_id="CLAIM-B",
                claim_version=1,
                recommended=True,
            ),
        ),
    )


class FakeDatabase:
    def __init__(
        self,
    ) -> None:
        self.rows: dict[
            tuple[str, str, int],
            dict[str, object],
        ] = {}

        self.connections = []
        self.sql_history = []

        self.race_mode: (
            str | None
        ) = None

        self.race_select_consumed = (
            False
        )

        self.race_target: (
            tuple[str, str, int]
            | None
        ) = None

        self.duplicate_fetch = False

    def connect(
        self,
    ):
        connection = (
            FakeConnection(
                self
            )
        )

        self.connections.append(
            connection
        )

        return connection


class FakeCursor:
    def __init__(
        self,
        connection,
    ) -> None:
        self.connection = connection
        self.result = []

    def __enter__(
        self,
    ):
        return self

    def __exit__(
        self,
        *_args,
    ):
        return False

    @staticmethod
    def _normalise_sql(
        sql,
    ) -> str:
        return " ".join(
            str(sql).split()
        )

    @staticmethod
    def _row_from_insert_params(
        params,
    ) -> dict[str, object]:
        return {
            "tenant_id":
                params[0],

            "claim_id":
                params[1],

            "claim_version":
                params[2],

            "detection_strategy_id":
                params[3],

            "strategy_type":
                params[4],

            "model_deployment_id":
                params[5],

            "source_job_id":
                params[6],

            "request_id":
                params[7],

            "analysis_mode":
                params[8],

            "ensemble_id":
                params[9],

            "ensemble_version":
                params[10],

            "feature_schema_version":
                params[11],

            "scored_at":
                SCORED_AT,

            "result_payload":
                json.loads(
                    params[12]
                ),

            "result_hash":
                params[13],
        }

    def execute(
        self,
        sql,
        params=None,
    ):
        normalized = (
            self._normalise_sql(
                sql
            )
        )

        canonical_params = (
            list(params)
            if params is not None
            else []
        )

        database = (
            self.connection.database
        )

        database.sql_history.append(
            {
                "sql":
                    normalized,

                "params":
                    canonical_params,
            }
        )

        if normalized.startswith(
            "INSERT INTO "
            "claim_detection_results"
        ):
            row = (
                self._row_from_insert_params(
                    canonical_params
                )
            )

            key = (
                str(
                    row["tenant_id"]
                ),
                str(
                    row["claim_id"]
                ),
                int(
                    row["claim_version"]
                ),
            )

            if (
                database.race_target
                == key
            ):
                mode = (
                    database.race_mode
                )

                database.race_target = (
                    None
                )

                if mode == "exact":
                    database.rows[key] = (
                        copy.deepcopy(
                            row
                        )
                    )

                elif mode == "conflict":
                    competing = (
                        copy.deepcopy(
                            row
                        )
                    )

                    competing[
                        "request_id"
                    ] = (
                        "competing-request"
                    )

                    database.rows[key] = (
                        competing
                    )

                elif mode != "missing":
                    raise AssertionError(
                        "Unknown race mode."
                    )

                raise DuplicateEntryError()

            if key in database.rows:
                raise DuplicateEntryError()

            database.rows[key] = (
                copy.deepcopy(
                    row
                )
            )

            self.result = []

            return 1

        if (
            normalized.startswith(
                "SELECT 1 "
            )
            and (
                "FROM "
                "claim_detection_results"
                in normalized
            )
        ):
            key = (
                str(
                    canonical_params[0]
                ),
                str(
                    canonical_params[1]
                ),
                int(
                    canonical_params[2]
                ),
            )

            self.result = (
                [
                    {
                        "1": 1,
                    }
                ]
                if key
                in database.rows
                else []
            )

            return len(
                self.result
            )

        if (
            normalized.startswith(
                "SELECT"
            )
            and (
                "FROM "
                "claim_detection_results"
                in normalized
            )
            and "LIMIT 1"
            in normalized
        ):
            key = (
                str(
                    canonical_params[0]
                ),
                str(
                    canonical_params[1]
                ),
                int(
                    canonical_params[2]
                ),
            )

            if (
                database.race_mode
                is not None
                and not database
                .race_select_consumed
                and key
                not in database.rows
            ):
                database.race_select_consumed = (
                    True
                )

                database.race_target = (
                    key
                )

                self.result = []

            else:
                row = (
                    database.rows.get(
                        key
                    )
                )

                self.result = (
                    [
                        copy.deepcopy(
                            row
                        )
                    ]
                    if row is not None
                    else []
                )

            return len(
                self.result
            )

        if (
            normalized.startswith(
                "SELECT"
            )
            and (
                "FROM "
                "claim_detection_results"
                in normalized
            )
            and (
                "( claim_id, "
                "claim_version ) IN"
                in normalized
            )
        ):
            tenant_id = str(
                canonical_params[0]
            )

            references = [
                (
                    str(
                        canonical_params[
                            index
                        ]
                    ),
                    int(
                        canonical_params[
                            index + 1
                        ]
                    ),
                )
                for index
                in range(
                    1,
                    len(
                        canonical_params
                    ),
                    2,
                )
            ]

            rows = []

            for (
                claim_id,
                claim_version,
            ) in references:
                row = database.rows.get(
                    (
                        tenant_id,
                        claim_id,
                        claim_version,
                    )
                )

                if row is not None:
                    rows.append(
                        copy.deepcopy(
                            row
                        )
                    )

            rows.reverse()

            if (
                database.duplicate_fetch
                and rows
            ):
                rows.append(
                    copy.deepcopy(
                        rows[0]
                    )
                )

            self.result = rows

            return len(
                self.result
            )

        raise AssertionError(
            "Unexpected SQL: "
            f"{normalized}"
        )

    def fetchone(
        self,
    ):
        if not self.result:
            return None

        return self.result[0]

    def fetchall(
        self,
    ):
        return list(
            self.result
        )


class FakeConnection:
    def __init__(
        self,
        database: FakeDatabase,
    ) -> None:
        self.database = database
        self.events = []
        self.snapshot = None

    def cursor(
        self,
    ):
        return FakeCursor(
            self
        )

    def begin(
        self,
    ):
        self.events.append(
            "begin"
        )

        self.snapshot = (
            copy.deepcopy(
                self.database.rows
            )
        )

    def commit(
        self,
    ):
        self.events.append(
            "commit"
        )

        self.snapshot = None

    def rollback(
        self,
    ):
        self.events.append(
            "rollback"
        )

        if self.snapshot is not None:
            self.database.rows = (
                self.snapshot
            )

        self.snapshot = None

    def close(
        self,
    ):
        self.events.append(
            "close"
        )


def repository_for(
    database: FakeDatabase,
    *,
    allowed_tenants=(
        frozenset(
            {
                TENANT_ID,
            }
        )
    ),
) -> PyMySqlDetectionResultsRepository:
    return PyMySqlDetectionResultsRepository(
        database.connect,
        allowed_tenant_ids=(
            allowed_tenants
        ),
    )


class DetectionResultsTests(
    TestCase,
):
    def test_new_records_are_inserted_and_reloaded_without_updates(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        records = [
            deterministic_record(
                claim_id="CLAIM-1",
                claim_version=1,
            ),
            deterministic_record(
                claim_id="CLAIM-2",
                claim_version=3,
                payload=(
                    deterministic_payload(
                        claim_id="CLAIM-2",
                        claim_version=3,
                        recommendation=True,
                    )
                ),
            ),
        ]

        stored = (
            repository
            .save_result_records(
                records
            )
        )

        self.assertEqual(
            len(
                stored
            ),
            2,
        )

        self.assertEqual(
            [
                (
                    result.claim_id,
                    result.claim_version,
                )
                for result in stored
            ],
            [
                (
                    "CLAIM-1",
                    1,
                ),
                (
                    "CLAIM-2",
                    3,
                ),
            ],
        )

        self.assertTrue(
            all(
                len(
                    result.result_hash
                )
                == 64
                for result
                in stored
            )
        )

        self.assertTrue(
            all(
                set(
                    result.result_hash
                )
                <= set(
                    "0123456789abcdef"
                )
                for result
                in stored
            )
        )

        self.assertEqual(
            len(
                database.rows
            ),
            2,
        )

        self.assertEqual(
            database.connections[0]
            .events,
            [
                "begin",
                "commit",
                "close",
            ],
        )

        self.assertFalse(
            any(
                entry["sql"]
                .startswith(
                    "UPDATE "
                )
                for entry
                in database.sql_history
            )
        )

    def test_exact_retry_reuses_existing_immutable_result(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        original = (
            deterministic_record()
        )

        first = (
            repository
            .save_result_records(
                [
                    original,
                ]
            )[0]
        )

        reordered_payload = {
            key:
                copy.deepcopy(
                    original[
                        "result_payload"
                    ][key]
                )
            for key
            in reversed(
                list(
                    original[
                        "result_payload"
                    ]
                )
            )
        }

        retry_record = {
            **original,
            "result_payload":
                reordered_payload,
        }

        insert_count_before = sum(
            entry["sql"].startswith(
                "INSERT INTO "
            )
            for entry
            in database.sql_history
        )

        second = (
            repository
            .save_result_records(
                [
                    retry_record,
                ]
            )[0]
        )

        insert_count_after = sum(
            entry["sql"].startswith(
                "INSERT INTO "
            )
            for entry
            in database.sql_history
        )

        self.assertEqual(
            first.result_hash,
            second.result_hash,
        )

        self.assertEqual(
            first.as_dict(),
            second.as_dict(),
        )

        self.assertEqual(
            insert_count_before,
            insert_count_after,
        )

        self.assertEqual(
            len(
                database.rows
            ),
            1,
        )

    def test_conflicting_retry_fails_and_does_not_mutate_existing_row(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        original = (
            deterministic_record()
        )

        repository.save_result_records(
            [
                original,
            ]
        )

        before = copy.deepcopy(
            database.rows
        )

        conflict = {
            **original,
            "request_id":
                "different-request",
        }

        with self.assertRaises(
            DetectionResultConflictError
        ) as captured:
            repository.save_result_records(
                [
                    conflict,
                ]
            )

        self.assertEqual(
            captured.exception.code,
            (
                "DETECTION_RESULT_"
                "IMMUTABILITY_CONFLICT"
            ),
        )

        self.assertIn(
            "request_id",
            str(
                captured.exception
            ),
        )

        self.assertEqual(
            database.rows,
            before,
        )

        self.assertEqual(
            database.connections[-1]
            .events,
            [
                "begin",
                "rollback",
                "close",
            ],
        )

    def test_batch_write_is_atomic_when_later_record_conflicts(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        existing = (
            deterministic_record(
                claim_id="CLAIM-2",
                claim_version=1,
            )
        )

        repository.save_result_records(
            [
                existing,
            ]
        )

        conflicting_existing = {
            **existing,
            "source_job_id":
                "different-job",
        }

        with self.assertRaises(
            DetectionResultConflictError
        ):
            repository.save_result_records(
                [
                    deterministic_record(
                        claim_id="CLAIM-1",
                        claim_version=1,
                    ),
                    conflicting_existing,
                ]
            )

        self.assertNotIn(
            (
                TENANT_ID,
                "CLAIM-1",
                1,
            ),
            database.rows,
        )

        self.assertIn(
            (
                TENANT_ID,
                "CLAIM-2",
                1,
            ),
            database.rows,
        )

    def test_duplicate_insert_race_reuses_exact_competing_result(
        self,
    ) -> None:
        database = FakeDatabase()

        database.race_mode = (
            "exact"
        )

        repository = repository_for(
            database
        )

        stored = (
            repository
            .save_result_records(
                [
                    deterministic_record(),
                ]
            )
        )

        self.assertEqual(
            len(
                stored
            ),
            1,
        )

        self.assertEqual(
            stored[0].claim_id,
            "CLAIM-1",
        )

        self.assertEqual(
            database.connections[0]
            .events,
            [
                "begin",
                "commit",
                "close",
            ],
        )

    def test_duplicate_insert_race_with_conflicting_result_fails_closed(
        self,
    ) -> None:
        database = FakeDatabase()

        database.race_mode = (
            "conflict"
        )

        repository = repository_for(
            database
        )

        with self.assertRaises(
            DetectionResultConflictError
        ):
            repository.save_result_records(
                [
                    deterministic_record(),
                ]
            )

        self.assertEqual(
            database.connections[0]
            .events,
            [
                "begin",
                "rollback",
                "close",
            ],
        )

    def test_duplicate_insert_that_cannot_be_reloaded_is_integrity_failure(
        self,
    ) -> None:
        database = FakeDatabase()

        database.race_mode = (
            "missing"
        )

        repository = repository_for(
            database
        )

        with self.assertRaises(
            DetectionResultIntegrityError
        ) as captured:
            repository.save_result_records(
                [
                    deterministic_record(),
                ]
            )

        self.assertEqual(
            captured.exception.code,
            (
                "DETECTION_RESULT_"
                "INTEGRITY_ERROR"
            ),
        )

        self.assertIn(
            "could not be reloaded",
            str(
                captured.exception
            ),
        )

    def test_cross_tenant_and_duplicate_batches_are_rejected_before_connecting(
        self,
    ) -> None:
        cases = [
            [
                deterministic_record(
                    claim_id="CLAIM-1",
                    tenant_id=(
                        "tenant_alpha"
                    ),
                ),
                deterministic_record(
                    claim_id="CLAIM-2",
                    tenant_id=(
                        "tenant_beta"
                    ),
                ),
            ],
            [
                deterministic_record(
                    claim_id="CLAIM-1",
                    claim_version=1,
                ),
                deterministic_record(
                    claim_id="CLAIM-1",
                    claim_version=1,
                ),
            ],
        ]

        for records in cases:
            with self.subTest(
                records=records,
            ):
                database = (
                    FakeDatabase()
                )

                repository = (
                    PyMySqlDetectionResultsRepository(
                        database.connect
                    )
                )

                with self.assertRaises(
                    DetectionResultContractError
                ):
                    repository.save_result_records(
                        records
                    )

                self.assertEqual(
                    database.connections,
                    [],
                )

    def test_verified_tenant_scope_is_enforced_before_connecting(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        with self.assertRaisesRegex(
            DetectionResultContractError,
            (
                "outside the verified "
                "worker data-plane scope"
            ),
        ):
            repository.save_result_records(
                [
                    deterministic_record(
                        tenant_id=(
                            "tenant_beta"
                        )
                    ),
                ]
            )

        self.assertEqual(
            database.connections,
            [],
        )

        with self.assertRaises(
            DetectionResultContractError
        ):
            repository.results_exist(
                "tenant_beta",
                "CLAIM-1",
                1,
            )

        self.assertEqual(
            database.connections,
            [],
        )

    def test_strategy_metadata_and_payload_must_satisfy_contract(
        self,
    ) -> None:
        invalid_records = []

        deterministic_with_model = (
            deterministic_record()
        )

        deterministic_with_model[
            "model_deployment_id"
        ] = DEPLOYMENT_ID

        invalid_records.append(
            deterministic_with_model
        )

        approved_without_model = (
            deterministic_record()
        )

        approved_without_model[
            "strategy_type"
        ] = "approved_model"

        invalid_records.append(
            approved_without_model
        )

        unsupported_strategy = (
            deterministic_record()
        )

        unsupported_strategy[
            "strategy_type"
        ] = "experimental"

        invalid_records.append(
            unsupported_strategy
        )

        nonfinite_payload = (
            deterministic_record()
        )

        nonfinite_payload[
            "result_payload"
        ] = {
            "score":
                float("nan"),
        }

        invalid_records.append(
            nonfinite_payload
        )

        for record in invalid_records:
            with self.subTest(
                record=record,
            ):
                database = (
                    FakeDatabase()
                )

                repository = (
                    repository_for(
                        database
                    )
                )

                with self.assertRaises(
                    DetectionResultContractError
                ):
                    repository.save_result_records(
                        [
                            record,
                        ]
                    )

                self.assertEqual(
                    database.connections,
                    [],
                )

    def test_model_review_is_persisted_for_exact_snapshot_versions(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        stored = (
            repository.save_results(
                snapshot=(
                    model_snapshot()
                ),
                review=(
                    model_review()
                ),
            )
        )

        self.assertEqual(
            [
                (
                    result.claim_id,
                    result.claim_version,
                )
                for result in stored
            ],
            [
                (
                    "CLAIM-B",
                    1,
                ),
                (
                    "CLAIM-A",
                    2,
                ),
            ],
        )

        first = stored[0]

        self.assertEqual(
            first.tenant_id,
            TENANT_ID,
        )

        self.assertEqual(
            first.detection_strategy_id,
            29,
        )

        self.assertEqual(
            first.strategy_type,
            "approved_model",
        )

        self.assertEqual(
            first.model_deployment_id,
            DEPLOYMENT_ID,
        )

        self.assertEqual(
            first.source_job_id,
            SOURCE_JOB_ID,
        )

        self.assertEqual(
            first.request_id,
            REQUEST_ID,
        )

        self.assertEqual(
            first.analysis_mode,
            ANALYSIS_MODE,
        )

        self.assertEqual(
            first.ensemble_id,
            ENSEMBLE_ID,
        )

        self.assertEqual(
            first.ensemble_version,
            ENSEMBLE_VERSION,
        )

        self.assertEqual(
            first.feature_schema_version,
            FEATURE_SCHEMA_VERSION,
        )

        payload = (
            first.result_payload
        )

        self.assertEqual(
            payload[
                "schemaVersion"
            ],
            RESULT_PAYLOAD_SCHEMA_VERSION,
        )

        self.assertEqual(
            payload[
                "claimId"
            ],
            "CLAIM-B",
        )

        self.assertEqual(
            payload[
                "claimVersion"
            ],
            1,
        )

        self.assertEqual(
            payload[
                "sourceJobId"
            ],
            SOURCE_JOB_ID,
        )

        self.assertEqual(
            payload[
                "watermark"
            ],
            WATERMARK,
        )

        self.assertEqual(
            payload[
                "strategy"
            ],
            {
                "detectionStrategyId":
                    29,

                "strategyType":
                    "approved_model",

                "modelDeploymentId":
                    DEPLOYMENT_ID,
            },
        )

        self.assertEqual(
            payload[
                "score"
            ][
                "compositeReviewRecommended"
            ],
            True,
        )

    def test_model_save_rejects_identity_and_coverage_mismatches_before_write(
        self,
    ) -> None:
        base_snapshot = (
            model_snapshot()
        )

        base_review = (
            model_review()
        )

        cases = [
            (
                base_snapshot,
                replace(
                    base_review,
                    watermark=(
                        "different-watermark"
                    ),
                ),
            ),
            (
                base_snapshot,
                replace(
                    base_review,
                    deployment_id=(
                        "different-deployment"
                    ),
                ),
            ),
            (
                base_snapshot,
                replace(
                    base_review,
                    scores=(
                        base_review
                        .scores[0],
                    ),
                ),
            ),
            (
                replace(
                    base_snapshot,
                    source_job_ids=(
                        "job-1",
                        "job-2",
                    ),
                ),
                base_review,
            ),
            (
                replace(
                    base_snapshot,
                    detection_strategy=(
                        "deterministic_rules"
                    ),
                    model_deployment_id=(
                        None
                    ),
                ),
                base_review,
            ),
        ]

        for (
            tenant_snapshot,
            review,
        ) in cases:
            with self.subTest(
                snapshot=(
                    tenant_snapshot
                ),
            ):
                database = (
                    FakeDatabase()
                )

                repository = (
                    repository_for(
                        database
                    )
                )

                with self.assertRaises(
                    DetectionResultContractError
                ):
                    repository.save_results(
                        snapshot=(
                            tenant_snapshot
                        ),
                        review=review,
                    )

                self.assertEqual(
                    database.connections,
                    [],
                )

    def test_results_exist_is_version_specific_and_closes_connection(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        repository.save_result_records(
            [
                deterministic_record(
                    claim_id="CLAIM-1",
                    claim_version=2,
                ),
            ]
        )

        self.assertTrue(
            repository.results_exist(
                TENANT_ID,
                "CLAIM-1",
                2,
            )
        )

        self.assertFalse(
            repository.results_exist(
                TENANT_ID,
                "CLAIM-1",
                1,
            )
        )

        self.assertTrue(
            all(
                connection.events[-1]
                == "close"
                for connection
                in database.connections
            )
        )

    def test_report_reload_preserves_requested_target_order(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        repository.save_result_records(
            [
                deterministic_record(
                    claim_id="CLAIM-1",
                    claim_version=1,
                ),
                deterministic_record(
                    claim_id="CLAIM-2",
                    claim_version=4,
                ),
            ]
        )

        loaded = (
            repository
            .load_results_for_report(
                TENANT_ID,
                [
                    {
                        "claim_id":
                            "CLAIM-2",

                        "claim_version":
                            4,
                    },
                    (
                        "CLAIM-1",
                        1,
                    ),
                ],
            )
        )

        self.assertEqual(
            [
                (
                    result[
                        "claim_id"
                    ],
                    result[
                        "claim_version"
                    ],
                )
                for result in loaded
            ],
            [
                (
                    "CLAIM-2",
                    4,
                ),
                (
                    "CLAIM-1",
                    1,
                ),
            ],
        )

    def test_report_reload_fails_for_missing_duplicate_or_corrupt_rows(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        repository.save_result_records(
            [
                deterministic_record(
                    claim_id="CLAIM-1",
                    claim_version=1,
                ),
            ]
        )

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            "missing for: CLAIM-2@1",
        ):
            repository.load_results_for_report(
                TENANT_ID,
                [
                    (
                        "CLAIM-1",
                        1,
                    ),
                    (
                        "CLAIM-2",
                        1,
                    ),
                ],
            )

        database.duplicate_fetch = (
            True
        )

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            "duplicate claim-version rows",
        ):
            repository.load_results_for_report(
                TENANT_ID,
                [
                    (
                        "CLAIM-1",
                        1,
                    ),
                ],
            )

        database.duplicate_fetch = (
            False
        )

        key = (
            TENANT_ID,
            "CLAIM-1",
            1,
        )

        database.rows[key][
            "result_hash"
        ] = "0" * 64

        with self.assertRaisesRegex(
            DetectionResultIntegrityError,
            "does not match its result_hash",
        ):
            repository.load_results_for_report(
                TENANT_ID,
                [
                    (
                        "CLAIM-1",
                        1,
                    ),
                ],
            )

    def test_result_hash_uses_canonical_finite_json(
        self,
    ) -> None:
        database = FakeDatabase()

        repository = repository_for(
            database
        )

        payload = {
            "z":
                [
                    3,
                    2,
                    1,
                ],

            "a": {
                "timestamp":
                    datetime(
                        2026,
                        7,
                        23,
                        12,
                        0,
                        tzinfo=UTC,
                    ),
            },
        }

        stored = (
            repository
            .save_result_records(
                [
                    deterministic_record(
                        payload=payload,
                    ),
                ]
            )[0]
        )

        expected_payload = {
            "a": {
                "timestamp":
                    (
                        "2026-07-23"
                        "T12:00:00+00:00"
                    ),
            },

            "z": [
                3,
                2,
                1,
            ],
        }

        expected_json = json.dumps(
            expected_payload,
            sort_keys=True,
            separators=(
                ",",
                ":",
            ),
            ensure_ascii=False,
            allow_nan=False,
        )

        expected_hash = (
            hashlib.sha256(
                expected_json.encode(
                    "utf-8"
                )
            ).hexdigest()
        )

        self.assertEqual(
            stored.result_hash,
            expected_hash,
        )

        self.assertEqual(
            stored.result_payload,
            expected_payload,
        )
