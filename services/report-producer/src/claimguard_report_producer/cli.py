from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

from .worker import create_discovered_workers_from_environment, create_worker_from_environment

def build_worker_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the ClaimGuard durable report-producer worker")
    parser.add_argument(
        "execution_mode",
        nargs="?",
        choices=["once", "drain", "drain-all", "continuous"],
        help="Execution mode. Positional form is preferred for container runtimes.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Lease one bounded batch and exit (default)")
    mode.add_argument("--drain", action="store_true", help="Process bounded batches until the outbox is empty")
    mode.add_argument("--drain-all", action="store_true", help="Drain every active compatible medical-aid route")
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
    parser = build_worker_parser()
    args = parser.parse_args(argv)
    flag_mode = "continuous" if args.continuous else "drain-all" if args.drain_all else "drain" if args.drain else "once" if args.once else None
    if args.execution_mode and flag_mode:
        parser.error("Choose either a positional execution mode or a mode flag, not both.")
    execution_mode = args.execution_mode or flag_mode or "once"
    if execution_mode == "drain-all":
        workers = create_discovered_workers_from_environment(backend=args.backend, output_dir=args.output_dir)
        for worker in workers:
            worker.run_until_empty()
        return 0

    worker = create_worker_from_environment(backend=args.backend, output_dir=args.output_dir)
    if execution_mode == "continuous":
        try:
            worker.run_continuously()
        except KeyboardInterrupt:
            return 0
        return 0
    if execution_mode == "drain":
        worker.run_until_empty()
        return 0

    worker.run_once()
    return 0


def main(argv: list[str] | None = None) -> int:
    resolved_argv = list(sys.argv[1:] if argv is None else argv)
    if resolved_argv[:1] != ["worker"]:
        parser = argparse.ArgumentParser(description="Run the ClaimGuard durable report-producer worker")
        parser.error("The report producer only accepts the durable 'worker' command.")
    try:
        result = run_worker_command(resolved_argv[1:])
        print(json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": "info",
            "service": "report-producer-worker",
            "event": "producer_run_completed",
        }, sort_keys=True))
        return result
    except Exception as error:  # noqa: BLE001
        print(json.dumps({
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": "error",
            "service": "report-producer-worker",
            "event": "producer_run_failed",
            "error_type": type(error).__name__,
        }, sort_keys=True), file=sys.stderr)
        return 1
