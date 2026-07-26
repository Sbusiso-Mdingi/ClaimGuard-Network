from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from unittest import TestCase

from claimguard_report_producer.outbox import (
    CLAIM_PROCESSING_AGGREGATE_TYPE,
    CLAIM_PROCESSING_JOB_TYPE,
    OutboxJob,
)
from claimguard_report_producer.prospective_worker import (
    ProspectiveAwareReportProducerWorker,
)
from claimguard_report_producer.worker import WorkerConfigurationError


BASELINE_DEPLOYMENT = "claimguard-claim-fraud-baseline:1.0.0"
CANDIDATE_DEPLOYMENT = "claimguard-claim-fraud-ensemble:2.0.0"


def job(deployment_id: str) -> OutboxJob:
    return OutboxJob(
        id=f"job-{deployment_id}",
        tenant_id="tenant-1",
        job_type=CLAIM_PROCESSING_JOB_TYPE,
        aggregate_type=CLAIM_PROCESSING_AGGREGATE_TYPE,
        aggregate_id="aggregate-1",
        correlation_id="correlation-1",
        payload={},
        status="processing",
        attempt_count=0,
        max_attempts=3,
        detection_strategy_id=2,
        strategy_type="approved_model",
        model_deployment_id=deployment_id,
    )


class RecordingRegistry:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.clients = {
            BASELINE_DEPLOYMENT: SimpleNamespace(
                deployment_id=BASELINE_DEPLOYMENT
            ),
            CANDIDATE_DEPLOYMENT: SimpleNamespace(
                deployment_id=CANDIDATE_DEPLOYMENT
            ),
        }

    def client_for(self, deployment_id: str):
        self.calls.append(deployment_id)
        return self.clients[deployment_id]


def worker_with(*, registry=None, client=None):
    worker = ProspectiveAwareReportProducerWorker.__new__(
        ProspectiveAwareReportProducerWorker
    )
    worker.prospective_registry = registry
    worker.prospective_client = client
    return worker


class ProspectiveWorkerRoutingTests(TestCase):
    def test_each_job_resolves_the_client_for_its_exact_pinned_deployment(
        self,
    ) -> None:
        registry = RecordingRegistry()
        worker = worker_with(registry=registry)

        baseline = worker._prospective_client_for(job(BASELINE_DEPLOYMENT))
        candidate = worker._prospective_client_for(job(CANDIDATE_DEPLOYMENT))

        self.assertEqual(baseline.deployment_id, BASELINE_DEPLOYMENT)
        self.assertEqual(candidate.deployment_id, CANDIDATE_DEPLOYMENT)
        self.assertEqual(
            registry.calls,
            [BASELINE_DEPLOYMENT, CANDIDATE_DEPLOYMENT],
        )

    def test_injected_single_client_cannot_process_another_deployment(
        self,
    ) -> None:
        worker = worker_with(
            client=SimpleNamespace(deployment_id=BASELINE_DEPLOYMENT)
        )

        with self.assertRaisesRegex(
            WorkerConfigurationError,
            "does not match",
        ):
            worker._prospective_client_for(job(CANDIDATE_DEPLOYMENT))

    def test_approved_model_job_requires_a_pinned_deployment(self) -> None:
        worker = worker_with(registry=RecordingRegistry())

        with self.assertRaisesRegex(
            WorkerConfigurationError,
            "require a pinned",
        ):
            worker._prospective_client_for(
                replace(job(BASELINE_DEPLOYMENT), model_deployment_id=None)
            )
