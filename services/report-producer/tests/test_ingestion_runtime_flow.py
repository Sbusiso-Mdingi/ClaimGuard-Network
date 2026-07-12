from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.cli import main as producer_main


class IngestionRuntimeFlowTests(TestCase):
    def test_claims_json_source_generates_and_publishes_report_with_latest_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            claims_path = root / "claims.json"
            output_dir = root / "published"

            claims_path.write_text(
                json.dumps(
                    {
                        "claims": [
                            {
                                "claim_id": "C-700",
                                "scheme_id": "scheme_a",
                                "member_id": "M-700",
                                "provider_id": "P-700",
                                "service_date": "2026-01-15",
                                "billing_code": "CONSULT",
                                "amount": 123.45,
                                "phone": "555-1700",
                                "email": "m700@example.com",
                                "address": "Pretoria",
                                "bank_account": "BANK-700",
                                "device_id": "DEV-700",
                                "ip_address": "10.70.0.7",
                            }
                        ]
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            exit_code = producer_main(
                [
                    "--claims-json",
                    str(claims_path),
                    "--backend",
                    "file",
                    "--output-dir",
                    str(output_dir),
                    "--trigger",
                    "ingest",
                ]
            )

            self.assertEqual(exit_code, 0)

            latest_pointer_path = output_dir / "latest.json"
            self.assertTrue(latest_pointer_path.exists())

            pointer = json.loads(latest_pointer_path.read_text(encoding="utf-8"))
            report_path = output_dir / pointer["reportBlobName"]

            self.assertTrue(report_path.exists())
            report = json.loads(report_path.read_text(encoding="utf-8"))

            self.assertEqual(report["data_dir"], "ingested-claims")
            self.assertIn("detection", report)
            self.assertIn("graph_summary", report["detection"])
            self.assertIn("risk_score", report["detection"])
            self.assertEqual(report["detection"]["relationships"][0]["claim_id"], "C-700")
