from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from claimguard_report_producer.runtime import DetectionReportProducer


class FakePublisher:
    def __init__(self) -> None:
        self.published = []

    def publish(self, report, *, run_id=None):
        self.published.append((report, run_id))

        class _Result:
            version = "v-test"
            report_path = "reports/report-v-test.json"
            metadata_path = "metadata/metadata-v-test.json"
            latest_pointer_path = "latest.json"

        return _Result()


class RuntimeTests(TestCase):
    def test_runtime_runs_detector_and_publishes(self) -> None:
        publisher = FakePublisher()

        def detector(data_dir: Path, top_n: int):
            self.assertEqual(top_n, 7)
            return {"schemes": [{"scheme_id": "S1"}]}

        runtime = DetectionReportProducer(
            data_dir=Path("/tmp/data"),
            publisher=publisher,
            top_n=7,
            max_retries=0,
            detector=detector,
        )

        result = runtime.run(trigger="manual")
        self.assertEqual(result.attempt_count, 1)
        self.assertEqual(result.published.version, "v-test")
        self.assertEqual(len(publisher.published), 1)

    def test_runtime_retries_and_succeeds(self) -> None:
        publisher = FakePublisher()
        attempts = {"count": 0}

        def detector(_data_dir: Path, _top_n: int):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RuntimeError("transient")
            return {"schemes": []}

        runtime = DetectionReportProducer(
            data_dir=Path("/tmp/data"),
            publisher=publisher,
            max_retries=1,
            retry_delay_seconds=0,
            detector=detector,
        )

        result = runtime.run(trigger="scheduled")
        self.assertEqual(result.attempt_count, 2)
        self.assertEqual(len(publisher.published), 1)

    def test_runtime_raises_after_retries(self) -> None:
        publisher = FakePublisher()

        def detector(_data_dir: Path, _top_n: int):
            raise RuntimeError("hard failure")

        runtime = DetectionReportProducer(
            data_dir=Path("/tmp/data"),
            publisher=publisher,
            max_retries=1,
            retry_delay_seconds=0,
            detector=detector,
        )

        with self.assertRaises(RuntimeError):
            runtime.run(trigger="queue")
