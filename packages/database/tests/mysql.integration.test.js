import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  createMysqlConnection,
  getOperationalMigrationStatus,
} from "../src/index.js";


const databaseUrl =
  process.env
    .OPERATIONAL_TEST_MYSQL_URL
  || "";


test(
  "real MySQL operational migrations enforce schema-14 prospective scoring foundations",
  {
    skip:
      !databaseUrl,
  },
  async () => {
    const pool =
      createMysqlConnection(
        databaseUrl,
      );

    try {
      const first =
        await applyMigrations(
          pool,
          undefined,
          {
            applicationVersion:
              "integration-test",
          },
        );

      const second =
        await applyMigrations(
          pool,
          undefined,
          {
            applicationVersion:
              "integration-test",
          },
        );

      const status =
        await getOperationalMigrationStatus(
          pool,
        );

      /*
       * A clean database applies all fourteen
       * operational migrations. A reused integration
       * database may report them as skipped instead.
       */
      assert.equal(
        first.applied.length
        + first.skipped.length,
        14,
      );

      assert.equal(
        second.applied.length,
        0,
      );

      assert.equal(
        second.appliedStatements,
        0,
      );

      assert.equal(
        second.skipped.length,
        14,
      );

      assert.equal(
        status.applied.length,
        14,
      );

      assert.equal(
        status.pending.length,
        0,
      );

      /*
       * The singleton data-plane marker must expose
       * the complete canonical schema-14 identity.
       */
      const [
        metadataColumns,
      ] =
        await pool.execute(
          `
            SELECT
              column_name AS columnName,
              data_type AS dataType,
              is_nullable AS isNullable,
              column_default AS columnDefault
            FROM information_schema.columns
            WHERE table_schema =
              DATABASE()
              AND table_name =
                'data_plane_metadata'
            ORDER BY ordinal_position
          `,
        );

      assert.deepEqual(
        metadataColumns.map(
          ({
            columnName,
          }) =>
            columnName,
        ),
        [
          "metadata_key",
          "database_mode",
          "logical_database_identifier",
          "schema_version",
          "environment_key",
          "migration_version",
          "updated_at",
        ],
      );

      assert.equal(
        metadataColumns.find(
          ({
            columnName,
          }) =>
            columnName
            === "migration_version",
        ).dataType,
        "int",
      );

      assert.equal(
        metadataColumns.every(
          ({
            isNullable,
          }) =>
            isNullable === "NO",
        ),
        true,
      );

      const [
        metadataRows,
      ] =
        await pool.execute(
          `
            SELECT
              metadata_key,
              database_mode,
              logical_database_identifier,
              schema_version,
              environment_key,
              migration_version
            FROM data_plane_metadata
          `,
        );

      assert.equal(
        metadataRows.length,
        1,
      );

      assert.deepEqual(
        {
          metadataKey:
            metadataRows[0]
              .metadata_key,

          databaseMode:
            metadataRows[0]
              .database_mode,

          logicalDatabaseIdentifier:
            metadataRows[0]
              .logical_database_identifier,

          schemaVersion:
            String(
              metadataRows[0]
                .schema_version,
            ),

          environmentKey:
            metadataRows[0]
              .environment_key,

          migrationVersion:
            Number(
              metadataRows[0]
                .migration_version,
            ),
        },
        {
          metadataKey:
            "primary",

          databaseMode:
            "legacy_shared",

          logicalDatabaseIdentifier:
            "legacy-operational-shared",

          schemaVersion:
            "14",

          environmentKey:
            "legacy",

          migrationVersion:
            14,
        },
      );

      /*
       * A second metadata identity cannot be created,
       * and the singleton primary row cannot be
       * duplicated.
       */
      await assert.rejects(
        () =>
          pool.execute(
            `
              INSERT INTO data_plane_metadata (
                metadata_key,
                database_mode,
                logical_database_identifier,
                schema_version,
                environment_key,
                migration_version
              )
              VALUES (
                'secondary',
                'legacy_shared',
                'legacy-operational-shared',
                '14',
                'legacy',
                14
              )
            `,
          ),
        (
          error,
        ) =>
          error.code
          === "ER_CHECK_CONSTRAINT_VIOLATED",
      );

      await assert.rejects(
        () =>
          pool.execute(
            `
              INSERT INTO data_plane_metadata (
                metadata_key,
                database_mode,
                logical_database_identifier,
                schema_version,
                environment_key,
                migration_version
              )
              VALUES (
                'primary',
                'legacy_shared',
                'legacy-operational-shared',
                '14',
                'legacy',
                14
              )
            `,
          ),
        (
          error,
        ) =>
          error.code
          === "ER_DUP_ENTRY",
      );

      /*
       * Schema 14 introduces the current-version
       * pointer and the immutable historical version
       * table.
       */
      const [
        prospectiveColumns,
      ] =
        await pool.execute(
          `
            SELECT
              table_name AS tableName,
              column_name AS columnName,
              column_type AS columnType,
              is_nullable AS isNullable
            FROM information_schema.columns
            WHERE table_schema =
              DATABASE()
              AND (
                (
                  table_name =
                    'claims'
                  AND column_name =
                    'current_claim_version'
                )
                OR
                (
                  table_name =
                    'claim_versions'
                  AND column_name IN (
                    'tenant_id',
                    'claim_id',
                    'claim_version',
                    'claim_payload',
                    'payload_hash',
                    'version_reason'
                  )
                )
                OR
                (
                  table_name =
                    'detection_strategies'
                  AND column_name IN (
                    'activated_at',
                    'deactivated_at',
                    'actor',
                    'change_reason'
                  )
                )
                OR
                (
                  table_name =
                    'claim_processing_outbox'
                  AND column_name IN (
                    'detection_strategy_id',
                    'strategy_type',
                    'model_deployment_id'
                  )
                )
                OR
                (
                  table_name =
                    'claim_detection_results'
                  AND column_name IN (
                    'tenant_id',
                    'claim_id',
                    'claim_version',
                    'detection_strategy_id',
                    'strategy_type',
                    'source_job_id',
                    'request_id',
                    'analysis_mode',
                    'result_payload',
                    'result_hash'
                  )
                )
              )
            ORDER BY
              table_name,
              ordinal_position
          `,
        );

      const columnNames =
        new Set(
          prospectiveColumns.map(
            ({
              tableName,
              columnName,
            }) =>
              `${tableName}.${columnName}`,
          ),
        );

      for (
        const expected
        of [
          "claims.current_claim_version",
          "claim_versions.tenant_id",
          "claim_versions.claim_id",
          "claim_versions.claim_version",
          "claim_versions.claim_payload",
          "claim_versions.payload_hash",
          "claim_versions.version_reason",
          "detection_strategies.activated_at",
          "detection_strategies.deactivated_at",
          "detection_strategies.actor",
          "detection_strategies.change_reason",
          "claim_processing_outbox.detection_strategy_id",
          "claim_processing_outbox.strategy_type",
          "claim_processing_outbox.model_deployment_id",
          "claim_detection_results.tenant_id",
          "claim_detection_results.claim_id",
          "claim_detection_results.claim_version",
          "claim_detection_results.detection_strategy_id",
          "claim_detection_results.strategy_type",
          "claim_detection_results.source_job_id",
          "claim_detection_results.request_id",
          "claim_detection_results.analysis_mode",
          "claim_detection_results.result_payload",
          "claim_detection_results.result_hash",
        ]
      ) {
        assert.equal(
          columnNames.has(
            expected,
          ),
          true,
          `Missing schema-14 column ${expected}.`,
        );
      }

      const currentVersionColumn =
        prospectiveColumns.find(
          ({
            tableName,
            columnName,
          }) =>
            tableName === "claims"
            && columnName
              === "current_claim_version",
        );

      assert.equal(
        currentVersionColumn
          .columnType,
        "int unsigned",
      );

      assert.equal(
        currentVersionColumn
          .isNullable,
        "NO",
      );

      for (
        const requiredAuditColumn
        of [
          "activated_at",
          "actor",
          "change_reason",
        ]
      ) {
        const column =
          prospectiveColumns.find(
            ({
              tableName,
              columnName,
            }) =>
              tableName
                === "detection_strategies"
              && columnName
                === requiredAuditColumn,
          );

        assert.ok(
          column,
        );

        assert.equal(
          column.isNullable,
          "NO",
        );
      }

      /*
       * Verify schema-level checks and tenant-scoped
       * foreign keys, not merely table existence.
       */
      const [
        constraints,
      ] =
        await pool.execute(
          `
            SELECT
              table_name AS tableName,
              constraint_name AS constraintName,
              constraint_type AS constraintType
            FROM information_schema.table_constraints
            WHERE table_schema =
              DATABASE()
          `,
        );

      const constraintNames =
        new Set(
          constraints.map(
            ({
              constraintName,
            }) =>
              constraintName,
          ),
        );

      for (
        const expected
        of [
          "chk_data_plane_database_mode",
          "chk_data_plane_metadata_singleton",
          "chk_claims_current_version",
          "chk_claim_versions_positive_version",
          "chk_claim_versions_payload_hash",
          "chk_detection_strategy_configuration",
          "chk_claim_outbox_strategy",
          "chk_detection_results_version",
          "chk_detection_results_hash",
          "chk_detection_results_strategy",
        ]
      ) {
        assert.equal(
          constraintNames.has(
            expected,
          ),
          true,
          `Missing database constraint ${expected}.`,
        );
      }

      const [
        foreignKeys,
      ] =
        await pool.execute(
          `
            SELECT
              table_name AS tableName,
              constraint_name AS constraintName
            FROM information_schema.referential_constraints
            WHERE constraint_schema =
              DATABASE()
          `,
        );

      const foreignKeyNames =
        new Set(
          foreignKeys.map(
            ({
              constraintName,
            }) =>
              constraintName,
          ),
        );

      for (
        const expected
        of [
          "fk_claim_processing_outbox_tenant",
          "fk_investigations_tenant_id",
          "fk_claim_versions_claim",
          "fk_claim_outbox_strategy",
          "fk_detection_result_claim_version",
          "fk_detection_result_strategy",
          "fk_detection_result_source_job",
        ]
      ) {
        assert.equal(
          foreignKeyNames.has(
            expected,
          ),
          true,
          `Missing foreign key ${expected}.`,
        );
      }

      /*
       * Detection results are protected against
       * UPDATE and DELETE by database triggers.
       */
      const [
        triggerRows,
      ] =
        await pool.execute(
          `
            SELECT
              trigger_name AS triggerName,
              event_manipulation AS eventManipulation,
              action_timing AS actionTiming,
              event_object_table AS tableName
            FROM information_schema.triggers
            WHERE trigger_schema =
              DATABASE()
              AND event_object_table =
                'claim_detection_results'
            ORDER BY trigger_name
          `,
        );

      assert.deepEqual(
        triggerRows.map(
          ({
            triggerName,
            eventManipulation,
            actionTiming,
            tableName,
          }) => ({
            triggerName,
            eventManipulation,
            actionTiming,
            tableName,
          }),
        ),
        [
          {
            triggerName:
              "trg_detection_results_no_delete",

            eventManipulation:
              "DELETE",

            actionTiming:
              "BEFORE",

            tableName:
              "claim_detection_results",
          },
          {
            triggerName:
              "trg_detection_results_no_update",

            eventManipulation:
              "UPDATE",

            actionTiming:
              "BEFORE",

            tableName:
              "claim_detection_results",
          },
        ],
      );

      /*
       * The historical claim-version identity must be
       * the composite primary key.
       */
      const [
        primaryKeyRows,
      ] =
        await pool.execute(
          `
            SELECT
              column_name AS columnName,
              ordinal_position AS ordinalPosition
            FROM information_schema.key_column_usage
            WHERE constraint_schema =
              DATABASE()
              AND table_name =
                'claim_versions'
              AND constraint_name =
                'PRIMARY'
            ORDER BY ordinal_position
          `,
        );

      assert.deepEqual(
        primaryKeyRows.map(
          ({
            columnName,
          }) =>
            columnName,
        ),
        [
          "tenant_id",
          "claim_id",
          "claim_version",
        ],
      );
    } finally {
      await pool.end();
    }
  },
);
