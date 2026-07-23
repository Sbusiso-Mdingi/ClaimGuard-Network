from __future__ import annotations

import os
import threading
from typing import Dict

from .model_service import (
    ModelServiceClient,
    ModelServiceExpectations,
    AzureTokenProvider,
    UrllibModelTransport,
    ENSEMBLE_ID,
    ENSEMBLE_VERSION,
    FEATURE_SCHEMA_VERSION,
)


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required for the approved model strategy.")
    return value


class ModelDeploymentRegistry:
    def __init__(self) -> None:
        self._cache: Dict[str, ModelServiceClient] = {}
        self._lock = threading.Lock()

    def client_for(self, deployment_id: str) -> ModelServiceClient:
        if not deployment_id:
            raise ValueError("deployment_id is required.")

        with self._lock:
            if deployment_id in self._cache:
                return self._cache[deployment_id]

            # In a full implementation, we might map specific deployment IDs to specific URLs.
            # Here we default to the environment variables, allowing optional overrides per deployment ID.
            prefix = deployment_id.replace("-", "_").upper()
            base_url = os.environ.get(f"MODEL_SERVICE_BASE_URL_{prefix}") or _required_environment("MODEL_SERVICE_BASE_URL")
            audience = os.environ.get(f"MODEL_SERVICE_AUDIENCE_{prefix}") or _required_environment("MODEL_SERVICE_AUDIENCE")
            pseudonymization_key = os.environ.get(f"MODEL_SERVICE_PSEUDONYMIZATION_KEY_{prefix}") or _required_environment("MODEL_SERVICE_PSEUDONYMIZATION_KEY")

            expectations = ModelServiceExpectations(
                deployment_id=deployment_id,
                ensemble_id=os.environ.get("MODEL_SERVICE_EXPECTED_ENSEMBLE_ID", ENSEMBLE_ID).strip(),
                ensemble_version=os.environ.get("MODEL_SERVICE_EXPECTED_ENSEMBLE_VERSION", ENSEMBLE_VERSION).strip(),
                feature_schema_version=os.environ.get("MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION", FEATURE_SCHEMA_VERSION).strip(),
                baseline_threshold=float(os.environ.get("MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD", "0.08760971001434723")),
                ring_threshold=float(os.environ.get("MODEL_SERVICE_EXPECTED_RING_THRESHOLD", "0.148")),
                phantom_threshold=float(os.environ.get("MODEL_SERVICE_EXPECTED_PHANTOM_THRESHOLD", "0.8138303120761656")),
            )

            try:
                timeout_seconds = float(os.environ.get("MODEL_SERVICE_TIMEOUT_SECONDS", "120"))
            except ValueError:
                timeout_seconds = 120.0

            client = ModelServiceClient(
                base_url=base_url,
                audience=audience,
                pseudonymization_key=pseudonymization_key,
                expectations=expectations,
                token_provider=AzureTokenProvider(),
                transport=UrllibModelTransport(),
                timeout_seconds=timeout_seconds,
            )

            self._cache[deployment_id] = client
            return client
