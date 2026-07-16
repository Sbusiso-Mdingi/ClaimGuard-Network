from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_detection_engine.detector import analyze_directory, analyze_scheme_directory


class DetectorTests(TestCase):
    def _write_csv(self, path: Path, header: str, rows: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join([header, *rows]) + "\n", encoding="utf-8")

    def test_scheme_analysis_ranks_obvious_outlier_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            scheme_dir = Path(temp_dir) / "scheme_a"
            scheme_dir.mkdir()

            self._write_csv(
                scheme_dir / "members.csv",
                "member_id,scheme_id,first_name,last_name,date_of_birth,gender,synthetic_id_number,synthetic_banking_detail,home_region,home_lat,home_lon,join_date",
                [
                    "A-M001,A,Teboho,Khumalo,1980-01-01,M,8001015009087,FNB|1111111111,Johannesburg,-26.2041,28.0473,2020-01-01",
                    "A-M002,A,Lerato,Naidoo,1988-02-02,F,8802025009088,FNB|2222222222,Cape Town,-33.9249,18.4241,2020-01-01",
                    "A-M003,A,Thabo,Mokoena,1990-03-03,M,9003035009089,FNB|3333333333,Durban,-29.8587,31.0218,2020-01-01",
                ],
            )
            self._write_csv(
                scheme_dir / "providers.csv",
                "provider_id,scheme_id,practice_number,specialty,practice_name,synthetic_banking_detail,practice_region,practice_lat,practice_lon",
                [
                    "A-P001,A,10001,GP,Alpha GP,FNB|9999999999,Cape Town,-33.9249,18.4241",
                    "A-P002,A,10002,GP,Bravo GP,FNB|8888888888,Johannesburg,-26.2041,28.0473",
                    "A-P003,A,10003,GP,Charlie GP,FNB|7777777777,Durban,-29.8587,31.0218",
                ],
            )
            self._write_csv(
                scheme_dir / "claims.csv",
                "claim_id,scheme_id,member_id,provider_id,service_date,billing_code,amount",
                [
                    "C1,A,A-M001,A-P001,2024-01-01,GP01,110.00",
                    "C2,A,A-M002,A-P001,2024-01-08,GP02,125.00",
                    "C3,A,A-M003,A-P001,2024-01-15,GP03,118.00",
                    "C4,A,A-M001,A-P002,2024-01-01,GP01,120.00",
                    "C5,A,A-M002,A-P002,2024-01-02,GP01,980.00",
                    "C6,A,A-M003,A-P002,2024-01-03,GP01,970.00",
                    "C7,A,A-M002,A-P002,2024-01-04,GP01,960.00",
                    "C8,A,A-M003,A-P002,2024-01-05,GP01,950.00",
                    "C9,A,A-M002,A-P002,2024-01-06,GP01,940.00",
                    "C10,A,A-M003,A-P002,2024-01-07,GP01,930.00",
                    "C11,A,A-M001,A-P003,2024-01-02,GP02,108.00",
                    "C12,A,A-M002,A-P003,2024-01-09,GP01,115.00",
                    "C13,A,A-M003,A-P003,2024-01-16,GP03,122.00",
                ],
            )

            report = analyze_scheme_directory(scheme_dir, top_n=2)

            self.assertEqual(report["scheme_id"], "a")
            self.assertEqual(report["provider_findings"][0]["entity_id"], "A-P002")
            self.assertEqual(report["provider_findings"][0]["category"], "up_coding")
            self.assertTrue(any("average amount" in reason for reason in report["provider_findings"][0]["reasons"]))
            self.assertEqual(report["member_findings"][0]["entity_id"], "A-M001")
            self.assertEqual(report["member_findings"][0]["category"], "geographic_substitution")
            self.assertTrue(any("same-day provider distance" in reason for reason in report["member_findings"][0]["reasons"]))

    def test_directory_analysis_includes_network_sections(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            self._write_csv(
                root / "scheme_a" / "members.csv",
                "member_id,scheme_id,first_name,last_name,date_of_birth,gender,synthetic_id_number,synthetic_banking_detail,home_region,home_lat,home_lon,join_date",
                ["A-M001,A,Teboho,Khumalo,1980-01-01,M,8001015009087,FNB|1111111111,Johannesburg,-26.2041,28.0473,2020-01-01"],
            )
            self._write_csv(
                root / "scheme_a" / "providers.csv",
                "provider_id,scheme_id,practice_number,specialty,practice_name,synthetic_banking_detail,practice_region,practice_lat,practice_lon",
                ["A-P002,A,10002,GP,Bravo GP,FNB|8888888888,Johannesburg,-26.2041,28.0473"],
            )
            self._write_csv(
                root / "scheme_a" / "claims.csv",
                "claim_id,scheme_id,member_id,provider_id,service_date,billing_code,amount",
                ["C1,A,A-M001,A-P002,2024-01-01,GP01,980.00"],
            )

            self._write_csv(
                root / "scheme_b" / "members.csv",
                "member_id,scheme_id,first_name,last_name,date_of_birth,gender,synthetic_id_number,synthetic_banking_detail,home_region,home_lat,home_lon,join_date",
                ["B-M001,B,Lebo,Modise,1985-01-01,F,8501015009087,FNB|2222222222,Cape Town,-33.9249,18.4241,2020-01-01"],
            )
            self._write_csv(
                root / "scheme_b" / "providers.csv",
                "provider_id,scheme_id,practice_number,specialty,practice_name,synthetic_banking_detail,practice_region,practice_lat,practice_lon",
                [
                    "B-P001,B,20001,GP,Rebranded GP,FNB|8888888888,Cape Town,-33.9249,18.4241",
                    "B-P002,B,20002,GP,Mirror GP,FNB|9999999998,Johannesburg,-26.2041,28.0473",
                ],
            )
            self._write_csv(
                root / "scheme_b" / "claims.csv",
                "claim_id,scheme_id,member_id,provider_id,service_date,billing_code,amount",
                [
                    "C2,B,B-M001,B-P001,2024-02-01,GP01,975.00",
                    "C3,B,B-M001,B-P002,2024-01-01,GP01,980.00",
                ],
            )

            (root / "ground_truth").mkdir(parents=True, exist_ok=True)
            (root / "ground_truth" / "planted_fraud.json").write_text(
                '{"single_scheme_fraud":[{"entity_type":"provider","entity_id":"A-P002"},{"entity_type":"member","entity_id":"A-M001"}],"cross_scheme_evasion":[{"original":{"provider_id":"A-P002"},"reappeared_as":{"provider_id":"B-P002"}}]}',
                encoding="utf-8",
            )

            report = analyze_directory(root, top_n=5)
            rendered = json.dumps(report)

            self.assertEqual(report["contractVersion"], "1.0")
            self.assertEqual(report["metadata"]["source"]["type"], "static_csv")
            self.assertEqual(report["summary"]["totalClaims"], 3)
            self.assertEqual(len(report["claims"]), 3)
            self.assertEqual(len(report["providers"]), 3)
            self.assertEqual(len(report["members"]), 2)
            self.assertIn("nodes", report["graph"])
            self.assertIn("edges", report["graph"])
            self.assertIn("riskScore", report["risk"])
            self.assertTrue(report["history"]["evaluation"]["available"])
            self.assertNotIn("synthetic_banking_detail", rendered)
            self.assertIsInstance(rendered, str)
