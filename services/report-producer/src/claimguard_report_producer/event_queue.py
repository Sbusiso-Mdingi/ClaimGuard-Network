from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from azure.identity import DefaultAzureCredential


class ClaimWakeupContractError(ValueError):
    code = "CLAIM_WAKEUP_CONTRACT_INVALID"


@dataclass(frozen=True)
class ClaimWakeupMessage:
    message_id: str
    pop_receipt: str
    outbox_job_id: str
    organisation_id: str | None
    correlation_id: str | None
    dequeue_count: int
    message_text: str


def _required_text(value: object, field: str, maximum: int) -> str:
    rendered = str(value or "").strip()
    if not rendered:
        raise ClaimWakeupContractError(f"{field} is required.")
    if len(rendered) > maximum:
        raise ClaimWakeupContractError(f"{field} must not exceed {maximum} characters.")
    return rendered


def _parse_message(element: ElementTree.Element) -> ClaimWakeupMessage:
    message_id = _required_text(element.findtext("MessageId"), "MessageId", 256)
    pop_receipt = _required_text(element.findtext("PopReceipt"), "PopReceipt", 2048)
    message_text = _required_text(element.findtext("MessageText"), "MessageText", 65_536)
    try:
        payload = json.loads(message_text)
    except json.JSONDecodeError as error:
        raise ClaimWakeupContractError("MessageText must contain JSON.") from error
    if not isinstance(payload, dict):
        raise ClaimWakeupContractError("Wake-up payload has an incompatible schema.")

    schema_version = payload.get("schema_version")
    expected_fields = (
        {
            "schema_version",
            "outbox_job_id",
            "correlation_id",
            "emitted_at",
        }
        if schema_version == 1
        else {
            "schema_version",
            "outbox_job_id",
            "organisation_id",
            "correlation_id",
            "emitted_at",
        }
    )
    if schema_version not in {1, 2}:
        raise ClaimWakeupContractError("Wake-up schema version is unsupported.")
    if frozenset(payload) != expected_fields:
        raise ClaimWakeupContractError("Wake-up payload has an incompatible schema.")
    emitted_at = _required_text(payload.get("emitted_at"), "emitted_at", 64)
    try:
        datetime.fromisoformat(emitted_at.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError as error:
        raise ClaimWakeupContractError("emitted_at must be an ISO timestamp.") from error
    correlation = payload.get("correlation_id")
    return ClaimWakeupMessage(
        message_id=message_id,
        pop_receipt=pop_receipt,
        outbox_job_id=_required_text(payload.get("outbox_job_id"), "outbox_job_id", 64),
        organisation_id=(
            _required_text(
                payload.get("organisation_id"),
                "organisation_id",
                64,
            )
            if schema_version == 2
            else None
        ),
        correlation_id=(
            _required_text(correlation, "correlation_id", 128)
            if correlation is not None
            else None
        ),
        dequeue_count=int(element.findtext("DequeueCount") or "1"),
        message_text=message_text,
    )


class AzureClaimWakeupQueue:
    def __init__(
        self,
        queue_url: str,
        *,
        credential=None,
        visibility_timeout_seconds: int = 1800,
    ) -> None:
        self.queue_url = _required_text(queue_url, "CLAIM_SCORING_QUEUE_URL", 2048).rstrip("/")
        self.credential = credential or DefaultAzureCredential(
            managed_identity_client_id=os.environ.get("AZURE_CLIENT_ID") or None,
        )
        self.visibility_timeout_seconds = max(60, min(int(visibility_timeout_seconds), 7200))

    def _request(
        self,
        url: str,
        *,
        method: str,
        body: bytes | None = None,
    ) -> bytes:
        token = self.credential.get_token("https://storage.azure.com/.default")
        request = Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {token.token}",
                "x-ms-date": datetime.now(UTC).strftime("%a, %d %b %Y %H:%M:%S GMT"),
                "x-ms-version": "2023-11-03",
                **(
                    {"Content-Type": "application/xml"}
                    if body is not None
                    else {}
                ),
            },
        )
        with urlopen(request, timeout=30) as response:  # noqa: S310
            return response.read()

    def receive(self, maximum_messages: int = 16) -> list[ClaimWakeupMessage]:
        count = max(1, min(int(maximum_messages), 32))
        body = self._request(
            f"{self.queue_url}/messages?numofmessages={count}"
            f"&visibilitytimeout={self.visibility_timeout_seconds}",
            method="GET",
        )
        root = ElementTree.fromstring(body)
        return [_parse_message(element) for element in root.findall("QueueMessage")]

    def delete(self, message: ClaimWakeupMessage) -> None:
        self._request(
            f"{self.queue_url}/messages/{quote(message.message_id, safe='')}"
            f"?popreceipt={quote(message.pop_receipt, safe='')}",
            method="DELETE",
        )

    def release(
        self,
        message: ClaimWakeupMessage,
        *,
        delay_seconds: int = 5,
    ) -> None:
        delay = max(0, min(int(delay_seconds), 604_800))
        root = ElementTree.Element("QueueMessage")
        text = ElementTree.SubElement(root, "MessageText")
        text.text = message.message_text
        body = ElementTree.tostring(
            root,
            encoding="utf-8",
            xml_declaration=True,
        )
        self._request(
            f"{self.queue_url}/messages/{quote(message.message_id, safe='')}"
            f"?popreceipt={quote(message.pop_receipt, safe='')}"
            f"&visibilitytimeout={delay}",
            method="PUT",
            body=body,
        )


def create_claim_wakeup_queue_from_environment() -> AzureClaimWakeupQueue:
    return AzureClaimWakeupQueue(
        os.environ.get("CLAIM_SCORING_QUEUE_URL", ""),
        visibility_timeout_seconds=int(
            os.environ.get("CLAIM_SCORING_QUEUE_VISIBILITY_SECONDS", "1800")
        ),
    )
