from __future__ import annotations

import math
from typing import Mapping, Sequence

from .detection_results import (
    DetectionResultContractError,
    DetectionResultIntegrityError,
    PyMySqlDetectionResultsRepository,
    RESULT_PAYLOAD_SCHEMA_VERSION,
)
from .prospective_model_service import (
    ANALYSIS_MODE,
    FEATURE_SCHEMA_VERSION,
    MODEL_ID,
    MODEL_VERSION,
    ProspectiveClaimScore,
    ProspectiveModelServiceClient,
    ProspectiveScreeningResult,
)
from .snapshot import ProspectiveScoringSnapshot


def _targets(
    snapshot: ProspectiveScoringSnapshot,
) -> tuple[tuple[str, int], ...]:
    if not isinstance(snapshot.target_claims, list) or not snapshot.target_claims:
        raise DetectionResultContractError(
            "A prospective scoring snapshot must contain target claim versions."
        )

    result: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for index, claim in enumerate(snapshot.target_claims):
        if not isinstance(claim, dict):
            raise DetectionResultContractError(
                f"snapshot.target_claims[{index}] must be an object."
            )
        claim_id = str(claim.get("claim_id") or "").strip()
        try:
            claim_version = int(claim.get("claim_version"))
        except (TypeError, ValueError) as error:
            raise DetectionResultContractError(
                f"snapshot.target_claims[{index}].claim_version is invalid."
            ) from error
        reference = (claim_id, claim_version)
        if not claim_id or claim_version <= 0 or reference in seen:
            raise DetectionResultContractError(
                "Prospective target claim-version references must be unique and valid."
            )
        seen.add(reference)
        result.append(reference)
    return tuple(result)


def _source_job_id(snapshot: ProspectiveScoringSnapshot) -> str:
    if not isinstance(snapshot.source_job_ids, tuple) or len(snapshot.source_job_ids) != 1:
        raise DetectionResultContractError(
            "A prospective scoring snapshot must identify exactly one source job."
        )
    value = str(snapshot.source_job_ids[0] or "").strip()
    if not value:
        raise DetectionResultContractError("The prospective source job ID is required.")
    return value


def _probability(value: object, field: str) -> float:
    if isinstance(value, bool):
        raise DetectionResultIntegrityError(f"{field} must be a probability.")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise DetectionResultIntegrityError(
            f"{field} must be a probability."
        ) from error
    if not math.isfinite(parsed) or not 0 <= parsed <= 1:
        raise DetectionResultIntegrityError(f"{field} must be a probability.")
    return parsed


def _records(
    snapshot: ProspectiveScoringSnapshot,
    result: ProspectiveScreeningResult,
) -> list[dict[str, object]]:
    targets = _targets(snapshot)
    source_job_id = _source_job_id(snapshot)

    if snapshot.detection_strategy != "approved_model":
        raise DetectionResultContractError(
            "Prospective model results require the approved_model strategy."
        )
    if result.deployment_id != snapshot.model_deployment_id:
        raise DetectionResultContractError(
            "Prospective model deployment differs from the pinned snapshot."
        )
    if result.watermark != snapshot.watermark:
        raise DetectionResultContractError(
            "Prospective model watermark differs from the pinned snapshot."
        )
    if (
        result.model_id != MODEL_ID
        or result.model_version != MODEL_VERSION
        or result.feature_schema_version != FEATURE_SCHEMA_VERSION
        or result.analysis_mode != ANALYSIS_MODE
    ):
        raise DetectionResultContractError(
            "Prospective model identity differs from the approved baseline contract."
        )

    by_target = {
        (score.claim_id, score.claim_version): score
        for score in result.scores
    }
    if tuple(by_target) != targets or len(by_target) != len(result.scores):
        raise DetectionResultContractError(
            "Prospective model score coverage or ordering differs from the snapshot."
        )

    records: list[dict[str, object]] = []
    for claim_id, claim_version in targets:
        score = by_target[(claim_id, claim_version)]
        probability = _probability(score.fraud_probability, "fraud_probability")
        threshold = _probability(score.threshold, "threshold")
        expected_review = probability >= threshold
        if (
            score.predicted_class not in {"LEGITIMATE", "FRAUD"}
            or (score.predicted_class == "FRAUD") != expected_review
            or score.review_recommended != expected_review
        ):
            raise DetectionResultContractError(
                "Prospective model decision differs from its published threshold."
            )

        payload = {
            "schemaVersion": RESULT_PAYLOAD_SCHEMA_VERSION,
            "tenantId": snapshot.tenant_id,
            "claimId": claim_id,
            "claimVersion": claim_version,
            "sourceJobId": source_job_id,
            "requestId": result.request_id,
            "watermark": result.watermark,
            "analysisMode": result.analysis_mode,
            "strategy": {
                "detectionStrategyId": snapshot.detection_strategy_id,
                "strategyType": "approved_model",
                "modelDeploymentId": result.deployment_id,
            },
            "model": {
                "deploymentId": result.deployment_id,
                "modelId": result.model_id,
                "modelVersion": result.model_version,
                "featureSchemaVersion": result.feature_schema_version,
            },
            "score": {
                "fraudProbability": probability,
                "predictedClass": score.predicted_class,
                "threshold": threshold,
                "reviewRecommended": score.review_recommended,
            },
        }
        records.append(
            {
                "tenant_id": snapshot.tenant_id,
                "claim_id": claim_id,
                "claim_version": claim_version,
                "detection_strategy_id": snapshot.detection_strategy_id,
                "strategy_type": "approved_model",
                "model_deployment_id": result.deployment_id,
                "source_job_id": source_job_id,
                "request_id": result.request_id,
                "analysis_mode": result.analysis_mode,
                # Existing columns retain generic model identity despite their legacy names.
                "ensemble_id": result.model_id,
                "ensemble_version": result.model_version,
                "feature_schema_version": result.feature_schema_version,
                "result_payload": payload,
            }
        )
    return records


def _result_from_stored(
    snapshot: ProspectiveScoringSnapshot,
    records: Sequence[Mapping[str, object]],
) -> ProspectiveScreeningResult:
    targets = _targets(snapshot)
    source_job_id = _source_job_id(snapshot)
    if len(records) != len(targets):
        raise DetectionResultIntegrityError(
            "Stored prospective result coverage differs from the target set."
        )

    common: tuple[str, str, str, str, str, str] | None = None
    scores: list[ProspectiveClaimScore] = []
    for index, (record, target) in enumerate(zip(records, targets, strict=True)):
        claim_id, claim_version = target
        if (
            record.get("tenant_id") != snapshot.tenant_id
            or record.get("claim_id") != claim_id
            or int(record.get("claim_version") or 0) != claim_version
            or int(record.get("detection_strategy_id") or 0)
            != snapshot.detection_strategy_id
            or record.get("strategy_type") != "approved_model"
            or record.get("model_deployment_id") != snapshot.model_deployment_id
            or record.get("source_job_id") != source_job_id
        ):
            raise DetectionResultIntegrityError(
                "Stored prospective result identity differs from its snapshot."
            )

        payload = record.get("result_payload")
        if not isinstance(payload, dict):
            raise DetectionResultIntegrityError(
                f"stored result {index} payload must be an object."
            )
        strategy = payload.get("strategy")
        model = payload.get("model")
        score = payload.get("score")
        if not isinstance(strategy, dict) or not isinstance(model, dict) or not isinstance(score, dict):
            raise DetectionResultIntegrityError(
                "Stored prospective result payload is incomplete."
            )
        if (
            payload.get("schemaVersion") != RESULT_PAYLOAD_SCHEMA_VERSION
            or payload.get("tenantId") != snapshot.tenant_id
            or payload.get("claimId") != claim_id
            or payload.get("claimVersion") != claim_version
            or payload.get("sourceJobId") != source_job_id
            or payload.get("watermark") != snapshot.watermark
            or strategy
            != {
                "detectionStrategyId": snapshot.detection_strategy_id,
                "strategyType": "approved_model",
                "modelDeploymentId": snapshot.model_deployment_id,
            }
            or model.get("deploymentId") != snapshot.model_deployment_id
        ):
            raise DetectionResultIntegrityError(
                "Stored prospective result payload differs from its snapshot."
            )

        identity = (
            str(model.get("modelId") or ""),
            str(model.get("modelVersion") or ""),
            str(model.get("featureSchemaVersion") or ""),
            str(payload.get("analysisMode") or ""),
            str(payload.get("requestId") or ""),
            str(payload.get("watermark") or ""),
        )
        if common is None:
            common = identity
        elif common != identity:
            raise DetectionResultIntegrityError(
                "Stored prospective results disagree on execution identity."
            )

        probability = _probability(score.get("fraudProbability"), "fraudProbability")
        threshold = _probability(score.get("threshold"), "threshold")
        predicted = score.get("predictedClass")
        review = score.get("reviewRecommended")
        expected_review = probability >= threshold
        if (
            predicted not in {"LEGITIMATE", "FRAUD"}
            or not isinstance(review, bool)
            or (predicted == "FRAUD") != expected_review
            or review != expected_review
        ):
            raise DetectionResultIntegrityError(
                "Stored prospective decision differs from its threshold."
            )
        scores.append(
            ProspectiveClaimScore(
                claim_id=claim_id,
                claim_version=claim_version,
                fraud_probability=probability,
                predicted_class=str(predicted),
                threshold=threshold,
                review_recommended=review,
            )
        )

    if common is None:
        raise DetectionResultIntegrityError("No stored prospective results were found.")
    model_id, model_version, feature_schema, analysis_mode, request_id, watermark = common
    if (
        model_id != MODEL_ID
        or model_version != MODEL_VERSION
        or feature_schema != FEATURE_SCHEMA_VERSION
        or analysis_mode != ANALYSIS_MODE
        or watermark != snapshot.watermark
    ):
        raise DetectionResultIntegrityError(
            "Stored prospective model identity is incompatible."
        )
    return ProspectiveScreeningResult(
        deployment_id=str(snapshot.model_deployment_id),
        model_id=model_id,
        model_version=model_version,
        feature_schema_version=feature_schema,
        analysis_mode=analysis_mode,
        request_id=request_id,
        watermark=watermark,
        scores=tuple(scores),
    )


def load_or_score_prospective_result(
    *,
    snapshot: ProspectiveScoringSnapshot,
    client: ProspectiveModelServiceClient,
    repository: PyMySqlDetectionResultsRepository,
) -> ProspectiveScreeningResult:
    targets = _targets(snapshot)
    existing = [
        repository.results_exist(snapshot.tenant_id, claim_id, claim_version)
        for claim_id, claim_version in targets
    ]
    if any(existing) and not all(existing):
        raise DetectionResultIntegrityError(
            "Only part of the immutable prospective result set exists."
        )
    if not any(existing):
        result = client.screen(snapshot)
        repository.save_result_records(_records(snapshot, result))

    stored = repository.load_results_for_report(snapshot.tenant_id, targets)
    return _result_from_stored(snapshot, stored)
