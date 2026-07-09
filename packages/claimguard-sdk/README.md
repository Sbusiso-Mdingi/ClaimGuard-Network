# ClaimGuard SDK

Phase 2 edge SDK for local tokenization.

## Quick start

```bash
uv sync --all-groups
uv run pytest tests
```

## Example

```python
from claimguard_sdk import ClaimGuardEdgeSDK

sdk = ClaimGuardEdgeSDK(scheme_key="replace-with-your-scheme-key")
token = sdk.tokenize_pcns("8001015009087")
```