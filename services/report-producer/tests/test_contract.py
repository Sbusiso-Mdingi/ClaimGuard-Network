from __future__ import annotations

import copy
from unittest import TestCase

from claimguard_report_producer.contract import ReportContractError, validate_detection_report


def valid_report() -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": "a" * 64,
            "tenant": {"tenantId": "tenant_alpha"},
            "generatedAt": "2026-07-16T00:00:00+00:00",
            "snapshotCutoff": "2026-07-16T00:00:00+00:00",
            "source": {"watermark": "w1"},
            "includedCounts": {"claims": 1, "providers": 0, "members": 0},
        },
        "summary": {"totalClaims": 1, "totalClaimedAmount": 10.0},
        "claims": [
            {
                "claimId": "C-1",
                "providerId": "P-1",
                "memberId": "M-1",
                "schemeId": "S-1",
                "amount": 10.0,
            }
        ],
        "providers": [],
        "members": [],
        "graph": {
            "nodes": [{"entity_id": "claimant:M-1"}, {"entity_id": "provider:P-1"}],
            "edges": [{"source_entity_id": "claimant:M-1", "target_entity_id": "provider:P-1"}],
            "summary": {},
        },
        "risk": {},
        "history": {},
    }


class ContractValidationTests(TestCase):
    def test_valid_report_passes(self) -> None:
        self.assertEqual(validate_detection_report(valid_report(), expected_tenant_id="tenant_alpha")["contractVersion"], "1.0")

    def test_missing_required_field_fails(self) -> None:
        report = valid_report()
        del report["graph"]
        with self.assertRaises(ReportContractError):
            validate_detection_report(report, expected_tenant_id="tenant_alpha")

    def test_unsupported_version_and_tenant_mismatch_fail(self) -> None:
        unsupported = valid_report()
        unsupported["contractVersion"] = "2.0"
        with self.assertRaises(ReportContractError):
            validate_detection_report(unsupported, expected_tenant_id="tenant_alpha")
        with self.assertRaises(ReportContractError):
            validate_detection_report(valid_report(), expected_tenant_id="tenant_beta")

    def test_non_finite_and_inconsistent_counts_fail(self) -> None:
        non_finite = valid_report()
        non_finite["claims"][0]["amount"] = float("nan")
        with self.assertRaises(ReportContractError):
            validate_detection_report(non_finite, expected_tenant_id="tenant_alpha")
        inconsistent = valid_report()
        inconsistent["summary"]["totalClaims"] = 2
        with self.assertRaises(ReportContractError):
            validate_detection_report(inconsistent, expected_tenant_id="tenant_alpha")

    def test_invalid_graph_reference_and_privacy_field_fail(self) -> None:
        invalid_graph = valid_report()
        invalid_graph["graph"]["edges"][0]["target_entity_id"] = "provider:missing"
        with self.assertRaises(ReportContractError):
            validate_detection_report(invalid_graph, expected_tenant_id="tenant_alpha")
        privacy = copy.deepcopy(valid_report())
        privacy["claims"][0]["syntheticBankingDetail"] = "private"
        with self.assertRaises(ReportContractError):
            validate_detection_report(privacy, expected_tenant_id="tenant_alpha")

    def test_invalid_report_id_and_identifiers_fail(self) -> None:
        invalid_report_id = valid_report()
        invalid_report_id["metadata"]["reportId"] = "not-a-digest"
        with self.assertRaises(ReportContractError):
            validate_detection_report(invalid_report_id, expected_tenant_id="tenant_alpha")
        missing_identifier = valid_report()
        missing_identifier["claims"][0]["providerId"] = ""
        with self.assertRaises(ReportContractError):
            validate_detection_report(missing_identifier, expected_tenant_id="tenant_alpha")
