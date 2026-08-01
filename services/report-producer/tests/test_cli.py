import io
import json
import runpy
import sys
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, Mock, patch

from claimguard_report_producer.cli import main, run_worker_command


class WorkerCliTests(TestCase):
    @patch("claimguard_report_producer.cli.create_claim_wakeup_queue_from_environment")
    @patch("claimguard_report_producer.cli.create_event_worker_from_environment")
    def test_event_processes_exact_job_in_a_scheme_slot(
        self,
        create_worker,
        create_queue,
    ) -> None:
        message = SimpleNamespace(
            organisation_id="organisation-1",
            outbox_job_id="job-1",
        )
        queue = Mock()
        queue.receive.return_value = [message]
        create_queue.return_value = queue

        cursor = MagicMock()
        cursor.fetchone.return_value = {
            "acquired": 1,
        }
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor
        worker = Mock()
        worker.repository.connection_factory.return_value = connection
        worker.run_once.return_value = 1
        create_worker.return_value = worker

        self.assertEqual(
            run_worker_command(["event"]),
            0,
        )

        queue.receive.assert_called_once_with(
            maximum_messages=1
        )
        create_worker.assert_called_once_with(
            backend=None,
            output_dir=None,
            organisation_id="organisation-1",
        )
        worker.run_once.assert_called_once_with(
            job_id="job-1"
        )
        queue.delete.assert_called_once_with(
            message
        )
        queue.release.assert_not_called()
        connection.close.assert_called_once_with()

    @patch("claimguard_report_producer.cli.create_claim_wakeup_queue_from_environment")
    @patch("claimguard_report_producer.cli.create_event_worker_from_environment")
    def test_event_releases_wakeup_when_five_scheme_slots_are_busy(
        self,
        create_worker,
        create_queue,
    ) -> None:
        message = SimpleNamespace(
            organisation_id="organisation-1",
            outbox_job_id="job-1",
        )
        queue = Mock()
        queue.receive.return_value = [message]
        create_queue.return_value = queue

        cursor = MagicMock()
        cursor.fetchone.return_value = {
            "acquired": 0,
        }
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor
        worker = Mock()
        worker.repository.connection_factory.return_value = connection
        create_worker.return_value = worker

        self.assertEqual(
            run_worker_command(["event"]),
            0,
        )

        self.assertEqual(
            cursor.execute.call_count,
            5,
        )
        worker.run_once.assert_not_called()
        queue.delete.assert_not_called()
        queue.release.assert_called_once_with(
            message,
            delay_seconds=5,
        )
        connection.close.assert_called_once_with()

    @patch("claimguard_report_producer.cli.create_worker_from_environment")
    def test_positional_drain_mode_is_container_safe(self, create_worker) -> None:
        worker = Mock()
        create_worker.return_value = worker

        self.assertEqual(run_worker_command(["drain"]), 0)

        worker.run_until_empty.assert_called_once_with()
        worker.run_once.assert_not_called()
        worker.run_continuously.assert_not_called()

    @patch("claimguard_report_producer.cli.create_worker_from_environment")
    def test_legacy_once_flag_remains_supported(self, create_worker) -> None:
        worker = Mock()
        create_worker.return_value = worker

        self.assertEqual(run_worker_command(["--once"]), 0)

        worker.run_once.assert_called_once_with()

    @patch("claimguard_report_producer.cli.create_discovered_workers_from_environment")
    def test_drain_all_processes_every_discovered_medical_aid(self, create_workers) -> None:
        workers = [Mock(), Mock(), Mock()]
        create_workers.return_value = workers

        self.assertEqual(run_worker_command(["drain-all"]), 0)

        for worker in workers:
            worker.run_until_empty.assert_called_once_with()

    @patch("claimguard_report_producer.prospective_worker.create_discovered_workers_from_environment")
    def test_module_execution_invokes_the_worker_command(self, create_workers) -> None:
        worker = Mock()
        create_workers.return_value = [worker]
        stdout = io.StringIO()

        with (
            patch.object(
                sys,
                "argv",
                [
                    "claimguard_report_producer.cli",
                    "worker",
                    "drain-all",
                ],
            ),
            patch("sys.stdout", stdout),
            self.assertRaises(SystemExit) as exit_context,
        ):
            runpy.run_module(
                "claimguard_report_producer.cli",
                run_name="__main__",
            )

        self.assertEqual(exit_context.exception.code, 0)
        worker.run_until_empty.assert_called_once_with()
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["event"], "producer_run_completed")

    @patch("claimguard_report_producer.cli.run_worker_command")
    def test_runtime_failure_is_reported_without_sensitive_error_text(self, run_worker) -> None:
        run_worker.side_effect = RuntimeError("mysql://user:password@example.invalid/private")
        stderr = io.StringIO()

        with patch("sys.stderr", stderr):
            self.assertEqual(main(["worker", "drain"]), 1)

        payload = json.loads(stderr.getvalue())
        self.assertEqual(payload["event"], "producer_run_failed")
        self.assertEqual(payload["error_type"], "RuntimeError")
        self.assertNotIn("password", stderr.getvalue())
