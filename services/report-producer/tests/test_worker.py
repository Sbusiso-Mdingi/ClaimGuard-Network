from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from claimguard_report_producer.contract import (
    ReportContractError,
)
from claimguard_report_producer.model_service import (
    ModelServiceContractError,
    ModelServiceUnavailable,
)
from claimguard_report_producer.outbox import (
    CLAIM_PROCESSING_AGGREGATE_TYPE,
    CLAIM_PROCESSING_DATASET_SCOPE,
    CLAIM_PROCESSING_JOB_TYPE,
    CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
    OutboxJob,
)
from claimguard_report_producer.snapshot import (
    ProspectiveScoringSnapshot,
)
from claimguard_report_producer.worker import (
    ReportProducerWorker,
    WorkerConfig,
)


CUTOFF = "2026-07-23T12:00:00+00:00"
DETERMINISTIC_STRATEGY_ID = 17
APPROVED_MODEL_STRATEGY_ID = 29
APPROVED_DEPLOYMENT_ID = (
    "claimguard-claim-fraud-ensemble:1.1.0"
)


def prospective_payload(
    *,
    targets: list[dict[str, object]] | None = None,
    source: str = "api:test",
    cutoff: str = CUTOFF,
) -> dict[str, object]:
    return {
        "schema_version":
            CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
        "dataset_scope":
            CLAIM_PROCESSING_DATASET_SCOPE,
        "source":
            source,
        "context_cutoff_at":
            cutoff,
        "targets":
            targets
            or [
                {
                    "claim_id": "CLAIM-1",
                    "claim_version": 1,
                }
            ],
    }


def job(
    job_id: str = "job-1",
    tenant_id: str = "tenant_alpha",
    **overrides,
) -> OutboxJob:
    value = OutboxJob(
        id=job_id,
        tenant_id=tenant_id,
        job_type=CLAIM_PROCESSING_JOB_TYPE,
        aggregate_type=(
            CLAIM_PROCESSING_AGGREGATE_TYPE
        ),
        aggregate_id=f"aggregate-{job_id}",
        correlation_id=f"correlation-{job_id}",
        payload=prospective_payload(),
        status="processing",
        attempt_count=1,
        max_attempts=3,
        detection_strategy_id=(
            DETERMINISTIC_STRATEGY_ID
        ),
        strategy_type="deterministic_rules",
        model_deployment_id=None,
    )

    return replace(
        value,
        **overrides,
    )


def snapshot_for(
    queued_job: OutboxJob,
    **overrides,
) -> ProspectiveScoringSnapshot:
    targets = [
        {
            "claim_id":
                str(target["claim_id"]),
            "claim_version":
                int(target["claim_version"]),
            "amount":
                100.0,
            "member_id":
                f"MEMBER-{index + 1}",
            "provider_id":
                f"PROVIDER-{index + 1}",
            "billing_code":
                "GP01",
            "service_date":
                "2026-07-22",
            "received_date":
                "2026-07-22",
        }
        for index, target
        in enumerate(
            queued_job.payload["targets"],
        )
    ]

    context_features = [
        {
            "claim_id":
                target["claim_id"],
            "claim_version":
                target["claim_version"],
            "features": {
                "member_claim_count_365d": 0,
                "provider_claim_count_365d": 0,
                "billing_code_count_365d": 0,
            },
        }
        for target in targets
    ]

    value = ProspectiveScoringSnapshot(
        tenant_id=queued_job.tenant_id,
        tenant_slug=None,
        tenant_display_name=None,
        detection_strategy_id=(
            queued_job.detection_strategy_id
        ),
        detection_strategy=(
            queued_job.strategy_type
        ),
        model_deployment_id=(
            queued_job.model_deployment_id
        ),
        captured_at=str(
            queued_job.payload[
                "context_cutoff_at"
            ]
        ),
        context_cutoff_at=str(
            queued_job.payload[
                "context_cutoff_at"
            ]
        ),
        watermark=f"watermark-{queued_job.id}",
        source_job_ids=(
            queued_job.id,
        ),
        schemes=[],
        members=[],
        providers=[],
        target_claims=targets,
        context_features=context_features,
    )

    return replace(
        value,
        **overrides,
    )


def minimal_report(
    tenant_id: str,
) -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": "a" * 64,
            "tenant": {
                "tenantId": tenant_id,
            },
        },
    }


@contextmanager
def patched_report_pipeline(
    *,
    report: dict[str, object] | None = None,
):
    with (
        patch(
            "claimguard_report_producer.worker."
            "build_report_from_tenant_snapshot"
        ) as build_report,
        patch(
            "claimguard_report_producer.worker."
            "validate_detection_report"
        ) as validate_report,
    ):
        build_report.return_value = (
            report
            or minimal_report(
                "tenant_alpha"
            )
        )

        yield (
            build_report,
            validate_report,
        )


class FakeRepository:
    def __init__(
        self,
        jobs=None,
        *,
        batches=None,
        completion_result: bool = True,
    ) -> None:
        if batches is not None:
            self.batches = [
                list(batch)
                for batch in batches
            ]
        else:
            self.batches = [
                list(jobs or [])
            ]

        self.completion_result = (
            completion_result
        )

        self.lease_calls = []
        self.completed = []
        self.retried = []
        self.dead = []

    def lease_next_available_jobs(
        self,
        **kwargs,
    ):
        self.lease_calls.append(
            kwargs
        )

        if not self.batches:
            return []

        return self.batches.pop(0)

    def mark_completed_many(
        self,
        **kwargs,
    ):
        self.completed.append(
            kwargs
        )

        return self.completion_result

    def mark_retry(
        self,
        **kwargs,
    ):
        self.retried.append(
            kwargs
        )

        return True

    def mark_dead_letter(
        self,
        **kwargs,
    ):
        self.dead.append(
            kwargs
        )

        return True


class FakeSnapshots:
    def __init__(
        self,
        *,
        transform=None,
        error: Exception | None = None,
    ) -> None:
        self.transform = transform
        self.error = error
        self.calls = []

    def load_tenant_snapshot(
        self,
        *,
        tenant_id,
        jobs,
    ):
        self.calls.append(
            {
                "tenant_id":
                    tenant_id,
                "jobs":
                    list(jobs),
            }
        )

        if self.error is not None:
            raise self.error

        if len(jobs) != 1:
            raise AssertionError(
                "Each snapshot must cover "
                "exactly one source job."
            )

        queued_job = jobs[0]

        value = snapshot_for(
            queued_job,
        )

        if self.transform is not None:
            return self.transform(
                value,
                queued_job,
            )

        return value


class FakePublisher:
    def __init__(
        self,
        *,
        error: Exception | None = None,
        errors_by_run_id=None,
    ) -> None:
        self.error = error
        self.errors_by_run_id = dict(
            errors_by_run_id or {}
        )
        self.calls = []

    def publish(
        self,
        report,
        *,
        run_id=None,
        tenant_id=None,
    ):
        self.calls.append(
            {
                "report":
                    report,
                "run_id":
                    run_id,
                "tenant_id":
                    tenant_id,
            }
        )

        selected_error = (
            self.errors_by_run_id.get(
                run_id
            )
            or self.error
        )

        if selected_error is not None:
            raise selected_error

        publication_number = len(
            self.calls
        )

        return SimpleNamespace(
            version=(
                f"{publication_number:064x}"
            ),
            report_path=(
                f"{run_id}/report.json"
            ),
            metadata_path=(
                f"{run_id}/metadata.json"
            ),
            latest_pointer_path=(
                f"{tenant_id}/latest.json"
            ),
        )


class FakeResultsRepository:
    pass


class FakeLogger:
    def __init__(
        self,
    ) -> None:
        self.events = []

    def emit(
        self,
        *args,
        **kwargs,
    ):
        self.events.append(
            {
                "args": args,
                "kwargs": kwargs,
            }
        )


class FakeModelRegistry:
    def __init__(
        self,
        *,
        client=None,
        error: Exception | None = None,
    ) -> None:
        self.client = (
            client
            if client is not None
            else object()
        )
        self.error = error
        self.calls = []

    def client_for(
        self,
        deployment_id,
    ):
        self.calls.append(
            deployment_id
        )

        if self.error is not None:
            raise self.error

        return self.client


def config(
    **overrides,
) -> WorkerConfig:
    value = WorkerConfig(
        worker_id="worker-test",
        initial_retry_delay_seconds=5,
        maximum_retry_delay_seconds=20,
    )

    return replace(
        value,
        **overrides,
    )


def worker_for(
    repository,
    *,
    publisher=None,
    snapshots=None,
    results=None,
    logger=None,
    scope_validator=None,
    model_registry=None,
    worker_config=None,
) -> ReportProducerWorker:
    return ReportProducerWorker(
        repository=repository,
        publisher=(
            publisher
            or FakePublisher()
        ),
        snapshot_repository=(
            snapshots
            or FakeSnapshots()
        ),
        results_repository=(
            results
            or FakeResultsRepository()
        ),
        config=(
            worker_config
            or config()
        ),
        logger=(
            logger
            or FakeLogger()
        ),
        scope_validator=scope_validator,
        model_registry=model_registry,
    )


class WorkerTests(
    TestCase,
):
    def test_scope_is_revalidated_before_any_job_is_leased(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job(),
            ]
        )

        def reject_stale_scope():
            raise RuntimeError(
                "stale generation"
            )

        worker = worker_for(
            repository,
            scope_validator=(
                reject_stale_scope
            ),
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "stale generation",
        ):
            worker.run_once()

        self.assertEqual(
            repository.lease_calls,
            [],
        )

        self.assertEqual(
            len(
                repository.batches[0]
            ),
            1,
        )

    def test_same_tenant_jobs_are_processed_independently(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job("job-1"),
                job(
                    "job-2",
                    payload=prospective_payload(
                        targets=[
                            {
                                "claim_id":
                                    "CLAIM-2",
                                "claim_version":
                                    1,
                            }
                        ]
                    ),
                ),
            ]
        )

        snapshots = FakeSnapshots()
        publisher = FakePublisher()

        worker = worker_for(
            repository,
            publisher=publisher,
            snapshots=snapshots,
        )

        with patched_report_pipeline() as (
            build_report,
            validate_report,
        ):
            self.assertEqual(
                worker.run_once(),
                2,
            )

        self.assertEqual(
            [
                call["jobs"][0].id
                for call in snapshots.calls
            ],
            [
                "job-1",
                "job-2",
            ],
        )

        self.assertEqual(
            [
                call["run_id"]
                for call in publisher.calls
            ],
            [
                "outbox-job-1",
                "outbox-job-2",
            ],
        )

        self.assertEqual(
            len(
                repository.completed
            ),
            2,
        )

        self.assertEqual(
            [
                [
                    queued.id
                    for queued
                    in completion["jobs"]
                ]
                for completion
                in repository.completed
            ],
            [
                [
                    "job-1",
                ],
                [
                    "job-2",
                ],
            ],
        )

        self.assertEqual(
            build_report.call_count,
            2,
        )

        self.assertEqual(
            validate_report.call_count,
            2,
        )

    def test_exact_targets_and_repositories_are_passed_to_report_builder(
        self,
    ) -> None:
        queued = job(
            payload=prospective_payload(
                targets=[
                    {
                        "claim_id": "CLAIM-A",
                        "claim_version": 2,
                    },
                    {
                        "claim_id": "CLAIM-B",
                        "claim_version": 7,
                    },
                ],
                source="service:claims-api",
            )
        )

        repository = FakeRepository(
            [
                queued,
            ]
        )

        snapshots = FakeSnapshots()
        publisher = FakePublisher()
        results = FakeResultsRepository()

        worker = worker_for(
            repository,
            publisher=publisher,
            snapshots=snapshots,
            results=results,
        )

        with patched_report_pipeline() as (
            build_report,
            validate_report,
        ):
            self.assertEqual(
                worker.run_once(),
                1,
            )

        snapshot_argument = (
            build_report
            .call_args
            .args[0]
        )

        self.assertEqual(
            [
                (
                    item["claim_id"],
                    item["claim_version"],
                )
                for item
                in snapshot_argument.target_claims
            ],
            [
                (
                    "CLAIM-A",
                    2,
                ),
                (
                    "CLAIM-B",
                    7,
                ),
            ],
        )

        self.assertEqual(
            snapshot_argument.source_job_ids,
            (
                "job-1",
            ),
        )

        self.assertEqual(
            snapshot_argument.context_cutoff_at,
            CUTOFF,
        )

        self.assertEqual(
            build_report.call_args.kwargs[
                "correlation_id"
            ],
            "correlation-job-1",
        )

        self.assertIs(
            build_report.call_args.kwargs[
                "results_repository"
            ],
            results,
        )

        self.assertIsNone(
            build_report.call_args.kwargs[
                "model_client"
            ]
        )

        validate_report.assert_called_once_with(
            build_report.return_value,
            expected_tenant_id=(
                "tenant_alpha"
            ),
        )

        self.assertEqual(
            publisher.calls[0]["run_id"],
            "outbox-job-1",
        )

        self.assertEqual(
            publisher.calls[0]["tenant_id"],
            "tenant_alpha",
        )

        self.assertEqual(
            repository.completed[0][
                "watermark"
            ],
            "watermark-job-1",
        )

    def test_legacy_malformed_and_invalid_strategy_jobs_are_terminal(
        self,
    ) -> None:
        legacy = job(
            "legacy-job",
            job_type="report_production",
        )

        malformed = job(
            "malformed-job",
            payload={
                "claims": [
                    {
                        "claim_id":
                            "UNTRUSTED",
                    }
                ]
            },
        )

        invalid_strategy = job(
            "invalid-strategy",
            strategy_type=(
                "deterministic_rules"
            ),
            model_deployment_id=(
                APPROVED_DEPLOYMENT_ID
            ),
        )

        repository = FakeRepository(
            [
                legacy,
                malformed,
                invalid_strategy,
            ]
        )

        snapshots = FakeSnapshots()

        worker = worker_for(
            repository,
            snapshots=snapshots,
        )

        self.assertEqual(
            worker.run_once(),
            3,
        )

        self.assertEqual(
            snapshots.calls,
            [],
        )

        self.assertEqual(
            [
                entry["job"].id
                for entry
                in repository.dead
            ],
            [
                "legacy-job",
                "malformed-job",
                "invalid-strategy",
            ],
        )

        self.assertEqual(
            [
                entry["failure_code"]
                for entry
                in repository.dead
            ],
            [
                "UNSUPPORTED_JOB_TYPE",
                "MALFORMED_JOB_PAYLOAD",
                "INVALID_STRATEGY_METADATA",
            ],
        )

        self.assertEqual(
            repository.retried,
            [],
        )

    def test_snapshot_identity_mismatch_is_terminal_before_building_or_publishing(
        self,
    ) -> None:
        snapshots = FakeSnapshots(
            transform=(
                lambda value, _job: replace(
                    value,
                    source_job_ids=(
                        "different-job",
                    ),
                )
            )
        )

        repository = FakeRepository(
            [
                job(),
            ]
        )

        publisher = FakePublisher()

        worker = worker_for(
            repository,
            snapshots=snapshots,
            publisher=publisher,
        )

        with patched_report_pipeline() as (
            build_report,
            _validate_report,
        ):
            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            build_report.call_count,
            0,
        )

        self.assertEqual(
            publisher.calls,
            [],
        )

        self.assertEqual(
            repository.completed,
            [],
        )

        self.assertEqual(
            repository.retried,
            [],
        )

        self.assertEqual(
            repository.dead[0][
                "failure_code"
            ],
            "SNAPSHOT_IDENTITY_INVALID",
        )

    def test_deterministic_strategy_does_not_consult_model_registry(
        self,
    ) -> None:
        registry = FakeModelRegistry(
            error=AssertionError(
                "Registry must not be used."
            )
        )

        repository = FakeRepository(
            [
                job(),
            ]
        )

        worker = worker_for(
            repository,
            model_registry=registry,
        )

        with patched_report_pipeline() as (
            build_report,
            _validate_report,
        ):
            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            registry.calls,
            [],
        )

        self.assertIsNone(
            build_report.call_args.kwargs[
                "model_client"
            ]
        )

        self.assertEqual(
            len(
                repository.completed
            ),
            1,
        )

    def test_approved_model_job_uses_exact_pinned_deployment_client(
        self,
    ) -> None:
        model_client = object()

        registry = FakeModelRegistry(
            client=model_client,
        )

        approved_job = job(
            detection_strategy_id=(
                APPROVED_MODEL_STRATEGY_ID
            ),
            strategy_type="approved_model",
            model_deployment_id=(
                APPROVED_DEPLOYMENT_ID
            ),
        )

        repository = FakeRepository(
            [
                approved_job,
            ]
        )

        worker = worker_for(
            repository,
            model_registry=registry,
        )

        with patched_report_pipeline() as (
            build_report,
            _validate_report,
        ):
            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            registry.calls,
            [
                APPROVED_DEPLOYMENT_ID,
            ],
        )

        self.assertIs(
            build_report.call_args.kwargs[
                "model_client"
            ],
            model_client,
        )

        snapshot_argument = (
            build_report
            .call_args
            .args[0]
        )

        self.assertEqual(
            snapshot_argument
            .detection_strategy_id,
            APPROVED_MODEL_STRATEGY_ID,
        )

        self.assertEqual(
            snapshot_argument
            .model_deployment_id,
            APPROVED_DEPLOYMENT_ID,
        )

    def test_model_contract_failure_is_terminal_with_watermark(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job("job-contract"),
            ]
        )

        worker = worker_for(
            repository,
        )

        with patched_report_pipeline() as (
            build_report,
            validate_report,
        ):
            build_report.side_effect = (
                ModelServiceContractError(
                    "Model response violated contract.",
                    watermark="model-watermark",
                )
            )

            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            validate_report.call_count,
            0,
        )

        self.assertEqual(
            repository.retried,
            [],
        )

        terminal = repository.dead[0]

        self.assertEqual(
            terminal["job"].id,
            "job-contract",
        )

        self.assertEqual(
            terminal["failure_code"],
            "MODEL_SERVICE_CONTRACT_ERROR",
        )

        self.assertEqual(
            terminal["failed_watermark"],
            "model-watermark",
        )

    def test_invalid_generated_report_is_terminal(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job("job-report-contract"),
            ]
        )

        publisher = FakePublisher()

        worker = worker_for(
            repository,
            publisher=publisher,
        )

        with patched_report_pipeline() as (
            _build_report,
            validate_report,
        ):
            validate_report.side_effect = (
                ReportContractError(
                    "Invalid report."
                )
            )

            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            publisher.calls,
            [],
        )

        self.assertEqual(
            repository.retried,
            [],
        )

        self.assertEqual(
            repository.dead[0][
                "failure_code"
            ],
            "ReportContractError",
        )

    def test_model_outage_retries_with_typed_failure_watermark_and_backoff(
        self,
    ) -> None:
        queued = job(
            "job-model",
            attempt_count=2,
            max_attempts=3,
        )

        repository = FakeRepository(
            [
                queued,
            ]
        )

        worker = worker_for(
            repository,
        )

        with patched_report_pipeline() as (
            build_report,
            _validate_report,
        ):
            build_report.side_effect = (
                ModelServiceUnavailable(
                    "Model endpoint timed out.",
                    watermark=(
                        "snapshot-watermark"
                    ),
                )
            )

            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            repository.dead,
            [],
        )

        retry = repository.retried[0]

        self.assertEqual(
            retry["job"].id,
            "job-model",
        )

        self.assertEqual(
            retry["failure_code"],
            "MODEL_SERVICE_UNAVAILABLE",
        )

        self.assertEqual(
            retry["failed_watermark"],
            "snapshot-watermark",
        )

        self.assertEqual(
            retry["delay_seconds"],
            10,
        )

    def test_failure_of_one_job_does_not_block_another_leased_job(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job("job-fails"),
                job(
                    "job-succeeds",
                    payload=prospective_payload(
                        targets=[
                            {
                                "claim_id":
                                    "CLAIM-2",
                                "claim_version":
                                    1,
                            }
                        ]
                    ),
                ),
            ]
        )

        publisher = FakePublisher(
            errors_by_run_id={
                "outbox-job-fails":
                    TimeoutError(
                        "storage timeout"
                    ),
            }
        )

        worker = worker_for(
            repository,
            publisher=publisher,
        )

        with patched_report_pipeline():
            self.assertEqual(
                worker.run_once(),
                2,
            )

        self.assertEqual(
            [
                entry["job"].id
                for entry
                in repository.retried
            ],
            [
                "job-fails",
            ],
        )

        self.assertEqual(
            [
                entry["jobs"][0].id
                for entry
                in repository.completed
            ],
            [
                "job-succeeds",
            ],
        )

        self.assertEqual(
            [
                call["run_id"]
                for call
                in publisher.calls
            ],
            [
                "outbox-job-fails",
                "outbox-job-succeeds",
            ],
        )

    def test_transient_failure_at_attempt_limit_is_dead_lettered(
        self,
    ) -> None:
        queued = job(
            "job-exhausted",
            attempt_count=3,
            max_attempts=3,
        )

        repository = FakeRepository(
            [
                queued,
            ]
        )

        publisher = FakePublisher(
            error=TimeoutError(
                "storage unavailable"
            )
        )

        worker = worker_for(
            repository,
            publisher=publisher,
        )

        with patched_report_pipeline():
            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            repository.retried,
            [],
        )

        self.assertEqual(
            repository.dead[0][
                "job"
            ].id,
            "job-exhausted",
        )

        self.assertEqual(
            repository.dead[0][
                "failure_code"
            ],
            "TimeoutError",
        )

    def test_lost_completion_lease_schedules_retry_after_publication(
        self,
    ) -> None:
        repository = FakeRepository(
            [
                job("job-lease-lost"),
            ],
            completion_result=False,
        )

        publisher = FakePublisher()

        worker = worker_for(
            repository,
            publisher=publisher,
        )

        with patched_report_pipeline():
            self.assertEqual(
                worker.run_once(),
                1,
            )

        self.assertEqual(
            len(
                publisher.calls
            ),
            1,
        )

        self.assertEqual(
            len(
                repository.completed
            ),
            1,
        )

        self.assertEqual(
            len(
                repository.retried
            ),
            1,
        )

        self.assertEqual(
            repository.retried[0][
                "failure_code"
            ],
            "RuntimeError",
        )

        self.assertIn(
            "lease was lost",
            repository.retried[0][
                "last_error"
            ],
        )

    def test_empty_batch_returns_without_loading_snapshot(
        self,
    ) -> None:
        repository = FakeRepository(
            []
        )

        snapshots = FakeSnapshots()

        worker = worker_for(
            repository,
            snapshots=snapshots,
        )

        self.assertEqual(
            worker.run_once(),
            0,
        )

        self.assertEqual(
            snapshots.calls,
            [],
        )

        self.assertEqual(
            len(
                repository.lease_calls
            ),
            1,
        )

    def test_scheduled_drain_runs_until_outbox_is_empty(
        self,
    ) -> None:
        repository = FakeRepository(
            batches=[
                [
                    job("job-1"),
                ],
                [
                    job(
                        "job-2",
                        payload=(
                            prospective_payload(
                                targets=[
                                    {
                                        "claim_id":
                                            "CLAIM-2",
                                        "claim_version":
                                            1,
                                    }
                                ]
                            )
                        ),
                    ),
                ],
                [],
            ]
        )

        worker = worker_for(
            repository,
        )

        with patched_report_pipeline():
            self.assertEqual(
                worker.run_until_empty(),
                2,
            )

        self.assertEqual(
            len(
                repository.lease_calls
            ),
            3,
        )

        self.assertEqual(
            len(
                repository.completed
            ),
            2,
        )

    def test_scheduled_drain_is_bounded(
        self,
    ) -> None:
        class NeverEmptyRepository(
            FakeRepository,
        ):
            def __init__(
                self,
            ) -> None:
                super().__init__(
                    []
                )
                self.counter = 0

            def lease_next_available_jobs(
                self,
                **kwargs,
            ):
                self.lease_calls.append(
                    kwargs
                )

                self.counter += 1

                return [
                    job(
                        f"job-{self.counter}",
                        payload=(
                            prospective_payload(
                                targets=[
                                    {
                                        "claim_id":
                                            (
                                                "CLAIM-"
                                                f"{self.counter}"
                                            ),
                                        "claim_version":
                                            1,
                                    }
                                ]
                            )
                        ),
                    )
                ]

        repository = (
            NeverEmptyRepository()
        )

        worker = worker_for(
            repository,
            worker_config=config(
                maximum_batches_per_run=2,
            ),
        )

        with patched_report_pipeline():
            self.assertEqual(
                worker.run_until_empty(),
                2,
            )

        self.assertEqual(
            len(
                repository.lease_calls
            ),
            2,
        )

        self.assertEqual(
            len(
                repository.completed
            ),
            2,
        )
