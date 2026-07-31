# ClaimGuard SDK

[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](https://www.python.org/)

POPIA-compliant edge SDK for local PII tokenization and authenticated claim ingestion into the ClaimGuard Network. All personally identifiable information is tokenized **before it leaves the medical aid's firewall** — no raw names, ID numbers, or banking details are ever transmitted.

## Quick Start

```bash
uv sync --all-groups
uv run pytest tests
```

## Modules

| Module | Description |
|--------|-------------|
| `tokenizer.py` | Core HMAC-SHA256 tokenization engine (`ClaimGuardEdgeSDK`). Tokenizes PCNS numbers, member IDs, names, and banking details using keyed, category-tagged HMACs. |
| `client.py` | Full HTTP ingestion client (`ClaimGuardClient`). Automatically sanitizes all PII fields before submitting claim batches to the ClaimGuard API. Handles date-of-birth minimization and GPS coordinate rounding. |
| `cli.py` | Command-line entry point for standalone tokenization. |

## Usage

### Tokenizer Only

```python
from claimguard_sdk import ClaimGuardEdgeSDK

sdk = ClaimGuardEdgeSDK(scheme_key="replace-with-your-scheme-key")
token = sdk.tokenize_pcns("8001015009087")
```

### Full Ingestion Client

```python
from claimguard_sdk.client import ClaimGuardClient

client = ClaimGuardClient(
    api_url="https://claimguard-api.example.com",
    api_key="your-integration-credential",
    scheme_key="your-scheme-secret-key",
)

result = client.ingest_claims(
    claims=[...],
    members=[...],
    providers=[...],
)
```

The client automatically tokenizes all PII fields (member IDs, names, banking details, practice numbers) and minimizes dates of birth and GPS coordinates before any data leaves the local environment.

### CLI

```bash
# Tokenize a single PCNS value
uv run claimguard-tokenize --scheme-key "your-key" --value "8001015009087"
```

## Privacy Compliance (POPIA / GDPR / HIPAA)

All PII is tokenized **locally** using HMAC-SHA256 before leaving the desktop:

| Field | Transformation |
|-------|---------------|
| Names | `HMAC(name, key, "NAME")` |
| ID numbers | `HMAC(id, key, "ID")` |
| Banking details | `HMAC(bank, key, "BANK")` |
| Practice numbers | `HMAC(pcns, key, "PCNS")` |
| Date of birth | Minimized to `YYYY-01-01` |
| GPS coordinates | Rounded to 1 decimal (~11 km) |