from __future__ import annotations

from pathlib import Path

from .contract import ReportContractError, validate_detection_report
from .outbox import OutboxContractError, OutboxJob
from .prospective_model_service import (
    ProspectiveModelContractError,
    ProspectiveModelServiceClient,
)
from .prospective_report import build_prospective_detection_report
from .prospective_results import load_or_score_prospective_result
from .prospective_snapshot import ProspectiveBaselineSnapshotRepository
from .worker import (
    ReportProducerWorker,
    SnapshotIdentityError,
    TerminalJobError,
    WorkerConfigurationError,
    create_discovered_workers_from_environment as _create_legacy_discovered_workers,
    create_worker_from_environment as _create_legacy_worker,
)


class ProspectiveAwareReportProducerWorker(ReportProducerWorker):
    """Uses the v3 baseline path only for approved-model jobs."""

    def __init__(self, *args, prospective_client=None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.prospective_client = prospective_client

    def _prospective_client_for(self, job: OutboxJob) -> ProspectiveModelServiceClient:
        if not job.model_deployment_id:
            raise WorkerConfigurationError(
                "Approved-model jobs require a pinned prospective deployment."
            )
        client = self.prospective_client
        if client is None:
            client = ProspectiveModelServiceClient.from_environment()
            self.prospective_client = client
        if client.deployment_id != job.model_deployment_id:
            raise WorkerConfigurationError(
                "The prospective client does not match the job's pinned deployment."
            )
        return client

    def _process_job(self, job: OutboxJob) -> None:
        if job.strategy_type != "approved_model":
            super()._process_job(job)
            return

        try:
            client = self._prospective_client_for(job)
            try:
                snapshot = self.snapshot_repository.load_tenant_snapshot(
                    tenant_id=job.tenant_id,
                    jobs=[job],
                )
            except ValueError as error:
                raise SnapshotIdentityError(str(error)) from error

            self._validate_snapshot(job, snapshot)
            result = load_or_score_prospective_result(
                snapshot=snapshot,
                client=client,
                repository=self.results_repository,
            )
            report = build_prospective_detection_report(
                snapshot,
                result,
                correlation_id=job.correlation_id,
            )
            validate_detection_report(
                report,
                expected_tenant_id=job.tenant_id,
            )
            published = self.publisher.publish(
                report,
                run_id=f"outbox-{job.id}",
                tenant_id=job.tenant_id,
            )
            completed = self.repository.mark_completed_many(
                jobs=[job],
                worker_id=self.config.worker_id,
                report_id=published.version,
                watermark=snapshot.watermark,
            )
            if not completed:
                raise RuntimeError(
                    "The active job lease was lost before completion could be recorded."
                )
            self.logger.emit(
                "info",
                "outbox_job_completed",
                job,
                covered_report_id=published.version,
                covered_watermark=snapshot.watermark,
                report_path=published.report_path,
                model_id=result.model_id,
                model_version=result.model_version,
                analysis_mode=result.analysis_mode,
            )

        except (
            TerminalJobError,
            OutboxContractError,
            ReportContractError,
            ProspectiveModelContractError,
        ) as error:
            self._dead_letter_terminal(job, error)

        except Exception as error:
            self._retry_or_dead_letter(job, error)


def _upgrade_worker(worker: ReportProducerWorker) -> ProspectiveAwareReportProducerWorker:
    allowed_tenants = getattr(
        worker.snapshot_repository,
        "allowed_tenant_ids",
        None,
    )
    snapshot_repository = ProspectiveBaselineSnapshotRepository(
        worker.repository.connection_factory,
        allowed_tenants,
    )
    return ProspectiveAwareReportProducerWorker(
        repository=worker.repository,
        publisher=worker.publisher,
        snapshot_repository=snapshot_repository,
        results_repository=worker.results_repository,
        config=worker.config,
        logger=worker.logger,
        scope_validator=worker.scope_validator,
        model_registry=worker.model_registry,
    )


def create_worker_from_environment(
    *,
    backend: str | None = None,
    output_dir: Path | None = None,
    organisation_id: str | None = None,
) -> ProspectiveAwareReportProducerWorker:
    return _upgrade_worker(
        _create_legacy_worker(
            backend=backend,
            output_dir=output_dir,
            organisation_id=organisation_id,
        )
    )


def create_discovered_workers_from_environment(
    *,
    backend: str | None = None,
    output_dir: Path | None = None,
) -> list[ProspectiveAwareReportProducerWorker]:
    return [
        _upgrade_worker(worker)
        for worker in _create_legacy_discovered_workers(
            backend=backend,
            output_dir=output_dir,
        )
    ]
