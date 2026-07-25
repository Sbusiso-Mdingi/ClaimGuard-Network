INSERT INTO worker_routing_status (
  organisation_id,
  worker_type,
  status,
  routing_generation,
  last_heartbeat_at,
  safe_error_summary
)
SELECT
  organisations.organisation_id,
  'report-worker',
  'ready',
  1,
  NULL,
  NULL
FROM organisations
INNER JOIN data_plane_routes
  ON data_plane_routes.organisation_id = organisations.organisation_id
 AND data_plane_routes.active_route_slot = organisations.organisation_id
WHERE organisations.organisation_type = 'medical_scheme'
  AND organisations.status = 'active'
  AND organisations.activation_state = 'activated'
  AND data_plane_routes.route_type = 'legacy_shared'
  AND data_plane_routes.provisioning_status = 'active'
  AND data_plane_routes.health_status NOT IN ('suspended', 'unreachable')
  AND data_plane_routes.schema_version = '14'
  AND data_plane_routes.retired_at IS NULL
ON DUPLICATE KEY UPDATE
  status = 'ready',
  routing_generation = routing_generation + 1,
  safe_error_summary = NULL;
