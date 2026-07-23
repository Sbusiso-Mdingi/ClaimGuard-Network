from __future__ import annotations

from dataclasses import replace
from unittest import TestCase
from unittest.mock import patch

from claimguard_report_producer.outbox import OutboxJob
from claimguard_report_producer.model_service import ModelServiceUnavailable
from claimguard_report_producer.snapshot import TenantSnapshot
from claimguard_report_producer.worker import ReportProducerWorker, WorkerConfig


def job(job_id: str = "job-1", tenant_id: str = "tenant_alpha", **overrides) -> OutboxJob:
    value = OutboxJob(
        id=job_id,
        tenant_id=tenant_id,
        job_type="report_production",
        aggregate_type="claim_batch",
        aggregate_id="aggregate-1",
        correlation_id=f"correlation-{job_id}",
        payload={"claims": [{"claim_id": "UNTRUSTED", "tenant_id": "tenant_beta"}]},
        status="processing",
        attempt_count=1,
        max_attempts=3,
    )
    return replace(value, **overrides)


def canonical_report(tenant_id: str) -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": "a" * 64,
            "tenant": {"tenantId": tenant_id, "tenantSlug": None, "displayName": None},
            "generatedAt": "2026-07-16T00:00:00+00:00",
            "snapshotCutoff": "2026-07-16T00:00:00+00:00",
            "source": {"type": "mysql", "watermark": "w1", "historicalWindow": None},
            "includedCounts": {"claims": 0, "providers": 0, "members": 0},
        },
        "summary": {"totalClaims": 0, "totalClaimedAmount": 0},
        "claims": [], "providers": [], "members": [],
        "graph": {"nodes": [], "edges": [], "summary": {}},
        "risk": {}, "history": {},
    }


class FakeRepository:
    def __init__(self, jobs) -> None:
        self.jobs = list(jobs)
        self.lease_calls = 0
        self.completed = []
        self.retried = []
        self.dead = []

    def lease_next_available_jobs(self, **_kwargs):
        self.lease_calls += 1
        result, self.jobs = self.jobs, []
        return result

    def mark_completed_many(self, **kwargs):
        self.completed.append(kwargs)
        return True

    def mark_retry(self, **kwargs):
        self.retried.append(kwargs)
        return True

    def mark_dead_letter(self, **kwargs):
        self.dead.append(kwargs)
        return True


class FakeSnapshots:
    def __init__(self) -> None:
        self.tenant_ids = []

    def load_tenant_snapshot(self, *, tenant_id):
        self.tenant_ids.append(tenant_id)
        return TenantSnapshot(tenant_id, None, None, "deterministic_rules", None, "2026-07-16T00:00:00+00:00", "w1", [], [], [], [])


class FakePublisher:
    def __init__(self, error=None) -> None:
        self.error = error
        self.tenants = []

    def publish(self, _report, *, run_id=None, tenant_id=None):
        if self.error:
            raise self.error
        self.tenants.append(tenant_id)

        class Result:
            version = "a" * 64
            report_path = "report.json"
            metadata_path = "metadata.json"
            latest_pointer_path = "latest.json"

        return Result()


class FakeLogger:
    def emit(self, *_args, **_kwargs):
        pass


def config() -> WorkerConfig:
    return WorkerConfig("worker-test", initial_retry_delay_seconds=5, maximum_retry_delay_seconds=20)


class WorkerTests(TestCase):
    def test_scope_is_revalidated_before_any_job_is_leased(self) -> None:
        repository = FakeRepository([job()])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            snapshot_repository=FakeSnapshots(),
            config=config(),
            logger=FakeLogger(),
            scope_validator=lambda: (_ for _ in ()).throw(RuntimeError("stale generation")),
        )
        with self.assertRaisesRegex(RuntimeError, "stale generation"):
            worker.run_once()
        self.assertEqual(len(repository.jobs), 1)

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_same_tenant_jobs_coalesce_into_one_snapshot_and_publication(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        repository = FakeRepository([job("job-1"), job("job-2")])
        snapshots = FakeSnapshots()
        publisher = FakePublisher()
        worker = ReportProducerWorker(
            repository=repository, publisher=publisher, snapshot_repository=snapshots, config=config(), logger=FakeLogger()
        )
        self.assertEqual(worker.run_once(), 2)
        self.assertEqual(snapshots.tenant_ids, ["tenant_alpha"])
        self.assertEqual(publisher.tenants, ["tenant_alpha"])
        self.assertEqual([item.id for item in repository.completed[0]["jobs"]], ["job-1", "job-2"])
        self.assertEqual(repository.completed[0]["report_id"], "a" * 64)
        self.assertEqual(repository.completed[0]["watermark"], "w1")

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_job_arriving_after_snapshot_lease_remains_pending(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        repository = FakeRepository([job("job-covered")])

        class SnapshotWithArrival(FakeSnapshots):
            def load_tenant_snapshot(self, *, tenant_id):
                repository.jobs.append(job("job-after-watermark"))
                return super().load_tenant_snapshot(tenant_id=tenant_id)

        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            snapshot_repository=SnapshotWithArrival(),
            config=config(),
            logger=FakeLogger(),
        )
        self.assertEqual(worker.run_once(), 1)
        self.assertEqual([item.id for item in repository.completed[0]["jobs"]], ["job-covered"])
        self.assertEqual([item.id for item in repository.jobs], ["job-after-watermark"])

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_different_tenants_are_never_coalesced(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        repository = FakeRepository([job("job-a", "tenant_alpha"), job("job-b", "tenant_beta")])
        snapshots = FakeSnapshots()
        worker = ReportProducerWorker(
            repository=repository, publisher=FakePublisher(), snapshot_repository=snapshots, config=config(), logger=FakeLogger()
        )
        worker.run_once()
        self.assertEqual(snapshots.tenant_ids, ["tenant_alpha", "tenant_beta"])
        self.assertEqual(len(repository.completed), 2)

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_payload_claim_body_is_not_used_for_detection(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        queued = job(payload={"claims": [{"claim_id": "foreign", "tenant_id": "tenant_beta", "amount": 999999}]})
        repository = FakeRepository([queued])
        snapshots = FakeSnapshots()
        worker = ReportProducerWorker(
            repository=repository, publisher=FakePublisher(), snapshot_repository=snapshots, config=config(), logger=FakeLogger()
        )
        worker.run_once()
        snapshot_argument = build_report.call_args.args[0]
        self.assertEqual(snapshot_argument.claims, [])
        self.assertEqual(snapshot_argument.tenant_id, "tenant_alpha")

    def test_malformed_and_unsupported_jobs_are_terminal(self) -> None:
        repository = FakeRepository([
            job("bad-payload", payload={"claims": []}),
            job("bad-type", job_type="unknown"),
        ])
        worker = ReportProducerWorker(
            repository=repository, publisher=FakePublisher(), snapshot_repository=FakeSnapshots(), config=config(), logger=FakeLogger()
        )
        worker.run_once()
        self.assertEqual(
            [item["job"].id for item in repository.dead],
            ["bad-payload", "bad-type"],
        )

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_publication_failure_retries_every_covered_job(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        queued = [job("job-1", attempt_count=2), job("job-2", attempt_count=2)]
        repository = FakeRepository(queued)
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(TimeoutError("storage")),
            snapshot_repository=FakeSnapshots(),
            config=config(),
            logger=FakeLogger(),
        )
        worker.run_once()
        self.assertEqual(
            [item["job"].id for item in repository.retried],
            ["job-1", "job-2"],
        )

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_model_outage_records_typed_failure_and_watermark(self, build_report) -> None:
        build_report.side_effect = ModelServiceUnavailable(
            watermark="snapshot-watermark",
        )
        repository = FakeRepository([job("job-model")])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            snapshot_repository=FakeSnapshots(),
            config=config(),
            logger=FakeLogger(),
        )

        worker.run_once()

        retry = repository.retried[0]
        self.assertEqual(retry["job"].id, "job-model")
        self.assertEqual(retry["failure_code"], "MODEL_SERVICE_UNAVAILABLE")
        self.assertEqual(retry["failed_watermark"], "snapshot-watermark")

    def test_empty_batch_returns_without_snapshot(self) -> None:
        snapshots = FakeSnapshots()
        worker = ReportProducerWorker(
            repository=FakeRepository([]), publisher=FakePublisher(), snapshot_repository=snapshots, config=config(), logger=FakeLogger()
        )
        self.assertEqual(worker.run_once(), 0)
        self.assertEqual(snapshots.tenant_ids, [])

    @patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot")
    def test_scheduled_drain_runs_until_the_outbox_is_empty(self, build_report) -> None:
        build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
        repository = FakeRepository([job("job-1"), job("job-2")])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            snapshot_repository=FakeSnapshots(),
            config=config(),
            logger=FakeLogger(),
        )

        self.assertEqual(worker.run_until_empty(), 2)
        self.assertEqual(repository.lease_calls, 2)
        self.assertEqual(len(repository.completed), 1)

    def test_scheduled_drain_is_bounded(self) -> None:
        class NeverEmptyRepository(FakeRepository):
            def lease_next_available_jobs(self, **_kwargs):
                self.lease_calls += 1
                return [job(f"job-{self.lease_calls}")]

        repository = NeverEmptyRepository([])
        worker = ReportProducerWorker(
            repository=repository,
            publisher=FakePublisher(),
            snapshot_repository=FakeSnapshots(),
            config=replace(config(), maximum_batches_per_run=2),
            logger=FakeLogger(),
        )

        with patch("claimguard_report_producer.worker.build_report_from_tenant_snapshot") as build_report:
            build_report.side_effect = lambda snapshot, **_kwargs: canonical_report(snapshot.tenant_id)
            self.assertEqual(worker.run_until_empty(), 2)
        self.assertEqual(repository.lease_calls, 2)
