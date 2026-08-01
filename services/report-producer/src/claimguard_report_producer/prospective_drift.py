from __future__ import annotations

import math
from typing import Mapping


INPUT_DRIFT_SCHEMA_VERSION = "claimguard.input-drift.v1"
PROFILE_ID = "claimguard-claim-fraud-ensemble-2.1.1-input-profile.v1"

# This profile is deliberately limited to values confirmed from the sealed 2.1.1
# training artifact. A feature without a verified reference vocabulary is not
# presented as drift-monitored.
_PROFILE_IDENTITY = (
    "claimguard-claim-fraud-ensemble",
    "2.1.1",
    "claim-feature-schema-2026.2",
)
_CATEGORICAL_VALUES = {
    "benefit_option": frozenset({"COMPREHENSIVE", "CORE", "EXECUTIVE", "FLEX"}),
    "network_type": frozenset({"CONTRACTED", "DSP", "NON_NETWORK", "PREFERRED_NETWORK"}),
    "line_type": frozenset({"FACILITY_SERVICE", "MEDICINE", "PROFESSIONAL_SERVICE"}),
    "tariff_discipline": frozenset({"014", "038", "052", "072", "PHARM"}),
    "diagnosis_code": frozenset({"E11.9", "I10", "J06.9", "J45.9", "M54.5", "Z00.0"}),
}

_NON_NEGATIVE_FEATURES = frozenset(
    {
        "claimed_amount",
        "log1p_claimed_amount",
        "quantity",
        "submission_lag_days",
        "provider_prior_claim_count",
        "provider_prior_unique_member_count",
        "provider_prior_amount_mean",
        "provider_prior_amount_std",
        "provider_prior_max_amount",
        "provider_prior_same_service_day_count",
        "provider_prior_same_code_count",
        "provider_prior_same_code_share",
        "provider_prior_7d_claim_count",
        "provider_prior_30d_claim_count",
        "provider_prior_90d_claim_count",
        "provider_prior_30d_amount_mean",
        "member_prior_claim_count",
        "member_prior_unique_provider_count",
        "member_prior_amount_mean",
        "member_prior_amount_std",
        "member_prior_7d_claim_count",
        "member_prior_30d_claim_count",
        "member_prior_90d_claim_count",
        "member_prior_same_service_day_provider_count",
        "member_days_since_prior_submission",
        "pair_prior_claim_count",
        "pair_prior_same_code_count",
        "pair_days_since_prior_submission",
        "exact_duplicate_prior_count",
        "code_prior_claim_count",
        "code_prior_amount_mean",
        "code_prior_amount_std",
        "claimed_to_provider_prior_mean_ratio",
        "claimed_to_code_prior_mean_ratio",
    }
)
_BINARY_FEATURES = frozenset(
    {
        "has_rendering_practitioner",
        "rendering_known_to_billing_provider",
        "member_has_prior_claim",
        "pair_has_prior_claim",
    }
)
_CYCLICAL_FEATURES = frozenset(
    {
        "service_weekday_sin",
        "service_weekday_cos",
        "service_month_sin",
        "service_month_cos",
    }
)


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _signal(
    feature: str,
    kind: str,
    value: object,
    expected: str,
) -> dict[str, object]:
    return {
        "feature": feature,
        "kind": kind,
        "observed": value,
        "expected": expected,
    }


def assess_input_drift(
    features: Mapping[str, object],
    *,
    model_id: str,
    model_version: str,
    feature_schema_version: str,
) -> dict[str, object]:
    """Assess one prospective feature vector against a sealed model profile.

    This is an input guard, not a second fraud model. It reports unfamiliar
    categorical inputs and invalid numeric feature shapes without altering the
    approved model output.
    """

    identity = (model_id, model_version, feature_schema_version)
    if identity != _PROFILE_IDENTITY:
        return {
            "schemaVersion": INPUT_DRIFT_SCHEMA_VERSION,
            "profileId": None,
            "status": "PROFILE_UNAVAILABLE",
            "decisionReliability": "UNKNOWN",
            "signalCount": 0,
            "signals": [],
            "message": "No approved input profile is registered for this model version.",
        }

    signals: list[dict[str, object]] = []
    for feature, allowed in _CATEGORICAL_VALUES.items():
        observed = str(features.get(feature) or "").strip()
        if observed not in allowed:
            signals.append(
                _signal(
                    feature,
                    "UNSEEN_CATEGORY",
                    observed or None,
                    "One of: " + ", ".join(sorted(allowed)),
                )
            )

    for feature in _NON_NEGATIVE_FEATURES:
        if feature not in features:
            continue
        observed = _number(features.get(feature))
        if observed is None or observed < 0:
            signals.append(
                _signal(feature, "INVALID_NUMERIC_VALUE", features.get(feature), "A finite value of zero or greater")
            )

    for feature in _BINARY_FEATURES:
        if feature not in features:
            continue
        observed = _number(features.get(feature))
        if observed not in {0.0, 1.0}:
            signals.append(
                _signal(feature, "INVALID_BINARY_VALUE", features.get(feature), "0 or 1")
            )

    for feature in _CYCLICAL_FEATURES:
        if feature not in features:
            continue
        observed = _number(features.get(feature))
        if observed is None or not -1 <= observed <= 1:
            signals.append(
                _signal(feature, "INVALID_CYCLICAL_VALUE", features.get(feature), "A finite value between -1 and 1")
            )

    critical = any(signal["kind"].startswith("INVALID_") for signal in signals)
    if critical or len(signals) >= 2:
        status = "OUT_OF_DISTRIBUTION"
        reliability = "LIMITED"
        message = "Multiple unfamiliar inputs or an invalid feature shape were detected; interpret the model score with caution."
    elif signals:
        status = "WATCH"
        reliability = "CAUTION"
        message = "One unfamiliar model input was detected; retain human review and monitor the pattern."
    else:
        status = "IN_DISTRIBUTION"
        reliability = "NORMAL"
        message = "No unfamiliar monitored inputs were detected."

    return {
        "schemaVersion": INPUT_DRIFT_SCHEMA_VERSION,
        "profileId": PROFILE_ID,
        "status": status,
        "decisionReliability": reliability,
        "monitoredCategoricalFeatures": sorted(_CATEGORICAL_VALUES),
        "signalCount": len(signals),
        "signals": signals,
        "message": message,
    }
