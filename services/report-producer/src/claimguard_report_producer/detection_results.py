from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from typing import Any, Callable, Iterable, Mapping, Sequence

from .contract import ReportContractError


RESULT_PAYLOAD_SCHEMA_VERSION = "claimguard.claim-detection-result.v1"
MAX_RESULTS_PER_WRITE = 10_000

_STRATEGIES = {
    "deterministic_rules",
    "approved_model",
}

_DEPLOYMENT_ID = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
)

_SHA256 = re.compile(
    r"^[0-9a-f]{64}$"
)


class DetectionResultContractError(
    ReportContractError
):
    code = "DETECTION_RESULT_CONTRACT_INVALID"


class DetectionResultConflictError(
    ReportContractError
):
    code = "DETECTION_RESULT_IMMUTABILITY_CONFLICT"


class DetectionResultIntegrityError(
    ReportContractError
):
    code = "DETECTION_RESULT_INTEGRITY_ERROR"


@dataclass(frozen=True)
class StoredDetectionResult:
    tenant_id: str
    claim_id: str
    claim_version: int

    detection_strategy_id: int
    strategy_type: str
    model_deployment_id: str | None

    source_job_id: str
    request_id: str
    analysis_mode: str

    ensemble_id: str | None
    ensemble_version: str | None
    feature_schema_version: str | None

    scored_at: object

    result_payload: dict[str, object]
    result_hash: str

    def as_dict(
        self,
    ) -> dict[str, object]:
        return asdict(self)


def _text(
    value: object,
    field: str,
    maximum: int | None = None,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise DetectionResultContractError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise DetectionResultContractError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _optional_text(
    value: object,
    field: str,
    maximum: int,
) -> str | None:
    if (
        value is None
        or not str(value).strip()
    ):
        return None

    return _text(
        value,
        field,
        maximum,
    )


def _positive_int(
    value: object,
    field: str,
) -> int:
    if isinstance(
        value,
        bool,
    ):
        raise DetectionResultContractError(
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
        raise DetectionResultContractError(
            f"{field} must be a positive integer."
        ) from error

    if (
        parsed <= 0
        or parsed > 2_147_483_647
    ):
        raise DetectionResultContractError(
            f"{field} must be a positive integer."
        )

    if (
        isinstance(
            value,
            float,
        )
        and not value.is_integer()
    ):
        raise DetectionResultContractError(
            f"{field} must be a positive integer."
        )

    return parsed


def _probability(
    value: object,
    field: str,
) -> float:
    if isinstance(
        value,
        bool,
    ):
        raise DetectionResultContractError(
            f"{field} must be a probability."
        )

    try:
        parsed = float(
            value
        )

    except (
        TypeError,
        ValueError,
    ) as error:
        raise DetectionResultContractError(
            f"{field} must be a probability."
        ) from error

    if (
        not math.isfinite(parsed)
        or not 0 <= parsed <= 1
    ):
        raise DetectionResultContractError(
            f"{field} must be a probability."
        )

    return parsed


def _boolean(
    value: object,
    field: str,
) -> bool:
    if not isinstance(
        value,
        bool,
    ):
        raise DetectionResultContractError(
            f"{field} must be a boolean."
        )

    return value


def _json_default(
    value: object,
) -> object:
    if isinstance(
        value,
        datetime,
    ):
        parsed = (
            value
            if value.tzinfo
            else value.replace(
                tzinfo=UTC
            )
        )

        return parsed.astimezone(
            UTC
        ).isoformat()

    if isinstance(
        value,
        date,
    ):
        return value.isoformat()

    raise TypeError(
        f"{type(value).__name__} "
        "is not JSON serialisable."
    )


def _canonical_json(
    value: object,
    field: str,
) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(
                ",",
                ":",
            ),
            ensure_ascii=False,
            allow_nan=False,
            default=_json_default,
        )

    except (
        TypeError,
        ValueError,
    ) as error:
        raise DetectionResultContractError(
            f"{field} must be finite JSON."
        ) from error


def _decode_payload(
    value: object,
) -> dict[str, object]:
    decoded = value

    if isinstance(
        decoded,
        (
            bytes,
            bytearray,
        ),
    ):
        try:
            decoded = decoded.decode(
                "utf-8"
            )

        except UnicodeDecodeError as error:
            raise DetectionResultIntegrityError(
                "Stored result payload is not UTF-8."
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
            raise DetectionResultIntegrityError(
                "Stored result payload is not JSON."
            ) from error

    if not isinstance(
        decoded,
        dict,
    ):
        raise DetectionResultIntegrityError(
            "Stored result payload must be an object."
        )

    _canonical_json(
        decoded,
        "stored result payload",
    )

    return dict(
        decoded
    )


def _strategy_metadata(
    raw: Mapping[
        str,
        object,
    ],
) -> tuple[
    int,
    str,
    str | None,
    str | None,
    str | None,
    str | None,
]:
    strategy_id = _positive_int(
        raw.get(
            "detection_strategy_id"
        ),
        "detection_strategy_id",
    )

    strategy = _text(
        raw.get(
            "strategy_type"
        ),
        "strategy_type",
        64,
    )

    if strategy not in _STRATEGIES:
        raise DetectionResultContractError(
            "strategy_type is unsupported."
        )

    deployment = _optional_text(
        raw.get(
            "model_deployment_id"
        ),
        "model_deployment_id",
        128,
    )

    ensemble_id = _optional_text(
        raw.get(
            "ensemble_id"
        ),
        "ensemble_id",
        128,
    )

    ensemble_version = _optional_text(
        raw.get(
            "ensemble_version"
        ),
        "ensemble_version",
        64,
    )

    feature_schema = _optional_text(
        raw.get(
            "feature_schema_version"
        ),
        "feature_schema_version",
        128,
    )

    if strategy == "approved_model":
        if (
            deployment is None
            or not _DEPLOYMENT_ID.fullmatch(
                deployment
            )
        ):
            raise DetectionResultContractError(
                "approved_model requires "
                "a valid deployment."
            )

        if (
            not ensemble_id
            or not ensemble_version
            or not feature_schema
        ):
            raise DetectionResultContractError(
                "approved_model requires ensemble "
                "and feature-schema metadata."
            )

    elif any(
        value is not None
        for value in (
            deployment,
            ensemble_id,
            ensemble_version,
            feature_schema,
        )
    ):
        raise DetectionResultContractError(
            "deterministic_rules cannot contain "
            "model metadata."
        )

    return (
        strategy_id,
        strategy,
        deployment,
        ensemble_id,
        ensemble_version,
        feature_schema,
    )


def _normalise_record(
    raw: Mapping[
        str,
        object,
    ],
    index: int,
) -> tuple[
    dict[str, object],
    str,
    str,
]:
    if not isinstance(
        raw,
        Mapping,
    ):
        raise DetectionResultContractError(
            f"results[{index}] must be an object."
        )

    (
        strategy_id,
        strategy,
        deployment,
        ensemble_id,
        ensemble_version,
        feature_schema,
    ) = _strategy_metadata(
        raw
    )

    payload = raw.get(
        "result_payload"
    )

    if not isinstance(
        payload,
        dict,
    ):
        raise DetectionResultContractError(
            f"results[{index}].result_payload "
            "must be an object."
        )

    payload = dict(
        payload
    )

    payload_json = _canonical_json(
        payload,
        (
            f"results[{index}]"
            ".result_payload"
        ),
    )

    result_hash = hashlib.sha256(
        payload_json.encode(
            "utf-8"
        )
    ).hexdigest()

    record = {
        "tenant_id": _text(
            raw.get(
                "tenant_id"
            ),
            f"results[{index}].tenant_id",
            64,
        ),

        "claim_id": _text(
            raw.get(
                "claim_id"
            ),
            f"results[{index}].claim_id",
            128,
        ),

        "claim_version": _positive_int(
            raw.get(
                "claim_version"
            ),
            f"results[{index}].claim_version",
        ),

        "detection_strategy_id":
            strategy_id,

        "strategy_type":
            strategy,

        "model_deployment_id":
            deployment,

        "source_job_id": _text(
            raw.get(
                "source_job_id"
            ),
            f"results[{index}].source_job_id",
            64,
        ),

        "request_id": _text(
            raw.get(
                "request_id"
            ),
            f"results[{index}].request_id",
            128,
        ),

        "analysis_mode": _text(
            raw.get(
                "analysis_mode"
            ),
            f"results[{index}].analysis_mode",
            64,
        ),

        "ensemble_id":
            ensemble_id,

        "ensemble_version":
            ensemble_version,

        "feature_schema_version":
            feature_schema,

        "result_payload":
            payload,
    }

    return (
        record,
        payload_json,
        result_hash,
    )


def _normalise_targets(
    targets: Sequence[
        object
    ],
) -> tuple[
    tuple[
        str,
        int,
    ],
    ...,
]:
    if (
        isinstance(
            targets,
            (
                str,
                bytes,
                bytearray,
            ),
        )
        or not isinstance(
            targets,
            Sequence,
        )
    ):
        raise DetectionResultContractError(
            "targets must contain exact "
            "claim-version references."
        )

    if (
        len(targets)
        > MAX_RESULTS_PER_WRITE
    ):
        raise DetectionResultContractError(
            "targets must not exceed "
            f"{MAX_RESULTS_PER_WRITE} entries."
        )

    result: list[
        tuple[
            str,
            int,
        ]
    ] = []

    seen: set[
        tuple[
            str,
            int,
        ]
    ] = set()

    for index, target in enumerate(
        targets
    ):
        if isinstance(
            target,
            Mapping,
        ):
            claim_id = target.get(
                "claim_id"
            )

            claim_version = target.get(
                "claim_version"
            )

        elif (
            isinstance(
                target,
                tuple,
            )
            and len(target) == 2
        ):
            (
                claim_id,
                claim_version,
            ) = target

        else:
            claim_id = getattr(
                target,
                "claim_id",
                None,
            )

            claim_version = getattr(
                target,
                "claim_version",
                None,
            )

        reference = (
            _text(
                claim_id,
                f"targets[{index}].claim_id",
                128,
            ),

            _positive_int(
                claim_version,
                f"targets[{index}].claim_version",
            ),
        )

        if reference in seen:
            raise DetectionResultContractError(
                "Duplicate target "
                f"{reference[0]}"
                f"@{reference[1]}."
            )

        seen.add(
            reference
        )

        result.append(
            reference
        )

    return tuple(
        result
    )


def _duplicate_key(
    error: Exception,
) -> bool:
    code = getattr(
        error,
        "code",
        None,
    )

    args = getattr(
        error,
        "args",
        (),
    )

    return (
        code
        in {
            "ER_DUP_ENTRY",
            1062,
        }
        or bool(
            args
            and args[0]
            in {
                "ER_DUP_ENTRY",
                1062,
            }
        )
    )


def _stored(
    row: Mapping[
        str,
        object,
    ],
) -> StoredDetectionResult:
    payload = _decode_payload(
        row.get(
            "result_payload"
        )
    )

    payload_json = _canonical_json(
        payload,
        "stored result payload",
    )

    computed_hash = hashlib.sha256(
        payload_json.encode(
            "utf-8"
        )
    ).hexdigest()

    result_hash = _text(
        row.get(
            "result_hash"
        ),
        "stored result_hash",
        64,
    )

    if (
        not _SHA256.fullmatch(
            result_hash
        )
        or result_hash
        != computed_hash
    ):
        raise DetectionResultIntegrityError(
            "Stored result payload does not "
            "match its result_hash."
        )

    (
        strategy_id,
        strategy,
        deployment,
        ensemble_id,
        ensemble_version,
        feature_schema,
    ) = _strategy_metadata(
        row
    )

    return StoredDetectionResult(
        tenant_id=_text(
            row.get(
                "tenant_id"
            ),
            "stored tenant_id",
            64,
        ),

        claim_id=_text(
            row.get(
                "claim_id"
            ),
            "stored claim_id",
            128,
        ),

        claim_version=_positive_int(
            row.get(
                "claim_version"
            ),
            "stored claim_version",
        ),

        detection_strategy_id=
            strategy_id,

        strategy_type=
            strategy,

        model_deployment_id=
            deployment,

        source_job_id=_text(
            row.get(
                "source_job_id"
            ),
            "stored source_job_id",
            64,
        ),

        request_id=_text(
            row.get(
                "request_id"
            ),
            "stored request_id",
            128,
        ),

        analysis_mode=_text(
            row.get(
                "analysis_mode"
            ),
            "stored analysis_mode",
            64,
        ),

        ensemble_id=
            ensemble_id,

        ensemble_version=
            ensemble_version,

        feature_schema_version=
            feature_schema,

        scored_at=row.get(
            "scored_at"
        ),

        result_payload=
            payload,

        result_hash=
            result_hash,
    )


def _assert_same(
    existing: StoredDetectionResult,
    record: Mapping[
        str,
        object,
    ],
    result_hash: str,
) -> None:
    pairs = (
        (
            "tenant_id",
            existing.tenant_id,
            record["tenant_id"],
        ),
        (
            "claim_id",
            existing.claim_id,
            record["claim_id"],
        ),
        (
            "claim_version",
            existing.claim_version,
            record["claim_version"],
        ),
        (
            "detection_strategy_id",
            existing.detection_strategy_id,
            record[
                "detection_strategy_id"
            ],
        ),
        (
            "strategy_type",
            existing.strategy_type,
            record["strategy_type"],
        ),
        (
            "model_deployment_id",
            existing.model_deployment_id,
            record[
                "model_deployment_id"
            ],
        ),
        (
            "source_job_id",
            existing.source_job_id,
            record["source_job_id"],
        ),
        (
            "request_id",
            existing.request_id,
            record["request_id"],
        ),
        (
            "analysis_mode",
            existing.analysis_mode,
            record["analysis_mode"],
        ),
        (
            "ensemble_id",
            existing.ensemble_id,
            record["ensemble_id"],
        ),
        (
            "ensemble_version",
            existing.ensemble_version,
            record[
                "ensemble_version"
            ],
        ),
        (
            "feature_schema_version",
            existing.feature_schema_version,
            record[
                "feature_schema_version"
            ],
        ),
        (
            "result_hash",
            existing.result_hash,
            result_hash,
        ),
    )

    mismatches = [
        field
        for (
            field,
            actual,
            expected,
        ) in pairs
        if actual != expected
    ]

    if mismatches:
        raise DetectionResultConflictError(
            "An immutable result already exists "
            "with different fields: "
            + ", ".join(
                mismatches
            )
            + "."
        )


def _model_score(
    score: object,
) -> dict[str, object]:
    predicted_class = _text(
        getattr(
            score,
            "baseline_predicted_class",
            None,
        ),
        "score.baseline_predicted_class",
        32,
    )

    if predicted_class not in {
        "FRAUD",
        "LEGITIMATE",
    }:
        raise DetectionResultContractError(
            "Unsupported baseline predicted class."
        )

    return {
        "baselineFraudProbability":
            _probability(
                getattr(
                    score,
                    (
                        "baseline_fraud"
                        "_probability"
                    ),
                    None,
                ),
                (
                    "score.baseline_fraud"
                    "_probability"
                ),
            ),

        "baselinePredictedClass":
            predicted_class,

        "baselineThreshold":
            _probability(
                getattr(
                    score,
                    "baseline_threshold",
                    None,
                ),
                "score.baseline_threshold",
            ),

        "ringProbability":
            _probability(
                getattr(
                    score,
                    "ring_probability",
                    None,
                ),
                "score.ring_probability",
            ),

        "ringReviewHit":
            _boolean(
                getattr(
                    score,
                    "ring_review_hit",
                    None,
                ),
                "score.ring_review_hit",
            ),

        "ringThreshold":
            _probability(
                getattr(
                    score,
                    "ring_threshold",
                    None,
                ),
                "score.ring_threshold",
            ),

        "phantomProbability":
            _probability(
                getattr(
                    score,
                    "phantom_probability",
                    None,
                ),
                "score.phantom_probability",
            ),

        "phantomReviewHit":
            _boolean(
                getattr(
                    score,
                    "phantom_review_hit",
                    None,
                ),
                "score.phantom_review_hit",
            ),

        "phantomThreshold":
            _probability(
                getattr(
                    score,
                    "phantom_threshold",
                    None,
                ),
                "score.phantom_threshold",
            ),

        "compositeReviewRecommended":
            _boolean(
                getattr(
                    score,
                    (
                        "composite_review"
                        "_recommended"
                    ),
                    None,
                ),
                (
                    "score.composite_review"
                    "_recommended"
                ),
            ),
    }


class PyMySqlDetectionResultsRepository:
    """
    Stores exactly one immutable detection result
    for each exact claim version.
    """

    _SELECT_ONE = """
        SELECT
          tenant_id,
          claim_id,
          claim_version,
          detection_strategy_id,
          strategy_type,
          model_deployment_id,
          source_job_id,
          request_id,
          analysis_mode,
          ensemble_id,
          ensemble_version,
          feature_schema_version,
          scored_at,
          result_payload,
          result_hash
        FROM claim_detection_results
        WHERE tenant_id = %s
          AND claim_id = %s
          AND claim_version = %s
        LIMIT 1
    """

    def __init__(
        self,
        connection_factory: Callable[
            [],
            Any,
        ],
        allowed_tenant_ids: (
            frozenset[str] | None
        ) = None,
    ) -> None:
        if not callable(
            connection_factory
        ):
            raise ValueError(
                "connection_factory must be callable."
            )

        self.connection_factory = (
            connection_factory
        )

        self.allowed_tenant_ids = (
            None
            if allowed_tenant_ids is None
            else frozenset(
                _text(
                    value,
                    "allowed tenant ID",
                    64,
                )
                for value
                in allowed_tenant_ids
            )
        )

    def _tenant(
        self,
        tenant_id: object,
    ) -> str:
        canonical = _text(
            tenant_id,
            "tenant_id",
            64,
        )

        if (
            self.allowed_tenant_ids
            is not None
            and canonical
            not in self.allowed_tenant_ids
        ):
            raise DetectionResultContractError(
                "Tenant is outside the verified "
                "worker data-plane scope."
            )

        return canonical

    @classmethod
    def _select_one(
        cls,
        cursor,
        tenant_id: str,
        claim_id: str,
        claim_version: int,
        *,
        for_update: bool,
    ) -> StoredDetectionResult | None:
        cursor.execute(
            cls._SELECT_ONE
            + (
                " FOR UPDATE"
                if for_update
                else ""
            ),
            [
                tenant_id,
                claim_id,
                claim_version,
            ],
        )

        row = cursor.fetchone()

        return (
            _stored(row)
            if row
            else None
        )

    @staticmethod
    def _insert(
        cursor,
        record: Mapping[
            str,
            object,
        ],
        payload_json: str,
        result_hash: str,
    ) -> None:
        cursor.execute(
            """
                INSERT INTO claim_detection_results (
                  tenant_id,
                  claim_id,
                  claim_version,
                  detection_strategy_id,
                  strategy_type,
                  model_deployment_id,
                  source_job_id,
                  request_id,
                  analysis_mode,
                  ensemble_id,
                  ensemble_version,
                  feature_schema_version,
                  scored_at,
                  result_payload,
                  result_hash
                )
                VALUES (
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s,
                  %s, %s, UTC_TIMESTAMP(3),
                  %s, %s
                )
            """,
            [
                record["tenant_id"],
                record["claim_id"],
                record["claim_version"],
                record[
                    "detection_strategy_id"
                ],
                record["strategy_type"],
                record[
                    "model_deployment_id"
                ],
                record["source_job_id"],
                record["request_id"],
                record["analysis_mode"],
                record["ensemble_id"],
                record["ensemble_version"],
                record[
                    "feature_schema_version"
                ],
                payload_json,
                result_hash,
            ],
        )

    def save_result_records(
        self,
        records: Iterable[
            Mapping[
                str,
                object,
            ]
        ],
    ) -> tuple[
        StoredDetectionResult,
        ...,
    ]:
        pending = tuple(
            _normalise_record(
                value,
                index,
            )
            for (
                index,
                value,
            ) in enumerate(
                records
            )
        )

        if not pending:
            return ()

        if (
            len(pending)
            > MAX_RESULTS_PER_WRITE
        ):
            raise DetectionResultContractError(
                "results must not exceed "
                f"{MAX_RESULTS_PER_WRITE} entries."
            )

        tenants = {
            self._tenant(
                record[
                    "tenant_id"
                ]
            )
            for (
                record,
                _,
                _,
            ) in pending
        }

        references = [
            (
                record["claim_id"],
                record["claim_version"],
            )
            for (
                record,
                _,
                _,
            ) in pending
        ]

        if len(tenants) != 1:
            raise DetectionResultContractError(
                "A result write cannot cross "
                "tenant boundaries."
            )

        if (
            len(
                set(
                    references
                )
            )
            != len(
                references
            )
        ):
            raise DetectionResultContractError(
                "A result write contains duplicate "
                "claim-version references."
            )

        connection = (
            self.connection_factory()
        )

        try:
            connection.begin()

            stored_results: list[
                StoredDetectionResult
            ] = []

            with connection.cursor() as cursor:
                for (
                    record,
                    payload_json,
                    result_hash,
                ) in pending:
                    existing = self._select_one(
                        cursor,
                        str(
                            record[
                                "tenant_id"
                            ]
                        ),
                        str(
                            record[
                                "claim_id"
                            ]
                        ),
                        int(
                            record[
                                "claim_version"
                            ]
                        ),
                        for_update=True,
                    )

                    if existing is not None:
                        _assert_same(
                            existing,
                            record,
                            result_hash,
                        )

                        stored_results.append(
                            existing
                        )

                        continue

                    try:
                        self._insert(
                            cursor,
                            record,
                            payload_json,
                            result_hash,
                        )

                    except Exception as error:
                        if not _duplicate_key(
                            error
                        ):
                            raise

                        existing = self._select_one(
                            cursor,
                            str(
                                record[
                                    "tenant_id"
                                ]
                            ),
                            str(
                                record[
                                    "claim_id"
                                ]
                            ),
                            int(
                                record[
                                    "claim_version"
                                ]
                            ),
                            for_update=True,
                        )

                        if existing is None:
                            raise (
                                DetectionResultIntegrityError(
                                    "A duplicate result "
                                    "could not be reloaded."
                                )
                            ) from error

                        _assert_same(
                            existing,
                            record,
                            result_hash,
                        )

                        stored_results.append(
                            existing
                        )

                        continue

                    inserted = self._select_one(
                        cursor,
                        str(
                            record[
                                "tenant_id"
                            ]
                        ),
                        str(
                            record[
                                "claim_id"
                            ]
                        ),
                        int(
                            record[
                                "claim_version"
                            ]
                        ),
                        for_update=True,
                    )

                    if inserted is None:
                        raise DetectionResultIntegrityError(
                            "An inserted result "
                            "could not be reloaded."
                        )

                    _assert_same(
                        inserted,
                        record,
                        result_hash,
                    )

                    stored_results.append(
                        inserted
                    )

            connection.commit()

            return tuple(
                stored_results
            )

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

    def save_results(
        self,
        *,
        snapshot: object,
        review: object,
    ) -> tuple[
        StoredDetectionResult,
        ...,
    ]:
        tenant_id = self._tenant(
            getattr(
                snapshot,
                "tenant_id",
                None,
            )
        )

        source_job_ids = getattr(
            snapshot,
            "source_job_ids",
            None,
        )

        if (
            not isinstance(
                source_job_ids,
                tuple,
            )
            or len(
                source_job_ids
            )
            != 1
        ):
            raise DetectionResultContractError(
                "A scoring snapshot must identify "
                "exactly one source job."
            )

        source_job_id = _text(
            source_job_ids[0],
            "source_job_id",
            64,
        )

        strategy = _text(
            getattr(
                snapshot,
                "detection_strategy",
                None,
            ),
            "snapshot.detection_strategy",
            64,
        )

        if strategy != "approved_model":
            raise DetectionResultContractError(
                "save_results(snapshot, review) "
                "accepts approved_model only."
            )

        strategy_id = _positive_int(
            getattr(
                snapshot,
                "detection_strategy_id",
                None,
            ),
            "snapshot.detection_strategy_id",
        )

        deployment_id = _text(
            getattr(
                snapshot,
                "model_deployment_id",
                None,
            ),
            "snapshot.model_deployment_id",
            128,
        )

        watermark = _text(
            getattr(
                snapshot,
                "watermark",
                None,
            ),
            "snapshot.watermark",
            1024,
        )

        if not _DEPLOYMENT_ID.fullmatch(
            deployment_id
        ):
            raise DetectionResultContractError(
                "Snapshot deployment ID is invalid."
            )

        if (
            _text(
                getattr(
                    review,
                    "watermark",
                    None,
                ),
                "review.watermark",
                1024,
            )
            != watermark
        ):
            raise DetectionResultContractError(
                "Model review watermark differs "
                "from the snapshot."
            )

        if (
            _text(
                getattr(
                    review,
                    "deployment_id",
                    None,
                ),
                "review.deployment_id",
                128,
            )
            != deployment_id
        ):
            raise DetectionResultContractError(
                "Model review deployment differs "
                "from the snapshot."
            )

        ensemble_id = _text(
            getattr(
                review,
                "ensemble_id",
                None,
            ),
            "review.ensemble_id",
            128,
        )

        ensemble_version = _text(
            getattr(
                review,
                "ensemble_version",
                None,
            ),
            "review.ensemble_version",
            64,
        )

        feature_schema = _text(
            getattr(
                review,
                "feature_schema_version",
                None,
            ),
            "review.feature_schema_version",
            128,
        )

        analysis_mode = _text(
            getattr(
                review,
                "analysis_mode",
                None,
            ),
            "review.analysis_mode",
            64,
        )

        request_id = _text(
            getattr(
                review,
                "request_id",
                None,
            ),
            "review.request_id",
            128,
        )

        target_claims = getattr(
            snapshot,
            "target_claims",
            None,
        )

        if (
            not isinstance(
                target_claims,
                list,
            )
            or not target_claims
        ):
            raise DetectionResultContractError(
                "Snapshot must contain target "
                "claim versions."
            )

        targets = _normalise_targets(
            target_claims
        )

        scores = getattr(
            review,
            "scores",
            None,
        )

        if (
            not isinstance(
                scores,
                tuple,
            )
            or not scores
        ):
            raise DetectionResultContractError(
                "Model review must contain scores."
            )

        by_target: dict[
            tuple[
                str,
                int,
            ],
            object,
        ] = {}

        for index, score in enumerate(
            scores
        ):
            target = (
                _text(
                    getattr(
                        score,
                        "claim_id",
                        None,
                    ),
                    (
                        f"review.scores[{index}]"
                        ".claim_id"
                    ),
                    128,
                ),

                _positive_int(
                    getattr(
                        score,
                        "claim_version",
                        None,
                    ),
                    (
                        f"review.scores[{index}]"
                        ".claim_version"
                    ),
                ),
            )

            if target in by_target:
                raise DetectionResultContractError(
                    "Model review contains duplicate "
                    "claim-version scores."
                )

            by_target[
                target
            ] = score

        if (
            set(
                by_target
            )
            != set(
                targets
            )
        ):
            raise DetectionResultContractError(
                "Model review coverage differs "
                "from the snapshot targets."
            )

        records: list[
            dict[
                str,
                object,
            ]
        ] = []

        for (
            claim_id,
            claim_version,
        ) in targets:
            payload = {
                "schemaVersion":
                    RESULT_PAYLOAD_SCHEMA_VERSION,

                "tenantId":
                    tenant_id,

                "claimId":
                    claim_id,

                "claimVersion":
                    claim_version,

                "sourceJobId":
                    source_job_id,

                "requestId":
                    request_id,

                "watermark":
                    watermark,

                "analysisMode":
                    analysis_mode,

                "strategy": {
                    "detectionStrategyId":
                        strategy_id,

                    "strategyType":
                        strategy,

                    "modelDeploymentId":
                        deployment_id,
                },

                "model": {
                    "deploymentId":
                        deployment_id,

                    "ensembleId":
                        ensemble_id,

                    "ensembleVersion":
                        ensemble_version,

                    "featureSchemaVersion":
                        feature_schema,
                },

                "score":
                    _model_score(
                        by_target[
                            (
                                claim_id,
                                claim_version,
                            )
                        ]
                    ),
            }

            records.append(
                {
                    "tenant_id":
                        tenant_id,

                    "claim_id":
                        claim_id,

                    "claim_version":
                        claim_version,

                    "detection_strategy_id":
                        strategy_id,

                    "strategy_type":
                        strategy,

                    "model_deployment_id":
                        deployment_id,

                    "source_job_id":
                        source_job_id,

                    "request_id":
                        request_id,

                    "analysis_mode":
                        analysis_mode,

                    "ensemble_id":
                        ensemble_id,

                    "ensemble_version":
                        ensemble_version,

                    "feature_schema_version":
                        feature_schema,

                    "result_payload":
                        payload,
                }
            )

        return self.save_result_records(
            records
        )

    def results_exist(
        self,
        tenant_id: str,
        claim_id: str,
        claim_version: int,
    ) -> bool:
        tenant_id = self._tenant(
            tenant_id
        )

        claim_id = _text(
            claim_id,
            "claim_id",
            128,
        )

        claim_version = _positive_int(
            claim_version,
            "claim_version",
        )

        connection = (
            self.connection_factory()
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT 1
                        FROM claim_detection_results
                        WHERE tenant_id = %s
                          AND claim_id = %s
                          AND claim_version = %s
                        LIMIT 1
                    """,
                    [
                        tenant_id,
                        claim_id,
                        claim_version,
                    ],
                )

                return (
                    cursor.fetchone()
                    is not None
                )

        finally:
            connection.close()

    def load_results_for_report(
        self,
        tenant_id: str,
        targets: Sequence[
            object
        ],
    ) -> list[
        dict[
            str,
            object,
        ]
    ]:
        tenant_id = self._tenant(
            tenant_id
        )

        references = _normalise_targets(
            targets
        )

        if not references:
            return []

        placeholders = ", ".join(
            [
                "(%s, %s)"
            ]
            * len(
                references
            )
        )

        params: list[
            object
        ] = [
            tenant_id
        ]

        for (
            claim_id,
            claim_version,
        ) in references:
            params.extend(
                [
                    claim_id,
                    claim_version,
                ]
            )

        connection = (
            self.connection_factory()
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"""
                        SELECT
                          tenant_id,
                          claim_id,
                          claim_version,
                          detection_strategy_id,
                          strategy_type,
                          model_deployment_id,
                          source_job_id,
                          request_id,
                          analysis_mode,
                          ensemble_id,
                          ensemble_version,
                          feature_schema_version,
                          scored_at,
                          result_payload,
                          result_hash
                        FROM claim_detection_results
                        WHERE tenant_id = %s
                          AND (
                            claim_id,
                            claim_version
                          ) IN (
                            {placeholders}
                          )
                    """,
                    params,
                )

                rows = cursor.fetchall()

        finally:
            connection.close()

        by_target: dict[
            tuple[
                str,
                int,
            ],
            StoredDetectionResult,
        ] = {}

        for row in rows:
            stored = _stored(
                row
            )

            target = (
                stored.claim_id,
                stored.claim_version,
            )

            if target in by_target:
                raise DetectionResultIntegrityError(
                    "Stored results contain duplicate "
                    "claim-version rows."
                )

            by_target[
                target
            ] = stored

        missing = [
            f"{claim_id}@{claim_version}"
            for (
                claim_id,
                claim_version,
            ) in references
            if (
                claim_id,
                claim_version,
            )
            not in by_target
        ]

        if missing:
            suffix = (
                "."
                if len(missing) <= 20
                else ", ..."
            )

            raise DetectionResultIntegrityError(
                "Detection results are missing for: "
                + ", ".join(
                    missing[:20]
                )
                + suffix
            )

        return [
            by_target[
                target
            ].as_dict()
            for target in references
        ]
