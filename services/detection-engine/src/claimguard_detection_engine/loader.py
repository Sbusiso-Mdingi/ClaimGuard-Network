from __future__ import annotations

import csv
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
    synthetic_id_number: str
    synthetic_banking_detail: str
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
    synthetic_banking_detail: str
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


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _as_float(value: str | None) -> float:
    return float(value) if value not in (None, "") else 0.0


def _load_scheme_dir(scheme_dir: Path) -> SchemeData:
    scheme_id = scheme_dir.name.split("_")[-1].upper()
    members_path = scheme_dir / "members.csv"
    providers_path = scheme_dir / "providers.csv"
    claims_path = scheme_dir / "claims.csv"

    if not (members_path.exists() and providers_path.exists() and claims_path.exists()):
        raise FileNotFoundError(f"Missing expected CSV exports in {scheme_dir}")

    members = {
        row["member_id"]: MemberRecord(
            member_id=row["member_id"],
            scheme_id=row["scheme_id"],
            first_name=row["first_name"],
            last_name=row["last_name"],
            date_of_birth=row["date_of_birth"],
            gender=row.get("gender", ""),
            synthetic_id_number=row["synthetic_id_number"],
            synthetic_banking_detail=row["synthetic_banking_detail"],
            home_region=row["home_region"],
            home_lat=_as_float(row["home_lat"]),
            home_lon=_as_float(row["home_lon"]),
            join_date=row["join_date"],
        )
        for row in _read_csv(members_path)
    }

    providers = {
        row["provider_id"]: ProviderRecord(
            provider_id=row["provider_id"],
            scheme_id=row["scheme_id"],
            practice_number=row["practice_number"],
            specialty=row["specialty"],
            practice_name=row["practice_name"],
            synthetic_banking_detail=row["synthetic_banking_detail"],
            practice_region=row["practice_region"],
            practice_lat=_as_float(row["practice_lat"]),
            practice_lon=_as_float(row["practice_lon"]),
        )
        for row in _read_csv(providers_path)
    }

    claims = [
        ClaimRecord(
            claim_id=row["claim_id"],
            scheme_id=row["scheme_id"],
            member_id=row["member_id"],
            provider_id=row["provider_id"],
            service_date=row["service_date"],
            billing_code=row["billing_code"],
            amount=_as_float(row["amount"]),
        )
        for row in _read_csv(claims_path)
    ]

    return SchemeData(scheme_id=scheme_id, members=members, providers=providers, claims=claims)


def load_scheme_directory(scheme_dir: Path) -> SchemeData:
    return _load_scheme_dir(scheme_dir)


def load_data_bundle(data_dir: Path) -> DataBundle:
    scheme_dirs = sorted(
        path
        for path in data_dir.iterdir()
        if path.is_dir()
        and path.name in {"scheme_a", "scheme_b", "scheme_c"}
        and (path / "providers.csv").exists()
    )
    schemes = {scheme_dir.name.split("_")[-1].upper(): _load_scheme_dir(scheme_dir) for scheme_dir in scheme_dirs}
    return DataBundle(data_dir=data_dir, schemes=schemes)


def build_data_bundle_from_records(
    *,
    schemes: list[dict[str, object]],
    members: list[dict[str, object]],
    providers: list[dict[str, object]],
    claims: list[dict[str, object]],
    data_dir: Path | None = None,
) -> DataBundle:
    """Adapt persisted tenant rows to the same immutable model used by CSV input."""

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
            synthetic_id_number=str(row.get("synthetic_id_number") or ""),
            synthetic_banking_detail=str(row.get("synthetic_banking_detail") or ""),
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
            synthetic_banking_detail=str(row.get("synthetic_banking_detail") or ""),
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
