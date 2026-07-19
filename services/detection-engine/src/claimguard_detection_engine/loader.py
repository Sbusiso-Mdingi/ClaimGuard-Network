from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MemberRecord:
    member_id: str
    scheme_id: str
    first_name: str
    last_name: str
    date_of_birth: str
    gender: str
    identity_number: str
    banking_detail: str
    home_region: str
    home_lat: float
    home_lon: float
    join_date: str


@dataclass(frozen=True)
class ProviderRecord:
    provider_id: str
    scheme_id: str
    practice_number: str
    specialty: str
    practice_name: str
    banking_detail: str
    practice_region: str
    practice_lat: float
    practice_lon: float


@dataclass(frozen=True)
class ClaimRecord:
    claim_id: str
    scheme_id: str
    member_id: str
    provider_id: str
    service_date: str
    billing_code: str
    amount: float


@dataclass(frozen=True)
class SchemeData:
    scheme_id: str
    members: dict[str, MemberRecord]
    providers: dict[str, ProviderRecord]
    claims: list[ClaimRecord]


@dataclass(frozen=True)
class DataBundle:
    data_dir: Path
    schemes: dict[str, SchemeData]


def build_data_bundle_from_records(
    *,
    schemes: list[dict[str, object]],
    members: list[dict[str, object]],
    providers: list[dict[str, object]],
    claims: list[dict[str, object]],
    data_dir: Path | None = None,
) -> DataBundle:
    """Adapt authoritative tenant rows to the detection engine's immutable model."""

    scheme_ids = {str(row.get("scheme_id") or "").strip() for row in schemes}
    scheme_ids.discard("")
    if not scheme_ids:
        raise ValueError("At least one authoritative scheme record is required.")

    member_records: dict[str, dict[str, MemberRecord]] = {scheme_id: {} for scheme_id in scheme_ids}
    provider_records: dict[str, dict[str, ProviderRecord]] = {scheme_id: {} for scheme_id in scheme_ids}
    claim_records: dict[str, list[ClaimRecord]] = {scheme_id: [] for scheme_id in scheme_ids}

    for row in members:
        scheme_id = str(row.get("scheme_id") or "").strip()
        member_id = str(row.get("member_id") or "").strip()
        if scheme_id not in scheme_ids or not member_id:
            raise ValueError("Member rows must reference an authoritative scheme and member ID.")
        member_records[scheme_id][member_id] = MemberRecord(
            member_id=member_id,
            scheme_id=scheme_id,
            first_name=str(row.get("first_name") or ""),
            last_name=str(row.get("last_name") or ""),
            date_of_birth=str(row.get("date_of_birth") or ""),
            gender=str(row.get("gender") or ""),
            identity_number=str(row.get("identity_number") or ""),
            banking_detail=str(row.get("banking_detail") or ""),
            home_region=str(row.get("home_region") or ""),
            home_lat=float(row.get("home_lat") or 0.0),
            home_lon=float(row.get("home_lon") or 0.0),
            join_date=str(row.get("join_date") or ""),
        )

    for row in providers:
        scheme_id = str(row.get("scheme_id") or "").strip()
        provider_id = str(row.get("provider_id") or "").strip()
        if scheme_id not in scheme_ids or not provider_id:
            raise ValueError("Provider rows must reference an authoritative scheme and provider ID.")
        provider_records[scheme_id][provider_id] = ProviderRecord(
            provider_id=provider_id,
            scheme_id=scheme_id,
            practice_number=str(row.get("practice_number") or ""),
            specialty=str(row.get("specialty") or ""),
            practice_name=str(row.get("practice_name") or ""),
            banking_detail=str(row.get("banking_detail") or ""),
            practice_region=str(row.get("practice_region") or ""),
            practice_lat=float(row.get("practice_lat") or 0.0),
            practice_lon=float(row.get("practice_lon") or 0.0),
        )

    for row in claims:
        scheme_id = str(row.get("scheme_id") or "").strip()
        member_id = str(row.get("member_id") or "").strip()
        provider_id = str(row.get("provider_id") or "").strip()
        claim_id = str(row.get("claim_id") or "").strip()
        if scheme_id not in scheme_ids or not claim_id:
            raise ValueError("Claim rows must reference an authoritative scheme and claim ID.")
        if member_id not in member_records[scheme_id] or provider_id not in provider_records[scheme_id]:
            raise ValueError("Claim rows must reference tenant-scoped member and provider records.")
        claim_records[scheme_id].append(
            ClaimRecord(
                claim_id=claim_id,
                scheme_id=scheme_id,
                member_id=member_id,
                provider_id=provider_id,
                service_date=str(row.get("service_date") or ""),
                billing_code=str(row.get("billing_code") or ""),
                amount=float(row.get("amount") or 0.0),
            )
        )

    bundle_schemes = {
        scheme_id: SchemeData(
            scheme_id=scheme_id,
            members=member_records[scheme_id],
            providers=provider_records[scheme_id],
            claims=sorted(claim_records[scheme_id], key=lambda claim: claim.claim_id),
        )
        for scheme_id in sorted(scheme_ids)
    }
    return DataBundle(data_dir=data_dir or Path("tenant-snapshot"), schemes=bundle_schemes)
