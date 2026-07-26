from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from .model_service import AzureTokenProvider, ModelHttpResponse, UrllibModelTransport
from .prospective_snapshot import PREDICTOR_NAMES
from .snapshot import ProspectiveScoringSnapshot

REQUEST_SCHEMA_VERSION = "claimguard.claim-screening-request.v3"
RESPONSE_SCHEMA_VERSION = "claimguard.claim-screening-response.v3"
FEATURE_SCHEMA_VERSION = "claim-feature-schema-2026.2"
ANALYSIS_MODE = "PROSPECTIVE_CLAIM_SCREENING"
MODEL_ID = "claimguard-claim-fraud-baseline"
MODEL_VERSION = "1.0.0"
DEFAULT_ENDPOINT_PATH = "/v3/claim-screening"
MAX_MODEL_RESPONSE_BYTES = 5 * 1024 * 1024


class ProspectiveModelServiceUnavailable(RuntimeError):
    code = "MODEL_SERVICE_UNAVAILABLE"

    def __init__(self, message: str = "The prospective model service is unavailable.", *, watermark: str | None = None) -> None:
        super().__init__(message)
        self.watermark = watermark


class ProspectiveModelContractError(ProspectiveModelServiceUnavailable):
    code = "MODEL_SERVICE_CONTRACT_ERROR"


@dataclass(frozen=True)
class ProspectiveClaimScore:
    claim_id: str
    claim_version: int
    fraud_probability: float
    predicted_class: str
    threshold: float
    review_recommended: bool


@dataclass(frozen=True)
class ProspectiveModelServiceExpectations:
    deployment_id: str
    model_id: str
    model_version: str
    feature_schema_version: str
    analysis_mode: str
    threshold: float

    def __post_init__(self) -> None:
        for field in (
            "deployment_id",
            "model_id",
            "model_version",
            "feature_schema_version",
            "analysis_mode",
        ):
            value = str(getattr(self, field) or "").strip()
            if not value or len(value) > 128:
                raise ValueError(
                    f"Prospective model expectation {field} is invalid."
                )
            object.__setattr__(self, field, value)

        if self.feature_schema_version != FEATURE_SCHEMA_VERSION:
            raise ValueError(
                "The prospective feature builder does not support the configured "
                "feature schema."
            )
        if self.analysis_mode != ANALYSIS_MODE:
            raise ValueError(
                "The prospective worker does not support the configured analysis mode."
            )
        if (
            isinstance(self.threshold, bool)
            or not math.isfinite(self.threshold)
            or not 0 <= self.threshold <= 1
        ):
            raise ValueError("The expected prospective threshold is invalid.")

    @classmethod
    def baseline(
        cls,
        deployment_id: str,
        *,
        threshold: float = 0.08760971001434723,
    ) -> "ProspectiveModelServiceExpectations":
        return cls(
            deployment_id=deployment_id,
            model_id=MODEL_ID,
            model_version=MODEL_VERSION,
            feature_schema_version=FEATURE_SCHEMA_VERSION,
            analysis_mode=ANALYSIS_MODE,
            threshold=threshold,
        )


@dataclass(frozen=True)
class ProspectiveScreeningResult:
    deployment_id: str
    model_id: str
    model_version: str
    feature_schema_version: str
    analysis_mode: str
    request_id: str
    watermark: str
    scores: tuple[ProspectiveClaimScore, ...]


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


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required for prospective model scoring.")
    return value


def _probability(value: object, field: str, watermark: str) -> float:
    if isinstance(value, bool):
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark)
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark) from error
    if not math.isfinite(parsed) or not 0 <= parsed <= 1:
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark)
    return parsed


def _positive_integer(value: object, field: str, watermark: str) -> int:
    if isinstance(value, bool):
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark) from error
    if parsed <= 0 or (isinstance(value, float) and not value.is_integer()):
        raise ProspectiveModelContractError(f"{field} is invalid.", watermark=watermark)
    return parsed


class ProspectiveModelServiceClient:
    def __init__(
        self,
        *,
        base_url: str,
        audience: str,
        pseudonymization_key: str,
        expectations: ProspectiveModelServiceExpectations,
        token_provider: TokenProvider,
        transport: ModelTransport,
        timeout_seconds: float = 120,
        endpoint_path: str = DEFAULT_ENDPOINT_PATH,
    ) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"}:
            raise ValueError("MODEL_SERVICE_BASE_URL must be an HTTPS origin.")
        if len(pseudonymization_key.encode("utf-8")) < 32:
            raise ValueError("MODEL_SERVICE_PSEUDONYMIZATION_KEY must contain at least 32 bytes.")
        if not endpoint_path.startswith("/") or endpoint_path.endswith("/"):
            raise ValueError("MODEL_SERVICE_ENDPOINT_PATH is invalid.")
        if not isinstance(expectations, ProspectiveModelServiceExpectations):
            raise ValueError("Prospective model-service expectations are required.")
        self.endpoint_url = f"{base_url.rstrip('/')}{endpoint_path}"
        self.audience = audience.strip()
        self.pseudonymization_key = pseudonymization_key.encode("utf-8")
        self.expectations = expectations
        self.deployment_id = expectations.deployment_id
        self.token_provider = token_provider
        self.transport = transport
        self.timeout_seconds = timeout_seconds
        self.expected_threshold = expectations.threshold

    @classmethod
    def from_environment(cls) -> "ProspectiveModelServiceClient":
        deployment_id = _required_environment("MODEL_SERVICE_DEPLOYMENT_ID")
        threshold = float(
            os.environ.get(
                "MODEL_SERVICE_EXPECTED_THRESHOLD",
                os.environ.get(
                    "MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD",
                    "0.08760971001434723",
                ),
            )
        )
        return cls(
            base_url=_required_environment("MODEL_SERVICE_BASE_URL"),
            audience=_required_environment("MODEL_SERVICE_AUDIENCE"),
            pseudonymization_key=_required_environment("MODEL_SERVICE_PSEUDONYMIZATION_KEY"),
            expectations=ProspectiveModelServiceExpectations(
                deployment_id=deployment_id,
                model_id=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_MODEL_ID",
                    MODEL_ID,
                ),
                model_version=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_MODEL_VERSION",
                    MODEL_VERSION,
                ),
                feature_schema_version=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION",
                    FEATURE_SCHEMA_VERSION,
                ),
                analysis_mode=os.environ.get(
                    "MODEL_SERVICE_EXPECTED_ANALYSIS_MODE",
                    ANALYSIS_MODE,
                ),
                threshold=threshold,
            ),
            token_provider=AzureTokenProvider(),
            transport=UrllibModelTransport(),
            timeout_seconds=float(os.environ.get("MODEL_SERVICE_TIMEOUT_SECONDS", "120")),
            endpoint_path=os.environ.get("MODEL_SERVICE_ENDPOINT_PATH", DEFAULT_ENDPOINT_PATH),
        )

    def _token(self, tenant_id: str, kind: str, value: object, watermark: str) -> str:
        rendered = str(value or "").strip()
        if not rendered:
            raise ProspectiveModelContractError(f"{kind} identifier is required.", watermark=watermark)
        digest = hmac.new(
            self.pseudonymization_key,
            f"{tenant_id}\0{kind}\0{rendered}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{kind}-{digest}"

    def _request(self, snapshot: ProspectiveScoringSnapshot) -> tuple[dict[str, object], dict[str, tuple[str, int]]]:
        watermark = str(snapshot.watermark or "").strip()
        if not watermark:
            raise ProspectiveModelContractError("Snapshot watermark is required.")
        if snapshot.model_deployment_id != self.deployment_id:
            raise ProspectiveModelContractError(
                "The pinned model deployment is not approved by this client.",
                watermark=watermark,
            )
        providers = {
            str(item.get("provider_id") or ""): item
            for item in snapshot.providers
        }
        context_by_ref = {
            (str(item.get("claim_id") or ""), int(item.get("claim_version") or 0)): item.get("features")
            for item in snapshot.context_features
        }
        targets: list[dict[str, object]] = []
        contexts: list[dict[str, object]] = []
        token_map: dict[str, tuple[str, int]] = {}
        for claim in snapshot.target_claims:
            claim_id = str(claim.get("claim_id") or "").strip()
            claim_version = _positive_integer(claim.get("claim_version"), "claimVersion", watermark)
            provider_id = str(claim.get("provider_id") or "").strip()
            provider = providers.get(provider_id)
            if not claim_id or provider is None:
                raise ProspectiveModelContractError("Target claim references are incomplete.", watermark=watermark)
            claim_token = self._token(
                snapshot.tenant_id,
                "claim-version",
                f"{claim_id}:{claim_version}",
                watermark,
            )
            if claim_token in token_map:
                raise ProspectiveModelContractError("Duplicate target claim version.", watermark=watermark)
            token_map[claim_token] = (claim_id, claim_version)
            rendering = claim.get("rendering_practitioner_id")
            rendering_token = (
                self._token(snapshot.tenant_id, "rendering", rendering, watermark)
                if rendering is not None and str(rendering).strip()
                else None
            )
            targets.append(
                {
                    "claimId": claim_token,
                    "claimVersion": claim_version,
                    "memberKey": self._token(snapshot.tenant_id, "member", claim.get("member_id"), watermark),
                    "billingProviderKey": self._token(snapshot.tenant_id, "provider", provider_id, watermark),
                    "renderingPractitionerKey": rendering_token,
                    "serviceDate": str(claim.get("service_date")),
                    "receivedDate": str(claim.get("received_date")),
                    "claimedAmount": str(claim.get("amount")),
                    "quantity": str(claim.get("quantity")),
                    "benefitOption": str(claim.get("benefit_option") or ""),
                    "networkType": str(claim.get("network_type") or ""),
                    "lineType": str(claim.get("line_type") or ""),
                    "billingCode": str(claim.get("billing_code") or ""),
                    "tariffDiscipline": str(claim.get("tariff_discipline") or ""),
                    "diagnosisCode": str(claim.get("diagnosis_code") or ""),
                    "billingProviderKind": str(provider.get("provider_kind") or ""),
                    "billingProviderCategory": str(provider.get("provider_category") or ""),
                    "renderingPractitionerCategory": str(claim.get("rendering_practitioner_category") or ""),
                    "renderingKnownToBillingProvider": claim.get("rendering_known_to_billing_provider") is True,
                }
            )
            features = context_by_ref.get((claim_id, claim_version))
            if not isinstance(features, dict) or tuple(features) != PREDICTOR_NAMES:
                raise ProspectiveModelContractError(
                    "Snapshot context features differ from the sealed model contract.",
                    watermark=watermark,
                )
            contexts.append(
                {
                    "claimId": claim_token,
                    "claimVersion": claim_version,
                    "features": features,
                }
            )
        request_without_id: dict[str, object] = {
            "schemaVersion": REQUEST_SCHEMA_VERSION,
            "featureSchemaVersion": self.expectations.feature_schema_version,
            "deploymentId": self.deployment_id,
            "tenantId": self._token(snapshot.tenant_id, "tenant", snapshot.tenant_id, watermark),
            "analysisMode": self.expectations.analysis_mode,
            "window": {
                "capturedAt": snapshot.captured_at,
                "contextCutoffAt": snapshot.context_cutoff_at,
                "watermark": watermark,
            },
            "targetClaims": targets,
            "contextFeatures": {
                "schemaVersion": self.expectations.feature_schema_version,
                "targets": contexts,
            },
        }
        digest = hashlib.sha256(
            json.dumps(request_without_id, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {**request_without_id, "requestId": f"screen-{digest}"}, token_map

    def screen(self, snapshot: ProspectiveScoringSnapshot) -> ProspectiveScreeningResult:
        request, token_map = self._request(snapshot)
        watermark = str(request["window"]["watermark"])  # type: ignore[index]
        request_id = str(request["requestId"])
        try:
            token = self.token_provider.get_token(self.audience)
            response = self.transport.post(
                url=self.endpoint_url,
                body=json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8"),
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "x-request-id": request_id,
                },
                timeout_seconds=self.timeout_seconds,
            )
        except Exception as error:
            raise ProspectiveModelServiceUnavailable(watermark=watermark) from error
        if response.status != 200:
            raise ProspectiveModelServiceUnavailable(
                f"The prospective model service returned HTTP {response.status}.",
                watermark=watermark,
            )
        if len(response.body) > MAX_MODEL_RESPONSE_BYTES:
            raise ProspectiveModelContractError("The model response exceeded the size limit.", watermark=watermark)
        try:
            payload = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProspectiveModelContractError("The model response is not valid JSON.", watermark=watermark) from error
        expected = {
            "schemaVersion": RESPONSE_SCHEMA_VERSION,
            "featureSchemaVersion": self.expectations.feature_schema_version,
            "deploymentId": self.deployment_id,
            "modelId": self.expectations.model_id,
            "modelVersion": self.expectations.model_version,
            "analysisMode": self.expectations.analysis_mode,
            "tenantId": request["tenantId"],
            "requestId": request_id,
            "windowWatermark": watermark,
        }
        if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in expected.items()):
            raise ProspectiveModelContractError("The model response identity is incompatible.", watermark=watermark)
        raw_scores = payload.get("scores")
        if not isinstance(raw_scores, list):
            raise ProspectiveModelContractError("The model response scores must be an array.", watermark=watermark)
        scores: list[ProspectiveClaimScore] = []
        ordered_tokens: list[str] = []
        for index, raw in enumerate(raw_scores):
            if not isinstance(raw, dict):
                raise ProspectiveModelContractError(f"scores[{index}] is invalid.", watermark=watermark)
            token = str(raw.get("claimId") or "")
            target = token_map.get(token)
            if target is None or token in ordered_tokens:
                raise ProspectiveModelContractError("Model response claim coverage is incompatible.", watermark=watermark)
            version = _positive_integer(raw.get("claimVersion"), f"scores[{index}].claimVersion", watermark)
            if version != target[1]:
                raise ProspectiveModelContractError("Model response claim version is incompatible.", watermark=watermark)
            probability = _probability(raw.get("fraudProbability"), f"scores[{index}].fraudProbability", watermark)
            threshold = _probability(raw.get("threshold"), f"scores[{index}].threshold", watermark)
            if not math.isclose(threshold, self.expected_threshold, rel_tol=0, abs_tol=1e-15):
                raise ProspectiveModelContractError("The model response threshold changed.", watermark=watermark)
            predicted = raw.get("predictedClass")
            review = raw.get("reviewRecommended")
            expected_review = probability >= threshold
            if predicted not in {"LEGITIMATE", "FRAUD"} or not isinstance(review, bool):
                raise ProspectiveModelContractError("The model response decision is invalid.", watermark=watermark)
            if (predicted == "FRAUD") != expected_review or review != expected_review:
                raise ProspectiveModelContractError("The model response decision differs from its threshold.", watermark=watermark)
            ordered_tokens.append(token)
            scores.append(
                ProspectiveClaimScore(
                    claim_id=target[0],
                    claim_version=target[1],
                    fraud_probability=probability,
                    predicted_class=str(predicted),
                    threshold=threshold,
                    review_recommended=review,
                )
            )
        if ordered_tokens != list(token_map):
            raise ProspectiveModelContractError("Model response ordering is incompatible.", watermark=watermark)
        return ProspectiveScreeningResult(
            deployment_id=self.deployment_id,
            model_id=self.expectations.model_id,
            model_version=self.expectations.model_version,
            feature_schema_version=self.expectations.feature_schema_version,
            analysis_mode=self.expectations.analysis_mode,
            request_id=request_id,
            watermark=watermark,
            scores=tuple(scores),
        )
