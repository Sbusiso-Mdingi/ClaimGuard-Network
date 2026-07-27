from __future__ import annotations

import os
from unittest import TestCase
from unittest.mock import Mock, patch

from claimguard_report_producer.event_queue import (
    AzureClaimWakeupQueue,
    ClaimWakeupContractError,
    _parse_message,
    create_claim_wakeup_queue_from_environment,
)
from xml.etree import ElementTree


VALID_MESSAGE = """
<QueueMessage>
  <MessageId>message-1</MessageId>
  <PopReceipt>receipt/with+symbols</PopReceipt>
  <DequeueCount>2</DequeueCount>
  <MessageText>{"schema_version":1,"outbox_job_id":"job-123","correlation_id":"request-456","emitted_at":"2026-07-27T01:00:00Z"}</MessageText>
</QueueMessage>
""".strip()


class EventQueueContractTests(TestCase):
    def test_parse_message_accepts_the_privacy_minimised_contract(self) -> None:
        message = _parse_message(ElementTree.fromstring(VALID_MESSAGE))

        self.assertEqual(message.message_id, "message-1")
        self.assertEqual(message.pop_receipt, "receipt/with+symbols")
        self.assertEqual(message.outbox_job_id, "job-123")
        self.assertEqual(message.correlation_id, "request-456")
        self.assertEqual(message.dequeue_count, 2)

    def test_parse_message_rejects_unknown_payload_fields(self) -> None:
        invalid = VALID_MESSAGE.replace(
            '"emitted_at":"2026-07-27T01:00:00Z"',
            '"emitted_at":"2026-07-27T01:00:00Z","claim":{"member_id":"secret"}',
        )

        with self.assertRaisesRegex(ClaimWakeupContractError, "incompatible schema"):
            _parse_message(ElementTree.fromstring(invalid))

    def test_parse_message_rejects_invalid_timestamp(self) -> None:
        invalid = VALID_MESSAGE.replace("2026-07-27T01:00:00Z", "not-a-timestamp")

        with self.assertRaisesRegex(ClaimWakeupContractError, "ISO timestamp"):
            _parse_message(ElementTree.fromstring(invalid))

    def test_receive_uses_bounded_queue_parameters(self) -> None:
        queue = AzureClaimWakeupQueue(
            "https://storage.queue.core.windows.net/claim-scoring/",
            credential=Mock(),
            visibility_timeout_seconds=30,
        )
        queue._request = Mock(return_value=f"<QueueMessagesList>{VALID_MESSAGE}</QueueMessagesList>".encode())

        messages = queue.receive(999)

        self.assertEqual(len(messages), 1)
        queue._request.assert_called_once_with(
            "https://storage.queue.core.windows.net/claim-scoring/messages?numofmessages=32&visibilitytimeout=60",
            method="GET",
        )

    def test_delete_url_encodes_message_identity_and_receipt(self) -> None:
        queue = AzureClaimWakeupQueue(
            "https://storage.queue.core.windows.net/claim-scoring",
            credential=Mock(),
        )
        queue._request = Mock(return_value=b"")
        message = _parse_message(ElementTree.fromstring(VALID_MESSAGE))

        queue.delete(message)

        queue._request.assert_called_once_with(
            "https://storage.queue.core.windows.net/claim-scoring/messages/message-1?popreceipt=receipt%2Fwith%2Bsymbols",
            method="DELETE",
        )

    def test_environment_factory_requires_the_queue_url(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ClaimWakeupContractError, "CLAIM_SCORING_QUEUE_URL"):
                create_claim_wakeup_queue_from_environment()

    @patch("claimguard_report_producer.event_queue.urlopen")
    def test_request_uses_managed_identity_bearer_token(self, urlopen) -> None:
        credential = Mock()
        credential.get_token.return_value = Mock(token="storage-token")
        response = Mock()
        response.read.return_value = b"<QueueMessagesList />"
        urlopen.return_value.__enter__.return_value = response
        queue = AzureClaimWakeupQueue(
            "https://storage.queue.core.windows.net/claim-scoring",
            credential=credential,
        )

        body = queue._request(
            "https://storage.queue.core.windows.net/claim-scoring/messages",
            method="GET",
        )

        self.assertEqual(body, b"<QueueMessagesList />")
        credential.get_token.assert_called_once_with("https://storage.azure.com/.default")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.headers["Authorization"], "Bearer storage-token")
