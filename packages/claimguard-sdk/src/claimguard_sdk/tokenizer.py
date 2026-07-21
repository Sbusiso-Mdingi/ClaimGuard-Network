from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac


class TokenizationError(ValueError):
    """Raised when the SDK receives invalid tokenization input."""


def _normalize_value(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise TokenizationError("value must not be empty")
    return normalized


def _normalize_key(scheme_key: str) -> bytes:
    normalized = scheme_key.strip()
    if not normalized:
        raise TokenizationError("scheme_key must not be empty")
    return normalized.encode("utf-8")


def tokenize_value(value: str, scheme_key: str, *, purpose: str = "PCNS") -> str:
    """Return a deterministic HMAC-SHA256 token for a sensitive identifier."""

    normalized_value = _normalize_value(value)
    normalized_key = _normalize_key(scheme_key)
    message = f"{purpose}:{normalized_value}".encode("utf-8")
    return hmac.new(normalized_key, message, hashlib.sha256).hexdigest()


@dataclass(frozen=True, slots=True)
class ClaimGuardEdgeSDK:
    """Minimal Phase 2 SDK wrapper around the HMAC tokenization primitive."""

    scheme_key: str

    def tokenize_pcns(self, pcns_number: str) -> str:
        return tokenize_value(pcns_number, self.scheme_key, purpose="PCNS")

    def tokenize_banking_detail(self, banking_detail: str) -> str:
        return tokenize_value(banking_detail, self.scheme_key, purpose="BANK")

    def tokenize_string(self, value: str, purpose: str) -> str:
        """Tokenize a generic PII string (e.g., identity number, first name) for POPIA compliance."""
        return tokenize_value(value, self.scheme_key, purpose=purpose)

    def rotate_key(self, new_scheme_key: str) -> "ClaimGuardEdgeSDK":
        return ClaimGuardEdgeSDK(scheme_key=new_scheme_key)