from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from unittest import TestCase

from claimguard_report_producer.model_registry import (
    APPROVED_DEPLOYMENTS_ENV,
    PRIMARY_DEPLOYMENT_ENV,
    ModelDeploymentNotApprovedError,
    ModelDeploymentRegistry,
    ModelRegistryConfigurationError,
    deployment_environment_prefix,
)
from claimguard_report_producer.model_service import (
    DEFAULT_ENDPOINT_PATH,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    ModelServiceClient,
    ModelServiceExpectations,
)


DEPLOYMENT_A = (
    "claimguard-claim-fraud-ensemble:1.1.0"
)

DEPLOYMENT_B = (
    "claimguard-claim-fraud-ensemble:1.2.0"
)


class FakeTokenProvider:
    def get_token(
        self,
        _audience: str,
    ) -> str:
        return "token"


class FakeTransport:
    def post(
        self,
        **_kwargs,
    ):
        raise AssertionError(
            "Transport should not be called by registry tests."
        )


class CountingFactory:
    def __init__(
        self,
        value=None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.value = value
        self.error = error
        self.calls = 0

    def __call__(
        self,
    ):
        self.calls += 1

        if self.error is not None:
            raise self.error

        return self.value


class RecordingClientFactory:
    def __init__(
        self,
    ) -> None:
        self.calls = []

    def __call__(
        self,
        **kwargs,
    ) -> ModelServiceClient:
        self.calls.append(
            dict(
                kwargs
            )
        )

        return ModelServiceClient(
            **kwargs,
        )


def base_environment(
    *,
    primary: str = DEPLOYMENT_A,
) -> dict[str, str]:
    return {
        PRIMARY_DEPLOYMENT_ENV:
            primary,

        "MODEL_SERVICE_BASE_URL":
            "https://models.example",

        "MODEL_SERVICE_AUDIENCE":
            "api://claimguard-model",

        "MODEL_SERVICE_PSEUDONYMIZATION_KEY":
            "k" * 32,
    }


def registry_for(
    *,
    environment=None,
    approved_deployment_ids=None,
    token_factory=None,
    transport_factory=None,
    client_factory=None,
):
    token = (
        token_factory
        or CountingFactory(
            FakeTokenProvider()
        )
    )

    transport = (
        transport_factory
        or CountingFactory(
            FakeTransport()
        )
    )

    clients = (
        client_factory
        or RecordingClientFactory()
    )

    registry = ModelDeploymentRegistry(
        environment=(
            base_environment()
            if environment is None
            else environment
        ),
        approved_deployment_ids=(
            approved_deployment_ids
        ),
        token_provider_factory=token,
        transport_factory=transport,
        client_factory=clients,
    )

    return (
        registry,
        token,
        transport,
        clients,
    )


class ModelRegistryTests(
    TestCase,
):
    def test_primary_deployment_environment_approves_exactly_one_client(
        self,
    ) -> None:
        (
            registry,
            token_factory,
            transport_factory,
            client_factory,
        ) = registry_for()

        self.assertEqual(
            registry.approved_deployment_ids,
            (
                DEPLOYMENT_A,
            ),
        )

        client = registry.client_for(
            DEPLOYMENT_A
        )

        self.assertIsInstance(
            client,
            ModelServiceClient,
        )

        self.assertEqual(
            client.endpoint_url,
            (
                "https://models.example"
                f"{DEFAULT_ENDPOINT_PATH}"
            ),
        )

        self.assertEqual(
            client.audience,
            "api://claimguard-model",
        )

        self.assertEqual(
            client.pseudonymization_key,
            ("k" * 32).encode(
                "utf-8"
            ),
        )

        self.assertEqual(
            client.expectations.deployment_id,
            DEPLOYMENT_A,
        )

        self.assertEqual(
            client.expectations.ensemble_id,
            ENSEMBLE_ID,
        )

        self.assertEqual(
            client.expectations.ensemble_version,
            ENSEMBLE_VERSION,
        )

        self.assertEqual(
            client.expectations.feature_schema_version,
            FEATURE_SCHEMA_VERSION,
        )

        self.assertEqual(
            client.timeout_seconds,
            120.0,
        )

        self.assertEqual(
            token_factory.calls,
            1,
        )

        self.assertEqual(
            transport_factory.calls,
            1,
        )

        self.assertEqual(
            len(
                client_factory.calls
            ),
            1,
        )

    def test_unapproved_or_invalid_deployment_is_rejected_before_factories(
        self,
    ) -> None:
        (
            registry,
            token_factory,
            transport_factory,
            client_factory,
        ) = registry_for()

        for deployment_id in (
            DEPLOYMENT_B,
            "",
            "contains spaces",
            "../unsafe",
        ):
            with self.subTest(
                deployment_id=deployment_id,
            ):
                with self.assertRaises(
                    ModelDeploymentNotApprovedError
                ) as captured:
                    registry.client_for(
                        deployment_id
                    )

                self.assertEqual(
                    captured.exception.code,
                    "MODEL_DEPLOYMENT_NOT_APPROVED",
                )

        self.assertEqual(
            token_factory.calls,
            0,
        )

        self.assertEqual(
            transport_factory.calls,
            0,
        )

        self.assertEqual(
            client_factory.calls,
            [],
        )

    def test_approved_list_preserves_order_and_requires_primary_membership(
        self,
    ) -> None:
        environment = base_environment()

        environment[
            APPROVED_DEPLOYMENTS_ENV
        ] = (
            f"{DEPLOYMENT_B},"
            f"{DEPLOYMENT_A}"
        )

        registry = ModelDeploymentRegistry(
            environment=environment,
            token_provider_factory=(
                lambda: FakeTokenProvider()
            ),
            transport_factory=(
                lambda: FakeTransport()
            ),
        )

        self.assertEqual(
            registry.approved_deployment_ids,
            (
                DEPLOYMENT_B,
                DEPLOYMENT_A,
            ),
        )

        invalid_environment = (
            base_environment()
        )

        invalid_environment[
            APPROVED_DEPLOYMENTS_ENV
        ] = DEPLOYMENT_B

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "must be included",
        ):
            ModelDeploymentRegistry(
                environment=(
                    invalid_environment
                )
            )

    def test_approved_environment_list_rejects_empty_duplicate_and_invalid_entries(
        self,
    ) -> None:
        cases = [
            f"{DEPLOYMENT_A},",
            (
                f"{DEPLOYMENT_A},"
                f"{DEPLOYMENT_A}"
            ),
            (
                f"{DEPLOYMENT_A},"
                "contains spaces"
            ),
        ]

        for configured in cases:
            with self.subTest(
                configured=configured,
            ):
                environment = (
                    base_environment()
                )

                environment[
                    APPROVED_DEPLOYMENTS_ENV
                ] = configured

                with self.assertRaises(
                    ModelRegistryConfigurationError
                ):
                    ModelDeploymentRegistry(
                        environment=environment
                    )

    def test_explicit_approved_deployments_override_environment_approval_list(
        self,
    ) -> None:
        environment = base_environment(
            primary=DEPLOYMENT_B
        )

        environment[
            APPROVED_DEPLOYMENTS_ENV
        ] = DEPLOYMENT_B

        (
            registry,
            _token,
            _transport,
            _clients,
        ) = registry_for(
            environment=environment,
            approved_deployment_ids=[
                DEPLOYMENT_A,
            ],
        )

        self.assertEqual(
            registry.approved_deployment_ids,
            (
                DEPLOYMENT_A,
            ),
        )

        registry.client_for(
            DEPLOYMENT_A
        )

        with self.assertRaises(
            ModelDeploymentNotApprovedError
        ):
            registry.client_for(
                DEPLOYMENT_B
            )

    def test_no_approved_deployments_fails_closed(
        self,
    ) -> None:
        environment = base_environment()

        environment.pop(
            PRIMARY_DEPLOYMENT_ENV
        )

        registry = ModelDeploymentRegistry(
            environment=environment,
            token_provider_factory=(
                lambda: FakeTokenProvider()
            ),
            transport_factory=(
                lambda: FakeTransport()
            ),
        )

        self.assertEqual(
            registry.approved_deployment_ids,
            (),
        )

        with self.assertRaises(
            ModelDeploymentNotApprovedError
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

    def test_environment_prefix_is_deterministic_and_collision_resistant(
        self,
    ) -> None:
        first = (
            deployment_environment_prefix(
                "model:a-b"
            )
        )

        repeated = (
            deployment_environment_prefix(
                "model:a-b"
            )
        )

        similar = (
            deployment_environment_prefix(
                "model:a_b"
            )
        )

        self.assertEqual(
            first,
            repeated,
        )

        self.assertNotEqual(
            first,
            similar,
        )

        self.assertRegex(
            first,
            r"^[A-Z0-9_]+_[0-9A-F]{12}$",
        )

        with self.assertRaises(
            ModelRegistryConfigurationError
        ):
            deployment_environment_prefix(
                "invalid deployment"
            )

    def test_exact_per_deployment_overrides_take_precedence_over_generic_values(
        self,
    ) -> None:
        environment = base_environment()

        environment[
            APPROVED_DEPLOYMENTS_ENV
        ] = (
            f"{DEPLOYMENT_A},"
            f"{DEPLOYMENT_B}"
        )

        prefix = (
            deployment_environment_prefix(
                DEPLOYMENT_B
            )
        )

        overrides = {
            "MODEL_SERVICE_BASE_URL":
                "https://models-b.example",

            "MODEL_SERVICE_AUDIENCE":
                "api://models-b",

            (
                "MODEL_SERVICE_"
                "PSEUDONYMIZATION_KEY"
            ):
                "b" * 32,

            "MODEL_SERVICE_ENDPOINT_PATH":
                "/v3/custom-screening",

            (
                "MODEL_SERVICE_EXPECTED_"
                "ENSEMBLE_ID"
            ):
                "ensemble-b",

            (
                "MODEL_SERVICE_EXPECTED_"
                "ENSEMBLE_VERSION"
            ):
                "2.0.0",

            (
                "MODEL_SERVICE_EXPECTED_"
                "FEATURE_SCHEMA_VERSION"
            ):
                "features-b",

            (
                "MODEL_SERVICE_EXPECTED_"
                "BASELINE_THRESHOLD"
            ):
                "0.2",

            (
                "MODEL_SERVICE_EXPECTED_"
                "RING_THRESHOLD"
            ):
                "0.3",

            (
                "MODEL_SERVICE_EXPECTED_"
                "PHANTOM_THRESHOLD"
            ):
                "0.4",

            "MODEL_SERVICE_TIMEOUT_SECONDS":
                "45",
        }

        for name, value in (
            overrides.items()
        ):
            environment[
                f"{name}_{prefix}"
            ] = value

        (
            registry,
            _token,
            _transport,
            clients,
        ) = registry_for(
            environment=environment
        )

        first = registry.client_for(
            DEPLOYMENT_A
        )

        second = registry.client_for(
            DEPLOYMENT_B
        )

        self.assertEqual(
            first.endpoint_url,
            (
                "https://models.example"
                f"{DEFAULT_ENDPOINT_PATH}"
            ),
        )

        self.assertEqual(
            second.endpoint_url,
            (
                "https://models-b.example"
                "/v3/custom-screening"
            ),
        )

        self.assertEqual(
            second.audience,
            "api://models-b",
        )

        self.assertEqual(
            second.pseudonymization_key,
            ("b" * 32).encode(
                "utf-8"
            ),
        )

        self.assertEqual(
            second.expectations.ensemble_id,
            "ensemble-b",
        )

        self.assertEqual(
            second.expectations.ensemble_version,
            "2.0.0",
        )

        self.assertEqual(
            second.expectations.feature_schema_version,
            "features-b",
        )

        self.assertEqual(
            second.expectations.baseline_threshold,
            0.2,
        )

        self.assertEqual(
            second.expectations.ring_threshold,
            0.3,
        )

        self.assertEqual(
            second.expectations.phantom_threshold,
            0.4,
        )

        self.assertEqual(
            second.timeout_seconds,
            45.0,
        )

        self.assertEqual(
            len(
                clients.calls
            ),
            2,
        )

    def test_empty_exact_override_fails_instead_of_falling_back(
        self,
    ) -> None:
        environment = base_environment()

        prefix = (
            deployment_environment_prefix(
                DEPLOYMENT_A
            )
        )

        environment[
            f"MODEL_SERVICE_BASE_URL_{prefix}"
        ] = "   "

        (
            registry,
            token_factory,
            transport_factory,
            client_factory,
        ) = registry_for(
            environment=environment
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "must not be empty",
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

        self.assertEqual(
            token_factory.calls,
            0,
        )

        self.assertEqual(
            transport_factory.calls,
            0,
        )

        self.assertEqual(
            client_factory.calls,
            [],
        )

    def test_environment_is_snapshotted_at_registry_construction(
        self,
    ) -> None:
        environment = base_environment()

        (
            registry,
            _token,
            _transport,
            _clients,
        ) = registry_for(
            environment=environment
        )

        environment[
            "MODEL_SERVICE_BASE_URL"
        ] = "https://changed.example"

        environment[
            PRIMARY_DEPLOYMENT_ENV
        ] = DEPLOYMENT_B

        client = registry.client_for(
            DEPLOYMENT_A
        )

        self.assertEqual(
            client.endpoint_url,
            (
                "https://models.example"
                f"{DEFAULT_ENDPOINT_PATH}"
            ),
        )

        self.assertEqual(
            registry.approved_deployment_ids,
            (
                DEPLOYMENT_A,
            ),
        )

    def test_client_is_cached_per_exact_deployment(
        self,
    ) -> None:
        (
            registry,
            token_factory,
            transport_factory,
            client_factory,
        ) = registry_for()

        first = registry.client_for(
            DEPLOYMENT_A
        )

        second = registry.client_for(
            DEPLOYMENT_A
        )

        self.assertIs(
            first,
            second,
        )

        self.assertEqual(
            token_factory.calls,
            1,
        )

        self.assertEqual(
            transport_factory.calls,
            1,
        )

        self.assertEqual(
            len(
                client_factory.calls
            ),
            1,
        )

    def test_concurrent_requests_build_only_one_client(
        self,
    ) -> None:
        (
            registry,
            token_factory,
            transport_factory,
            client_factory,
        ) = registry_for()

        with ThreadPoolExecutor(
            max_workers=8
        ) as executor:
            clients = list(
                executor.map(
                    lambda _index: (
                        registry.client_for(
                            DEPLOYMENT_A
                        )
                    ),
                    range(32),
                )
            )

        self.assertTrue(
            all(
                client
                is clients[0]
                for client in clients
            )
        )

        self.assertEqual(
            token_factory.calls,
            1,
        )

        self.assertEqual(
            transport_factory.calls,
            1,
        )

        self.assertEqual(
            len(
                client_factory.calls
            ),
            1,
        )

    def test_missing_required_connection_configuration_fails_before_factories(
        self,
    ) -> None:
        required_names = [
            "MODEL_SERVICE_BASE_URL",
            "MODEL_SERVICE_AUDIENCE",
            (
                "MODEL_SERVICE_"
                "PSEUDONYMIZATION_KEY"
            ),
        ]

        for name in required_names:
            with self.subTest(
                name=name,
            ):
                environment = (
                    base_environment()
                )

                environment.pop(
                    name
                )

                (
                    registry,
                    token_factory,
                    transport_factory,
                    client_factory,
                ) = registry_for(
                    environment=environment
                )

                with self.assertRaisesRegex(
                    ModelRegistryConfigurationError,
                    "is required",
                ):
                    registry.client_for(
                        DEPLOYMENT_A
                    )

                self.assertEqual(
                    token_factory.calls,
                    0,
                )

                self.assertEqual(
                    transport_factory.calls,
                    0,
                )

                self.assertEqual(
                    client_factory.calls,
                    [],
                )

    def test_invalid_numeric_configuration_fails_closed_without_defaulting(
        self,
    ) -> None:
        cases = [
            (
                "MODEL_SERVICE_TIMEOUT_SECONDS",
                "not-a-number",
            ),
            (
                "MODEL_SERVICE_TIMEOUT_SECONDS",
                "0",
            ),
            (
                "MODEL_SERVICE_TIMEOUT_SECONDS",
                "241",
            ),
            (
                (
                    "MODEL_SERVICE_EXPECTED_"
                    "BASELINE_THRESHOLD"
                ),
                "-0.1",
            ),
            (
                (
                    "MODEL_SERVICE_EXPECTED_"
                    "RING_THRESHOLD"
                ),
                "1.1",
            ),
            (
                (
                    "MODEL_SERVICE_EXPECTED_"
                    "PHANTOM_THRESHOLD"
                ),
                "nan",
            ),
        ]

        for name, value in cases:
            with self.subTest(
                name=name,
                value=value,
            ):
                environment = (
                    base_environment()
                )

                environment[name] = value

                (
                    registry,
                    token_factory,
                    transport_factory,
                    client_factory,
                ) = registry_for(
                    environment=environment
                )

                with self.assertRaises(
                    ModelRegistryConfigurationError
                ):
                    registry.client_for(
                        DEPLOYMENT_A
                    )

                self.assertEqual(
                    token_factory.calls,
                    0,
                )

                self.assertEqual(
                    transport_factory.calls,
                    0,
                )

                self.assertEqual(
                    client_factory.calls,
                    [],
                )

    def test_invalid_model_client_configuration_is_wrapped(
        self,
    ) -> None:
        cases = [
            (
                "MODEL_SERVICE_BASE_URL",
                "http://models.example",
            ),
            (
                (
                    "MODEL_SERVICE_"
                    "PSEUDONYMIZATION_KEY"
                ),
                "too-short",
            ),
            (
                "MODEL_SERVICE_ENDPOINT_PATH",
                "/v3/../unsafe",
            ),
        ]

        for name, value in cases:
            with self.subTest(
                name=name,
            ):
                environment = (
                    base_environment()
                )

                environment[name] = value

                registry, *_ = registry_for(
                    environment=environment
                )

                with self.assertRaisesRegex(
                    ModelRegistryConfigurationError,
                    "configuration is invalid",
                ):
                    registry.client_for(
                        DEPLOYMENT_A
                    )

    def test_token_and_transport_initialization_failures_are_wrapped(
        self,
    ) -> None:
        token_error = CountingFactory(
            error=RuntimeError(
                "credential failure"
            )
        )

        (
            registry,
            _token,
            transport,
            clients,
        ) = registry_for(
            token_factory=token_error
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "token provider",
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

        self.assertEqual(
            transport.calls,
            0,
        )

        self.assertEqual(
            clients.calls,
            [],
        )

        transport_error = (
            CountingFactory(
                error=RuntimeError(
                    "transport failure"
                )
            )
        )

        (
            registry,
            token,
            _transport,
            clients,
        ) = registry_for(
            transport_factory=(
                transport_error
            )
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "transport",
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

        self.assertEqual(
            token.calls,
            1,
        )

        self.assertEqual(
            clients.calls,
            [],
        )

    def test_client_factory_must_return_matching_model_service_client(
        self,
    ) -> None:
        class UnsupportedClientFactory:
            def __call__(
                self,
                **_kwargs,
            ):
                return object()

        registry, *_ = registry_for(
            client_factory=(
                UnsupportedClientFactory()
            )
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "unsupported model client",
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

        class MismatchedClientFactory:
            def __call__(
                self,
                **kwargs,
            ) -> ModelServiceClient:
                return ModelServiceClient(
                    **{
                        **kwargs,
                        "expectations": (
                            ModelServiceExpectations(
                                deployment_id=(
                                    DEPLOYMENT_B
                                )
                            )
                        ),
                    }
                )

        registry, *_ = registry_for(
            client_factory=(
                MismatchedClientFactory()
            )
        )

        with self.assertRaisesRegex(
            ModelRegistryConfigurationError,
            "does not match",
        ):
            registry.client_for(
                DEPLOYMENT_A
            )

    def test_invalid_factories_are_rejected_at_construction(
        self,
    ) -> None:
        arguments = [
            {
                "token_provider_factory":
                    None,
            },
            {
                "transport_factory":
                    None,
            },
            {
                "client_factory":
                    None,
            },
        ]

        for values in arguments:
            with self.subTest(
                values=values,
            ):
                with self.assertRaises(
                    ValueError
                ):
                    ModelDeploymentRegistry(
                        environment=(
                            base_environment()
                        ),
                        **values,
                    )
