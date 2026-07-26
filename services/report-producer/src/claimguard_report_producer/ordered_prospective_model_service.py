from __future__ import annotations

import json
from typing import Any

from .prospective_model_service import (
    ProspectiveModelServiceClient as _BaseProspectiveModelServiceClient,
)
from .prospective_snapshot import PREDICTOR_NAMES


class _FeatureOrderPreservingTransport:
    """Repairs canonical JSON sorting before the request leaves the worker.

    The base client intentionally canonicalises request identity with sorted JSON,
    but the fitted model contract also pins predictor order. This wrapper restores
    that order in the wire payload without changing the request ID or any values.
    """

    def __init__(self, delegate: Any) -> None:
        self.delegate = delegate

    def post(
        self,
        *,
        url: str,
        body: bytes,
        headers: dict[str, str],
        timeout_seconds: float,
    ):
        payload = json.loads(body.decode("utf-8"))
        context = payload.get("contextFeatures")
        targets = context.get("targets") if isinstance(context, dict) else None
        if not isinstance(targets, list):
            raise ValueError("Prospective context targets are missing from the request.")

        for index, target in enumerate(targets):
            if not isinstance(target, dict):
                raise ValueError(
                    f"Prospective context target {index} must be an object."
                )
            features = target.get("features")
            if not isinstance(features, dict):
                raise ValueError(
                    f"Prospective context target {index} has no feature object."
                )
            if set(features) != set(PREDICTOR_NAMES):
                raise ValueError(
                    f"Prospective context target {index} differs from the sealed predictor set."
                )
            target["features"] = {
                name: features[name]
                for name in PREDICTOR_NAMES
            }

        ordered_body = json.dumps(
            payload,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        return self.delegate.post(
            url=url,
            body=ordered_body,
            headers=headers,
            timeout_seconds=timeout_seconds,
        )


class ProspectiveModelServiceClient(_BaseProspectiveModelServiceClient):
    """Prospective ML client whose wire payload preserves model feature order."""

    def __init__(self, *, transport, **kwargs) -> None:
        super().__init__(
            transport=_FeatureOrderPreservingTransport(transport),
            **kwargs,
        )
