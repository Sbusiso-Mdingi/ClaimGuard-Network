from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from datetime import UTC, datetime

from .model_service import ClaimReviewResult, ReviewWindowResult
from .snapshot import ProspectiveScoringSnapshot


MODEL_REPORT_ENGINE_VERSION = "claim-review-consumer-1.0.0"


def _severity(score: float | None) -> str | None:
    if score is None:
        return None
    if score >= 70:
        return "High"
    if score >= 40:
        return "Medium"
    return "Low"


def _component_index(probability: float, threshold: float) -> float:
    if threshold <= 0:
        return 100.0
    return min(100.0, 70.0 * probability / threshold)


def _risk_index(score: ClaimReviewResult) -> float:
    return round(
        max(
            _component_index(
                score.baseline_fraud_probability,
                score.baseline_threshold,
            ),
            _component_index(score.ring_probability, score.ring_threshold),
            _component_index(
                score.phantom_probability,
                score.phantom_threshold,
            ),
        ),
        3,
    )


def _claim_reasons(score: ClaimReviewResult) -> list[str]:
    reasons: list[str] = []
    if score.baseline_predicted_class == "FRAUD":
        reasons.append("Baseline learned detector reached its review threshold")
    if score.ring_review_hit:
        reasons.append("Retrospective ring detector reached its review threshold")
    if score.phantom_review_hit:
        reasons.append(
            "Specialised phantom-service detector reached its review threshold"
        )
    return reasons


def _stable_report_id(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
) -> str:
    payload = {
        "contractVersion": "1.0",
        "engineVersion": MODEL_REPORT_ENGINE_VERSION,
        "tenantId": snapshot.tenant_id,
        "watermark": snapshot.watermark,
        "deploymentId": review.deployment_id,
        "ensembleId": review.ensemble_id,
        "ensembleVersion": review.ensemble_version,
        "claimIds": sorted(score.claim_id for score in review.scores),
    }
    return hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _date_text(value: object) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def build_model_detection_report(
    snapshot: ProspectiveScoringSnapshot,
    review: ReviewWindowResult,
    *,
    correlation_id: str,
    producer_version: str = "report-producer-0.3.0",
) -> dict[str, object]:
    if review.watermark != snapshot.watermark:
        raise ValueError("Model review watermark differs from its tenant snapshot.")
    score_by_claim = {score.claim_id: score for score in review.scores}
    claim_ids = [str(claim.get("claim_id") or "") for claim in snapshot.target_claims]
    if (
        len(score_by_claim) != len(review.scores)
        or set(score_by_claim) != set(claim_ids)
    ):
        raise ValueError("Model review coverage differs from its tenant snapshot.")

    provider_claim_risks: dict[str, list[float]] = defaultdict(list)
    provider_review_counts: dict[str, int] = defaultdict(int)
    member_claim_risks: dict[str, list[float]] = defaultdict(list)
    member_review_counts: dict[str, int] = defaultdict(int)
    claims: list[dict[str, object]] = []
    graph_edges: list[dict[str, object]] = []
    service_dates: list[str] = []

    for claim in sorted(
        snapshot.target_claims,
        key=lambda item: str(item.get("claim_id") or ""),
    ):
        claim_id = str(claim["claim_id"])
        provider_id = str(claim["provider_id"])
        member_id = str(claim["member_id"])
        score = score_by_claim[claim_id]
        risk_score = _risk_index(score)
        reasons = _claim_reasons(score)
        provider_claim_risks[provider_id].append(risk_score)
        member_claim_risks[member_id].append(risk_score)
        if score.composite_review_recommended:
            provider_review_counts[provider_id] += 1
            member_review_counts[member_id] += 1
        service_date = _date_text(claim["service_date"])
        service_dates.append(service_date)
        claims.append(
            {
                "claimId": claim_id,
                "claimVersion": claim.get("claim_version"),
                "providerId": provider_id,
                "memberId": member_id,
                "schemeId": str(claim["scheme_id"]),
                "serviceDate": service_date,
                "amount": float(claim["amount"]),
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": reasons,
                "ruleHits": [],
                "evidenceReferences": [],
                "processingStatus": (
                    "REVIEW_RECOMMENDED"
                    if score.composite_review_recommended
                    else "NO_MODEL_REVIEW"
                ),
                "modelReview": {
                    "baselineFraudProbability": (
                        score.baseline_fraud_probability
                    ),
                    "baselinePredictedClass": score.baseline_predicted_class,
                    "baselineThreshold": score.baseline_threshold,
                    "ringProbability": score.ring_probability,
                    "ringReviewHit": score.ring_review_hit,
                    "ringThreshold": score.ring_threshold,
                    "phantomProbability": score.phantom_probability,
                    "phantomReviewHit": score.phantom_review_hit,
                    "phantomThreshold": score.phantom_threshold,
                    "compositeReviewRecommended": (
                        score.composite_review_recommended
                    ),
                },
            }
        )
        graph_edges.append(
            {
                "relationship_type": "submitted_to",
                "source_entity_id": f"claimant:{member_id}",
                "target_entity_id": f"provider:{provider_id}",
                "claim_id": claim_id,
            }
        )

    providers: list[dict[str, object]] = []
    for provider in sorted(
        snapshot.providers,
        key=lambda item: str(item.get("provider_id") or ""),
    ):
        provider_id = str(provider["provider_id"])
        if provider_id not in provider_claim_risks:
            continue
        risks = provider_claim_risks[provider_id]
        risk_score = round(max(risks, default=0.0), 3)
        review_count = provider_review_counts[provider_id]
        providers.append(
            {
                "providerId": provider_id,
                "schemeId": str(provider["scheme_id"]),
                "specialty": str(provider.get("specialty") or ""),
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": (
                    [f"{review_count} claim(s) reached a learned review threshold"]
                    if review_count
                    else []
                ),
                "category": "model_review",
                "claimStatistics": {
                    "claim_count": len(risks),
                    "review_recommended_count": review_count,
                    "maximum_claim_risk_index": risk_score,
                },
                "networkMetrics": {},
            }
        )

    members: list[dict[str, object]] = []
    for member in sorted(
        snapshot.members,
        key=lambda item: str(item.get("member_id") or ""),
    ):
        member_id = str(member["member_id"])
        if member_id not in member_claim_risks:
            continue
        risks = member_claim_risks[member_id]
        risk_score = round(max(risks, default=0.0), 3)
        review_count = member_review_counts[member_id]
        members.append(
            {
                "memberId": member_id,
                "schemeId": str(member["scheme_id"]),
                "riskScore": risk_score,
                "severity": _severity(risk_score),
                "reasons": (
                    [f"{review_count} claim(s) reached a learned review threshold"]
                    if review_count
                    else []
                ),
                "category": "model_review",
                "utilizationStatistics": {
                    "claim_count": len(risks),
                    "review_recommended_count": review_count,
                    "maximum_claim_risk_index": risk_score,
                },
            }
        )

    graph_nodes = [
        *(
            {
                "entity_id": f"claimant:{item['member_id']}",
                "entity_type": "claimant",
            }
            for item in sorted(
                snapshot.members,
                key=lambda value: str(value.get("member_id") or ""),
            ) if str(item.get("member_id") or "") in member_claim_risks
        ),
        *(
            {
                "entity_id": f"provider:{item['provider_id']}",
                "entity_type": "provider",
            }
            for item in sorted(
                snapshot.providers,
                key=lambda value: str(value.get("provider_id") or ""),
            ) if str(item.get("provider_id") or "") in provider_claim_risks
        ),
    ]
    claim_scores = [float(claim["riskScore"]) for claim in claims]
    review_recommended_count = sum(
        score.composite_review_recommended for score in review.scores
    )
    risk_distribution = {
        "low": sum(score < 40 for score in claim_scores),
        "medium": sum(40 <= score < 70 for score in claim_scores),
        "high": sum(score >= 70 for score in claim_scores),
    }
    average_risk = (
        round(sum(claim_scores) / len(claim_scores), 3)
        if claim_scores
        else None
    )
    active_components = sum(
        (
            any(
                score.baseline_predicted_class == "FRAUD"
                for score in review.scores
            ),
            any(score.ring_review_hit for score in review.scores),
            any(score.phantom_review_hit for score in review.scores),
        )
    )
    reasons = []
    if review_recommended_count:
        reasons.append(
            f"{review_recommended_count} claim(s) require learned-model review"
        )
    generated_at = datetime.now(UTC).isoformat()

    report = {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": _stable_report_id(snapshot, review),
            "tenant": {
                "tenantId": snapshot.tenant_id,
                "tenantSlug": snapshot.tenant_slug,
                "displayName": snapshot.tenant_display_name,
            },
            "generatedAt": generated_at,
            "snapshotCutoff": snapshot.captured_at,
            "source": {
                "type": "mysql_tenant_snapshot",
                "watermark": snapshot.watermark,
                "historicalWindow": None,
            },
            "includedCounts": {
                "claims": len(claims),
                "providers": len(providers),
                "members": len(members),
            },
            "includedDateRange": {
                "from": min(service_dates) if service_dates else None,
                "to": max(service_dates) if service_dates else None,
            },
            "detectionEngineVersion": MODEL_REPORT_ENGINE_VERSION,
            "producerVersion": producer_version,
            "generationCorrelationId": correlation_id,
            "model": {
                "deploymentId": review.deployment_id,
                "ensembleId": review.ensemble_id,
                "ensembleVersion": review.ensemble_version,
                "featureSchemaVersion": review.feature_schema_version,
                "analysisMode": review.analysis_mode,
                "requestId": review.request_id,
                "riskScoreBasis": "THRESHOLD_NORMALIZED_MAX_COMPONENT",
            },
        },
        "summary": {
            "totalClaims": len(claims),
            "totalClaimedAmount": round(
                sum(float(claim["amount"]) for claim in claims),
                2,
            ),
            "highRiskClaims": review_recommended_count,
            "flaggedProviders": sum(value > 0 for value in provider_review_counts.values()),
            "flaggedMembers": sum(value > 0 for value in member_review_counts.values()),
            "activeFraudPatterns": active_components,
            "averageRiskScore": average_risk,
            "riskDistribution": risk_distribution,
        },
        "claims": claims,
        "providers": providers,
        "members": members,
        "graph": {
            "nodes": graph_nodes,
            "edges": graph_edges,
            "summary": {
                "entity_count": len(graph_nodes),
                "relationship_count": len(graph_edges),
                "claimant_count": len(members),
                "provider_count": len(providers),
            },
        },
        "risk": {
            "riskScore": average_risk,
            "severity": _severity(average_risk),
            "reasons": reasons,
            "highRiskClaims": review_recommended_count,
            "activeFraudPatterns": active_components,
        },
        "history": {
            "schemeMetrics": [],
            "ruleExecution": {
                "triggeredRules": [],
                "triggeredRuleCount": 0,
                "notExecuted": True,
            },
            "modelExecution": {
                "deploymentId": review.deployment_id,
                "ensembleId": review.ensemble_id,
                "ensembleVersion": review.ensemble_version,
                "featureSchemaVersion": review.feature_schema_version,
                "analysisMode": review.analysis_mode,
                "requestId": review.request_id,
                "windowWatermark": review.watermark,
                "reviewRecommendedClaims": review_recommended_count,
                "baselineThreshold": review.scores[0].baseline_threshold,
                "ringThreshold": review.scores[0].ring_threshold,
                "phantomThreshold": review.scores[0].phantom_threshold,
            },
            "evaluation": {
                "available": False,
                "message": "Production tenant reports do not contain ground truth.",
            },
            "timings": None,
        },
    }
    if not all(math.isfinite(float(claim["riskScore"])) for claim in claims):
        raise ValueError("Model report produced a non-finite claim risk index.")
    return report
