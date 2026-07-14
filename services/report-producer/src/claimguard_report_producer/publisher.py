from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4


@dataclass(frozen=True)
class PublishedReport:
    version: str
    report_path: str
    metadata_path: str
    latest_pointer_path: str


class ReportPublisher(Protocol):
    def publish(
        self,
        report: dict[str, object],
        *,
        run_id: str | None = None,
        tenant_id: str | None = None,
    ) -> PublishedReport:
        ...


def generate_version(now: datetime | None = None) -> str:
    timestamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    return f"{timestamp}-{uuid4().hex[:8]}"


class FileReportPublisher:
    def __init__(self, base_dir: Path) -> None:
        self.base_dir = base_dir

    def publish(
        self,
        report: dict[str, object],
        *,
        run_id: str | None = None,
        tenant_id: str | None = None,
    ) -> PublishedReport:
        version = generate_version()
        tenant_partition = (tenant_id or "tenant_default").strip() or "tenant_default"
        tenant_root = self.base_dir / tenant_partition
        versions_dir = tenant_root / "versions"
        latest_path = tenant_root / "latest.json"
        metadata_path = tenant_root / "metadata.json"

        versions_dir.mkdir(parents=True, exist_ok=True)

        report_path = versions_dir / f"report-{version}.json"
        version_metadata_path = versions_dir / f"metadata-{version}.json"

        payload = {
            "version": version,
            "runId": run_id,
            "tenantId": tenant_partition,
            "generatedAt": datetime.now(UTC).isoformat(),
            "reportBlobName": str(report_path.relative_to(self.base_dir)).replace("\\", "/"),
            "metadataBlobName": str(metadata_path.relative_to(self.base_dir)).replace("\\", "/"),
            "versionMetadataBlobName": str(version_metadata_path.relative_to(self.base_dir)).replace("\\", "/"),
        }

        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        version_metadata_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        metadata_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        latest_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        return PublishedReport(
            version=version,
            report_path=str(report_path),
            metadata_path=str(metadata_path),
            latest_pointer_path=str(latest_path),
        )


class AzureBlobReportPublisher:
    def __init__(
        self,
        *,
        container_client,
        reports_prefix: str = "reports",
        metadata_prefix: str = "metadata",
        latest_blob_name: str = "latest.json",
    ) -> None:
        self.container_client = container_client
        self.reports_prefix = reports_prefix.strip("/")
        self.metadata_prefix = metadata_prefix.strip("/")
        self.latest_blob_name = latest_blob_name

    @classmethod
    def from_environment(
        cls,
        *,
        account_url: str | None = None,
        container_name: str | None = None,
        connection_string: str | None = None,
    ) -> "AzureBlobReportPublisher":
        try:
            from azure.storage.blob import BlobServiceClient
        except ModuleNotFoundError as error:
            raise RuntimeError("azure-storage-blob package is required for AzureBlobReportPublisher") from error

        account_url = account_url or __import__("os").environ.get("REPORT_STORAGE_ACCOUNT_URL")
        container_name = container_name or __import__("os").environ.get("REPORT_STORAGE_CONTAINER")
        connection_string = connection_string or __import__("os").environ.get("AZURE_STORAGE_CONNECTION_STRING")

        if not container_name:
            raise ValueError("REPORT_STORAGE_CONTAINER is required for Azure blob publishing.")

        if connection_string:
            blob_service_client = BlobServiceClient.from_connection_string(connection_string)
        else:
            if not account_url:
                raise ValueError("REPORT_STORAGE_ACCOUNT_URL is required when AZURE_STORAGE_CONNECTION_STRING is absent.")
            try:
                from azure.identity import DefaultAzureCredential
            except ModuleNotFoundError as error:
                raise RuntimeError("azure-identity package is required for managed identity authentication") from error
            blob_service_client = BlobServiceClient(account_url=account_url, credential=DefaultAzureCredential())

        container_client = blob_service_client.get_container_client(container_name)
        return cls(container_client=container_client)

    def publish(
        self,
        report: dict[str, object],
        *,
        run_id: str | None = None,
        tenant_id: str | None = None,
    ) -> PublishedReport:
        version = generate_version()
        tenant_partition = (tenant_id or "tenant_default").strip() or "tenant_default"
        report_blob_name = f"{tenant_partition}/versions/report-{version}.json"
        version_metadata_blob_name = f"{tenant_partition}/versions/metadata-{version}.json"
        metadata_blob_name = f"{tenant_partition}/metadata.json"
        latest_blob_name = f"{tenant_partition}/latest.json"

        pointer = {
            "version": version,
            "runId": run_id,
            "tenantId": tenant_partition,
            "generatedAt": datetime.now(UTC).isoformat(),
            "reportBlobName": report_blob_name,
            "metadataBlobName": metadata_blob_name,
            "versionMetadataBlobName": version_metadata_blob_name,
        }

        self.container_client.upload_blob(
            name=report_blob_name,
            data=json.dumps(report, sort_keys=True),
            overwrite=True,
        )
        self.container_client.upload_blob(
            name=version_metadata_blob_name,
            data=json.dumps(pointer, sort_keys=True),
            overwrite=True,
        )
        self.container_client.upload_blob(
            name=metadata_blob_name,
            data=json.dumps(pointer, sort_keys=True),
            overwrite=True,
        )
        self.container_client.upload_blob(
            name=latest_blob_name,
            data=json.dumps(pointer, sort_keys=True),
            overwrite=True,
        )

        return PublishedReport(
            version=version,
            report_path=report_blob_name,
            metadata_path=metadata_blob_name,
            latest_pointer_path=latest_blob_name,
        )
