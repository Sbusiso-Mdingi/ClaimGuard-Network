from __future__ import annotations

import argparse
from pathlib import Path
import sys

from .worker import create_worker_from_environment

def build_worker_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the ClaimGuard durable report-producer worker")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Lease one bounded batch and exit (default)")
    mode.add_argument("--continuous", action="store_true", help="Poll continuously for local development")
    parser.add_argument(
        "--backend",
        choices=["file", "azure_blob"],
        default=None,
        help="Override REPORT_STORAGE_BACKEND",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Override REPORT_OUTPUT_DIR for the file backend",
    )
    return parser


def run_worker_command(argv: list[str]) -> int:
    args = build_worker_parser().parse_args(argv)
    worker = create_worker_from_environment(backend=args.backend, output_dir=args.output_dir)
    if args.continuous:
        try:
            worker.run_continuously()
        except KeyboardInterrupt:
            return 0
        return 0

    worker.run_once()
    return 0


def main(argv: list[str] | None = None) -> int:
    resolved_argv = list(sys.argv[1:] if argv is None else argv)
    if resolved_argv[:1] != ["worker"]:
        parser = argparse.ArgumentParser(description="Run the ClaimGuard durable report-producer worker")
        parser.error("The report producer only accepts the durable 'worker' command.")
    return run_worker_command(resolved_argv[1:])
