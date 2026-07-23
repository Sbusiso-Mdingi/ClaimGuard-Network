from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest import TestCase

from claimguard_report_producer.outbox import (
    CLAIM_PROCESSING_AGGREGATE_TYPE,
    CLAIM_PROCESSING_DATASET_SCOPE,
    CLAIM_PROCESSING_JOB_TYPE,
    CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
    OutboxJob,
)
from claimguard_report_producer.snapshot import (
    PyMySqlTenantSnapshotRepository,
)


CUTOFF = datetime(
    2026,
    7,
    23,
    12,
    0,
    0,
    tzinfo=UTC,
)

CUTOFF_TEXT = CUTOFF.isoformat()

DETERMINISTIC_STRATEGY_ID = 17

APPROVED_MODEL_STRATEGY_ID = 29

APPROVED_DEPLOYMENT_ID = (
    "claimguard-claim-fraud-ensemble:1.1.0"
)


def claim_payload(
    *,
    claim_id: str,
    member_id: str,
    provider_id: str,
    billing_code: str,
    amount: float,
    service_date: str = "2026-07-22",
    received_date: str = "2026-07-23",
    claim_version: int | None = None,
    tenant_id: str | None = None,
) -> str:
    payload: dict[str, object] = {
        "claim_id":
            claim_id,

        "member_id":
            member_id,

        "provider_id":
            provider_id,

        "billing_code":
            billing_code,

        "amount":
            amount,

        "service_date":
            service_date,

        "received_date":
            received_date,
    }

    if claim_version is not None:
        payload["claim_version"] = (
            claim_version
        )

    if tenant_id is not None:
        payload["tenant_id"] = (
            tenant_id
        )

    return json.dumps(
        payload,
        sort_keys=True,
    )


def claim_version_row(
    *,
    claim_id: str,
    claim_version: int,
    member_id: str,
    provider_id: str,
    billing_code: str,
    amount: float,
    created_at: datetime,
    service_date: str = "2026-07-22",
    received_date: str = "2026-07-23",
    tenant_id_in_payload: str | None = None,
) -> dict[str, object]:
    return {
        "claim_id":
            claim_id,

        "claim_version":
            claim_version,

        "claim_payload":
            claim_payload(
                claim_id=claim_id,
                claim_version=claim_version,
                member_id=member_id,
                provider_id=provider_id,
                billing_code=billing_code,
                amount=amount,
                service_date=service_date,
                received_date=received_date,
                tenant_id=tenant_id_in_payload,
            ),

        "created_at":
            created_at,
    }


def outbox_job(
    job_id: str = "job-1",
    *,
    tenant_id: str = "tenant_alpha",
    targets: list[
        dict[str, object]
    ] | None = None,
    cutoff: str = CUTOFF_TEXT,
    detection_strategy_id: int = (
        DETERMINISTIC_STRATEGY_ID
    ),
    strategy_type: str = (
        "deterministic_rules"
    ),
    model_deployment_id: (
        str | None
    ) = None,
) -> OutboxJob:
    return OutboxJob(
        id=job_id,
        tenant_id=tenant_id,
        job_type=(
            CLAIM_PROCESSING_JOB_TYPE
        ),
        aggregate_type=(
            CLAIM_PROCESSING_AGGREGATE_TYPE
        ),
        aggregate_id=(
            f"aggregate-{job_id}"
        ),
        correlation_id=(
            f"correlation-{job_id}"
        ),
        payload={
            "schema_version":
                CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,

            "dataset_scope":
                CLAIM_PROCESSING_DATASET_SCOPE,

            "source":
                "api:test",

            "context_cutoff_at":
                cutoff,

            "targets":
                targets
                or [
                    {
                        "claim_id":
                            "CLAIM-1",

                        "claim_version":
                            1,
                    }
                ],
        },
        status="processing",
        attempt_count=1,
        max_attempts=3,
        detection_strategy_id=(
            detection_strategy_id
        ),
        strategy_type=(
            strategy_type
        ),
        model_deployment_id=(
            model_deployment_id
        ),
    )


class FakeCursor:
    def __init__(
        self,
        connection,
    ) -> None:
        self.connection = (
            connection
        )

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

    def execute(
        self,
        sql,
        params=None,
    ):
        normalized = " ".join(
            str(sql).split()
        )

        canonical_params = (
            list(params)
            if params is not None
            else None
        )

        self.connection.queries.append(
            (
                normalized,
                canonical_params,
            )
        )

        if (
            self.connection
            .fail_pattern
            and self.connection
            .fail_pattern
            in normalized
        ):
            raise RuntimeError(
                "Synthetic database failure."
            )

        if normalized.startswith(
            "SET TRANSACTION ISOLATION LEVEL"
        ):
            self.result = []

        elif "FROM tenants" in normalized:
            self.result = (
                [
                    dict(
                        self.connection
                        .tenant
                    )
                ]
                if self.connection
                .tenant
                is not None
                else []
            )

        elif "FROM schemes" in normalized:
            self.result = [
                dict(row)
                for row
                in self.connection.schemes
            ]

        elif "FROM members" in normalized:
            self.result = [
                dict(row)
                for row
                in self.connection.members
            ]

        elif "FROM providers" in normalized:
            self.result = [
                dict(row)
                for row
                in self.connection.providers
            ]

        elif (
            "FROM claim_versions cv"
            in normalized
        ):
            self.result = [
                dict(row)
                for row
                in self.connection.history_rows
            ]

        elif (
            "FROM claim_versions"
            in normalized
        ):
            self.result = [
                dict(row)
                for row
                in self.connection.target_rows
            ]

        else:
            raise AssertionError(
                "Unexpected SQL: "
                f"{normalized}"
            )

        return len(
            self.result
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
        *,
        tenant: (
            dict[str, object]
            | None
        ) = None,
        schemes=None,
        members=None,
        providers=None,
        target_rows=None,
        history_rows=None,
        fail_pattern: str | None = None,
    ) -> None:
        self.tenant = (
            tenant
            if tenant is not None
            else {
                "tenant_id":
                    "tenant_alpha",

                "tenant_slug":
                    "alpha",

                "tenant_name":
                    "Tenant Alpha",
            }
        )

        self.schemes = list(
            schemes
            or [
                {
                    "scheme_id":
                        "ALPHA01",

                    "scheme_name":
                        "Alpha Scheme",
                }
            ]
        )

        self.members = list(
            members
            or []
        )

        self.providers = list(
            providers
            or []
        )

        self.target_rows = list(
            target_rows
            or []
        )

        self.history_rows = list(
            history_rows
            or []
        )

        self.fail_pattern = (
            fail_pattern
        )

        self.queries = []
        self.events = []

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

    def commit(
        self,
    ):
        self.events.append(
            "commit"
        )

    def rollback(
        self,
    ):
        self.events.append(
            "rollback"
        )

    def close(
        self,
    ):
        self.events.append(
            "close"
        )


class CountingConnectionFactory:
    def __init__(
        self,
        connection,
    ) -> None:
        self.connection = (
            connection
        )

        self.calls = 0

    def __call__(
        self,
    ):
        self.calls += 1

        return self.connection


def target_query(
    connection: FakeConnection,
):
    for query, params in (
        connection.queries
    ):
        if (
            "FROM claim_versions"
            in query
            and "FROM claim_versions cv"
            not in query
        ):
            return query, params

    raise AssertionError(
        "Target query was not executed."
    )


def history_query(
    connection: FakeConnection,
):
    for query, params in (
        connection.queries
    ):
        if (
            "FROM claim_versions cv"
            in query
        ):
            return query, params

    raise AssertionError(
        "History query was not executed."
    )


class SnapshotTests(
    TestCase,
):
    def test_snapshot_loads_exact_versions_and_bounded_historical_context(
        self,
    ) -> None:
        queued_job = outbox_job(
            targets=[
                {
                    "claim_id":
                        "CLAIM-B",

                    "claim_version":
                        3,
                },
                {
                    "claim_id":
                        "CLAIM-A",

                    "claim_version":
                        2,
                },
            ]
        )

        target_rows = [
            claim_version_row(
                claim_id="CLAIM-B",
                claim_version=3,
                member_id="MEMBER-B",
                provider_id="PROVIDER-B",
                billing_code="GP02",
                amount=50,
                created_at=(
                    CUTOFF
                    - timedelta(
                        minutes=5
                    )
                ),
                tenant_id_in_payload=(
                    "tenant_beta"
                ),
            ),
            claim_version_row(
                claim_id="CLAIM-A",
                claim_version=2,
                member_id="MEMBER-1",
                provider_id="PROVIDER-1",
                billing_code="GP01",
                amount=200,
                created_at=(
                    CUTOFF
                    - timedelta(
                        minutes=10
                    )
                ),
                tenant_id_in_payload=(
                    "tenant_beta"
                ),
            ),
        ]

        history_rows = [
            /*
             * Same member, provider, billing code,
             * service date and amount as CLAIM-A.
             */
            claim_version_row(
                claim_id="HISTORY-1",
                claim_version=1,
                member_id="MEMBER-1",
                provider_id="PROVIDER-1",
                billing_code="GP01",
                amount=200,
                service_date="2026-07-22",
                received_date="2026-07-22",
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=1
                    )
                ),
            ),
            claim_version_row(
                claim_id="HISTORY-2",
                claim_version=1,
                member_id="MEMBER-1",
                provider_id="PROVIDER-2",
                billing_code="GP01",
                amount=100,
                service_date="2026-07-10",
                received_date="2026-07-10",
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=13
                    )
                ),
            ),
            claim_version_row(
                claim_id="HISTORY-3",
                claim_version=4,
                member_id="MEMBER-2",
                provider_id="PROVIDER-1",
                billing_code="GP99",
                amount=300,
                service_date="2026-06-01",
                received_date="2026-06-01",
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=52
                    )
                ),
            ),
            /*
             * A historical version of a target claim.
             * It must be excluded by claim_id.
             */
            claim_version_row(
                claim_id="CLAIM-A",
                claim_version=1,
                member_id="MEMBER-1",
                provider_id="PROVIDER-1",
                billing_code="GP01",
                amount=999,
                service_date="2026-07-01",
                received_date="2026-07-01",
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=22
                    )
                ),
            ),
        ]

        connection = FakeConnection(
            target_rows=target_rows,
            history_rows=history_rows,
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection,
                allowed_tenant_ids=(
                    frozenset(
                        {
                            "tenant_alpha",
                        }
                    )
                ),
            )
        )

        snapshot = (
            repository
            .load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    queued_job,
                ],
            )
        )

        self.assertEqual(
            snapshot.tenant_id,
            "tenant_alpha",
        )

        self.assertEqual(
            snapshot.tenant_slug,
            "alpha",
        )

        self.assertEqual(
            snapshot
            .tenant_display_name,
            "Tenant Alpha",
        )

        self.assertEqual(
            snapshot
            .detection_strategy_id,
            DETERMINISTIC_STRATEGY_ID,
        )

        self.assertEqual(
            snapshot
            .detection_strategy,
            "deterministic_rules",
        )

        self.assertIsNone(
            snapshot
            .model_deployment_id
        )

        self.assertEqual(
            snapshot.captured_at,
            CUTOFF_TEXT,
        )

        self.assertEqual(
            snapshot
            .context_cutoff_at,
            CUTOFF_TEXT,
        )

        self.assertEqual(
            snapshot
            .source_job_ids,
            (
                "job-1",
            ),
        )

        self.assertEqual(
            [
                (
                    claim[
                        "claim_id"
                    ],
                    claim[
                        "claim_version"
                    ],
                )
                for claim
                in snapshot
                .target_claims
            ],
            [
                (
                    "CLAIM-A",
                    2,
                ),
                (
                    "CLAIM-B",
                    3,
                ),
            ],
        )

        self.assertTrue(
            all(
                "tenant_id"
                not in claim
                for claim
                in snapshot
                .target_claims
            )
        )

        features_by_claim = {
            entry["claim_id"]:
                entry["features"]
            for entry
            in snapshot
            .context_features
        }

        claim_a = (
            features_by_claim[
                "CLAIM-A"
            ]
        )

        self.assertEqual(
            claim_a[
                "historyWindowDays"
            ],
            365,
        )

        self.assertEqual(
            claim_a[
                "contextCutoffAt"
            ],
            CUTOFF_TEXT,
        )

        self.assertEqual(
            claim_a["member"][
                "claimCount30d"
            ],
            2,
        )

        self.assertEqual(
            claim_a["member"][
                "claimAmount30d"
            ],
            300.0,
        )

        self.assertEqual(
            claim_a["member"][
                "distinctProviderCount90d"
            ],
            2,
        )

        self.assertEqual(
            claim_a["member"][
                "daysSincePreviousClaim"
            ],
            1,
        )

        self.assertEqual(
            claim_a["provider"][
                "claimCount7d"
            ],
            1,
        )

        self.assertEqual(
            claim_a["provider"][
                "claimCount90d"
            ],
            2,
        )

        self.assertEqual(
            claim_a["provider"][
                "claimAmount90d"
            ],
            500.0,
        )

        self.assertEqual(
            claim_a[
                "memberProviderPair"
            ][
                "claimCount365d"
            ],
            1,
        )

        self.assertEqual(
            claim_a["billingCode"][
                "tenantClaimCount90d"
            ],
            2,
        )

        self.assertEqual(
            claim_a["billingCode"][
                "providerClaimCount90d"
            ],
            1,
        )

        self.assertEqual(
            claim_a["claim"][
                "duplicateLikeClaimCount365d"
            ],
            1,
        )

        self.assertEqual(
            claim_a["claim"][
                "amountToMemberMean365d"
            ],
            1.333333,
        )

        self.assertEqual(
            claim_a["claim"][
                "amountToProviderMean365d"
            ],
            0.8,
        )

        self.assertRegex(
            snapshot.watermark,
            (
                r"^prospective:"
                r"2026-07-23T12:00:00"
                r"\+00:00:"
                r"targets:2:"
                r"sha256:[0-9a-f]{64}$"
            ),
        )

        target_sql, target_params = (
            target_query(
                connection
            )
        )

        self.assertNotIn(
            "MAX(",
            target_sql,
        )

        self.assertIn(
            (
                "(claim_id, claim_version) "
                "IN ((%s, %s), (%s, %s))"
            ),
            target_sql,
        )

        self.assertEqual(
            target_params,
            [
                "tenant_alpha",
                "CLAIM-A",
                2,
                "CLAIM-B",
                3,
            ],
        )

        historical_sql, historical_params = (
            history_query(
                connection
            )
        )

        self.assertIn(
            "MAX(claim_version)",
            historical_sql,
        )

        self.assertIn(
            "created_at >= %s",
            historical_sql,
        )

        self.assertIn(
            "created_at <= %s",
            historical_sql,
        )

        self.assertEqual(
            historical_params[0],
            "tenant_alpha",
        )

        self.assertEqual(
            historical_params[-1],
            "tenant_alpha",
        )

        self.assertEqual(
            historical_params[1],
            (
                CUTOFF
                - timedelta(
                    days=365
                )
            ).replace(
                tzinfo=None
            ),
        )

        self.assertEqual(
            historical_params[2],
            CUTOFF.replace(
                tzinfo=None
            ),
        )

        select_queries = [
            (
                query,
                params,
            )
            for query, params
            in connection.queries
            if query.startswith(
                "SELECT"
            )
        ]

        self.assertTrue(
            all(
                (
                    "tenant_id = %s"
                    in query
                )
                for query, _params
                in select_queries
            )
        )

        self.assertTrue(
            all(
                params
                and params[0]
                == "tenant_alpha"
                for _query, params
                in select_queries
            )
        )

        self.assertEqual(
            connection.events,
            [
                "begin",
                "commit",
                "close",
            ],
        )

    def test_watermark_and_output_are_stable_across_database_and_job_order(
        self,
    ) -> None:
        first_job = outbox_job(
            "job-b",
            targets=[
                {
                    "claim_id":
                        "CLAIM-B",

                    "claim_version":
                        1,
                }
            ],
        )

        second_job = outbox_job(
            "job-a",
            targets=[
                {
                    "claim_id":
                        "CLAIM-A",

                    "claim_version":
                        2,
                }
            ],
        )

        targets = [
            claim_version_row(
                claim_id="CLAIM-A",
                claim_version=2,
                member_id="MEMBER-1",
                provider_id="PROVIDER-1",
                billing_code="GP01",
                amount=100,
                created_at=(
                    CUTOFF
                    - timedelta(
                        minutes=10
                    )
                ),
            ),
            claim_version_row(
                claim_id="CLAIM-B",
                claim_version=1,
                member_id="MEMBER-2",
                provider_id="PROVIDER-2",
                billing_code="GP02",
                amount=200,
                created_at=(
                    CUTOFF
                    - timedelta(
                        minutes=5
                    )
                ),
            ),
        ]

        history = [
            claim_version_row(
                claim_id="HISTORY-A",
                claim_version=1,
                member_id="MEMBER-1",
                provider_id="PROVIDER-1",
                billing_code="GP01",
                amount=50,
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=2
                    )
                ),
            ),
            claim_version_row(
                claim_id="HISTORY-B",
                claim_version=1,
                member_id="MEMBER-2",
                provider_id="PROVIDER-2",
                billing_code="GP02",
                amount=75,
                created_at=(
                    CUTOFF
                    - timedelta(
                        days=3
                    )
                ),
            ),
        ]

        first_connection = (
            FakeConnection(
                target_rows=list(
                    reversed(
                        targets
                    )
                ),
                history_rows=list(
                    reversed(
                        history
                    )
                ),
            )
        )

        second_connection = (
            FakeConnection(
                target_rows=targets,
                history_rows=history,
            )
        )

        first_snapshot = (
            PyMySqlTenantSnapshotRepository(
                lambda: first_connection
            ).load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    first_job,
                    second_job,
                ],
            )
        )

        second_snapshot = (
            PyMySqlTenantSnapshotRepository(
                lambda: second_connection
            ).load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    second_job,
                    first_job,
                ],
            )
        )

        self.assertEqual(
            first_snapshot
            .source_job_ids,
            (
                "job-a",
                "job-b",
            ),
        )

        self.assertEqual(
            second_snapshot
            .source_job_ids,
            (
                "job-a",
                "job-b",
            ),
        )

        self.assertEqual(
            first_snapshot
            .target_claims,
            second_snapshot
            .target_claims,
        )

        self.assertEqual(
            first_snapshot
            .context_features,
            second_snapshot
            .context_features,
        )

        self.assertEqual(
            first_snapshot
            .watermark,
            second_snapshot
            .watermark,
        )

    def test_approved_model_metadata_is_preserved_exactly(
        self,
    ) -> None:
        queued_job = outbox_job(
            detection_strategy_id=(
                APPROVED_MODEL_STRATEGY_ID
            ),
            strategy_type=(
                "approved_model"
            ),
            model_deployment_id=(
                APPROVED_DEPLOYMENT_ID
            ),
        )

        connection = FakeConnection(
            target_rows=[
                claim_version_row(
                    claim_id="CLAIM-1",
                    claim_version=1,
                    member_id="MEMBER-1",
                    provider_id="PROVIDER-1",
                    billing_code="GP01",
                    amount=100,
                    created_at=(
                        CUTOFF
                        - timedelta(
                            minutes=1
                        )
                    ),
                )
            ],
        )

        snapshot = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection
            ).load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    queued_job,
                ],
            )
        )

        self.assertEqual(
            snapshot
            .detection_strategy_id,
            APPROVED_MODEL_STRATEGY_ID,
        )

        self.assertEqual(
            snapshot
            .detection_strategy,
            "approved_model",
        )

        self.assertEqual(
            snapshot
            .model_deployment_id,
            APPROVED_DEPLOYMENT_ID,
        )

    def test_missing_exact_target_version_fails_closed(
        self,
    ) -> None:
        queued_job = outbox_job(
            targets=[
                {
                    "claim_id":
                        "CLAIM-A",

                    "claim_version":
                        1,
                },
                {
                    "claim_id":
                        "CLAIM-B",

                    "claim_version":
                        2,
                },
            ]
        )

        connection = FakeConnection(
            target_rows=[
                claim_version_row(
                    claim_id="CLAIM-A",
                    claim_version=1,
                    member_id="MEMBER-1",
                    provider_id="PROVIDER-1",
                    billing_code="GP01",
                    amount=100,
                    created_at=(
                        CUTOFF
                        - timedelta(
                            minutes=1
                        )
                    ),
                )
            ],
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection
            )
        )

        with self.assertRaisesRegex(
            ValueError,
            (
                r"Pinned target claim "
                r"versions are unavailable:"
                r" CLAIM-B@2"
            ),
        ):
            repository.load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    queued_job,
                ],
            )

        self.assertEqual(
            connection.events,
            [
                "begin",
                "commit",
                "close",
            ],
        )

    def test_target_version_created_after_cutoff_is_rejected(
        self,
    ) -> None:
        connection = FakeConnection(
            target_rows=[
                claim_version_row(
                    claim_id="CLAIM-1",
                    claim_version=1,
                    member_id="MEMBER-1",
                    provider_id="PROVIDER-1",
                    billing_code="GP01",
                    amount=100,
                    created_at=(
                        CUTOFF
                        + timedelta(
                            seconds=1
                        )
                    ),
                )
            ],
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection
            )
        )

        with self.assertRaisesRegex(
            ValueError,
            "created after its cutoff",
        ):
            repository.load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    outbox_job(),
                ],
            )

    def test_historical_context_crossing_cutoff_is_rejected(
        self,
    ) -> None:
        connection = FakeConnection(
            target_rows=[
                claim_version_row(
                    claim_id="CLAIM-1",
                    claim_version=1,
                    member_id="MEMBER-1",
                    provider_id="PROVIDER-1",
                    billing_code="GP01",
                    amount=100,
                    created_at=(
                        CUTOFF
                        - timedelta(
                            minutes=1
                        )
                    ),
                )
            ],
            history_rows=[
                claim_version_row(
                    claim_id="FUTURE-HISTORY",
                    claim_version=1,
                    member_id="MEMBER-1",
                    provider_id="PROVIDER-1",
                    billing_code="GP01",
                    amount=100,
                    created_at=(
                        CUTOFF
                        + timedelta(
                            seconds=1
                        )
                    ),
                )
            ],
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection
            )
        )

        with self.assertRaisesRegex(
            ValueError,
            "Historical context crossed",
        ):
            repository.load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    outbox_job(),
                ],
            )

    def test_scope_and_job_identity_are_validated_before_connecting(
        self,
    ) -> None:
        connection = FakeConnection()

        factory = (
            CountingConnectionFactory(
                connection
            )
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                factory,
                allowed_tenant_ids=(
                    frozenset(
                        {
                            "tenant_alpha",
                        }
                    )
                ),
            )
        )

        invalid_cases = [
            {
                "tenant_id":
                    "tenant_beta",

                "jobs": [
                    outbox_job(
                        tenant_id=(
                            "tenant_beta"
                        )
                    ),
                ],

                "message":
                    "outside the verified",
            },
            {
                "tenant_id":
                    "tenant_alpha",

                "jobs": [],

                "message":
                    "At least one outbox job",
            },
            {
                "tenant_id":
                    "tenant_alpha",

                "jobs": [
                    outbox_job(
                        tenant_id=(
                            "tenant_beta"
                        )
                    ),
                ],

                "message":
                    "cross tenant boundaries",
            },
            {
                "tenant_id":
                    "tenant_alpha",

                "jobs": [
                    outbox_job(
                        "job-1"
                    ),
                    outbox_job(
                        "job-2",
                        detection_strategy_id=(
                            999
                        ),
                    ),
                ],

                "message":
                    "one pinned strategy",
            },
            {
                "tenant_id":
                    "tenant_alpha",

                "jobs": [
                    outbox_job(
                        "job-1"
                    ),
                    outbox_job(
                        "job-2",
                        cutoff=(
                            "2026-07-23"
                            "T12:01:00+00:00"
                        ),
                    ),
                ],

                "message":
                    "one context cutoff",
            },
        ]

        for case in invalid_cases:
            with self.subTest(
                message=case[
                    "message"
                ]
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    case["message"],
                ):
                    repository.load_tenant_snapshot(
                        tenant_id=(
                            case[
                                "tenant_id"
                            ]
                        ),
                        jobs=case[
                            "jobs"
                        ],
                    )

        self.assertEqual(
            factory.calls,
            0,
        )

    def test_database_failure_rolls_back_and_closes_connection(
        self,
    ) -> None:
        connection = FakeConnection(
            fail_pattern=(
                "FROM claim_versions "
                "WHERE tenant_id = %s"
            )
        )

        repository = (
            PyMySqlTenantSnapshotRepository(
                lambda: connection
            )
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "Synthetic database failure",
        ):
            repository.load_tenant_snapshot(
                tenant_id=(
                    "tenant_alpha"
                ),
                jobs=[
                    outbox_job(),
                ],
            )

        self.assertEqual(
            connection.events,
            [
                "begin",
                "rollback",
                "close",
            ],
        )
