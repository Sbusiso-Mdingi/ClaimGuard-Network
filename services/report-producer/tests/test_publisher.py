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
            published = publisher.publish(
                {"detection": {"risk_score": {"riskScore": 91}}},
                run_id="manual-1",
                tenant_id="tenant_alpha",
            )

            self.assertTrue(Path(published.report_path).exists())
            self.assertTrue(Path(published.metadata_path).exists())
            self.assertTrue(Path(published.latest_pointer_path).exists())
            self.assertIn("tenant_alpha/versions/", published.report_path)
            self.assertTrue(published.latest_pointer_path.endswith("tenant_alpha/latest.json"))

            pointer = json.loads(Path(published.latest_pointer_path).read_text(encoding="utf-8"))
            self.assertEqual(pointer["version"], published.version)
            self.assertEqual(pointer["tenantId"], "tenant_alpha")
            self.assertIn("reportBlobName", pointer)
            self.assertIn("metadataBlobName", pointer)

    def test_file_publisher_uses_default_tenant_when_not_supplied(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            publisher = FileReportPublisher(Path(temp_dir))
            published = publisher.publish({"schemes": []}, run_id="manual-1")

            self.assertIn("tenant_default/versions/", published.report_path)
            self.assertTrue(published.latest_pointer_path.endswith("tenant_default/latest.json"))

    def test_azure_blob_publisher_writes_versioned_artifacts(self) -> None:
        container = FakeContainerClient()
        publisher = AzureBlobReportPublisher(container_client=container)

        published = publisher.publish(
            {"schemes": [{"scheme_id": "S1"}]},
            run_id="scheduled-1",
            tenant_id="tenant_beta",
        )

        self.assertIn(published.report_path, container.blobs)
        self.assertIn(published.metadata_path, container.blobs)
        self.assertIn(published.latest_pointer_path, container.blobs)
        self.assertEqual(published.latest_pointer_path, "tenant_beta/latest.json")
        self.assertTrue(published.report_path.startswith("tenant_beta/versions/"))

        latest = json.loads(container.blobs[published.latest_pointer_path])
        self.assertEqual(latest["version"], published.version)
        self.assertEqual(latest["reportBlobName"], published.report_path)
        self.assertEqual(latest["tenantId"], "tenant_beta")

    def test_azure_blob_publisher_keeps_tenant_reports_isolated(self) -> None:
        container = FakeContainerClient()
        publisher = AzureBlobReportPublisher(container_client=container)

        alpha = publisher.publish({"schemes": [{"scheme_id": "S1"}]}, run_id="run-1", tenant_id="tenant_alpha")
        beta = publisher.publish({"schemes": [{"scheme_id": "S2"}]}, run_id="run-2", tenant_id="tenant_beta")

        self.assertIn(alpha.latest_pointer_path, container.blobs)
        self.assertIn(beta.latest_pointer_path, container.blobs)
        self.assertNotEqual(alpha.latest_pointer_path, beta.latest_pointer_path)
        self.assertNotEqual(alpha.report_path, beta.report_path)
