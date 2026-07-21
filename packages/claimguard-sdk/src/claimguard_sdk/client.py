from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

from .tokenizer import ClaimGuardEdgeSDK


class ClaimGuardClientError(Exception):
    """Raised when the API returns an error."""
    def __init__(self, message: str, status_code: int, response_body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class ClaimGuardClient:
    """
    Lightweight Edge SDK Client for ClaimGuard Network.
    This client automatically enforces POPIA-aligned tokenization of PII
    before any data leaves the local firewall.
    """

    def __init__(self, api_url: str, api_key: str, scheme_key: str):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.tokenizer = ClaimGuardEdgeSDK(scheme_key=scheme_key)

    def _sanitize_date_of_birth(self, dob: str) -> str:
        """Minimizes exact date of birth to the first of the year (YYYY-01-01)."""
        if not dob or len(dob) < 4:
            return dob
        return f"{dob[:4]}-01-01"

    def _sanitize_coordinate(self, coord: Any) -> float:
        """Rounds coordinates to 1 decimal place (~11km precision) for privacy."""
        try:
            return round(float(coord), 1)
        except (ValueError, TypeError):
            return 0.0

    def _sanitize_members(self, members: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        sanitized = []
        for m in members:
            safe_m = m.copy()
            # Tokenize direct identifiers and names
            safe_m["member_id"] = self.tokenizer.tokenize_string(str(m["member_id"]), "ID")
            safe_m["identity_number"] = self.tokenizer.tokenize_string(str(m["identity_number"]), "ID")
            safe_m["first_name"] = self.tokenizer.tokenize_string(str(m["first_name"]), "NAME")
            safe_m["last_name"] = self.tokenizer.tokenize_string(str(m["last_name"]), "NAME")
            safe_m["banking_detail"] = self.tokenizer.tokenize_banking_detail(str(m["banking_detail"]))
            
            # Minimize precision
            safe_m["date_of_birth"] = self._sanitize_date_of_birth(str(m["date_of_birth"]))
            if "home_lat" in safe_m:
                safe_m["home_lat"] = self._sanitize_coordinate(safe_m["home_lat"])
            if "home_lon" in safe_m:
                safe_m["home_lon"] = self._sanitize_coordinate(safe_m["home_lon"])
            sanitized.append(safe_m)
        return sanitized

    def _sanitize_providers(self, providers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        sanitized = []
        for p in providers:
            safe_p = p.copy()
            safe_p["provider_id"] = self.tokenizer.tokenize_string(str(p["provider_id"]), "ID")
            safe_p["practice_number"] = self.tokenizer.tokenize_pcns(str(p["practice_number"]))
            safe_p["practice_name"] = self.tokenizer.tokenize_string(str(p["practice_name"]), "NAME")
            safe_p["banking_detail"] = self.tokenizer.tokenize_banking_detail(str(p["banking_detail"]))
            
            if "practice_lat" in safe_p:
                safe_p["practice_lat"] = self._sanitize_coordinate(safe_p["practice_lat"])
            if "practice_lon" in safe_p:
                safe_p["practice_lon"] = self._sanitize_coordinate(safe_p["practice_lon"])
            sanitized.append(safe_p)
        return sanitized

    def _sanitize_claims(self, claims: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        sanitized = []
        for c in claims:
            safe_c = c.copy()
            # Must match the tokenized IDs of members and providers
            safe_c["claim_id"] = self.tokenizer.tokenize_string(str(c["claim_id"]), "ID")
            safe_c["member_id"] = self.tokenizer.tokenize_string(str(c["member_id"]), "ID")
            safe_c["provider_id"] = self.tokenizer.tokenize_string(str(c["provider_id"]), "ID")
            sanitized.append(safe_c)
        return sanitized

    def submit_batch(
        self,
        claims: List[Dict[str, Any]],
        members: List[Dict[str, Any]],
        providers: List[Dict[str, Any]],
        schemes: List[Dict[str, Any]],
        source: str = "api"
    ) -> Dict[str, Any]:
        """
        Tokenizes PII elements locally and submits the batch to ClaimGuard.
        """
        payload = {
            "source": source,
            "schemes": schemes,
            "members": self._sanitize_members(members),
            "providers": self._sanitize_providers(providers),
            "claims": self._sanitize_claims(claims)
        }

        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.api_url}/claims/ingest",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}"
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                error_body = json.loads(e.read().decode("utf-8"))
            except Exception:
                error_body = e.read().decode("utf-8")
            raise ClaimGuardClientError(
                f"API Error: {e.code} {e.reason}",
                status_code=e.code,
                response_body=error_body
            )
