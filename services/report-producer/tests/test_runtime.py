from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.runtime import DetectionReportProducer
from claimguard_report_producer.contract import ReportContractError


def canonical_report(tenant_id: str = "tenant_default") -> dict[str, object]:
    return {
        "contractVersion": "1.0",
        "metadata": {
            "reportId": "a" * 64,
            "tenant": {"tenantId": tenant_id, "tenantSlug": None, "displayName": None},
            "generatedAt": "2026-07-16T00:00:00+00:00",
            "snapshotCutoff": "2026-07-16T00:00:00+00:00",
            "source": {"type": "test", "watermark": "w1", "historicalWindow": None},
            "includedCounts": {"claims": 0, "providers": 0, "members": 0},
        },
        "summary": {"totalClaims": 0, "totalClaimedAmount": 0},
        "claims": [],
        "providers": [],
        "members": [],
        "graph": {"nodes": [], "edges": [], "summary": {}},
        "risk": {},
        "history": {},
    }


class FakePublisher:
    def __init__(self) -> None:
        self.published = []

    def publish(self, report, *, run_id=None, tenant_id=None):
        self.published.append((report, run_id, tenant_id))

        class Result:
            version = "a" * 64
            report_path = "report.json"
            metadata_path = "metadata.json"
            latest_pointer_path = "latest.json"

        return Result()


class RuntimeTests(TestCase):
    def test_runtime_validates_then_publishes(self) -> None:
        publisher = FakePublisher()
        runtime = DetectionReportProducer(
            data_dir=Path("/tmp/data"),
            publisher=publisher,
            top_n=7,
            max_retries=0,
            detector=lambda _path, top_n: canonical_report() if top_n == 7 else {},
        )
        result = runtime.run(trigger="manual")
        self.assertEqual(result.attempt_count, 1)
        self.assertEqual(publisher.published[0][2], "tenant_default")

    def test_runtime_retries_transient_detector_failure(self) -> None:
        publisher = FakePublisher()
        attempts = 0

        def detector(_path, _top_n):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise TimeoutError("transient")
            return canonical_report()

        runtime = DetectionReportProducer(
            data_dir=Path("."), publisher=publisher, detector=detector, max_retries=1, retry_delay_seconds=0
        )
        self.assertEqual(runtime.run(trigger="scheduled").attempt_count, 2)

    def test_invalid_report_never_reaches_publisher(self) -> None:
        publisher = FakePublisher()
        runtime = DetectionReportProducer(
            data_dir=Path("."), publisher=publisher, detector=lambda _path, _top_n: {"schemes": []}, max_retries=0
        )
        with self.assertRaises(ReportContractError):
            runtime.run(trigger="manual")
        self.assertEqual(publisher.published, [])

    def test_report_tenant_must_match_partition(self) -> None:
        publisher = FakePublisher()
        runtime = DetectionReportProducer(
            data_dir=Path("."),
            publisher=publisher,
            tenant_id="tenant_alpha",
            detector=lambda _path, _top_n: canonical_report("tenant_beta"),
            max_retries=0,
        )
        with self.assertRaises(ReportContractError):
            runtime.run(trigger="manual")
        self.assertEqual(publisher.published, [])
