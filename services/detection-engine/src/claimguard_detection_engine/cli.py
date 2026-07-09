from __future__ import annotations

import argparse
import json
from pathlib import Path

from .detector import analyze_directory


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze ClaimGuard synthetic claims data.")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data"),
        help="Directory containing scheme_* CSV folders.",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Number of provider and member findings to keep per scheme.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional output path. Defaults to stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    report = analyze_directory(args.data_dir, top_n=args.top_n)
    rendered = json.dumps(report, indent=2, sort_keys=True)

    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)

    return 0