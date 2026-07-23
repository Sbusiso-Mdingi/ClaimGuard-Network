from __future__ import annotations

import copy
import hashlib
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Sequence

from .detection_results import (
    DetectionResultContractError,
    DetectionResultIntegrityError,
    PyMySqlDetectionResultsRepository,
    RESULT_PAYLOAD_SCHEMA_VERSION,
)
from .model_report import build_model_detection_report
from .model_service import (
    ClaimReviewResult,
    ModelServiceClient,
    ModelServiceUnavailable,
    ReviewWindowResult,
)
from .snapshot import ProspectiveScoringSnapshot


DETERMINISTIC_ANALYSIS_MODE = (
    "PROSPECTIVE_DETERMINISTIC_RULES"
)

DETERMINISTIC_REQUEST_VERSION = (
    "claimguard.deterministic-request.v1"
)


def _detection_imports():
    try:
        from claimguard_detection_engine.loader import (
            build_data_bundle_from_records,
        )

        from claimguard_detection_engine.orchestration import (
            DetectionSnapshot,
            run_detection_orchestration,
        )

    except ModuleNotFoundError:
        repo_root = (
            Path(__file__)
            .resolve()
            .parents[4]
        )

        detection_engine_src = (
            repo_root
            / "services"
            / "detection-engine"
            / "src"
        )

        if (
            str(detection_engine_src)
            not in sys.path
        ):
            sys.path.append(
                str(detection_engine_src)
            )

        from claimguard_detection_engine.loader import (
            build_data_bundle_from_records,
        )

        from claimguard_detection_engine.orchestration import (
            DetectionSnapshot,
            run_detection_orchestration,
        )

    return (
        build_data_bundle_from_records,
        DetectionSnapshot,
        run_detection_orchestration,
    )


def _text(
    value: object,
    field: str,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise DetectionResultContractError(
            f"{field} is required."
        )

    return rendered


def _positive_int(
    value: object,
    field: str,
) -> int:
    if isinstance(
        value,
        bool,
    ):
        raise DetectionResultContractError(
            f"{field} must be "
            "a positive integer."
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
            f"{field} must be "
            "a positive integer."
        ) from error

    if (
        parsed <= 0
        or (
            isinstance(
                value,
                float,
            )
            and not value.is_integer()
        )
    ):
        raise DetectionResultContractError(
            f"{field} must be "
            "a positive integer."
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
        raise DetectionResultIntegrityError(
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
        raise DetectionResultIntegrityError(
            f"{field} must be a probability."
        ) from error

    if (
        not math.isfinite(
            parsed
        )
        or not 0 <= parsed <= 1
    ):
        raise DetectionResultIntegrityError(
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
        raise DetectionResultIntegrityError(
            f"{field} must be a boolean."
        )

    return value


def _mapping(
    value: object,
    field: str,
) -> dict[str, object]:
    if not isinstance(
        value,
        dict,
    ):
        raise DetectionResultIntegrityError(
            f"{field} must be an object."
        )

    return dict(
        value
    )


def _timestamp(
    value: object,
    field: str,
) -> str:
    rendered = (
        value.isoformat()
        if hasattr(
            value,
            "isoformat",
        )
        else str(
            value or ""
        ).strip()
    )

    if not rendered:
        raise DetectionResultContractError(
            f"{field} is required."
        )

    try:
        parsed = datetime.fromisoformat(
            rendered.replace(
                "Z",
                "+00:00",
            )
        )

    except ValueError as error:
        raise DetectionResultContractError(
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


def _canonical_json(
    value: object,
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
        )

    except (
        TypeError,
        ValueError,
    ) as error:
        raise DetectionResultContractError(
            "Detection data must be "
            "finite JSON."
        ) from error


def _targets(
    snapshot: ProspectiveScoringSnapshot,
) -> tuple[
    tuple[
        str,
        int,
    ],
    ...,
]:
    if (
        not isinstance(
            snapshot.target_claims,
            list,
        )
        or not snapshot.target_claims
    ):
        raise DetectionResultContractError(
            "Snapshot must contain "
            "target claim versions."
        )

    result: list[
        tuple[
            str,
            int,
        ]
    ] = []

    seen_claim_ids: set[
        str
    ] = set()

    for index, claim in enumerate(
        snapshot.target_claims
    ):
        if not isinstance(
            claim,
            dict,
        ):
            raise DetectionResultContractError(
                f"snapshot.target_claims"
                f"[{index}] must be an object."
            )

        target = (
            _text(
                claim.get(
                    "claim_id"
                ),
                (
                    f"target[{index}]"
                    ".claim_id"
                ),
            ),

            _positive_int(
                claim.get(
                    "claim_version"
                ),
                (
                    f"target[{index}]"
                    ".claim_version"
                ),
            ),
        )

        if (
            target[0]
            in seen_claim_ids
        ):
            raise DetectionResultContractError(
                "Snapshot contains multiple "
                "versions of claim "
                f"{target[0]}."
            )

        seen_claim_ids.add(
            target[0]
        )

        result.append(
            target
        )

    return tuple(
        result
    )


def _source_job_id(
    snapshot: ProspectiveScoringSnapshot,
) -> str:
    if (
        not isinstance(
            snapshot.source_job_ids,
            tuple,
        )
        or len(
            snapshot.source_job_ids
        )
        != 1
    ):
        raise DetectionResultContractError(
            "A scoring snapshot must identify "
            "exactly one source job."
        )

    return _text(
        snapshot.source_job_ids[0],
        "source_job_id",
    )


def _stored_state(
    repository: (
        PyMySqlDetectionResultsRepository
    ),
    snapshot: ProspectiveScoringSnapshot,
    targets: Sequence[
        tuple[
            str,
            int,
        ]
    ],
) -> str:
    exists = [
        repository.results_exist(
            snapshot.tenant_id,
            claim_id,
            claim_version,
        )
        for (
            claim_id,
            claim_version,
        )
        in targets
    ]

    if all(
        exists
    ):
        return "complete"

    if any(
        exists
    ):
        raise DetectionResultIntegrityError(
            "Only part of the immutable "
            "result set exists for one "
            "scoring job."
        )

    return "absent"


def _load_results(
    repository: (
        PyMySqlDetectionResultsRepository
    ),
    snapshot: ProspectiveScoringSnapshot,
    targets: Sequence[
        tuple[
            str,
            int,
        ]
    ],
) -> list[
    dict[
        str,
        object,
    ]
]:
    return (
        repository
        .load_results_for_report(
            snapshot.tenant_id,
            list(
                targets
            ),
        )
    )


def _model_review_from_stored(
    snapshot: ProspectiveScoringSnapshot,
    records: Sequence[
        Mapping[
            str,
            object,
        ]
    ],
) -> ReviewWindowResult:
    targets = _targets(
        snapshot
    )

    if (
        len(
            records
        )
        != len(
            targets
        )
    ):
        raise DetectionResultIntegrityError(
            "Stored model-result coverage "
            "differs from the target set."
        )

    source_job_id = (
        _source_job_id(
            snapshot
        )
    )

    strategy_id = (
        _positive_int(
            snapshot.detection_strategy_id,
            (
                "snapshot."
                "detection_strategy_id"
            ),
        )
    )

    deployment_id = _text(
        snapshot.model_deployment_id,
        (
            "snapshot."
            "model_deployment_id"
        ),
    )

    common: tuple[
        str,
        str,
        str,
        str,
        str,
    ] | None = None

    scores: list[
        ClaimReviewResult
    ] = []

    for index, (
        record,
        target,
    ) in enumerate(
        zip(
            records,
            targets,
            strict=True,
        )
    ):
        (
            claim_id,
            claim_version,
        ) = target

        if (
            record.get(
                "tenant_id"
            )
            != snapshot.tenant_id

            or record.get(
                "claim_id"
            )
            != claim_id

            or int(
                record.get(
                    "claim_version"
                )
                or 0
            )
            != claim_version

            or int(
                record.get(
                    "detection_strategy_id"
                )
                or 0
            )
            != strategy_id

            or record.get(
                "strategy_type"
            )
            != "approved_model"

            or record.get(
                "model_deployment_id"
            )
            != deployment_id

            or record.get(
                "source_job_id"
            )
            != source_job_id
        ):
            raise DetectionResultIntegrityError(
                "Stored model-result identity "
                "differs from its snapshot."
            )

        payload = _mapping(
            record.get(
                "result_payload"
            ),
            (
                f"results[{index}]"
                ".payload"
            ),
        )

        strategy = _mapping(
            payload.get(
                "strategy"
            ),
            (
                f"results[{index}]"
                ".strategy"
            ),
        )

        model = _mapping(
            payload.get(
                "model"
            ),
            (
                f"results[{index}]"
                ".model"
            ),
        )

        score = _mapping(
            payload.get(
                "score"
            ),
            (
                f"results[{index}]"
                ".score"
            ),
        )

        if (
            payload.get(
                "schemaVersion"
            )
            != RESULT_PAYLOAD_SCHEMA_VERSION

            or payload.get(
                "tenantId"
            )
            != snapshot.tenant_id

            or payload.get(
                "claimId"
            )
            != claim_id

            or payload.get(
                "claimVersion"
            )
            != claim_version

            or payload.get(
                "sourceJobId"
            )
            != source_job_id

            or payload.get(
                "watermark"
            )
            != snapshot.watermark

            or strategy
            != {
                "detectionStrategyId":
                    strategy_id,

                "strategyType":
                    "approved_model",

                "modelDeploymentId":
                    deployment_id,
            }

            or model.get(
                "deploymentId"
            )
            != deployment_id
        ):
            raise DetectionResultIntegrityError(
                "Stored model-result payload "
                "differs from its snapshot."
            )

        identity = (
            _text(
                model.get(
                    "ensembleId"
                ),
                "ensemble_id",
            ),

            _text(
                model.get(
                    "ensembleVersion"
                ),
                "ensemble_version",
            ),

            _text(
                model.get(
                    "featureSchemaVersion"
                ),
                "feature_schema_version",
            ),

            _text(
                payload.get(
                    "analysisMode"
                ),
                "analysis_mode",
            ),

            _text(
                payload.get(
                    "requestId"
                ),
                "request_id",
            ),
        )

        if common is None:
            common = identity

        elif common != identity:
            raise DetectionResultIntegrityError(
                "Stored model results "
                "disagree on execution identity."
            )

        predicted_class = _text(
            score.get(
                "baselinePredictedClass"
            ),
            (
                "baseline_"
                "predicted_class"
            ),
        )

        if predicted_class not in {
            "FRAUD",
            "LEGITIMATE",
        }:
            raise DetectionResultIntegrityError(
                "Stored baseline predicted "
                "class is invalid."
            )

        baseline = _probability(
            score.get(
                "baselineFraudProbability"
            ),
            (
                "baselineFraud"
                "Probability"
            ),
        )

        baseline_threshold = (
            _probability(
                score.get(
                    "baselineThreshold"
                ),
                "baselineThreshold",
            )
        )

        ring = _probability(
            score.get(
                "ringProbability"
            ),
            "ringProbability",
        )

        ring_hit = _boolean(
            score.get(
                "ringReviewHit"
            ),
            "ringReviewHit",
        )

        ring_threshold = _probability(
            score.get(
                "ringThreshold"
            ),
            "ringThreshold",
        )

        phantom = _probability(
            score.get(
                "phantomProbability"
            ),
            "phantomProbability",
        )

        phantom_hit = _boolean(
            score.get(
                "phantomReviewHit"
            ),
            "phantomReviewHit",
        )

        phantom_threshold = (
            _probability(
                score.get(
                    "phantomThreshold"
                ),
                "phantomThreshold",
            )
        )

        composite = _boolean(
            score.get(
                (
                    "compositeReview"
                    "Recommended"
                )
            ),
            (
                "compositeReview"
                "Recommended"
            ),
        )

        baseline_hit = (
            baseline
            >= baseline_threshold
        )

        if (
            (
                predicted_class
                == "FRAUD"
            )
            != baseline_hit

            or ring_hit
            != (
                ring
                >= ring_threshold
            )

            or phantom_hit
            != (
                phantom
                >= phantom_threshold
            )

            or composite
            != (
                baseline_hit
                or ring_hit
                or phantom_hit
            )
        ):
            raise DetectionResultIntegrityError(
                "Stored model decisions "
                "differ from their thresholds."
            )

        scores.append(
            ClaimReviewResult(
                claim_id=(
                    claim_id
                ),

                claim_version=(
                    claim_version
                ),

                baseline_fraud_probability=(
                    baseline
                ),

                baseline_predicted_class=(
                    predicted_class
                ),

                baseline_threshold=(
                    baseline_threshold
                ),

                ring_probability=(
                    ring
                ),

                ring_review_hit=(
                    ring_hit
                ),

                ring_threshold=(
                    ring_threshold
                ),

                phantom_probability=(
                    phantom
                ),

                phantom_review_hit=(
                    phantom_hit
                ),

                phantom_threshold=(
                    phantom_threshold
                ),

                composite_review_recommended=(
                    composite
                ),
            )
        )

    if common is None:
        raise DetectionResultIntegrityError(
            "No stored model results "
            "were found."
        )

    (
        ensemble_id,
        ensemble_version,
        feature_schema_version,
        analysis_mode,
        request_id,
    ) = common

    return ReviewWindowResult(
        deployment_id=(
            deployment_id
        ),

        ensemble_id=(
            ensemble_id
        ),

        ensemble_version=(
            ensemble_version
        ),

        feature_schema_version=(
            feature_schema_version
        ),

        analysis_mode=(
            analysis_mode
        ),

        request_id=(
            request_id
        ),

        watermark=(
            snapshot.watermark
        ),

        scores=tuple(
            scores
        ),
    )


def _approved_model_report(
    snapshot: ProspectiveScoringSnapshot,
    *,
    correlation_id: str,
    model_client: (
        ModelServiceClient
        | None
    ),
    repository: (
        PyMySqlDetectionResultsRepository
    ),
) -> dict[str, object]:
    targets = _targets(
        snapshot
    )

    if (
        _stored_state(
            repository,
            snapshot,
            targets,
        )
        == "absent"
    ):
        if model_client is None:
            raise ModelServiceUnavailable(
                watermark=(
                    snapshot.watermark
                )
            )

        repository.save_results(
            snapshot=snapshot,

            review=(
                model_client.review(
                    snapshot
                )
            ),
        )

    review = (
        _model_review_from_stored(
            snapshot,

            _load_results(
                repository,
                snapshot,
                targets,
            ),
        )
    )

    return build_model_detection_report(
        snapshot,
        review,
        correlation_id=(
            correlation_id
        ),
    )


def _deterministic_request_id(
    snapshot: ProspectiveScoringSnapshot,
) -> str:
    identity = {
        "requestVersion":
            DETERMINISTIC_REQUEST_VERSION,

        "tenantId":
            snapshot.tenant_id,

        "sourceJobId":
            _source_job_id(
                snapshot
            ),

        "watermark":
            snapshot.watermark,

        "detectionStrategyId":
            snapshot.detection_strategy_id,

        "targets": [
            {
                "claimId":
                    claim_id,

                "claimVersion":
                    claim_version,
            }
            for (
                claim_id,
                claim_version,
            )
            in _targets(
                snapshot
            )
        ],
    }

    return hashlib.sha256(
        _canonical_json(
            identity
        ).encode(
            "utf-8"
        )
    ).hexdigest()


def _run_deterministic(
    snapshot: ProspectiveScoringSnapshot,
    *,
    correlation_id: str,
    top_n: int,
) -> dict[str, object]:
    (
        build_bundle,
        DetectionSnapshot,
        run_detection,
    ) = _detection_imports()

    cutoff = _timestamp(
        snapshot.context_cutoff_at,
        "snapshot.context_cutoff_at",
    )

    report = run_detection(
        DetectionSnapshot(
            bundle=build_bundle(
                schemes=(
                    snapshot.schemes
                ),

                members=(
                    snapshot.members
                ),

                providers=(
                    snapshot.providers
                ),

                # Prospective-only:
                # the deterministic engine receives
                # only exact triggering versions.
                claims=(
                    snapshot.target_claims
                ),

                data_dir=Path(
                    "tenant-prospective-snapshot"
                ),
            ),

            tenant_id=(
                snapshot.tenant_id
            ),

            tenant_slug=(
                snapshot.tenant_slug
            ),

            tenant_display_name=(
                snapshot
                .tenant_display_name
            ),

            snapshot_cutoff=(
                cutoff
            ),

            source_type=(
                "mysql_prospective_"
                "claim_versions"
            ),

            source_watermark=(
                snapshot.watermark
            ),

            generation_correlation_id=(
                correlation_id
            ),

            generated_at=_timestamp(
                snapshot.captured_at,
                "snapshot.captured_at",
            ),

            producer_version=(
                "report-producer-0.4.0"
            ),

            historical_window={
                "mode":
                    "aggregate_features_only",

                "contextCutoffAt":
                    cutoff,
            },
        ),

        top_n=(
            top_n
        ),
    )

    claims = report.get(
        "claims"
    )

    if not isinstance(
        claims,
        list,
    ):
        raise DetectionResultContractError(
            "Deterministic engine report "
            "has no claims array."
        )

    versions = dict(
        _targets(
            snapshot
        )
    )

    seen: set[
        str
    ] = set()

    for claim in claims:
        if not isinstance(
            claim,
            dict,
        ):
            raise DetectionResultContractError(
                "Deterministic engine returned "
                "an invalid claim."
            )

        claim_id = _text(
            claim.get(
                "claimId"
            ),
            "report claimId",
        )

        if (
            claim_id not in versions
            or claim_id in seen
        ):
            raise DetectionResultContractError(
                "Deterministic engine claim "
                "coverage is incompatible."
            )

        seen.add(
            claim_id
        )

        claim[
            "claimVersion"
        ] = versions[
            claim_id
        ]

    if seen != set(
        versions
    ):
        raise DetectionResultContractError(
            "Deterministic engine coverage "
            "differs from the target set."
        )

    return report


def _save_deterministic(
    snapshot: ProspectiveScoringSnapshot,
    report: dict[str, object],
    repository: (
        PyMySqlDetectionResultsRepository
    ),
) -> None:
    targets = _targets(
        snapshot
    )

    claims = report.get(
        "claims"
    )

    if not isinstance(
        claims,
        list,
    ):
        raise DetectionResultContractError(
            "Deterministic report has "
            "no claims array."
        )

    decisions: dict[
        tuple[
            str,
            int,
        ],
        dict[
            str,
            object,
        ],
    ] = {}

    for claim in claims:
        if not isinstance(
            claim,
            dict,
        ):
            raise DetectionResultContractError(
                "Deterministic report "
                "claim is invalid."
            )

        target = (
            _text(
                claim.get(
                    "claimId"
                ),
                "claimId",
            ),

            _positive_int(
                claim.get(
                    "claimVersion"
                ),
                "claimVersion",
            ),
        )

        if target in decisions:
            raise DetectionResultContractError(
                "Deterministic report contains "
                "duplicate decisions."
            )

        decisions[
            target
        ] = copy.deepcopy(
            claim
        )

    if set(
        decisions
    ) != set(
        targets
    ):
        raise DetectionResultContractError(
            "Deterministic report coverage "
            "differs from the target set."
        )

    source_job_id = (
        _source_job_id(
            snapshot
        )
    )

    request_id = (
        _deterministic_request_id(
            snapshot
        )
    )

    strategy_id = (
        _positive_int(
            snapshot.detection_strategy_id,
            (
                "snapshot."
                "detection_strategy_id"
            ),
        )
    )

    anchor = min(
        targets
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
        target = (
            claim_id,
            claim_version,
        )

        payload: dict[
            str,
            object,
        ] = {
            "schemaVersion":
                RESULT_PAYLOAD_SCHEMA_VERSION,

            "tenantId":
                snapshot.tenant_id,

            "claimId":
                claim_id,

            "claimVersion":
                claim_version,

            "sourceJobId":
                source_job_id,

            "requestId":
                request_id,

            "watermark":
                snapshot.watermark,

            "analysisMode":
                DETERMINISTIC_ANALYSIS_MODE,

            "strategy": {
                "detectionStrategyId":
                    strategy_id,

                "strategyType":
                    "deterministic_rules",

                "modelDeploymentId":
                    None,
            },

            "decision":
                decisions[
                    target
                ],
        }

        if target == anchor:
            # The complete report is stored once
            # rather than duplicated for every
            # claim in the batch.
            payload[
                "report"
            ] = copy.deepcopy(
                report
            )

        records.append(
            {
                "tenant_id":
                    snapshot.tenant_id,

                "claim_id":
                    claim_id,

                "claim_version":
                    claim_version,

                "detection_strategy_id":
                    strategy_id,

                "strategy_type":
                    "deterministic_rules",

                "model_deployment_id":
                    None,

                "source_job_id":
                    source_job_id,

                "request_id":
                    request_id,

                "analysis_mode":
                    DETERMINISTIC_ANALYSIS_MODE,

                "ensemble_id":
                    None,

                "ensemble_version":
                    None,

                "feature_schema_version":
                    None,

                "result_payload":
                    payload,
            }
        )

    repository.save_result_records(
        records
    )


def _deterministic_from_stored(
    snapshot: ProspectiveScoringSnapshot,
    records: Sequence[
        Mapping[
            str,
            object,
        ]
    ],
) -> dict[str, object]:
    targets = _targets(
        snapshot
    )

    if (
        len(
            records
        )
        != len(
            targets
        )
    ):
        raise DetectionResultIntegrityError(
            "Stored deterministic-result "
            "coverage differs from the "
            "target set."
        )

    source_job_id = (
        _source_job_id(
            snapshot
        )
    )

    strategy_id = (
        _positive_int(
            snapshot.detection_strategy_id,
            (
                "snapshot."
                "detection_strategy_id"
            ),
        )
    )

    request_id = (
        _deterministic_request_id(
            snapshot
        )
    )

    decisions: dict[
        tuple[
            str,
            int,
        ],
        dict[
            str,
            object,
        ],
    ] = {}

    anchored_reports: list[
        dict[
            str,
            object,
        ]
    ] = []

    for index, (
        record,
        target,
    ) in enumerate(
        zip(
            records,
            targets,
            strict=True,
        )
    ):
        (
            claim_id,
            claim_version,
        ) = target

        if (
            record.get(
                "tenant_id"
            )
            != snapshot.tenant_id

            or record.get(
                "claim_id"
            )
            != claim_id

            or int(
                record.get(
                    "claim_version"
                )
                or 0
            )
            != claim_version

            or int(
                record.get(
                    "detection_strategy_id"
                )
                or 0
            )
            != strategy_id

            or record.get(
                "strategy_type"
            )
            != "deterministic_rules"

            or record.get(
                "model_deployment_id"
            )
            is not None

            or record.get(
                "source_job_id"
            )
            != source_job_id

            or record.get(
                "request_id"
            )
            != request_id

            or record.get(
                "analysis_mode"
            )
            != DETERMINISTIC_ANALYSIS_MODE
        ):
            raise DetectionResultIntegrityError(
                "Stored deterministic-result "
                "identity differs from its "
                "snapshot."
            )

        payload = _mapping(
            record.get(
                "result_payload"
            ),
            (
                f"results[{index}]"
                ".payload"
            ),
        )

        strategy = _mapping(
            payload.get(
                "strategy"
            ),
            (
                f"results[{index}]"
                ".strategy"
            ),
        )

        decision = _mapping(
            payload.get(
                "decision"
            ),
            (
                f"results[{index}]"
                ".decision"
            ),
        )

        if (
            payload.get(
                "schemaVersion"
            )
            != RESULT_PAYLOAD_SCHEMA_VERSION

            or payload.get(
                "tenantId"
            )
            != snapshot.tenant_id

            or payload.get(
                "claimId"
            )
            != claim_id

            or payload.get(
                "claimVersion"
            )
            != claim_version

            or payload.get(
                "sourceJobId"
            )
            != source_job_id

            or payload.get(
                "requestId"
            )
            != request_id

            or payload.get(
                "watermark"
            )
            != snapshot.watermark

            or payload.get(
                "analysisMode"
            )
            != DETERMINISTIC_ANALYSIS_MODE

            or strategy
            != {
                "detectionStrategyId":
                    strategy_id,

                "strategyType":
                    "deterministic_rules",

                "modelDeploymentId":
                    None,
            }

            or decision.get(
                "claimId"
            )
            != claim_id

            or decision.get(
                "claimVersion"
            )
            != claim_version
        ):
            raise DetectionResultIntegrityError(
                "Stored deterministic payload "
                "differs from its row."
            )

        decisions[
            target
        ] = decision

        if "report" in payload:
            anchored_reports.append(
                _mapping(
                    payload.get(
                        "report"
                    ),
                    (
                        f"results[{index}]"
                        ".report"
                    ),
                )
            )

    if len(
        anchored_reports
    ) != 1:
        raise DetectionResultIntegrityError(
            "Stored deterministic results "
            "must contain exactly one "
            "report anchor."
        )

    report = copy.deepcopy(
        anchored_reports[0]
    )

    report_claims = report.get(
        "claims"
    )

    if not isinstance(
        report_claims,
        list,
    ):
        raise DetectionResultIntegrityError(
            "Stored deterministic report "
            "has no claims array."
        )

    report_decisions: dict[
        tuple[
            str,
            int,
        ],
        dict[
            str,
            object,
        ],
    ] = {}

    for claim in report_claims:
        if not isinstance(
            claim,
            dict,
        ):
            raise DetectionResultIntegrityError(
                "Stored deterministic report "
                "contains an invalid claim."
            )

        target = (
            _text(
                claim.get(
                    "claimId"
                ),
                (
                    "stored report "
                    "claimId"
                ),
            ),

            _positive_int(
                claim.get(
                    "claimVersion"
                ),
                (
                    "stored report "
                    "claimVersion"
                ),
            ),
        )

        if target in report_decisions:
            raise DetectionResultIntegrityError(
                "Stored deterministic report "
                "contains duplicate claims."
            )

        report_decisions[
            target
        ] = claim

    if set(
        report_decisions
    ) != set(
        targets
    ):
        raise DetectionResultIntegrityError(
            "Stored deterministic report "
            "coverage differs from the "
            "target set."
        )

    for target in targets:
        if (
            _canonical_json(
                report_decisions[
                    target
                ]
            )
            != _canonical_json(
                decisions[
                    target
                ]
            )
        ):
            raise DetectionResultIntegrityError(
                "Stored deterministic report "
                "differs from its claim "
                "decisions."
            )

    metadata = _mapping(
        report.get(
            "metadata"
        ),
        (
            "stored report "
            "metadata"
        ),
    )

    tenant = _mapping(
        metadata.get(
            "tenant"
        ),
        (
            "stored report "
            "tenant"
        ),
    )

    source = _mapping(
        metadata.get(
            "source"
        ),
        (
            "stored report "
            "source"
        ),
    )

    if (
        tenant.get(
            "tenantId"
        )
        != snapshot.tenant_id

        or source.get(
            "watermark"
        )
        != snapshot.watermark

        or metadata.get(
            "snapshotCutoff"
        )
        != _timestamp(
            snapshot.context_cutoff_at,
            (
                "snapshot."
                "context_cutoff_at"
            ),
        )
    ):
        raise DetectionResultIntegrityError(
            "Stored deterministic report "
            "identity differs from its "
            "snapshot."
        )

    return report


def _deterministic_report(
    snapshot: ProspectiveScoringSnapshot,
    *,
    correlation_id: str,
    top_n: int,
    repository: (
        PyMySqlDetectionResultsRepository
    ),
) -> dict[str, object]:
    targets = _targets(
        snapshot
    )

    if (
        _stored_state(
            repository,
            snapshot,
            targets,
        )
        == "absent"
    ):
        report = _run_deterministic(
            snapshot,
            correlation_id=(
                correlation_id
            ),
            top_n=(
                top_n
            ),
        )

        _save_deterministic(
            snapshot,
            report,
            repository,
        )

    return _deterministic_from_stored(
        snapshot,

        _load_results(
            repository,
            snapshot,
            targets,
        ),
    )


def build_report_from_tenant_snapshot(
    snapshot: ProspectiveScoringSnapshot,
    *,
    correlation_id: str,
    top_n: int = 10,
    model_client: (
        ModelServiceClient
        | None
    ) = None,
    results_repository: (
        PyMySqlDetectionResultsRepository
        | None
    ) = None,
) -> dict[str, object]:
    if not isinstance(
        snapshot,
        ProspectiveScoringSnapshot,
    ):
        raise DetectionResultContractError(
            "A prospective scoring "
            "snapshot is required."
        )

    if results_repository is None:
        raise DetectionResultContractError(
            "An immutable detection-results "
            "repository is required."
        )

    correlation_id = _text(
        correlation_id,
        "correlation_id",
    )

    top_n = _positive_int(
        top_n,
        "top_n",
    )

    if (
        snapshot.detection_strategy
        == "approved_model"
    ):
        return _approved_model_report(
            snapshot,

            correlation_id=(
                correlation_id
            ),

            model_client=(
                model_client
            ),

            repository=(
                results_repository
            ),
        )

    if (
        snapshot.detection_strategy
        == "deterministic_rules"
    ):
        if model_client is not None:
            raise DetectionResultContractError(
                "Deterministic scoring cannot "
                "use a model client."
            )

        return _deterministic_report(
            snapshot,

            correlation_id=(
                correlation_id
            ),

            top_n=(
                top_n
            ),

            repository=(
                results_repository
            ),
        )

    raise DetectionResultContractError(
        "The selected detection strategy "
        "is unsupported."
    )
