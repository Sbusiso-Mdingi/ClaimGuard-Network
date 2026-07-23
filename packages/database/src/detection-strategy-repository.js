import {
  getActiveTenantId,
} from "./tenant-context-store.js";


const DEPLOYMENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const STRATEGY_TYPES = new Set([
  "deterministic_rules",
  "approved_model",
]);

const MAX_TENANT_ID_LENGTH = 64;
const MAX_ACTOR_LENGTH = 255;
const MAX_CHANGE_REASON_LENGTH = 500;


export class DetectionStrategyValidationError
  extends Error {
  constructor(message) {
    super(message);

    this.name =
      "DetectionStrategyValidationError";

    this.code =
      "DETECTION_STRATEGY_INVALID";

    this.status = 400;
  }
}


export class DetectionStrategyIntegrityError
  extends Error {
  constructor(message) {
    super(message);

    this.name =
      "DetectionStrategyIntegrityError";

    this.code =
      "DETECTION_STRATEGY_INTEGRITY_ERROR";

    this.status = 500;
  }
}


function validationError(
  message,
) {
  return new DetectionStrategyValidationError(
    message,
  );
}


function integrityError(
  message,
) {
  return new DetectionStrategyIntegrityError(
    message,
  );
}


function requireText(
  value,
  field,
  maximumLength,
) {
  const canonical =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!canonical) {
    throw validationError(
      `${field} is required.`,
    );
  }

  if (
    canonical.length
    > maximumLength
  ) {
    throw validationError(
      `${field} must not exceed `
      + `${maximumLength} characters.`,
    );
  }

  return canonical;
}


function requireStoredText(
  value,
  field,
  maximumLength,
) {
  const canonical =
    typeof value === "string"
      ? value.trim()
      : "";

  if (
    !canonical
    || canonical.length
      > maximumLength
  ) {
    throw integrityError(
      `Stored detection strategy ${field} is invalid.`,
    );
  }

  return canonical;
}


function approvedDeploymentIds() {
  return new Set(
    String(
      process.env
        .APPROVED_MODEL_DEPLOYMENT_IDS
      || "",
    )
      .split(",")
      .map(
        (value) =>
          value.trim(),
      )
      .filter(Boolean),
  );
}


function dataPlaneTenantMismatchError() {
  const error =
    new Error(
      "Detection strategy tenant does not "
      + "match the verified data-plane context.",
    );

  error.code =
    "DATA_PLANE_TENANT_MISMATCH";

  error.status = 403;

  return error;
}


function dataPlaneContextRequiredError() {
  const error =
    new Error(
      "An explicit verified DataPlaneContext "
      + "is required for detection strategy access.",
    );

  error.code =
    "DATA_PLANE_CONTEXT_REQUIRED";

  error.status = 503;

  return error;
}


function resolveTenantId({
  pinnedTenantId,
  allowLegacyTenantContext,
  tenantContext,
}) {
  const requestedTenantId =
    typeof tenantContext?.tenant_id
      === "string"
      ? tenantContext.tenant_id.trim()
      : "";

  if (pinnedTenantId) {
    if (
      requestedTenantId
      && requestedTenantId
        !== pinnedTenantId
    ) {
      throw dataPlaneTenantMismatchError();
    }

    return pinnedTenantId;
  }

  if (!allowLegacyTenantContext) {
    throw dataPlaneContextRequiredError();
  }

  return requireText(
    requestedTenantId
    || getActiveTenantId(),
    "tenantId",
    MAX_TENANT_ID_LENGTH,
  );
}


function normalizeRequestedStrategy({
  strategyType,
  modelDeploymentId = null,
  actor,
  changeReason,
}) {
  const canonicalStrategy =
    requireText(
      strategyType,
      "strategyType",
      64,
    );

  if (
    !STRATEGY_TYPES.has(
      canonicalStrategy,
    )
  ) {
    throw validationError(
      "Unsupported detection strategy.",
    );
  }

  const canonicalDeploymentId =
    modelDeploymentId === undefined
    || modelDeploymentId === null
    || modelDeploymentId === ""
      ? null
      : requireText(
          modelDeploymentId,
          "modelDeploymentId",
          128,
        );

  if (
    canonicalStrategy
    === "approved_model"
  ) {
    if (
      !canonicalDeploymentId
      || !DEPLOYMENT_ID_PATTERN.test(
        canonicalDeploymentId,
      )
      || !approvedDeploymentIds().has(
        canonicalDeploymentId,
      )
    ) {
      throw validationError(
        "The model deployment is not "
        + "approved in this environment.",
      );
    }
  } else if (
    canonicalDeploymentId
    !== null
  ) {
    throw validationError(
      "Deterministic strategy cannot "
      + "select a model deployment.",
    );
  }

  return {
    strategyType:
      canonicalStrategy,

    modelDeploymentId:
      canonicalDeploymentId,

    actor:
      requireText(
        actor,
        "actor",
        MAX_ACTOR_LENGTH,
      ),

    changeReason:
      requireText(
        changeReason,
        "changeReason",
        MAX_CHANGE_REASON_LENGTH,
      ),
  };
}


function normalizeStoredStrategy(
  row,
  expectedTenantId,
) {
  if (
    !row
    || typeof row !== "object"
    || Array.isArray(row)
  ) {
    throw integrityError(
      "Stored detection strategy row is invalid.",
    );
  }

  const strategyId =
    Number(
      row.id,
    );

  if (
    !Number.isSafeInteger(
      strategyId,
    )
    || strategyId <= 0
  ) {
    throw integrityError(
      "Stored detection strategy ID is invalid.",
    );
  }

  const tenantId =
    requireStoredText(
      row.tenant_id,
      "tenant_id",
      MAX_TENANT_ID_LENGTH,
    );

  if (
    tenantId
    !== expectedTenantId
  ) {
    throw integrityError(
      "Stored detection strategy tenant "
      + "does not match the requested tenant.",
    );
  }

  const strategyType =
    requireStoredText(
      row.strategy_type,
      "strategy_type",
      64,
    );

  if (
    !STRATEGY_TYPES.has(
      strategyType,
    )
  ) {
    throw integrityError(
      "Stored detection strategy type "
      + "is unsupported.",
    );
  }

  const modelDeploymentId =
    row.model_deployment_id
      === undefined
    || row.model_deployment_id
      === null
    || row.model_deployment_id
      === ""
      ? null
      : requireStoredText(
          row.model_deployment_id,
          "model_deployment_id",
          128,
        );

  if (
    strategyType
      === "approved_model"
    && (
      !modelDeploymentId
      || !DEPLOYMENT_ID_PATTERN.test(
        modelDeploymentId,
      )
    )
  ) {
    throw integrityError(
      "Stored approved-model strategy "
      + "has an invalid deployment identifier.",
    );
  }

  if (
    strategyType
      === "deterministic_rules"
    && modelDeploymentId
      !== null
  ) {
    throw integrityError(
      "Stored deterministic strategy "
      + "unexpectedly references a model deployment.",
    );
  }

  const isActive =
    Number(
      row.is_active,
    );

  if (isActive !== 1) {
    throw integrityError(
      "Stored active detection strategy "
      + "is not marked active.",
    );
  }

  const actor =
    requireStoredText(
      row.actor,
      "actor",
      MAX_ACTOR_LENGTH,
    );

  const changeReason =
    requireStoredText(
      row.change_reason,
      "change_reason",
      MAX_CHANGE_REASON_LENGTH,
    );

  if (!row.activated_at) {
    throw integrityError(
      "Stored detection strategy "
      + "has no activation timestamp.",
    );
  }

  return {
    strategyId,
    tenantId,
    strategyType,
    modelDeploymentId,
    isActive,
    activatedAt:
      row.activated_at,
    deactivatedAt:
      row.deactivated_at
      ?? null,
    actor,
    changeReason,
    createdAt:
      row.created_at
      ?? null,
    updatedAt:
      row.updated_at
      ?? null,
  };
}


async function readActiveStrategy(
  executor,
  tenantId,
  {
    forUpdate = false,
  } = {},
) {
  const [rows] =
    await executor.execute(
      `
        SELECT
          id,
          tenant_id,
          strategy_type,
          model_deployment_id,
          is_active,
          activated_at,
          deactivated_at,
          actor,
          change_reason,
          created_at,
          updated_at
        FROM detection_strategies
        WHERE tenant_id = ?
          AND is_active = 1
        ORDER BY
          activated_at DESC,
          id DESC
        LIMIT 2
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [
        tenantId,
      ],
    );

  const activeRows =
    Array.isArray(rows)
      ? rows
      : [];

  if (
    activeRows.length === 0
  ) {
    throw integrityError(
      "Tenant has no active detection strategy.",
    );
  }

  if (
    activeRows.length !== 1
  ) {
    throw integrityError(
      "Tenant has multiple active "
      + "detection strategies.",
    );
  }

  return normalizeStoredStrategy(
    activeRows[0],
    tenantId,
  );
}


function sameConfiguration(
  current,
  requested,
) {
  return (
    current.strategyType
      === requested.strategyType
    && current.modelDeploymentId
      === requested.modelDeploymentId
  );
}


function requirePool(
  pool,
) {
  if (
    !pool
    || typeof pool.execute
      !== "function"
    || typeof pool.getConnection
      !== "function"
  ) {
    throw new TypeError(
      "A MySQL-compatible pool is required.",
    );
  }

  return pool;
}


export function createDetectionStrategyRepository(
  _db,
  suppliedPool,
  options = {},
) {
  const pool =
    requirePool(
      suppliedPool,
    );

  const allowLegacyTenantContext =
    options.allowLegacyTenantContext
    === true;

  const pinnedTenantId =
    options
      .dataPlaneContext
      ?.operationalTenantId
    || null;

  const tenantIdFor =
    (tenantContext) =>
      resolveTenantId({
        pinnedTenantId,
        allowLegacyTenantContext,
        tenantContext,
      });

  return Object.freeze({
    async getActiveStrategy(
      tenantContext,
    ) {
      const tenantId =
        tenantIdFor(
          tenantContext,
        );

      return readActiveStrategy(
        pool,
        tenantId,
      );
    },

    async setStrategy(
      tenantContext,
      change = {},
    ) {
      const tenantId =
        tenantIdFor(
          tenantContext,
        );

      const requested =
        normalizeRequestedStrategy(
          change,
        );

      const connection =
        await pool.getConnection();

      try {
        await connection
          .beginTransaction();

        const current =
          await readActiveStrategy(
            connection,
            tenantId,
            {
              forUpdate: true,
            },
          );

        /*
         * Safe retry behaviour:
         *
         * A client may retry after losing the first
         * successful response. Do not create a false
         * strategy transition when the exact requested
         * configuration is already active.
         */
        if (
          sameConfiguration(
            current,
            requested,
          )
        ) {
          await connection.commit();

          return {
            ...current,
            changed: false,
          };
        }

        const [
          deactivateResult,
        ] =
          await connection.execute(
            `
              UPDATE detection_strategies
              SET
                is_active = 0,
                deactivated_at =
                  UTC_TIMESTAMP(3)
              WHERE id = ?
                AND tenant_id = ?
                AND is_active = 1
            `,
            [
              current.strategyId,
              tenantId,
            ],
          );

        if (
          Number(
            deactivateResult
              ?.affectedRows
            || 0,
          ) !== 1
        ) {
          throw integrityError(
            "The active detection strategy changed "
            + "while it was being replaced.",
          );
        }

        const [
          insertResult,
        ] =
          await connection.execute(
            `
              INSERT INTO detection_strategies (
                tenant_id,
                strategy_type,
                model_deployment_id,
                is_active,
                activated_at,
                actor,
                change_reason
              )
              VALUES (
                ?,
                ?,
                ?,
                1,
                UTC_TIMESTAMP(3),
                ?,
                ?
              )
            `,
            [
              tenantId,
              requested.strategyType,
              requested.modelDeploymentId,
              requested.actor,
              requested.changeReason,
            ],
          );

        const insertedStrategyId =
          Number(
            insertResult
              ?.insertId,
          );

        if (
          !Number.isSafeInteger(
            insertedStrategyId,
          )
          || insertedStrategyId <= 0
        ) {
          throw integrityError(
            "The new detection strategy "
            + "did not return a valid strategy ID.",
          );
        }

        const [
          insertedRows,
        ] =
          await connection.execute(
            `
              SELECT
                id,
                tenant_id,
                strategy_type,
                model_deployment_id,
                is_active,
                activated_at,
                deactivated_at,
                actor,
                change_reason,
                created_at,
                updated_at
              FROM detection_strategies
              WHERE id = ?
                AND tenant_id = ?
              LIMIT 1
            `,
            [
              insertedStrategyId,
              tenantId,
            ],
          );

        if (
          !Array.isArray(
            insertedRows,
          )
          || insertedRows.length
            !== 1
        ) {
          throw integrityError(
            "The new detection strategy "
            + "could not be read after insertion.",
          );
        }

        const inserted =
          normalizeStoredStrategy(
            insertedRows[0],
            tenantId,
          );

        if (
          inserted.strategyId
            !== insertedStrategyId
          || !sameConfiguration(
            inserted,
            requested,
          )
          || inserted.actor
            !== requested.actor
          || inserted.changeReason
            !== requested.changeReason
        ) {
          throw integrityError(
            "The stored detection strategy differs "
            + "from the requested transition.",
          );
        }

        await connection.commit();

        return {
          ...inserted,
          changed: true,
        };
      } catch (error) {
        await connection.rollback();

        throw error;
      } finally {
        connection.release();
      }
    },
  });
}
