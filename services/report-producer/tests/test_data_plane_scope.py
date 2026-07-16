import unittest

from claimguard_report_producer.data_plane import DataPlaneRouteError, resolve_worker_data_plane_scope
from claimguard_report_producer.outbox import OutboxJob, PyMySqlOutboxRepository


class DataPlaneScopedOutboxTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
