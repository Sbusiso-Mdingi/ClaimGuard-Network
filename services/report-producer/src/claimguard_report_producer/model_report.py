from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation

from .contract import ReportContractError
from .model_service import ClaimReviewResult, ReviewWindowResult
from .snapshot import ProspectiveScoringSnapshot


REPORT_CONTRACT_VERSION = "1.0"
MODEL_REPORT_ENGINE_VERSION = "claim-review-consumer-1.1.0"
DEFAULT_PRODUCER_VERSION = "report-producer-0.4.0"
RISK_SCORE_BASIS = "THRESHOLD_NORMALIZED_MAX_COMPONENT"
SOURCE_TYPE = "mysql_prospective_claim_versions"


class ModelReportContractError(ReportContractError):
    code = "MODEL_REPORT_CONTRACT_INVALID"


def _required_text(
    value: object,
    field: str,
    maximum: int | None = None,
) -> str:
    rendered = str(value or "").strip()

    if not rendered:
        raise ModelReportContractError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise ModelReportContractError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _positive_integer(
    value: object,
    field: str,
) -> int:
    if isinstance(value, bool):
        raise ModelReportContractError(
            f"{field} must be a positive integer."
        )

    try:
        parsed = int(value)

    except (
        TypeError,
        ValueError,
    ) as error:
        raise ModelReportContractError(
            f"{field} must be a positive integer."
        ) from error

    if (
        parsed <= 0
        or parsed > 2_147_483_647
        or (
            isinstance(value, float)
            and not value.is_integer()
        )
    ):
        raise ModelReportContractError(
            f"{field} must be a positive integer."
        )

    return parsed


def _finite_float(
    value: object,
    field: str,
) -> float:
    if isinstance(value, bool):
        raise ModelReportContractError(
            f"{field} must be a finite number."
        )

    try:
        parsed = float(value)

    except (
        TypeError,
        ValueError,
    ) as error:
        raise ModelReportContractError(
            f"{field} must be a finite number."
        ) from error

    if not math.isfinite(parsed):
        raise ModelReportContractError(
            f"{field} must be a finite number."
        )

    return parsed


def _probability(
    value: object,
    field: str,
) -> float:
    parsed = _finite_float(
        value,
        field,
    )

    if not 0 <= parsed <= 1:
        raise ModelReportContractError(
            f"{field} must be a probability."
        )

    return parsed


def _require_boolean(
    value: object,
    field: str,
) -> bool:
    if not isinstance(value, bool):
        raise ModelReportContractError(
            f"{field} must be a boolean."
        )

    return value


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
        else str(value or "").strip()
    )

    try:
        parsed = datetime.fromisoformat(
            rendered.replace(
                "Z",
                "+00:00",
            )
        )

    except ValueError as error:
        raise ModelReportContractError(
            f"{field} must be an ISO timestamp."
        ) from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    ).isoformat()


def _date(
    value: object,
    field: str,
) -> str:
    rendered = (
        value.isoformat()
        if hasattr(
            value,
            "isoformat",
        )
        else str(value or "").strip()
    )

    try:
        return date.fromisoformat(
            rendered
        ).isoformat()

    except ValueError as error:
        raise ModelReportContractError(
            f"{field} must be an ISO calendar date."
        ) from error


def _amount(
    value: object,
    field: str,
) -> float:
    try:
        parsed = Decimal(
            str(value)
        )

    except (
        InvalidOperation,
        TypeError,
        ValueError,
    ) as error:
        raise ModelReportContractError(
            f"{field} must be a positive "
            "monetary amount."
        ) from error

    if (
        not parsed.is_finite()
        or parsed <= 0
    ):
        raise ModelReportContractError(
            f"{field} must be a positive "
            "monetary amount."
        )

    return float(
        parsed.quantize(
            Decimal("0.01")
        )
    )


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
        raise ModelReportContractError(
            "Model report data must be finite JSON."
        ) from error


def _severity(
    score: float | None,
) -> str | None:
    if score is None:
        return None

    if score >= 70:
        return "High"

    if score >= 40:
        return "Medium"

    return "Low"


def _component_index(
    probability: float,
    threshold: float,
) -> float:
    if threshold == 0:
        return 100.0

    return min(
        100.0,
        70.0
        * probability
        / threshold,
    )


def _risk_index(
    score: ClaimReviewResult,
) -> float:
    value = max(
        _component_index(
            float(
                score
                .baseline_fraud_probability
            ),
            float(
                score.baseline_threshold
            ),
        ),
        _component_index(
            float(
                score.ring_probability
            ),
            float(
                score.ring_threshold
            ),
        ),
        _component_index(
            float(
                score.phantom_probability
            ),
            float(
                score.phantom_threshold
            ),
        ),
    )

    if not math.isfinite(value):
        raise ModelReportContractError(
            "Model report produced a "
            "non-finite risk index."
        )

    return round(
        value,
        3,
    )


def _claim_reasons(
    score: ClaimReviewResult,
) -> list[str]:
    reasons: list[str] = []

    if (
        score.baseline_predicted_class
        == "FRAUD"
    ):
        reasons.append(
            "Baseline learned detector "
            "reached its review threshold"
        )

    if score.ring_review_hit:
        reasons.append(
            "Ring-risk component reached "
            "its review threshold"
        )

    if score.phantom_review_hit:
        reasons.append(
            "Specialised phantom-service "
            "component reached its review threshold"
        )

    return reasons


def _index_rows(
    rows: object,
    *,
    id_field: str,
    collection: str,
    maximum: int,
) -> dict[
    str,
    dict[str, object],
]:
    if not isinstance(
        rows,
        list,
    ):
        raise ModelReportContractError(
            f"snapshot.{collection} must be an array."
        )

    indexed: dict[
        str,
        dict[str, object],
    ] = {}

    for index, row in enumerate(
        rows
    ):
        if not isinstance(
            row,
            dict,
        ):
            raise ModelReportContractError(
                f"snapshot.{collection}"
                f"[{index}] must be an object."
            )

        identifier = _required_text(
            row.get(
                id_field
            ),
            (
                f"snapshot.{collection}"
                f"[{index}].{id_field}"
            ),
            maximum,
        )

        if identifier in indexed:
            raise ModelReportContractError(
                "Snapshot contains duplicate "
                f"{collection} identifier "
                f"{identifier}."
            )

        indexed[
            identifier
        ] = row

    return indexed


def _target_index(
    snapshot: ProspectiveScoringSnapshot,
) -> tuple[
    tuple[
        tuple[str, int],
        ...,
    ],
    dict[
        tuple[str, int],
        dict[str, object],
    ],
]:
    if (
        not isinstance(
            snapshot.target_claims,
            list,
        )
        or not snapshot.target_claims
    ):
        raise ModelReportContractError(
            "Snapshot must contain target "
            "claim versions."
        )

    ordered: list[
        tuple[str, int]
    ] = []

    indexed: dict[
        tuple[str, int],
        dict[str, object],
    ] = {}

    claim_ids: set[
        str
    ] = set()

    for index, claim in enumerate(
        snapshot.target_claims
    ):
        if not isinstance(
            claim,
            dict,
        ):
            raise ModelReportContractError(
                f"snapshot.target_claims"
                f"[{index}] must be an object."
            )

        claim_id = _required_text(
            claim.get(
                "claim_id"
            ),
            (
                f"snapshot.target_claims"
                f"[{index}].claim_id"
            ),
            128,
        )

        claim_version = (
            _positive_integer(
                claim.get(
                    "claim_version"
                ),
                (
                    f"snapshot.target_claims"
                    f"[{index}].claim_version"
                ),
            )
        )

        target = (
            claim_id,
            claim_version,
        )

        if (
            target in indexed
            or claim_id in claim_ids
        ):
            raise ModelReportContractError(
                "Snapshot contains a duplicate "
                "or ambiguous target for "
                f"{claim_id}."
            )

        indexed[
            target
        ] = claim

        ordered.append(
            target
        )

        claim_ids.add(
            claim_id
        )

    return (
        tuple(
            ordered
        ),
        indexed,
    )


def _validate_score(
    score: object,
    index: int,
) -> tuple[str, int]:
    if not isinstance(
        score,
        ClaimReviewResult,
    ):
        raise ModelReportContractError(
            f"review.scores[{index}] has an "
            "unsupported representation."
        )

    claim_id = _required_text(
        score.claim_id,
        (
            f"review.scores[{index}]"
            ".claim_id"
        ),
        128,
    )

    claim_version = (
        _positive_integer(
            score.claim_version,
            (
                f"review.scores[{index}]"
                ".claim_version"
            ),
        )
    )

    baseline = _probability(
        score.baseline_fraud_probability,
        (
            f"review.scores[{index}]"
            ".baseline_fraud_probability"
        ),
    )

    baseline_threshold = (
        _probability(
            score.baseline_threshold,
            (
                f"review.scores[{index}]"
                ".baseline_threshold"
            ),
        )
    )

    ring = _probability(
        score.ring_probability,
        (
            f"review.scores[{index}]"
            ".ring_probability"
        ),
    )

    ring_threshold = (
        _probability(
            score.ring_threshold,
            (
                f"review.scores[{index}]"
                ".ring_threshold"
            ),
        )
    )

    phantom = _probability(
        score.phantom_probability,
        (
            f"review.scores[{index}]"
            ".phantom_probability"
        ),
    )

    phantom_threshold = (
        _probability(
            score.phantom_threshold,
            (
                f"review.scores[{index}]"
                ".phantom_threshold"
            ),
        )
    )

    ring_hit = _require_boolean(
        score.ring_review_hit,
        (
            f"review.scores[{index}]"
            ".ring_review_hit"
        ),
    )

    phantom_hit = _require_boolean(
        score.phantom_review_hit,
        (
            f"review.scores[{index}]"
            ".phantom_review_hit"
        ),
    )

    composite = _require_boolean(
        score.composite_review_recommended,
        (
            f"review.scores[{index}]"
            ".composite_review_recommended"
        ),
    )

    predicted_class = _required_text(
        score.baseline_predicted_class,
        (
            f"review.scores[{index}]"
            ".baseline_predicted_class"
        ),
        32,
    )

    if predicted_class not in {
        "FRAUD",
        "LEGITIMATE",
    }:
        raise ModelReportContractError(
            "Model review contains an unsupported "
            "baseline class."
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
        raise ModelReportContractError(
            "Model review decisions differ "
            "from their thresholds."
        )

    return (
        claim_id,
        claim_version,
    )


def _review_index(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
    targets: tuple[
        tuple[str, int],
        ...,
    ],
) -> dict[
    tuple[str, int],
    ClaimReviewResult,
]:
    if not isinstance(
        review,
        ReviewWindowResult,
    ):
        raise ModelReportContractError(
            "A model ReviewWindowResult is required."
        )

    if (
        review.watermark
        != snapshot.watermark
    ):
        raise ModelReportContractError(
            "Model review watermark differs "
            "from its tenant snapshot."
        )

    if (
        review.deployment_id
        != snapshot.model_deployment_id
    ):
        raise ModelReportContractError(
            "Model review deployment differs "
            "from its tenant snapshot."
        )

    _required_text(
        review.ensemble_id,
        "review.ensemble_id",
        128,
    )

    _required_text(
        review.ensemble_version,
        "review.ensemble_version",
        64,
    )

    _required_text(
        review.feature_schema_version,
        "review.feature_schema_version",
        128,
    )

    _required_text(
        review.analysis_mode,
        "review.analysis_mode",
        64,
    )

    _required_text(
        review.request_id,
        "review.request_id",
        128,
    )

    if (
        not isinstance(
            review.scores,
            tuple,
        )
        or not review.scores
    ):
        raise ModelReportContractError(
            "Model review must contain scores."
        )

    indexed: dict[
        tuple[str, int],
        ClaimReviewResult,
    ] = {}

    order: list[
        tuple[str, int]
    ] = []

    for index, score in enumerate(
        review.scores
    ):
        target = _validate_score(
            score,
            index,
        )

        if target in indexed:
            raise ModelReportContractError(
                "Model review contains duplicate "
                f"score {target[0]}@{target[1]}."
            )

        indexed[
            target
        ] = score

        order.append(
            target
        )

    if (
        tuple(order) != targets
        or set(indexed) != set(targets)
    ):
        raise ModelReportContractError(
            "Model review coverage or ordering "
            "differs from its tenant snapshot."
        )

    thresholds = {
        (
            float(
                score.baseline_threshold
            ),
            float(
                score.ring_threshold
            ),
            float(
                score.phantom_threshold
            ),
        )
        for score in review.scores
    }

    if len(thresholds) != 1:
        raise ModelReportContractError(
            "Model review thresholds differ "
            "across target claims."
        )

    return indexed


def _stable_report_id(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
    targets: tuple[
        tuple[str, int],
        ...,
    ],
) -> str:
    identity = {
        "contractVersion":
            REPORT_CONTRACT_VERSION,

        "engineVersion":
            MODEL_REPORT_ENGINE_VERSION,

        "tenantId":
            snapshot.tenant_id,

        "watermark":
            snapshot.watermark,

        "contextCutoffAt":
            _timestamp(
                snapshot.context_cutoff_at,
                "snapshot.context_cutoff_at",
            ),

        "detectionStrategyId":
            snapshot.detection_strategy_id,

        "strategyType":
            snapshot.detection_strategy,

        "deploymentId":
            review.deployment_id,

        "ensembleId":
            review.ensemble_id,

        "ensembleVersion":
            review.ensemble_version,

        "featureSchemaVersion":
            review.feature_schema_version,

        "analysisMode":
            review.analysis_mode,

        "requestId":
            review.request_id,

        "sourceJobIds":
            list(
                snapshot.source_job_ids
            ),

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
            in targets
        ],
    }

    return hashlib.sha256(
        _canonical_json(
            identity
        ).encode(
            "utf-8"
        )
    ).hexdigest()


def _provider_rows(
    providers: dict[
        str,
        dict[str, object],
    ],
    risks: dict[
        str,
        list[float],
    ],
    review_counts: dict[
        str,
        int,
    ],
) -> list[
    dict[str, object]
]:
    result: list[
        dict[str, object]
    ] = []

    for provider_id in sorted(
        risks
    ):
        provider = providers[
            provider_id
        ]

        values = risks[
            provider_id
        ]

        risk_score = round(
            max(values),
            3,
        )

        review_count = (
            review_counts[
                provider_id
            ]
        )

        result.append(
            {
                "providerId":
                    provider_id,

                "schemeId":
                    str(
                        provider[
                            "scheme_id"
                        ]
                    ),

                "specialty":
                    str(
                        provider.get(
                            "specialty"
                        )
                        or ""
                    ),

                "riskScore":
                    risk_score,

                "severity":
                    _severity(
                        risk_score
                    ),

                "reasons":
                    (
                        [
                            f"{review_count} claim(s) "
                            "reached a learned-model "
                            "review threshold"
                        ]
                        if review_count
                        else []
                    ),

                "category":
                    "model_review",

                "claimStatistics": {
                    "claim_count":
                        len(values),

                    "review_recommended_count":
                        review_count,

                    "maximum_claim_risk_index":
                        risk_score,
                },

                "networkMetrics":
                    {},
            }
        )

    return result


def _member_rows(
    members: dict[
        str,
        dict[str, object],
    ],
    risks: dict[
        str,
        list[float],
    ],
    review_counts: dict[
        str,
        int,
    ],
) -> list[
    dict[str, object]
]:
    result: list[
        dict[str, object]
    ] = []

    for member_id in sorted(
        risks
    ):
        member = members[
            member_id
        ]

        values = risks[
            member_id
        ]

        risk_score = round(
            max(values),
            3,
        )

        review_count = (
            review_counts[
                member_id
            ]
        )

        result.append(
            {
                "memberId":
                    member_id,

                "schemeId":
                    str(
                        member[
                            "scheme_id"
                        ]
                    ),

                "riskScore":
                    risk_score,

                "severity":
                    _severity(
                        risk_score
                    ),

                "reasons":
                    (
                        [
                            f"{review_count} claim(s) "
                            "reached a learned-model "
                            "review threshold"
                        ]
                        if review_count
                        else []
                    ),

                "category":
                    "model_review",

                "utilizationStatistics": {
                    "claim_count":
                        len(values),

                    "review_recommended_count":
                        review_count,

                    "maximum_claim_risk_index":
                        risk_score,
                },
            }
        )

    return result


def build_model_detection_report(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
    *,
    correlation_id: str,
    producer_version: str = (
        DEFAULT_PRODUCER_VERSION
    ),
) -> dict[str, object]:
    if not isinstance(
        snapshot,
        ProspectiveScoringSnapshot,
    ):
        raise ModelReportContractError(
            "A ProspectiveScoringSnapshot "
            "is required."
        )

    if (
        snapshot.detection_strategy
        != "approved_model"
    ):
        raise ModelReportContractError(
            "Model reports require the "
            "approved_model strategy."
        )

    correlation_id = _required_text(
        correlation_id,
        "correlation_id",
        128,
    )

    producer_version = _required_text(
        producer_version,
        "producer_version",
        128,
    )

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
        raise ModelReportContractError(
            "A model report must identify "
            "exactly one source job."
        )

    source_job_id = _required_text(
        snapshot.source_job_ids[0],
        "snapshot.source_job_ids[0]",
        64,
    )

    _positive_integer(
        snapshot.detection_strategy_id,
        "snapshot.detection_strategy_id",
    )

    targets, target_claims = (
        _target_index(
            snapshot
        )
    )

    scores = _review_index(
        snapshot,
        review,
        targets,
    )

    schemes = _index_rows(
        snapshot.schemes,
        id_field="scheme_id",
        collection="schemes",
        maximum=64,
    )

    members = _index_rows(
        snapshot.members,
        id_field="member_id",
        collection="members",
        maximum=128,
    )

    providers = _index_rows(
        snapshot.providers,
        id_field="provider_id",
        collection="providers",
        maximum=128,
    )

    provider_risks: dict[
        str,
        list[float],
    ] = defaultdict(list)

    provider_reviews: dict[
        str,
        int,
    ] = defaultdict(int)

    member_risks: dict[
        str,
        list[float],
    ] = defaultdict(list)

    member_reviews: dict[
        str,
        int,
    ] = defaultdict(int)

    claims: list[
        dict[str, object]
    ] = []

    edges: list[
        dict[str, object]
    ] = []

    service_dates: list[
        str
    ] = []

    scheme_ids: set[
        str
    ] = set()

    for (
        claim_id,
        claim_version,
    ) in sorted(
        targets
    ):
        target = (
            claim_id,
            claim_version,
        )

        claim = target_claims[
            target
        ]

        score = scores[
            target
        ]

        scheme_id = _required_text(
            claim.get(
                "scheme_id"
            ),
            (
                f"claim {claim_id}"
                ".scheme_id"
            ),
            64,
        )

        member_id = _required_text(
            claim.get(
                "member_id"
            ),
            (
                f"claim {claim_id}"
                ".member_id"
            ),
            128,
        )

        provider_id = _required_text(
            claim.get(
                "provider_id"
            ),
            (
                f"claim {claim_id}"
                ".provider_id"
            ),
            128,
        )

        if scheme_id not in schemes:
            raise ModelReportContractError(
                f"Claim {claim_id} references "
                "an unknown scheme."
            )

        if (
            member_id not in members
            or members[
                member_id
            ].get(
                "scheme_id"
            )
            != scheme_id
        ):
            raise ModelReportContractError(
                f"Claim {claim_id} references "
                "an invalid member."
            )

        if (
            provider_id not in providers
            or providers[
                provider_id
            ].get(
                "scheme_id"
            )
            != scheme_id
        ):
            raise ModelReportContractError(
                f"Claim {claim_id} references "
                "an invalid provider."
            )

        service_date = _date(
            claim.get(
                "service_date"
            ),
            (
                f"claim {claim_id}"
                ".service_date"
            ),
        )

        risk_score = _risk_index(
            score
        )

        provider_risks[
            provider_id
        ].append(
            risk_score
        )

        member_risks[
            member_id
        ].append(
            risk_score
        )

        if (
            score
            .composite_review_recommended
        ):
            provider_reviews[
                provider_id
            ] += 1

            member_reviews[
                member_id
            ] += 1

        service_dates.append(
            service_date
        )

        scheme_ids.add(
            scheme_id
        )

        claims.append(
            {
                "claimId":
                    claim_id,

                "claimVersion":
                    claim_version,

                "providerId":
                    provider_id,

                "memberId":
                    member_id,

                "schemeId":
                    scheme_id,

                "serviceDate":
                    service_date,

                "amount":
                    _amount(
                        claim.get(
                            "amount"
                        ),
                        (
                            f"claim {claim_id}"
                            ".amount"
                        ),
                    ),

                "riskScore":
                    risk_score,

                "severity":
                    _severity(
                        risk_score
                    ),

                "reasons":
                    _claim_reasons(
                        score
                    ),

                "ruleHits":
                    [],

                "evidenceReferences":
                    [],

                "processingStatus":
                    (
                        "REVIEW_RECOMMENDED"
                        if (
                            score
                            .composite_review_recommended
                        )
                        else "NO_MODEL_REVIEW"
                    ),

                "modelReview": {
                    "baselineFraudProbability":
                        float(
                            score
                            .baseline_fraud_probability
                        ),

                    "baselinePredictedClass":
                        score
                        .baseline_predicted_class,

                    "baselineThreshold":
                        float(
                            score
                            .baseline_threshold
                        ),

                    "ringProbability":
                        float(
                            score
                            .ring_probability
                        ),

                    "ringReviewHit":
                        score
                        .ring_review_hit,

                    "ringThreshold":
                        float(
                            score
                            .ring_threshold
                        ),

                    "phantomProbability":
                        float(
                            score
                            .phantom_probability
                        ),

                    "phantomReviewHit":
                        score
                        .phantom_review_hit,

                    "phantomThreshold":
                        float(
                            score
                            .phantom_threshold
                        ),

                    "compositeReviewRecommended":
                        score
                        .composite_review_recommended,
                },
            }
        )

        edges.append(
            {
                "relationship_type":
                    "submitted_to",

                "source_entity_id":
                    f"claimant:{member_id}",

                "target_entity_id":
                    f"provider:{provider_id}",

                "claim_id":
                    claim_id,

                "claim_version":
                    claim_version,
            }
        )

    report_providers = _provider_rows(
        providers,
        provider_risks,
        provider_reviews,
    )

    report_members = _member_rows(
        members,
        member_risks,
        member_reviews,
    )

    graph_nodes = [
        *[
            {
                "entity_id":
                    f"claimant:{member_id}",

                "entity_type":
                    "claimant",
            }
            for member_id
            in sorted(
                member_risks
            )
        ],

        *[
            {
                "entity_id":
                    f"provider:{provider_id}",

                "entity_type":
                    "provider",
            }
            for provider_id
            in sorted(
                provider_risks
            )
        ],
    ]

    claim_scores = [
        float(
            claim[
                "riskScore"
            ]
        )
        for claim
        in claims
    ]

    review_count = sum(
        1
        for score
        in review.scores
        if (
            score
            .composite_review_recommended
        )
    )

    risk_distribution = {
        "low":
            sum(
                score < 40
                for score
                in claim_scores
            ),

        "medium":
            sum(
                40 <= score < 70
                for score
                in claim_scores
            ),

        "high":
            sum(
                score >= 70
                for score
                in claim_scores
            ),
    }

    average_risk = round(
        sum(
            claim_scores
        )
        / len(
            claim_scores
        ),
        3,
    )

    active_components = sum(
        (
            any(
                (
                    score
                    .baseline_predicted_class
                    == "FRAUD"
                )
                for score
                in review.scores
            ),

            any(
                score.ring_review_hit
                for score
                in review.scores
            ),

            any(
                score.phantom_review_hit
                for score
                in review.scores
            ),
        )
    )

    context_cutoff = _timestamp(
        snapshot.context_cutoff_at,
        "snapshot.context_cutoff_at",
    )

    generated_at = _timestamp(
        snapshot.captured_at,
        "snapshot.captured_at",
    )

    thresholds = review.scores[
        0
    ]

    report = {
        "contractVersion":
            REPORT_CONTRACT_VERSION,

        "metadata": {
            "reportId":
                _stable_report_id(
                    snapshot,
                    review,
                    targets,
                ),

            "tenant": {
                "tenantId":
                    snapshot.tenant_id,

                "tenantSlug":
                    snapshot.tenant_slug,

                "displayName":
                    snapshot
                    .tenant_display_name,
            },

            "generatedAt":
                generated_at,

            "snapshotCutoff":
                context_cutoff,

            "source": {
                "type":
                    SOURCE_TYPE,

                "watermark":
                    snapshot.watermark,

                "historicalWindow": {
                    "mode":
                        "aggregate_features_only",

                    "contextCutoffAt":
                        context_cutoff,
                },

                "sourceJobIds": [
                    source_job_id
                ],
            },

            "includedCounts": {
                "claims":
                    len(
                        claims
                    ),

                "providers":
                    len(
                        report_providers
                    ),

                "members":
                    len(
                        report_members
                    ),
            },

            "includedDateRange": {
                "from":
                    min(
                        service_dates
                    ),

                "to":
                    max(
                        service_dates
                    ),
            },

            "detectionEngineVersion":
                MODEL_REPORT_ENGINE_VERSION,

            "producerVersion":
                producer_version,

            "generationCorrelationId":
                correlation_id,

            "detectionStrategy": {
                "detectionStrategyId":
                    snapshot
                    .detection_strategy_id,

                "strategyType":
                    snapshot
                    .detection_strategy,
            },

            "model": {
                "deploymentId":
                    review.deployment_id,

                "ensembleId":
                    review.ensemble_id,

                "ensembleVersion":
                    review.ensemble_version,

                "featureSchemaVersion":
                    review
                    .feature_schema_version,

                "analysisMode":
                    review.analysis_mode,

                "requestId":
                    review.request_id,

                "riskScoreBasis":
                    RISK_SCORE_BASIS,
            },
        },

        "summary": {
            "totalClaims":
                len(
                    claims
                ),

            "totalClaimedAmount":
                round(
                    sum(
                        float(
                            claim[
                                "amount"
                            ]
                        )
                        for claim
                        in claims
                    ),
                    2,
                ),

            "highRiskClaims":
                review_count,

            "flaggedProviders":
                sum(
                    value > 0
                    for value
                    in provider_reviews.values()
                ),

            "flaggedMembers":
                sum(
                    value > 0
                    for value
                    in member_reviews.values()
                ),

            "activeFraudPatterns":
                active_components,

            "averageRiskScore":
                average_risk,

            "riskDistribution":
                risk_distribution,
        },

        "claims":
            claims,

        "providers":
            report_providers,

        "members":
            report_members,

        "graph": {
            "nodes":
                graph_nodes,

            "edges":
                edges,

            "summary": {
                "entity_count":
                    len(
                        graph_nodes
                    ),

                "relationship_count":
                    len(
                        edges
                    ),

                "claimant_count":
                    len(
                        report_members
                    ),

                "provider_count":
                    len(
                        report_providers
                    ),
            },
        },

        "risk": {
            "riskScore":
                average_risk,

            "severity":
                _severity(
                    average_risk
                ),

            "reasons":
                (
                    [
                        f"{review_count} claim(s) "
                        "require learned-model review"
                    ]
                    if review_count
                    else []
                ),

            "highRiskClaims":
                review_count,

            "activeFraudPatterns":
                active_components,
        },

        "history": {
            "schemeMetrics": [
                {
                    "schemeId":
                        scheme_id,

                    "targetClaimCount":
                        sum(
                            (
                                claim[
                                    "schemeId"
                                ]
                                == scheme_id
                            )
                            for claim
                            in claims
                        ),
                }
                for scheme_id
                in sorted(
                    scheme_ids
                )
            ],

            "ruleExecution": {
                "triggeredRules":
                    [],

                "triggeredRuleCount":
                    0,

                "notExecuted":
                    True,
            },

            "modelExecution": {
                "deploymentId":
                    review.deployment_id,

                "ensembleId":
                    review.ensemble_id,

                "ensembleVersion":
                    review.ensemble_version,

                "featureSchemaVersion":
                    review
                    .feature_schema_version,

                "analysisMode":
                    review.analysis_mode,

                "requestId":
                    review.request_id,

                "windowWatermark":
                    review.watermark,

                "reviewRecommendedClaims":
                    review_count,

                "baselineThreshold":
                    float(
                        thresholds
                        .baseline_threshold
                    ),

                "ringThreshold":
                    float(
                        thresholds
                        .ring_threshold
                    ),

                "phantomThreshold":
                    float(
                        thresholds
                        .phantom_threshold
                    ),
            },

            "evaluation": {
                "available":
                    False,

                "message":
                    (
                        "Production tenant reports "
                        "do not contain ground truth."
                    ),
            },

            "timings":
                None,
        },
    }

    _canonical_json(
        report
    )

    return report
