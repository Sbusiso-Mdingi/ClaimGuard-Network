from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from .contract import ReportContractError, validate_detection_report
from .data_plane import resolve_worker_data_plane_scope
from .outbox import OutboxJob, PyMySqlOutboxRepository
from .publisher import AzureBlobReportPublisher, FileReportPublisher
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
    maximum_batches_per_run: int = 100
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
            maximum_batches_per_run=_positive_number(
                os.environ.get("REPORT_WORKER_MAX_BATCHES_PER_RUN"), 100
            ),
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
        scope_validator=None,
    ) -> None:
        self.repository = repository
        self.publisher = publisher
        self.snapshot_repository = snapshot_repository
        self.config = config
        self.logger = logger or StructuredWorkerLogger()
        self.scope_validator = scope_validator

    def run_once(self) -> int:
        if self.scope_validator is not None:
            self.scope_validator()
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

    def run_until_empty(self) -> int:
        total_jobs = 0
        for batch_number in range(1, self.config.maximum_batches_per_run + 1):
            processed = self.run_once()
            total_jobs += processed
            if processed == 0:
                self.logger.emit(
                    "info",
                    "outbox_drain_completed",
                    batch_count=batch_number - 1,
                    job_count=total_jobs,
                    worker_id=self.config.worker_id,
                )
                return total_jobs

        self.logger.emit(
            "warning",
            "outbox_drain_limit_reached",
            batch_count=self.config.maximum_batches_per_run,
            job_count=total_jobs,
            worker_id=self.config.worker_id,
        )
        return total_jobs

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
            validate_detection_report(report, expected_tenant_id=job.tenant_id)
            published = self.publisher.publish(
                report,
                run_id=f"outbox-tenant-{job.tenant_id}",
                tenant_id=job.tenant_id,
            )
            if not self.repository.mark_completed_many(
                jobs=jobs,
                worker_id=self.config.worker_id,
                report_id=published.version,
                watermark=snapshot.watermark,
            ):
                raise RuntimeError("An active job lease was lost before coalesced completion could be recorded.")
            for candidate in jobs:
                self.logger.emit(
                    "info",
                    "outbox_job_completed",
                    candidate,
                    covered_report_id=published.version,
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
    organisation_ids = [os.environ.get("REPORT_WORKER_ORGANISATION_ID", "").strip()]
    organisation_ids = [value for value in organisation_ids if value]
    allowed_organisation_ids = frozenset(
        value.strip() for value in os.environ.get("INTERNAL_SERVICE_ORGANISATION_IDS", "").split(",") if value.strip()
    )
    supported_schema_versions = frozenset(
        value.strip()
        for value in os.environ.get("DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS", "10").split(",")
        if value.strip()
    )

    def resolve_scope():
        return resolve_worker_data_plane_scope(
            control_plane_url=os.environ.get("CONTROL_PLANE_MYSQL_URL", ""),
            operational_url=os.environ.get("MYSQL_URL", ""),
            organisation_ids=organisation_ids,
            allowed_organisation_ids=allowed_organisation_ids,
            environment_key=os.environ.get("DATA_PLANE_ENVIRONMENT", "legacy"),
            private_environment_key=os.environ.get("DATA_PLANE_PRIVATE_ENVIRONMENT", "production"),
            supported_schema_versions=supported_schema_versions,
        )

    scope = resolve_scope()

    def validate_scope() -> None:
        current = resolve_scope()
        if (
            current.route_keys != scope.route_keys
            or current.tenant_ids != scope.tenant_ids
            or current.connection_fingerprint != scope.connection_fingerprint
        ):
            raise RuntimeError("The report-worker data-plane route generation changed; restart on the fresh route.")
    print(json.dumps({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": "info",
        "service": "report-producer-worker",
        "event": "data_plane_scope_verified",
        "organisation_id": scope.organisation_ids[0],
        "route_key": scope.route_keys[0],
        "route_type": scope.route_type,
        "schema_version": scope.schema_version,
    }, sort_keys=True))
    repository = PyMySqlOutboxRepository.from_url(scope.operational_url, allowed_tenant_ids=scope.tenant_ids)
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
        scope_validator=validate_scope,
    )
