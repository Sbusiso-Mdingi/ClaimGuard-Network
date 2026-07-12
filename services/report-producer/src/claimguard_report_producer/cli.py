from __future__ import annotations

import argparse
from pathlib import Path

from .publisher import AzureBlobReportPublisher, FileReportPublisher
from .runtime import DetectionReportProducer
from .sources import build_report_from_ingested_claims, load_claims_from_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run ClaimGuard detection report producer")
    parser.add_argument("--data-dir", type=Path, help="Claims data directory for filesystem mode")
    parser.add_argument("--claims-json", type=Path, help="JSON file containing ingested claims payload")
    parser.add_argument("--top-n", type=int, default=10, help="Top findings per scheme")
    parser.add_argument("--backend", choices=["file", "azure_blob"], default="file", help="Report storage backend")
    parser.add_argument("--output-dir", type=Path, default=Path("reports"), help="Output base directory for file backend")
    parser.add_argument("--trigger", default="manual", help="Trigger label for telemetry and metadata")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

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

        def detector(_data_dir: Path, _top_n: int) -> dict[str, object]:
            return build_report_from_ingested_claims(claims)

    producer = DetectionReportProducer(
        data_dir=runtime_data_dir,
        publisher=publisher,
        top_n=args.top_n,
        detector=detector,
    )
    result = producer.run(trigger=args.trigger)

    print(f"Published report version {result.published.version} ({result.published.report_path})")
    return 0
