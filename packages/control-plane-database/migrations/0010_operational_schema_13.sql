UPDATE data_plane_routes
SET
  schema_version = '13',
  route_generation = route_generation + 1
WHERE route_type = 'legacy_shared'
  AND schema_version = '10'
  AND retired_at IS NULL;

UPDATE organisation_schema_status status_record
JOIN data_plane_routes route_record
  ON route_record.route_id = status_record.route_id
SET
  status_record.expected_schema_version = '13',
  status_record.observed_schema_version = '13',
  status_record.compatibility_status = 'compatible',
  status_record.last_checked_at = UTC_TIMESTAMP(3),
  status_record.safe_error_summary = NULL
WHERE route_record.route_type = 'legacy_shared'
  AND route_record.schema_version = '13'
  AND route_record.retired_at IS NULL;

UPDATE worker_routing_status routing
JOIN data_plane_routes route_record
  ON route_record.organisation_id = routing.organisation_id
SET
  routing.routing_generation = routing.routing_generation + 1,
  routing.safe_error_summary = NULL
WHERE routing.worker_type = 'report-worker'
  AND route_record.route_type = 'legacy_shared'
  AND route_record.active_route_slot = route_record.organisation_id
  AND route_record.schema_version = '13';
