import unittest
from types import SimpleNamespace
from unittest.mock import patch

from claimguard_report_producer.data_plane import DataPlaneRouteError, resolve_worker_data_plane_scope
from claimguard_report_producer.outbox import OutboxJob, PyMySqlOutboxRepository


class DataPlaneScopedOutboxTests(unittest.TestCase):
    @staticmethod
    def _pymysql_module(
        *, migration_version: int, route_type: str = "legacy_shared", schema_version: str = "10"
    ):
        class Cursor:
            def __init__(self, kind):
                self.kind = kind
                self.query = ""

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, query, _params=None):
                self.query = query

            def fetchone(self):
                if self.kind == "operational":
                    return {
                        "database_mode": route_type,
                        "logical_database_identifier": (
                            "legacy-operational-shared" if route_type == "legacy_shared" else "private:org-alpha"
                        ),
                        "schema_version": schema_version,
                        "environment_key": "legacy" if route_type == "legacy_shared" else "production",
                        "migration_version": migration_version,
                    }
                if "FROM organisations" in self.query:
                    return {
                        "organisation_id": "org-alpha",
                        "canonical_slug": "alpha",
                        "status": "active",
                        "activation_state": "activated",
                    }
                return None

            def fetchall(self):
                if "FROM data_plane_routes" in self.query:
                    return [{
                        "route_id": "route-alpha",
                        "route_type": route_type,
                        "route_generation": 3,
                        "logical_database_identifier": (
                            "legacy-operational-shared" if route_type == "legacy_shared" else "private:org-alpha"
                        ),
                        "database_name": "operational" if route_type == "legacy_shared" else "tenant_alpha",
                        "secret_reference": (
                            "" if route_type == "legacy_shared" else ",".join([
                                "https://vault.test/secrets/username",
                                "https://vault.test/secrets/password",
                                "https://vault.test/secrets/host",
                                "https://vault.test/secrets/database",
                            ])
                        ),
                        "schema_version": schema_version,
                        "provisioning_status": "active",
                        "health_status": "healthy",
                        "retired_at": None,
                    }]
                if "FROM legacy_tenant_mappings" in self.query:
                    return [{
                        "legacy_tenant_id": "tenant_alpha",
                        "migration_status": "verified",
                        "route_id": "route-alpha",
                        "verified_at": "2026-07-19T00:00:00Z",
                    }]
                return []

        class Connection:
            def __init__(self, kind):
                self.kind = kind

            def cursor(self):
                return Cursor(self.kind)

            def close(self):
                return None

        connections = iter([Connection("control"), Connection("operational")])
        return SimpleNamespace(
            connect=lambda **_options: next(connections),
            cursors=SimpleNamespace(DictCursor=object),
        )

    def test_service_identity_scope_rejects_another_organisation_before_connecting(self):
        with self.assertRaisesRegex(DataPlaneRouteError, "outside the internal service identity scope"):
            resolve_worker_data_plane_scope(
                control_plane_url="unused",
                operational_url="unused",
                organisation_ids=["org-beta"],
                allowed_organisation_ids=frozenset({"org-alpha"}),
            )

    def test_job_tenant_cannot_expand_verified_worker_scope(self):
        repository = PyMySqlOutboxRepository(
            lambda: self.fail("no connection should be opened for a rejected scope"),
            frozenset({"tenant_alpha"}),
        )
        job = OutboxJob(
            id="job-beta",
            tenant_id="tenant_beta",
            job_type="report_production",
            aggregate_type="claim_batch",
            aggregate_id="batch",
            correlation_id="corr",
            payload={"claims": [{"claim_id": "c"}]},
            status="processing",
            attempt_count=1,
            max_attempts=5,
        )
        with self.assertRaisesRegex(ValueError, "outside the verified worker data-plane scope"):
            repository.mark_dead_letter(job=job, worker_id="worker", last_error="failure")

    def test_worker_scope_requires_the_current_operational_schema(self):
        with patch.dict("sys.modules", {"pymysql": self._pymysql_module(migration_version=10)}):
            scope = resolve_worker_data_plane_scope(
                control_plane_url="mysql://user:secret@control/controls",
                operational_url="mysql://user:secret@operational/operational",
                organisation_ids=["org-alpha"],
                allowed_organisation_ids=frozenset({"org-alpha"}),
            )
        self.assertEqual(scope.schema_version, "10")
        self.assertEqual(scope.tenant_ids, frozenset({"tenant_alpha"}))

        with patch.dict("sys.modules", {"pymysql": self._pymysql_module(migration_version=8)}):
            with self.assertRaisesRegex(DataPlaneRouteError, "metadata verification failed"):
                resolve_worker_data_plane_scope(
                    control_plane_url="mysql://user:secret@control/controls",
                    operational_url="mysql://user:secret@operational/operational",
                    organisation_ids=["org-alpha"],
                    allowed_organisation_ids=frozenset({"org-alpha"}),
                )

    def test_private_route_resolves_key_vault_credentials_and_uses_organisation_tenant(self):
        values = {
            "username": "tenant@runtime",
            "password": "p:a/ss",
            "host": "claimguard.mysql.database.azure.com",
            "database": "tenant_alpha",
        }

        class SecretClient:
            def get_secret(self, name, *, version=None):
                self.assert_version(version)
                return SimpleNamespace(value=values[name])

            @staticmethod
            def assert_version(version):
                if version is not None:
                    raise AssertionError("Unexpected secret version")

        with patch.dict(
            "sys.modules",
            {"pymysql": self._pymysql_module(migration_version=10, route_type="private_database")},
        ):
            scope = resolve_worker_data_plane_scope(
                control_plane_url="mysql://user:secret@control/controls",
                operational_url="",
                organisation_ids=["org-alpha"],
                allowed_organisation_ids=frozenset({"org-alpha"}),
                credential=object(),
                secret_client_factory=lambda **_kwargs: SecretClient(),
            )

        self.assertEqual(scope.route_type, "private_database")
        self.assertEqual(scope.tenant_ids, frozenset({"org-alpha"}))
        self.assertEqual(scope.schema_version, "10")
        self.assertIn("tenant%40runtime:p%3Aa%2Fss@claimguard.mysql.database.azure.com", scope.operational_url)
        self.assertNotIn("p:a/ss", repr(scope))

    def test_private_route_rejects_an_unsupported_schema_before_resolving_secrets(self):
        with patch.dict(
            "sys.modules",
            {
                "pymysql": self._pymysql_module(
                    migration_version=10,
                    route_type="private_database",
                    schema_version="8",
                )
            },
        ):
            with self.assertRaisesRegex(DataPlaneRouteError, "not active and compatible"):
                resolve_worker_data_plane_scope(
                    control_plane_url="mysql://user:secret@control/controls",
                    operational_url="",
                    organisation_ids=["org-alpha"],
                    allowed_organisation_ids=frozenset({"org-alpha"}),
                    credential=object(),
                    secret_client_factory=lambda **_kwargs: self.fail("secrets must not be resolved"),
                )


if __name__ == "__main__":
    unittest.main()
