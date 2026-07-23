from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass

from .graph_store import GraphDocument, GraphStore, InMemoryGraphStore
from .rule_engine import GraphForRules, RuleEngine


@dataclass(frozen=True)
class NormalizedClaim:
    claim_id: str
    claimant_id: str
    provider_id: str
    phone: str | None
    email: str | None
    address: str | None
    bank_account: str | None
    device_id: str | None
    ip_address: str | None


def _stable_token(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


def _optional_text(*values: object) -> str | None:
    for value in values:
        rendered = str(value or "").strip()
        if rendered:
            return rendered
    return None


def normalize_claim_data(raw_claims: list[dict[str, object]]) -> list[NormalizedClaim]:
    normalized: list[NormalizedClaim] = []

    for raw in raw_claims:
        claim_id = str(raw.get("claim_id") or raw.get("claimId") or _stable_token("claim", str(raw)))
        claimant_id = str(raw.get("claimant_id") or raw.get("claimantId") or raw.get("member_id") or raw.get("memberId") or "unknown_claimant")
        provider_id = str(raw.get("provider_id") or raw.get("providerId") or "unknown_provider")

        phone = _optional_text(raw.get("phone"), raw.get("phone_number"))
        email = _optional_text(raw.get("email"))
        address = _optional_text(raw.get("address"), raw.get("home_region"))
        bank_account = _optional_text(raw.get("bank_account"), raw.get("bankAccount"), raw.get("banking_detail"))
        device_id = _optional_text(raw.get("device_id"), raw.get("deviceId"))
        ip_address = _optional_text(raw.get("ip_address"), raw.get("ipAddress"))

        normalized.append(
            NormalizedClaim(
                claim_id=claim_id,
                claimant_id=claimant_id,
                provider_id=provider_id,
                phone=phone,
                email=email,
                address=address,
                bank_account=bank_account,
                device_id=device_id,
                ip_address=ip_address,
            )
        )

    return sorted(normalized, key=lambda claim: (claim.claimant_id, claim.claim_id))


def _entity(entity_type: str, entity_id: str, value: str | None = None) -> dict[str, object]:
    payload: dict[str, object] = {
        "entity_id": entity_id,
        "entity_type": entity_type,
    }
    if value is not None:
        payload["value"] = value
    return payload


def build_internal_graph(normalized_claims: list[NormalizedClaim]) -> GraphDocument:
    entities: dict[str, dict[str, object]] = {}
    relationships: list[dict[str, object]] = []

    for claim in normalized_claims:
        claimant_entity_id = f"claimant:{claim.claimant_id}"
        provider_entity_id = f"provider:{claim.provider_id}"
        for entity in (
            _entity("claimant", claimant_entity_id, claim.claimant_id),
            _entity("provider", provider_entity_id, claim.provider_id),
        ):
            entities[entity["entity_id"]] = entity

        artifacts = [
            ("phone", claim.phone),
            ("email", claim.email),
            ("address", claim.address),
            ("bank_account", claim.bank_account),
            ("device", claim.device_id),
            ("ip", claim.ip_address),
        ]
        artifact_entity_ids = [provider_entity_id]
        for entity_type, value in artifacts:
            if value is None:
                continue
            entity_id = _stable_token(entity_type, value)
            entities[entity_id] = _entity(entity_type, entity_id)
            artifact_entity_ids.append(entity_id)

        for artifact_entity_id in artifact_entity_ids:
            relationships.append(
                {
                    "relationship_type": "observed_with",
                    "source_entity_id": claimant_entity_id,
                    "target_entity_id": artifact_entity_id,
                    "claim_id": claim.claim_id,
                }
            )

    degree = Counter()
    for rel in relationships:
        degree[str(rel["source_entity_id"])] += 1
        degree[str(rel["target_entity_id"])] += 1

    summary = {
        "entity_count": len(entities),
        "relationship_count": len(relationships),
        "max_degree": max(degree.values(), default=0),
        "claimant_count": sum(1 for entity in entities.values() if entity["entity_type"] == "claimant"),
    }

    return GraphDocument(
        entities=sorted(entities.values(), key=lambda entity: str(entity["entity_id"])),
        relationships=sorted(
            relationships,
            key=lambda rel: (
                str(rel["source_entity_id"]),
                str(rel["target_entity_id"]),
                str(rel["claim_id"]),
            ),
        ),
        summary=summary,
    )


def _risk_from_hits(hits: list[dict[str, object]]) -> dict[str, object]:
    if not hits:
        return {
            "riskScore": 0,
            "severity": "Low",
            "reasons": ["No detection rules were triggered"],
        }

    weighted_score = 0
    reasons: list[str] = []
    for hit in hits:
        weight = int(hit["weight"])
        weighted_score += weight
        reasons.append(f"{hit['title']}: {', '.join(hit['evidence'])}")

    risk_score = min(100, weighted_score)
    severity = "Low"
    if risk_score >= 70:
        severity = "High"
    elif risk_score >= 40:
        severity = "Medium"

    return {
        "riskScore": risk_score,
        "severity": severity,
        "reasons": reasons,
    }


def run_detection_pipeline(
    raw_claims: list[dict[str, object]],
    *,
    ledger_reference: dict[str, object] | None = None,
    graph_store: GraphStore | None = None,
) -> dict[str, object]:
    normalized_claims = normalize_claim_data(raw_claims)
    graph = build_internal_graph(normalized_claims)

    claim_counts = Counter(f"claimant:{claim.claimant_id}" for claim in normalized_claims)
    rule_engine = RuleEngine()
    rule_hits = rule_engine.evaluate(
        GraphForRules(
            entities=graph.entities,
            relationships=graph.relationships,
            claim_counts=dict(claim_counts),
        ),
    )

    serialized_hits = [
        {
            "rule_id": hit.rule_id,
            "title": hit.title,
            "weight": hit.weight,
            "evidence": hit.evidence,
        }
        for hit in rule_hits
    ]

    risk = _risk_from_hits(serialized_hits)
    evidence = [item for hit in serialized_hits for item in hit["evidence"]]

    store = graph_store or InMemoryGraphStore()
    store.write(graph)

    return {
        "entities": graph.entities,
        "relationships": graph.relationships,
        "triggered_rules": serialized_hits,
        "risk_score": risk,
        "evidence": evidence,
        "graph_summary": graph.summary,
        "ledger_reference": ledger_reference,
    }
