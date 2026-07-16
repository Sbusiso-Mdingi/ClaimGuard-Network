from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_detection_engine.loader import build_data_bundle_from_records, load_data_bundle
from claimguard_detection_engine.orchestration import DetectionSnapshot, run_detection_orchestration


class OrchestrationParityTests(TestCase):
    def test_csv_and_runtime_adapters_produce_identical_business_sections(self) -> None:
        schemes = [{"scheme_id": "A", "scheme_name": "Alpha"}]
        members = [{
            "member_id": "M-1", "scheme_id": "A", "first_name": "A", "last_name": "Member",
            "date_of_birth": "1980-01-01", "gender": "F", "synthetic_id_number": "id-1",
            "synthetic_banking_detail": "bank-1", "home_region": "Cape Town", "home_lat": -33.9,
            "home_lon": 18.4, "join_date": "2020-01-01",
        }]
        providers = [{
            "provider_id": "P-1", "scheme_id": "A", "practice_number": "100", "specialty": "GP",
            "practice_name": "Practice", "synthetic_banking_detail": "bank-2", "practice_region": "Cape Town",
            "practice_lat": -33.9, "practice_lon": 18.4,
        }]
        claims = [{
            "claim_id": "C-1", "scheme_id": "A", "member_id": "M-1", "provider_id": "P-1",
            "service_date": "2026-07-15", "billing_code": "GP01", "amount": 125.0,
        }]

        with tempfile.TemporaryDirectory() as temp_dir:
            scheme_dir = Path(temp_dir) / "scheme_a"
            scheme_dir.mkdir()
            self._write_csv(scheme_dir / "members.csv", members)
            self._write_csv(scheme_dir / "providers.csv", providers)
            self._write_csv(scheme_dir / "claims.csv", claims)
            csv_bundle = load_data_bundle(Path(temp_dir))

        runtime_bundle = build_data_bundle_from_records(
            schemes=schemes, members=members, providers=providers, claims=claims
        )
        base = {
            "tenant_id": "tenant_alpha",
            "tenant_slug": "alpha",
            "tenant_display_name": "Alpha",
            "snapshot_cutoff": "2026-07-16T00:00:00+00:00",
            "source_watermark": "same-corpus",
            "generation_correlation_id": "parity",
            "generated_at": "2026-07-16T00:00:00+00:00",
        }
        csv_report = run_detection_orchestration(
            DetectionSnapshot(bundle=csv_bundle, source_type="static_csv", **base)
        )
        runtime_report = run_detection_orchestration(
            DetectionSnapshot(bundle=runtime_bundle, source_type="mysql_tenant_snapshot", **base)
        )
        for section in ("summary", "claims", "providers", "members", "graph", "risk", "history"):
            self.assertEqual(csv_report[section], runtime_report[section], section)

    @staticmethod
    def _write_csv(path: Path, rows: list[dict[str, object]]) -> None:
        headers = list(rows[0])
        rendered = [",".join(headers)]
        rendered.extend(",".join(str(row.get(header, "")) for header in headers) for row in rows)
        path.write_text("\n".join(rendered) + "\n", encoding="utf-8")
