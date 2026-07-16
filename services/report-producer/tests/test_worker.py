from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from claimguard_report_producer.cli import main as producer_main
from claimguard_report_producer.outbox import OutboxJob
from claimguard_report_producer.worker import ReportProducerWorker, WorkerConfig


class FakeLogger:
    def __init__(self) -> None:
        self.events: list[str] = []

    def emit(self, _level, event, _job=None, **_details) -> None:
        self.events.append(event)


class FakeRepository:
    def __init__(self, jobs=None) -> None:
        self.jobs = list(jobs or [])
        self.completed: list[OutboxJob] = []
        self.retried: list[tuple[OutboxJob, int, str]] = []
        self.dead_lettered: list[tuple[OutboxJob, str]] = []

    def lease_next_available_jobs(self, **_kwargs):
        jobs, self.jobs = self.jobs, []
        return jobs

    def mark_completed(self, *, job, worker_id):
        self.completed.append(job)
        return worker_id == "worker-test"

    def mark_retry(self, *, job, worker_id, delay_seconds, last_error):
        self.retried.append((job, delay_seconds, last_error))
        return worker_id == "worker-test"

    def mark_dead_letter(self, *, job, worker_id, last_error):
        self.dead_lettered.append((job, last_error))
        return worker_id == "worker-test"


class FakePublisher:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.published: list[tuple[dict[str, object], str | None, str | None]] = []

    def publish(self, report, *, run_id=None, tenant_id=None):
        if self.error:
            raise self.error
        self.published.append((report, run_id, tenant_id))

        class Result:
            version = "worker-v1"
            report_path = "tenant_alpha/versions/report-worker-v1.json"
            metadata_path = "tenant_alpha/metadata.json"
            latest_pointer_path = "tenant_alpha/latest.json"

        return Result()


def job(**overrides) -> OutboxJob:
    values = {
        "id": "job-1",
        "tenant_id": "tenant_alpha",
        "job_type": "report_production",
        "aggregate_type": "claim_batch",
        "aggregate_id": "aggregate-1",
        "correlation_id": "request-1",
        "payload": {
            "dataset_scope": "triggering_claim_batch",
            "claims": [
                {
                    "claim_id": "C-1",
                    "scheme_id": "scheme_a",
                    "member_id": "M-1",
                    "provider_id": "P-1",
                    "service_date": "2026-07-16",
                    "billing_code": "CONSULT",
                    "amount": 100,
                    "tenant_id": "tenant_beta",
                }
            ],
        },
        "status": "processing",
        "attempt_count": 1,
        "max_attempts": 3,
    }
    values.update(overrides)
    return OutboxJob(**values)


def config() -> WorkerConfig:
    return WorkerConfig(
        worker_id="worker-test",
        batch_size=10,
        lease_seconds=60,
        maximum_attempts=5,
        initial_retry_delay_seconds=5,
        maximum_retry_delay_seconds=20,
        poll_seconds=1,
        top_n=10,
    )


class WorkerTests(TestCase):
    @patch("claimguard_report_producer.worker.build_report_from_ingested_claims")
    def test_successful_publication_marks_job_completed(self, build_report) -> None:
        build_report.return_value = {"detection": {}}
        repository = FakeRepository([job()])
        publisher = FakePublisher()
        worker = ReportProducerWorker(
            repository=repository,
            publisher=publisher,
            config=config(),
            logger=FakeLogger(),
        )

        self.assertEqual(worker.run_once(), 1)
        self.assertEqual(len(publisher.published), 1)
        self.assertEqual(repository.completed, [job()])
        self.assertEqual(repository.retried, [])

    @patch("claimguard_report_producer.worker.build_report_from_ingested_claims")
    def test_publication_failure_schedules_bounded_retry(self, build_report) -> None:
        build_report.return_value = {"detection": {}}
        queued_job = job(attempt_count=2)
        repository = FakeRepository([queued_job])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(error=TimeoutError("storage unavailable")),
            config=config(),
            logger=FakeLogger(),
        )

        worker.run_once()

        self.assertEqual(repository.completed, [])
        self.assertEqual(repository.retried, [(queued_job, 10, "RuntimeError")])

    @patch("claimguard_report_producer.worker.build_report_from_ingested_claims")
    def test_exhausted_failure_is_dead_lettered(self, build_report) -> None:
        build_report.return_value = {"detection": {}}
        exhausted_job = job(attempt_count=3, max_attempts=3)
        repository = FakeRepository([exhausted_job])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(error=TimeoutError("storage unavailable")),
            config=config(),
            logger=FakeLogger(),
        )

        worker.run_once()

        self.assertEqual(repository.retried, [])
        self.assertEqual(repository.dead_lettered, [(exhausted_job, "RuntimeError")])

    def test_malformed_and_unsupported_jobs_are_terminal(self) -> None:
        malformed = job(id="job-malformed", payload={"claims": []})
        unsupported = job(id="job-unsupported", job_type="unknown")
        repository = FakeRepository([malformed, unsupported])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            config=config(),
            logger=FakeLogger(),
        )

        worker.run_once()

        self.assertEqual([entry[0].id for entry in repository.dead_lettered], ["job-malformed", "job-unsupported"])
        self.assertEqual(repository.retried, [])

    @patch("claimguard_report_producer.worker.build_report_from_ingested_claims")
    def test_outbox_tenant_overrides_untrusted_payload_tenant(self, build_report) -> None:
        observed_claims: list[dict[str, object]] = []

        def capture(claims):
            observed_claims.extend(claims)
            return {"detection": {}}

        build_report.side_effect = capture
        repository = FakeRepository([job()])
        publisher = FakePublisher()
        worker = ReportProducerWorker(
            repository=repository,
            publisher=publisher,
            config=config(),
            logger=FakeLogger(),
        )

        worker.run_once()

        self.assertEqual(observed_claims[0]["tenant_id"], "tenant_alpha")
        self.assertEqual(publisher.published[0][2], "tenant_alpha")

    def test_one_shot_mode_exits_cleanly_when_no_jobs_exist(self) -> None:
        repository = FakeRepository([])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            config=config(),
            logger=FakeLogger(),
        )
        self.assertEqual(worker.run_once(), 0)

    @patch("claimguard_report_producer.cli.create_worker_from_environment")
    def test_worker_cli_requires_no_claim_input_arguments(self, create_worker) -> None:
        empty_worker = create_worker.return_value
        empty_worker.run_once.return_value = 0

        self.assertEqual(producer_main(["worker", "--once"]), 0)
        empty_worker.run_once.assert_called_once_with()

    def test_declared_runtime_dependencies_are_importable(self) -> None:
        import azure.identity  # noqa: F401
        import azure.storage.blob  # noqa: F401
        import pymysql  # noqa: F401
