from __future__ import annotations

from datetime import UTC, date, datetime
from unittest import TestCase

from claimguard_report_producer.snapshot import PyMySqlTenantSnapshotRepository


class FakeCursor:
    def __init__(self, connection) -> None:
        self.connection = connection
        self.result = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split())
        self.connection.queries.append((normalized, params))
        if "FROM tenants" in normalized:
            self.result = [{
                "tenant_id": "tenant_alpha", "tenant_slug": "alpha", "tenant_name": "Alpha",
                "captured_at": datetime(2026, 7, 16, tzinfo=UTC),
            }]
        elif "FROM schemes" in normalized:
            self.result = [{"scheme_id": "A", "scheme_name": "Alpha"}]
        elif "FROM members" in normalized:
            self.result = []
        elif "FROM providers" in normalized:
            self.result = []
        elif "FROM claims" in normalized:
            self.result = [
                {"claim_id": "C-1", "service_date": date(2026, 7, 14), "updated_at": datetime(2026, 7, 15, tzinfo=UTC)},
                {"claim_id": "C-2", "service_date": date(2026, 7, 15), "updated_at": datetime(2026, 7, 16, tzinfo=UTC)},
            ]
        return 1

    def fetchone(self):
        return self.result[0] if self.result else None

    def fetchall(self):
        return list(self.result)


class FakeConnection:
    def __init__(self) -> None:
        self.queries = []
        self.events = []

    def cursor(self):
        return FakeCursor(self)

    def begin(self):
        self.events.append("begin")

    def commit(self):
        self.events.append("commit")

    def rollback(self):
        self.events.append("rollback")

    def close(self):
        self.events.append("close")


class SnapshotTests(TestCase):
    def test_snapshot_is_repeatable_read_and_every_corpus_query_is_tenant_scoped(self) -> None:
        connection = FakeConnection()
        snapshot = PyMySqlTenantSnapshotRepository(lambda: connection).load_tenant_snapshot(tenant_id="tenant_alpha")
        self.assertEqual(snapshot.tenant_id, "tenant_alpha")
        self.assertEqual([claim["claim_id"] for claim in snapshot.claims], ["C-1", "C-2"])
        self.assertIn("claims-updated:2026-07-16T00:00:00+00:00:count:2", snapshot.watermark)
        self.assertIn("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", connection.queries[0][0])
        corpus_queries = [query for query, _params in connection.queries if query.startswith("SELECT")]
        self.assertTrue(all("tenant_id = %s" in query for query in corpus_queries))
        self.assertTrue(all(params == ["tenant_alpha"] for query, params in connection.queries if query.startswith("SELECT")))
        self.assertEqual(connection.events, ["begin", "commit", "close"])
