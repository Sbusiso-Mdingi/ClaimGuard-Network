"""Non-scoring diagnostics for the isolated Ensemble 2.1.1 canary."""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import joblib

MARKER = "CLAIMGUARD_CANARY_RESULT="
AUDIENCE = "api://58019e2d-cfd0-4bdf-b757-bc96876f2f25"
BASE_URL = (
    "https://claimguard-ensemble-211-canary."
    "livelydune-39b25d2c.southafricanorth.azurecontainerapps.io"
)
BASELINE_URL = (
    "https://claimguard-ml-prospective."
    "livelydune-39b25d2c.southafricanorth.azurecontainerapps.io"
)


def main() -> None:
    result: dict[str, object] = {
        "diagnostic": "identity-and-artifact",
        "identityEndpointPresent": bool(os.environ.get("IDENTITY_ENDPOINT")),
        "identityHeaderPresent": bool(os.environ.get("IDENTITY_HEADER")),
        "azureClientIdPresent": bool(os.environ.get("AZURE_CLIENT_ID")),
        "tokenAcquired": False,
    }
    access_token: str | None = None
    try:
        query = urllib.parse.urlencode(
            {
                "api-version": "2019-08-01",
                "resource": AUDIENCE,
                "client_id": os.environ["AZURE_CLIENT_ID"],
            }
        )
        request = urllib.request.Request(
            f"{os.environ['IDENTITY_ENDPOINT']}?{query}",
            headers={"X-IDENTITY-HEADER": os.environ["IDENTITY_HEADER"]},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            token = json.load(response)
        access_token = token.get("access_token")
        result.update(
            {
                "tokenAcquired": bool(access_token),
                "tokenType": token.get("token_type"),
                "expiresOnPresent": bool(token.get("expires_on")),
            }
        )
    except urllib.error.HTTPError as error:
        result.update(
            {
                "tokenErrorType": type(error).__name__,
                "tokenErrorStatus": error.code,
                "tokenErrorBody": error.read(1000).decode("utf-8", "replace"),
            }
        )
    except Exception as error:  # diagnostic boundary
        result.update(
            {
                "tokenErrorType": type(error).__name__,
                "tokenErrorMessage": str(error),
            }
        )

    if access_token:
        encoded_claims = access_token.split(".")[1]
        encoded_claims += "=" * (-len(encoded_claims) % 4)
        claims = json.loads(
            base64.urlsafe_b64decode(encoded_claims).decode("utf-8")
        )
        result["tokenClaims"] = {
            key: claims.get(key)
            for key in ("aud", "appid", "azp", "iss", "oid", "sub")
            if claims.get(key) is not None
        }
        try:
            openapi_request = urllib.request.Request(
                f"{BASE_URL}/openapi.json",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            with urllib.request.urlopen(openapi_request, timeout=20) as response:
                openapi = json.load(response)
                result["authenticatedOpenApiStatus"] = response.status
            result["claimScreeningPostPresent"] = bool(
                openapi.get("paths", {})
                .get("/v3/claim-screening", {})
                .get("post")
            )
        except urllib.error.HTTPError as error:
            result.update(
                {
                    "openApiErrorType": type(error).__name__,
                    "openApiErrorStatus": error.code,
                    "openApiErrorBody": error.read(1000).decode(
                        "utf-8",
                        "replace",
                    ),
                }
            )
        except Exception as error:  # diagnostic boundary
            result.update(
                {
                    "openApiErrorType": type(error).__name__,
                    "openApiErrorMessage": str(error),
                }
            )

        try:
            baseline_request = urllib.request.Request(
                f"{BASELINE_URL}/openapi.json",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            with urllib.request.urlopen(baseline_request, timeout=20) as response:
                baseline_openapi = json.load(response)
                result["baselineAuthenticatedOpenApiStatus"] = response.status
            result["baselineClaimScreeningPostPresent"] = bool(
                baseline_openapi.get("paths", {})
                .get("/v3/claim-screening", {})
                .get("post")
            )
        except urllib.error.HTTPError as error:
            result.update(
                {
                    "baselineOpenApiErrorType": type(error).__name__,
                    "baselineOpenApiErrorStatus": error.code,
                    "baselineOpenApiErrorBody": error.read(1000).decode(
                        "utf-8",
                        "replace",
                    ),
                }
            )
        except Exception as error:  # diagnostic boundary
            result.update(
                {
                    "baselineOpenApiErrorType": type(error).__name__,
                    "baselineOpenApiErrorMessage": str(error),
                }
            )

    artifact = joblib.load(Path("/opt/claimguard/model/model.joblib"))
    result.update(
        {
            "artifactModelId": artifact.get("model_id"),
            "artifactModelVersion": artifact.get("model_version"),
            "predictorCount": len(artifact.get("predictor_names", ())),
        }
    )
    print(MARKER + json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
