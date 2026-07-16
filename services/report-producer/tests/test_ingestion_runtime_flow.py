from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.cli import main as producer_main


class IngestionRuntimeFlowTests(TestCase):
    def test_claim_only_json_path_is_rejected_instead_of_publishing_partial_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            claims_path = root / "claims.json"
            claims_path.write_text(json.dumps({"claims": [{"claim_id": "C-1"}]}), encoding="utf-8")
            with self.assertRaises(SystemExit):
                producer_main([
                    "--claims-json", str(claims_path), "--backend", "file", "--output-dir", str(root / "reports")
                ])
            self.assertFalse((root / "reports" / "tenant_default" / "latest.json").exists())

    def test_cli_requires_a_source(self) -> None:
        with self.assertRaises(SystemExit):
            producer_main([])
