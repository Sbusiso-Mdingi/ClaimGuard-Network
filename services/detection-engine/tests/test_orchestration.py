from __future__ import annotations

from unittest import TestCase

from claimguard_detection_engine.loader import build_data_bundle_from_records
from claimguard_detection_engine.orchestration import DetectionSnapshot, run_detection_orchestration


class OrchestrationTests(TestCase):
    def test_authoritative_tenant_records_produce_a_scoped_report(self) -> None:
        schemes = [{"scheme_id": "A", "scheme_name": "Alpha"}]
        members = [{
            "member_id": "M-1", "scheme_id": "A", "first_name": "A", "last_name": "Member",
            "date_of_birth": "1980-01-01", "gender": "F", "identity_number": "id-1",
            "banking_detail": "bank-1", "home_region": "Cape Town", "home_lat": -33.9,
            "home_lon": 18.4, "join_date": "2020-01-01",
        }]
        providers = [{
            "provider_id": "P-1", "scheme_id": "A", "practice_number": "100", "specialty": "GP",
            "practice_name": "Practice", "banking_detail": "bank-2", "practice_region": "Cape Town",
            "practice_lat": -33.9, "practice_lon": 18.4,
        }]
        claims = [{
            "claim_id": "C-1", "scheme_id": "A", "member_id": "M-1", "provider_id": "P-1",
            "service_date": "2026-07-15", "billing_code": "GP01", "amount": 125.0,
        }]

        bundle = build_data_bundle_from_records(
            schemes=schemes, members=members, providers=providers, claims=claims
        )
        report = run_detection_orchestration(
            DetectionSnapshot(
                bundle=bundle,
                tenant_id="tenant_alpha",
                tenant_slug="alpha",
                tenant_display_name="Alpha",
                snapshot_cutoff="2026-07-16T00:00:00+00:00",
                source_type="mysql_tenant_snapshot",
                source_watermark="same-corpus",
                generation_correlation_id="authoritative-records",
                generated_at="2026-07-16T00:00:00+00:00",
            )
        )
        self.assertEqual(report["metadata"]["tenant"]["tenantId"], "tenant_alpha")
        self.assertEqual(report["metadata"]["source"]["type"], "mysql_tenant_snapshot")
        self.assertEqual(report["summary"]["totalClaims"], 1)
        self.assertEqual([claim["claimId"] for claim in report["claims"]], ["C-1"])
        self.assertNotIn("banking_detail", str(report))
