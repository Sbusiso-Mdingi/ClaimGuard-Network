from __future__ import annotations

import argparse

from .tokenizer import ClaimGuardEdgeSDK, TokenizationError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="claimguard-tokenize",
        description="Tokenize sensitive values with the ClaimGuard Phase 2 SDK.",
    )
    parser.add_argument("--key", required=True, help="Scheme secret key used for HMAC tokenization")
    parser.add_argument("--value", required=True, help="Value to tokenize")
    parser.add_argument(
        "--purpose",
        default="PCNS",
        choices=["PCNS", "BANK"],
        help="Tokenization purpose label (default: PCNS)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        sdk = ClaimGuardEdgeSDK(scheme_key=args.key)
        if args.purpose == "BANK":
            token = sdk.tokenize_banking_detail(args.value)
        else:
            token = sdk.tokenize_pcns(args.value)
    except TokenizationError as exc:
        parser.error(str(exc))
        return 2

    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())