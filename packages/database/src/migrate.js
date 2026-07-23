import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultMigrationPath = fileURLToPath(
  new URL("../migrations/0001_initial.sql", import.meta.url),
);

export const defaultMigrationPaths = Object.freeze([
  defaultMigrationPath,
  fileURLToPath(
    new URL(
      "../migrations/0002_investigations.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0003_shared_fraud_registry.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0004_claim_processing_outbox.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0005_atomic_fraud_workflows.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0006_tenant_snapshot_reports.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0007_simulation_runtime.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0008_data_plane_metadata.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0009_data_plane_metadata_singleton.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0010_production_ingestion.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0011_detection_strategies.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0012_custom_model.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0013_approved_model_contract.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0014_prospective_claim_detection.sql",
      import.meta.url,
    ),
  ),
]);

const MIGRATION_LOCK_NAME =
  "claimguard_operational_migrations";

const PROSPECTIVE_MIGRATION_ID =
  "0014_prospective_claim_detection";

const PROSPECTIVE_SCHEMA_VERSION = "14";
const PROSPECTIVE_MIGRATION_VERSION = 14;

const MIGRATION_ID_PATTERN =
  /^\d{4}_[A-Za-z0-9][A-Za-z0-9_-]*$/;

const migrationHistorySql = `
  CREATE TABLE IF NOT EXISTS operational_migration_history (
    migration_id VARCHAR(255) PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP(3)
      NOT NULL
      DEFAULT CURRENT_TIMESTAMP(3),
    execution_duration_ms INT UNSIGNED NOT NULL,
    application_version VARCHAR(128) NULL
  )
`;

const migrationStatementHistorySql = `
  CREATE TABLE IF NOT EXISTS operational_migration_statement_history (
    migration_id VARCHAR(255) NOT NULL,
    statement_index INT UNSIGNED NOT NULL,
    statement_checksum CHAR(64) NOT NULL,
    adopted BOOLEAN NOT NULL DEFAULT FALSE,
    applied_at TIMESTAMP(3)
      NOT NULL
      DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (
      migration_id,
      statement_index
    )
  )
`;

export class OperationalMigrationChecksumMismatchError
  extends Error {
  constructor(migrationId) {
    super(
      `Applied operational migration ${migrationId} `
      + "no longer matches its recorded checksum.",
    );

    this.name =
      "OperationalMigrationChecksumMismatchError";

    this.code =
      "OPERATIONAL_MIGRATION_CHECKSUM_MISMATCH";

    this.migrationId =
      migrationId;
  }
}

export class OperationalMigrationExecutionError
  extends Error {
  constructor(
    migrationId,
    statementIndex,
    cause,
  ) {
    super(
      `Operational migration ${migrationId} failed `
      + `at statement ${statementIndex}.`,
    );

    this.name =
      "OperationalMigrationExecutionError";

    this.code =
      "OPERATIONAL_MIGRATION_FAILED";

    this.migrationId =
      migrationId;

    this.statementIndex =
      statementIndex;

    this.cause =
      cause;
  }
}

class OperationalMigrationStatementChecksumMismatchError
  extends Error {
  constructor(
    migrationId,
    statementIndex,
  ) {
    super(
      `Operational migration ${migrationId} statement `
      + `${statementIndex} no longer matches its `
      + "recorded checksum.",
    );

    this.name =
      "OperationalMigrationStatementChecksumMismatchError";

    this.code =
      "OPERATIONAL_MIGRATION_STATEMENT_CHECKSUM_MISMATCH";

    this.migrationId =
      migrationId;

    this.statementIndex =
      statementIndex;
  }
}

class OperationalMigrationMetadataError
  extends Error {
  constructor(message) {
    super(message);

    this.name =
      "OperationalMigrationMetadataError";

    this.code =
      "OPERATIONAL_MIGRATION_METADATA_MISMATCH";
  }
}

function isDashCommentStart(
  sql,
  index,
) {
  return (
    sql[index] === "-"
    && sql[index + 1] === "-"
    && (
      index + 2 >= sql.length
      || /\s/.test(
        sql[index + 2],
      )
    )
  );
}

function splitSqlStatements(sql) {
  const source =
    String(sql || "")
      .replace(/\r\n?/g, "\n");

  const statements = [];

  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (
    let index = 0;
    index < source.length;
    index += 1
  ) {
    const character =
      source[index];

    const next =
      source[index + 1]
      || "";

    if (lineComment) {
      current += character;

      if (character === "\n") {
        lineComment = false;
      }

      continue;
    }

    if (blockComment) {
      current += character;

      if (
        character === "*"
        && next === "/"
      ) {
        current += next;
        index += 1;
        blockComment = false;
      }

      continue;
    }

    if (quote) {
      current += character;

      if (
        character === "\\"
        && quote !== "`"
        && index + 1
          < source.length
      ) {
        current += next;
        index += 1;
        continue;
      }

      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }

      continue;
    }

    if (
      isDashCommentStart(
        source,
        index,
      )
      || character === "#"
    ) {
      lineComment = true;
      current += character;

      if (
        character === "-"
        && next === "-"
      ) {
        current += next;
        index += 1;
      }

      continue;
    }

    if (
      character === "/"
      && next === "*"
    ) {
      blockComment = true;
      current += character + next;
      index += 1;
      continue;
    }

    if (
      [
        "'",
        "\"",
        "`",
      ].includes(
        character,
      )
    ) {
      quote = character;
      current += character;
      continue;
    }

    if (character === ";") {
      const statement =
        current.trim();

      if (statement) {
        statements.push(
          statement,
        );
      }

      current = "";
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new TypeError(
      "Migration SQL contains an "
      + "unterminated quoted value.",
    );
  }

  if (blockComment) {
    throw new TypeError(
      "Migration SQL contains an "
      + "unterminated block comment.",
    );
  }

  const finalStatement =
    current.trim();

  if (finalStatement) {
    statements.push(
      finalStatement,
    );
  }

  return statements;
}

export function operationalMigrationChecksum(
  sql,
) {
  return crypto
    .createHash("sha256")
    .update(
      String(sql || "")
        .replace(
          /\r\n/g,
          "\n",
        ),
    )
    .digest("hex");
}

function canonicalMigrationPaths(
  migrationPath,
) {
  const values =
    Array.isArray(
      migrationPath,
    )
      ? migrationPath
      : [
          migrationPath,
        ];

  const paths =
    values
      .map(
        (value) =>
          typeof value === "string"
            ? value.trim()
            : "",
      )
      .filter(Boolean)
      .map(
        (value) =>
          path.resolve(
            value,
          ),
      );

  if (paths.length === 0) {
    throw new TypeError(
      "At least one operational migration "
      + "path is required.",
    );
  }

  if (
    new Set(paths).size
    !== paths.length
  ) {
    throw new TypeError(
      "Operational migration paths "
      + "must be unique.",
    );
  }

  return paths;
}

async function loadMigrations(
  migrationPath =
    defaultMigrationPaths,
) {
  const migrationPaths =
    canonicalMigrationPaths(
      migrationPath,
    );

  const migrations =
    await Promise.all(
      migrationPaths.map(
        async (filePath) => {
          const sql =
            await readFile(
              filePath,
              "utf8",
            );

          const id =
            path.basename(
              filePath,
              path.extname(
                filePath,
              ),
            );

          if (
            !MIGRATION_ID_PATTERN.test(
              id,
            )
          ) {
            throw new TypeError(
              `Operational migration ${id} `
              + "has an invalid migration ID.",
            );
          }

          const statements =
            splitSqlStatements(
              sql,
            );

          if (
            statements.length === 0
          ) {
            throw new TypeError(
              `Operational migration ${id} `
              + "contains no SQL statements.",
            );
          }

          return {
            id,
            filePath,

            checksum:
              operationalMigrationChecksum(
                sql,
              ),

            statements,

            statementChecksums:
              statements.map(
                operationalMigrationChecksum,
              ),
          };
        },
      ),
    );

  migrations.sort(
    (left, right) =>
      left.id.localeCompare(
        right.id,
      ),
  );

  const migrationIds =
    migrations.map(
      (migration) =>
        migration.id,
    );

  if (
    new Set(migrationIds).size
    !== migrationIds.length
  ) {
    throw new TypeError(
      "Operational migration IDs "
      + "must be unique.",
    );
  }

  return migrations;
}

function requireConnection(
  connection,
) {
  if (
    !connection
    || typeof connection.query
      !== "function"
  ) {
    throw new TypeError(
      "A MySQL-compatible migration "
      + "connection is required.",
    );
  }

  return connection;
}

async function withConnection(
  pool,
  operation,
) {
  if (
    !pool
    || (
      typeof pool.getConnection
        !== "function"
      && typeof pool.query
        !== "function"
    )
  ) {
    throw new TypeError(
      "A MySQL-compatible migration "
      + "pool is required.",
    );
  }

  if (
    typeof pool.getConnection
    !== "function"
  ) {
    return operation(
      requireConnection(
        pool,
      ),
    );
  }

  const connection =
    requireConnection(
      await pool.getConnection(),
    );

  try {
    return await operation(
      connection,
    );
  } finally {
    connection.release();
  }
}

function isAdoptionIdempotencyError(
  error,
) {
  return new Set([
    "ER_CHECK_CONSTRAINT_DUP_NAME",
    "ER_DUP_ENTRY",
    "ER_DUP_FIELDNAME",
    "ER_DUP_KEY",
    "ER_DUP_KEYNAME",
    "ER_FK_DUP_NAME",
    "ER_TABLE_EXISTS_ERROR",
    "ER_TRG_ALREADY_EXISTS",
  ]).has(
    error?.code,
  );
}

function normalizeApplicationVersion(
  value,
) {
  if (
    value === undefined
    || value === null
    || value === ""
  ) {
    return null;
  }

  const rendered =
    String(value).trim();

  if (!rendered) {
    return null;
  }

  if (rendered.length > 128) {
    throw new TypeError(
      "applicationVersion must not "
      + "exceed 128 characters.",
    );
  }

  return rendered;
}

async function ensureMigrationHistory(
  connection,
) {
  await connection.query(
    migrationHistorySql,
  );

  await connection.query(
    migrationStatementHistorySql,
  );
}

async function readMigrationHistory(
  connection,
) {
  const [
    rows,
  ] =
    await connection.query(
      `
        SELECT
          migration_id,
          checksum,
          applied_at,
          execution_duration_ms,
          application_version
        FROM operational_migration_history
        ORDER BY migration_id
      `,
    );

  return Array.isArray(rows)
    ? rows
    : [];
}

async function readStatementHistory(
  connection,
) {
  const [
    rows,
  ] =
    await connection.query(
      `
        SELECT
          migration_id,
          statement_index,
          statement_checksum,
          adopted,
          applied_at
        FROM operational_migration_statement_history
        ORDER BY
          migration_id,
          statement_index
      `,
    );

  return Array.isArray(rows)
    ? rows
    : [];
}

function statementHistoryByMigration(
  rows,
) {
  const byMigration =
    new Map();

  for (const row of rows) {
    const migrationId =
      String(
        row.migration_id
        || "",
      ).trim();

    const statementIndex =
      Number(
        row.statement_index,
      );

    if (
      !migrationId
      || !Number.isSafeInteger(
        statementIndex,
      )
      || statementIndex <= 0
    ) {
      continue;
    }

    if (
      !byMigration.has(
        migrationId,
      )
    ) {
      byMigration.set(
        migrationId,
        new Map(),
      );
    }

    byMigration
      .get(
        migrationId,
      )
      .set(
        statementIndex,
        row,
      );
  }

  return byMigration;
}

function validateMigrationChecksums(
  migrations,
  appliedById,
) {
  for (const migration of migrations) {
    const applied =
      appliedById.get(
        migration.id,
      );

    if (
      applied
      && applied.checksum
        !== migration.checksum
    ) {
      throw new OperationalMigrationChecksumMismatchError(
        migration.id,
      );
    }
  }
}

function validateStatementChecksum(
  migration,
  statementIndex,
  recorded,
) {
  const expected =
    migration
      .statementChecksums[
        statementIndex - 1
      ];

  if (
    recorded?.statement_checksum
    !== expected
  ) {
    throw new OperationalMigrationStatementChecksumMismatchError(
      migration.id,
      statementIndex,
    );
  }
}

function requiresProspectiveMetadataVerification(
  migrations,
) {
  return migrations.some(
    (migration) =>
      migration.id
      === PROSPECTIVE_MIGRATION_ID,
  );
}

async function verifyProspectiveMetadata(
  connection,
) {
  const [
    rows,
  ] =
    await connection.query(
      `
        SELECT
          schema_version,
          migration_version
        FROM data_plane_metadata
        WHERE metadata_key = 'primary'
        LIMIT 2
      `,
    );

  if (
    !Array.isArray(rows)
    || rows.length !== 1
  ) {
    throw new OperationalMigrationMetadataError(
      "Operational data-plane metadata "
      + "must contain exactly one primary row.",
    );
  }

  const row =
    rows[0];

  if (
    String(
      row.schema_version
      ?? "",
    ).trim()
      !== PROSPECTIVE_SCHEMA_VERSION
    || Number(
      row.migration_version,
    )
      !== PROSPECTIVE_MIGRATION_VERSION
  ) {
    throw new OperationalMigrationMetadataError(
      "Operational data-plane metadata "
      + "was not advanced to schema version 14.",
    );
  }
}

export async function getOperationalMigrationStatus(
  pool,
  {
    migrationPath =
      defaultMigrationPaths,
  } = {},
) {
  const migrations =
    await loadMigrations(
      migrationPath,
    );

  return withConnection(
    pool,
    async (connection) => {
      await ensureMigrationHistory(
        connection,
      );

      const historyRows =
        await readMigrationHistory(
          connection,
        );

      const statementRows =
        await readStatementHistory(
          connection,
        );

      const appliedById =
        new Map(
          historyRows.map(
            (row) => [
              row.migration_id,
              row,
            ],
          ),
        );

      const statementsByMigration =
        statementHistoryByMigration(
          statementRows,
        );

      validateMigrationChecksums(
        migrations,
        appliedById,
      );

      const pending =
        migrations
          .filter(
            (migration) =>
              !appliedById.has(
                migration.id,
              ),
          )
          .map(
            (migration) => {
              const recorded =
                statementsByMigration.get(
                  migration.id,
                )
                || new Map();

              for (
                let index = 1;
                index
                  <= migration.statements.length;
                index += 1
              ) {
                if (
                  recorded.has(
                    index,
                  )
                ) {
                  validateStatementChecksum(
                    migration,
                    index,
                    recorded.get(
                      index,
                    ),
                  );
                }
              }

              return {
                id:
                  migration.id,

                checksum:
                  migration.checksum,

                statementCount:
                  migration.statements.length,

                completedStatementCount:
                  recorded.size,

                remainingStatementCount:
                  Math.max(
                    0,
                    migration.statements.length
                    - recorded.size,
                  ),
              };
            },
          );

      return {
        applied:
          historyRows.map(
            (row) => ({
              id:
                row.migration_id,

              checksum:
                row.checksum,

              appliedAt:
                row.applied_at,

              executionDurationMs:
                Number(
                  row.execution_duration_ms,
                ),

              applicationVersion:
                row.application_version
                || null,
            }),
          ),

        pending,

        inProgress:
          pending.filter(
            (migration) =>
              migration
                .completedStatementCount
              > 0,
          ),
      };
    },
  );
}

export async function applyMigrations(
  pool,
  migrationPath =
    defaultMigrationPaths,
  {
    applicationVersion =
      process.env
        .CLAIMGUARD_APP_VERSION
      || null,
  } = {},
) {
  const migrations =
    await loadMigrations(
      migrationPath,
    );

  const canonicalApplicationVersion =
    normalizeApplicationVersion(
      applicationVersion,
    );

  return withConnection(
    pool,
    async (connection) => {
      const [
        lockRows,
      ] =
        await connection.query(
          "SELECT GET_LOCK(?, 30) AS acquired",
          [
            MIGRATION_LOCK_NAME,
          ],
        );

      if (
        Number(
          lockRows?.[0]?.acquired,
        ) !== 1
      ) {
        throw new Error(
          "Could not acquire the "
          + "operational migration lock.",
        );
      }

      try {
        await ensureMigrationHistory(
          connection,
        );

        const historyRows =
          await readMigrationHistory(
            connection,
          );

        const statementRows =
          await readStatementHistory(
            connection,
          );

        const appliedById =
          new Map(
            historyRows.map(
              (row) => [
                row.migration_id,
                row,
              ],
            ),
          );

        const statementsByMigration =
          statementHistoryByMigration(
            statementRows,
          );

        validateMigrationChecksums(
          migrations,
          appliedById,
        );

        const applied = [];
        const skipped = [];

        let appliedStatements = 0;
        let adoptedStatements = 0;
        let resumedStatements = 0;

        for (const migration of migrations) {
          if (
            appliedById.has(
              migration.id,
            )
          ) {
            skipped.push(
              migration.id,
            );

            continue;
          }

          const recordedStatements =
            statementsByMigration.get(
              migration.id,
            )
            || new Map();

          const startedAt =
            Date.now();

          let migrationAppliedStatements = 0;
          let migrationAdoptedStatements = 0;
          let migrationResumedStatements = 0;

          for (
            let index = 0;
            index
              < migration.statements.length;
            index += 1
          ) {
            const statementIndex =
              index + 1;

            const existingStatement =
              recordedStatements.get(
                statementIndex,
              );

            if (existingStatement) {
              validateStatementChecksum(
                migration,
                statementIndex,
                existingStatement,
              );

              resumedStatements += 1;
              migrationResumedStatements += 1;

              continue;
            }

            let adopted = false;

            try {
              await connection.query(
                migration.statements[
                  index
                ],
              );
            } catch (error) {
              if (
                !isAdoptionIdempotencyError(
                  error,
                )
              ) {
                throw new OperationalMigrationExecutionError(
                  migration.id,
                  statementIndex,
                  error,
                );
              }

              adopted = true;
            }

            await connection.query(
              `
                INSERT INTO operational_migration_statement_history (
                  migration_id,
                  statement_index,
                  statement_checksum,
                  adopted
                )
                VALUES (?, ?, ?, ?)
              `,
              [
                migration.id,
                statementIndex,
                migration
                  .statementChecksums[
                    index
                  ],
                adopted ? 1 : 0,
              ],
            );

            appliedStatements += 1;
            migrationAppliedStatements += 1;

            if (adopted) {
              adoptedStatements += 1;
              migrationAdoptedStatements += 1;
            }
          }

          if (
            migration.id
            === PROSPECTIVE_MIGRATION_ID
          ) {
            await verifyProspectiveMetadata(
              connection,
            );
          }

          const executionDurationMs =
            Math.max(
              0,
              Date.now()
              - startedAt,
            );

          await connection.query(
            `
              INSERT INTO operational_migration_history (
                migration_id,
                checksum,
                execution_duration_ms,
                application_version
              )
              VALUES (?, ?, ?, ?)
            `,
            [
              migration.id,
              migration.checksum,
              executionDurationMs,
              canonicalApplicationVersion,
            ],
          );

          applied.push({
            id:
              migration.id,

            checksum:
              migration.checksum,

            executionDurationMs,

            statementCount:
              migration.statements.length,

            appliedStatements:
              migrationAppliedStatements,

            adoptedStatements:
              migrationAdoptedStatements,

            resumedStatements:
              migrationResumedStatements,
          });
        }

        if (
          requiresProspectiveMetadataVerification(
            migrations,
          )
        ) {
          await verifyProspectiveMetadata(
            connection,
          );
        }

        return {
          applied,
          skipped,
          pending: [],
          appliedStatements,
          adoptedStatements,
          resumedStatements,

          migrationPath:
            migrations.length === 1
              ? migrations[0].filePath
              : null,

          migrationPaths:
            migrations.map(
              (migration) =>
                migration.filePath,
            ),

          warning:
            "MySQL DDL can implicitly commit. "
            + "Statement-level checksums preserve "
            + "exact resume state, and a migration "
            + "is complete only after its history "
            + "row is recorded.",
        };
      } finally {
        await connection
          .query(
            "SELECT RELEASE_LOCK(?) AS released",
            [
              MIGRATION_LOCK_NAME,
            ],
          )
          .catch(
            () => undefined,
          );
      }
    },
  );
}

function databaseNameFromUrl(
  databaseUrl,
) {
  const parsed =
    new URL(
      databaseUrl,
    );

  const databaseName =
    decodeURIComponent(
      parsed.pathname
        .replace(
          /^\//,
          "",
        ),
    );

  if (
    !databaseName
    || !/^[A-Za-z0-9_-]+$/.test(
      databaseName,
    )
  ) {
    throw new TypeError(
      "MYSQL_URL must include a safe "
      + "operational database name.",
    );
  }

  return databaseName;
}

async function ensureDatabaseExists(
  databaseUrl,
) {
  const {
    buildConnectionOptions,
  } =
    await import(
      "./client.js"
    );

  const connectionOptions =
    buildConnectionOptions(
      databaseUrl,
      {
        includeDatabase: false,
      },
    );

  const databaseName =
    databaseNameFromUrl(
      databaseUrl,
    );

  const adminPool =
    await import(
      "mysql2/promise"
    ).then(
      ({
        default: mysql,
      }) =>
        mysql.createPool(
          connectionOptions,
        ),
    );

  try {
    await adminPool.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName}\``,
    );
  } finally {
    await adminPool.end();
  }
}

const isDirectExecution =
  process.argv[1]
  === fileURLToPath(
    import.meta.url,
  );

if (isDirectExecution) {
  (async () => {
    if (
      process.env
        .OPERATIONAL_ADMIN_MODE
      !== "legacy_shared"
    ) {
      throw new Error(
        "Operational migrations require "
        + "OPERATIONAL_ADMIN_MODE=legacy_shared.",
      );
    }

    const databaseUrl =
      process.env.MYSQL_URL;

    if (!databaseUrl) {
      throw new Error(
        "MYSQL_URL must be set "
        + "to run migrations",
      );
    }

    let pool;

    try {
      const {
        createMysqlConnection,
      } =
        await import(
          "./client.js"
        );

      pool =
        createMysqlConnection(
          databaseUrl,
        );

      console.log(
        JSON.stringify(
          await applyMigrations(
            pool,
          ),
          null,
          2,
        ),
      );
    } catch (error) {
      if (
        error?.code
        === "ER_BAD_DB_ERROR"
      ) {
        await ensureDatabaseExists(
          databaseUrl,
        );

        if (pool) {
          await pool.end();
        }

        const {
          createMysqlConnection,
        } =
          await import(
            "./client.js"
          );

        pool =
          createMysqlConnection(
            databaseUrl,
          );

        console.log(
          JSON.stringify(
            await applyMigrations(
              pool,
            ),
            null,
            2,
          ),
        );
      } else {
        throw error;
      }
    } finally {
      if (pool) {
        await pool.end();
      }
    }
  })().catch(
    (error) => {
      console.error(
        error,
      );

      process.exit(1);
    },
  );
}
