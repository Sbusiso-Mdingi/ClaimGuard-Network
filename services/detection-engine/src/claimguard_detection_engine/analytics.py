from __future__ import annotations

import json
import math
import hashlib
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime
from itertools import combinations
from pathlib import Path

from .loader import ClaimRecord, DataBundle, MemberRecord, ProviderRecord, SchemeData, load_data_bundle
from .pipeline import run_detection_pipeline
from .reference_data import CODE_LOOKUP, SPECIALTIES


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _entropy(counts: Counter[str]) -> float:
    total = sum(counts.values())
    if not total:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        probability = count / total
        entropy -= probability * math.log(probability, 2)
    return entropy


def _cosine_similarity(left: dict[str, float], right: dict[str, float]) -> float:
    keys = set(left) | set(right)
    if not keys:
        return 0.0
    dot = sum(left.get(key, 0.0) * right.get(key, 0.0) for key in keys)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)


def _robust_zscore(value: float, values: list[float]) -> float:
    if not values:
        return 0.0

    median = statistics.median(values)
    deviations = [abs(item - median) for item in values]
    mad = statistics.median(deviations)
    if mad:
        return 0.6745 * (value - median) / mad

    if len(values) > 1:
        stdev = statistics.pstdev(values)
        if stdev:
            return (value - statistics.mean(values)) / stdev

    return 0.0


def _parse_date(value: str) -> date:
    return datetime.fromisoformat(value).date()


def _age_on(dob_iso: str, on_date: date) -> int:
    born = datetime.fromisoformat(dob_iso).date()
    years = on_date.year - born.year
    if (on_date.month, on_date.day) < (born.month, born.day):
        years -= 1
    return years


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)
    a = math.sin(delta_lat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def _dataframe_like(values: list[float]) -> dict[str, float]:
    if not values:
        return {"mean": 0.0, "stdev": 0.0, "median": 0.0, "mad": 0.0}
    median = statistics.median(values)
    deviations = [abs(value - median) for value in values]
    mad = statistics.median(deviations) if deviations else 0.0
    return {
        "mean": statistics.mean(values),
        "stdev": statistics.pstdev(values) if len(values) > 1 else 0.0,
        "median": median,
        "mad": mad,
    }


@dataclass(frozen=True)
class Finding:
    entity_id: str
    score: float
    category: str
    reasons: list[str]
    metrics: dict[str, float | int | str]


def _provider_claims(scheme: SchemeData) -> dict[str, list[ClaimRecord]]:
    provider_claims: dict[str, list[ClaimRecord]] = defaultdict(list)
    for claim in scheme.claims:
        provider_claims[claim.provider_id].append(claim)
    return provider_claims


def _member_claims(scheme: SchemeData) -> dict[str, list[ClaimRecord]]:
    member_claims: dict[str, list[ClaimRecord]] = defaultdict(list)
    for claim in scheme.claims:
        member_claims[claim.member_id].append(claim)
    return member_claims


def analyze_provider(provider: ProviderRecord, scheme: SchemeData, provider_claims: dict[str, list[ClaimRecord]]) -> Finding:
    claims = provider_claims.get(provider.provider_id, [])
    specialty = SPECIALTIES[provider.specialty]
    claim_count = len(claims)
    if not claims:
        return Finding(provider.provider_id, 0.0, "provider", ["No claims recorded"], {"claim_count": 0})

    amounts = [claim.amount for claim in claims]
    daily_counts = Counter(_parse_date(claim.service_date) for claim in claims)
    codes = Counter(claim.billing_code for claim in claims)
    active_days = len(daily_counts)
    claims_per_day = claim_count / active_days if active_days else float(claim_count)
    avg_amount = statistics.mean(amounts)
    amount_cv = (statistics.pstdev(amounts) / avg_amount) if len(amounts) > 1 and avg_amount else 0.0
    peak_day = max(daily_counts.values(), default=0)
    expected_daily_capacity = specialty.monthly_capacity_baseline / 22.0
    peak_capacity_ratio = peak_day / expected_daily_capacity if expected_daily_capacity else 0.0
    unique_members = len({claim.member_id for claim in claims})
    claims_per_member = claim_count / unique_members if unique_members else float(claim_count)
    dominant_code_share = max(codes.values(), default=0) / claim_count if claim_count else 0.0
    code_entropy = _entropy(codes)

    peers = [peer for peer in scheme.providers.values() if peer.specialty == provider.specialty and peer.provider_id != provider.provider_id]
    peer_claim_rates: list[float] = []
    peer_avg_amounts: list[float] = []
    peer_peak_ratios = []
    peer_claims_per_member = []
    peer_amount_cvs = []
    peer_code_entropies = []
    for peer in peers:
        peer_claim_list = provider_claims.get(peer.provider_id, [])
        if not peer_claim_list:
            continue
        peer_daily = Counter(_parse_date(claim.service_date) for claim in peer_claim_list)
        peer_unique_members = len({claim.member_id for claim in peer_claim_list})
        peer_avg_amount = statistics.mean(claim.amount for claim in peer_claim_list)
        peer_amount_cv = (statistics.pstdev([claim.amount for claim in peer_claim_list]) / peer_avg_amount) if len(peer_claim_list) > 1 and peer_avg_amount else 0.0
        peer_peak_ratio = max(peer_daily.values(), default=0) / expected_daily_capacity if expected_daily_capacity else 0.0
        peer_code_counts = Counter(claim.billing_code for claim in peer_claim_list)
        peer_claim_rate = len(peer_claim_list) / max(1, len(peer_daily))
        peer_peak_ratios.append(peer_peak_ratio)
        peer_claim_rates.append(peer_claim_rate)
        peer_avg_amounts.append(peer_avg_amount)
        peer_claims_per_member.append(len(peer_claim_list) / max(1, peer_unique_members))
        peer_amount_cvs.append(peer_amount_cv)
        peer_code_entropies.append(_entropy(peer_code_counts))

    amount_z = max(0.0, _robust_zscore(avg_amount, peer_avg_amounts))
    claim_rate_z = max(0.0, _robust_zscore(claims_per_day, peer_claim_rates))
    peak_z = max(0.0, _robust_zscore(peak_capacity_ratio, peer_peak_ratios))
    ring_z = max(0.0, _robust_zscore(claims_per_member, peer_claims_per_member))
    diversity_z = max(0.0, _robust_zscore(code_entropy, peer_code_entropies))

    upcoding_signal = _clamp01(amount_z / 3.0)
    ghost_signal = _clamp01(peak_capacity_ratio / 4.0 + peak_z / 5.0 + claim_rate_z / 4.0)
    collusion_signal = _clamp01(ring_z / 3.0 + (1.0 - min(1.0, amount_cv * 4.0)) + dominant_code_share)
    behavior_similarity = _clamp01((1.0 - min(1.0, amount_cv * 3.0)) * 0.35 + dominant_code_share * 0.4 + (1.0 - min(1.0, code_entropy / 3.0)) * 0.25)

    score = round(100.0 * (0.45 * upcoding_signal + 0.35 * ghost_signal + 0.20 * collusion_signal), 3)
    category = max(
        {
            "up_coding": upcoding_signal,
            "ghost_claiming": ghost_signal,
            "collusion_ring": collusion_signal,
            "behavioral_match": behavior_similarity,
        }.items(),
        key=lambda item: item[1],
    )[0]

    reasons: list[str] = []
    if upcoding_signal >= 0.35:
        reasons.append(f"average amount {avg_amount:.2f} is high for {provider.specialty}")
    if ghost_signal >= 0.35:
        reasons.append(f"peak day volume {peak_day} is above plausible capacity for {provider.specialty}")
    if collusion_signal >= 0.40:
        reasons.append(f"claims are concentrated across {unique_members} members with limited amount variation")
    if dominant_code_share >= 0.55:
        reasons.append(f"billing-code concentration is {dominant_code_share:.0%}")

    return Finding(
        entity_id=provider.provider_id,
        score=score,
        category=category,
        reasons=reasons,
        metrics={
            "scheme_id": provider.scheme_id,
            "specialty": provider.specialty,
            "claim_count": claim_count,
            "claims_per_day": round(claims_per_day, 2),
            "peak_day": peak_day,
            "peak_capacity_ratio": round(peak_capacity_ratio, 2),
            "unique_members": unique_members,
            "claims_per_member": round(claims_per_member, 2),
            "average_amount": round(avg_amount, 2),
            "amount_cv": round(amount_cv, 3),
            "dominant_code_share": round(dominant_code_share, 3),
            "upcoding_signal": round(upcoding_signal, 3),
            "ghost_signal": round(ghost_signal, 3),
            "collusion_signal": round(collusion_signal, 3),
            "behavior_similarity": round(behavior_similarity, 3),
        },
    )


def analyze_member(member: MemberRecord, scheme: SchemeData, member_claims: dict[str, list[ClaimRecord]], providers: dict[str, ProviderRecord]) -> Finding:
    claims = member_claims.get(member.member_id, [])
    if not claims:
        return Finding(member.member_id, 0.0, "member", ["No claims recorded"], {"claim_count": 0})

    claim_count = len(claims)
    providers_claimed = {claim.provider_id for claim in claims}
    provider_share = max(Counter(claim.provider_id for claim in claims).values()) / claim_count
    amounts = [claim.amount for claim in claims]
    amount_cv = (statistics.pstdev(amounts) / statistics.mean(amounts)) if len(amounts) > 1 and statistics.mean(amounts) else 0.0
    claim_by_day: dict[str, list[ClaimRecord]] = defaultdict(list)
    for claim in claims:
        claim_by_day[claim.service_date].append(claim)

    same_day_provider_peak = max((len({claim.provider_id for claim in same_day_claims}) for same_day_claims in claim_by_day.values()), default=0)
    max_same_day_distance = 0.0
    for same_day_claims in claim_by_day.values():
        for left, right in combinations(same_day_claims, 2):
            left_provider = providers.get(left.provider_id)
            right_provider = providers.get(right.provider_id)
            if left_provider and right_provider:
                max_same_day_distance = max(
                    max_same_day_distance,
                    _distance_km(left_provider.practice_lat, left_provider.practice_lon, right_provider.practice_lat, right_provider.practice_lon),
                )

    violations = 0
    violation_details: list[str] = []
    for claim in claims:
        provider = providers.get(claim.provider_id)
        if not provider:
            continue
        specialty = SPECIALTIES.get(provider.specialty)
        if not specialty:
            continue
        claim_date = _parse_date(claim.service_date)
        age = _age_on(member.date_of_birth, claim_date)
        for code in specialty.codes:
            if code.code != claim.billing_code:
                continue
            if code.gender_restriction and member.gender != code.gender_restriction:
                violations += 1
                violation_details.append(
                    f"code {code.code} restricted to gender={code.gender_restriction}; member is gender={member.gender}"
                )
                break
            if (code.min_age is not None and age < code.min_age) or (code.max_age is not None and age > code.max_age):
                violations += 1
                violation_details.append(
                    f"code {code.code} restricted to age {code.min_age}-{code.max_age}; member age is {age}"
                )
                break

    member_provider = Counter(claim.provider_id for claim in claims).most_common(1)
    dominant_provider_share = member_provider[0][1] / claim_count if member_provider else 0.0
    interval_days: list[int] = []
    sorted_dates = sorted(_parse_date(claim.service_date) for claim in claims)
    for left, right in zip(sorted_dates, sorted_dates[1:]):
        interval_days.append((right - left).days)
    interval_cv = (statistics.pstdev(interval_days) / statistics.mean(interval_days)) if len(interval_days) > 1 and statistics.mean(interval_days) else 0.0

    geo_signal = _clamp01((max_same_day_distance - 200.0) / 1000.0 + max(0.0, same_day_provider_peak - 1) / 3.0)
    demo_signal = _clamp01(violations / max(1, claim_count))
    ring_signal = _clamp01((dominant_provider_share - 0.75) / 0.25 + (1.0 - min(1.0, amount_cv * 5.0)) + (1.0 - min(1.0, interval_cv)))
    behavior_signal = _clamp01((claim_count / 60.0) + same_day_provider_peak / 3.0)

    score = round(100.0 * (0.5 * geo_signal + 0.35 * demo_signal + 0.15 * ring_signal), 3)
    category = max(
        {
            "geographic_substitution": geo_signal,
            "demographic_substitution": demo_signal,
            "collusion_member": ring_signal,
            "behavioral_match": behavior_signal,
        }.items(),
        key=lambda item: item[1],
    )[0]

    reasons: list[str] = []
    if geo_signal >= 0.35:
        reasons.append(f"same-day provider distance reached {max_same_day_distance:.1f} km")
    if demo_signal >= 0.20:
        reasons.extend(violation_details[:2])
    if ring_signal >= 0.35:
        reasons.append(f"claims are concentrated around {member_provider[0][0]} with low variation")

    return Finding(
        entity_id=member.member_id,
        score=score,
        category=category,
        reasons=reasons,
        metrics={
            "scheme_id": member.scheme_id,
            "claim_count": claim_count,
            "unique_providers": len(providers_claimed),
            "same_day_provider_peak": same_day_provider_peak,
            "max_same_day_distance_km": round(max_same_day_distance, 1),
            "billing_violations": violations,
            "dominant_provider_share": round(dominant_provider_share, 3),
            "amount_cv": round(amount_cv, 3),
            "interval_cv": round(interval_cv, 3),
            "geo_signal": round(geo_signal, 3),
            "demo_signal": round(demo_signal, 3),
            "ring_signal": round(ring_signal, 3),
            "behavior_signal": round(behavior_signal, 3),
        },
    )


def _normalize_findings(findings: list[Finding], top_n: int) -> list[dict[str, object]]:
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


def _exact_banking_links(bundle: DataBundle) -> list[dict[str, object]]:
    by_banking_detail: dict[str, list[ProviderRecord]] = defaultdict(list)
    for scheme in bundle.schemes.values():
        for provider in scheme.providers.values():
            by_banking_detail[provider.synthetic_banking_detail].append(provider)

    links: list[dict[str, object]] = []
    for banking_detail, providers in by_banking_detail.items():
        schemes = {provider.scheme_id for provider in providers}
        if len(schemes) < 2:
            continue
        links.append(
            {
                "link_type": "exact_banking_match",
                "synthetic_banking_detail": banking_detail,
                "providers": [
                    {
                        "provider_id": provider.provider_id,
                        "scheme_id": provider.scheme_id,
                        "specialty": provider.specialty,
                        "practice_region": provider.practice_region,
                    }
                    for provider in providers
                ],
                "confidence": 1.0,
            }
        )
    return links


def _provider_signature(provider: ProviderRecord, claims: list[ClaimRecord]) -> dict[str, object]:
    code_counts = Counter(claim.billing_code for claim in claims)
    month_counts = Counter(claim.service_date[:7] for claim in claims)
    day_counts = Counter(datetime.fromisoformat(claim.service_date).date().weekday() for claim in claims)
    amount_values = [claim.amount for claim in claims]
    amount_mean = statistics.mean(amount_values) if amount_values else 0.0
    amount_cv = (statistics.pstdev(amount_values) / amount_mean) if len(amount_values) > 1 and amount_mean else 0.0
    daily_counts = Counter(claim.service_date for claim in claims)
    active_days = len(daily_counts)
    claims_per_day = len(claims) / active_days if active_days else 0.0
    return {
        "provider_id": provider.provider_id,
        "scheme_id": provider.scheme_id,
        "specialty": provider.specialty,
        "code_vector": {code: float(count) for code, count in code_counts.items()},
        "month_vector": {month: float(count) for month, count in month_counts.items()},
        "weekday_vector": {str(day): float(count) for day, count in day_counts.items()},
        "amount_mean": amount_mean,
        "amount_cv": amount_cv,
        "claims_per_day": claims_per_day,
        "practice_region": provider.practice_region,
        "banking_detail": provider.synthetic_banking_detail,
    }


def _provider_similarity(left: dict[str, object], right: dict[str, object]) -> float:
    if left["specialty"] != right["specialty"]:
        return 0.0

    code_similarity = _cosine_similarity(left["code_vector"], right["code_vector"])
    month_similarity = _cosine_similarity(left["month_vector"], right["month_vector"])
    weekday_similarity = _cosine_similarity(left["weekday_vector"], right["weekday_vector"])
    amount_mean_left = float(left["amount_mean"])
    amount_mean_right = float(right["amount_mean"])
    amount_similarity = 1.0 - min(1.0, abs(amount_mean_left - amount_mean_right) / max(amount_mean_left, amount_mean_right, 1.0))
    claims_per_day_similarity = 1.0 - min(1.0, abs(float(left["claims_per_day"]) - float(right["claims_per_day"])) / max(float(left["claims_per_day"]), float(right["claims_per_day"]), 1.0))
    region_similarity = 1.0 if left["practice_region"] == right["practice_region"] else 0.6
    return 0.34 * code_similarity + 0.20 * month_similarity + 0.15 * weekday_similarity + 0.17 * amount_similarity + 0.09 * claims_per_day_similarity + 0.05 * region_similarity


def _provider_similarity_links(bundle: DataBundle, provider_findings: dict[str, Finding]) -> list[dict[str, object]]:
    signatures: dict[str, dict[str, object]] = {}
    for scheme in bundle.schemes.values():
        provider_claims = _provider_claims(scheme)
        for provider in scheme.providers.values():
            signatures[provider.provider_id] = _provider_signature(provider, provider_claims.get(provider.provider_id, []))

    links: list[dict[str, object]] = []
    provider_list = [provider for scheme in bundle.schemes.values() for provider in scheme.providers.values()]
    for left, right in combinations(provider_list, 2):
        if left.scheme_id == right.scheme_id:
            continue
        similarity = _provider_similarity(signatures[left.provider_id], signatures[right.provider_id])
        if similarity < 0.78:
            continue
        links.append(
            {
                "link_type": "behavioral_provider_match",
                "providers": [left.provider_id, right.provider_id],
                "schemes": [left.scheme_id, right.scheme_id],
                "confidence": round(similarity, 3),
            }
        )
    return links


def _connected_components(edges: list[tuple[str, str]]) -> list[list[str]]:
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        parent.setdefault(node, node)
        if parent[node] != node:
            parent[node] = find(parent[node])
        return parent[node]

    def union(left: str, right: str) -> None:
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for left, right in edges:
        union(left, right)

    buckets: dict[str, list[str]] = defaultdict(list)
    for node in parent:
        buckets[find(node)].append(node)
    return list(buckets.values())


def evaluate_against_ground_truth(bundle: DataBundle, provider_findings: dict[str, Finding], member_findings: dict[str, Finding], exact_links: list[dict[str, object]], fuzzy_links: list[dict[str, object]]) -> dict[str, object]:
    truth_path = bundle.data_dir / "ground_truth" / "planted_fraud.json"
    if not truth_path.exists():
        return {"available": False, "message": "ground truth not found"}

    truth = json.loads(truth_path.read_text(encoding="utf-8"))
    detected_single_scheme = 0
    total_single_scheme = len(truth.get("single_scheme_fraud", []))
    provider_positive = {entity_id for entity_id, finding in provider_findings.items() if finding.score >= 55.0}
    member_positive = {entity_id for entity_id, finding in member_findings.items() if finding.score >= 50.0}

    for item in truth.get("single_scheme_fraud", []):
        if item.get("entity_type") == "provider" and item.get("entity_id") in provider_positive:
            detected_single_scheme += 1
        if item.get("entity_type") == "member" and item.get("entity_id") in member_positive:
            detected_single_scheme += 1

    link_pairs = {
        tuple(sorted(link["providers"])) for link in fuzzy_links if link.get("link_type") == "behavioral_provider_match"
    }
    exact_pairs = {tuple(sorted(provider["provider_id"] for provider in link["providers"])) for link in exact_links}
    detected_cross_scheme = 0
    for item in truth.get("cross_scheme_evasion", []):
        left = item["original"]["provider_id"]
        right = item["reappeared_as"]["provider_id"]
        pair = tuple(sorted((left, right)))
        if pair in exact_pairs or pair in link_pairs:
            detected_cross_scheme += 1

    total_cross_scheme = len(truth.get("cross_scheme_evasion", []))
    return {
        "available": True,
        "single_scheme": {
            "detected": detected_single_scheme,
            "total": total_single_scheme,
            "recall": round(detected_single_scheme / total_single_scheme, 3) if total_single_scheme else 0.0,
        },
        "cross_scheme": {
            "detected": detected_cross_scheme,
            "total": total_cross_scheme,
            "recall": round(detected_cross_scheme / total_cross_scheme, 3) if total_cross_scheme else 0.0,
        },
    }


def build_report(data_dir: Path, top_n: int = 10) -> dict[str, object]:
    bundle = load_data_bundle(data_dir)
    scheme_reports: list[dict[str, object]] = []
    all_provider_findings: dict[str, Finding] = {}
    all_member_findings: dict[str, Finding] = {}

    for scheme in bundle.schemes.values():
        provider_claims = _provider_claims(scheme)
        member_claims = _member_claims(scheme)
        provider_findings = [analyze_provider(provider, scheme, provider_claims) for provider in scheme.providers.values()]
        member_findings = [analyze_member(member, scheme, member_claims, scheme.providers) for member in scheme.members.values()]
        for finding in provider_findings:
            all_provider_findings[finding.entity_id] = finding
        for finding in member_findings:
            all_member_findings[finding.entity_id] = finding

        scheme_reports.append(
            {
                "scheme_id": scheme.scheme_id,
                "provider_count": len(scheme.providers),
                "claim_count": len(scheme.claims),
                "member_count": len(scheme.members),
                "provider_findings": _normalize_findings(provider_findings, top_n),
                "member_findings": _normalize_findings(member_findings, top_n),
                "summary": {
                    "provider_score_median": round(statistics.median(finding.score for finding in provider_findings), 3) if provider_findings else 0.0,
                    "member_score_median": round(statistics.median(finding.score for finding in member_findings), 3) if member_findings else 0.0,
                },
            }
        )

    exact_links = _exact_banking_links(bundle)
    fuzzy_links = _provider_similarity_links(bundle, all_provider_findings)

    network_nodes = []
    for finding in all_provider_findings.values():
        network_nodes.append(
            {
                "node_id": finding.entity_id,
                "node_type": "provider",
                "score": finding.score,
                "category": finding.category,
                "scheme_id": finding.metrics.get("scheme_id"),
                "signals": {key: value for key, value in finding.metrics.items() if key.endswith("signal") or key.endswith("similarity")},
            }
        )

    edges = []
    union_edges: list[tuple[str, str]] = []
    for link in exact_links:
        providers = [provider["provider_id"] for provider in link["providers"]]
        for left, right in combinations(providers, 2):
            union_edges.append((left, right))
        edges.append(link)
    for link in fuzzy_links:
        providers = link["providers"]
        union_edges.append((providers[0], providers[1]))
        edges.append(link)

    components = _connected_components(union_edges)
    resolved_entities = []
    for index, component in enumerate(components, start=1):
        schemes = sorted({all_provider_findings[node].metrics.get("scheme_id") for node in component if node in all_provider_findings})
        if len(schemes) < 2:
            continue
        pair_confidences = []
        exact_pairs = {tuple(sorted(provider["provider_id"] for provider in link["providers"])) for link in exact_links}
        fuzzy_lookup = {tuple(sorted(link["providers"])): link["confidence"] for link in fuzzy_links}
        for left, right in combinations(component, 2):
            pair = tuple(sorted((left, right)))
            if pair in exact_pairs:
                pair_confidences.append(1.0)
            elif pair in fuzzy_lookup:
                pair_confidences.append(float(fuzzy_lookup[pair]))
        resolved_entities.append(
            {
                "resolved_entity_id": f"RE-{index:03d}",
                "providers": component,
                "schemes": schemes,
                "size": len(component),
                "confidence": round(max(pair_confidences, default=0.0), 3),
            }
        )

    evaluation = evaluate_against_ground_truth(bundle, all_provider_findings, all_member_findings, exact_links, fuzzy_links)

    raw_claims: list[dict[str, object]] = []
    for scheme in bundle.schemes.values():
        for claim in scheme.claims:
            member = scheme.members.get(claim.member_id)
            provider = scheme.providers.get(claim.provider_id)
            raw_claims.append(
                {
                    "claim_id": claim.claim_id,
                    "member_id": claim.member_id,
                    "provider_id": claim.provider_id,
                    "phone": f"{claim.member_id}-phone",
                    "email": f"{claim.member_id.lower()}@claimguard.synthetic",
                    "address": member.home_region if member else "unknown-region",
                    "bank_account": provider.synthetic_banking_detail if provider else "unknown-bank",
                    "device_id": f"device-{claim.member_id}",
                    "ip_address": f"10.{int(hashlib.sha256(claim.provider_id.encode('utf-8')).hexdigest()[:2], 16)}.{int(hashlib.sha256(claim.member_id.encode('utf-8')).hexdigest()[:2], 16)}.{int(hashlib.sha256(claim.claim_id.encode('utf-8')).hexdigest()[:2], 16)}",
                }
            )

    detection = run_detection_pipeline(
        raw_claims,
        ledger_reference={
            "type": "runtime-ledger",
            "available": False,
            "note": "Attach runtime ledger entries from the API service when database-backed ledger is enabled.",
        },
    )

    return {
        "data_dir": str(data_dir),
        "schemes": scheme_reports,
        "network": {
            "exact_banking_links": exact_links,
            "behavioral_provider_links": fuzzy_links,
            "resolved_entities": resolved_entities,
            "network_nodes": network_nodes,
        },
        "evaluation": evaluation,
        "detection": detection,
    }
