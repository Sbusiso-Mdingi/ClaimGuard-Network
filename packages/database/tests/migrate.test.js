import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyMigrations,
  defaultMigrationPaths,
  getOperationalMigrationStatus,
} from "../src/migrate.js";


const SCHEMA_14_MIGRATION_ID =
  "0014_prospective_claim_detection";


function normalizeSql(
  sql,
) {
  return String(
    sql || "",
  )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}


function statementHistoryKey(
  migrationId,
  statementIndex,
) {
  return (
    `${migrationId}:`
    + `${statementIndex}`
  );
}


function createFakePool({
  failOncePattern = null,
  advanceMetadata = true,
  metadata = {
    schema_version: "13",
    migration_version: 13,
  },
  lockAcquired = true,
} = {}) {
  const statements = [];
  const calls = [];

  const history =
    new Map();

  const statementHistory =
    new Map();

  const failedPatterns =
    new Set();

  const metadataState = {
    ...metadata,
  };

  function recordCall(
    statement,
    params,
  ) {
    const normalized =
      normalizeSql(
        statement,
      );

    statements.push(
      normalized,
    );

    calls.push({
      sql: normalized,
      params: [
        ...params,
      ],
    });

    return normalized;
  }

  async function query(
    statement,
    params = [],
  ) {
    const normalized =
      recordCall(
        statement,
        params,
      );

    if (
      normalized.includes(
        "SELECT GET_LOCK",
      )
    ) {
      return [
        [
          {
            acquired:
              lockAcquired
                ? 1
                : 0,
          },
        ],
        [],
      ];
    }

    if (
      normalized.includes(
        "SELECT RELEASE_LOCK",
      )
    ) {
      return [
        [
          {
            released: 1,
          },
        ],
        [],
      ];
    }

    if (
      normalized.startsWith(
        "CREATE TABLE IF NOT EXISTS "
        + "operational_migration_history",
      )
    ) {
      return [
        {
          affectedRows: 0,
        },
        [],
      ];
    }

    if (
      normalized.startsWith(
        "CREATE TABLE IF NOT EXISTS "
        + "operational_migration_statement_history",
      )
    ) {
      return [
        {
          affectedRows: 0,
        },
        [],
      ];
    }

    if (
      normalized.startsWith(
        "SELECT migration_id, checksum, "
        + "applied_at, execution_duration_ms, "
        + "application_version "
        + "FROM operational_migration_history",
      )
    ) {
      return [
        [
          ...history.values(),
        ].map(
          (row) => ({
            ...row,
          }),
        ),
        [],
      ];
    }

    if (
      normalized.startsWith(
        "SELECT migration_id, statement_index, "
        + "statement_checksum, adopted, applied_at "
        + "FROM "
        + "operational_migration_statement_history",
      )
    ) {
      return [
        [
          ...statementHistory.values(),
        ].map(
          (row) => ({
            ...row,
          }),
        ),
        [],
      ];
    }

    if (
      normalized.startsWith(
        "INSERT INTO "
        + "operational_migration_statement_history",
      )
    ) {
      const [
        migrationId,
        statementIndex,
        statementChecksum,
        adopted,
      ] = params;

      statementHistory.set(
        statementHistoryKey(
          migrationId,
          statementIndex,
        ),
        {
          migration_id:
            migrationId,

          statement_index:
            statementIndex,

          statement_checksum:
            statementChecksum,

          adopted:
            Number(
              adopted,
            ),

          applied_at:
            new Date(
              "2026-07-23T12:00:00.000Z",
            ),
        },
      );

      return [
        {
          affectedRows: 1,
        },
        [],
      ];
    }

    if (
      normalized.startsWith(
        "INSERT INTO "
        + "operational_migration_history",
      )
    ) {
      const [
        migrationId,
        checksum,
        executionDurationMs,
        applicationVersion,
      ] = params;

      history.set(
        migrationId,
        {
          migration_id:
            migrationId,

          checksum,

          execution_duration_ms:
            executionDurationMs,

          application_version:
            applicationVersion,

          applied_at:
            new Date(
              "2026-07-23T12:00:00.000Z",
            ),
        },
      );

      return [
        {
          affectedRows: 1,
        },
        [],
      ];
    }

    if (
      normalized.startsWith(
        "SELECT schema_version, migration_version "
        + "FROM data_plane_metadata",
      )
    ) {
      return [
        [
          {
            ...metadataState,
          },
        ],
        [],
      ];
    }

    if (
      normalized.includes(
        "UPDATE data_plane_metadata",
      )
      && normalized.includes(
        "schema_version = '14'",
      )
    ) {
      if (advanceMetadata) {
        metadataState.schema_version =
          "14";

        metadataState.migration_version =
          Math.max(
            Number(
              metadataState
                .migration_version,
            )
            || 0,
            14,
          );
      }

      return [
        {
          affectedRows: 1,
        },
        [],
      ];
    }

    if (
      failOncePattern
      && normalized.includes(
        failOncePattern,
      )
      && !failedPatterns.has(
        failOncePattern,
      )
    ) {
      failedPatterns.add(
        failOncePattern,
      );

      const error =
        new Error(
          "Synthetic migration statement failure.",
        );

      error.code =
        "ER_PARSE_ERROR";

      throw error;
    }

    return [
      {
        affectedRows: 1,
      },
      [],
    ];
  }

  return {
    statements,
    calls,
    history,
    statementHistory,
    metadata:
      metadataState,

    async query(
      statement,
      params,
    ) {
      return query(
        statement,
        params,
      );
    },

    executionCount(
      pattern,
    ) {
      return statements.filter(
        (statement) =>
          statement.includes(
            pattern,
          ),
      ).length;
    },
  };
}


async function withTemporaryMigration(
  {
    filename,
    sql,
  },
  operation,
) {
  const directory =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        "claimguard-migration-test-",
      ),
    );

  const migrationPath =
    path.join(
      directory,
      filename,
    );

  try {
    await writeFile(
      migrationPath,
      sql,
      "utf8",
    );

    return await operation(
      migrationPath,
    );
  } finally {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }
}


test(
  "applyMigrations records statement and migration history, advances schema 14, and skips completed migrations",
  async () => {
    const pool =
      createFakePool();

    const first =
      await applyMigrations(
        pool,
        defaultMigrationPaths,
        {
          applicationVersion:
            "migration-test-suite",
        },
      );

    assert.equal(
      first.applied.length,
      14,
    );

    assert.equal(
      first.skipped.length,
      0,
    );

    assert.equal(
      first.appliedStatements
        > 0,
      true,
    );

    assert.equal(
      first.adoptedStatements,
      0,
    );

    assert.equal(
      first.resumedStatements,
      0,
    );

    assert.equal(
      pool.history.size,
      14,
    );

    assert.equal(
      pool.statementHistory.size,
      first.applied.reduce(
        (
          total,
          migration,
        ) =>
          total
          + migration
            .statementCount,
        0,
      ),
    );

    assert.equal(
      pool.metadata
        .schema_version,
      "14",
    );

    assert.equal(
      pool.metadata
        .migration_version,
      14,
    );

    assert.equal(
      pool.history
        .get(
          SCHEMA_14_MIGRATION_ID,
        )
        .application_version,
      "migration-test-suite",
    );

    const prospectiveMigration =
      first.applied.find(
        (migration) =>
          migration.id
          === SCHEMA_14_MIGRATION_ID,
      );

    assert.ok(
      prospectiveMigration,
    );

    assert.equal(
      prospectiveMigration
        .statementCount
        > 0,
      true,
    );

    assert.equal(
      pool.statements.some(
        (statement) =>
          statement.includes(
            "CREATE TABLE claim_versions",
          ),
      ),
      true,
    );

    assert.equal(
      pool.statements.some(
        (statement) =>
          statement.includes(
            "CREATE TABLE claim_detection_results",
          ),
      ),
      true,
    );

    assert.equal(
      pool.statements.some(
        (statement) =>
          statement.includes(
            "CREATE TRIGGER "
            + "trg_detection_results_no_update",
          ),
      ),
      true,
    );

    assert.equal(
      pool.statements.some(
        (statement) =>
          statement.includes(
            "CREATE TRIGGER "
            + "trg_detection_results_no_delete",
          ),
      ),
      true,
    );

    const claimVersionAlterCount =
      pool.executionCount(
        "ADD COLUMN current_claim_version",
      );

    const second =
      await applyMigrations(
        pool,
      );

    assert.equal(
      second.applied.length,
      0,
    );

    assert.equal(
      second.skipped.length,
      14,
    );

    assert.equal(
      second.appliedStatements,
      0,
    );

    assert.equal(
      second.adoptedStatements,
      0,
    );

    assert.equal(
      second.resumedStatements,
      0,
    );

    assert.equal(
      pool.executionCount(
        "ADD COLUMN current_claim_version",
      ),
      claimVersionAlterCount,
    );

    const status =
      await getOperationalMigrationStatus(
        pool,
      );

    assert.equal(
      status.applied.length,
      14,
    );

    assert.deepEqual(
      status.pending,
      [],
    );

    assert.deepEqual(
      status.inProgress,
      [],
    );

    assert.equal(
      pool.statements.some(
        (statement) =>
          statement.includes(
            "SELECT RELEASE_LOCK",
          ),
      ),
      true,
    );
  },
);


test(
  "applyMigrations fails closed when a completed migration checksum changes",
  async () => {
    const pool =
      createFakePool();

    await applyMigrations(
      pool,
    );

    pool.history.get(
      "0008_data_plane_metadata",
    ).checksum =
      "0".repeat(
        64,
      );

    await assert.rejects(
      () =>
        applyMigrations(
          pool,
        ),
      (error) => (
        error.code
          === "OPERATIONAL_MIGRATION_CHECKSUM_MISMATCH"
        && error.migrationId
          === "0008_data_plane_metadata"
      ),
    );
  },
);


test(
  "an interrupted migration resumes after its last recorded statement without replaying completed DDL",
  async () => {
    await withTemporaryMigration(
      {
        filename:
          "0099_resume_probe.sql",

        sql: `
          CREATE TABLE resume_probe (
            id INT PRIMARY KEY
          );

          INSERT INTO resume_probe (
            id
          )
          VALUES (1);

          INSERT INTO resume_probe (
            id
          )
          VALUES (2);
        `,
      },
      async (
        migrationPath,
      ) => {
        const failingStatement =
          "INSERT INTO resume_probe ( id ) VALUES (1)";

        const pool =
          createFakePool({
            failOncePattern:
              failingStatement,
          });

        await assert.rejects(
          () =>
            applyMigrations(
              pool,
              migrationPath,
            ),
          (error) => (
            error.code
              === "OPERATIONAL_MIGRATION_FAILED"
            && error.migrationId
              === "0099_resume_probe"
            && error.statementIndex
              === 2
          ),
        );

        assert.equal(
          pool.history.size,
          0,
        );

        assert.equal(
          pool.statementHistory.size,
          1,
        );

        assert.equal(
          pool.executionCount(
            "CREATE TABLE resume_probe",
          ),
          1,
        );

        const interruptedStatus =
          await getOperationalMigrationStatus(
            pool,
            {
              migrationPath,
            },
          );

        assert.equal(
          interruptedStatus
            .applied
            .length,
          0,
        );

        assert.equal(
          interruptedStatus
            .pending
            .length,
          1,
        );

        assert.equal(
          interruptedStatus
            .pending[0]
            .completedStatementCount,
          1,
        );

        assert.equal(
          interruptedStatus
            .pending[0]
            .remainingStatementCount,
          2,
        );

        assert.equal(
          interruptedStatus
            .inProgress
            .length,
          1,
        );

        const resumed =
          await applyMigrations(
            pool,
            migrationPath,
          );

        assert.equal(
          resumed.applied.length,
          1,
        );

        assert.equal(
          resumed.appliedStatements,
          2,
        );

        assert.equal(
          resumed.resumedStatements,
          1,
        );

        assert.equal(
          resumed.applied[0]
            .appliedStatements,
          2,
        );

        assert.equal(
          resumed.applied[0]
            .resumedStatements,
          1,
        );

        assert.equal(
          pool.executionCount(
            "CREATE TABLE resume_probe",
          ),
          1,
        );

        assert.equal(
          pool.executionCount(
            failingStatement,
          ),
          2,
        );

        assert.equal(
          pool.executionCount(
            "INSERT INTO resume_probe ( id ) VALUES (2)",
          ),
          1,
        );

        assert.equal(
          pool.history.has(
            "0099_resume_probe",
          ),
          true,
        );

        const completeStatus =
          await getOperationalMigrationStatus(
            pool,
            {
              migrationPath,
            },
          );

        assert.deepEqual(
          completeStatus.pending,
          [],
        );

        assert.deepEqual(
          completeStatus.inProgress,
          [],
        );
      },
    );
  },
);


test(
  "partially recorded migrations fail closed when a statement checksum changes",
  async () => {
    await withTemporaryMigration(
      {
        filename:
          "0099_statement_checksum.sql",

        sql: `
          CREATE TABLE checksum_probe (
            id INT PRIMARY KEY
          );

          INSERT INTO checksum_probe (
            id
          )
          VALUES (1);
        `,
      },
      async (
        migrationPath,
      ) => {
        const pool =
          createFakePool({
            failOncePattern:
              "INSERT INTO checksum_probe ( id ) VALUES (1)",
          });

        await assert.rejects(
          () =>
            applyMigrations(
              pool,
              migrationPath,
            ),
          (error) =>
            error.code
            === "OPERATIONAL_MIGRATION_FAILED",
        );

        const firstStatement =
          pool.statementHistory.get(
            statementHistoryKey(
              "0099_statement_checksum",
              1,
            ),
          );

        assert.ok(
          firstStatement,
        );

        firstStatement
          .statement_checksum =
            "0".repeat(
              64,
            );

        await assert.rejects(
          () =>
            getOperationalMigrationStatus(
              pool,
              {
                migrationPath,
              },
            ),
          (error) => (
            error.code
              === "OPERATIONAL_MIGRATION_STATEMENT_CHECKSUM_MISMATCH"
            && error.migrationId
              === "0099_statement_checksum"
            && error.statementIndex
              === 1
          ),
        );

        await assert.rejects(
          () =>
            applyMigrations(
              pool,
              migrationPath,
            ),
          (error) =>
            error.code
            === "OPERATIONAL_MIGRATION_STATEMENT_CHECKSUM_MISMATCH",
        );
      },
    );
  },
);


test(
  "migration 0014 is not marked complete until data-plane metadata reports schema and migration version 14",
  async () => {
    const migrationPath =
      defaultMigrationPaths.find(
        (candidate) =>
          candidate.endsWith(
            "0014_prospective_claim_detection.sql",
          ),
      );

    assert.ok(
      migrationPath,
    );

    const pool =
      createFakePool({
        advanceMetadata:
          false,
      });

    await assert.rejects(
      () =>
        applyMigrations(
          pool,
          migrationPath,
        ),
      (error) =>
        error.code
        === "OPERATIONAL_MIGRATION_METADATA_MISMATCH",
    );

    assert.equal(
      pool.history.has(
        SCHEMA_14_MIGRATION_ID,
      ),
      false,
    );

    assert.equal(
      pool.statementHistory.size
        > 0,
      true,
    );

    const recordedStatementCount =
      pool.statementHistory.size;

    pool.metadata
      .schema_version =
        "14";

    pool.metadata
      .migration_version =
        14;

    const resumed =
      await applyMigrations(
        pool,
        migrationPath,
      );

    assert.equal(
      resumed.applied.length,
      1,
    );

    assert.equal(
      resumed.appliedStatements,
      0,
    );

    assert.equal(
      resumed.resumedStatements,
      recordedStatementCount,
    );

    assert.equal(
      pool.history.has(
        SCHEMA_14_MIGRATION_ID,
      ),
      true,
    );
  },
);


test(
  "applyMigrations rejects execution when the operational migration lock is unavailable",
  async () => {
    const migrationPath =
      defaultMigrationPaths[0];

    const pool =
      createFakePool({
        lockAcquired:
          false,
      });

    await assert.rejects(
      () =>
        applyMigrations(
          pool,
          migrationPath,
        ),
      /Could not acquire the operational migration lock/,
    );

    assert.equal(
      pool.history.size,
      0,
    );

    assert.equal(
      pool.statementHistory.size,
      0,
    );
  },
);
