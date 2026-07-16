from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .contract import ReportContractError
from .data_plane import resolve_worker_data_plane_scope
from .outbox import OutboxJob, PyMySqlOutboxRepository
from .publisher import AzureBlobReportPublisher, FileReportPublisher
from .runtime import DetectionReportProducer
from .snapshot import PyMySqlTenantSnapshotRepository
from .sources import build_report_from_tenant_snapshot


class TerminalJobError(ValueError):
    pass


class UnsupportedJobTypeError(TerminalJobError):
    pass


class MalformedJobPayloadError(TerminalJobError):
    pass


class InvalidTenantMetadataError(TerminalJobError):
    pass


def _positive_number(value: object, default: int) -> int:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


@dataclass(frozen=True)
class WorkerConfig:
    worker_id: str
    batch_size: int = 10
    lease_seconds: int = 300
    maximum_attempts: int = 5
    initial_retry_delay_seconds: int = 30
    maximum_retry_delay_seconds: int = 900
    poll_seconds: int = 5
    top_n: int = 10

    @classmethod
    def from_environment(cls) -> "WorkerConfig":
        default_worker_id = f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:8]}"
        return cls(
            worker_id=os.environ.get("REPORT_WORKER_ID", default_worker_id),
            batch_size=_positive_number(os.environ.get("REPORT_WORKER_BATCH_SIZE"), 10),
            lease_seconds=_positive_number(os.environ.get("REPORT_WORKER_LEASE_SECONDS"), 300),
            maximum_attempts=_positive_number(os.environ.get("REPORT_WORKER_MAX_ATTEMPTS"), 5),
            initial_retry_delay_seconds=_positive_number(
                os.environ.get("REPORT_WORKER_RETRY_INITIAL_SECONDS"), 30
            ),
            maximum_retry_delay_seconds=_positive_number(
                os.environ.get("REPORT_WORKER_RETRY_MAX_SECONDS"), 900
            ),
            poll_seconds=_positive_number(os.environ.get("REPORT_WORKER_POLL_SECONDS"), 5),
            top_n=_positive_number(os.environ.get("REPORT_TOP_N"), 10),
        )


class StructuredWorkerLogger:
    def emit(self, level: str, event: str, job: OutboxJob | None = None, **details: object) -> None:
        payload: dict[str, object] = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level,
            "service": "report-producer-worker",
            "event": event,
            **details,
        }
        if job is not None:
            payload.update(
                {
                    "job_id": job.id,
                    "correlation_id": job.correlation_id,
                    "tenant_id": job.tenant_id,
                    "job_type": job.job_type,
                    "attempt": job.attempt_count,
                }
            )
        print(json.dumps(payload, sort_keys=True))


class ReportProducerWorker:
    def __init__(
        self,
        *,
        repository,
        publisher,
        snapshot_repository,
        config: WorkerConfig,
        logger: StructuredWorkerLogger | None = None,
    ) -> None:
        self.repository = repository
        self.publisher = publisher
        self.snapshot_repository = snapshot_repository
        self.config = config
        self.logger = logger or StructuredWorkerLogger()

    def run_once(self) -> int:
        jobs = self.repository.lease_next_available_jobs(
            worker_id=self.config.worker_id,
            limit=self.config.batch_size,
            lease_seconds=self.config.lease_seconds,
        )
        self.logger.emit("info", "outbox_batch_leased", job_count=len(jobs), worker_id=self.config.worker_id)
        jobs_by_tenant: dict[str, list[OutboxJob]] = {}
        for job in jobs:
            self.logger.emit("info", "outbox_job_leased", job)
            try:
                self._validate_job(job)
            except TerminalJobError as error:
                self.repository.mark_dead_letter(
                    job=job,
                    worker_id=self.config.worker_id,
                    last_error=type(error).__name__,
                )
                self.logger.emit("error", "outbox_job_dead_lettered", job, error_type=type(error).__name__)
                continue
            jobs_by_tenant.setdefault(job.tenant_id, []).append(job)
        for tenant_jobs in jobs_by_tenant.values():
            self._process_tenant_jobs(tenant_jobs)
        return len(jobs)

    def run_continuously(self) -> None:
        while True:
            processed = self.run_once()
            if processed == 0:
                time.sleep(self.config.poll_seconds)

    def _process_tenant_jobs(self, jobs: list[OutboxJob]) -> None:
        job = jobs[0]
        try:
            for candidate in jobs:
                if candidate.tenant_id != job.tenant_id:
                    raise InvalidTenantMetadataError("A coalesced batch crossed tenant boundaries.")

            snapshot = self.snapshot_repository.load_tenant_snapshot(tenant_id=job.tenant_id)
            correlation_id = ",".join(sorted(candidate.correlation_id for candidate in jobs))
            report = build_report_from_tenant_snapshot(
                snapshot,
                correlation_id=correlation_id,
                top_n=self.config.top_n,
            )

            def detector(_data_dir: Path, _top_n: int) -> dict[str, object]:
                return report

            producer = DetectionReportProducer(
                data_dir=Path("."),
                publisher=self.publisher,
                top_n=self.config.top_n,
                max_retries=0,
                detector=detector,
                tenant_id=job.tenant_id,
            )
            result = producer.run(trigger=f"outbox-tenant-{job.tenant_id}")
            if not self.repository.mark_completed_many(
                jobs=jobs,
                worker_id=self.config.worker_id,
                report_id=result.published.version,
                watermark=snapshot.watermark,
            ):
                raise RuntimeError("An active job lease was lost before coalesced completion could be recorded.")
            for candidate in jobs:
                self.logger.emit(
                    "info",
                    "outbox_job_completed",
                    candidate,
                    covered_report_id=result.published.version,
                    covered_watermark=snapshot.watermark,
                )
        except (TerminalJobError, ReportContractError) as error:
            for candidate in jobs:
                self.repository.mark_dead_letter(
                    job=candidate,
                    worker_id=self.config.worker_id,
                    last_error=type(error).__name__,
                )
                self.logger.emit("error", "outbox_job_dead_lettered", candidate, error_type=type(error).__name__)
        except Exception as error:  # noqa: BLE001
            for candidate in jobs:
                self._retry_or_dead_letter(candidate, error)

    def _retry_or_dead_letter(self, job: OutboxJob, error: Exception) -> None:
        effective_maximum_attempts = min(
            job.max_attempts if job.max_attempts > 0 else self.config.maximum_attempts,
            self.config.maximum_attempts,
        )
        if job.attempt_count >= effective_maximum_attempts:
            self.repository.mark_dead_letter(
                job=job,
                worker_id=self.config.worker_id,
                last_error=type(error).__name__,
            )
            self.logger.emit("error", "outbox_job_dead_lettered", job, error_type=type(error).__name__)
            return

        delay = min(
            self.config.maximum_retry_delay_seconds,
            self.config.initial_retry_delay_seconds * (2 ** min(max(0, job.attempt_count - 1), 20)),
        )
        self.repository.mark_retry(
            job=job,
            worker_id=self.config.worker_id,
            delay_seconds=delay,
            last_error=type(error).__name__,
        )
        self.logger.emit(
            "warning",
            "outbox_job_retry_scheduled",
            job,
            retry_delay_seconds=delay,
            error_type=type(error).__name__,
        )

    @staticmethod
    def _validate_job(job: OutboxJob) -> None:
        if job.job_type != "report_production":
            raise UnsupportedJobTypeError("Unsupported outbox job type.")
        if job.aggregate_type != "claim_batch":
            raise UnsupportedJobTypeError("Unsupported outbox aggregate type.")
        if not job.tenant_id.strip():
            raise InvalidTenantMetadataError("Outbox tenant is required.")
        if not isinstance(job.payload, dict):
            raise MalformedJobPayloadError("Outbox payload must be an object.")
        claims = job.payload.get("claims")
        if not isinstance(claims, list) or not claims:
            raise MalformedJobPayloadError("Outbox payload must contain a non-empty claims list.")
        if not all(isinstance(claim, dict) for claim in claims):
            raise MalformedJobPayloadError("Each claim must be an object.")

        # Payload contents are trigger metadata only. Detection always reloads the tenant snapshot.


def create_worker_from_environment(*, backend: str | None = None, output_dir: Path | None = None) -> ReportProducerWorker:
    database_url = os.environ.get("MYSQL_URL", "")
    organisation_ids = [os.environ.get("REPORT_WORKER_ORGANISATION_ID", "").strip()]
    organisation_ids = [value for value in organisation_ids if value]
    scope = resolve_worker_data_plane_scope(
        control_plane_url=os.environ.get("CONTROL_PLANE_MYSQL_URL", ""),
        operational_url=database_url,
        organisation_ids=organisation_ids,
        environment_key=os.environ.get("DATA_PLANE_ENVIRONMENT", "legacy"),
    )
    print(json.dumps({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": "info",
        "service": "report-producer-worker",
        "event": "data_plane_scope_verified",
        "organisation_id": scope.organisation_ids[0],
        "route_key": scope.route_keys[0],
        "schema_version": scope.schema_version,
    }, sort_keys=True))
    repository = PyMySqlOutboxRepository.from_url(database_url, allowed_tenant_ids=scope.tenant_ids)
    snapshot_repository = PyMySqlTenantSnapshotRepository(repository.connection_factory, scope.tenant_ids)
    resolved_backend = (backend or os.environ.get("REPORT_STORAGE_BACKEND", "file")).lower()
    if resolved_backend == "azure_blob":
        publisher = AzureBlobReportPublisher.from_environment()
    elif resolved_backend == "file":
        publisher = FileReportPublisher(
            output_dir or Path(os.environ.get("REPORT_OUTPUT_DIR", "reports")),
            retention_versions=_positive_number(os.environ.get("REPORT_RETENTION_VERSIONS"), 10),
        )
    else:
        raise ValueError("REPORT_STORAGE_BACKEND must be file or azure_blob.")

    return ReportProducerWorker(
        repository=repository,
        publisher=publisher,
        snapshot_repository=snapshot_repository,
        config=WorkerConfig.from_environment(),
    )
