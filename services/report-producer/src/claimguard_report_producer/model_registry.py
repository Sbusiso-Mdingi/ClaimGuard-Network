from __future__ import annotations

import hashlib
import math
import os
import re
import threading
from collections.abc import Callable, Iterable, Mapping

from .contract import ReportContractError
from .model_service import (
    DEFAULT_ENDPOINT_PATH,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
    AzureTokenProvider,
    ModelServiceClient,
    ModelServiceExpectations,
    UrllibModelTransport,
)


APPROVED_DEPLOYMENTS_ENV = (
    "MODEL_SERVICE_APPROVED_DEPLOYMENT_IDS"
)

PRIMARY_DEPLOYMENT_ENV = (
    "MODEL_SERVICE_DEPLOYMENT_ID"
)

_DEPLOYMENT_ID_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
)

_NON_ENVIRONMENT_CHARACTER = re.compile(
    r"[^A-Za-z0-9]+"
)


class ModelDeploymentNotApprovedError(
    ReportContractError
):
    code = "MODEL_DEPLOYMENT_NOT_APPROVED"


class ModelRegistryConfigurationError(
    RuntimeError
):
    code = "MODEL_REGISTRY_CONFIGURATION_INVALID"


def _required_text(
    value: object,
    *,
    field: str,
    maximum: int | None = None,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise ModelRegistryConfigurationError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise ModelRegistryConfigurationError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _deployment_id(
    value: object,
    *,
    error_type: type[Exception],
    field: str = "deployment_id",
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if (
        not rendered
        or not _DEPLOYMENT_ID_PATTERN.fullmatch(
            rendered
        )
    ):
        raise error_type(
            f"{field} is invalid."
        )

    return rendered


def deployment_environment_prefix(
    deployment_id: str,
) -> str:
    """
    Return a deterministic, collision-resistant
    environment-variable suffix for one exact
    deployment ID.

    Example:
      MODEL_SERVICE_BASE_URL_<returned suffix>
    """

    canonical = _deployment_id(
        deployment_id,
        error_type=(
            ModelRegistryConfigurationError
        ),
    )

    readable = (
        _NON_ENVIRONMENT_CHARACTER.sub(
            "_",
            canonical,
        )
        .strip("_")
        .upper()
    )

    digest = hashlib.sha256(
        canonical.encode(
            "utf-8"
        )
    ).hexdigest()[:12].upper()

    return (
        f"{readable[:64]}_{digest}"
    )


def _normalise_approved_deployments(
    values: Iterable[object],
) -> tuple[str, ...]:
    approved: list[str] = []
    seen: set[str] = set()

    for index, value in enumerate(
        values
    ):
        deployment_id = _deployment_id(
            value,
            error_type=(
                ModelRegistryConfigurationError
            ),
            field=(
                "approved deployment "
                f"at index {index}"
            ),
        )

        if deployment_id in seen:
            raise ModelRegistryConfigurationError(
                "Approved deployment IDs "
                "must not contain duplicates."
            )

        seen.add(
            deployment_id
        )

        approved.append(
            deployment_id
        )

    return tuple(
        approved
    )


def _approved_from_environment(
    environment: Mapping[str, str],
) -> tuple[str, ...]:
    configured_list = str(
        environment.get(
            APPROVED_DEPLOYMENTS_ENV,
            "",
        )
        or ""
    ).strip()

    primary = str(
        environment.get(
            PRIMARY_DEPLOYMENT_ENV,
            "",
        )
        or ""
    ).strip()

    if configured_list:
        raw_values = [
            value.strip()
            for value in configured_list.split(
                ","
            )
        ]

        if any(
            not value
            for value in raw_values
        ):
            raise ModelRegistryConfigurationError(
                f"{APPROVED_DEPLOYMENTS_ENV} "
                "contains an empty deployment ID."
            )

        approved = (
            _normalise_approved_deployments(
                raw_values
            )
        )

        if (
            primary
            and primary not in approved
        ):
            raise ModelRegistryConfigurationError(
                f"{PRIMARY_DEPLOYMENT_ENV} "
                "must be included in "
                f"{APPROVED_DEPLOYMENTS_ENV}."
            )

        return approved

    if primary:
        return (
            _normalise_approved_deployments(
                [
                    primary,
                ]
            )
        )

    return ()


def _deployment_value(
    environment: Mapping[str, str],
    deployment_id: str,
    name: str,
    *,
    default: str | None = None,
    required: bool = False,
) -> str:
    prefix = (
        deployment_environment_prefix(
            deployment_id
        )
    )

    override_name = (
        f"{name}_{prefix}"
    )

    if override_name in environment:
        value = str(
            environment[
                override_name
            ]
            or ""
        ).strip()

        if not value:
            raise ModelRegistryConfigurationError(
                f"{override_name} must not be empty."
            )

        return value

    if name in environment:
        value = str(
            environment[
                name
            ]
            or ""
        ).strip()

        if not value:
            raise ModelRegistryConfigurationError(
                f"{name} must not be empty."
            )

        return value

    if default is not None:
        return default

    if required:
        raise ModelRegistryConfigurationError(
            f"{name} is required for deployment "
            f"{deployment_id}."
        )

    return ""


def _deployment_float(
    environment: Mapping[str, str],
    deployment_id: str,
    name: str,
    *,
    default: str,
    minimum: float,
    maximum: float,
) -> float:
    rendered = _deployment_value(
        environment,
        deployment_id,
        name,
        default=default,
    )

    try:
        value = float(
            rendered
        )

    except (
        TypeError,
        ValueError,
    ) as error:
        raise ModelRegistryConfigurationError(
            f"{name} must be numeric for "
            f"deployment {deployment_id}."
        ) from error

    if (
        not math.isfinite(
            value
        )
        or not minimum
        <= value
        <= maximum
    ):
        raise ModelRegistryConfigurationError(
            f"{name} must be between "
            f"{minimum:g} and {maximum:g} "
            f"for deployment {deployment_id}."
        )

    return value


class ModelDeploymentRegistry:
    """
    Creates and caches one model-service client
    for each explicitly approved immutable
    deployment.

    Configuration is snapshotted during registry
    construction so environment changes cannot
    silently alter a deployment after startup.
    """

    def __init__(
        self,
        *,
        approved_deployment_ids: (
            Iterable[str] | None
        ) = None,
        environment: (
            Mapping[str, str] | None
        ) = None,
        token_provider_factory: (
            Callable[[], object]
        ) = AzureTokenProvider,
        transport_factory: (
            Callable[[], object]
        ) = UrllibModelTransport,
        client_factory: (
            Callable[..., ModelServiceClient]
        ) = ModelServiceClient,
    ) -> None:
        if not callable(
            token_provider_factory
        ):
            raise ValueError(
                "token_provider_factory "
                "must be callable."
            )

        if not callable(
            transport_factory
        ):
            raise ValueError(
                "transport_factory "
                "must be callable."
            )

        if not callable(
            client_factory
        ):
            raise ValueError(
                "client_factory must be callable."
            )

        self._environment = dict(
            os.environ
            if environment is None
            else environment
        )

        self._approved_deployment_ids = (
            _normalise_approved_deployments(
                approved_deployment_ids
            )
            if approved_deployment_ids
            is not None
            else _approved_from_environment(
                self._environment
            )
        )

        self._approved_deployment_set = (
            frozenset(
                self._approved_deployment_ids
            )
        )

        self._token_provider_factory = (
            token_provider_factory
        )

        self._transport_factory = (
            transport_factory
        )

        self._client_factory = (
            client_factory
        )

        self._cache: dict[
            str,
            ModelServiceClient,
        ] = {}

        self._lock = threading.Lock()

    @property
    def approved_deployment_ids(
        self,
    ) -> tuple[str, ...]:
        return (
            self._approved_deployment_ids
        )

    def _approved_deployment(
        self,
        deployment_id: object,
    ) -> str:
        try:
            canonical = _deployment_id(
                deployment_id,
                error_type=(
                    ModelDeploymentNotApprovedError
                ),
            )

        except ModelDeploymentNotApprovedError:
            raise

        if (
            canonical
            not in self
            ._approved_deployment_set
        ):
            raise ModelDeploymentNotApprovedError(
                "The pinned model deployment "
                f"{canonical} is not approved "
                "for this worker."
            )

        return canonical

    def _build_client(
        self,
        deployment_id: str,
    ) -> ModelServiceClient:
        base_url = _deployment_value(
            self._environment,
            deployment_id,
            "MODEL_SERVICE_BASE_URL",
            required=True,
        )

        audience = _deployment_value(
            self._environment,
            deployment_id,
            "MODEL_SERVICE_AUDIENCE",
            required=True,
        )

        pseudonymization_key = (
            _deployment_value(
                self._environment,
                deployment_id,
                (
                    "MODEL_SERVICE_"
                    "PSEUDONYMIZATION_KEY"
                ),
                required=True,
            )
        )

        endpoint_path = (
            _deployment_value(
                self._environment,
                deployment_id,
                "MODEL_SERVICE_ENDPOINT_PATH",
                default=(
                    DEFAULT_ENDPOINT_PATH
                ),
            )
        )

        expectations = (
            ModelServiceExpectations(
                deployment_id=(
                    deployment_id
                ),
                ensemble_id=(
                    _deployment_value(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "ENSEMBLE_ID"
                        ),
                        default=ENSEMBLE_ID,
                    )
                ),
                ensemble_version=(
                    _deployment_value(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "ENSEMBLE_VERSION"
                        ),
                        default=(
                            ENSEMBLE_VERSION
                        ),
                    )
                ),
                feature_schema_version=(
                    _deployment_value(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "FEATURE_SCHEMA_VERSION"
                        ),
                        default=(
                            FEATURE_SCHEMA_VERSION
                        ),
                    )
                ),
                baseline_threshold=(
                    _deployment_float(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "BASELINE_THRESHOLD"
                        ),
                        default=(
                            "0.08760971001434723"
                        ),
                        minimum=0,
                        maximum=1,
                    )
                ),
                ring_threshold=(
                    _deployment_float(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "RING_THRESHOLD"
                        ),
                        default="0.148",
                        minimum=0,
                        maximum=1,
                    )
                ),
                phantom_threshold=(
                    _deployment_float(
                        self._environment,
                        deployment_id,
                        (
                            "MODEL_SERVICE_EXPECTED_"
                            "PHANTOM_THRESHOLD"
                        ),
                        default=(
                            "0.8138303120761656"
                        ),
                        minimum=0,
                        maximum=1,
                    )
                ),
            )
        )

        timeout_seconds = (
            _deployment_float(
                self._environment,
                deployment_id,
                (
                    "MODEL_SERVICE_"
                    "TIMEOUT_SECONDS"
                ),
                default="120",
                minimum=1,
                maximum=240,
            )
        )

        try:
            token_provider = (
                self
                ._token_provider_factory()
            )

        except Exception as error:
            raise ModelRegistryConfigurationError(
                "The model-service token "
                "provider could not be initialized."
            ) from error

        try:
            transport = (
                self
                ._transport_factory()
            )

        except Exception as error:
            raise ModelRegistryConfigurationError(
                "The model-service transport "
                "could not be initialized."
            ) from error

        try:
            client = self._client_factory(
                base_url=base_url,
                audience=audience,
                pseudonymization_key=(
                    pseudonymization_key
                ),
                expectations=expectations,
                token_provider=(
                    token_provider
                ),
                transport=transport,
                timeout_seconds=(
                    timeout_seconds
                ),
                endpoint_path=(
                    endpoint_path
                ),
            )

        except (
            ModelRegistryConfigurationError,
            ModelDeploymentNotApprovedError,
        ):
            raise

        except Exception as error:
            raise ModelRegistryConfigurationError(
                "Model-service configuration "
                f"is invalid for deployment "
                f"{deployment_id}: {error}"
            ) from error

        if not isinstance(
            client,
            ModelServiceClient,
        ):
            raise ModelRegistryConfigurationError(
                "client_factory returned an "
                "unsupported model client."
            )

        if (
            client.expectations
            .deployment_id
            != deployment_id
        ):
            raise ModelRegistryConfigurationError(
                "The constructed model client "
                "does not match its approved "
                "deployment."
            )

        return client

    def client_for(
        self,
        deployment_id: str,
    ) -> ModelServiceClient:
        canonical = (
            self._approved_deployment(
                deployment_id
            )
        )

        with self._lock:
            existing = self._cache.get(
                canonical
            )

            if existing is not None:
                return existing

            client = self._build_client(
                canonical
            )

            self._cache[
                canonical
            ] = client

            return client
