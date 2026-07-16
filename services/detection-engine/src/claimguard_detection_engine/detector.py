from __future__ import annotations

from pathlib import Path
from statistics import median
import hashlib
import json
from dataclasses import asdict

from .analytics import analyze_member, analyze_provider
from .loader import SchemeData, load_data_bundle, load_scheme_directory
from .orchestration import DetectionSnapshot, run_detection_orchestration


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


def analyze_directory(
    data_dir: Path,
    top_n: int = 10,
    *,
    tenant_id: str = "tenant_default",
    tenant_slug: str | None = None,
    correlation_id: str = "static-csv",
) -> dict[str, object]:
    bundle = load_data_bundle(data_dir)
    canonical_rows = {
        "claims": [asdict(claim) for scheme in bundle.schemes.values() for claim in scheme.claims],
        "providers": [asdict(provider) for scheme in bundle.schemes.values() for provider in scheme.providers.values()],
        "members": [asdict(member) for scheme in bundle.schemes.values() for member in scheme.members.values()],
    }
    watermark = hashlib.sha256(
        json.dumps(canonical_rows, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    service_dates = [claim.service_date for scheme in bundle.schemes.values() for claim in scheme.claims]
    snapshot_cutoff = f"{max(service_dates)}T23:59:59Z" if service_dates else "1970-01-01T00:00:00Z"
    return run_detection_orchestration(
        DetectionSnapshot(
            bundle=bundle,
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            tenant_display_name=tenant_slug,
            snapshot_cutoff=snapshot_cutoff,
            source_type="static_csv",
            source_watermark=f"sha256:{watermark}",
            generation_correlation_id=correlation_id,
        ),
        top_n=top_n,
    )


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
