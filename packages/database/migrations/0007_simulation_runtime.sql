CREATE TABLE IF NOT EXISTS simulation_instances (
  id VARCHAR(64) PRIMARY KEY,
  scope_key VARCHAR(128) NOT NULL,
  scope_type VARCHAR(32) NOT NULL,
  tenant_id VARCHAR(64) NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'off',
  status VARCHAR(16) NOT NULL DEFAULT 'stopped',
  story_key VARCHAR(128) NULL,
  seed BIGINT UNSIGNED NOT NULL DEFAULT 42,
  tick_interval_ms INT UNSIGNED NOT NULL DEFAULT 8000,
  simulated_at TIMESTAMP(3) NULL,
  tick_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  checkpoint_version INT UNSIGNED NOT NULL DEFAULT 1,
  checkpoint JSON NULL,
  config JSON NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at TIMESTAMP(3) NULL,
  paused_at TIMESTAMP(3) NULL,
  stopped_at TIMESTAMP(3) NULL,
  last_successful_tick_at TIMESTAMP(3) NULL,
  last_correlation_id VARCHAR(128) NULL,
  last_control_command VARCHAR(32) NULL,
  last_control_actor VARCHAR(255) NULL,
  last_control_correlation_id VARCHAR(128) NULL,
  last_error JSON NULL,
  UNIQUE KEY uq_simulation_instances_scope (scope_key),
  INDEX idx_simulation_instances_runnable (status, updated_at),
  INDEX idx_simulation_instances_tenant_scope (tenant_id, scope_type),
  INDEX idx_simulation_instances_mode (mode, updated_at),
  CONSTRAINT fk_simulation_instances_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS simulation_leases (
  simulation_instance_id VARCHAR(64) PRIMARY KEY,
  leased_by VARCHAR(255) NOT NULL,
  fencing_token BIGINT UNSIGNED NOT NULL,
  leased_at TIMESTAMP(3) NOT NULL,
  lease_expires_at TIMESTAMP(3) NOT NULL,
  heartbeat_at TIMESTAMP(3) NOT NULL,
  INDEX idx_simulation_leases_expiry (lease_expires_at),
  INDEX idx_simulation_leases_worker (leased_by, lease_expires_at),
  CONSTRAINT fk_simulation_leases_instance
    FOREIGN KEY (simulation_instance_id) REFERENCES simulation_instances (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS simulation_tick_history (
  simulation_instance_id VARCHAR(64) NOT NULL,
  tick_number BIGINT UNSIGNED NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  fencing_token BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at TIMESTAMP(3) NOT NULL,
  completed_at TIMESTAMP(3) NULL,
  duration_ms INT UNSIGNED NULL,
  outcome_summary JSON NULL,
  error_type VARCHAR(128) NULL,
  checkpoint_version INT UNSIGNED NOT NULL,
  PRIMARY KEY (simulation_instance_id, tick_number),
  UNIQUE KEY uq_simulation_tick_correlation (correlation_id),
  INDEX idx_simulation_tick_status (status, started_at),
  INDEX idx_simulation_tick_completed (simulation_instance_id, completed_at),
  CONSTRAINT fk_simulation_tick_instance
    FOREIGN KEY (simulation_instance_id) REFERENCES simulation_instances (id) ON DELETE CASCADE
);
