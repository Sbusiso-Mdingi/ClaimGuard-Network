import unittest
from types import SimpleNamespace
from unittest.mock import patch

from claimguard_report_producer.data_plane import DataPlaneRouteError, resolve_worker_data_plane_scope
from claimguard_report_producer.outbox import OutboxJob, PyMySqlOutboxRepository


class DataPlaneScopedOutboxTests(unittest.TestCase):
    @staticmethod
    def _pymysql_module(*, migration_version: int):
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
                        "database_mode": "legacy_shared",
                        "logical_database_identifier": "legacy-operational-shared",
                        "schema_version": "10",
                        "environment_key": "legacy",
                        "migration_version": migration_version,
                    }
                if "FROM organisations" in self.query:
                    return {"organisation_id": "org-alpha", "status": "active", "activation_state": "activated"}
                return None

            def fetchall(self):
                if "FROM data_plane_routes" in self.query:
                    return [{
                        "route_id": "route-alpha",
                        "route_type": "legacy_shared",
                        "route_generation": 3,
                        "logical_database_identifier": "legacy-operational-shared",
                        "database_name": "operational",
                        "schema_version": "10",
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


if __name__ == "__main__":
    unittest.main()
