from __future__ import annotations

from unittest import TestCase

from claimguard_report_producer.model_registry import (
    APPROVED_DEPLOYMENTS_ENV,
    PRIMARY_DEPLOYMENT_ENV,
    ModelDeploymentNotApprovedError,
    ModelRegistryConfigurationError,
    ProspectiveModelDeploymentRegistry,
    deployment_environment_prefix,
)
from claimguard_report_producer.model_service import ModelHttpResponse
from claimguard_report_producer.prospective_model_service import (
    ANALYSIS_MODE,
    FEATURE_SCHEMA_VERSION,
    MODEL_ID,
    MODEL_VERSION,
)


BASELINE_DEPLOYMENT = "claimguard-claim-fraud-baseline:1.0.0"
CANDIDATE_DEPLOYMENT = "claimguard-claim-fraud-ensemble:2.0.0"


class StaticTokenProvider:
    def get_token(self, _audience: str) -> str:
        return "token"


class UnusedTransport:
    def post(self, **_kwargs) -> ModelHttpResponse:
        raise AssertionError("Registry construction must not call the model service.")


def base_environment() -> dict[str, str]:
    return {
        PRIMARY_DEPLOYMENT_ENV: BASELINE_DEPLOYMENT,
        "MODEL_SERVICE_BASE_URL": "https://baseline.example.test",
        "MODEL_SERVICE_AUDIENCE": "api://baseline-model",
        "MODEL_SERVICE_PSEUDONYMIZATION_KEY": "b" * 32,
        "MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD": "0.08760971001434723",
    }


def registry(environment: dict[str, str]) -> ProspectiveModelDeploymentRegistry:
    return ProspectiveModelDeploymentRegistry(
        environment=environment,
        token_provider_factory=StaticTokenProvider,
        transport_factory=UnusedTransport,
    )


class ProspectiveModelDeploymentRegistryTests(TestCase):
    def test_primary_deployment_keeps_existing_baseline_configuration(
        self,
    ) -> None:
        model_registry = registry(base_environment())

        client = model_registry.client_for(BASELINE_DEPLOYMENT)

        self.assertEqual(
            model_registry.approved_deployment_ids,
            (BASELINE_DEPLOYMENT,),
        )
        self.assertEqual(client.endpoint_url, "https://baseline.example.test/v3/claim-screening")
        self.assertEqual(client.expectations.deployment_id, BASELINE_DEPLOYMENT)
        self.assertEqual(client.expectations.model_id, MODEL_ID)
        self.assertEqual(client.expectations.model_version, MODEL_VERSION)
        self.assertEqual(
            client.expectations.feature_schema_version,
            FEATURE_SCHEMA_VERSION,
        )
        self.assertEqual(client.expectations.analysis_mode, ANALYSIS_MODE)
        self.assertEqual(
            client.expectations.threshold,
            0.08760971001434723,
        )

    def test_each_approved_deployment_has_immutable_endpoint_and_identity(
        self,
    ) -> None:
        environment = base_environment()
        environment[APPROVED_DEPLOYMENTS_ENV] = (
            f"{BASELINE_DEPLOYMENT},{CANDIDATE_DEPLOYMENT}"
        )
        prefix = deployment_environment_prefix(CANDIDATE_DEPLOYMENT)
        environment[f"MODEL_SERVICE_BASE_URL_{prefix}"] = (
            "https://ensemble.example.test"
        )
        environment[f"MODEL_SERVICE_AUDIENCE_{prefix}"] = (
            "api://ensemble-model"
        )
        environment[f"MODEL_SERVICE_PSEUDONYMIZATION_KEY_{prefix}"] = "e" * 32
        environment[f"MODEL_SERVICE_EXPECTED_MODEL_ID_{prefix}"] = (
            "claimguard-claim-fraud-ensemble"
        )
        environment[f"MODEL_SERVICE_EXPECTED_MODEL_VERSION_{prefix}"] = "2.0.0"
        environment[f"MODEL_SERVICE_EXPECTED_THRESHOLD_{prefix}"] = "0.19"

        model_registry = registry(environment)
        baseline = model_registry.client_for(BASELINE_DEPLOYMENT)
        candidate = model_registry.client_for(CANDIDATE_DEPLOYMENT)

        self.assertIsNot(baseline, candidate)
        self.assertIs(
            candidate,
            model_registry.client_for(CANDIDATE_DEPLOYMENT),
        )
        self.assertEqual(
            candidate.endpoint_url,
            "https://ensemble.example.test/v3/claim-screening",
        )
        self.assertEqual(
            candidate.expectations.model_id,
            "claimguard-claim-fraud-ensemble",
        )
        self.assertEqual(candidate.expectations.model_version, "2.0.0")
        self.assertEqual(candidate.expectations.threshold, 0.19)

    def test_unapproved_pinned_deployment_is_rejected_before_network_access(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ModelDeploymentNotApprovedError,
            "not approved",
        ):
            registry(base_environment()).client_for(CANDIDATE_DEPLOYMENT)

    def test_unknown_feature_schema_is_rejected_until_a_builder_exists(
        self,
    ) -> None:
        environment = base_environment()
        environment["MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION"] = (
            "claim-feature-schema-2099.1"
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "feature builder does not support",
        ):
            registry(environment).client_for(BASELINE_DEPLOYMENT)
