from __future__ import annotations

import argparse
from pathlib import Path

from .publisher import AzureBlobReportPublisher, FileReportPublisher
from .runtime import DetectionReportProducer


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run ClaimGuard detection report producer")
    parser.add_argument("--data-dir", type=Path, required=True, help="Claims data directory")
    parser.add_argument("--top-n", type=int, default=10, help="Top findings per scheme")
    parser.add_argument("--backend", choices=["file", "azure_blob"], default="file", help="Report storage backend")
    parser.add_argument("--output-dir", type=Path, default=Path("reports"), help="Output base directory for file backend")
    parser.add_argument("--trigger", default="manual", help="Trigger label for telemetry and metadata")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.backend == "azure_blob":
        publisher = AzureBlobReportPublisher.from_environment()
    else:
        publisher = FileReportPublisher(args.output_dir)

    producer = DetectionReportProducer(
        data_dir=args.data_dir,
        publisher=publisher,
        top_n=args.top_n,
    )
    result = producer.run(trigger=args.trigger)

    print(f"Published report version {result.published.version} ({result.published.report_path})")
    return 0
