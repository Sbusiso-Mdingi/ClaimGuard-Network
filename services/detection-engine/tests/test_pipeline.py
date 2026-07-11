from __future__ import annotations

from unittest import TestCase

from claimguard_detection_engine.pipeline import normalize_claim_data, run_detection_pipeline


class PipelineTests(TestCase):
    def test_normalize_claim_data_produces_deterministic_order(self) -> None:
        claims = [
            {"claim_id": "C2", "member_id": "M2", "provider_id": "P1", "phone": "111", "email": "m2@example.com", "address": "A1", "bank_account": "B1", "device_id": "D1", "ip_address": "10.0.0.1"},
            {"claim_id": "C1", "member_id": "M1", "provider_id": "P1", "phone": "222", "email": "m1@example.com", "address": "A2", "bank_account": "B2", "device_id": "D2", "ip_address": "10.0.0.2"},
        ]

        normalized = normalize_claim_data(claims)

        self.assertEqual(normalized[0].claim_id, "C1")
        self.assertEqual(normalized[1].claim_id, "C2")

    def test_detection_pipeline_emits_entities_relationships_rules_and_risk(self) -> None:
        claims = [
            {"claim_id": "C1", "member_id": "M1", "provider_id": "P1", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.1"},
            {"claim_id": "C2", "member_id": "M2", "provider_id": "P2", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.2"},
            {"claim_id": "C3", "member_id": "M1", "provider_id": "P3", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.3"},
            {"claim_id": "C4", "member_id": "M1", "provider_id": "P4", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.4"},
        ]

        report = run_detection_pipeline(claims, ledger_reference={"entryHash": "a" * 64})

        self.assertIn("entities", report)
        self.assertIn("relationships", report)
        self.assertIn("triggered_rules", report)
        self.assertIn("risk_score", report)
        self.assertIn("graph_summary", report)
        self.assertIn("ledger_reference", report)

        rule_ids = {item["rule_id"] for item in report["triggered_rules"]}
        self.assertIn("shared_devices", rule_ids)
        self.assertIn("shared_addresses", rule_ids)
        self.assertIn("reused_bank_accounts", rule_ids)
        self.assertIn("reused_phone_numbers", rule_ids)
        self.assertIn("reused_emails", rule_ids)
        self.assertIn("repeat_offenders", rule_ids)

        self.assertGreater(report["risk_score"]["riskScore"], 0)
        self.assertIn(report["risk_score"]["severity"], {"Low", "Medium", "High"})
        self.assertTrue(report["risk_score"]["reasons"])

    def test_detection_pipeline_is_deterministic_for_same_input(self) -> None:
        claims = [
            {"claim_id": "C1", "member_id": "M1", "provider_id": "P1", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.1"},
            {"claim_id": "C2", "member_id": "M2", "provider_id": "P1", "phone": "555-1000", "email": "shared@x.com", "address": "ADDR-1", "bank_account": "BANK-1", "device_id": "DEVICE-1", "ip_address": "10.0.0.2"},
        ]

        first = run_detection_pipeline(claims)
        second = run_detection_pipeline(claims)

        self.assertEqual(first, second)
