import io
import json
from unittest import TestCase
from unittest.mock import Mock, patch

from claimguard_report_producer.cli import main, run_worker_command


class WorkerCliTests(TestCase):
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
