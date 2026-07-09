from __future__ import annotations

from claimguard_sdk.cli import main


def test_cli_tokenizes_pcns(capsys):
    exit_code = main(["--key", "scheme-secret", "--value", "8001015009087"])

    captured = capsys.readouterr()

    assert exit_code == 0
    assert len(captured.out.strip()) == 64


def test_cli_tokenizes_bank_value(capsys):
    exit_code = main([
        "--key",
        "scheme-secret",
        "--purpose",
        "BANK",
        "--value",
        "FNB:123456789",
    ])

    captured = capsys.readouterr()

    assert exit_code == 0
    assert len(captured.out.strip()) == 64