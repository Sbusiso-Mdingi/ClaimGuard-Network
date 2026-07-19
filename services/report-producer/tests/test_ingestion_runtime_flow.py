from __future__ import annotations

from unittest import TestCase

from claimguard_report_producer.cli import main as producer_main


class IngestionRuntimeFlowTests(TestCase):
    def test_cli_rejects_legacy_filesystem_report_generation(self) -> None:
        with self.assertRaises(SystemExit):
            producer_main(["--data-dir", "claims"])

    def test_cli_requires_the_durable_worker_command(self) -> None:
        with self.assertRaises(SystemExit):
            producer_main([])
