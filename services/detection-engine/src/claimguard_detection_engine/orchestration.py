from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from .analytics import analyze_bundle
from .loader import DataBundle


REPORT_CONTRACT_VERSION = "1.0"
DETECTION_ENGINE_VERSION = "0.2.0-canonical"


@dataclass(frozen=True)
class DetectionSnapshot:
    bundle: DataBundle
    tenant_id: str
    tenant_slug: str | None
    tenant_display_name: str | None
    snapshot_cutoff: str
    source_type: str
    source_watermark: str
    generation_correlation_id: str
    detection_strategy: str = "deterministic_rules"
    ml_endpoint_url: str | None = None
    generated_at: str | None = None
    producer_version: str = "detection-engine-cli"
    historical_window: dict[str, object] | None = None
    ground_truth: dict[str, object] | None = None


def _severity(score: float | None) -> str | None:
    if score is None:
        return None
    if score >= 70:
        return "High"
    if score >= 40:
        return "Medium"
    return "Low"


def _stable_report_id(snapshot: DetectionSnapshot, claim_ids: list[str]) -> str:
    payload = {
        "contractVersion": REPORT_CONTRACT_VERSION,
        "engineVersion": DETECTION_ENGINE_VERSION,
        "tenantId": snapshot.tenant_id,
        "sourceType": snapshot.source_type,
        "watermark": snapshot.source_watermark,
        "claimIds": sorted(claim_ids),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


_EVIDENCE_ENTITY_PATTERN = re.compile(r"(?:claimant|provider):[A-Za-z0-9_.-]+")


def _index_rule_hits(triggered_rules: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    indexed: dict[str, list[dict[str, object]]] = {}
    for rule in triggered_rules:
        evidence = [str(item) for item in rule.get("evidence", [])]
        hit = {
            "ruleId": str(rule.get("rule_id") or ""),
            "title": str(rule.get("title") or ""),
            "weight": int(rule.get("weight") or 0),
        }
        for entity_id in sorted({match for item in evidence for match in _EVIDENCE_ENTITY_PATTERN.findall(item)}):
            indexed.setdefault(entity_id, []).append(hit)
    return indexed


def _rule_hits_for_claim(
    indexed_rule_hits: dict[str, list[dict[str, object]]], member_id: str, provider_id: str
) -> list[dict[str, object]]:
    hits: list[dict[str, object]] = []
    seen: set[tuple[str, str, int]] = set()
    for entity_id in (f"claimant:{member_id}", f"provider:{provider_id}"):
        for hit in indexed_rule_hits.get(entity_id, []):
            identity = (str(hit["ruleId"]), str(hit["title"]), int(hit["weight"]))
            if identity in seen:
                continue
            seen.add(identity)
            hits.append(hit)
    return hits


def run_detection_orchestration(snapshot: DetectionSnapshot, *, top_n: int = 10) -> dict[str, object]:
    """Run detection over one authoritative tenant snapshot."""

    if not snapshot.tenant_id.strip():
        raise ValueError("A canonical tenant ID is required for detection orchestration.")

    analyzed = analyze_bundle(
        snapshot.bundle,
        top_n=0,
        ground_truth=snapshot.ground_truth,
        detection_strategy=snapshot.detection_strategy,
        ml_endpoint_url=snapshot.ml_endpoint_url,
    )
    provider_findings = {
        finding["entity_id"]: finding
        for scheme in analyzed["schemes"]
        for finding in scheme["provider_findings"]
    }
    member_findings = {
        finding["entity_id"]: finding
        for scheme in analyzed["schemes"]
        for finding in scheme["member_findings"]
    }
    triggered_rules = list(analyzed["detection"]["triggered_rules"])
    indexed_rule_hits = _index_rule_hits(triggered_rules)

    claims: list[dict[str, object]] = []
    providers: list[dict[str, object]] = []
    members: list[dict[str, object]] = []
    service_dates: list[str] = []

    for scheme in snapshot.bundle.schemes.values():
        for provider in scheme.providers.values():
            finding = provider_findings[provider.provider_id]
            score = float(finding["score"])
            providers.append(
                {
                    "providerId": provider.provider_id,
                    "schemeId": provider.scheme_id,
                    "specialty": provider.specialty,
                    "riskScore": score,
                    "severity": _severity(score),
                    "reasons": list(finding["reasons"]),
                    "category": finding["category"],
                    "claimStatistics": dict(finding["metrics"]),
                    "networkMetrics": {
                        key: value
                        for key, value in finding["metrics"].items()
                        if key.endswith("signal") or key.endswith("similarity")
                    },
                }
            )

        for member in scheme.members.values():
            finding = member_findings[member.member_id]
            score = float(finding["score"])
            members.append(
                {
                    "memberId": member.member_id,
                    "schemeId": member.scheme_id,
                    "riskScore": score,
                    "severity": _severity(score),
                    "reasons": list(finding["reasons"]),
                    "category": finding["category"],
                    "utilizationStatistics": dict(finding["metrics"]),
                }
            )

        for claim in scheme.claims:
            provider_score = float(provider_findings[claim.provider_id]["score"])
            member_score = float(member_findings[claim.member_id]["score"])
            risk_score = round(max(provider_score, member_score), 3)
            reasons = list(
                dict.fromkeys(
                    [
                        *provider_findings[claim.provider_id]["reasons"],
                        *member_findings[claim.member_id]["reasons"],
                    ]
                )
            )
            claims.append(
                {
                    "claimId": claim.claim_id,
                    "providerId": claim.provider_id,
                    "memberId": claim.member_id,
                    "schemeId": claim.scheme_id,
                    "serviceDate": claim.service_date,
                    "amount": float(claim.amount),
                    "riskScore": risk_score,
                    "severity": _severity(risk_score),
                    "reasons": reasons,
                    "ruleHits": _rule_hits_for_claim(indexed_rule_hits, claim.member_id, claim.provider_id),
                    "evidenceReferences": [],
                    "processingStatus": None,
                }
            )
            service_dates.append(claim.service_date)

    claims.sort(key=lambda item: str(item["claimId"]))
    providers.sort(key=lambda item: (-float(item["riskScore"]), str(item["providerId"])))
    members.sort(key=lambda item: (-float(item["riskScore"]), str(item["memberId"])))

    claim_scores = [float(claim["riskScore"]) for claim in claims]
    average_risk = round(sum(claim_scores) / len(claim_scores), 3) if claim_scores else None
    risk_distribution = {
        "low": sum(1 for score in claim_scores if score < 40),
        "medium": sum(1 for score in claim_scores if 40 <= score < 70),
        "high": sum(1 for score in claim_scores if score >= 70),
    }
    fraud_pattern_count = (
        len(analyzed["network"]["exact_banking_links"])
        + len(analyzed["network"]["behavioral_provider_links"])
        + len(triggered_rules)
    )
    generated_at = snapshot.generated_at or datetime.now(UTC).isoformat()
    report_id = _stable_report_id(snapshot, [str(claim["claimId"]) for claim in claims])
    graph = {
        "nodes": list(analyzed["detection"]["entities"]),
        "edges": list(analyzed["detection"]["relationships"]),
        "summary": dict(analyzed["detection"]["graph_summary"]),
    }

    report = {
        "contractVersion": REPORT_CONTRACT_VERSION,
        "metadata": {
            "reportId": report_id,
            "tenant": {
                "tenantId": snapshot.tenant_id,
                "tenantSlug": snapshot.tenant_slug,
                "displayName": snapshot.tenant_display_name,
            },
            "generatedAt": generated_at,
            "snapshotCutoff": snapshot.snapshot_cutoff,
            "source": {
                "type": snapshot.source_type,
                "watermark": snapshot.source_watermark,
                "historicalWindow": snapshot.historical_window,
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
            "detectionEngineVersion": DETECTION_ENGINE_VERSION,
            "producerVersion": snapshot.producer_version,
            "generationCorrelationId": snapshot.generation_correlation_id,
        },
        "summary": {
            "totalClaims": len(claims),
            "totalClaimedAmount": round(sum(float(claim["amount"]) for claim in claims), 2),
            "highRiskClaims": risk_distribution["high"],
            "flaggedProviders": sum(1 for provider in providers if float(provider["riskScore"]) >= 55),
            "flaggedMembers": sum(1 for member in members if float(member["riskScore"]) >= 50),
            "activeFraudPatterns": fraud_pattern_count,
            "averageRiskScore": average_risk,
            "riskDistribution": risk_distribution,
        },
        "claims": claims,
        "providers": providers,
        "members": members,
        "graph": graph,
        "risk": {
            "riskScore": average_risk,
            "severity": _severity(average_risk),
            "reasons": list(analyzed["detection"]["risk_score"]["reasons"]),
            "highRiskClaims": risk_distribution["high"],
            "activeFraudPatterns": fraud_pattern_count,
        },
        "history": {
            "schemeMetrics": [
                {
                    "schemeId": scheme["scheme_id"],
                    "providerCount": scheme["provider_count"],
                    "memberCount": scheme["member_count"],
                    "claimCount": scheme["claim_count"],
                    "summary": {
                        "providerScoreMedian": (
                            scheme["summary"]["provider_score_median"] if scheme["provider_count"] else None
                        ),
                        "memberScoreMedian": (
                            scheme["summary"]["member_score_median"] if scheme["member_count"] else None
                        ),
                    },
                }
                for scheme in analyzed["schemes"]
            ],
            "ruleExecution": {
                "triggeredRules": triggered_rules,
                "triggeredRuleCount": len(triggered_rules),
            },
            "evaluation": analyzed["evaluation"],
            "timings": None,
        },
    }

    if not all(math.isfinite(float(claim["riskScore"])) for claim in claims):
        raise ValueError("Detection orchestration produced a non-finite claim score.")
    return report
