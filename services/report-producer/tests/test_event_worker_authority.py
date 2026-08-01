from __future__ import annotations

import os
from unittest import TestCase
from unittest.mock import Mock, patch

from claimguard_report_producer import prospective_worker
from claimguard_report_producer.data_plane import DataPlaneRouteError
from claimguard_report_producer.worker import (
    create_event_worker_from_environment,
)


class EventWorkerAuthorityTests(TestCase):
    @patch(
        "claimguard_report_producer.prospective_worker._upgrade_worker"
    )
    @patch(
        "claimguard_report_producer.prospective_worker._create_legacy_event_worker"
    )
    def test_event_worker_keeps_prospective_model_routing(
        self,
        create_legacy_worker,
        upgrade_worker,
    ) -> None:
        legacy_worker = Mock()
        expected_worker = Mock()
        create_legacy_worker.return_value = legacy_worker
        upgrade_worker.return_value = expected_worker

        worker = prospective_worker.create_event_worker_from_environment(
            organisation_id="organisation-1",
            backend="azure_blob",
        )

        self.assertIs(worker, expected_worker)
        create_legacy_worker.assert_called_once_with(
            backend="azure_blob",
            output_dir=None,
            organisation_id="organisation-1",
        )
        upgrade_worker.assert_called_once_with(legacy_worker)

    @patch(
        "claimguard_report_producer.worker.create_worker_from_environment"
    )
    @patch(
        "claimguard_report_producer.worker.discover_active_worker_organisation_ids"
    )
    def test_active_scheme_is_scoped_for_worker_creation(
        self,
        discover_organisations,
        create_worker,
    ) -> None:
        discover_organisations.return_value = [
            "organisation-1",
            "organisation-2",
        ]
        expected_worker = Mock()
        create_worker.return_value = expected_worker

        with patch.dict(
            os.environ,
            {
                "CONTROL_PLANE_MYSQL_URL": "mysql://control-plane",
                "DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS": "14",
            },
            clear=False,
        ):
            os.environ.pop(
                "INTERNAL_SERVICE_ORGANISATION_IDS",
                None,
            )
            worker = create_event_worker_from_environment(
                organisation_id="organisation-1"
            )

        self.assertIs(worker, expected_worker)
        discover_organisations.assert_called_once_with(
            control_plane_url="mysql://control-plane",
            supported_schema_versions=frozenset({"14"}),
        )
        create_worker.assert_called_once_with(
            backend=None,
            output_dir=None,
            organisation_id="organisation-1",
        )
        self.assertNotIn(
            "INTERNAL_SERVICE_ORGANISATION_IDS",
            os.environ,
        )

    @patch(
        "claimguard_report_producer.worker.create_worker_from_environment"
    )
    @patch(
        "claimguard_report_producer.worker.discover_active_worker_organisation_ids"
    )
    def test_unknown_scheme_is_rejected_before_worker_creation(
        self,
        discover_organisations,
        create_worker,
    ) -> None:
        discover_organisations.return_value = ["organisation-2"]

        with (
            patch.dict(
                os.environ,
                {
                    "CONTROL_PLANE_MYSQL_URL": "mysql://control-plane",
                    "DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS": "14",
                },
                clear=False,
            ),
            self.assertRaisesRegex(
                DataPlaneRouteError,
                "active worker routing scope",
            ),
        ):
            create_event_worker_from_environment(
                organisation_id="organisation-1"
            )

        create_worker.assert_not_called()
