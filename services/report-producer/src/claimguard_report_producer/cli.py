from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from .publisher import AzureBlobReportPublisher, FileReportPublisher
from .runtime import DetectionReportProducer
from .sources import build_report_from_ingested_claims, filter_claims_for_tenant, load_claims_from_json
from .worker import create_worker_from_environment


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run ClaimGuard detection report producer")
    parser.add_argument("--data-dir", type=Path, help="Claims data directory for filesystem mode")
    parser.add_argument("--claims-json", type=Path, help="JSON file containing ingested claims payload")
    parser.add_argument("--top-n", type=int, default=10, help="Top findings per scheme")
    parser.add_argument("--backend", choices=["file", "azure_blob"], default="file", help="Report storage backend")
    parser.add_argument("--output-dir", type=Path, default=Path("reports"), help="Output base directory for file backend")
    parser.add_argument("--trigger", default="manual", help="Trigger label for telemetry and metadata")
    parser.add_argument(
        "--tenant-id",
        default=os.environ.get("DEFAULT_TENANT_ID", "tenant_default"),
        help="Tenant identifier to scope report generation and publishing",
    )
    return parser


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
    if resolved_argv[:1] == ["worker"]:
        return run_worker_command(resolved_argv[1:])

    parser = build_parser()
    args = parser.parse_args(resolved_argv)

    if not args.data_dir and not args.claims_json:
        parser.error("One of --data-dir or --claims-json is required.")

    if args.data_dir and args.claims_json:
        parser.error("Use only one of --data-dir or --claims-json.")

    if args.backend == "azure_blob":
        publisher = AzureBlobReportPublisher.from_environment()
    else:
        publisher = FileReportPublisher(args.output_dir)

    detector = None
    runtime_data_dir = args.data_dir or Path(".")
    if args.claims_json:
        claims = load_claims_from_json(args.claims_json)
        tenant_claims = filter_claims_for_tenant(claims, tenant_id=args.tenant_id)

        def detector(_data_dir: Path, _top_n: int) -> dict[str, object]:
            return build_report_from_ingested_claims(tenant_claims)

    producer = DetectionReportProducer(
        data_dir=runtime_data_dir,
        publisher=publisher,
        top_n=args.top_n,
        detector=detector,
        tenant_id=args.tenant_id,
    )
    result = producer.run(trigger=args.trigger)

    print(f"Published report version {result.published.version} ({result.published.report_path})")
    return 0
