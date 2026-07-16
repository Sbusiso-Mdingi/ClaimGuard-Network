from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.publisher import AzureBlobReportPublisher, FileReportPublisher


def report(tenant_id: str, report_id: str = "a" * 64, watermark: str = "w1") -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": report_id,
            "tenant": {"tenantId": tenant_id},
            "generatedAt": "2026-07-16T00:00:00+00:00",
            "source": {"watermark": watermark},
        },
    }


class FakeDownload:
    def __init__(self, value: str) -> None:
        self.value = value

    def readall(self) -> str:
        return self.value


class FakeBlob:
    def __init__(self, container, name: str) -> None:
        self.container = container
        self.name = name

    def download_blob(self):
        return FakeDownload(self.container.blobs[self.name])


class FakeContainerClient:
    def __init__(self) -> None:
        self.blobs: dict[str, str] = {}

    def upload_blob(self, *, name: str, data: str, overwrite: bool) -> None:
        if not overwrite and name in self.blobs:
            raise ValueError("blob already exists")
        self.blobs[name] = data

    def get_blob_client(self, name: str):
        return FakeBlob(self, name)


class FailingLatestContainer(FakeContainerClient):
    def __init__(self) -> None:
        super().__init__()
        self.fail_latest = False

    def upload_blob(self, *, name: str, data: str, overwrite: bool) -> None:
        if self.fail_latest and name.endswith("/latest.json"):
            raise TimeoutError("latest pointer unavailable")
        super().upload_blob(name=name, data=data, overwrite=overwrite)


class PublisherTests(TestCase):
    def test_file_publication_orders_immutable_report_before_latest_and_reuses_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            publisher = FileReportPublisher(Path(temp_dir), retention_versions=2)
            first = publisher.publish(report("tenant_alpha"), run_id="run-1", tenant_id="tenant_alpha")
            retry = publisher.publish(report("tenant_alpha"), run_id="run-2", tenant_id="tenant_alpha")
            self.assertEqual(first.version, retry.version)
            self.assertEqual(len(list((Path(temp_dir) / "tenant_alpha" / "versions").glob("report-*.json"))), 1)
            pointer = json.loads(Path(first.latest_pointer_path).read_text(encoding="utf-8"))
            self.assertEqual(pointer["reportId"], "a" * 64)
            self.assertEqual(pointer["sourceWatermark"], "w1")
            self.assertEqual(publisher.list_retention_candidates(tenant_id="tenant_alpha", keep_version=first.version), [])

    def test_file_publication_rejects_partition_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(ValueError):
                FileReportPublisher(Path(temp_dir)).publish(report("tenant_beta"), tenant_id="tenant_alpha")

    def test_azure_publication_reuses_immutable_blob_and_updates_pointer(self) -> None:
        container = FakeContainerClient()
        publisher = AzureBlobReportPublisher(container_client=container)
        first = publisher.publish(report("tenant_beta"), run_id="run-1", tenant_id="tenant_beta")
        retry = publisher.publish(report("tenant_beta"), run_id="run-2", tenant_id="tenant_beta")
        self.assertEqual(first.report_path, retry.report_path)
        self.assertEqual(json.loads(container.blobs[first.latest_pointer_path])["reportId"], "a" * 64)

    def test_same_report_id_with_different_watermark_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            publisher = FileReportPublisher(Path(temp_dir))
            publisher.publish(report("tenant_alpha"), tenant_id="tenant_alpha")
            with self.assertRaises(RuntimeError):
                publisher.publish(report("tenant_alpha", watermark="w2"), tenant_id="tenant_alpha")

    def test_latest_pointer_failure_preserves_previous_valid_pointer(self) -> None:
        container = FailingLatestContainer()
        publisher = AzureBlobReportPublisher(container_client=container)
        first = publisher.publish(report("tenant_alpha", report_id="a" * 64), tenant_id="tenant_alpha")
        previous_pointer = container.blobs[first.latest_pointer_path]
        container.fail_latest = True
        with self.assertRaises(TimeoutError):
            publisher.publish(
                report("tenant_alpha", report_id="b" * 64, watermark="w2"),
                tenant_id="tenant_alpha",
            )
        self.assertEqual(container.blobs[first.latest_pointer_path], previous_pointer)
        self.assertIn("tenant_alpha/versions/report-" + "b" * 64 + ".json", container.blobs)
