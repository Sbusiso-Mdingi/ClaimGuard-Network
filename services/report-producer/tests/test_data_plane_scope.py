from __future__ import annotations

import re
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from claimguard_report_producer.data_plane import (
    DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
    DataPlaneRouteError,
    discover_active_worker_organisation_ids,
    resolve_worker_data_plane_scope,
)
from claimguard_report_producer.outbox import (
    CLAIM_PROCESSING_AGGREGATE_TYPE,
    CLAIM_PROCESSING_DATASET_SCOPE,
    CLAIM_PROCESSING_JOB_TYPE,
    CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
    OutboxContractError,
    OutboxJob,
    PyMySqlOutboxRepository,
)


SCHEMA_VERSION = "14"
MIGRATION_VERSION = 14

CONTROL_URL = (
    "mysql://control-user:control-secret"
    "@control.test/controls"
)

LEGACY_OPERATIONAL_URL = (
    "mysql://runtime-user:runtime-secret"
    "@operational.test/operational"
    "?ssl-mode=require"
)


def prospective_job(
    *,
    tenant_id: str = "tenant_alpha",
) -> OutboxJob:
    return OutboxJob(
        id="job-1",
        tenant_id=tenant_id,
        job_type=(
            CLAIM_PROCESSING_JOB_TYPE
        ),
        aggregate_type=(
            CLAIM_PROCESSING_AGGREGATE_TYPE
        ),
        aggregate_id="a" * 64,
        correlation_id="correlation-1",
        payload={
            "schema_version":
                CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
            "dataset_scope":
                CLAIM_PROCESSING_DATASET_SCOPE,
            "source":
                "api:test",
            "context_cutoff_at":
                "2026-07-23T12:00:00+00:00",
            "targets": [
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
        max_attempts=5,
        detection_strategy_id=17,
        strategy_type=(
            "deterministic_rules"
        ),
        model_deployment_id=None,
    )


class FakeCursor:
    def __init__(
        self,
        connection,
    ) -> None:
        self.connection = connection
        self.query = ""
        self.params = []

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
        query,
        params=None,
    ):
        self.query = " ".join(
            str(query).split()
        )

        self.params = (
            list(params)
            if params is not None
            else []
        )

        self.connection.queries.append(
            {
                "sql":
                    self.query,
                "params":
                    list(
                        self.params
                    ),
            }
        )

        return 1

    def fetchone(
        self,
    ):
        if (
            "FROM organisations"
            in self.query
        ):
            organisation = (
                self.connection
                .fake
                .organisation
            )

            return (
                dict(
                    organisation
                )
                if organisation
                is not None
                else None
            )

        return None

    def fetchall(
        self,
    ):
        fake = (
            self.connection.fake
        )

        if (
            "worker_routing_status"
            in self.query
        ):
            return [
                {
                    "organisation_id":
                        organisation_id,
                }
                for organisation_id
                in fake
                .discovered_organisation_ids
            ]

        if (
            "FROM data_plane_routes"
            in self.query
        ):
            return [
                dict(row)
                for row
                in fake.route_rows
            ]

        if (
            "FROM legacy_tenant_mappings"
            in self.query
        ):
            return [
                dict(row)
                for row
                in fake.mapping_rows
            ]

        if (
            "FROM data_plane_metadata"
            in self.query
        ):
            return [
                dict(row)
                for row
                in fake.metadata_rows
            ]

        return []


class FakeConnection:
    def __init__(
        self,
        fake,
        *,
        kind: str,
        options,
    ) -> None:
        self.fake = fake
        self.kind = kind
        self.options = dict(
            options
        )
        self.queries = []
        self.closed = False

    def cursor(
        self,
    ):
        return FakeCursor(
            self
        )

    def close(
        self,
    ):
        self.closed = True


class FakePyMySql:
    def __init__(
        self,
        *,
        route_type: str = (
            "legacy_shared"
        ),
        schema_version: str = (
            SCHEMA_VERSION
        ),
        migration_version: int = (
            MIGRATION_VERSION
        ),
        route_generation: object = 3,
        route_rows=None,
        mapping_rows=None,
        metadata_rows=None,
        organisation=None,
        discovered_organisation_ids=(
            "org-alpha",
            "org-beta",
        ),
    ) -> None:
        self.route_type = (
            route_type
        )

        logical_identifier = (
            "legacy-operational-shared"
            if route_type
            == "legacy_shared"
            else "private:org-alpha"
        )

        database_name = (
            "operational"
            if route_type
            == "legacy_shared"
            else "tenant_alpha"
        )

        secret_reference = (
            ""
            if route_type
            == "legacy_shared"
            else ",".join(
                [
                    (
                        "https://vault.test"
                        "/secrets/username"
                    ),
                    (
                        "https://vault.test"
                        "/secrets/password"
                    ),
                    (
                        "https://vault.test"
                        "/secrets/host"
                    ),
                    (
                        "https://vault.test"
                        "/secrets/database"
                    ),
                ]
            )
        )

        self.route_rows = (
            [
                {
                    "route_id":
                        "route-alpha",
                    "route_type":
                        route_type,
                    "route_generation":
                        route_generation,
                    "logical_database_identifier":
                        logical_identifier,
                    "database_name":
                        database_name,
                    "secret_reference":
                        secret_reference,
                    "schema_version":
                        schema_version,
                    "provisioning_status":
                        "active",
                    "health_status":
                        "healthy",
                    "retired_at":
                        None,
                }
            ]
            if route_rows
            is None
            else list(
                route_rows
            )
        )

        self.mapping_rows = (
            [
                {
                    "legacy_tenant_id":
                        "tenant_alpha",
                    "migration_status":
                        "verified",
                    "route_id":
                        "route-alpha",
                    "verified_at":
                        (
                            "2026-07-23"
                            "T00:00:00Z"
                        ),
                }
            ]
            if mapping_rows
            is None
            else list(
                mapping_rows
            )
        )

        self.metadata_rows = (
            [
                {
                    "database_mode":
                        route_type,
                    "logical_database_identifier":
                        logical_identifier,
                    "schema_version":
                        schema_version,
                    "environment_key":
                        (
                            "legacy"
                            if route_type
                            == "legacy_shared"
                            else "production"
                        ),
                    "migration_version":
                        migration_version,
                }
            ]
            if metadata_rows
            is None
            else list(
                metadata_rows
            )
        )

        self.organisation = (
            {
                "organisation_id":
                    "org-alpha",
                "canonical_slug":
                    "alpha",
                "status":
                    "active",
                "activation_state":
                    "activated",
            }
            if organisation
            is None
            else organisation
        )

        self.discovered_organisation_ids = tuple(
            discovered_organisation_ids
        )

        self.connect_calls = []
        self.connections = []

        self.cursors = (
            SimpleNamespace(
                DictCursor=object,
            )
        )

    def connect(
        self,
        **options,
    ):
        kind = (
            "control"
            if options.get(
                "database"
            )
            == "controls"
            else "operational"
        )

        self.connect_calls.append(
            {
                "kind":
                    kind,
                "options":
                    dict(
                        options
                    ),
            }
        )

        connection = (
            FakeConnection(
                self,
                kind=kind,
                options=options,
            )
        )

        self.connections.append(
            connection
        )

        return connection


def resolve_scope(
    fake: FakePyMySql,
    **overrides,
):
    arguments = {
        "control_plane_url":
            CONTROL_URL,
        "operational_url":
            LEGACY_OPERATIONAL_URL,
        "organisation_ids":
            [
                "org-alpha",
            ],
        "allowed_organisation_ids":
            frozenset(
                {
                    "org-alpha",
                }
            ),
    }

    arguments.update(
        overrides
    )

    with patch.dict(
        "sys.modules",
        {
            "pymysql":
                fake,
        },
    ):
        return (
            resolve_worker_data_plane_scope(
                **arguments,
            )
        )


class DataPlaneScopeTests(
    unittest.TestCase,
):
    def test_default_supported_schema_is_14(
        self,
    ) -> None:
        self.assertEqual(
            DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
            frozenset(
                {
                    "14",
                }
            ),
        )

    def test_service_identity_scope_is_checked_before_database_connection(
        self,
    ) -> None:
        fake = FakePyMySql()

        with patch.dict(
            "sys.modules",
            {
                "pymysql":
                    fake,
            },
        ):
            with self.assertRaisesRegex(
                DataPlaneRouteError,
                (
                    "outside the internal "
                    "service identity scope"
                ),
            ):
                resolve_worker_data_plane_scope(
                    control_plane_url=(
                        CONTROL_URL
                    ),
                    operational_url=(
                        LEGACY_OPERATIONAL_URL
                    ),
                    organisation_ids=[
                        "org-beta",
                    ],
                    allowed_organisation_ids=(
                        frozenset(
                            {
                                "org-alpha",
                            }
                        )
                    ),
                )

        self.assertEqual(
            fake.connect_calls,
            [],
        )

    def test_exactly_one_organisation_is_required_per_worker(
        self,
    ) -> None:
        fake = FakePyMySql()

        cases = [
            [],
            [
                "org-alpha",
                "org-beta",
            ],
        ]

        for organisations in cases:
            with self.subTest(
                organisations=(
                    organisations
                )
            ):
                with patch.dict(
                    "sys.modules",
                    {
                        "pymysql":
                            fake,
                    },
                ):
                    with self.assertRaisesRegex(
                        DataPlaneRouteError,
                        "Exactly one",
                    ):
                        resolve_worker_data_plane_scope(
                            control_plane_url=(
                                CONTROL_URL
                            ),
                            operational_url=(
                                LEGACY_OPERATIONAL_URL
                            ),
                            organisation_ids=(
                                organisations
                            ),
                            allowed_organisation_ids=(
                                frozenset(
                                    {
                                        "org-alpha",
                                        "org-beta",
                                    }
                                )
                            ),
                        )

        self.assertEqual(
            fake.connect_calls,
            [],
        )

    def test_discovery_uses_schema_14_and_returns_control_plane_order(
        self,
    ) -> None:
        fake = FakePyMySql(
            discovered_organisation_ids=(
                "org-alpha",
                "org-beta",
            )
        )

        with patch.dict(
            "sys.modules",
            {
                "pymysql":
                    fake,
            },
        ):
            organisation_ids = (
                discover_active_worker_organisation_ids(
                    control_plane_url=(
                        CONTROL_URL
                    ),
                )
            )

        self.assertEqual(
            organisation_ids,
            (
                "org-alpha",
                "org-beta",
            ),
        )

        self.assertEqual(
            len(
                fake.connections
            ),
            1,
        )

        connection = (
            fake.connections[0]
        )

        discovery_query = next(
            query
            for query
            in connection.queries
            if (
                "worker_routing_status"
                in query["sql"]
            )
        )

        self.assertEqual(
            discovery_query[
                "params"
            ],
            [
                "14",
            ],
        )

        self.assertIn(
            (
                "r.active_route_slot "
                "= o.organisation_id"
            ),
            discovery_query[
                "sql"
            ],
        )

        self.assertIn(
            "w.status = 'ready'",
            discovery_query[
                "sql"
            ],
        )

        self.assertTrue(
            connection.closed
        )

    def test_discovery_rejects_duplicate_organisations(
        self,
    ) -> None:
        fake = FakePyMySql(
            discovered_organisation_ids=(
                "org-alpha",
                "org-alpha",
            )
        )

        with patch.dict(
            "sys.modules",
            {
                "pymysql":
                    fake,
            },
        ):
            with self.assertRaisesRegex(
                DataPlaneRouteError,
                "duplicate organisations",
            ):
                discover_active_worker_organisation_ids(
                    control_plane_url=(
                        CONTROL_URL
                    ),
                )

        self.assertTrue(
            fake.connections[0].closed
        )

    def test_legacy_scope_verifies_schema_and_migration_14(
        self,
    ) -> None:
        fake = FakePyMySql()

        scope = resolve_scope(
            fake
        )

        self.assertEqual(
            scope.organisation_ids,
            (
                "org-alpha",
            ),
        )

        self.assertEqual(
            scope.tenant_ids,
            frozenset(
                {
                    "tenant_alpha",
                }
            ),
        )

        self.assertEqual(
            scope.route_keys,
            (
                "org-alpha:"
                "route-alpha:3",
            ),
        )

        self.assertEqual(
            scope.schema_version,
            "14",
        )

        self.assertEqual(
            scope.migration_version,
            14,
        )

        self.assertEqual(
            scope.route_type,
            "legacy_shared",
        )

        self.assertEqual(
            scope.operational_url,
            LEGACY_OPERATIONAL_URL,
        )

        self.assertRegex(
            scope.connection_fingerprint,
            r"^[0-9a-f]{64}$",
        )

        self.assertNotIn(
            "runtime-secret",
            repr(
                scope
            ),
        )

        self.assertEqual(
            [
                call["kind"]
                for call
                in fake.connect_calls
            ],
            [
                "control",
                "operational",
            ],
        )

        self.assertTrue(
            all(
                connection.closed
                for connection
                in fake.connections
            )
        )

        operational = next(
            connection
            for connection
            in fake.connections
            if connection.kind
            == "operational"
        )

        metadata_query = next(
            query
            for query
            in operational.queries
            if (
                "FROM data_plane_metadata"
                in query["sql"]
            )
        )

        self.assertIn(
            (
                "WHERE metadata_key "
                "= 'primary'"
            ),
            metadata_query[
                "sql"
            ],
        )

        self.assertIn(
            "LIMIT 2",
            metadata_query[
                "sql"
            ],
        )

    def test_route_schema_determines_required_migration_version(
        self,
    ) -> None:
        fake = FakePyMySql(
            schema_version="15",
            migration_version=15,
        )

        scope = resolve_scope(
            fake,
            supported_schema_versions=(
                frozenset(
                    {
                        "15",
                    }
                )
            ),
        )

        self.assertEqual(
            scope.schema_version,
            "15",
        )

        self.assertEqual(
            scope.migration_version,
            15,
        )

    def test_metadata_identity_mismatches_fail_closed(
        self,
    ) -> None:
        base = {
            "database_mode":
                "legacy_shared",
            "logical_database_identifier":
                "legacy-operational-shared",
            "schema_version":
                "14",
            "environment_key":
                "legacy",
            "migration_version":
                14,
        }

        cases = [
            (
                "database mode",
                {
                    "database_mode":
                        "private_database",
                },
            ),
            (
                "logical identity",
                {
                    "logical_database_identifier":
                        "wrong-database",
                },
            ),
            (
                "schema version",
                {
                    "schema_version":
                        "13",
                },
            ),
            (
                "environment",
                {
                    "environment_key":
                        "production",
                },
            ),
            (
                "migration version",
                {
                    "migration_version":
                        13,
                },
            ),
        ]

        for name, changes in cases:
            with self.subTest(
                case=name,
            ):
                fake = FakePyMySql(
                    metadata_rows=[
                        {
                            **base,
                            **changes,
                        }
                    ]
                )

                with self.assertRaisesRegex(
                    DataPlaneRouteError,
                    (
                        "metadata "
                        "verification failed"
                    ),
                ):
                    resolve_scope(
                        fake
                    )

                self.assertTrue(
                    all(
                        connection.closed
                        for connection
                        in fake.connections
                    )
                )

    def test_metadata_requires_exactly_one_primary_row(
        self,
    ) -> None:
        valid = {
            "database_mode":
                "legacy_shared",
            "logical_database_identifier":
                "legacy-operational-shared",
            "schema_version":
                "14",
            "environment_key":
                "legacy",
            "migration_version":
                14,
        }

        for rows in (
            [],
            [
                dict(
                    valid
                ),
                dict(
                    valid
                ),
            ],
        ):
            with self.subTest(
                row_count=len(
                    rows
                )
            ):
                fake = FakePyMySql(
                    metadata_rows=rows
                )

                with self.assertRaisesRegex(
                    DataPlaneRouteError,
                    (
                        "Exactly one "
                        "operational"
                    ),
                ):
                    resolve_scope(
                        fake
                    )

    def test_route_requires_exactly_one_active_record(
        self,
    ) -> None:
        valid_route = (
            FakePyMySql()
            .route_rows[0]
        )

        for rows in (
            [],
            [
                dict(
                    valid_route
                ),
                {
                    **valid_route,
                    "route_id":
                        "route-second",
                },
            ],
        ):
            with self.subTest(
                row_count=len(
                    rows
                )
            ):
                fake = FakePyMySql(
                    route_rows=rows
                )

                with self.assertRaisesRegex(
                    DataPlaneRouteError,
                    (
                        "Exactly one active "
                        "report-worker route"
                    ),
                ):
                    resolve_scope(
                        fake
                    )

                self.assertEqual(
                    [
                        call["kind"]
                        for call
                        in fake.connect_calls
                    ],
                    [
                        "control",
                    ],
                )

    def test_unsupported_route_schema_is_rejected_before_private_secrets(
        self,
    ) -> None:
        fake = FakePyMySql(
            route_type=(
                "private_database"
            ),
            schema_version="13",
            migration_version=13,
        )

        secret_calls = []

        def secret_client_factory(
            **kwargs,
        ):
            secret_calls.append(
                kwargs
            )

            raise AssertionError(
                "Secrets must not be resolved."
            )

        with self.assertRaisesRegex(
            DataPlaneRouteError,
            "not active and compatible",
        ):
            resolve_scope(
                fake,
                operational_url="",
                credential=object(),
                secret_client_factory=(
                    secret_client_factory
                ),
            )

        self.assertEqual(
            secret_calls,
            [],
        )

        self.assertEqual(
            [
                call["kind"]
                for call
                in fake.connect_calls
            ],
            [
                "control",
            ],
        )

    def test_private_route_resolves_exact_secrets_and_uses_organisation_tenant(
        self,
    ) -> None:
        fake = FakePyMySql(
            route_type=(
                "private_database"
            )
        )

        values = {
            "username":
                "tenant@runtime",
            "password":
                "p:a/ss",
            "host":
                (
                    "claimguard.mysql"
                    ".database.azure.com"
                ),
            "database":
                "tenant_alpha",
        }

        secret_requests = []
        factory_requests = []

        class SecretClient:
            def get_secret(
                self,
                name,
                *,
                version=None,
            ):
                secret_requests.append(
                    {
                        "name":
                            name,
                        "version":
                            version,
                    }
                )

                return SimpleNamespace(
                    value=values[
                        name
                    ]
                )

        def secret_client_factory(
            **kwargs,
        ):
            factory_requests.append(
                kwargs
            )

            return SecretClient()

        scope = resolve_scope(
            fake,
            operational_url="",
            credential=object(),
            secret_client_factory=(
                secret_client_factory
            ),
        )

        self.assertEqual(
            scope.route_type,
            "private_database",
        )

        self.assertEqual(
            scope.tenant_ids,
            frozenset(
                {
                    "org-alpha",
                }
            ),
        )

        self.assertEqual(
            scope.schema_version,
            "14",
        )

        self.assertEqual(
            scope.migration_version,
            14,
        )

        self.assertIn(
            (
                "tenant%40runtime:"
                "p%3Aa%2Fss@"
            ),
            scope.operational_url,
        )

        self.assertIn(
            "/tenant_alpha",
            scope.operational_url,
        )

        self.assertIn(
            "ssl-mode=require",
            scope.operational_url,
        )

        self.assertNotIn(
            "p:a/ss",
            repr(
                scope
            ),
        )

        self.assertEqual(
            len(
                factory_requests
            ),
            1,
        )

        self.assertEqual(
            factory_requests[0][
                "vault_url"
            ],
            "https://vault.test",
        )

        self.assertEqual(
            [
                request["name"]
                for request
                in secret_requests
            ],
            [
                "username",
                "password",
                "host",
                "database",
            ],
        )

        self.assertTrue(
            all(
                request["version"]
                is None
                for request
                in secret_requests
            )
        )

        operational_call = next(
            call
            for call
            in fake.connect_calls
            if call["kind"]
            == "operational"
        )

        self.assertEqual(
            operational_call[
                "options"
            ][
                "user"
            ],
            "tenant@runtime",
        )

        self.assertEqual(
            operational_call[
                "options"
            ][
                "password"
            ],
            "p:a/ss",
        )

        self.assertEqual(
            operational_call[
                "options"
            ][
                "database"
            ],
            "tenant_alpha",
        )

    def test_invalid_route_generation_fails_closed(
        self,
    ) -> None:
        for generation in (
            0,
            -1,
            True,
            "invalid",
        ):
            with self.subTest(
                generation=(
                    generation
                )
            ):
                fake = FakePyMySql(
                    route_generation=(
                        generation
                    )
                )

                with self.assertRaisesRegex(
                    DataPlaneRouteError,
                    (
                        "route generation "
                        "is invalid"
                    ),
                ):
                    resolve_scope(
                        fake
                    )

    def test_outbox_job_cannot_expand_verified_tenant_scope(
        self,
    ) -> None:
        connection_calls = []

        def forbidden_connection():
            connection_calls.append(
                True
            )

            raise AssertionError(
                "No database connection "
                "should be opened."
            )

        repository = (
            PyMySqlOutboxRepository(
                forbidden_connection,
                allowed_tenant_ids=(
                    frozenset(
                        {
                            "tenant_alpha",
                        }
                    )
                ),
            )
        )

        queued_job = prospective_job(
            tenant_id=(
                "tenant_beta"
            )
        )

        with self.assertRaisesRegex(
            OutboxContractError,
            (
                "outside the verified "
                "data-plane scope"
            ),
        ):
            repository.mark_dead_letter(
                job=queued_job,
                worker_id="worker-1",
                last_error=(
                    "terminal failure"
                ),
            )

        self.assertEqual(
            connection_calls,
            [],
        )

    def test_supported_schema_versions_must_be_canonical_positive_integers(
        self,
    ) -> None:
        invalid_sets = [
            frozenset(),
            frozenset(
                {
                    "0",
                }
            ),
            frozenset(
                {
                    "014",
                }
            ),
            frozenset(
                {
                    "current",
                }
            ),
        ]

        for values in invalid_sets:
            with self.subTest(
                values=values,
            ):
                fake = FakePyMySql()

                with self.assertRaises(
                    DataPlaneRouteError
                ):
                    resolve_scope(
                        fake,
                        supported_schema_versions=(
                            values
                        ),
                    )

                self.assertEqual(
                    fake.connect_calls,
                    [],
                )


if __name__ == "__main__":
    unittest.main()
