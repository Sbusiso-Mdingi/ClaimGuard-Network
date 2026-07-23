from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Callable, Mapping
from urllib.parse import parse_qs, unquote, urlparse


CLAIM_PROCESSING_JOB_TYPE = "claim_detection"
CLAIM_PROCESSING_AGGREGATE_TYPE = "claim_batch"
CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION = 2
CLAIM_PROCESSING_DATASET_SCOPE = "triggering_claim_versions"

MAX_LEASE_LIMIT = 100
MAX_LEASE_SECONDS = 86_400
MAX_RETRY_SECONDS = 86_400
MAX_TARGETS_PER_JOB = 10_000

_SUPPORTED_STRATEGIES = frozenset(
    {
        "deterministic_rules",
        "approved_model",
    }
)

_SUPPORTED_STATUSES = frozenset(
    {
        "pending",
        "processing",
        "completed",
        "retry",
        "dead_letter",
    }
)

_DEPLOYMENT_ID_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
)

_SHA256_HEX_PATTERN = re.compile(
    r"^[0-9a-f]{64}$"
)


class OutboxContractError(ValueError):
    code = "OUTBOX_CONTRACT_INVALID"


@dataclass(frozen=True, order=True)
class ClaimVersionTarget:
    claim_id: str
    claim_version: int


@dataclass(frozen=True)
class OutboxJob:
    id: str
    tenant_id: str
    job_type: str
    aggregate_type: str
    aggregate_id: str
    correlation_id: str
    payload: dict[str, object]
    status: str
    attempt_count: int
    max_attempts: int
    detection_strategy_id: int
    strategy_type: str
    model_deployment_id: str | None

    @property
    def targets(
        self,
    ) -> tuple[ClaimVersionTarget, ...]:
        raw_targets = self.payload.get(
            "targets"
        )

        if not isinstance(
            raw_targets,
            list,
        ):
            raise OutboxContractError(
                "Outbox payload targets are unavailable."
            )

        targets: list[
            ClaimVersionTarget
        ] = []

        for raw_target in raw_targets:
            if not isinstance(
                raw_target,
                dict,
            ):
                raise OutboxContractError(
                    "Outbox payload target is invalid."
                )

            targets.append(
                ClaimVersionTarget(
                    claim_id=str(
                        raw_target[
                            "claim_id"
                        ]
                    ),
                    claim_version=int(
                        raw_target[
                            "claim_version"
                        ]
                    ),
                )
            )

        return tuple(
            targets
        )

    @property
    def context_cutoff_at(
        self,
    ) -> str:
        return str(
            self.payload.get(
                "context_cutoff_at"
            )
            or ""
        )


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
        raise OutboxContractError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise OutboxContractError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _optional_text(
    value: object,
    *,
    field: str,
    maximum: int | None = None,
) -> str | None:
    if value is None:
        return None

    rendered = str(
        value
    ).strip()

    if not rendered:
        return None

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise OutboxContractError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _positive_integer(
    value: object,
    *,
    field: str,
    maximum: int = 2_147_483_647,
) -> int:
    if isinstance(
        value,
        bool,
    ):
        raise OutboxContractError(
            f"{field} must be a positive integer."
        )

    try:
        parsed = int(
            value
        )
    except (
        TypeError,
        ValueError,
    ) as error:
        raise OutboxContractError(
            f"{field} must be a positive integer."
        ) from error

    if (
        parsed <= 0
        or parsed > maximum
    ):
        raise OutboxContractError(
            f"{field} must be a positive integer."
        )

    if (
        isinstance(
            value,
            float,
        )
        and not value.is_integer()
    ):
        raise OutboxContractError(
            f"{field} must be a positive integer."
        )

    return parsed


def _non_negative_integer(
    value: object,
    *,
    field: str,
) -> int:
    if isinstance(
        value,
        bool,
    ):
        raise OutboxContractError(
            f"{field} must be a non-negative integer."
        )

    try:
        parsed = int(
            value
        )
    except (
        TypeError,
        ValueError,
    ) as error:
        raise OutboxContractError(
            f"{field} must be a non-negative integer."
        ) from error

    if (
        parsed < 0
        or (
            isinstance(
                value,
                float,
            )
            and not value.is_integer()
        )
    ):
        raise OutboxContractError(
            f"{field} must be a non-negative integer."
        )

    return parsed


def _bounded_positive_integer(
    value: object,
    *,
    default: int,
    maximum: int,
) -> int:
    try:
        parsed = int(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        return default

    if parsed <= 0:
        return default

    return min(
        parsed,
        maximum,
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
            raise OutboxContractError(
                f"{field} is required."
            )

        if re.fullmatch(
            (
                r"\d{4}-\d{2}-\d{2} "
                r"\d{2}:\d{2}:\d{2}"
                r"(?:\.\d{1,6})?"
            ),
            rendered,
        ):
            rendered = (
                rendered.replace(
                    " ",
                    "T",
                )
                + "Z"
            )

        try:
            parsed = datetime.fromisoformat(
                rendered.replace(
                    "Z",
                    "+00:00",
                )
            )
        except ValueError as error:
            raise OutboxContractError(
                f"{field} must be a valid ISO timestamp."
            ) from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    ).isoformat()


def _decode_payload(
    value: object,
) -> dict[str, object]:
    decoded = value

    if isinstance(
        decoded,
        (bytes, bytearray),
    ):
        try:
            decoded = decoded.decode(
                "utf-8"
            )
        except UnicodeDecodeError as error:
            raise OutboxContractError(
                "Outbox payload must be valid UTF-8."
            ) from error

    if isinstance(
        decoded,
        str,
    ):
        try:
            decoded = json.loads(
                decoded
            )
        except json.JSONDecodeError as error:
            raise OutboxContractError(
                "Outbox payload must be valid JSON."
            ) from error

    if not isinstance(
        decoded,
        dict,
    ):
        raise OutboxContractError(
            "Outbox payload must be an object."
        )

    return dict(
        decoded
    )


def _normalise_targets(
    value: object,
) -> list[dict[str, object]]:
    if (
        not isinstance(
            value,
            list,
        )
        or not value
    ):
        raise OutboxContractError(
            "Outbox payload targets must "
            "be a non-empty array."
        )

    if (
        len(value)
        > MAX_TARGETS_PER_JOB
    ):
        raise OutboxContractError(
            "Outbox payload contains too many targets."
        )

    targets: list[
        ClaimVersionTarget
    ] = []

    seen_claim_ids: set[
        str
    ] = set()

    seen_references: set[
        ClaimVersionTarget
    ] = set()

    for index, raw_target in enumerate(
        value
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
            raise OutboxContractError(
                f"Outbox payload targets[{index}] "
                "has an incompatible shape."
            )

        target = ClaimVersionTarget(
            claim_id=_required_text(
                raw_target.get(
                    "claim_id"
                ),
                field=(
                    f"payload.targets[{index}]"
                    ".claim_id"
                ),
                maximum=128,
            ),
            claim_version=_positive_integer(
                raw_target.get(
                    "claim_version"
                ),
                field=(
                    f"payload.targets[{index}]"
                    ".claim_version"
                ),
            ),
        )

        if target in seen_references:
            raise OutboxContractError(
                "Outbox payload contains duplicate "
                f"target {target.claim_id}"
                f"@{target.claim_version}."
            )

        if target.claim_id in seen_claim_ids:
            raise OutboxContractError(
                "Outbox payload contains multiple "
                "versions of claim "
                f"{target.claim_id}."
            )

        seen_references.add(
            target
        )

        seen_claim_ids.add(
            target.claim_id
        )

        targets.append(
            target
        )

    targets.sort()

    return [
        {
            "claim_id":
                target.claim_id,

            "claim_version":
                target.claim_version,
        }
        for target in targets
    ]


def _normalise_payload(
    value: object,
) -> dict[str, object]:
    payload = _decode_payload(
        value
    )

    expected_keys = frozenset(
        {
            "schema_version",
            "dataset_scope",
            "source",
            "context_cutoff_at",
            "targets",
        }
    )

    if (
        frozenset(
            payload
        )
        != expected_keys
    ):
        raise OutboxContractError(
            "Outbox payload has an incompatible schema."
        )

    schema_version = _positive_integer(
        payload.get(
            "schema_version"
        ),
        field=(
            "payload.schema_version"
        ),
    )

    if (
        schema_version
        != CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION
    ):
        raise OutboxContractError(
            "Outbox payload schema version "
            "is unsupported."
        )

    dataset_scope = _required_text(
        payload.get(
            "dataset_scope"
        ),
        field=(
            "payload.dataset_scope"
        ),
        maximum=64,
    )

    if (
        dataset_scope
        != CLAIM_PROCESSING_DATASET_SCOPE
    ):
        raise OutboxContractError(
            "Outbox payload dataset scope "
            "is unsupported."
        )

    return {
        "schema_version":
            schema_version,

        "dataset_scope":
            dataset_scope,

        "source":
            _required_text(
                payload.get(
                    "source"
                ),
                field=(
                    "payload.source"
                ),
                maximum=128,
            ),

        "context_cutoff_at":
            _canonical_timestamp(
                payload.get(
                    "context_cutoff_at"
                ),
                field=(
                    "payload.context_cutoff_at"
                ),
            ),

        "targets":
            _normalise_targets(
                payload.get(
                    "targets"
                )
            ),
    }


def _normalise_strategy(
    row: Mapping[str, object],
) -> tuple[
    int,
    str,
    str | None,
]:
    strategy_id = _positive_integer(
        row.get(
            "detection_strategy_id"
        ),
        field=(
            "detection_strategy_id"
        ),
    )

    strategy_type = _required_text(
        row.get(
            "strategy_type"
        ),
        field=(
            "strategy_type"
        ),
        maximum=64,
    )

    if (
        strategy_type
        not in _SUPPORTED_STRATEGIES
    ):
        raise OutboxContractError(
            "Outbox strategy type is unsupported."
        )

    deployment_id = _optional_text(
        row.get(
            "model_deployment_id"
        ),
        field=(
            "model_deployment_id"
        ),
        maximum=128,
    )

    if (
        strategy_type
        == "approved_model"
    ):
        if (
            deployment_id is None
            or not _DEPLOYMENT_ID_PATTERN.fullmatch(
                deployment_id
            )
        ):
            raise OutboxContractError(
                "Approved-model jobs require "
                "a valid pinned deployment."
            )

    elif deployment_id is not None:
        raise OutboxContractError(
            "Deterministic jobs cannot "
            "pin a model deployment."
        )

    return (
        strategy_id,
        strategy_type,
        deployment_id,
    )


def _map_job(
    row: Mapping[str, object],
) -> OutboxJob:
    job_type = _required_text(
        row.get(
            "job_type"
        ),
        field="job_type",
        maximum=64,
    )

    if (
        job_type
        != CLAIM_PROCESSING_JOB_TYPE
    ):
        raise OutboxContractError(
            "Outbox job type is unsupported."
        )

    aggregate_type = _required_text(
        row.get(
            "aggregate_type"
        ),
        field="aggregate_type",
        maximum=64,
    )

    if (
        aggregate_type
        != CLAIM_PROCESSING_AGGREGATE_TYPE
    ):
        raise OutboxContractError(
            "Outbox aggregate type is unsupported."
        )

    aggregate_id = _required_text(
        row.get(
            "aggregate_id"
        ),
        field="aggregate_id",
        maximum=64,
    )

    if not _SHA256_HEX_PATTERN.fullmatch(
        aggregate_id
    ):
        raise OutboxContractError(
            "Outbox aggregate identifier is invalid."
        )

    status = _required_text(
        row.get(
            "status"
        ),
        field="status",
        maximum=32,
    )

    if (
        status
        not in _SUPPORTED_STATUSES
    ):
        raise OutboxContractError(
            "Outbox status is unsupported."
        )

    attempt_count = _non_negative_integer(
        row.get(
            "attempt_count"
        ),
        field="attempt_count",
    )

    max_attempts = _positive_integer(
        row.get(
            "max_attempts"
        ),
        field="max_attempts",
    )

    if (
        attempt_count
        > max_attempts
    ):
        raise OutboxContractError(
            "Outbox attempt count exceeds "
            "its maximum."
        )

    (
        strategy_id,
        strategy_type,
        deployment_id,
    ) = _normalise_strategy(
        row
    )

    return OutboxJob(
        id=_required_text(
            row.get(
                "id"
            ),
            field="id",
            maximum=64,
        ),

        tenant_id=_required_text(
            row.get(
                "tenant_id"
            ),
            field="tenant_id",
            maximum=64,
        ),

        job_type=job_type,

        aggregate_type=
            aggregate_type,

        aggregate_id=
            aggregate_id,

        correlation_id=
            _required_text(
                row.get(
                    "correlation_id"
                ),
                field=(
                    "correlation_id"
                ),
                maximum=128,
            ),

        payload=_normalise_payload(
            row.get(
                "payload"
            )
        ),

        status=status,

        attempt_count=
            attempt_count,

        max_attempts=
            max_attempts,

        detection_strategy_id=
            strategy_id,

        strategy_type=
            strategy_type,

        model_deployment_id=
            deployment_id,
    )


class PyMySqlOutboxRepository:
    def __init__(
        self,
        connection_factory: Callable[
            [],
            object,
        ],
        allowed_tenant_ids: (
            frozenset[str] | None
        ) = None,
    ) -> None:
        self.connection_factory = (
            connection_factory
        )

        self.allowed_tenant_ids = (
            None
            if allowed_tenant_ids is None
            else frozenset(
                _required_text(
                    tenant_id,
                    field=(
                        "allowed tenant ID"
                    ),
                    maximum=64,
                )
                for tenant_id
                in allowed_tenant_ids
            )
        )

    @classmethod
    def from_url(
        cls,
        database_url: str,
        *,
        allowed_tenant_ids: (
            frozenset[str] | None
        ) = None,
    ) -> "PyMySqlOutboxRepository":
        if not database_url:
            raise ValueError(
                "MYSQL_URL is required "
                "for report worker mode."
            )

        parsed = urlparse(
            database_url
        )

        if parsed.scheme not in {
            "mysql",
            "mysql+pymysql",
        }:
            raise ValueError(
                "MYSQL_URL must use "
                "the mysql scheme."
            )

        if (
            not parsed.hostname
            or not parsed.path.strip(
                "/"
            )
        ):
            raise ValueError(
                "MYSQL_URL must include "
                "a host and database name."
            )

        query = parse_qs(
            parsed.query
        )

        ssl_mode = (
            query.get(
                "ssl-mode"
            )
            or query.get(
                "ssl_mode"
            )
            or [""]
        )[0].lower()

        connect_options: dict[
            str,
            object,
        ] = {
            "host":
                parsed.hostname,

            "port":
                parsed.port or 3306,

            "user":
                unquote(
                    parsed.username
                    or ""
                ),

            "password":
                unquote(
                    parsed.password
                    or ""
                ),

            "database":
                unquote(
                    parsed.path.lstrip(
                        "/"
                    )
                ),

            "charset":
                "utf8mb4",

            "autocommit":
                False,

            "connect_timeout":
                15,

            "read_timeout":
                240,

            "write_timeout":
                240,
        }

        if ssl_mode in {
            "required",
            "verify_ca",
            "verify_identity",
        }:
            connect_options[
                "ssl"
            ] = {
                "check_hostname":
                    ssl_mode
                    == "verify_identity"
            }

        def connection_factory():
            import pymysql

            return pymysql.connect(
                cursorclass=(
                    pymysql.cursors
                    .DictCursor
                ),
                **connect_options,
            )

        return cls(
            connection_factory,
            allowed_tenant_ids,
        )

    def _require_allowed_tenant(
        self,
        tenant_id: str,
    ) -> None:
        if (
            self.allowed_tenant_ids
            is not None
            and tenant_id
            not in self.allowed_tenant_ids
        ):
            raise OutboxContractError(
                "Outbox tenant is outside "
                "the verified data-plane scope."
            )

    def _tenant_filter(
        self,
        *,
        column: str = "tenant_id",
    ) -> tuple[
        str,
        list[object],
    ]:
        if (
            self.allowed_tenant_ids
            is None
        ):
            return "", []

        if not self.allowed_tenant_ids:
            return (
                " AND 1 = 0",
                [],
            )

        tenant_ids = sorted(
            self.allowed_tenant_ids
        )

        placeholders = ", ".join(
            ["%s"] * len(
                tenant_ids
            )
        )

        return (
            f" AND {column} IN "
            f"({placeholders})",

            list(
                tenant_ids
            ),
        )

    def recover_expired_leases(
        self,
        cursor,
    ) -> int:
        (
            tenant_sql,
            tenant_params,
        ) = self._tenant_filter()

        return cursor.execute(
            f"""
                UPDATE claim_processing_outbox
                SET
                  status = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN 'dead_letter'
                    ELSE 'retry'
                  END,

                  available_at =
                    UTC_TIMESTAMP(3),

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error =
                    'Worker lease expired before completion.',

                  failure_code = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN
                      'MAXIMUM_ATTEMPTS_EXHAUSTED'
                    ELSE
                      'WORKER_LEASE_EXPIRED'
                  END,

                  completed_at = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN UTC_TIMESTAMP(3)
                    ELSE NULL
                  END

                WHERE job_type = %s

                  AND aggregate_type = %s

                  AND status =
                    'processing'

                  {tenant_sql}

                  AND lease_expires_at
                    IS NOT NULL

                  AND lease_expires_at
                    <= UTC_TIMESTAMP(3)
            """,
            [
                CLAIM_PROCESSING_JOB_TYPE,
                CLAIM_PROCESSING_AGGREGATE_TYPE,
                *tenant_params,
            ],
        )

    def _dead_letter_exhausted(
        self,
        cursor,
    ) -> int:
        (
            tenant_sql,
            tenant_params,
        ) = self._tenant_filter()

        return cursor.execute(
            f"""
                UPDATE claim_processing_outbox
                SET
                  status = 'dead_letter',

                  completed_at =
                    COALESCE(
                      completed_at,
                      UTC_TIMESTAMP(3)
                    ),

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error =
                    COALESCE(
                      last_error,
                      'Maximum processing attempts exhausted.'
                    ),

                  failure_code =
                    COALESCE(
                      failure_code,
                      'MAXIMUM_ATTEMPTS_EXHAUSTED'
                    )

                WHERE job_type = %s

                  AND aggregate_type = %s

                  {tenant_sql}

                  AND status IN (
                    'pending',
                    'retry'
                  )

                  AND attempt_count
                    >= max_attempts
            """,
            [
                CLAIM_PROCESSING_JOB_TYPE,
                CLAIM_PROCESSING_AGGREGATE_TYPE,
                *tenant_params,
            ],
        )

    @staticmethod
    def _dead_letter_invalid_row(
        cursor,
        *,
        row: Mapping[str, object],
        worker_id: str,
        error: Exception,
    ) -> None:
        cursor.execute(
            """
                UPDATE claim_processing_outbox
                SET
                  status = 'dead_letter',

                  completed_at =
                    UTC_TIMESTAMP(3),

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error = %s,

                  failure_code =
                    'OUTBOX_CONTRACT_INVALID',

                  failed_watermark = NULL

                WHERE id = %s

                  AND status =
                    'processing'

                  AND leased_by = %s
            """,
            [
                str(error)[:255],

                str(
                    row.get(
                        "id"
                    )
                    or ""
                ),

                worker_id,
            ],
        )

    def lease_next_available_jobs(
        self,
        *,
        worker_id: str,
        limit: int,
        lease_seconds: int,
    ) -> list[OutboxJob]:
        canonical_worker_id = (
            _required_text(
                worker_id,
                field="worker_id",
                maximum=128,
            )
        )

        safe_limit = (
            _bounded_positive_integer(
                limit,
                default=10,
                maximum=(
                    MAX_LEASE_LIMIT
                ),
            )
        )

        safe_lease_seconds = (
            _bounded_positive_integer(
                lease_seconds,
                default=300,
                maximum=(
                    MAX_LEASE_SECONDS
                ),
            )
        )

        connection = (
            self.connection_factory()
        )

        try:
            connection.begin()

            with connection.cursor() as cursor:
                self.recover_expired_leases(
                    cursor
                )

                self._dead_letter_exhausted(
                    cursor
                )

                (
                    tenant_sql,
                    tenant_params,
                ) = self._tenant_filter()

                cursor.execute(
                    f"""
                        SELECT id
                        FROM claim_processing_outbox

                        WHERE job_type = %s

                          AND aggregate_type = %s

                          {tenant_sql}

                          AND status IN (
                            'pending',
                            'retry'
                          )

                          AND attempt_count
                            < max_attempts

                          AND available_at
                            <= UTC_TIMESTAMP(3)

                        ORDER BY
                          available_at ASC,
                          created_at ASC,
                          id ASC

                        LIMIT {safe_limit}

                        FOR UPDATE SKIP LOCKED
                    """,
                    [
                        CLAIM_PROCESSING_JOB_TYPE,
                        CLAIM_PROCESSING_AGGREGATE_TYPE,
                        *tenant_params,
                    ],
                )

                ids = [
                    str(
                        row["id"]
                    )
                    for row
                    in cursor.fetchall()
                    if str(
                        row.get(
                            "id"
                        )
                        or ""
                    ).strip()
                ]

                if not ids:
                    connection.commit()
                    return []

                placeholders = ", ".join(
                    ["%s"] * len(ids)
                )

                cursor.execute(
                    f"""
                        UPDATE claim_processing_outbox
                        SET
                          status =
                            'processing',

                          attempt_count =
                            attempt_count + 1,

                          leased_at =
                            UTC_TIMESTAMP(3),

                          lease_expires_at =
                            DATE_ADD(
                              UTC_TIMESTAMP(3),
                              INTERVAL %s SECOND
                            ),

                          leased_by = %s,

                          last_error = NULL,

                          failure_code = NULL,

                          failed_watermark = NULL

                        WHERE id IN (
                          {placeholders}
                        )

                          AND job_type = %s

                          AND aggregate_type = %s

                          AND status IN (
                            'pending',
                            'retry'
                          )

                          AND attempt_count
                            < max_attempts
                    """,
                    [
                        safe_lease_seconds,
                        canonical_worker_id,
                        *ids,
                        CLAIM_PROCESSING_JOB_TYPE,
                        CLAIM_PROCESSING_AGGREGATE_TYPE,
                    ],
                )

                cursor.execute(
                    f"""
                        SELECT *
                        FROM claim_processing_outbox

                        WHERE id IN (
                          {placeholders}
                        )

                          AND job_type = %s

                          AND aggregate_type = %s

                          AND status =
                            'processing'

                          AND leased_by = %s

                        ORDER BY
                          available_at ASC,
                          created_at ASC,
                          id ASC
                    """,
                    [
                        *ids,
                        CLAIM_PROCESSING_JOB_TYPE,
                        CLAIM_PROCESSING_AGGREGATE_TYPE,
                        canonical_worker_id,
                    ],
                )

                jobs: list[
                    OutboxJob
                ] = []

                for row in cursor.fetchall():
                    try:
                        job = _map_job(
                            row
                        )

                        self._require_allowed_tenant(
                            job.tenant_id
                        )

                    except OutboxContractError as error:
                        self._dead_letter_invalid_row(
                            cursor,
                            row=row,
                            worker_id=(
                                canonical_worker_id
                            ),
                            error=error,
                        )

                        continue

                    jobs.append(
                        job
                    )

            connection.commit()

            return jobs

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

    def _transition(
        self,
        *,
        sql: str,
        params: list[object],
    ) -> bool:
        connection = (
            self.connection_factory()
        )

        try:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    sql,
                    params,
                )

            connection.commit()

            return affected == 1

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

    def mark_completed(
        self,
        *,
        job: OutboxJob,
        worker_id: str,
    ) -> bool:
        self._require_allowed_tenant(
            job.tenant_id
        )

        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status = 'completed',

                  completed_at =
                    UTC_TIMESTAMP(3),

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error = NULL,

                  failure_code = NULL,

                  failed_watermark = NULL

                WHERE id = %s

                  AND tenant_id = %s

                  AND job_type = %s

                  AND aggregate_type = %s

                  AND status =
                    'processing'

                  AND leased_by = %s
            """,
            params=[
                job.id,

                job.tenant_id,

                CLAIM_PROCESSING_JOB_TYPE,

                CLAIM_PROCESSING_AGGREGATE_TYPE,

                _required_text(
                    worker_id,
                    field="worker_id",
                    maximum=128,
                ),
            ],
        )

    def mark_completed_many(
        self,
        *,
        jobs: list[OutboxJob],
        worker_id: str,
        report_id: str,
        watermark: str,
    ) -> bool:
        if not jobs:
            return True

        canonical_worker_id = (
            _required_text(
                worker_id,
                field="worker_id",
                maximum=128,
            )
        )

        canonical_report_id = (
            _required_text(
                report_id,
                field="report_id",
                maximum=64,
            )
        )

        canonical_watermark = (
            _required_text(
                watermark,
                field="watermark",
                maximum=255,
            )
        )

        tenant_ids = {
            job.tenant_id
            for job in jobs
        }

        if len(tenant_ids) != 1:
            raise OutboxContractError(
                "Coalesced completion cannot "
                "cross tenant boundaries."
            )

        tenant_id = next(
            iter(
                tenant_ids
            )
        )

        self._require_allowed_tenant(
            tenant_id
        )

        if any(
            (
                job.job_type
                != CLAIM_PROCESSING_JOB_TYPE
            )
            or (
                job.aggregate_type
                != CLAIM_PROCESSING_AGGREGATE_TYPE
            )
            for job in jobs
        ):
            raise OutboxContractError(
                "Coalesced completion contains "
                "an unsupported job."
            )

        connection = (
            self.connection_factory()
        )

        try:
            connection.begin()

            with connection.cursor() as cursor:
                affected = 0

                for job in jobs:
                    affected += cursor.execute(
                        """
                            UPDATE claim_processing_outbox
                            SET
                              status =
                                'completed',

                              completed_at =
                                UTC_TIMESTAMP(3),

                              covered_report_id =
                                %s,

                              covered_watermark =
                                %s,

                              covered_at =
                                UTC_TIMESTAMP(3),

                              leased_at = NULL,

                              lease_expires_at =
                                NULL,

                              leased_by = NULL,

                              last_error = NULL,

                              failure_code = NULL,

                              failed_watermark =
                                NULL

                            WHERE id = %s

                              AND tenant_id = %s

                              AND job_type = %s

                              AND aggregate_type =
                                %s

                              AND status =
                                'processing'

                              AND leased_by = %s
                        """,
                        [
                            canonical_report_id,

                            canonical_watermark,

                            job.id,

                            job.tenant_id,

                            CLAIM_PROCESSING_JOB_TYPE,

                            CLAIM_PROCESSING_AGGREGATE_TYPE,

                            canonical_worker_id,
                        ],
                    )

            if affected != len(
                jobs
            ):
                connection.rollback()
                return False

            connection.commit()

            return True

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

    def mark_retry(
        self,
        *,
        job: OutboxJob,
        worker_id: str,
        delay_seconds: int,
        last_error: str,
        failure_code: str | None = None,
        failed_watermark: str | None = None,
    ) -> bool:
        self._require_allowed_tenant(
            job.tenant_id
        )

        delay = (
            _bounded_positive_integer(
                delay_seconds,
                default=1,
                maximum=(
                    MAX_RETRY_SECONDS
                ),
            )
        )

        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN 'dead_letter'
                    ELSE 'retry'
                  END,

                  available_at = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN available_at
                    ELSE DATE_ADD(
                      UTC_TIMESTAMP(3),
                      INTERVAL %s SECOND
                    )
                  END,

                  completed_at = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN UTC_TIMESTAMP(3)
                    ELSE NULL
                  END,

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error = %s,

                  failure_code = CASE
                    WHEN attempt_count
                      >= max_attempts
                    THEN
                      'MAXIMUM_ATTEMPTS_EXHAUSTED'
                    ELSE %s
                  END,

                  failed_watermark = %s

                WHERE id = %s

                  AND tenant_id = %s

                  AND job_type = %s

                  AND aggregate_type = %s

                  AND status =
                    'processing'

                  AND leased_by = %s
            """,
            params=[
                delay,

                str(
                    last_error
                    or "Retryable producer failure."
                )[:255],

                str(
                    failure_code
                    or "RETRYABLE_PRODUCER_FAILURE"
                )[:64],

                (
                    str(
                        failed_watermark
                    )[:1024]
                    if failed_watermark
                    else None
                ),

                job.id,

                job.tenant_id,

                CLAIM_PROCESSING_JOB_TYPE,

                CLAIM_PROCESSING_AGGREGATE_TYPE,

                _required_text(
                    worker_id,
                    field="worker_id",
                    maximum=128,
                ),
            ],
        )

    def mark_dead_letter(
        self,
        *,
        job: OutboxJob,
        worker_id: str,
        last_error: str,
        failure_code: str | None = None,
        failed_watermark: str | None = None,
    ) -> bool:
        self._require_allowed_tenant(
            job.tenant_id
        )

        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status =
                    'dead_letter',

                  completed_at =
                    UTC_TIMESTAMP(3),

                  leased_at = NULL,

                  lease_expires_at = NULL,

                  leased_by = NULL,

                  last_error = %s,

                  failure_code = %s,

                  failed_watermark = %s

                WHERE id = %s

                  AND tenant_id = %s

                  AND job_type = %s

                  AND aggregate_type = %s

                  AND status =
                    'processing'

                  AND leased_by = %s
            """,
            params=[
                str(
                    last_error
                    or "Terminal producer failure."
                )[:255],

                str(
                    failure_code
                    or "TERMINAL_PRODUCER_FAILURE"
                )[:64],

                (
                    str(
                        failed_watermark
                    )[:1024]
                    if failed_watermark
                    else None
                ),

                job.id,

                job.tenant_id,

                CLAIM_PROCESSING_JOB_TYPE,

                CLAIM_PROCESSING_AGGREGATE_TYPE,

                _required_text(
                    worker_id,
                    field="worker_id",
                    maximum=128,
                ),
            ],
        )
