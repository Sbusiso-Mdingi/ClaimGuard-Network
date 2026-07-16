CREATE TABLE IF NOT EXISTS data_plane_metadata (
  metadata_key VARCHAR(64) PRIMARY KEY,
  database_mode VARCHAR(32) NOT NULL,
  logical_database_identifier VARCHAR(128) NOT NULL,
  schema_version VARCHAR(64) NOT NULL,
  environment_key VARCHAR(64) NOT NULL,
  migration_version INT UNSIGNED NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_data_plane_database_mode CHECK (database_mode IN ('legacy_shared', 'private_database'))
);

INSERT INTO data_plane_metadata
  (metadata_key, database_mode, logical_database_identifier, schema_version, environment_key, migration_version)
VALUES ('primary', 'legacy_shared', 'legacy-operational-shared', '8', 'legacy', 8)
ON DUPLICATE KEY UPDATE
  database_mode = VALUES(database_mode),
  logical_database_identifier = VALUES(logical_database_identifier),
  schema_version = VALUES(schema_version),
  migration_version = GREATEST(migration_version, VALUES(migration_version));
