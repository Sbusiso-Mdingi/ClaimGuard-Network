from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Protocol
from urllib.parse import urlparse

if TYPE_CHECKING:
    from .snapshot import ProspectiveScoringSnapshot


REQUEST_SCHEMA_VERSION = "claimguard.claim-screening-request.v3"
RESPONSE_SCHEMA_VERSION = "claimguard.claim-screening-response.v3"
FEATURE_SCHEMA_VERSION = "claim-feature-schema-2026.2"
ANALYSIS_MODE = "PROSPECTIVE_CLAIM_SCREENING"
ENSEMBLE_ID = "claimguard-claim-fraud-ensemble"
ENSEMBLE_VERSION = "1.1.0"

DEFAULT_ENDPOINT_PATH = "/v3/claim-screening"
MAX_REVIEW_CLAIMS = 10_000
MAX_MODEL_RESPONSE_BYTES = 5 * 1024 * 1024

_DEPLOYMENT_ID = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
)

_ENDPOINT_PATH = re.compile(
    r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$"
)


class ModelServiceUnavailable(RuntimeError):
    code = "MODEL_SERVICE_UNAVAILABLE"

    def __init__(
        self,
        message: str = (
            "The approved model service is unavailable."
        ),
        *,
        watermark: str | None = None,
    ) -> None:
        super().__init__(message)
        self.watermark = watermark


class ModelServiceContractError(
    ModelServiceUnavailable
):
    code = "MODEL_SERVICE_CONTRACT_ERROR"


@dataclass(frozen=True)
class ModelServiceExpectations:
    deployment_id: str
    ensemble_id: str = ENSEMBLE_ID
    ensemble_version: str = ENSEMBLE_VERSION
    feature_schema_version: str = FEATURE_SCHEMA_VERSION
    baseline_threshold: float = (
        0.08760971001434723
    )
    ring_threshold: float = 0.148
    phantom_threshold: float = (
        0.8138303120761656
    )

    def __post_init__(self) -> None:
        if not _DEPLOYMENT_ID.fullmatch(
            self.deployment_id
        ):
            raise ValueError(
                "MODEL_SERVICE_DEPLOYMENT_ID is invalid."
            )

        for name, value in (
            ("ensemble ID", self.ensemble_id),
            (
                "ensemble version",
                self.ensemble_version,
            ),
            (
                "feature schema version",
                self.feature_schema_version,
            ),
        ):
            if (
                not isinstance(value, str)
                or not value.strip()
            ):
                raise ValueError(
                    f"The expected {name} is required."
                )

        for name, value in (
            (
                "baseline",
                self.baseline_threshold,
            ),
            ("ring", self.ring_threshold),
            (
                "phantom",
                self.phantom_threshold,
            ),
        ):
            if (
                not math.isfinite(value)
                or not 0 <= value <= 1
            ):
                raise ValueError(
                    f"The expected {name} threshold "
                    "is invalid."
                )


@dataclass(frozen=True)
class ClaimReviewResult:
    claim_id: str
    claim_version: int
    baseline_fraud_probability: float
    baseline_predicted_class: str
    baseline_threshold: float
    ring_probability: float
    ring_review_hit: bool
    ring_threshold: float
    phantom_probability: float
    phantom_review_hit: bool
    phantom_threshold: float
    composite_review_recommended: bool


@dataclass(frozen=True)
class ReviewWindowResult:
    deployment_id: str
    ensemble_id: str
    ensemble_version: str
    feature_schema_version: str
    analysis_mode: str
    request_id: str
    watermark: str
    scores: tuple[ClaimReviewResult, ...]


@dataclass(frozen=True)
class ModelHttpResponse:
    status: int
    body: bytes


@dataclass(frozen=True)
class _ClaimTarget:
    claim_id: str
    claim_version: int


class TokenProvider(Protocol):
    def get_token(
        self,
        audience: str,
    ) -> str: ...


class ModelTransport(Protocol):
    def post(
        self,
        *,
        url: str,
        body: bytes,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> ModelHttpResponse: ...


class AzureTokenProvider:
    def __init__(self) -> None:
        from azure.identity import (
            DefaultAzureCredential,
        )

        self._credential = (
            DefaultAzureCredential()
        )

    def get_token(
        self,
        audience: str,
    ) -> str:
        scope = (
            audience
            if audience.endswith("/.default")
            else (
                f"{audience.rstrip('/')}"
                "/.default"
            )
        )

        return self._credential.get_token(
            scope
        ).token


class _NoRedirectHandler(
    urllib.request.HTTPRedirectHandler
):
    def redirect_request(
        self,
        req,
        fp,
        code,
        msg,
        headers,
        newurl,
    ):
        return None


class UrllibModelTransport:
    def __init__(self) -> None:
        self._opener = (
            urllib.request.build_opener(
                _NoRedirectHandler()
            )
        )

    def post(
        self,
        *,
        url: str,
        body: bytes,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> ModelHttpResponse:
        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with self._opener.open(
                request,
                timeout=timeout_seconds,
            ) as response:
                response_body = response.read(
                    MAX_MODEL_RESPONSE_BYTES + 1
                )

                if (
                    len(response_body)
                    > MAX_MODEL_RESPONSE_BYTES
                ):
                    raise RuntimeError(
                        "The model response exceeded "
                        "the size limit."
                    )

                return ModelHttpResponse(
                    status=int(response.status),
                    body=response_body,
                )

        except urllib.error.HTTPError as error:
            response_body = error.read(
                MAX_MODEL_RESPONSE_BYTES + 1
            )

            if (
                len(response_body)
                > MAX_MODEL_RESPONSE_BYTES
            ):
                response_body = b""

            return ModelHttpResponse(
                status=int(error.code),
                body=response_body,
            )


def _positive_float(
    value: str | None,
    default: float,
) -> float:
    try:
        parsed = (
            float(value)
            if value is not None
            else default
        )
    except (TypeError, ValueError):
        return default

    return (
        parsed
        if math.isfinite(parsed)
        and parsed > 0
        else default
    )


def _probability_environment(
    name: str,
    default: float,
) -> float:
    raw_value = os.environ.get(name)

    try:
        value = (
            float(raw_value)
            if raw_value is not None
            else default
        )
    except ValueError as error:
        raise ValueError(
            f"{name} must be a finite probability."
        ) from error

    if (
        not math.isfinite(value)
        or not 0 <= value <= 1
    ):
        raise ValueError(
            f"{name} must be a finite probability."
        )

    return value


def _required_environment(
    name: str,
) -> str:
    value = os.environ.get(
        name,
        "",
    ).strip()

    if not value:
        raise ValueError(
            f"{name} is required for the "
            "approved model strategy."
        )

    return value


def _validated_endpoint_path(
    value: str | None,
) -> str:
    path = str(
        value or DEFAULT_ENDPOINT_PATH
    ).strip()

    if (
        not _ENDPOINT_PATH.fullmatch(path)
        or "//" in path
        or ".." in path
        or path.endswith("/")
    ):
        raise ValueError(
            "MODEL_SERVICE_ENDPOINT_PATH "
            "is invalid."
        )

    return path


def _decimal_string(
    value: object,
    *,
    field: str,
    places: str,
    watermark: str,
) -> str:
    try:
        amount = Decimal(
            str(value)
        ).quantize(
            Decimal(places)
        )
    except (
        InvalidOperation,
        TypeError,
        ValueError,
    ) as error:
        raise ModelServiceContractError(
            f"Snapshot {field} is invalid.",
            watermark=watermark,
        ) from error

    if (
        not amount.is_finite()
        or amount <= 0
    ):
        raise ModelServiceContractError(
            f"Snapshot {field} is outside "
            "the model domain.",
            watermark=watermark,
        )

    return format(
        amount,
        "f",
    )


def _text(
    value: object,
    field: str,
    watermark: str,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise ModelServiceContractError(
            f"Snapshot {field} is required "
            "by the model contract.",
            watermark=watermark,
        )

    return rendered


def _date_text(
    value: object,
    field: str,
    watermark: str,
) -> str:
    rendered = (
        value.isoformat()
        if hasattr(value, "isoformat")
        else str(value or "")
    )

    try:
        return date.fromisoformat(
            rendered
        ).isoformat()

    except ValueError as error:
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "an ISO calendar date.",
            watermark=watermark,
        ) from error


def _timestamp_text(
    value: object,
    field: str,
    watermark: str,
) -> str:
    rendered = (
        value.isoformat()
        if hasattr(value, "isoformat")
        else str(value or "").strip()
    )

    if not rendered:
        raise ModelServiceContractError(
            f"Snapshot {field} is required "
            "by the model contract.",
            watermark=watermark,
        )

    try:
        parsed = datetime.fromisoformat(
            rendered.replace(
                "Z",
                "+00:00",
            )
        )
    except ValueError as error:
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "an ISO timestamp.",
            watermark=watermark,
        ) from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    ).isoformat()


def _positive_integer(
    value: object,
    field: str,
    watermark: str,
) -> int:
    if isinstance(value, bool):
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "a positive integer.",
            watermark=watermark,
        )

    try:
        parsed = int(value)
    except (
        TypeError,
        ValueError,
    ) as error:
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "a positive integer.",
            watermark=watermark,
        ) from error

    if (
        parsed <= 0
        or (
            isinstance(value, float)
            and not value.is_integer()
        )
    ):
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "a positive integer.",
            watermark=watermark,
        )

    return parsed


def _snapshot_boolean(
    value: object,
    field: str,
    watermark: str,
) -> bool:
    if not isinstance(value, bool):
        raise ModelServiceContractError(
            f"Snapshot {field} must be "
            "a boolean.",
            watermark=watermark,
        )

    return value


def _exact_mapping(
    value: object,
    *,
    expected_keys: frozenset[str],
    path: str,
    watermark: str,
) -> dict[str, object]:
    if (
        not isinstance(value, dict)
        or frozenset(value) != expected_keys
    ):
        raise ModelServiceContractError(
            f"The model response {path} "
            "contract is incompatible.",
            watermark=watermark,
        )

    return value


def _probability(
    value: object,
    path: str,
    watermark: str,
) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(
            value,
            (int, float),
        )
    ):
        raise ModelServiceContractError(
            f"The model response {path} "
            "is invalid.",
            watermark=watermark,
        )

    result = float(value)

    if (
        not math.isfinite(result)
        or not 0 <= result <= 1
    ):
        raise ModelServiceContractError(
            f"The model response {path} "
            "is invalid.",
            watermark=watermark,
        )

    return result


def _boolean(
    value: object,
    path: str,
    watermark: str,
) -> bool:
    if not isinstance(value, bool):
        raise ModelServiceContractError(
            f"The model response {path} "
            "is invalid.",
            watermark=watermark,
        )

    return value


def _json_safe(
    value: object,
    *,
    path: str,
    watermark: str,
) -> object:
    if (
        value is None
        or isinstance(
            value,
            (str, bool, int),
        )
    ):
        return value

    if isinstance(value, float):
        if not math.isfinite(value):
            raise ModelServiceContractError(
                f"Snapshot {path} contains "
                "a non-finite number.",
                watermark=watermark,
            )

        return value

    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ModelServiceContractError(
                f"Snapshot {path} contains "
                "a non-finite number.",
                watermark=watermark,
            )

        return format(
            value,
            "f",
        )

    if isinstance(value, datetime):
        return _timestamp_text(
            value,
            path,
            watermark,
        )

    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, dict):
        normalized: dict[
            str,
            object,
        ] = {}

        for key, item in value.items():
            if (
                not isinstance(key, str)
                or not key.strip()
            ):
                raise ModelServiceContractError(
                    f"Snapshot {path} contains "
                    "an invalid key.",
                    watermark=watermark,
                )

            normalized[key] = _json_safe(
                item,
                path=f"{path}.{key}",
                watermark=watermark,
            )

        return normalized

    if isinstance(
        value,
        (list, tuple),
    ):
        return [
            _json_safe(
                item,
                path=(
                    f"{path}[{index}]"
                ),
                watermark=watermark,
            )
            for index, item
            in enumerate(value)
        ]

    raise ModelServiceContractError(
        f"Snapshot {path} contains "
        "an unsupported value.",
        watermark=watermark,
    )


class ModelServiceClient:
    def __init__(
        self,
        *,
        base_url: str,
        audience: str,
        pseudonymization_key: str,
        expectations: ModelServiceExpectations,
        token_provider: TokenProvider,
        transport: ModelTransport,
        timeout_seconds: float = 120,
        endpoint_path: str = (
            DEFAULT_ENDPOINT_PATH
        ),
    ) -> None:
        parsed = urlparse(
            base_url
        )

        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.path not in {"", "/"}
        ):
            raise ValueError(
                "MODEL_SERVICE_BASE_URL must "
                "be an HTTPS origin."
            )

        if (
            parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "MODEL_SERVICE_BASE_URL must "
                "not contain credentials or "
                "query data."
            )

        if not audience.strip():
            raise ValueError(
                "MODEL_SERVICE_AUDIENCE "
                "is required."
            )

        if (
            len(
                pseudonymization_key.encode(
                    "utf-8"
                )
            )
            < 32
        ):
            raise ValueError(
                "MODEL_SERVICE_PSEUDONYMIZATION_KEY "
                "must contain at least 32 bytes."
            )

        if (
            not math.isfinite(
                timeout_seconds
            )
            or not 1
            <= timeout_seconds
            <= 240
        ):
            raise ValueError(
                "Model-service timeout must "
                "be between 1 and 240 seconds."
            )

        self.endpoint_url = (
            f"{base_url.rstrip('/')}"
            f"{_validated_endpoint_path(endpoint_path)}"
        )

        self.audience = audience.strip()

        self.pseudonymization_key = (
            pseudonymization_key.encode(
                "utf-8"
            )
        )

        self.expectations = expectations
        self.token_provider = token_provider
        self.transport = transport
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_environment(
        cls,
    ) -> "ModelServiceClient":
        return cls(
            base_url=_required_environment(
                "MODEL_SERVICE_BASE_URL"
            ),
            audience=_required_environment(
                "MODEL_SERVICE_AUDIENCE"
            ),
            pseudonymization_key=(
                _required_environment(
                    "MODEL_SERVICE_PSEUDONYMIZATION_KEY"
                )
            ),
            expectations=(
                ModelServiceExpectations(
                    deployment_id=(
                        _required_environment(
                            "MODEL_SERVICE_DEPLOYMENT_ID"
                        )
                    ),
                    ensemble_id=(
                        os.environ.get(
                            "MODEL_SERVICE_EXPECTED_ENSEMBLE_ID",
                            ENSEMBLE_ID,
                        ).strip()
                    ),
                    ensemble_version=(
                        os.environ.get(
                            "MODEL_SERVICE_EXPECTED_ENSEMBLE_VERSION",
                            ENSEMBLE_VERSION,
                        ).strip()
                    ),
                    feature_schema_version=(
                        os.environ.get(
                            "MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION",
                            FEATURE_SCHEMA_VERSION,
                        ).strip()
                    ),
                    baseline_threshold=(
                        _probability_environment(
                            "MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD",
                            0.08760971001434723,
                        )
                    ),
                    ring_threshold=(
                        _probability_environment(
                            "MODEL_SERVICE_EXPECTED_RING_THRESHOLD",
                            0.148,
                        )
                    ),
                    phantom_threshold=(
                        _probability_environment(
                            "MODEL_SERVICE_EXPECTED_PHANTOM_THRESHOLD",
                            0.8138303120761656,
                        )
                    ),
                )
            ),
            token_provider=(
                AzureTokenProvider()
            ),
            transport=(
                UrllibModelTransport()
            ),
            timeout_seconds=(
                _positive_float(
                    os.environ.get(
                        "MODEL_SERVICE_TIMEOUT_SECONDS"
                    ),
                    120,
                )
            ),
            endpoint_path=(
                _validated_endpoint_path(
                    os.environ.get(
                        "MODEL_SERVICE_ENDPOINT_PATH"
                    )
                )
            ),
        )

    def _token(
        self,
        tenant_id: str,
        kind: str,
        value: object,
        *,
        watermark: str | None = None,
    ) -> str:
        rendered = str(
            value or ""
        ).strip()

        if not rendered:
            raise ModelServiceContractError(
                f"Snapshot {kind} identifier "
                "is required.",
                watermark=watermark,
            )

        digest = hmac.new(
            self.pseudonymization_key,
            (
                f"{tenant_id}\0"
                f"{kind}\0"
                f"{rendered}"
            ).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        return f"{kind}-{digest}"

    def _target_token(
        self,
        snapshot: (
            "ProspectiveScoringSnapshot"
        ),
        claim_id: str,
        claim_version: int,
        *,
        watermark: str,
    ) -> str:
        return self._token(
            snapshot.tenant_id,
            "claim-version",
            (
                f"{claim_id}:"
                f"{claim_version}"
            ),
            watermark=watermark,
        )

    def _map_target_claims(
        self,
        snapshot: (
            "ProspectiveScoringSnapshot"
        ),
        *,
        watermark: str,
    ) -> tuple[
        list[dict[str, object]],
        dict[str, _ClaimTarget],
    ]:
        providers = {
            str(
                item.get(
                    "provider_id"
                )
                or ""
            ): item
            for item in snapshot.providers
        }

        claim_token_to_target: dict[
            str,
            _ClaimTarget,
        ] = {}

        mapped_claims: list[
            dict[str, object]
        ] = []

        sorted_claims = sorted(
            snapshot.target_claims,
            key=lambda item: (
                str(
                    item.get(
                        "claim_id"
                    )
                    or ""
                ),
                str(
                    item.get(
                        "claim_version"
                    )
                    or ""
                ),
            ),
        )

        for claim in sorted_claims:
            claim_id = _text(
                claim.get(
                    "claim_id"
                ),
                "claim_id",
                watermark,
            )

            claim_version = (
                _positive_integer(
                    claim.get(
                        "claim_version"
                    ),
                    "claim_version",
                    watermark,
                )
            )

            provider_id = _text(
                claim.get(
                    "provider_id"
                ),
                "provider_id",
                watermark,
            )

            provider = providers.get(
                provider_id
            )

            if provider is None:
                raise ModelServiceContractError(
                    "A target claim billing "
                    "provider is absent from "
                    "the snapshot.",
                    watermark=watermark,
                )

            claim_token = (
                self._target_token(
                    snapshot,
                    claim_id,
                    claim_version,
                    watermark=watermark,
                )
            )

            if (
                claim_token
                in claim_token_to_target
            ):
                raise ModelServiceContractError(
                    "The prospective snapshot "
                    "contains duplicate claim "
                    "versions.",
                    watermark=watermark,
                )

            claim_token_to_target[
                claim_token
            ] = _ClaimTarget(
                claim_id=claim_id,
                claim_version=(
                    claim_version
                ),
            )

            rendering_id = claim.get(
                "rendering_practitioner_id"
            )

            rendering_token = (
                self._token(
                    snapshot.tenant_id,
                    "rendering",
                    rendering_id,
                    watermark=watermark,
                )
                if (
                    rendering_id is not None
                    and str(
                        rendering_id
                    ).strip()
                )
                else None
            )

            rendering_category = _text(
                claim.get(
                    "rendering_practitioner_category"
                ),
                (
                    "rendering_"
                    "practitioner_category"
                ),
                watermark,
            )

            rendering_known = (
                _snapshot_boolean(
                    claim.get(
                        "rendering_known_to_"
                        "billing_provider"
                    ),
                    (
                        "rendering_known_to_"
                        "billing_provider"
                    ),
                    watermark,
                )
            )

            if (
                rendering_token is None
                and (
                    rendering_category
                    != "NONE"
                    or rendering_known
                )
            ):
                raise ModelServiceContractError(
                    "Rendering-practitioner "
                    "facts are internally "
                    "inconsistent.",
                    watermark=watermark,
                )

            if (
                rendering_token is not None
                and rendering_category
                == "NONE"
            ):
                raise ModelServiceContractError(
                    "Rendering-practitioner "
                    "facts are internally "
                    "inconsistent.",
                    watermark=watermark,
                )

            mapped_claims.append(
                {
                    "claimId": claim_token,
                    "claimVersion": (
                        claim_version
                    ),
                    "memberKey": (
                        self._token(
                            snapshot.tenant_id,
                            "member",
                            claim.get(
                                "member_id"
                            ),
                            watermark=watermark,
                        )
                    ),
                    "billingProviderKey": (
                        self._token(
                            snapshot.tenant_id,
                            "provider",
                            provider_id,
                            watermark=watermark,
                        )
                    ),
                    (
                        "rendering"
                        "PractitionerKey"
                    ): rendering_token,
                    "serviceDate": (
                        _date_text(
                            claim.get(
                                "service_date"
                            ),
                            "service_date",
                            watermark,
                        )
                    ),
                    "receivedDate": (
                        _date_text(
                            claim.get(
                                "received_date"
                            ),
                            "received_date",
                            watermark,
                        )
                    ),
                    "claimedAmount": (
                        _decimal_string(
                            claim.get(
                                "amount"
                            ),
                            field="amount",
                            places="0.01",
                            watermark=watermark,
                        )
                    ),
                    "quantity": (
                        _decimal_string(
                            claim.get(
                                "quantity"
                            ),
                            field="quantity",
                            places="0.001",
                            watermark=watermark,
                        )
                    ),
                    "benefitOption": (
                        _text(
                            claim.get(
                                "benefit_option"
                            ),
                            "benefit_option",
                            watermark,
                        )
                    ),
                    "networkType": (
                        _text(
                            claim.get(
                                "network_type"
                            ),
                            "network_type",
                            watermark,
                        )
                    ),
                    "lineType": (
                        _text(
                            claim.get(
                                "line_type"
                            ),
                            "line_type",
                            watermark,
                        )
                    ),
                    "billingCode": (
                        _text(
                            claim.get(
                                "billing_code"
                            ),
                            "billing_code",
                            watermark,
                        )
                    ),
                    "tariffDiscipline": (
                        _text(
                            claim.get(
                                "tariff_discipline"
                            ),
                            "tariff_discipline",
                            watermark,
                        )
                    ),
                    "diagnosisCode": (
                        _text(
                            claim.get(
                                "diagnosis_code"
                            ),
                            "diagnosis_code",
                            watermark,
                        )
                    ),
                    "billingProviderKind": (
                        _text(
                            provider.get(
                                "provider_kind"
                            ),
                            "provider_kind",
                            watermark,
                        )
                    ),
                    (
                        "billingProvider"
                        "Category"
                    ): (
                        _text(
                            provider.get(
                                "provider_category"
                            ),
                            "provider_category",
                            watermark,
                        )
                    ),
                    (
                        "rendering"
                        "PractitionerCategory"
                    ): rendering_category,
                    (
                        "renderingKnownTo"
                        "BillingProvider"
                    ): rendering_known,
                }
            )

        return (
            mapped_claims,
            claim_token_to_target,
        )

    def _map_context_features(
        self,
        snapshot: (
            "ProspectiveScoringSnapshot"
        ),
        *,
        claim_token_to_target: dict[
            str,
            _ClaimTarget,
        ],
        watermark: str,
    ) -> dict[str, object]:
        raw_context = getattr(
            snapshot,
            "context_features",
            None,
        )

        if raw_context in (
            None,
            [],
        ):
            return {
                "schemaVersion": (
                    self.expectations
                    .feature_schema_version
                ),
                "targets": [
                    {
                        "claimId": (
                            claim_token
                        ),
                        "claimVersion": (
                            target.claim_version
                        ),
                        "features": {},
                    }
                    for (
                        claim_token,
                        target,
                    )
                    in (
                        claim_token_to_target
                        .items()
                    )
                ],
            }

        if not isinstance(
            raw_context,
            list,
        ):
            raise ModelServiceContractError(
                "Snapshot context_features "
                "must be an array.",
                watermark=watermark,
            )

        expected_refs = {
            (
                target.claim_id,
                target.claim_version,
            )
            for target
            in claim_token_to_target.values()
        }

        context_by_ref: dict[
            tuple[str, int],
            dict[str, object],
        ] = {}

        for index, entry in enumerate(
            raw_context
        ):
            if not isinstance(
                entry,
                dict,
            ):
                raise ModelServiceContractError(
                    (
                        "Snapshot "
                        f"context_features[{index}] "
                        "must be an object."
                    ),
                    watermark=watermark,
                )

            if frozenset(entry) != {
                "claim_id",
                "claim_version",
                "features",
            }:
                raise ModelServiceContractError(
                    (
                        "Snapshot "
                        f"context_features[{index}] "
                        "has an incompatible "
                        "shape."
                    ),
                    watermark=watermark,
                )

            claim_id = _text(
                entry.get(
                    "claim_id"
                ),
                (
                    f"context_features"
                    f"[{index}].claim_id"
                ),
                watermark,
            )

            claim_version = (
                _positive_integer(
                    entry.get(
                        "claim_version"
                    ),
                    (
                        f"context_features"
                        f"[{index}]"
                        ".claim_version"
                    ),
                    watermark,
                )
            )

            reference = (
                claim_id,
                claim_version,
            )

            if (
                reference not in expected_refs
                or reference
                in context_by_ref
            ):
                raise ModelServiceContractError(
                    "Snapshot context feature "
                    "coverage is incompatible.",
                    watermark=watermark,
                )

            features = entry.get(
                "features"
            )

            if not isinstance(
                features,
                dict,
            ):
                raise ModelServiceContractError(
                    (
                        "Snapshot "
                        f"context_features[{index}]"
                        ".features must be "
                        "an object."
                    ),
                    watermark=watermark,
                )

            if (
                "claims" in features
                or "historicalClaims"
                in features
            ):
                raise ModelServiceContractError(
                    "Raw historical claims are "
                    "not allowed in context "
                    "features.",
                    watermark=watermark,
                )

            normalized = _json_safe(
                features,
                path=(
                    f"context_features"
                    f"[{index}].features"
                ),
                watermark=watermark,
            )

            if not isinstance(
                normalized,
                dict,
            ):
                raise ModelServiceContractError(
                    "Snapshot context features "
                    "are invalid.",
                    watermark=watermark,
                )

            context_by_ref[
                reference
            ] = normalized

        if (
            set(context_by_ref)
            != expected_refs
        ):
            raise ModelServiceContractError(
                "Snapshot context feature "
                "coverage is incomplete.",
                watermark=watermark,
            )

        return {
            "schemaVersion": (
                self.expectations
                .feature_schema_version
            ),
            "targets": [
                {
                    "claimId": claim_token,
                    "claimVersion": (
                        target.claim_version
                    ),
                    "features": (
                        context_by_ref[
                            (
                                target.claim_id,
                                target.claim_version,
                            )
                        ]
                    ),
                }
                for (
                    claim_token,
                    target,
                )
                in (
                    claim_token_to_target
                    .items()
                )
            ],
        }

    def _request(
        self,
        snapshot: (
            "ProspectiveScoringSnapshot"
        ),
    ) -> tuple[
        dict[str, object],
        dict[str, _ClaimTarget],
    ]:
        watermark = _text(
            snapshot.watermark,
            "watermark",
            "",
        )

        if not isinstance(
            snapshot.target_claims,
            list,
        ):
            raise ModelServiceContractError(
                "Snapshot target_claims "
                "must be an array.",
                watermark=watermark,
            )

        if not (
            1
            <= len(
                snapshot.target_claims
            )
            <= MAX_REVIEW_CLAIMS
        ):
            raise ModelServiceContractError(
                "The prospective scoring "
                "request contains an "
                "unsupported target count.",
                watermark=watermark,
            )

        if (
            snapshot.model_deployment_id
            != self.expectations.deployment_id
        ):
            raise ModelServiceContractError(
                "The pinned model deployment "
                "is not approved by this "
                "client.",
                watermark=watermark,
            )

        (
            mapped_targets,
            claim_token_to_target,
        ) = self._map_target_claims(
            snapshot,
            watermark=watermark,
        )

        context_features = (
            self._map_context_features(
                snapshot,
                claim_token_to_target=(
                    claim_token_to_target
                ),
                watermark=watermark,
            )
        )

        context_cutoff = getattr(
            snapshot,
            "context_cutoff_at",
            snapshot.captured_at,
        )

        request_without_id: dict[
            str,
            object,
        ] = {
            "schemaVersion": (
                REQUEST_SCHEMA_VERSION
            ),
            "featureSchemaVersion": (
                self.expectations
                .feature_schema_version
            ),
            "deploymentId": (
                self.expectations
                .deployment_id
            ),
            "tenantId": self._token(
                snapshot.tenant_id,
                "tenant",
                snapshot.tenant_id,
                watermark=watermark,
            ),
            "analysisMode": ANALYSIS_MODE,
            "window": {
                "capturedAt": (
                    _timestamp_text(
                        snapshot.captured_at,
                        "captured_at",
                        watermark,
                    )
                ),
                "contextCutoffAt": (
                    _timestamp_text(
                        context_cutoff,
                        "context_cutoff_at",
                        watermark,
                    )
                ),
                "watermark": watermark,
            },
            "targetClaims": (
                mapped_targets
            ),
            "contextFeatures": (
                context_features
            ),
        }

        request_digest = (
            hashlib.sha256(
                json.dumps(
                    request_without_id,
                    sort_keys=True,
                    separators=(
                        ",",
                        ":",
                    ),
                ).encode("utf-8")
            ).hexdigest()
        )

        return (
            {
                **request_without_id,
                "requestId": (
                    f"screen-"
                    f"{request_digest}"
                ),
            },
            claim_token_to_target,
        )

    def review(
        self,
        snapshot: (
            "ProspectiveScoringSnapshot"
        ),
    ) -> ReviewWindowResult:
        (
            request,
            claim_token_to_target,
        ) = self._request(
            snapshot
        )

        window = request.get(
            "window"
        )

        if not isinstance(
            window,
            dict,
        ):
            raise ModelServiceContractError(
                "The internal request window "
                "is invalid.",
                watermark=(
                    str(
                        snapshot.watermark
                        or ""
                    )
                    or None
                ),
            )

        watermark = str(
            window["watermark"]
        )

        request_id = str(
            request["requestId"]
        )

        try:
            access_token = (
                self.token_provider
                .get_token(
                    self.audience
                )
            )

            if not access_token:
                raise ModelServiceUnavailable(
                    "The workload identity did "
                    "not return an access token.",
                    watermark=watermark,
                )

            response = self.transport.post(
                url=self.endpoint_url,
                body=json.dumps(
                    request,
                    sort_keys=True,
                    separators=(
                        ",",
                        ":",
                    ),
                ).encode("utf-8"),
                headers={
                    "Accept": (
                        "application/json"
                    ),
                    "Authorization": (
                        "Bearer "
                        f"{access_token}"
                    ),
                    "Content-Type": (
                        "application/json"
                    ),
                    "x-request-id": (
                        request_id
                    ),
                },
                timeout_seconds=(
                    self.timeout_seconds
                ),
            )

        except ModelServiceUnavailable:
            raise

        except Exception as error:
            raise ModelServiceUnavailable(
                watermark=watermark,
            ) from error

        if response.status != 200:
            raise ModelServiceUnavailable(
                "The approved model service "
                "returned HTTP "
                f"{response.status}.",
                watermark=watermark,
            )

        if (
            len(response.body)
            > MAX_MODEL_RESPONSE_BYTES
        ):
            raise ModelServiceContractError(
                "The model response exceeded "
                "the size limit.",
                watermark=watermark,
            )

        try:
            payload = json.loads(
                response.body.decode(
                    "utf-8"
                ),
                parse_constant=(
                    lambda value: (
                        _ for _ in ()
                    ).throw(
                        ValueError(value)
                    )
                ),
            )

        except (
            UnicodeDecodeError,
            json.JSONDecodeError,
            ValueError,
        ) as error:
            raise ModelServiceContractError(
                "The model response is not "
                "valid finite JSON.",
                watermark=watermark,
            ) from error

        root = _exact_mapping(
            payload,
            expected_keys=frozenset(
                {
                    "schemaVersion",
                    "featureSchemaVersion",
                    "deploymentId",
                    "ensembleId",
                    "ensembleVersion",
                    "analysisMode",
                    "tenantId",
                    "requestId",
                    "windowWatermark",
                    "scores",
                }
            ),
            path="root",
            watermark=watermark,
        )

        expected_root = {
            "schemaVersion": (
                RESPONSE_SCHEMA_VERSION
            ),
            "featureSchemaVersion": (
                self.expectations
                .feature_schema_version
            ),
            "deploymentId": (
                self.expectations
                .deployment_id
            ),
            "ensembleId": (
                self.expectations
                .ensemble_id
            ),
            "ensembleVersion": (
                self.expectations
                .ensemble_version
            ),
            "analysisMode": (
                ANALYSIS_MODE
            ),
            "tenantId": (
                request["tenantId"]
            ),
            "requestId": request_id,
            "windowWatermark": (
                watermark
            ),
        }

        if any(
            root.get(key) != value
            for key, value
            in expected_root.items()
        ):
            raise ModelServiceContractError(
                "The model response identity "
                "or version is incompatible.",
                watermark=watermark,
            )

        raw_scores = root.get(
            "scores"
        )

        if not isinstance(
            raw_scores,
            list,
        ):
            raise ModelServiceContractError(
                "The model response scores "
                "must be an array.",
                watermark=watermark,
            )

        score_keys = frozenset(
            {
                "claimId",
                "claimVersion",
                (
                    "baselineFraud"
                    "Probability"
                ),
                (
                    "baselinePredicted"
                    "Class"
                ),
                "baselineThreshold",
                "ringProbability",
                "ringReviewHit",
                "ringThreshold",
                "phantomProbability",
                "phantomReviewHit",
                "phantomThreshold",
                (
                    "compositeReview"
                    "Recommended"
                ),
            }
        )

        scores_by_token: dict[
            str,
            ClaimReviewResult,
        ] = {}

        ordered_tokens: list[
            str
        ] = []

        for index, raw_score in enumerate(
            raw_scores
        ):
            score = _exact_mapping(
                raw_score,
                expected_keys=score_keys,
                path=(
                    f"scores[{index}]"
                ),
                watermark=watermark,
            )

            claim_token = str(
                score.get(
                    "claimId"
                )
                or ""
            )

            target = (
                claim_token_to_target
                .get(claim_token)
            )

            if (
                target is None
                or claim_token
                in scores_by_token
            ):
                raise ModelServiceContractError(
                    "The model response claim "
                    "coverage is incompatible.",
                    watermark=watermark,
                )

            claim_version = (
                _positive_integer(
                    score.get(
                        "claimVersion"
                    ),
                    (
                        f"scores[{index}]"
                        ".claimVersion"
                    ),
                    watermark,
                )
            )

            if (
                claim_version
                != target.claim_version
            ):
                raise ModelServiceContractError(
                    "The model response claim "
                    "version is incompatible.",
                    watermark=watermark,
                )

            ordered_tokens.append(
                claim_token
            )

            baseline = _probability(
                score.get(
                    "baselineFraudProbability"
                ),
                (
                    f"scores[{index}]"
                    ".baselineFraudProbability"
                ),
                watermark,
            )

            baseline_threshold = (
                _probability(
                    score.get(
                        "baselineThreshold"
                    ),
                    (
                        f"scores[{index}]"
                        ".baselineThreshold"
                    ),
                    watermark,
                )
            )

            ring = _probability(
                score.get(
                    "ringProbability"
                ),
                (
                    f"scores[{index}]"
                    ".ringProbability"
                ),
                watermark,
            )

            ring_threshold = (
                _probability(
                    score.get(
                        "ringThreshold"
                    ),
                    (
                        f"scores[{index}]"
                        ".ringThreshold"
                    ),
                    watermark,
                )
            )

            phantom = _probability(
                score.get(
                    "phantomProbability"
                ),
                (
                    f"scores[{index}]"
                    ".phantomProbability"
                ),
                watermark,
            )

            phantom_threshold = (
                _probability(
                    score.get(
                        "phantomThreshold"
                    ),
                    (
                        f"scores[{index}]"
                        ".phantomThreshold"
                    ),
                    watermark,
                )
            )

            ring_hit = _boolean(
                score.get(
                    "ringReviewHit"
                ),
                (
                    f"scores[{index}]"
                    ".ringReviewHit"
                ),
                watermark,
            )

            phantom_hit = _boolean(
                score.get(
                    "phantomReviewHit"
                ),
                (
                    f"scores[{index}]"
                    ".phantomReviewHit"
                ),
                watermark,
            )

            composite = _boolean(
                score.get(
                    "compositeReviewRecommended"
                ),
                (
                    f"scores[{index}]"
                    ".compositeReviewRecommended"
                ),
                watermark,
            )

            predicted_class = (
                score.get(
                    "baselinePredictedClass"
                )
            )

            if predicted_class not in {
                "LEGITIMATE",
                "FRAUD",
            }:
                raise ModelServiceContractError(
                    "The model response baseline "
                    "class is invalid.",
                    watermark=watermark,
                )

            expected_thresholds = (
                (
                    baseline_threshold,
                    self.expectations
                    .baseline_threshold,
                ),
                (
                    ring_threshold,
                    self.expectations
                    .ring_threshold,
                ),
                (
                    phantom_threshold,
                    self.expectations
                    .phantom_threshold,
                ),
            )

            if any(
                not math.isclose(
                    actual,
                    expected,
                    rel_tol=0,
                    abs_tol=1e-15,
                )
                for actual, expected
                in expected_thresholds
            ):
                raise ModelServiceContractError(
                    "The model response "
                    "thresholds changed.",
                    watermark=watermark,
                )

            baseline_hit = (
                baseline
                >= baseline_threshold
            )

            if (
                (
                    predicted_class
                    == "FRAUD"
                )
                != baseline_hit
                or ring_hit
                != (
                    ring
                    >= ring_threshold
                )
                or phantom_hit
                != (
                    phantom
                    >= phantom_threshold
                )
                or composite
                != (
                    baseline_hit
                    or ring_hit
                    or phantom_hit
                )
            ):
                raise ModelServiceContractError(
                    "The model response decisions "
                    "differ from their thresholds.",
                    watermark=watermark,
                )

            scores_by_token[
                claim_token
            ] = ClaimReviewResult(
                claim_id=(
                    target.claim_id
                ),
                claim_version=(
                    target.claim_version
                ),
                baseline_fraud_probability=(
                    baseline
                ),
                baseline_predicted_class=(
                    str(predicted_class)
                ),
                baseline_threshold=(
                    baseline_threshold
                ),
                ring_probability=ring,
                ring_review_hit=(
                    ring_hit
                ),
                ring_threshold=(
                    ring_threshold
                ),
                phantom_probability=(
                    phantom
                ),
                phantom_review_hit=(
                    phantom_hit
                ),
                phantom_threshold=(
                    phantom_threshold
                ),
                composite_review_recommended=(
                    composite
                ),
            )

        expected_order = list(
            claim_token_to_target
        )

        if (
            set(scores_by_token)
            != set(
                claim_token_to_target
            )
            or ordered_tokens
            != expected_order
        ):
            raise ModelServiceContractError(
                "The model response claim "
                "coverage or ordering is "
                "incompatible.",
                watermark=watermark,
            )

        return ReviewWindowResult(
            deployment_id=(
                self.expectations
                .deployment_id
            ),
            ensemble_id=(
                self.expectations
                .ensemble_id
            ),
            ensemble_version=(
                self.expectations
                .ensemble_version
            ),
            feature_schema_version=(
                self.expectations
                .feature_schema_version
            ),
            analysis_mode=(
                ANALYSIS_MODE
            ),
            request_id=request_id,
            watermark=watermark,
            scores=tuple(
                scores_by_token[token]
                for token
                in expected_order
            ),
        )
