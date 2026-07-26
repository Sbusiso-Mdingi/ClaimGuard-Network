from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation

from .contract import ReportContractError
from .prospective_model_service import ProspectiveClaimScore, ProspectiveScreeningResult
from .snapshot import ProspectiveScoringSnapshot

REPORT_CONTRACT_VERSION = "1.0"
ENGINE_VERSION = "prospective-baseline-consumer-1.0.0"
PRODUCER_VERSION = "report-producer-0.5.0"
RISK_SCORE_BASIS = "THRESHOLD_NORMALIZED_BASELINE"
SOURCE_TYPE = "mysql_prospective_claim_versions"


def _text(value: object, field: str, maximum: int = 128) -> str:
    rendered = str(value or "").strip()
    if not rendered or len(rendered) > maximum:
        raise ReportContractError(f"{field} is required and must not exceed {maximum} characters.")
    return rendered


def _positive_int(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise ReportContractError(f"{field} must be a positive integer.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ReportContractError(f"{field} must be a positive integer.") from error
    if parsed <= 0 or (isinstance(value, float) and not value.is_integer()):
        raise ReportContractError(f"{field} must be a positive integer.")
    return parsed


def _timestamp(value: object, field: str) -> str:
    rendered = value.isoformat() if hasattr(value, "isoformat") else str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(rendered.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReportContractError(f"{field} must be an ISO timestamp.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _date(value: object, field: str) -> str:
    rendered = value.isoformat() if hasattr(value, "isoformat") else str(value or "").strip()
    try:
        return date.fromisoformat(rendered).isoformat()
    except ValueError as error:
        raise ReportContractError(f"{field} must be an ISO calendar date.") from error


def _amount(value: object, field: str) -> float:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as error:
        raise ReportContractError(f"{field} must be a positive monetary amount.") from error
    if not parsed.is_finite() or parsed <= 0:
        raise ReportContractError(f"{field} must be a positive monetary amount.")
    return float(parsed.quantize(Decimal("0.01")))


def _probability(value: object, field: str) -> float:
    if isinstance(value, bool):
        raise ReportContractError(f"{field} must be a probability.")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ReportContractError(f"{field} must be a probability.") from error
    if not math.isfinite(parsed) or not 0 <= parsed <= 1:
        raise ReportContractError(f"{field} must be a probability.")
    return parsed


def _risk_index(score: ProspectiveClaimScore) -> float:
    probability = _probability(score.fraud_probability, "fraud_probability")
    threshold = _probability(score.threshold, "threshold")
    if threshold == 0:
        return 100.0
    return round(min(100.0, 70.0 * probability / threshold), 3)


def _severity(score: float | None) -> str | None:
    if score is None:
        return None
    if score >= 70:
        return "High"
    if score >= 40:
        return "Medium"
    return "Low"


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ReportContractError("Prospective report data must be finite JSON.") from error


def _index_rows(rows: object, *, id_field: str, collection: str) -> dict[str, dict[str, object]]:
    if not isinstance(rows, list):
        raise ReportContractError(f"snapshot.{collection} must be an array.")
    indexed: dict[str, dict[str, object]] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ReportContractError(f"snapshot.{collection}[{index}] must be an object.")
        identifier = _text(row.get(id_field), f"snapshot.{collection}[{index}].{id_field}")
        if identifier in indexed:
            raise ReportContractError(f"Snapshot contains duplicate {collection} identifier {identifier}.")
        indexed[identifier] = row
    return indexed


def _target_index(snapshot: ProspectiveScoringSnapshot) -> tuple[
    tuple[tuple[str, int], ...],
    dict[tuple[str, int], dict[str, object]],
]:
    if not isinstance(snapshot.target_claims, list) or not snapshot.target_claims:
        raise ReportContractError("Snapshot must contain target claim versions.")
    ordered: list[tuple[str, int]] = []
    indexed: dict[tuple[str, int], dict[str, object]] = {}
    claim_ids: set[str] = set()
    for index, claim in enumerate(snapshot.target_claims):
        if not isinstance(claim, dict):
            raise ReportContractError(f"snapshot.target_claims[{index}] must be an object.")
        claim_id = _text(claim.get("claim_id"), f"target[{index}].claim_id")
        claim_version = _positive_int(claim.get("claim_version"), f"target[{index}].claim_version")
        target = (claim_id, claim_version)
        if target in indexed or claim_id in claim_ids:
            raise ReportContractError(f"Snapshot contains an ambiguous target for {claim_id}.")
        ordered.append(target)
        indexed[target] = claim
        claim_ids.add(claim_id)
    return tuple(ordered), indexed


def _score_index(
    snapshot: ProspectiveScoringSnapshot,
    result: ProspectiveScreeningResult,
    targets: tuple[tuple[str, int], ...],
) -> dict[tuple[str, int], ProspectiveClaimScore]:
    if result.deployment_id != snapshot.model_deployment_id:
        raise ReportContractError("Prospective result deployment differs from its snapshot.")
    if result.watermark != snapshot.watermark:
        raise ReportContractError("Prospective result watermark differs from its snapshot.")
    indexed: dict[tuple[str, int], ProspectiveClaimScore] = {}
    order: list[tuple[str, int]] = []
    thresholds: set[float] = set()
    for index, score in enumerate(result.scores):
        if not isinstance(score, ProspectiveClaimScore):
            raise ReportContractError(f"result.scores[{index}] has an unsupported representation.")
        target = (
            _text(score.claim_id, f"result.scores[{index}].claim_id"),
            _positive_int(score.claim_version, f"result.scores[{index}].claim_version"),
        )
        probability = _probability(score.fraud_probability, "fraud_probability")
        threshold = _probability(score.threshold, "threshold")
        expected_review = probability >= threshold
        if (
            score.predicted_class not in {"LEGITIMATE", "FRAUD"}
            or (score.predicted_class == "FRAUD") != expected_review
            or score.review_recommended != expected_review
        ):
            raise ReportContractError("Prospective score decision differs from its threshold.")
        if target in indexed:
            raise ReportContractError("Prospective result contains duplicate claim-version scores.")
        indexed[target] = score
        order.append(target)
        thresholds.add(threshold)
    if tuple(order) != targets or len(indexed) != len(targets):
        raise ReportContractError("Prospective result coverage or ordering differs from the snapshot.")
    if len(thresholds) != 1:
        raise ReportContractError("Prospective thresholds differ across target claims.")
    return indexed


def build_prospective_detection_report(
    snapshot: ProspectiveScoringSnapshot,
    result: ProspectiveScreeningResult,
    *,
    correlation_id: str,
    producer_version: str = PRODUCER_VERSION,
) -> dict[str, object]:
    if snapshot.detection_strategy != "approved_model":
        raise ReportContractError("Prospective reports require the approved_model strategy.")
    correlation_id = _text(correlation_id, "correlation_id")
    producer_version = _text(producer_version, "producer_version")
    if not isinstance(snapshot.source_job_ids, tuple) or len(snapshot.source_job_ids) != 1:
        raise ReportContractError("A prospective report must identify exactly one source job.")
    source_job_id = _text(snapshot.source_job_ids[0], "source_job_id", 64)

    targets, target_claims = _target_index(snapshot)
    scores = _score_index(snapshot, result, targets)
    schemes = _index_rows(snapshot.schemes, id_field="scheme_id", collection="schemes")
    members = _index_rows(snapshot.members, id_field="member_id", collection="members")
    providers = _index_rows(snapshot.providers, id_field="provider_id", collection="providers")

    provider_risks: dict[str, list[float]] = defaultdict(list)
    member_risks: dict[str, list[float]] = defaultdict(list)
    provider_reviews: dict[str, int] = defaultdict(int)
    member_reviews: dict[str, int] = defaultdict(int)
    claims: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    service_dates: list[str] = []
    scheme_ids: set[str] = set()

    for claim_id, claim_version in targets:
        claim = target_claims[(claim_id, claim_version)]
        score = scores[(claim_id, claim_version)]
        scheme_id = _text(claim.get("scheme_id"), f"claim {claim_id}.scheme_id", 64)
        member_id = _text(claim.get("member_id"), f"claim {claim_id}.member_id")
        provider_id = _text(claim.get("provider_id"), f"claim {claim_id}.provider_id")
        if scheme_id not in schemes:
            raise ReportContractError(f"Claim {claim_id} references an unknown scheme.")
        if member_id not in members or members[member_id].get("scheme_id") != scheme_id:
            raise ReportContractError(f"Claim {claim_id} references an invalid member.")
        if provider_id not in providers or providers[provider_id].get("scheme_id") != scheme_id:
            raise ReportContractError(f"Claim {claim_id} references an invalid provider.")

        service_date = _date(claim.get("service_date"), f"claim {claim_id}.service_date")
        amount = _amount(claim.get("amount"), f"claim {claim_id}.amount")
        risk_score = _risk_index(score)
        provider_risks[provider_id].append(risk_score)
        member_risks[member_id].append(risk_score)
        if score.review_recommended:
            provider_reviews[provider_id] += 1
            member_reviews[member_id] += 1
        service_dates.append(service_date)
        scheme_ids.add(scheme_id)
        claims.append(
            {
                "claimId": claim_id,
                "claimVersion": claim_version,
                "providerId": provider_id,
                "memberId": member_id,
                "schemeId": scheme_id,
                "serviceDate": service_date,
                "amount": amount,
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": (
                    ["Prospective baseline model reached its review threshold"]
                    if score.review_recommended
                    else []
                ),
                "ruleHits": [],
                "evidenceReferences": [],
                "processingStatus": (
                    "REVIEW_RECOMMENDED"
                    if score.review_recommended
                    else "NO_MODEL_REVIEW"
                ),
                "modelReview": {
                    "fraudProbability": float(score.fraud_probability),
                    "predictedClass": score.predicted_class,
                    "threshold": float(score.threshold),
                    "reviewRecommended": score.review_recommended,
                },
            }
        )
        edges.append(
            {
                "relationship_type": "submitted_to",
                "source_entity_id": f"claimant:{member_id}",
                "target_entity_id": f"provider:{provider_id}",
                "claim_id": claim_id,
                "claim_version": claim_version,
            }
        )

    report_providers: list[dict[str, object]] = []
    for provider_id in sorted(provider_risks):
        values = provider_risks[provider_id]
        risk_score = round(max(values), 3)
        reviews = provider_reviews[provider_id]
        provider = providers[provider_id]
        report_providers.append(
            {
                "providerId": provider_id,
                "schemeId": str(provider["scheme_id"]),
                "specialty": str(provider.get("specialty") or ""),
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": (
                    [f"{reviews} claim(s) reached the prospective baseline threshold"]
                    if reviews
                    else []
                ),
                "category": "prospective_model_review",
                "claimStatistics": {
                    "claim_count": len(values),
                    "review_recommended_count": reviews,
                    "maximum_claim_risk_index": risk_score,
                },
                "networkMetrics": {},
            }
        )

    report_members: list[dict[str, object]] = []
    for member_id in sorted(member_risks):
        values = member_risks[member_id]
        risk_score = round(max(values), 3)
        reviews = member_reviews[member_id]
        member = members[member_id]
        report_members.append(
            {
                "memberId": member_id,
                "schemeId": str(member["scheme_id"]),
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": (
                    [f"{reviews} claim(s) reached the prospective baseline threshold"]
                    if reviews
                    else []
                ),
                "category": "prospective_model_review",
                "utilizationStatistics": {
                    "claim_count": len(values),
                    "review_recommended_count": reviews,
                    "maximum_claim_risk_index": risk_score,
                },
            }
        )

    graph_nodes = [
        *[
            {"entity_id": f"claimant:{member_id}", "entity_type": "claimant"}
            for member_id in sorted(member_risks)
        ],
        *[
            {"entity_id": f"provider:{provider_id}", "entity_type": "provider"}
            for provider_id in sorted(provider_risks)
        ],
    ]
    claim_scores = [float(claim["riskScore"]) for claim in claims]
    review_count = sum(score.review_recommended for score in result.scores)
    average_risk = round(sum(claim_scores) / len(claim_scores), 3)
    risk_distribution = {
        "low": sum(score < 40 for score in claim_scores),
        "medium": sum(40 <= score < 70 for score in claim_scores),
        "high": sum(score >= 70 for score in claim_scores),
    }
    context_cutoff = _timestamp(snapshot.context_cutoff_at, "snapshot.context_cutoff_at")
    generated_at = _timestamp(snapshot.captured_at, "snapshot.captured_at")
    threshold = float(result.scores[0].threshold)

    report_identity = {
        "contractVersion": REPORT_CONTRACT_VERSION,
        "engineVersion": ENGINE_VERSION,
        "tenantId": snapshot.tenant_id,
        "watermark": snapshot.watermark,
        "deploymentId": result.deployment_id,
        "modelId": result.model_id,
        "modelVersion": result.model_version,
        "featureSchemaVersion": result.feature_schema_version,
        "analysisMode": result.analysis_mode,
        "requestId": result.request_id,
        "sourceJobId": source_job_id,
        "targets": [
            {"claimId": claim_id, "claimVersion": claim_version}
            for claim_id, claim_version in targets
        ],
    }
    report_id = hashlib.sha256(_canonical_json(report_identity).encode("utf-8")).hexdigest()

    report: dict[str, object] = {
        "contractVersion": REPORT_CONTRACT_VERSION,
        "metadata": {
            "reportId": report_id,
            "tenant": {
                "tenantId": snapshot.tenant_id,
                "tenantSlug": snapshot.tenant_slug,
                "displayName": snapshot.tenant_display_name,
            },
            "generatedAt": generated_at,
            "snapshotCutoff": context_cutoff,
            "source": {
                "type": SOURCE_TYPE,
                "watermark": snapshot.watermark,
                "historicalWindow": {
                    "mode": "exact_gate_g_features",
                    "contextCutoffAt": context_cutoff,
                },
                "sourceJobIds": [source_job_id],
            },
            "includedCounts": {
                "claims": len(claims),
                "providers": len(report_providers),
                "members": len(report_members),
            },
            "includedDateRange": {
                "from": min(service_dates),
                "to": max(service_dates),
            },
            "detectionEngineVersion": ENGINE_VERSION,
            "producerVersion": producer_version,
            "generationCorrelationId": correlation_id,
            "detectionStrategy": {
                "detectionStrategyId": snapshot.detection_strategy_id,
                "strategyType": snapshot.detection_strategy,
            },
            "model": {
                "deploymentId": result.deployment_id,
                "modelId": result.model_id,
                "modelVersion": result.model_version,
                "featureSchemaVersion": result.feature_schema_version,
                "analysisMode": result.analysis_mode,
                "requestId": result.request_id,
                "riskScoreBasis": RISK_SCORE_BASIS,
            },
        },
        "summary": {
            "totalClaims": len(claims),
            "totalClaimedAmount": round(sum(float(claim["amount"]) for claim in claims), 2),
            "highRiskClaims": review_count,
            "flaggedProviders": sum(value > 0 for value in provider_reviews.values()),
            "flaggedMembers": sum(value > 0 for value in member_reviews.values()),
            "activeFraudPatterns": 1 if review_count else 0,
            "averageRiskScore": average_risk,
            "riskDistribution": risk_distribution,
        },
        "claims": claims,
        "providers": report_providers,
        "members": report_members,
        "graph": {
            "nodes": graph_nodes,
            "edges": edges,
            "summary": {
                "entity_count": len(graph_nodes),
                "relationship_count": len(edges),
                "claimant_count": len(report_members),
                "provider_count": len(report_providers),
            },
        },
        "risk": {
            "riskScore": average_risk,
            "severity": _severity(average_risk),
            "reasons": (
                [f"{review_count} claim(s) require prospective baseline review"]
                if review_count
                else []
            ),
            "highRiskClaims": review_count,
            "activeFraudPatterns": 1 if review_count else 0,
        },
        "history": {
            "schemeMetrics": [
                {
                    "schemeId": scheme_id,
                    "targetClaimCount": sum(claim["schemeId"] == scheme_id for claim in claims),
                }
                for scheme_id in sorted(scheme_ids)
            ],
            "ruleExecution": {
                "triggeredRules": [],
                "triggeredRuleCount": 0,
                "notExecuted": True,
            },
            "modelExecution": {
                "deploymentId": result.deployment_id,
                "modelId": result.model_id,
                "modelVersion": result.model_version,
                "featureSchemaVersion": result.feature_schema_version,
                "analysisMode": result.analysis_mode,
                "requestId": result.request_id,
                "windowWatermark": result.watermark,
                "reviewRecommendedClaims": review_count,
                "threshold": threshold,
            },
            "evaluation": {
                "available": False,
                "message": "Production tenant reports do not contain ground truth.",
            },
            "timings": None,
        },
    }
    _canonical_json(report)
    return report
