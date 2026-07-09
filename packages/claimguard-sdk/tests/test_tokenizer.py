from __future__ import annotations

import re

import pytest

from claimguard_sdk import ClaimGuardEdgeSDK, TokenizationError, tokenize_value


def test_tokenize_value_is_deterministic():
    token1 = tokenize_value("8001015009087", "scheme-secret")
    token2 = tokenize_value("8001015009087", "scheme-secret")

    assert token1 == token2
    assert re.fullmatch(r"[0-9a-f]{64}", token1)


def test_tokenize_value_changes_with_key():
    token1 = tokenize_value("8001015009087", "scheme-secret-1")
    token2 = tokenize_value("8001015009087", "scheme-secret-2")

    assert token1 != token2


def test_sdk_tokenizes_pcns_and_banking_detail_with_distinct_purposes():
    sdk = ClaimGuardEdgeSDK(scheme_key="scheme-secret")

    pcns_token = sdk.tokenize_pcns("8001015009087")
    bank_token = sdk.tokenize_banking_detail("FNB:123456789")

    assert pcns_token != bank_token


def test_sdk_normalizes_whitespace():
    sdk = ClaimGuardEdgeSDK(scheme_key="scheme-secret")

    assert sdk.tokenize_pcns(" 8001015009087 ") == sdk.tokenize_pcns("8001015009087")


def test_rotate_key_returns_new_sdk_instance():
    sdk = ClaimGuardEdgeSDK(scheme_key="scheme-secret")
    rotated = sdk.rotate_key("scheme-secret-2")

    assert rotated is not sdk
    assert rotated.tokenize_pcns("8001015009087") != sdk.tokenize_pcns("8001015009087")


@pytest.mark.parametrize("value,key", [("", "scheme-secret"), ("8001015009087", "")])
def test_empty_values_raise_tokenization_error(value: str, key: str):
    with pytest.raises(TokenizationError):
        tokenize_value(value, key)