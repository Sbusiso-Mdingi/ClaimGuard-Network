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
