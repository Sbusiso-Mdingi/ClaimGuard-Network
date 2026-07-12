from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .publisher import PublishedReport, ReportPublisher


def _default_detector(data_dir: Path, top_n: int) -> dict[str, object]:
    from claimguard_detection_engine.detector import analyze_directory

    return analyze_directory(data_dir, top_n=top_n)


@dataclass(frozen=True)
class ProducerRunResult:
    published: PublishedReport
    attempt_count: int
    trigger: str


class DetectionReportProducer:
    def __init__(
        self,
        *,
        data_dir: Path,
        publisher: ReportPublisher,
        top_n: int = 10,
        max_retries: int = 2,
        retry_delay_seconds: float = 1.0,
        detector: Callable[[Path, int], dict[str, object]] | None = None,
        logger=None,
    ) -> None:
        self.data_dir = data_dir
        self.publisher = publisher
        self.top_n = top_n
        self.max_retries = max_retries
        self.retry_delay_seconds = retry_delay_seconds
        self.detector = detector or _default_detector
        self.logger = logger

    def run(self, *, trigger: str = "manual") -> ProducerRunResult:
        attempt = 0
        last_error: Exception | None = None
        run_started_at = time.perf_counter()

        while attempt <= self.max_retries:
            attempt += 1
            attempt_started_at = time.perf_counter()
            try:
                self._log(
                    "info",
                    "producer_attempt_started",
                    {
                        "attempt": attempt,
                        "trigger": trigger,
                        "max_retries": self.max_retries,
                        "top_n": self.top_n,
                    },
                )
                report = self.detector(self.data_dir, self.top_n)
                published = self.publisher.publish(report, run_id=f"{trigger}-{attempt}")
                self._log(
                    "info",
                    "producer_attempt_succeeded",
                    {
                        "attempt": attempt,
                        "trigger": trigger,
                        "version": published.version,
                        "report_path": published.report_path,
                        "latest_pointer_path": published.latest_pointer_path,
                        "attempt_duration_ms": round((time.perf_counter() - attempt_started_at) * 1000, 3),
                    },
                )
                self._log(
                    "info",
                    "producer_run_completed",
                    {
                        "trigger": trigger,
                        "attempt_count": attempt,
                        "run_duration_ms": round((time.perf_counter() - run_started_at) * 1000, 3),
                    },
                )
                return ProducerRunResult(published=published, attempt_count=attempt, trigger=trigger)
            except Exception as error:  # noqa: BLE001
                last_error = error
                self._log(
                    "error",
                    "producer_attempt_failed",
                    {
                        "attempt": attempt,
                        "trigger": trigger,
                        "message": str(error),
                        "attempt_duration_ms": round((time.perf_counter() - attempt_started_at) * 1000, 3),
                    },
                )
                if attempt > self.max_retries:
                    break
                time.sleep(self.retry_delay_seconds)

        self._log(
            "error",
            "producer_run_failed",
            {
                "trigger": trigger,
                "attempt_count": attempt,
                "run_duration_ms": round((time.perf_counter() - run_started_at) * 1000, 3),
            },
        )
        raise RuntimeError("Detection report production failed after retries") from last_error

    def _log(self, level: str, event: str, details: dict[str, object]) -> None:
        payload = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level,
            "service": "report-producer",
            "event": event,
            **details,
        }

        if not self.logger:
            rendered = json.dumps(payload)
            print(rendered)
            return

        method = getattr(self.logger, level, None)
        if callable(method):
            method(json.dumps(payload))
