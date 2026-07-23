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
from decimal import Decimal, InvalidOperation
from typing import Protocol, TYPE_CHECKING
from urllib.parse import urlparse

if TYPE_CHECKING:
    from .snapshot import TenantSnapshot


REQUEST_SCHEMA_VERSION = "claimguard.claim-review-request.v2"
RESPONSE_SCHEMA_VERSION = "claimguard.claim-review-response.v2"
FEATURE_SCHEMA_VERSION = "claim-feature-schema-2026.2"
ANALYSIS_MODE = "RETROSPECTIVE_CLOSED_WINDOW_REVIEW"
ENSEMBLE_ID = "claimguard-claim-fraud-ensemble"
ENSEMBLE_VERSION = "1.1.0"
MAX_REVIEW_CLAIMS = 10_000

_DEPLOYMENT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class ModelServiceUnavailable(RuntimeError):
    code = "MODEL_SERVICE_UNAVAILABLE"

    def __init__(
        self,
        message: str = "The approved model service is unavailable.",
        *,
        watermark: str | None = None,
    ) -> None:
        super().__init__(message)
        self.watermark = watermark


class ModelServiceContractError(ModelServiceUnavailable):
    pass


@dataclass(frozen=True)
class ModelServiceExpectations:
    deployment_id: str
    ensemble_id: str = ENSEMBLE_ID
    ensemble_version: str = ENSEMBLE_VERSION
    feature_schema_version: str = FEATURE_SCHEMA_VERSION
    baseline_threshold: float = 0.08760971001434723
    ring_threshold: float = 0.148
    phantom_threshold: float = 0.8138303120761656

    def __post_init__(self) -> None:
        if not _DEPLOYMENT_ID.fullmatch(self.deployment_id):
            raise ValueError("MODEL_SERVICE_DEPLOYMENT_ID is invalid.")
        for name, value in (
            ("baseline", self.baseline_threshold),
            ("ring", self.ring_threshold),
            ("phantom", self.phantom_threshold),
        ):
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError(f"The expected {name} threshold is invalid.")


@dataclass(frozen=True)
class ClaimReviewResult:
    claim_id: str
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


class TokenProvider(Protocol):
    def get_token(self, audience: str) -> str: ...


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
        from azure.identity import DefaultAzureCredential

        self._credential = DefaultAzureCredential()

    def get_token(self, audience: str) -> str:
        scope = audience if audience.endswith("/.default") else (
            f"{audience.rstrip('/')}/.default"
        )
        return self._credential.get_token(scope).token


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UrllibModelTransport:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_NoRedirectHandler())

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
            with self._opener.open(request, timeout=timeout_seconds) as response:
                return ModelHttpResponse(
                    status=int(response.status),
                    body=response.read(),
                )
        except urllib.error.HTTPError as error:
            return ModelHttpResponse(status=int(error.code), body=error.read())


def _positive_float(value: str | None, default: float) -> float:
    try:
        parsed = float(value) if value is not None else default
    except ValueError:
        return default
    return parsed if math.isfinite(parsed) and parsed > 0 else default


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required for the approved model strategy.")
    return value


def _decimal_string(
    value: object,
    *,
    field: str,
    places: str,
    watermark: str,
) -> str:
    try:
        amount = Decimal(str(value)).quantize(Decimal(places))
    except (InvalidOperation, ValueError) as error:
        raise ModelServiceContractError(
            f"Snapshot {field} is invalid.",
            watermark=watermark,
        ) from error
    if not amount.is_finite() or amount <= 0:
        raise ModelServiceContractError(
            f"Snapshot {field} is outside the model domain.",
            watermark=watermark,
        )
    return format(amount, "f")


def _text(value: object, field: str, watermark: str) -> str:
    rendered = str(value or "").strip()
    if not rendered:
        raise ModelServiceContractError(
            f"Snapshot {field} is required by the model contract.",
            watermark=watermark,
        )
    return rendered


def _date_text(value: object, field: str, watermark: str) -> str:
    rendered = value.isoformat() if hasattr(value, "isoformat") else str(value or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", rendered):
        raise ModelServiceContractError(
            f"Snapshot {field} must be an ISO calendar date.",
            watermark=watermark,
        )
    return rendered


def _exact_mapping(
    value: object,
    *,
    expected_keys: frozenset[str],
    path: str,
    watermark: str,
) -> dict[str, object]:
    if not isinstance(value, dict) or frozenset(value) != expected_keys:
        raise ModelServiceContractError(
            f"The model response {path} contract is incompatible.",
            watermark=watermark,
        )
    return value


def _probability(value: object, path: str, watermark: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ModelServiceContractError(
            f"The model response {path} is invalid.",
            watermark=watermark,
        )
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= 1:
        raise ModelServiceContractError(
            f"The model response {path} is invalid.",
            watermark=watermark,
        )
    return result


def _boolean(value: object, path: str, watermark: str) -> bool:
    if not isinstance(value, bool):
        raise ModelServiceContractError(
            f"The model response {path} is invalid.",
            watermark=watermark,
        )
    return value


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
    ) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("MODEL_SERVICE_BASE_URL must be an HTTPS origin.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("MODEL_SERVICE_BASE_URL must not contain credentials or query data.")
        if not audience.strip():
            raise ValueError("MODEL_SERVICE_AUDIENCE is required.")
        if len(pseudonymization_key.encode("utf-8")) < 32:
            raise ValueError(
                "MODEL_SERVICE_PSEUDONYMIZATION_KEY must contain at least 32 bytes."
            )
        if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 240:
            raise ValueError("Model-service timeout must be between 1 and 240 seconds.")
        self.endpoint_url = f"{base_url.rstrip('/')}/v2/review-windows"
        self.audience = audience.strip()
        self.pseudonymization_key = pseudonymization_key.encode("utf-8")
        self.expectations = expectations
        self.token_provider = token_provider
        self.transport = transport
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_environment(cls) -> "ModelServiceClient":
        return cls(
            base_url=_required_environment("MODEL_SERVICE_BASE_URL"),
            audience=_required_environment("MODEL_SERVICE_AUDIENCE"),
            pseudonymization_key=_required_environment(
                "MODEL_SERVICE_PSEUDONYMIZATION_KEY"
            ),
            expectations=ModelServiceExpectations(
                deployment_id=_required_environment("MODEL_SERVICE_DEPLOYMENT_ID"),
                ensemble_id=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_ENSEMBLE_ID",
                    ENSEMBLE_ID,
                ).strip(),
                ensemble_version=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_ENSEMBLE_VERSION",
                    ENSEMBLE_VERSION,
                ).strip(),
                feature_schema_version=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION",
                    FEATURE_SCHEMA_VERSION,
                ).strip(),
                baseline_threshold=float(
                    os.environ.get(
                        "MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD",
                        "0.08760971001434723",
                    )
                ),
                ring_threshold=float(
                    os.environ.get(
                        "MODEL_SERVICE_EXPECTED_RING_THRESHOLD",
                        "0.148",
                    )
                ),
                phantom_threshold=float(
                    os.environ.get(
                        "MODEL_SERVICE_EXPECTED_PHANTOM_THRESHOLD",
                        "0.8138303120761656",
                    )
                ),
            ),
            token_provider=AzureTokenProvider(),
            transport=UrllibModelTransport(),
            timeout_seconds=_positive_float(
                os.environ.get("MODEL_SERVICE_TIMEOUT_SECONDS"),
                120,
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
        rendered = str(value or "").strip()
        if not rendered:
            raise ModelServiceContractError(
                f"Snapshot {kind} identifier is required.",
                watermark=watermark,
            )
        digest = hmac.new(
            self.pseudonymization_key,
            f"{tenant_id}\0{kind}\0{rendered}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{kind}-{digest}"

    def _request(
        self,
        snapshot: "TenantSnapshot",
    ) -> tuple[dict[str, object], dict[str, str]]:
        watermark = _text(snapshot.watermark, "watermark", "")
        if not 1 <= len(snapshot.claims) <= MAX_REVIEW_CLAIMS:
            raise ModelServiceContractError(
                "The closed review window contains an unsupported claim count.",
                watermark=watermark,
            )
        if snapshot.model_deployment_id != self.expectations.deployment_id:
            raise ModelServiceContractError(
                "The selected model deployment is not approved by this worker.",
                watermark=watermark,
            )

        providers = {
            str(item.get("provider_id") or ""): item for item in snapshot.providers
        }
        claim_token_to_id: dict[str, str] = {}
        claims: list[dict[str, object]] = []
        for claim in sorted(
            snapshot.claims,
            key=lambda item: str(item.get("claim_id") or ""),
        ):
            claim_id = _text(claim.get("claim_id"), "claim_id", watermark)
            provider_id = _text(claim.get("provider_id"), "provider_id", watermark)
            provider = providers.get(provider_id)
            if provider is None:
                raise ModelServiceContractError(
                    "A claim billing provider is absent from the closed snapshot.",
                    watermark=watermark,
                )
            claim_token = self._token(
                snapshot.tenant_id,
                "claim",
                claim_id,
                watermark=watermark,
            )
            if claim_token in claim_token_to_id:
                raise ModelServiceContractError(
                    "The closed review window contains duplicate claim identifiers.",
                    watermark=watermark,
                )
            claim_token_to_id[claim_token] = claim_id
            rendering_id = claim.get("rendering_practitioner_id")
            rendering_token = (
                self._token(
                    snapshot.tenant_id,
                    "rendering",
                    rendering_id,
                    watermark=watermark,
                )
                if rendering_id is not None and str(rendering_id).strip()
                else None
            )
            rendering_category = _text(
                claim.get("rendering_practitioner_category"),
                "rendering_practitioner_category",
                watermark,
            )
            rendering_known = bool(
                claim.get("rendering_known_to_billing_provider")
            )
            if rendering_token is None and (
                rendering_category != "NONE" or rendering_known
            ):
                raise ModelServiceContractError(
                    "Rendering-practitioner facts are internally inconsistent.",
                    watermark=watermark,
                )
            if rendering_token is not None and rendering_category == "NONE":
                raise ModelServiceContractError(
                    "Rendering-practitioner facts are internally inconsistent.",
                    watermark=watermark,
                )
            claims.append(
                {
                    "claimId": claim_token,
                    "memberKey": self._token(
                        snapshot.tenant_id,
                        "member",
                        claim.get("member_id"),
                        watermark=watermark,
                    ),
                    "billingProviderKey": self._token(
                        snapshot.tenant_id,
                        "provider",
                        provider_id,
                        watermark=watermark,
                    ),
                    "renderingPractitionerKey": rendering_token,
                    "serviceDate": _date_text(
                        claim.get("service_date"),
                        "service_date",
                        watermark,
                    ),
                    "receivedDate": _date_text(
                        claim.get("received_date"),
                        "received_date",
                        watermark,
                    ),
                    "claimedAmount": _decimal_string(
                        claim.get("amount"),
                        field="amount",
                        places="0.01",
                        watermark=watermark,
                    ),
                    "quantity": _decimal_string(
                        claim.get("quantity"),
                        field="quantity",
                        places="0.001",
                        watermark=watermark,
                    ),
                    "benefitOption": _text(
                        claim.get("benefit_option"),
                        "benefit_option",
                        watermark,
                    ),
                    "networkType": _text(
                        claim.get("network_type"),
                        "network_type",
                        watermark,
                    ),
                    "lineType": _text(
                        claim.get("line_type"),
                        "line_type",
                        watermark,
                    ),
                    "billingCode": _text(
                        claim.get("billing_code"),
                        "billing_code",
                        watermark,
                    ),
                    "tariffDiscipline": _text(
                        claim.get("tariff_discipline"),
                        "tariff_discipline",
                        watermark,
                    ),
                    "diagnosisCode": _text(
                        claim.get("diagnosis_code"),
                        "diagnosis_code",
                        watermark,
                    ),
                    "billingProviderKind": _text(
                        provider.get("provider_kind"),
                        "provider_kind",
                        watermark,
                    ),
                    "billingProviderCategory": _text(
                        provider.get("provider_category"),
                        "provider_category",
                        watermark,
                    ),
                    "renderingPractitionerCategory": rendering_category,
                    "renderingKnownToBillingProvider": rendering_known,
                }
            )

        request_digest = hashlib.sha256(
            (
                f"{snapshot.tenant_id}\0{watermark}\0"
                f"{self.expectations.deployment_id}"
            ).encode("utf-8")
        ).hexdigest()
        request_id = f"review-{request_digest}"
        return (
            {
                "schemaVersion": REQUEST_SCHEMA_VERSION,
                "featureSchemaVersion": self.expectations.feature_schema_version,
                "tenantId": self._token(
                    snapshot.tenant_id,
                    "tenant",
                    snapshot.tenant_id,
                    watermark=watermark,
                ),
                "requestId": request_id,
                "analysisMode": ANALYSIS_MODE,
                "window": {
                    "capturedAt": _text(
                        snapshot.captured_at,
                        "captured_at",
                        watermark,
                    ),
                    "watermark": watermark,
                },
                "claims": claims,
            },
            claim_token_to_id,
        )

    def review(self, snapshot: "TenantSnapshot") -> ReviewWindowResult:
        request, claim_token_to_id = self._request(snapshot)
        watermark = str(request["window"]["watermark"])
        request_id = str(request["requestId"])
        try:
            access_token = self.token_provider.get_token(self.audience)
            if not access_token:
                raise ModelServiceUnavailable(
                    "The workload identity did not return an access token.",
                    watermark=watermark,
                )
            response = self.transport.post(
                url=self.endpoint_url,
                body=json.dumps(
                    request,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8"),
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "x-request-id": request_id,
                },
                timeout_seconds=self.timeout_seconds,
            )
        except ModelServiceUnavailable:
            raise
        except Exception as error:
            raise ModelServiceUnavailable(watermark=watermark) from error

        if response.status != 200:
            raise ModelServiceUnavailable(watermark=watermark)
        try:
            payload = json.loads(
                response.body.decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(value)
                ),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise ModelServiceContractError(
                "The model response is not valid finite JSON.",
                watermark=watermark,
            ) from error

        root = _exact_mapping(
            payload,
            expected_keys=frozenset(
                {
                    "schemaVersion",
                    "featureSchemaVersion",
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
            "schemaVersion": RESPONSE_SCHEMA_VERSION,
            "featureSchemaVersion": self.expectations.feature_schema_version,
            "ensembleId": self.expectations.ensemble_id,
            "ensembleVersion": self.expectations.ensemble_version,
            "analysisMode": ANALYSIS_MODE,
            "tenantId": request["tenantId"],
            "requestId": request_id,
            "windowWatermark": watermark,
        }
        if any(root.get(key) != value for key, value in expected_root.items()):
            raise ModelServiceContractError(
                "The model response identity or version is incompatible.",
                watermark=watermark,
            )
        raw_scores = root.get("scores")
        if not isinstance(raw_scores, list):
            raise ModelServiceContractError(
                "The model response scores must be an array.",
                watermark=watermark,
            )

        score_keys = frozenset(
            {
                "claimId",
                "baselineFraudProbability",
                "baselinePredictedClass",
                "baselineThreshold",
                "ringProbability",
                "ringReviewHit",
                "ringThreshold",
                "phantomProbability",
                "phantomReviewHit",
                "phantomThreshold",
                "compositeReviewRecommended",
            }
        )
        scores_by_token: dict[str, ClaimReviewResult] = {}
        ordered_tokens: list[str] = []
        for index, raw_score in enumerate(raw_scores):
            score = _exact_mapping(
                raw_score,
                expected_keys=score_keys,
                path=f"scores[{index}]",
                watermark=watermark,
            )
            claim_token = str(score.get("claimId") or "")
            if claim_token not in claim_token_to_id or claim_token in scores_by_token:
                raise ModelServiceContractError(
                    "The model response claim coverage is incompatible.",
                    watermark=watermark,
                )
            ordered_tokens.append(claim_token)
            baseline = _probability(
                score.get("baselineFraudProbability"),
                f"scores[{index}].baselineFraudProbability",
                watermark,
            )
            baseline_threshold = _probability(
                score.get("baselineThreshold"),
                f"scores[{index}].baselineThreshold",
                watermark,
            )
            ring = _probability(
                score.get("ringProbability"),
                f"scores[{index}].ringProbability",
                watermark,
            )
            ring_threshold = _probability(
                score.get("ringThreshold"),
                f"scores[{index}].ringThreshold",
                watermark,
            )
            phantom = _probability(
                score.get("phantomProbability"),
                f"scores[{index}].phantomProbability",
                watermark,
            )
            phantom_threshold = _probability(
                score.get("phantomThreshold"),
                f"scores[{index}].phantomThreshold",
                watermark,
            )
            ring_hit = _boolean(
                score.get("ringReviewHit"),
                f"scores[{index}].ringReviewHit",
                watermark,
            )
            phantom_hit = _boolean(
                score.get("phantomReviewHit"),
                f"scores[{index}].phantomReviewHit",
                watermark,
            )
            composite = _boolean(
                score.get("compositeReviewRecommended"),
                f"scores[{index}].compositeReviewRecommended",
                watermark,
            )
            predicted_class = score.get("baselinePredictedClass")
            if predicted_class not in {"LEGITIMATE", "FRAUD"}:
                raise ModelServiceContractError(
                    "The model response baseline class is invalid.",
                    watermark=watermark,
                )
            expected_thresholds = (
                (baseline_threshold, self.expectations.baseline_threshold),
                (ring_threshold, self.expectations.ring_threshold),
                (phantom_threshold, self.expectations.phantom_threshold),
            )
            if any(
                not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-15)
                for actual, expected in expected_thresholds
            ):
                raise ModelServiceContractError(
                    "The model response thresholds changed.",
                    watermark=watermark,
                )
            baseline_hit = baseline >= baseline_threshold
            if (
                (predicted_class == "FRAUD") != baseline_hit
                or ring_hit != (ring >= ring_threshold)
                or phantom_hit != (phantom >= phantom_threshold)
                or composite != (baseline_hit or ring_hit or phantom_hit)
            ):
                raise ModelServiceContractError(
                    "The model response decisions differ from their thresholds.",
                    watermark=watermark,
                )
            scores_by_token[claim_token] = ClaimReviewResult(
                claim_id=claim_token_to_id[claim_token],
                baseline_fraud_probability=baseline,
                baseline_predicted_class=str(predicted_class),
                baseline_threshold=baseline_threshold,
                ring_probability=ring,
                ring_review_hit=ring_hit,
                ring_threshold=ring_threshold,
                phantom_probability=phantom,
                phantom_review_hit=phantom_hit,
                phantom_threshold=phantom_threshold,
                composite_review_recommended=composite,
            )

        if (
            set(scores_by_token) != set(claim_token_to_id)
            or ordered_tokens != sorted(ordered_tokens)
        ):
            raise ModelServiceContractError(
                "The model response claim coverage or ordering is incompatible.",
                watermark=watermark,
            )
        return ReviewWindowResult(
            deployment_id=self.expectations.deployment_id,
            ensemble_id=self.expectations.ensemble_id,
            ensemble_version=self.expectations.ensemble_version,
            feature_schema_version=self.expectations.feature_schema_version,
            analysis_mode=ANALYSIS_MODE,
            request_id=request_id,
            watermark=watermark,
            scores=tuple(
                sorted(
                    scores_by_token.values(),
                    key=lambda item: item.claim_id,
                )
            ),
        )
