import unittest

from claimguard_report_producer.outbox import OutboxJob, PyMySqlOutboxRepository


class DataPlaneScopedOutboxTests(unittest.TestCase):
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
