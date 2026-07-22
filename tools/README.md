# ClaimGuard Tools

Utility scripts for operating and testing the ClaimGuard Network.

## Desktop Simulator (`simulate_medical_aids.py`)

Simulates multiple South African medical aid schemes submitting claims to the
ClaimGuard API.  Designed to run on a separate machine (e.g. an old desktop)
that acts as the claims servers for demonstration purposes.

### Quick start

```bash
# 1. Set bearer tokens (created via Platform Admin → Integration Credentials)
export CLAIMGUARD_BONITAS_TOKEN="eyJ..."
export CLAIMGUARD_DISCOVERY_TOKEN="eyJ..."
export CLAIMGUARD_GEMS_TOKEN="eyJ..."

# 2. Set the HMAC key for POPIA-compliant PII tokenization
export CLAIMGUARD_SCHEME_KEY="your-scheme-secret-key"

# 3. Run a single batch for all schemes
python simulate_medical_aids.py \
    --api-url https://claimguard-api.example.com \
    --scheme all

# 4. Or run continuously (batch every 30s)
python simulate_medical_aids.py \
    --api-url https://claimguard-api.example.com \
    --scheme all \
    --continuous --interval 30

# 5. Dry-run (preview without calling the API)
python simulate_medical_aids.py \
    --api-url https://example.com \
    --scheme bonitas \
    --dry-run
```

### Included medical aids

| Scheme | Env Variable | Members | Providers |
|--------|-------------|---------|-----------|
| Bonitas | `CLAIMGUARD_BONITAS_TOKEN` | 4 | 3 |
| Discovery Health | `CLAIMGUARD_DISCOVERY_TOKEN` | 3 | 2 |
| GEMS | `CLAIMGUARD_GEMS_TOKEN` | 2 | 1 |

### Privacy compliance (POPIA / GDPR / HIPAA)

All PII is tokenized **locally** using HMAC-SHA256 before leaving the desktop.
No raw names, ID numbers, or banking details are transmitted.

- Names → `HMAC(name, key, "NAME")`
- ID numbers → `HMAC(id, key, "ID")`
- Banking details → `HMAC(bank, key, "BANK")`
- Practice numbers → `HMAC(pcns, key, "PCNS")`
- Date of birth → minimized to `YYYY-01-01`
- GPS coordinates → rounded to 1 decimal (~11 km)
