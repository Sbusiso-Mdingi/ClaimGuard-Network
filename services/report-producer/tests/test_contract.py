from __future__ import annotations

import copy
from unittest import TestCase

from claimguard_report_producer.contract import (
    ReportContractError,
    SUPPORTED_REPORT_CONTRACT_VERSIONS,
    validate_detection_report,
)


TENANT_ID = "tenant_alpha"


def valid_report() -> dict[str, object]:
    return {
        "contractVersion":
            "1.0",

        "metadata": {
            "reportId":
                "a" * 64,

            "tenant": {
                "tenantId":
                    TENANT_ID,
            },

            "generatedAt":
                "2026-07-23T12:00:00+00:00",

            "snapshotCutoff":
                "2026-07-23T11:59:59+00:00",

            "source": {
                "watermark":
                    (
                        "prospective:"
                        "2026-07-23T11:59:59"
                        "+00:00:targets:2:"
                        f"sha256:{'b' * 64}"
                    ),

                "sourceJobIds": [
                    "job-1",
                ],
            },

            "includedCounts": {
                "claims": 2,
                "providers": 2,
                "members": 2,
            },

            "strategy": {
                "detectionStrategyId":
                    17,

                "strategyType":
                    "deterministic_rules",

                "modelDeploymentId":
                    None,
            },
        },

        "summary": {
            "totalClaims": 2,
            "totalClaimedAmount": 30.5,
            "reviewRecommendedClaims": 1,
        },

        "claims": [
            {
                "claimId":
                    "C-1",

                "claimVersion":
                    1,

                "providerId":
                    "P-1",

                "memberId":
                    "M-1",

                "schemeId":
                    "S-1",

                "amount":
                    10.0,

                "processingStatus":
                    "NO_REVIEW",

                "ruleHits": [],
            },
            {
                "claimId":
                    "C-2",

                "claimVersion":
                    3,

                "providerId":
                    "P-2",

                "memberId":
                    "M-2",

                "schemeId":
                    "S-1",

                "amount":
                    20.5,

                "processingStatus":
                    "REVIEW_RECOMMENDED",

                "ruleHits": [
                    "HIGH_AMOUNT",
                ],
            },
        ],

        "providers": [
            {
                "providerId":
                    "P-1",

                "claimCount":
                    1,
            },
            {
                "providerId":
                    "P-2",

                "claimCount":
                    1,
            },
        ],

        "members": [
            {
                "memberId":
                    "M-1",

                "claimCount":
                    1,
            },
            {
                "memberId":
                    "M-2",

                "claimCount":
                    1,
            },
        ],

        "graph": {
            "nodes": [
                {
                    "entity_id":
                        "claimant:M-1",

                    "entity_type":
                        "member",
                },
                {
                    "entity_id":
                        "claimant:M-2",

                    "entity_type":
                        "member",
                },
                {
                    "entity_id":
                        "provider:P-1",

                    "entity_type":
                        "provider",
                },
                {
                    "entity_id":
                        "provider:P-2",

                    "entity_type":
                        "provider",
                },
            ],

            "edges": [
                {
                    "source_entity_id":
                        "claimant:M-1",

                    "target_entity_id":
                        "provider:P-1",
                },
                {
                    "source_entity_id":
                        "claimant:M-2",

                    "target_entity_id":
                        "provider:P-2",
                },
            ],

            "summary": {
                "nodeCount":
                    4,

                "edgeCount":
                    2,
            },
        },

        "risk": {
            "reviewRecommendedCount":
                1,
        },

        "history": {
            "prospectiveOnly":
                True,

            "ruleExecution": {
                "notExecuted":
                    False,
            },
        },
    }


def assert_contract_error(
    test_case: TestCase,
    report: object,
    *,
    message: str | None = None,
    tenant_id: str = TENANT_ID,
) -> ReportContractError:
    with test_case.assertRaises(
        ReportContractError,
    ) as captured:
        validate_detection_report(
            report,
            expected_tenant_id=(
                tenant_id
            ),
        )

    if message is not None:
        test_case.assertIn(
            message,
            str(
                captured.exception
            ),
        )

    return captured.exception


class ContractValidationTests(
    TestCase,
):
    def test_supported_report_contract_is_explicit(
        self,
    ) -> None:
        self.assertEqual(
            SUPPORTED_REPORT_CONTRACT_VERSIONS,
            {
                "1.0",
            },
        )

    def test_valid_prospective_report_passes_without_mutation(
        self,
    ) -> None:
        report = valid_report()

        before = copy.deepcopy(
            report
        )

        validated = (
            validate_detection_report(
                report,
                expected_tenant_id=(
                    TENANT_ID
                ),
            )
        )

        self.assertIs(
            validated,
            report,
        )

        self.assertEqual(
            report,
            before,
        )

        self.assertEqual(
            validated[
                "contractVersion"
            ],
            "1.0",
        )

        self.assertEqual(
            [
                claim[
                    "claimVersion"
                ]
                for claim
                in validated[
                    "claims"
                ]
            ],
            [
                1,
                3,
            ],
        )

    def test_report_root_and_required_sections_must_have_expected_types(
        self,
    ) -> None:
        assert_contract_error(
            self,
            [],
            message=(
                "report must be "
                "an object"
            ),
        )

        object_fields = [
            "metadata",
            "summary",
            "graph",
            "risk",
            "history",
        ]

        for field in object_fields:
            with self.subTest(
                field=field,
            ):
                report = valid_report()

                report[field] = []

                assert_contract_error(
                    self,
                    report,
                    message=(
                        f"report.{field} "
                        "must be an object"
                    ),
                )

        array_fields = [
            "claims",
            "providers",
            "members",
        ]

        for field in array_fields:
            with self.subTest(
                field=field,
            ):
                report = valid_report()

                report[field] = {}

                assert_contract_error(
                    self,
                    report,
                    message=(
                        f"report.{field} "
                        "must be an array"
                    ),
                )

    def test_unsupported_version_and_publication_tenant_mismatch_fail(
        self,
    ) -> None:
        report = valid_report()

        report[
            "contractVersion"
        ] = "2.0"

        assert_contract_error(
            self,
            report,
            message=(
                "contract version "
                "is unsupported"
            ),
        )

        assert_contract_error(
            self,
            valid_report(),
            tenant_id=(
                "tenant_beta"
            ),
            message=(
                "tenant does not match"
            ),
        )

    def test_nested_tenant_identifiers_cannot_escape_canonical_scope(
        self,
    ) -> None:
        cases = [
            {
                "tenantId":
                    "tenant_beta",
            },
            {
                "tenant_id":
                    "tenant_beta",
            },
        ]

        for nested_value in cases:
            with self.subTest(
                nested_value=(
                    nested_value
                )
            ):
                report = valid_report()

                report["risk"][
                    "nested"
                ] = nested_value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "outside the canonical "
                        "tenant scope"
                    ),
                )

    def test_report_id_must_be_lowercase_sha256_digest(
        self,
    ) -> None:
        invalid_values = [
            None,
            "",
            "not-a-digest",
            "A" * 64,
            "g" * 64,
            "a" * 63,
            "a" * 65,
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report["metadata"][
                    "reportId"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "lowercase "
                        "64-character"
                    ),
                )

    def test_required_timestamps_must_be_parseable_iso_values(
        self,
    ) -> None:
        fields = [
            "generatedAt",
            "snapshotCutoff",
        ]

        invalid_values = [
            None,
            "",
            "not-a-timestamp",
            "2026-99-99T25:61:00Z",
        ]

        for field in fields:
            for value in invalid_values:
                with self.subTest(
                    field=field,
                    value=value,
                ):
                    report = valid_report()

                    report[
                        "metadata"
                    ][field] = value

                    assert_contract_error(
                        self,
                        report,
                        message=(
                            f"report.metadata."
                            f"{field} must be "
                            "an ISO timestamp"
                        ),
                    )

    def test_source_watermark_is_required(
        self,
    ) -> None:
        invalid_values = [
            None,
            "",
            7,
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "metadata"
                ][
                    "source"
                ][
                    "watermark"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "source.watermark "
                        "is required"
                    ),
                )

    def test_included_counts_must_exactly_match_entity_arrays(
        self,
    ) -> None:
        mutations = [
            {
                "claims": 1,
                "providers": 2,
                "members": 2,
            },
            {
                "claims": 2,
                "providers": 1,
                "members": 2,
            },
            {
                "claims": 2,
                "providers": 2,
                "members": 1,
            },
            {
                "claims": 2,
                "providers": 2,
                "members": 2,
                "extra": 0,
            },
        ]

        for included_counts in mutations:
            with self.subTest(
                included_counts=(
                    included_counts
                )
            ):
                report = valid_report()

                report[
                    "metadata"
                ][
                    "includedCounts"
                ] = included_counts

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "aggregate counts "
                        "do not match"
                    ),
                )

    def test_summary_claim_count_must_match_claim_array(
        self,
    ) -> None:
        invalid_values = [
            1,
            3,
            "2",
            True,
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "summary"
                ][
                    "totalClaims"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "aggregate counts "
                        "do not match"
                    ),
                )

    def test_claim_identifiers_are_required(
        self,
    ) -> None:
        identifiers = [
            "claimId",
            "providerId",
            "memberId",
            "schemeId",
        ]

        invalid_values = [
            None,
            "",
            "   ",
            123,
        ]

        for identifier in identifiers:
            for value in invalid_values:
                with self.subTest(
                    identifier=identifier,
                    value=value,
                ):
                    report = valid_report()

                    report[
                        "claims"
                    ][0][
                        identifier
                    ] = value

                    assert_contract_error(
                        self,
                        report,
                        message=(
                            f"{identifier} "
                            "is required"
                        ),
                    )

    def test_claim_version_must_be_a_positive_integer(
        self,
    ) -> None:
        invalid_values = [
            None,
            True,
            False,
            0,
            -1,
            1.0,
            1.5,
            "1",
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "claims"
                ][0][
                    "claimVersion"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "claimVersion is "
                        "required and must "
                        "be a positive integer"
                    ),
                )

    def test_claim_amounts_must_be_finite_numbers(
        self,
    ) -> None:
        invalid_values = [
            None,
            True,
            False,
            "10.00",
            float("nan"),
            float("inf"),
            float("-inf"),
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "claims"
                ][0][
                    "amount"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "amount must be "
                        "a finite number"
                    ),
                )

    def test_summary_total_must_equal_rounded_claim_total(
        self,
    ) -> None:
        report = valid_report()

        report[
            "summary"
        ][
            "totalClaimedAmount"
        ] = 30.49

        assert_contract_error(
            self,
            report,
            message=(
                "total claimed amount "
                "is inconsistent"
            ),
        )

        invalid_values = [
            None,
            True,
            "30.50",
            float("nan"),
            float("inf"),
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "summary"
                ][
                    "totalClaimedAmount"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "total claimed amount "
                        "is inconsistent"
                    ),
                )

    def test_provider_and_member_identifiers_are_required(
        self,
    ) -> None:
        cases = [
            (
                "providers",
                "providerId",
            ),
            (
                "members",
                "memberId",
            ),
        ]

        for collection, identifier in cases:
            for value in (
                None,
                "",
                " ",
                123,
            ):
                with self.subTest(
                    collection=collection,
                    value=value,
                ):
                    report = valid_report()

                    report[
                        collection
                    ][0][
                        identifier
                    ] = value

                    assert_contract_error(
                        self,
                        report,
                        message=(
                            f"{identifier} "
                            "is required"
                        ),
                    )

    def test_graph_nodes_require_nonempty_identifiers(
        self,
    ) -> None:
        invalid_values = [
            None,
            "",
            " ",
            123,
        ]

        for value in invalid_values:
            with self.subTest(
                value=value,
            ):
                report = valid_report()

                report[
                    "graph"
                ][
                    "nodes"
                ][0][
                    "entity_id"
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "entity_id "
                        "is required"
                    ),
                )

    def test_graph_edges_must_reference_known_nodes(
        self,
    ) -> None:
        cases = [
            (
                "source_entity_id",
                "claimant:missing",
            ),
            (
                "target_entity_id",
                "provider:missing",
            ),
            (
                "source_entity_id",
                None,
            ),
            (
                "target_entity_id",
                None,
            ),
        ]

        for field, value in cases:
            with self.subTest(
                field=field,
                value=value,
            ):
                report = valid_report()

                report[
                    "graph"
                ][
                    "edges"
                ][0][
                    field
                ] = value

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "edge with an "
                        "unknown node"
                    ),
                )

    def test_nonfinite_numbers_are_rejected_recursively(
        self,
    ) -> None:
        paths = [
            (
                "risk",
                "score",
            ),
            (
                "history",
                "metric",
            ),
            (
                "graph",
                "metric",
            ),
        ]

        for section, field in paths:
            with self.subTest(
                section=section,
            ):
                report = valid_report()

                report[
                    section
                ][field] = float(
                    "nan"
                )

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "contains a "
                        "non-finite number"
                    ),
                )

    def test_sensitive_fields_are_rejected_recursively_and_case_insensitively(
        self,
    ) -> None:
        forbidden_fields = [
            "firstName",
            "last_name",
            "Date-Of-Birth",
            "identityNumber",
            "banking_detail",
            "syntheticIdNumber",
            "syntheticBankingDetail",
            "bankAccount",
            "email",
            "phone",
            "address",
            "ipAddress",
            "device_id",
        ]

        for field in forbidden_fields:
            with self.subTest(
                field=field,
            ):
                report = valid_report()

                report[
                    "claims"
                ][0][field] = (
                    "private-value"
                )

                assert_contract_error(
                    self,
                    report,
                    message=(
                        "is not permitted "
                        "in a shared report "
                        "artifact"
                    ),
                )

    def test_privacy_and_tenant_checks_cover_nested_arrays(
        self,
    ) -> None:
        privacy_report = (
            valid_report()
        )

        privacy_report[
            "history"
        ][
            "nested"
        ] = [
            {
                "items": [
                    {
                        "bank_account":
                            "private",
                    }
                ]
            }
        ]

        assert_contract_error(
            self,
            privacy_report,
            message=(
                "is not permitted"
            ),
        )

        tenant_report = (
            valid_report()
        )

        tenant_report[
            "history"
        ][
            "nested"
        ] = [
            {
                "items": [
                    {
                        "tenantId":
                            "tenant_beta",
                    }
                ]
            }
        ]

        assert_contract_error(
            self,
            tenant_report,
            message=(
                "outside the canonical "
                "tenant scope"
            ),
        )

    def test_empty_entity_arrays_are_valid_when_aggregates_match(
        self,
    ) -> None:
        report = valid_report()

        report["claims"] = []
        report["providers"] = []
        report["members"] = []

        report[
            "metadata"
        ][
            "includedCounts"
        ] = {
            "claims": 0,
            "providers": 0,
            "members": 0,
        }

        report[
            "summary"
        ][
            "totalClaims"
        ] = 0

        report[
            "summary"
        ][
            "totalClaimedAmount"
        ] = 0.0

        validated = (
            validate_detection_report(
                report,
                expected_tenant_id=(
                    TENANT_ID
                ),
            )
        )

        self.assertEqual(
            validated["claims"],
            [],
        )
