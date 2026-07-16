from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .contract import ReportContractError, validate_detection_report
from .publisher import PublishedReport, ReportPublisher


def _default_detector(data_dir: Path, top_n: int, tenant_id: str, correlation_id: str) -> dict[str, object]:
    from claimguard_detection_engine.detector import analyze_directory

    return analyze_directory(data_dir, top_n=top_n, tenant_id=tenant_id, correlation_id=correlation_id)


@dataclass(frozen=True)
class ProducerRunResult:
    published: PublishedReport
    attempt_count: int
    trigger: str
    tenant_id: str


class DetectionReportProducer:
    def __init__(
        self,
        *,
        data_dir: Path,
        publisher: ReportPublisher,
        top_n: int = 10,
        max_retries: int = 2,
        retry_delay_seconds: float = 1.0,
        detector: Callable[..., dict[str, object]] | None = None,
        tenant_id: str | None = None,
        logger=None,
    ) -> None:
        self.data_dir = data_dir
        self.publisher = publisher
        self.top_n = top_n
        self.max_retries = max_retries
        self.retry_delay_seconds = retry_delay_seconds
        self.detector = detector or _default_detector
        self.tenant_id = str(tenant_id or "").strip()
        if not self.tenant_id:
            raise ValueError("An explicit canonical tenant_id is required.")
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
                        "tenant_id": self.tenant_id,
                    },
                )
                if self.detector is _default_detector:
                    report = self.detector(self.data_dir, self.top_n, self.tenant_id, trigger)
                else:
                    report = self.detector(self.data_dir, self.top_n)
                validate_detection_report(report, expected_tenant_id=self.tenant_id)
                published = self.publisher.publish(
                    report,
                    run_id=f"{trigger}-{self.tenant_id}",
                    tenant_id=self.tenant_id,
                )
                self._log(
                    "info",
                    "producer_attempt_succeeded",
                    {
                        "attempt": attempt,
                        "trigger": trigger,
                        "version": published.version,
                        "report_path": published.report_path,
                        "latest_pointer_path": published.latest_pointer_path,
                        "tenant_id": self.tenant_id,
                        "attempt_duration_ms": round((time.perf_counter() - attempt_started_at) * 1000, 3),
                    },
                )
                self._log(
                    "info",
                    "producer_run_completed",
                    {
                        "trigger": trigger,
                        "attempt_count": attempt,
                        "tenant_id": self.tenant_id,
                        "run_duration_ms": round((time.perf_counter() - run_started_at) * 1000, 3),
                    },
                )
                return ProducerRunResult(
                    published=published,
                    attempt_count=attempt,
                    trigger=trigger,
                    tenant_id=self.tenant_id,
                )
            except Exception as error:  # noqa: BLE001
                last_error = error
                self._log(
                    "error",
                    "producer_attempt_failed",
                    {
                        "attempt": attempt,
                        "trigger": trigger,
                        "tenant_id": self.tenant_id,
                        "error_type": type(error).__name__,
                        "attempt_duration_ms": round((time.perf_counter() - attempt_started_at) * 1000, 3),
                    },
                )
                if isinstance(error, ReportContractError):
                    raise
                if attempt > self.max_retries:
                    break
                time.sleep(self.retry_delay_seconds)

        self._log(
            "error",
            "producer_run_failed",
            {
                "trigger": trigger,
                "attempt_count": attempt,
                "tenant_id": self.tenant_id,
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
