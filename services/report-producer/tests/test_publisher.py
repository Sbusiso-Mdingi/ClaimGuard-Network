from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.publisher import AzureBlobReportPublisher, FileReportPublisher


class FakeContainerClient:
    def __init__(self) -> None:
        self.blobs: dict[str, str] = {}

    def upload_blob(self, *, name: str, data: str, overwrite: bool) -> None:
        if not overwrite and name in self.blobs:
            raise ValueError("blob already exists")
        self.blobs[name] = data


class PublisherTests(TestCase):
    def test_file_publisher_writes_report_metadata_and_latest_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            publisher = FileReportPublisher(Path(temp_dir))
            published = publisher.publish({"detection": {"risk_score": {"riskScore": 91}}}, run_id="manual-1")

            self.assertTrue(Path(published.report_path).exists())
            self.assertTrue(Path(published.metadata_path).exists())
            self.assertTrue(Path(published.latest_pointer_path).exists())

            pointer = json.loads(Path(published.latest_pointer_path).read_text(encoding="utf-8"))
            self.assertEqual(pointer["version"], published.version)
            self.assertIn("reportBlobName", pointer)
            self.assertIn("metadataBlobName", pointer)

    def test_azure_blob_publisher_writes_versioned_artifacts(self) -> None:
        container = FakeContainerClient()
        publisher = AzureBlobReportPublisher(container_client=container)

        published = publisher.publish({"schemes": [{"scheme_id": "S1"}]}, run_id="scheduled-1")

        self.assertIn(published.report_path, container.blobs)
        self.assertIn(published.metadata_path, container.blobs)
        self.assertIn(published.latest_pointer_path, container.blobs)

        latest = json.loads(container.blobs[published.latest_pointer_path])
        self.assertEqual(latest["version"], published.version)
        self.assertEqual(latest["reportBlobName"], published.report_path)
