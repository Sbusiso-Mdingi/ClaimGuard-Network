CREATE TABLE IF NOT EXISTS data_plane_routes (
  route_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  route_type VARCHAR(32) NOT NULL,
  logical_database_identifier VARCHAR(128) NOT NULL,
  azure_resource_identifier VARCHAR(1024) NULL,
  database_name VARCHAR(128) NULL,
  secret_reference VARCHAR(1024) NULL,
  region VARCHAR(128) NULL,
  route_generation INT UNSIGNED NOT NULL DEFAULT 1,
  schema_version VARCHAR(64) NULL,
  provisioning_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  health_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  last_health_check_at TIMESTAMP(3) NULL,
  active_at TIMESTAMP(3) NULL,
  retired_at TIMESTAMP(3) NULL,
  active_route_slot CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_data_plane_active_slot (active_route_slot),
  UNIQUE KEY uq_data_plane_generation (organisation_id, route_generation),
  INDEX idx_data_plane_org_status (organisation_id, provisioning_status),
  CONSTRAINT fk_data_plane_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_data_plane_route_type CHECK (route_type IN ('legacy_shared', 'private_database', 'platform_none')),
  CONSTRAINT chk_data_plane_provision CHECK (provisioning_status IN ('pending', 'assigned', 'migrating', 'ready', 'active', 'failed', 'retired')),
  CONSTRAINT chk_data_plane_health CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unreachable', 'suspended')),
  CONSTRAINT chk_data_plane_slot CHECK (active_route_slot IS NULL OR active_route_slot = organisation_id)
);

CREATE TABLE IF NOT EXISTS legacy_tenant_mappings (
  mapping_id CHAR(36) PRIMARY KEY,
  legacy_tenant_id VARCHAR(64) NOT NULL,
  legacy_tenant_slug VARCHAR(128) NOT NULL,
  organisation_id CHAR(36) NOT NULL,
  migration_status VARCHAR(32) NOT NULL DEFAULT 'mapped',
  route_id CHAR(36) NULL,
  verified_at TIMESTAMP(3) NULL,
  migration_metadata JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_legacy_mapping_tenant_id (legacy_tenant_id),
  UNIQUE KEY uq_legacy_mapping_tenant_slug (legacy_tenant_slug),
  UNIQUE KEY uq_legacy_mapping_organisation (organisation_id),
  CONSTRAINT fk_legacy_mapping_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_legacy_mapping_route FOREIGN KEY (route_id) REFERENCES data_plane_routes (route_id) ON DELETE RESTRICT,
  CONSTRAINT chk_legacy_mapping_status CHECK (migration_status IN ('discovered', 'mapped', 'verified', 'migrating', 'cutover', 'retired', 'conflict'))
);

CREATE TABLE IF NOT EXISTS organisation_provisioning_operations (
  operation_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  operation_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requested_by VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(128) NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  safe_error_summary VARCHAR(512) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_provisioning_org_status (organisation_id, status),
  CONSTRAINT fk_provisioning_operation_org FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_provisioning_operation_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'compensating', 'compensated', 'quarantined'))
);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  operation_id CHAR(36) NOT NULL,
  step_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  external_resource_reference VARCHAR(1024) NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  error_type VARCHAR(128) NULL,
  safe_error_summary VARCHAR(512) NULL,
  compensation_status VARCHAR(32) NOT NULL DEFAULT 'not_required',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (operation_id, step_key),
  CONSTRAINT fk_provisioning_step_operation FOREIGN KEY (operation_id) REFERENCES organisation_provisioning_operations (operation_id) ON DELETE CASCADE,
  CONSTRAINT chk_provisioning_step_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  CONSTRAINT chk_provisioning_compensation CHECK (compensation_status IN ('not_required', 'pending', 'running', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS organisation_schema_status (
  organisation_id CHAR(36) PRIMARY KEY,
  route_id CHAR(36) NULL,
  expected_schema_version VARCHAR(64) NOT NULL,
  observed_schema_version VARCHAR(64) NULL,
  compatibility_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  last_checked_at TIMESTAMP(3) NULL,
  safe_error_summary VARCHAR(512) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_schema_status_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT fk_schema_status_route FOREIGN KEY (route_id) REFERENCES data_plane_routes (route_id) ON DELETE RESTRICT,
  CONSTRAINT chk_schema_compatibility CHECK (compatibility_status IN ('unknown', 'compatible', 'upgrade_required', 'ahead', 'unreachable'))
);

CREATE TABLE IF NOT EXISTS report_storage_partitions (
  partition_id CHAR(36) PRIMARY KEY,
  organisation_id CHAR(36) NOT NULL,
  storage_type VARCHAR(32) NOT NULL,
  logical_partition_key VARCHAR(255) NOT NULL,
  resource_reference VARCHAR(1024) NULL,
  provisioning_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  health_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  active_at TIMESTAMP(3) NULL,
  retired_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_report_partition_org_key (organisation_id, logical_partition_key),
  CONSTRAINT fk_report_partition_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS worker_routing_status (
  organisation_id CHAR(36) NOT NULL,
  worker_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'unconfigured',
  routing_generation INT UNSIGNED NOT NULL DEFAULT 1,
  last_heartbeat_at TIMESTAMP(3) NULL,
  safe_error_summary VARCHAR(512) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organisation_id, worker_type),
  CONSTRAINT fk_worker_routing_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (organisation_id) ON DELETE RESTRICT,
  CONSTRAINT chk_worker_routing_status CHECK (status IN ('unconfigured', 'pending', 'ready', 'degraded', 'disabled'))
);
