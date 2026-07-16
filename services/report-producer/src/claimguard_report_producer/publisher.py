from __future__ import annotations

import json
import os
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


@dataclass(frozen=True)
class RetentionCandidate:
    version: str
    report_path: str
    metadata_path: str


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
    def __init__(self, base_dir: Path, *, retention_versions: int | None = None) -> None:
        self.base_dir = base_dir
        self.retention_versions = retention_versions

    @staticmethod
    def _atomic_write(path: Path, payload: str) -> None:
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        temporary.write_text(payload, encoding="utf-8")
        os.replace(temporary, path)

    @staticmethod
    def _write_immutable(path: Path, payload: str, *, report_id: str, watermark: str) -> None:
        if path.exists():
            existing = json.loads(path.read_text(encoding="utf-8"))
            existing_metadata = existing.get("metadata", {}) if isinstance(existing, dict) else {}
            existing_source = existing_metadata.get("source", {}) if isinstance(existing_metadata, dict) else {}
            if existing_metadata.get("reportId") != report_id or existing_source.get("watermark") != watermark:
                raise RuntimeError("An immutable report artifact already exists with different snapshot identity.")
            return
        FileReportPublisher._atomic_write(path, payload)

    @staticmethod
    def _write_immutable_pointer(path: Path, payload: str, *, report_id: str, watermark: str) -> None:
        if path.exists():
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing.get("reportId") != report_id or existing.get("sourceWatermark") != watermark:
                raise RuntimeError("Immutable version metadata already exists with different snapshot identity.")
            return
        FileReportPublisher._atomic_write(path, payload)

    def list_retention_candidates(self, *, tenant_id: str, keep_version: str) -> list[RetentionCandidate]:
        if not self.retention_versions or self.retention_versions < 1:
            return []
        versions_dir = self.base_dir / tenant_id / "versions"
        reports = sorted(versions_dir.glob("report-*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        candidates = [path for path in reports[self.retention_versions :] if path.stem.removeprefix("report-") != keep_version]
        return [
            RetentionCandidate(
                version=path.stem.removeprefix("report-"),
                report_path=str(path),
                metadata_path=str(versions_dir / f"metadata-{path.stem.removeprefix('report-')}.json"),
            )
            for path in candidates
        ]

    def publish(
        self,
        report: dict[str, object],
        *,
        run_id: str | None = None,
        tenant_id: str | None = None,
    ) -> PublishedReport:
        metadata = report.get("metadata") if isinstance(report, dict) else None
        source = metadata.get("source") if isinstance(metadata, dict) else None
        version = str(metadata.get("reportId") or "") if isinstance(metadata, dict) else ""
        watermark = str(source.get("watermark") or "") if isinstance(source, dict) else ""
        report_tenant = metadata.get("tenant", {}).get("tenantId") if isinstance(metadata, dict) else None
        if len(version) != 64 or not watermark or any(character not in "0123456789abcdef" for character in version):
            raise ValueError("A canonical hexadecimal reportId and source watermark are required for publication.")
        tenant_partition = (tenant_id or "tenant_default").strip() or "tenant_default"
        if report_tenant != tenant_partition:
            raise ValueError("The report tenant does not match the storage partition.")
        tenant_root = self.base_dir / tenant_partition
        versions_dir = tenant_root / "versions"
        latest_path = tenant_root / "latest.json"
        metadata_path = tenant_root / "metadata.json"

        versions_dir.mkdir(parents=True, exist_ok=True)

        report_path = versions_dir / f"report-{version}.json"
        version_metadata_path = versions_dir / f"metadata-{version}.json"

        payload = {
            "version": version,
            "reportId": version,
            "contractVersion": report.get("contractVersion"),
            "sourceWatermark": watermark,
            "runId": run_id,
            "tenantId": tenant_partition,
            "generatedAt": metadata.get("generatedAt"),
            "reportBlobName": str(report_path.relative_to(self.base_dir)).replace("\\", "/"),
            "metadataBlobName": str(metadata_path.relative_to(self.base_dir)).replace("\\", "/"),
            "versionMetadataBlobName": str(version_metadata_path.relative_to(self.base_dir)).replace("\\", "/"),
        }

        report_json = json.dumps(report, indent=2, sort_keys=True) + "\n"
        pointer_json = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        self._write_immutable(report_path, report_json, report_id=version, watermark=watermark)
        self._write_immutable_pointer(
            version_metadata_path,
            pointer_json,
            report_id=version,
            watermark=watermark,
        )
        self._atomic_write(metadata_path, pointer_json)
        self._atomic_write(latest_path, pointer_json)

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
        metadata = report.get("metadata") if isinstance(report, dict) else None
        source = metadata.get("source") if isinstance(metadata, dict) else None
        version = str(metadata.get("reportId") or "") if isinstance(metadata, dict) else ""
        watermark = str(source.get("watermark") or "") if isinstance(source, dict) else ""
        report_tenant = metadata.get("tenant", {}).get("tenantId") if isinstance(metadata, dict) else None
        if len(version) != 64 or not watermark or any(character not in "0123456789abcdef" for character in version):
            raise ValueError("A canonical hexadecimal reportId and source watermark are required for publication.")
        tenant_partition = (tenant_id or "tenant_default").strip() or "tenant_default"
        if report_tenant != tenant_partition:
            raise ValueError("The report tenant does not match the storage partition.")
        report_blob_name = f"{tenant_partition}/versions/report-{version}.json"
        version_metadata_blob_name = f"{tenant_partition}/versions/metadata-{version}.json"
        metadata_blob_name = f"{tenant_partition}/metadata.json"
        latest_blob_name = f"{tenant_partition}/latest.json"

        pointer = {
            "version": version,
            "reportId": version,
            "contractVersion": report.get("contractVersion"),
            "sourceWatermark": watermark,
            "runId": run_id,
            "tenantId": tenant_partition,
            "generatedAt": metadata.get("generatedAt"),
            "reportBlobName": report_blob_name,
            "metadataBlobName": metadata_blob_name,
            "versionMetadataBlobName": version_metadata_blob_name,
        }

        try:
            self.container_client.upload_blob(
                name=report_blob_name,
                data=json.dumps(report, sort_keys=True),
                overwrite=False,
            )
        except Exception as error:  # Azure and test doubles expose different exists exceptions.
            try:
                existing = json.loads(
                    self.container_client.get_blob_client(report_blob_name).download_blob().readall()
                )
            except Exception:
                raise error
            existing_metadata = existing.get("metadata", {})
            if existing_metadata.get("reportId") != version or existing_metadata.get("source", {}).get("watermark") != watermark:
                raise RuntimeError("An immutable report blob already exists with different snapshot identity.") from error
        try:
            self.container_client.upload_blob(
                name=version_metadata_blob_name,
                data=json.dumps(pointer, sort_keys=True),
                overwrite=False,
            )
        except Exception as error:
            try:
                existing_pointer = json.loads(
                    self.container_client.get_blob_client(version_metadata_blob_name).download_blob().readall()
                )
            except Exception:
                raise error
            if (
                existing_pointer.get("reportId") != version
                or existing_pointer.get("sourceWatermark") != watermark
            ):
                raise RuntimeError(
                    "Immutable version metadata already exists with different snapshot identity."
                ) from error
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
