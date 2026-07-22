#!/usr/bin/env python3
"""
ClaimGuard Desktop Simulator — Medical Aid Claims Ingestion
============================================================

This script simulates multiple medical aid schemes uploading claims to the
ClaimGuard Network API.  It is designed to run on an old desktop that acts as
a stand-in for the claims servers of different medical aids.

Usage
-----
    # Single scheme (Bonitas):
    python simulate_medical_aids.py \
        --api-url https://claimguard-api.example.com \
        --scheme bonitas

    # All configured schemes:
    python simulate_medical_aids.py \
        --api-url https://claimguard-api.example.com \
        --scheme all

    # Continuous mode — submit a batch every 30 seconds:
    python simulate_medical_aids.py \
        --api-url https://claimguard-api.example.com \
        --scheme all \
        --continuous --interval 30

Environment Variables
---------------------
    CLAIMGUARD_BONITAS_TOKEN     Bearer token for Bonitas
    CLAIMGUARD_DISCOVERY_TOKEN   Bearer token for Discovery
    CLAIMGUARD_GEMS_TOKEN        Bearer token for GEMS
    CLAIMGUARD_SCHEME_KEY        HMAC scheme key for PII tokenization (POPIA)

POPIA / Privacy Compliance
---------------------------
All personally-identifiable information (PII) is tokenized **before** it
leaves this machine using HMAC-SHA256 via the ClaimGuard Edge SDK.  No raw
names, ID numbers, or banking details are ever transmitted over the wire.

This is required by:
  • POPIA (Protection of Personal Information Act, South Africa)
  • GDPR Art 32 — pseudonymisation as a security measure
  • HIPAA Safe Harbor — de-identification of protected health information

Even for demo data, we enforce the same tokenization pipeline so that the
full end-to-end flow is exercised.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────
# Import the ClaimGuard Edge SDK for POPIA-compliant tokenization.
# Falls back to a built-in HMAC implementation if the SDK is not installed.
# ──────────────────────────────────────────────────────────────────────
try:
    from claimguard_sdk.client import ClaimGuardClient
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    import hashlib
    import hmac

    def _tokenize(value: str, scheme_key: str, purpose: str = "ID") -> str:
        """Standalone HMAC-SHA256 tokenization (mirrors the SDK)."""
        key = scheme_key.strip().encode("utf-8")
        msg = f"{purpose}:{value.strip()}".encode("utf-8")
        return hmac.new(key, msg, hashlib.sha256).hexdigest()


# ──────────────────────────────────────────────────────────────────────
#  Demo data — South African medical scheme simulation
# ──────────────────────────────────────────────────────────────────────

SCHEME_CONFIGS = {
    "bonitas": {
        "scheme_id": "SCH-BONITAS",
        "scheme_name": "Bonitas Medical Fund",
        "token_env": "CLAIMGUARD_BONITAS_TOKEN",
        "source": "bonitas-claims-server",
        "members": [
            {"member_id": "BON-M001", "scheme_id": "SCH-BONITAS", "first_name": "Thabo", "last_name": "Mokoena", "date_of_birth": "1985-06-15", "gender": "Male", "identity_number": "8506155012083", "banking_detail": "FNB-62012345678", "home_region": "Gauteng", "home_lat": -26.2, "home_lon": 28.0, "join_date": "2020-01-15"},
            {"member_id": "BON-M002", "scheme_id": "SCH-BONITAS", "first_name": "Lerato", "last_name": "Dlamini", "date_of_birth": "1992-03-22", "gender": "Female", "identity_number": "9203220156089", "banking_detail": "ABSA-40712345678", "home_region": "KwaZulu-Natal", "home_lat": -29.9, "home_lon": 31.0, "join_date": "2021-06-01"},
            {"member_id": "BON-M003", "scheme_id": "SCH-BONITAS", "first_name": "Sipho", "last_name": "Ndlovu", "date_of_birth": "1978-11-03", "gender": "Male", "identity_number": "7811035028084", "banking_detail": "NEDBANK-10123456789", "home_region": "Mpumalanga", "home_lat": -25.5, "home_lon": 30.6, "join_date": "2019-03-10"},
            {"member_id": "BON-M004", "scheme_id": "SCH-BONITAS", "first_name": "Naledi", "last_name": "Khumalo", "date_of_birth": "1990-08-17", "gender": "Female", "identity_number": "9008170234087", "banking_detail": "STD-01012345678", "home_region": "Gauteng", "home_lat": -26.1, "home_lon": 28.1, "join_date": "2022-01-20"},
        ],
        "providers": [
            {"provider_id": "BON-P001", "scheme_id": "SCH-BONITAS", "practice_number": "0512345", "specialty": "General Practice", "practice_name": "Mokoena Family Practice", "banking_detail": "FNB-62098765432", "practice_region": "Gauteng", "practice_lat": -26.2, "practice_lon": 28.0},
            {"provider_id": "BON-P002", "scheme_id": "SCH-BONITAS", "practice_number": "0523456", "specialty": "Radiology", "practice_name": "JHB Radiology Centre", "banking_detail": "ABSA-40798765432", "practice_region": "Gauteng", "practice_lat": -26.2, "practice_lon": 28.1},
            {"provider_id": "BON-P003", "scheme_id": "SCH-BONITAS", "practice_number": "0534567", "specialty": "Orthopaedics", "practice_name": "Pretoria Ortho Clinic", "banking_detail": "NEDBANK-10987654321", "practice_region": "Gauteng", "practice_lat": -25.7, "practice_lon": 28.2},
        ],
    },
    "discovery": {
        "scheme_id": "SCH-DISCOVERY",
        "scheme_name": "Discovery Health Medical Scheme",
        "token_env": "CLAIMGUARD_DISCOVERY_TOKEN",
        "source": "discovery-claims-server",
        "members": [
            {"member_id": "DIS-M001", "scheme_id": "SCH-DISCOVERY", "first_name": "Pieter", "last_name": "Van der Merwe", "date_of_birth": "1980-04-10", "gender": "Male", "identity_number": "8004105034085", "banking_detail": "FNB-62087654321", "home_region": "Western Cape", "home_lat": -33.9, "home_lon": 18.4, "join_date": "2018-07-01"},
            {"member_id": "DIS-M002", "scheme_id": "SCH-DISCOVERY", "first_name": "Ayanda", "last_name": "Zulu", "date_of_birth": "1995-12-08", "gender": "Female", "identity_number": "9512080178086", "banking_detail": "CAPITEC-13012345678", "home_region": "Gauteng", "home_lat": -26.0, "home_lon": 28.3, "join_date": "2023-01-15"},
            {"member_id": "DIS-M003", "scheme_id": "SCH-DISCOVERY", "first_name": "Jannie", "last_name": "Botha", "date_of_birth": "1972-09-25", "gender": "Male", "identity_number": "7209255091082", "banking_detail": "STD-01098765432", "home_region": "Free State", "home_lat": -29.1, "home_lon": 26.2, "join_date": "2017-02-28"},
        ],
        "providers": [
            {"provider_id": "DIS-P001", "scheme_id": "SCH-DISCOVERY", "practice_number": "0612345", "specialty": "General Practice", "practice_name": "Cape Town Medical Group", "banking_detail": "FNB-62076543210", "practice_region": "Western Cape", "practice_lat": -33.9, "practice_lon": 18.4},
            {"provider_id": "DIS-P002", "scheme_id": "SCH-DISCOVERY", "practice_number": "0623456", "specialty": "Pathology", "practice_name": "Sandton Pathology Lab", "banking_detail": "ABSA-40787654321", "practice_region": "Gauteng", "practice_lat": -26.1, "practice_lon": 28.1},
        ],
    },
    "gems": {
        "scheme_id": "SCH-GEMS",
        "scheme_name": "Government Employees Medical Scheme",
        "token_env": "CLAIMGUARD_GEMS_TOKEN",
        "source": "gems-claims-server",
        "members": [
            {"member_id": "GEM-M001", "scheme_id": "SCH-GEMS", "first_name": "Mandla", "last_name": "Mthembu", "date_of_birth": "1988-02-14", "gender": "Male", "identity_number": "8802145056081", "banking_detail": "ABSA-40776543210", "home_region": "Gauteng", "home_lat": -25.8, "home_lon": 28.3, "join_date": "2019-09-01"},
            {"member_id": "GEM-M002", "scheme_id": "SCH-GEMS", "first_name": "Zanele", "last_name": "Nkosi", "date_of_birth": "1993-07-20", "gender": "Female", "identity_number": "9307200198088", "banking_detail": "NEDBANK-10876543210", "home_region": "Limpopo", "home_lat": -23.9, "home_lon": 29.4, "join_date": "2021-04-15"},
        ],
        "providers": [
            {"provider_id": "GEM-P001", "scheme_id": "SCH-GEMS", "practice_number": "0712345", "specialty": "General Practice", "practice_name": "Tshwane Government Clinic", "banking_detail": "STD-01087654321", "practice_region": "Gauteng", "practice_lat": -25.7, "practice_lon": 28.2},
        ],
    },
}

# South African ICD-10 and billing codes commonly used in medical scheme claims
BILLING_CODES = [
    "0190",   # GP consultation
    "0191",   # Follow-up consultation
    "0200",   # After-hours consultation
    "3604",   # Blood test
    "3610",   # Full blood count
    "3616",   # Glucose test
    "3633",   # Lipogram
    "3700",   # Chest X-ray
    "3710",   # Abdominal X-ray
    "3714",   # Lumbar spine X-ray
    "0007",   # Repeat prescription
    "0051",   # ECG
    "2701",   # MRI scan
]


def _rand_amount() -> float:
    """Generate a realistic claim amount in ZAR."""
    return round(random.uniform(150.0, 15000.0), 2)


def _rand_date(days_back: int = 90) -> str:
    """Generate a random service date within the last N days."""
    delta = timedelta(days=random.randint(0, days_back))
    return (date.today() - delta).isoformat()


def generate_claims(
    scheme_config: dict,
    count: int = 10,
    batch_number: int = 1,
) -> List[Dict[str, Any]]:
    """Generate realistic demo claims for a given scheme."""
    claims = []
    members = scheme_config["members"]
    providers = scheme_config["providers"]
    scheme_id = scheme_config["scheme_id"]

    for i in range(count):
        member = random.choice(members)
        provider = random.choice(providers)
        claim_id = f"{scheme_id}-CLM-{batch_number:04d}-{i:04d}"
        claims.append({
            "claim_id": claim_id,
            "scheme_id": scheme_id,
            "member_id": member["member_id"],
            "provider_id": provider["provider_id"],
            "service_date": _rand_date(),
            "billing_code": random.choice(BILLING_CODES),
            "amount": _rand_amount(),
        })

    return claims


# ──────────────────────────────────────────────────────────────────────
#  Tokenization layer (POPIA compliance)
# ──────────────────────────────────────────────────────────────────────

def tokenize_member(member: dict, scheme_key: str) -> dict:
    """Tokenize PII fields on a member record before transmission."""
    m = member.copy()
    m["member_id"] = _tokenize(str(m["member_id"]), scheme_key, "ID")
    m["identity_number"] = _tokenize(str(m["identity_number"]), scheme_key, "ID")
    m["first_name"] = _tokenize(str(m["first_name"]), scheme_key, "NAME")
    m["last_name"] = _tokenize(str(m["last_name"]), scheme_key, "NAME")
    m["banking_detail"] = _tokenize(str(m["banking_detail"]), scheme_key, "BANK")
    # Minimize date of birth to year only (YYYY-01-01)
    if m.get("date_of_birth") and len(m["date_of_birth"]) >= 4:
        m["date_of_birth"] = f"{m['date_of_birth'][:4]}-01-01"
    # Round coordinates to ~11km precision
    if "home_lat" in m:
        m["home_lat"] = round(float(m["home_lat"]), 1)
    if "home_lon" in m:
        m["home_lon"] = round(float(m["home_lon"]), 1)
    return m


def tokenize_provider(provider: dict, scheme_key: str) -> dict:
    """Tokenize PII fields on a provider record before transmission."""
    p = provider.copy()
    p["provider_id"] = _tokenize(str(p["provider_id"]), scheme_key, "ID")
    p["practice_number"] = _tokenize(str(p["practice_number"]), scheme_key, "PCNS")
    p["practice_name"] = _tokenize(str(p["practice_name"]), scheme_key, "NAME")
    p["banking_detail"] = _tokenize(str(p["banking_detail"]), scheme_key, "BANK")
    if "practice_lat" in p:
        p["practice_lat"] = round(float(p["practice_lat"]), 1)
    if "practice_lon" in p:
        p["practice_lon"] = round(float(p["practice_lon"]), 1)
    return p


def tokenize_claim(claim: dict, scheme_key: str) -> dict:
    """Tokenize identifier fields on a claim to match tokenized member/provider IDs."""
    c = claim.copy()
    c["claim_id"] = _tokenize(str(c["claim_id"]), scheme_key, "ID")
    c["member_id"] = _tokenize(str(c["member_id"]), scheme_key, "ID")
    c["provider_id"] = _tokenize(str(c["provider_id"]), scheme_key, "ID")
    return c


# ──────────────────────────────────────────────────────────────────────
#  Submission
# ──────────────────────────────────────────────────────────────────────

def submit_batch(
    api_url: str,
    bearer_token: str,
    payload: dict,
    dry_run: bool = False,
) -> Optional[dict]:
    """POST a tokenized claim batch to the ClaimGuard API."""
    if dry_run:
        print(f"  [DRY-RUN] Would POST {len(payload['claims'])} claims to {api_url}/claims/ingest")
        return None

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}/claims/ingest",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bearer_token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            print(f"  ✅ Accepted (HTTP {response.status})")
            return result
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  ❌ API error: HTTP {e.code} — {body[:300]}")
        return None
    except urllib.error.URLError as e:
        print(f"  ❌ Connection error: {e.reason}")
        return None


def run_scheme(
    scheme_name: str,
    api_url: str,
    scheme_key: str,
    claims_per_batch: int,
    batch_number: int,
    dry_run: bool = False,
) -> bool:
    """Run a single ingestion cycle for one medical scheme."""
    config = SCHEME_CONFIGS.get(scheme_name)
    if not config:
        print(f"  ⚠️  Unknown scheme: {scheme_name}")
        return False

    token = os.environ.get(config["token_env"], "")
    if not token and not dry_run:
        print(f"  ⚠️  No bearer token found in ${config['token_env']} — skipping {scheme_name}")
        return False

    print(f"\n{'=' * 60}")
    print(f"  🏥  {config['scheme_name']}")
    print(f"  📋  Source: {config['source']}")
    print(f"  📦  Batch #{batch_number} — {claims_per_batch} claims")
    print(f"{'=' * 60}")

    # Generate demo claims
    claims = generate_claims(config, count=claims_per_batch, batch_number=batch_number)

    # Tokenize everything (POPIA compliance)
    print("  🔒 Tokenizing PII (HMAC-SHA256)...")
    tokenized_members = [tokenize_member(m, scheme_key) for m in config["members"]]
    tokenized_providers = [tokenize_provider(p, scheme_key) for p in config["providers"]]
    tokenized_claims = [tokenize_claim(c, scheme_key) for c in claims]

    payload = {
        "source": config["source"],
        "schemes": [{"scheme_id": config["scheme_id"], "scheme_name": config["scheme_name"]}],
        "members": tokenized_members,
        "providers": tokenized_providers,
        "claims": tokenized_claims,
    }

    print(f"  📤 Submitting to {api_url}...")
    result = submit_batch(api_url, token, payload, dry_run=dry_run)

    if result:
        ingestion = result.get("ingestion", {})
        print(f"  📊 Ingestion summary: {json.dumps(ingestion, indent=2)[:500]}")

    return result is not None


def main():
    parser = argparse.ArgumentParser(
        description="ClaimGuard Desktop Simulator — submit claims as different medical aids",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--api-url", required=True, help="ClaimGuard API base URL (e.g. https://claimguard-api.example.com)")
    parser.add_argument("--scheme", required=True, choices=["bonitas", "discovery", "gems", "all"], help="Which medical aid to simulate")
    parser.add_argument("--claims", type=int, default=10, help="Number of claims per batch (default: 10)")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be sent without actually calling the API")
    parser.add_argument("--continuous", action="store_true", help="Keep submitting batches in a loop")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between batches in continuous mode (default: 60)")

    args = parser.parse_args()

    scheme_key = os.environ.get("CLAIMGUARD_SCHEME_KEY", "demo-scheme-key-change-in-production")
    if scheme_key == "demo-scheme-key-change-in-production":
        print("⚠️  Using default demo scheme key. Set CLAIMGUARD_SCHEME_KEY for production.")

    schemes = list(SCHEME_CONFIGS.keys()) if args.scheme == "all" else [args.scheme]

    batch_number = 1
    while True:
        print(f"\n{'━' * 60}")
        print(f"  🚀 ClaimGuard Desktop Simulator — Batch #{batch_number}")
        print(f"  🕐 {time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'━' * 60}")

        for scheme in schemes:
            run_scheme(
                scheme_name=scheme,
                api_url=args.api_url,
                scheme_key=scheme_key,
                claims_per_batch=args.claims,
                batch_number=batch_number,
                dry_run=args.dry_run,
            )

        if not args.continuous:
            break

        batch_number += 1
        print(f"\n  ⏳ Waiting {args.interval}s before next batch...")
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n  🛑 Stopped by user.")
            break

    print("\n✅ Simulation complete.")


if __name__ == "__main__":
    main()
