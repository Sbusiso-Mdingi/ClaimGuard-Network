from __future__ import annotations

from pathlib import Path
from statistics import median

from .analytics import analyze_member, analyze_provider, build_report
from .loader import SchemeData, load_scheme_directory


def analyze_scheme_directory(scheme_dir: Path, top_n: int = 10) -> dict[str, object]:
    scheme = load_scheme_directory(scheme_dir)
    provider_claims = _provider_claims(scheme)
    member_claims = _member_claims(scheme)
    provider_findings = [analyze_provider(provider, scheme, provider_claims) for provider in scheme.providers.values()]
    member_findings = [analyze_member(member, scheme, member_claims, scheme.providers) for member in scheme.members.values()]

    return {
        "scheme_id": scheme.scheme_id.lower(),
        "provider_count": len(scheme.providers),
        "claim_count": len(scheme.claims),
        "member_count": len(scheme.members),
        "provider_findings": _trim_findings(provider_findings, top_n),
        "member_findings": _trim_findings(member_findings, top_n),
        "summary": {
            "provider_score_median": _median_score(provider_findings),
            "member_score_median": _median_score(member_findings),
        },
    }


def analyze_directory(data_dir: Path, top_n: int = 10) -> dict[str, object]:
    return build_report(data_dir, top_n=top_n)


def _provider_claims(scheme: SchemeData) -> dict[str, list]:
    provider_claims: dict[str, list] = {}
    for claim in scheme.claims:
        provider_claims.setdefault(claim.provider_id, []).append(claim)
    return provider_claims


def _member_claims(scheme: SchemeData) -> dict[str, list]:
    member_claims: dict[str, list] = {}
    for claim in scheme.claims:
        member_claims.setdefault(claim.member_id, []).append(claim)
    return member_claims


def _trim_findings(findings, top_n: int) -> list[dict[str, object]]:
    ordered = sorted(findings, key=lambda item: item.score, reverse=True)
    top = ordered[:top_n] if top_n > 0 else ordered
    return [
        {
            "entity_id": finding.entity_id,
            "score": finding.score,
            "category": finding.category,
            "reasons": finding.reasons,
            "metrics": finding.metrics,
        }
        for finding in top
    ]


def _median_score(findings) -> float:
    scores = [finding.score for finding in findings]
    return round(median(scores), 3) if scores else 0.0
