import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  createMysqlConnection,
  getOperationalMigrationStatus,
} from "../src/index.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

test("real MySQL operational migrations, checksums, metadata singleton, and constraints", { skip: !databaseUrl }, async () => {
  const pool = createMysqlConnection(databaseUrl);
  try {
    const first = await applyMigrations(pool, undefined, { applicationVersion: "integration-test" });
    const second = await applyMigrations(pool, undefined, { applicationVersion: "integration-test" });
    const status = await getOperationalMigrationStatus(pool);
    assert.equal(first.applied.length + first.skipped.length, 13);
    assert.equal(second.applied.length, 0);
    assert.equal(second.appliedStatements, 0);
    assert.equal(status.applied.length, 13);
    assert.equal(status.pending.length, 0);

    const [columns] = await pool.execute(
      `SELECT column_name AS columnName, data_type AS dataType, is_nullable AS isNullable, column_default AS columnDefault
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'data_plane_metadata'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.map(({ columnName }) => columnName), [
      "metadata_key", "database_mode", "logical_database_identifier", "schema_version",
      "environment_key", "migration_version", "updated_at",
    ]);
    assert.equal(columns.find(({ columnName }) => columnName === "migration_version").dataType, "int");
    assert.equal(columns.every(({ isNullable }) => isNullable === "NO"), true);

    const [constraints] = await pool.execute(
      `SELECT constraint_name AS constraintName, constraint_type AS constraintType
       FROM information_schema.table_constraints
       WHERE table_schema = DATABASE() AND table_name = 'data_plane_metadata'`,
    );
    assert.equal(constraints.some(({ constraintName }) => constraintName === "chk_data_plane_database_mode"), true);
    assert.equal(constraints.some(({ constraintName }) => constraintName === "chk_data_plane_metadata_singleton"), true);

    await assert.rejects(
      () => pool.execute(
        `INSERT INTO data_plane_metadata
          (metadata_key,database_mode,logical_database_identifier,schema_version,environment_key,migration_version)
         VALUES ('secondary','legacy_shared','legacy-operational-shared','10','legacy',10)`,
      ),
      (error) => error.code === "ER_CHECK_CONSTRAINT_VIOLATED",
    );
    await assert.rejects(
      () => pool.execute(
        `INSERT INTO data_plane_metadata
          (metadata_key,database_mode,logical_database_identifier,schema_version,environment_key,migration_version)
         VALUES ('primary','legacy_shared','legacy-operational-shared','10','legacy',10)`,
      ),
      (error) => error.code === "ER_DUP_ENTRY",
    );

    const [foreignKeys] = await pool.execute(
      `SELECT table_name AS tableName, constraint_name AS constraintName
       FROM information_schema.referential_constraints
       WHERE constraint_schema = DATABASE()`,
    );
    assert.equal(foreignKeys.some(({ constraintName }) => constraintName === "fk_claim_processing_outbox_tenant"), true);
    assert.equal(foreignKeys.some(({ constraintName }) => constraintName === "fk_investigations_tenant_id"), true);

    const [metadata] = await pool.execute("SELECT * FROM data_plane_metadata");
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].metadata_key, "primary");
    assert.equal(metadata[0].migration_version, 13);
  } finally {
    await pool.end();
  }
});
