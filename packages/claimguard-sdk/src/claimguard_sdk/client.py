from __future__ import annotations

import json
import urllib.request
import urllib.error
import datetime
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

    def __init__(self, api_url: str, api_key: str, scheme_key: str, timeout: float = 10.0):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.tokenizer = ClaimGuardEdgeSDK(scheme_key=scheme_key)
        self.timeout = timeout

    def _sanitize_date_of_birth(self, dob: str) -> Optional[str]:
        """Minimizes exact date of birth to the first of the year (YYYY-01-01)."""
        if not dob:
            return dob
        try:
            clean_dob = dob.replace("Z", "+00:00")
            if "T" in clean_dob or " " in clean_dob:
                dt = datetime.datetime.fromisoformat(clean_dob)
                return f"{dt.year:04d}-01-01"
            else:
                d = datetime.date.fromisoformat(clean_dob)
                return f"{d.year:04d}-01-01"
        except Exception:
            return None

    def _sanitize_coordinate(self, coord: Any) -> Optional[float]:
        """Rounds coordinates to 1 decimal place (~11km precision) for privacy."""
        try:
            return round(float(coord), 1)
        except (ValueError, TypeError):
            return None

    def _sanitize_members(self, members: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        sanitized = []
        for m in members:
            safe_m = m.copy()
            # Tokenize direct identifiers and names
            if "member_id" in m:
                safe_m["member_id"] = self.tokenizer.tokenize_string(str(m["member_id"]), "ID")
            if "identity_number" in m:
                safe_m["identity_number"] = self.tokenizer.tokenize_string(str(m["identity_number"]), "ID")
            if "first_name" in m:
                safe_m["first_name"] = self.tokenizer.tokenize_string(str(m["first_name"]), "NAME")
            if "last_name" in m:
                safe_m["last_name"] = self.tokenizer.tokenize_string(str(m["last_name"]), "NAME")
            if "banking_detail" in m:
                safe_m["banking_detail"] = self.tokenizer.tokenize_banking_detail(str(m["banking_detail"]))
            
            # Minimize precision
            if "date_of_birth" in m:
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
            if "provider_id" in p:
                safe_p["provider_id"] = self.tokenizer.tokenize_string(str(p["provider_id"]), "ID")
            if "practice_number" in p:
                safe_p["practice_number"] = self.tokenizer.tokenize_pcns(str(p["practice_number"]))
            if "practice_name" in p:
                safe_p["practice_name"] = self.tokenizer.tokenize_string(str(p["practice_name"]), "NAME")
            if "banking_detail" in p:
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
            if "claim_id" in c:
                safe_c["claim_id"] = self.tokenizer.tokenize_string(str(c["claim_id"]), "ID")
            if "member_id" in c:
                safe_c["member_id"] = self.tokenizer.tokenize_string(str(c["member_id"]), "ID")
            if "provider_id" in c:
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
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_content = e.read().decode("utf-8")
            try:
                error_body = json.loads(error_content)
            except Exception:
                error_body = error_content
            raise ClaimGuardClientError(
                f"API Error: {e.code} {e.reason}",
                status_code=e.code,
                response_body=error_body
            )

