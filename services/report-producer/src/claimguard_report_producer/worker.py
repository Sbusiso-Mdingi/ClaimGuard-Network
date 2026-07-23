from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from .contract import (
    ReportContractError,
    validate_detection_report,
)
from .data_plane import (
    discover_active_worker_organisation_ids,
    resolve_worker_data_plane_scope,
)
from .detection_results import (
    PyMySqlDetectionResultsRepository,
)
from .model_registry import (
    ModelDeploymentRegistry,
)
from .model_service import (
    ModelServiceContractError,
    ModelServiceUnavailable,
)
from .outbox import (
    CLAIM_PROCESSING_AGGREGATE_TYPE,
    CLAIM_PROCESSING_DATASET_SCOPE,
    CLAIM_PROCESSING_JOB_TYPE,
    CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
    MAX_TARGETS_PER_JOB,
    OutboxContractError,
    OutboxJob,
    PyMySqlOutboxRepository,
)
from .publisher import (
    AzureBlobReportPublisher,
    FileReportPublisher,
)
from .snapshot import (
    ProspectiveScoringSnapshot,
    PyMySqlTenantSnapshotRepository,
)
from .sources import (
    build_report_from_tenant_snapshot,
)


_SUPPORTED_STRATEGIES = frozenset(
    {
        "deterministic_rules",
        "approved_model",
    }
)

_ACTIVE_JOB_STATUSES = frozenset(
    {
        "processing",
    }
)


class TerminalJobError(ValueError):
    code = "TERMINAL_JOB_ERROR"


class UnsupportedJobTypeError(
    TerminalJobError
):
    code = "UNSUPPORTED_JOB_TYPE"


class MalformedJobPayloadError(
    TerminalJobError
):
    code = "MALFORMED_JOB_PAYLOAD"


class InvalidTenantMetadataError(
    TerminalJobError
):
    code = "INVALID_TENANT_METADATA"


class InvalidStrategyMetadataError(
    TerminalJobError
):
    code = "INVALID_STRATEGY_METADATA"


class SnapshotIdentityError(
    TerminalJobError
):
    code = "SNAPSHOT_IDENTITY_INVALID"


class WorkerConfigurationError(
    ValueError
):
    code = "WORKER_CONFIGURATION_INVALID"


def _required_text(
    value: object,
    *,
    field: str,
    maximum: int | None = None,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise WorkerConfigurationError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise WorkerConfigurationError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _positive_number(
    value: object,
    default: int,
    *,
    maximum: int | None = None,
) -> int:
    try:
        parsed = int(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        parsed = default

    if parsed <= 0:
        parsed = default

    if maximum is not None:
        parsed = min(
            parsed,
            maximum,
        )

    return parsed


def _csv_values(
    value: object,
) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            item.strip()
            for item in str(
                value or ""
            ).split(",")
            if item.strip()
        )
    )


def _canonical_timestamp(
    value: object,
    *,
    field: str,
) -> str:
    if isinstance(
        value,
        datetime,
    ):
        parsed = value

    else:
        rendered = str(
            value or ""
        ).strip()

        if not rendered:
            raise SnapshotIdentityError(
                f"{field} is required."
            )

        if (
            "T" not in rendered
            and " " in rendered
        ):
            rendered = rendered.replace(
                " ",
                "T",
                1,
            )

        try:
            parsed = datetime.fromisoformat(
                rendered.replace(
                    "Z",
                    "+00:00",
                )
            )
        except ValueError as error:
            raise SnapshotIdentityError(
                f"{field} must be "
                "an ISO timestamp."
            ) from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    ).isoformat()


def _failure_code(
    error: Exception,
) -> str:
    code = getattr(
        error,
        "code",
        None,
    )

    return str(
        code
        or type(error).__name__
    )[:64]


def _failed_watermark(
    error: Exception,
) -> str | None:
    value = getattr(
        error,
        "watermark",
        None,
    )

    rendered = str(
        value or ""
    ).strip()

    return (
        rendered[:1024]
        if rendered
        else None
    )


def _job_target_references(
    job: OutboxJob,
) -> tuple[
    tuple[str, int],
    ...,
]:
    raw_targets = job.payload.get(
        "targets"
    )

    if (
        not isinstance(
            raw_targets,
            list,
        )
        or not raw_targets
    ):
        raise MalformedJobPayloadError(
            "Outbox payload must contain "
            "a non-empty targets array."
        )

    if (
        len(raw_targets)
        > MAX_TARGETS_PER_JOB
    ):
        raise MalformedJobPayloadError(
            "Outbox payload contains "
            "too many targets."
        )

    targets: list[
        tuple[str, int]
    ] = []

    seen_claim_ids: set[
        str
    ] = set()

    seen_references: set[
        tuple[str, int]
    ] = set()

    for index, raw_target in enumerate(
        raw_targets
    ):
        if (
            not isinstance(
                raw_target,
                dict,
            )
            or frozenset(
                raw_target
            )
            != {
                "claim_id",
                "claim_version",
            }
        ):
            raise MalformedJobPayloadError(
                f"targets[{index}] has "
                "an incompatible shape."
            )

        claim_id = str(
            raw_target.get(
                "claim_id"
            )
            or ""
        ).strip()

        if not claim_id:
            raise MalformedJobPayloadError(
                f"targets[{index}].claim_id "
                "is required."
            )

        if len(claim_id) > 128:
            raise MalformedJobPayloadError(
                f"targets[{index}].claim_id "
                "is too long."
            )

        claim_version_value = (
            raw_target.get(
                "claim_version"
            )
        )

        if isinstance(
            claim_version_value,
            bool,
        ):
            raise MalformedJobPayloadError(
                f"targets[{index}].claim_version "
                "must be a positive integer."
            )

        try:
            claim_version = int(
                claim_version_value
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise MalformedJobPayloadError(
                f"targets[{index}].claim_version "
                "must be a positive integer."
            ) from error

        if (
            claim_version <= 0
            or (
                isinstance(
                    claim_version_value,
                    float,
                )
                and not claim_version_value
                .is_integer()
            )
        ):
            raise MalformedJobPayloadError(
                f"targets[{index}].claim_version "
                "must be a positive integer."
            )

        reference = (
            claim_id,
            claim_version,
        )

        if reference in seen_references:
            raise MalformedJobPayloadError(
                "Outbox payload contains "
                f"duplicate target "
                f"{claim_id}@{claim_version}."
            )

        if claim_id in seen_claim_ids:
            raise MalformedJobPayloadError(
                "Outbox payload contains "
                "multiple versions of claim "
                f"{claim_id}."
            )

        seen_references.add(
            reference
        )

        seen_claim_ids.add(
            claim_id
        )

        targets.append(
            reference
        )

    return tuple(
        sorted(
            targets
        )
    )


def _snapshot_target_references(
    snapshot: ProspectiveScoringSnapshot,
) -> tuple[
    tuple[str, int],
    ...,
]:
    references: list[
        tuple[str, int]
    ] = []

    seen: set[
        tuple[str, int]
    ] = set()

    for index, claim in enumerate(
        snapshot.target_claims
    ):
        if not isinstance(
            claim,
            dict,
        ):
            raise SnapshotIdentityError(
                f"Snapshot target_claims[{index}] "
                "must be an object."
            )

        claim_id = str(
            claim.get(
                "claim_id"
            )
            or ""
        ).strip()

        try:
            claim_version = int(
                claim.get(
                    "claim_version"
                )
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise SnapshotIdentityError(
                f"Snapshot target_claims[{index}] "
                "has an invalid version."
            ) from error

        if (
            not claim_id
            or claim_version <= 0
        ):
            raise SnapshotIdentityError(
                f"Snapshot target_claims[{index}] "
                "has an invalid identity."
            )

        reference = (
            claim_id,
            claim_version,
        )

        if reference in seen:
            raise SnapshotIdentityError(
                "Snapshot contains duplicate "
                "target claim versions."
            )

        seen.add(
            reference
        )

        references.append(
            reference
        )

    return tuple(
        sorted(
            references
        )
    )


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

    def __post_init__(
        self,
    ) -> None:
        if not str(
            self.worker_id
            or ""
        ).strip():
            raise WorkerConfigurationError(
                "worker_id is required."
            )

        for field_name, value in (
            (
                "batch_size",
                self.batch_size,
            ),
            (
                "maximum_batches_per_run",
                self.maximum_batches_per_run,
            ),
            (
                "lease_seconds",
                self.lease_seconds,
            ),
            (
                "maximum_attempts",
                self.maximum_attempts,
            ),
            (
                "initial_retry_delay_seconds",
                self.initial_retry_delay_seconds,
            ),
            (
                "maximum_retry_delay_seconds",
                self.maximum_retry_delay_seconds,
            ),
            (
                "poll_seconds",
                self.poll_seconds,
            ),
            (
                "top_n",
                self.top_n,
            ),
        ):
            if (
                not isinstance(
                    value,
                    int,
                )
                or isinstance(
                    value,
                    bool,
                )
                or value <= 0
            ):
                raise WorkerConfigurationError(
                    f"{field_name} must be "
                    "a positive integer."
                )

        if self.batch_size > 100:
            raise WorkerConfigurationError(
                "batch_size must not exceed 100."
            )

        if self.lease_seconds > 86_400:
            raise WorkerConfigurationError(
                "lease_seconds must not "
                "exceed 86400."
            )

        if (
            self.initial_retry_delay_seconds
            > self.maximum_retry_delay_seconds
        ):
            raise WorkerConfigurationError(
                "initial_retry_delay_seconds "
                "must not exceed "
                "maximum_retry_delay_seconds."
            )

    @classmethod
    def from_environment(
        cls,
    ) -> "WorkerConfig":
        default_worker_id = (
            f"{socket.gethostname()}-"
            f"{os.getpid()}-"
            f"{uuid4().hex[:8]}"
        )

        return cls(
            worker_id=str(
                os.environ.get(
                    "REPORT_WORKER_ID",
                    default_worker_id,
                )
            ).strip(),

            batch_size=_positive_number(
                os.environ.get(
                    "REPORT_WORKER_BATCH_SIZE"
                ),
                10,
                maximum=100,
            ),

            maximum_batches_per_run=(
                _positive_number(
                    os.environ.get(
                        "REPORT_WORKER_MAX_BATCHES_PER_RUN"
                    ),
                    100,
                )
            ),

            lease_seconds=_positive_number(
                os.environ.get(
                    "REPORT_WORKER_LEASE_SECONDS"
                ),
                300,
                maximum=86_400,
            ),

            maximum_attempts=_positive_number(
                os.environ.get(
                    "REPORT_WORKER_MAX_ATTEMPTS"
                ),
                5,
                maximum=100,
            ),

            initial_retry_delay_seconds=(
                _positive_number(
                    os.environ.get(
                        "REPORT_WORKER_RETRY_INITIAL_SECONDS"
                    ),
                    30,
                    maximum=86_400,
                )
            ),

            maximum_retry_delay_seconds=(
                _positive_number(
                    os.environ.get(
                        "REPORT_WORKER_RETRY_MAX_SECONDS"
                    ),
                    900,
                    maximum=86_400,
                )
            ),

            poll_seconds=_positive_number(
                os.environ.get(
                    "REPORT_WORKER_POLL_SECONDS"
                ),
                5,
                maximum=3_600,
            ),

            top_n=_positive_number(
                os.environ.get(
                    "REPORT_TOP_N"
                ),
                10,
                maximum=10_000,
            ),
        )


class StructuredWorkerLogger:
    def emit(
        self,
        level: str,
        event: str,
        job: OutboxJob | None = None,
        **details: object,
    ) -> None:
        payload: dict[
            str,
            object,
        ] = {
            "timestamp": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(),
            ),

            "level": level,

            "service":
                "report-producer-worker",

            "event": event,

            **details,
        }

        if job is not None:
            payload.update(
                {
                    "job_id":
                        job.id,

                    "correlation_id":
                        job.correlation_id,

                    "tenant_id":
                        job.tenant_id,

                    "job_type":
                        job.job_type,

                    "attempt":
                        job.attempt_count,

                    "maximum_attempts":
                        job.max_attempts,

                    "detection_strategy_id":
                        job.detection_strategy_id,

                    "strategy_type":
                        job.strategy_type,

                    "model_deployment_id":
                        job.model_deployment_id,

                    "target_count":
                        len(
                            job.targets
                        ),

                    "context_cutoff_at":
                        job.context_cutoff_at,
                }
            )

        print(
            json.dumps(
                payload,
                sort_keys=True,
                default=str,
            )
        )


class ReportProducerWorker:
    def __init__(
        self,
        *,
        repository,
        publisher,
        snapshot_repository,
        results_repository,
        config: WorkerConfig,
        logger: (
            StructuredWorkerLogger
            | None
        ) = None,
        scope_validator=None,
        model_registry: (
            ModelDeploymentRegistry
            | None
        ) = None,
    ) -> None:
        if repository is None:
            raise WorkerConfigurationError(
                "repository is required."
            )

        if publisher is None:
            raise WorkerConfigurationError(
                "publisher is required."
            )

        if snapshot_repository is None:
            raise WorkerConfigurationError(
                "snapshot_repository is required."
            )

        if results_repository is None:
            raise WorkerConfigurationError(
                "results_repository is required."
            )

        self.repository = repository

        self.publisher = publisher

        self.snapshot_repository = (
            snapshot_repository
        )

        self.results_repository = (
            results_repository
        )

        self.config = config

        self.logger = (
            logger
            or StructuredWorkerLogger()
        )

        self.scope_validator = (
            scope_validator
        )

        self.model_registry = (
            model_registry
        )

    def run_once(
        self,
    ) -> int:
        if (
            self.scope_validator
            is not None
        ):
            self.scope_validator()

        jobs = (
            self.repository
            .lease_next_available_jobs(
                worker_id=(
                    self.config.worker_id
                ),

                limit=(
                    self.config.batch_size
                ),

                lease_seconds=(
                    self.config.lease_seconds
                ),
            )
        )

        self.logger.emit(
            "info",
            "outbox_batch_leased",
            job_count=len(
                jobs
            ),
            worker_id=(
                self.config.worker_id
            ),
        )

        for job in jobs:
            self.logger.emit(
                "info",
                "outbox_job_leased",
                job,
            )

            try:
                self._validate_job(
                    job
                )

            except (
                TerminalJobError,
                OutboxContractError,
            ) as error:
                self._dead_letter_terminal(
                    job,
                    error,
                )

                continue

            self._process_job(
                job
            )

        return len(
            jobs
        )

    def run_continuously(
        self,
    ) -> None:
        while True:
            processed = self.run_once()

            if processed == 0:
                time.sleep(
                    self.config.poll_seconds
                )

    def run_until_empty(
        self,
    ) -> int:
        total_jobs = 0

        for batch_number in range(
            1,
            (
                self.config
                .maximum_batches_per_run
            )
            + 1,
        ):
            processed = self.run_once()

            total_jobs += processed

            if processed == 0:
                self.logger.emit(
                    "info",
                    "outbox_drain_completed",

                    batch_count=(
                        batch_number - 1
                    ),

                    job_count=(
                        total_jobs
                    ),

                    worker_id=(
                        self.config.worker_id
                    ),
                )

                return total_jobs

        self.logger.emit(
            "warning",
            "outbox_drain_limit_reached",

            batch_count=(
                self.config
                .maximum_batches_per_run
            ),

            job_count=(
                total_jobs
            ),

            worker_id=(
                self.config.worker_id
            ),
        )

        return total_jobs

    def _process_job(
        self,
        job: OutboxJob,
    ) -> None:
        try:
            model_client = (
                self._model_client_for(
                    job
                )
            )

            try:
                snapshot = (
                    self.snapshot_repository
                    .load_tenant_snapshot(
                        tenant_id=(
                            job.tenant_id
                        ),
                        jobs=[
                            job
                        ],
                    )
                )

            except ValueError as error:
                raise SnapshotIdentityError(
                    str(error)
                ) from error

            self._validate_snapshot(
                job,
                snapshot,
            )

            report = (
                build_report_from_tenant_snapshot(
                    snapshot,

                    correlation_id=(
                        job.correlation_id
                    ),

                    top_n=(
                        self.config.top_n
                    ),

                    model_client=(
                        model_client
                    ),

                    results_repository=(
                        self.results_repository
                    ),
                )
            )

            validate_detection_report(
                report,
                expected_tenant_id=(
                    job.tenant_id
                ),
            )

            published = (
                self.publisher.publish(
                    report,

                    run_id=(
                        f"outbox-{job.id}"
                    ),

                    tenant_id=(
                        job.tenant_id
                    ),
                )
            )

            completed = (
                self.repository
                .mark_completed_many(
                    jobs=[
                        job
                    ],

                    worker_id=(
                        self.config.worker_id
                    ),

                    report_id=(
                        published.version
                    ),

                    watermark=(
                        snapshot.watermark
                    ),
                )
            )

            if not completed:
                raise RuntimeError(
                    "The active job lease was "
                    "lost before completion "
                    "could be recorded."
                )

            self.logger.emit(
                "info",
                "outbox_job_completed",
                job,

                covered_report_id=(
                    published.version
                ),

                covered_watermark=(
                    snapshot.watermark
                ),

                report_path=(
                    published.report_path
                ),
            )

        except (
            TerminalJobError,
            OutboxContractError,
            ReportContractError,
            ModelServiceContractError,
        ) as error:
            self._dead_letter_terminal(
                job,
                error,
            )

        except Exception as error:
            self._retry_or_dead_letter(
                job,
                error,
            )

    def _model_client_for(
        self,
        job: OutboxJob,
    ):
        if (
            job.strategy_type
            == "deterministic_rules"
        ):
            return None

        if (
            job.strategy_type
            != "approved_model"
        ):
            raise InvalidStrategyMetadataError(
                "The pinned strategy type "
                "is unsupported."
            )

        if not job.model_deployment_id:
            raise InvalidStrategyMetadataError(
                "The approved model job "
                "has no pinned deployment."
            )

        if self.model_registry is None:
            raise WorkerConfigurationError(
                "A model registry is required "
                "for approved-model jobs."
            )

        return (
            self.model_registry
            .client_for(
                job.model_deployment_id
            )
        )

    @staticmethod
    def _validate_job(
        job: OutboxJob,
    ) -> None:
        if not isinstance(
            job,
            OutboxJob,
        ):
            raise MalformedJobPayloadError(
                "The leased job has "
                "an unsupported representation."
            )

        if (
            job.job_type
            != CLAIM_PROCESSING_JOB_TYPE
        ):
            raise UnsupportedJobTypeError(
                "Unsupported outbox job type."
            )

        if (
            job.aggregate_type
            != CLAIM_PROCESSING_AGGREGATE_TYPE
        ):
            raise UnsupportedJobTypeError(
                "Unsupported outbox "
                "aggregate type."
            )

        if (
            job.status
            not in _ACTIVE_JOB_STATUSES
        ):
            raise UnsupportedJobTypeError(
                "The leased outbox job "
                "is not processing."
            )

        if not str(
            job.id
            or ""
        ).strip():
            raise MalformedJobPayloadError(
                "Outbox job ID is required."
            )

        if not str(
            job.tenant_id
            or ""
        ).strip():
            raise InvalidTenantMetadataError(
                "Outbox tenant is required."
            )

        if not str(
            job.correlation_id
            or ""
        ).strip():
            raise MalformedJobPayloadError(
                "Outbox correlation ID "
                "is required."
            )

        if (
            not isinstance(
                job.detection_strategy_id,
                int,
            )
            or isinstance(
                job.detection_strategy_id,
                bool,
            )
            or job.detection_strategy_id
            <= 0
        ):
            raise InvalidStrategyMetadataError(
                "Outbox detection strategy ID "
                "is invalid."
            )

        if (
            job.strategy_type
            not in _SUPPORTED_STRATEGIES
        ):
            raise InvalidStrategyMetadataError(
                "Outbox strategy type "
                "is unsupported."
            )

        if (
            job.strategy_type
            == "approved_model"
            and not str(
                job.model_deployment_id
                or ""
            ).strip()
        ):
            raise InvalidStrategyMetadataError(
                "Approved-model jobs require "
                "a pinned deployment."
            )

        if (
            job.strategy_type
            == "deterministic_rules"
            and job.model_deployment_id
            is not None
        ):
            raise InvalidStrategyMetadataError(
                "Deterministic jobs cannot "
                "pin a model deployment."
            )

        if not isinstance(
            job.payload,
            dict,
        ):
            raise MalformedJobPayloadError(
                "Outbox payload must be "
                "an object."
            )

        expected_payload_keys = (
            frozenset(
                {
                    "schema_version",
                    "dataset_scope",
                    "source",
                    "context_cutoff_at",
                    "targets",
                }
            )
        )

        if (
            frozenset(
                job.payload
            )
            != expected_payload_keys
        ):
            raise MalformedJobPayloadError(
                "Outbox payload has "
                "an incompatible schema."
            )

        if (
            job.payload.get(
                "schema_version"
            )
            != (
                CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION
            )
        ):
            raise MalformedJobPayloadError(
                "Outbox payload schema "
                "version is unsupported."
            )

        if (
            job.payload.get(
                "dataset_scope"
            )
            != (
                CLAIM_PROCESSING_DATASET_SCOPE
            )
        ):
            raise MalformedJobPayloadError(
                "Outbox payload dataset "
                "scope is unsupported."
            )

        if not str(
            job.payload.get(
                "source"
            )
            or ""
        ).strip():
            raise MalformedJobPayloadError(
                "Outbox payload source "
                "is required."
            )

        _canonical_timestamp(
            job.payload.get(
                "context_cutoff_at"
            ),
            field=(
                "payload.context_cutoff_at"
            ),
        )

        _job_target_references(
            job
        )

    @staticmethod
    def _validate_snapshot(
        job: OutboxJob,
        snapshot: ProspectiveScoringSnapshot,
    ) -> None:
        if not isinstance(
            snapshot,
            ProspectiveScoringSnapshot,
        ):
            raise SnapshotIdentityError(
                "Snapshot repository returned "
                "an unsupported representation."
            )

        if (
            snapshot.tenant_id
            != job.tenant_id
        ):
            raise SnapshotIdentityError(
                "Snapshot tenant does not "
                "match the outbox job."
            )

        if (
            snapshot.detection_strategy_id
            != job.detection_strategy_id
        ):
            raise SnapshotIdentityError(
                "Snapshot strategy ID does not "
                "match the pinned job."
            )

        if (
            snapshot.detection_strategy
            != job.strategy_type
        ):
            raise SnapshotIdentityError(
                "Snapshot strategy type does not "
                "match the pinned job."
            )

        if (
            snapshot.model_deployment_id
            != job.model_deployment_id
        ):
            raise SnapshotIdentityError(
                "Snapshot model deployment does "
                "not match the pinned job."
            )

        if (
            snapshot.source_job_ids
            != (
                job.id,
            )
        ):
            raise SnapshotIdentityError(
                "Snapshot source-job identity "
                "does not match the outbox job."
            )

        job_cutoff = _canonical_timestamp(
            job.payload.get(
                "context_cutoff_at"
            ),
            field=(
                "payload.context_cutoff_at"
            ),
        )

        snapshot_cutoff = (
            _canonical_timestamp(
                snapshot.context_cutoff_at,
                field=(
                    "snapshot.context_cutoff_at"
                ),
            )
        )

        if (
            snapshot_cutoff
            != job_cutoff
        ):
            raise SnapshotIdentityError(
                "Snapshot context cutoff does not "
                "match the pinned outbox job."
            )

        job_targets = (
            _job_target_references(
                job
            )
        )

        snapshot_targets = (
            _snapshot_target_references(
                snapshot
            )
        )

        if (
            snapshot_targets
            != job_targets
        ):
            raise SnapshotIdentityError(
                "Snapshot target claim versions "
                "do not match the outbox job."
            )

        context_references: list[
            tuple[str, int]
        ] = []

        for index, entry in enumerate(
            snapshot.context_features
        ):
            if not isinstance(
                entry,
                dict,
            ):
                raise SnapshotIdentityError(
                    f"Snapshot context_features"
                    f"[{index}] must be an object."
                )

            try:
                reference = (
                    str(
                        entry[
                            "claim_id"
                        ]
                    ),

                    int(
                        entry[
                            "claim_version"
                        ]
                    ),
                )

            except (
                KeyError,
                TypeError,
                ValueError,
            ) as error:
                raise SnapshotIdentityError(
                    f"Snapshot context_features"
                    f"[{index}] has an invalid "
                    "target identity."
                ) from error

            if not isinstance(
                entry.get(
                    "features"
                ),
                dict,
            ):
                raise SnapshotIdentityError(
                    f"Snapshot context_features"
                    f"[{index}].features must "
                    "be an object."
                )

            context_references.append(
                reference
            )

        if (
            tuple(
                sorted(
                    context_references
                )
            )
            != job_targets
        ):
            raise SnapshotIdentityError(
                "Snapshot context-feature coverage "
                "does not match the target set."
            )

    def _dead_letter_terminal(
        self,
        job: OutboxJob,
        error: Exception,
    ) -> None:
        failure_code = _failure_code(
            error
        )

        failed_watermark = (
            _failed_watermark(
                error
            )
        )

        transitioned = (
            self.repository
            .mark_dead_letter(
                job=job,

                worker_id=(
                    self.config.worker_id
                ),

                last_error=str(
                    error
                )[:255],

                failure_code=(
                    failure_code
                ),

                failed_watermark=(
                    failed_watermark
                ),
            )
        )

        if transitioned:
            self.logger.emit(
                "error",
                "outbox_job_dead_lettered",
                job,

                error_type=(
                    type(error).__name__
                ),

                failure_code=(
                    failure_code
                ),

                failed_watermark=(
                    failed_watermark
                ),

                terminal=True,
            )

        else:
            self.logger.emit(
                "error",
                "outbox_job_terminal_transition_lost",
                job,

                error_type=(
                    type(error).__name__
                ),

                failure_code=(
                    failure_code
                ),
            )

    def _retry_or_dead_letter(
        self,
        job: OutboxJob,
        error: Exception,
    ) -> None:
        failure_code = _failure_code(
            error
        )

        failed_watermark = (
            _failed_watermark(
                error
            )
        )

        effective_maximum_attempts = min(
            (
                job.max_attempts
                if job.max_attempts > 0
                else (
                    self.config
                    .maximum_attempts
                )
            ),
            (
                self.config
                .maximum_attempts
            ),
        )

        if (
            job.attempt_count
            >= effective_maximum_attempts
        ):
            transitioned = (
                self.repository
                .mark_dead_letter(
                    job=job,

                    worker_id=(
                        self.config.worker_id
                    ),

                    last_error=str(
                        error
                    )[:255],

                    failure_code=(
                        failure_code
                    ),

                    failed_watermark=(
                        failed_watermark
                    ),
                )
            )

            self.logger.emit(
                (
                    "error"
                    if transitioned
                    else "warning"
                ),

                (
                    "outbox_job_dead_lettered"
                    if transitioned
                    else (
                        "outbox_job_dead_letter_"
                        "transition_lost"
                    )
                ),

                job,

                error_type=(
                    type(error).__name__
                ),

                failure_code=(
                    failure_code
                ),

                failed_watermark=(
                    failed_watermark
                ),

                terminal=False,
            )

            return

        exponent = min(
            max(
                0,
                job.attempt_count - 1,
            ),
            20,
        )

        delay = min(
            (
                self.config
                .maximum_retry_delay_seconds
            ),

            (
                self.config
                .initial_retry_delay_seconds
                * (
                    2 ** exponent
                )
            ),
        )

        transitioned = (
            self.repository
            .mark_retry(
                job=job,

                worker_id=(
                    self.config.worker_id
                ),

                delay_seconds=(
                    delay
                ),

                last_error=str(
                    error
                )[:255],

                failure_code=(
                    failure_code
                ),

                failed_watermark=(
                    failed_watermark
                ),
            )
        )

        self.logger.emit(
            (
                "warning"
                if transitioned
                else "error"
            ),

            (
                "outbox_job_retry_scheduled"
                if transitioned
                else (
                    "outbox_job_retry_"
                    "transition_lost"
                )
            ),

            job,

            retry_delay_seconds=(
                delay
            ),

            error_type=(
                type(error).__name__
            ),

            failure_code=(
                failure_code
            ),

            failed_watermark=(
                failed_watermark
            ),
        )


def create_worker_from_environment(
    *,
    backend: str | None = None,
    output_dir: Path | None = None,
    organisation_id: str | None = None,
) -> ReportProducerWorker:
    selected_organisation_id = str(
        organisation_id
        or os.environ.get(
            "REPORT_WORKER_ORGANISATION_ID",
            "",
        )
    ).strip()

    organisation_ids = (
        [selected_organisation_id]
        if selected_organisation_id
        else []
    )

    allowed_organisation_ids = (
        frozenset(
            _csv_values(
                os.environ.get(
                    "INTERNAL_SERVICE_ORGANISATION_IDS",
                    "",
                )
            )
        )
    )

    supported_schema_versions = (
        frozenset(
            _csv_values(
                os.environ.get(
                    "DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS",
                    "14",
                )
            )
        )
    )

    if not supported_schema_versions:
        raise WorkerConfigurationError(
            "At least one supported "
            "data-plane schema version "
            "is required."
        )

    def resolve_scope():
        return (
            resolve_worker_data_plane_scope(
                control_plane_url=(
                    os.environ.get(
                        "CONTROL_PLANE_MYSQL_URL",
                        "",
                    )
                ),

                operational_url=(
                    os.environ.get(
                        "MYSQL_URL",
                        "",
                    )
                ),

                organisation_ids=(
                    organisation_ids
                ),

                allowed_organisation_ids=(
                    allowed_organisation_ids
                ),

                environment_key=(
                    os.environ.get(
                        "DATA_PLANE_ENVIRONMENT",
                        "legacy",
                    )
                ),

                private_environment_key=(
                    os.environ.get(
                        "DATA_PLANE_PRIVATE_ENVIRONMENT",
                        "production",
                    )
                ),

                supported_schema_versions=(
                    supported_schema_versions
                ),
            )
        )

    scope = resolve_scope()

    def validate_scope() -> None:
        current = resolve_scope()

        if (
            current.route_keys
            != scope.route_keys
            or current.tenant_ids
            != scope.tenant_ids
            or current.connection_fingerprint
            != scope.connection_fingerprint
            or current.schema_version
            != scope.schema_version
        ):
            raise RuntimeError(
                "The report-worker data-plane "
                "route generation changed; "
                "restart on the fresh route."
            )

    logger = StructuredWorkerLogger()

    logger.emit(
        "info",
        "data_plane_scope_verified",

        organisation_id=(
            scope.organisation_ids[0]
        ),

        route_key=(
            scope.route_keys[0]
        ),

        route_type=(
            scope.route_type
        ),

        schema_version=(
            scope.schema_version
        ),

        tenant_count=len(
            scope.tenant_ids
        ),
    )

    repository = (
        PyMySqlOutboxRepository.from_url(
            scope.operational_url,

            allowed_tenant_ids=(
                scope.tenant_ids
            ),
        )
    )

    snapshot_repository = (
        PyMySqlTenantSnapshotRepository(
            repository.connection_factory,
            scope.tenant_ids,
        )
    )

    results_repository = (
        PyMySqlDetectionResultsRepository(
            repository.connection_factory,
            scope.tenant_ids,
        )
    )

    resolved_backend = str(
        backend
        or os.environ.get(
            "REPORT_STORAGE_BACKEND",
            "file",
        )
    ).strip().lower()

    if (
        resolved_backend
        == "azure_blob"
    ):
        publisher = (
            AzureBlobReportPublisher
            .from_environment()
        )

    elif (
        resolved_backend
        == "file"
    ):
        publisher = FileReportPublisher(
            output_dir
            or Path(
                os.environ.get(
                    "REPORT_OUTPUT_DIR",
                    "reports",
                )
            ),

            retention_versions=(
                _positive_number(
                    os.environ.get(
                        "REPORT_RETENTION_VERSIONS"
                    ),
                    10,
                    maximum=10_000,
                )
            ),
        )

    else:
        raise WorkerConfigurationError(
            "REPORT_STORAGE_BACKEND must "
            "be file or azure_blob."
        )

    return ReportProducerWorker(
        repository=repository,

        publisher=publisher,

        snapshot_repository=(
            snapshot_repository
        ),

        results_repository=(
            results_repository
        ),

        config=(
            WorkerConfig
            .from_environment()
        ),

        logger=logger,

        scope_validator=(
            validate_scope
        ),

        model_registry=(
            ModelDeploymentRegistry()
        ),
    )


def create_discovered_workers_from_environment(
    *,
    backend: str | None = None,
    output_dir: Path | None = None,
) -> list[
    ReportProducerWorker
]:
    supported_schema_versions = (
        frozenset(
            _csv_values(
                os.environ.get(
                    "DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS",
                    "14",
                )
            )
        )
    )

    if not supported_schema_versions:
        raise WorkerConfigurationError(
            "At least one supported "
            "data-plane schema version "
            "is required."
        )

    organisation_ids = (
        discover_active_worker_organisation_ids(
            control_plane_url=(
                os.environ.get(
                    "CONTROL_PLANE_MYSQL_URL",
                    "",
                )
            ),

            supported_schema_versions=(
                supported_schema_versions
            ),
        )
    )

    if not organisation_ids:
        StructuredWorkerLogger().emit(
            "info",
            "no_active_worker_organisations",
        )

        return []

    previous_allowlist = (
        os.environ.get(
            "INTERNAL_SERVICE_ORGANISATION_IDS"
        )
    )

    os.environ[
        "INTERNAL_SERVICE_ORGANISATION_IDS"
    ] = ",".join(
        organisation_ids
    )

    try:
        return [
            create_worker_from_environment(
                backend=backend,

                output_dir=(
                    output_dir
                ),

                organisation_id=(
                    current_id
                ),
            )
            for current_id
            in organisation_ids
        ]

    finally:
        if previous_allowlist is None:
            os.environ.pop(
                "INTERNAL_SERVICE_ORGANISATION_IDS",
                None,
            )

        else:
            os.environ[
                "INTERNAL_SERVICE_ORGANISATION_IDS"
            ] = previous_allowlist
