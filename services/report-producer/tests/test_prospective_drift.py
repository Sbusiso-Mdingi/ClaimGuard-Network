from __future__ import annotations

from unittest import TestCase

from claimguard_report_producer.prospective_drift import assess_input_drift


MODEL = {
    "model_id": "claimguard-claim-fraud-ensemble",
    "model_version": "2.1.1",
    "feature_schema_version": "claim-feature-schema-2026.2",
}


def known_features() -> dict[str, object]:
    return {
        "claimed_amount": 610.0,
        "quantity": 1.0,
        "submission_lag_days": 1,
        "has_rendering_practitioner": 1,
        "rendering_known_to_billing_provider": 1,
        "member_has_prior_claim": 0,
        "pair_has_prior_claim": 0,
        "service_weekday_sin": 0.0,
        "service_weekday_cos": 1.0,
        "service_month_sin": 0.5,
        "service_month_cos": -0.5,
        "benefit_option": "COMPREHENSIVE",
        "network_type": "CONTRACTED",
        "line_type": "PROFESSIONAL_SERVICE",
        "tariff_discipline": "014",
        "diagnosis_code": "E11.9",
    }


class ProspectiveInputDriftTests(TestCase):
    def test_known_feature_vector_is_in_distribution(self) -> None:
        assessment = assess_input_drift(known_features(), **MODEL)

        self.assertEqual(assessment["status"], "IN_DISTRIBUTION")
        self.assertEqual(assessment["decisionReliability"], "NORMAL")
        self.assertEqual(assessment["signals"], [])

    def test_one_unseen_category_is_watch(self) -> None:
        features = known_features()
        features["benefit_option"] = "STANDARD"

        assessment = assess_input_drift(features, **MODEL)

        self.assertEqual(assessment["status"], "WATCH")
        self.assertEqual(assessment["decisionReliability"], "CAUTION")
        self.assertEqual(assessment["signals"][0]["feature"], "benefit_option")
        self.assertEqual(assessment["signals"][0]["kind"], "UNSEEN_CATEGORY")

    def test_multiple_unseen_categories_limit_reliability(self) -> None:
        features = known_features()
        features["benefit_option"] = "SAVER"
        features["diagnosis_code"] = "Z76.0"

        assessment = assess_input_drift(features, **MODEL)

        self.assertEqual(assessment["status"], "OUT_OF_DISTRIBUTION")
        self.assertEqual(assessment["decisionReliability"], "LIMITED")
        self.assertEqual(assessment["signalCount"], 2)

    def test_unregistered_model_does_not_claim_to_have_a_profile(self) -> None:
        assessment = assess_input_drift(
            known_features(),
            model_id="claimguard-claim-fraud-baseline",
            model_version="1.0.0",
            feature_schema_version="claim-feature-schema-2026.2",
        )

        self.assertEqual(assessment["status"], "PROFILE_UNAVAILABLE")
        self.assertEqual(assessment["profileId"], None)
