import assert from "node:assert/strict";
import {
  afterEach,
  test,
} from "node:test";

import {
  createDetectionStrategyRepository,
  DetectionStrategyIntegrityError,
  DetectionStrategyValidationError,
} from "../src/detection-strategy-repository.js";


const ORIGINAL_APPROVED_DEPLOYMENTS =
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS;

const ACTIVATED_AT =
  "2026-07-23 12:30:45.123";

const CREATED_AT =
  "2026-07-20 09:00:00.000";

const UPDATED_AT =
  "2026-07-20 09:00:00.000";

const APPROVED_DEPLOYMENT_ID =
  "claimguard-claim-fraud-ensemble:1.1.0";


afterEach(() => {
  if (
    ORIGINAL_APPROVED_DEPLOYMENTS
    === undefined
  ) {
    delete process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS;
  } else {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        ORIGINAL_APPROVED_DEPLOYMENTS;
  }
});


function dataPlaneContext(
  tenantId = "tenant_alpha",
) {
  return {
    operationalTenantId:
      tenantId,
  };
}


function strategyRow(
  overrides = {},
) {
  return {
    id: 1,
    tenant_id: "tenant_alpha",
    strategy_type:
      "deterministic_rules",
    model_deployment_id: null,
    is_active: 1,
    activated_at:
      ACTIVATED_AT,
    deactivated_at: null,
    actor:
      "migration:0014",
    change_reason:
      "Created explicit default prospective detection strategy",
    created_at:
      CREATED_AT,
    updated_at:
      UPDATED_AT,
    ...overrides,
  };
}


function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}


function cloneRows(rows) {
  return rows.map(
    (row) => ({
      ...row,
    }),
  );
}


function createStrategyPool({
  initialRows = [
    strategyRow(),
  ],
  insertedStrategyId = 2,
  insertedReadOverrides = null,
  deactivateAffectedRows = null,
  insertError = null,
} = {}) {
  const state = {
    rows:
      cloneRows(
        initialRows,
      ),

    calls: [],
  };

  function activeRows(
    tenantId,
  ) {
    return state.rows
      .filter(
        (row) => (
          row.tenant_id
            === tenantId
          && Number(
            row.is_active,
          ) === 1
        ),
      )
      .sort(
        (left, right) =>
          Number(
            right.id,
          )
          - Number(
            left.id,
          ),
      )
      .slice(
        0,
        2,
      )
      .map(
        (row) => ({
          ...row,
        }),
      );
  }

  async function executeStatement({
    scope,
    sql,
    params = [],
  }) {
    const statement =
      normalizeSql(sql);

    state.calls.push({
      operation:
        "execute",
      scope,
      sql:
        statement,
      params,
    });

    if (
      statement.includes(
        "FROM detection_strategies",
      )
      && statement.includes(
        "WHERE tenant_id = ?",
      )
      && statement.includes(
        "AND is_active = 1",
      )
    ) {
      return [
        activeRows(
          params[0],
        ),
      ];
    }

    if (
      statement.startsWith(
        "UPDATE detection_strategies SET is_active = 0",
      )
    ) {
      const [
        strategyId,
        tenantId,
      ] = params;

      if (
        deactivateAffectedRows
        !== null
      ) {
        return [
          {
            affectedRows:
              deactivateAffectedRows,
          },
        ];
      }

      const active =
        state.rows.find(
          (row) => (
            Number(
              row.id,
            ) === Number(
              strategyId,
            )
            && row.tenant_id
              === tenantId
            && Number(
              row.is_active,
            ) === 1
          ),
        );

      if (!active) {
        return [
          {
            affectedRows: 0,
          },
        ];
      }

      active.is_active = 0;

      active.deactivated_at =
        ACTIVATED_AT;

      return [
        {
          affectedRows: 1,
        },
      ];
    }

    if (
      statement.startsWith(
        "INSERT INTO detection_strategies",
      )
    ) {
      if (insertError) {
        throw insertError;
      }

      const [
        tenantId,
        strategyType,
        modelDeploymentId,
        actor,
        changeReason,
      ] = params;

      state.rows.push({
        id:
          insertedStrategyId,

        tenant_id:
          tenantId,

        strategy_type:
          strategyType,

        model_deployment_id:
          modelDeploymentId,

        is_active: 1,

        activated_at:
          ACTIVATED_AT,

        deactivated_at:
          null,

        actor,

        change_reason:
          changeReason,

        created_at:
          ACTIVATED_AT,

        updated_at:
          ACTIVATED_AT,
      });

      return [
        {
          affectedRows: 1,
          insertId:
            insertedStrategyId,
        },
      ];
    }

    if (
      statement.includes(
        "FROM detection_strategies",
      )
      && statement.includes(
        "WHERE id = ?",
      )
      && statement.includes(
        "AND tenant_id = ?",
      )
    ) {
      const [
        strategyId,
        tenantId,
      ] = params;

      const stored =
        state.rows.find(
          (row) => (
            Number(
              row.id,
            ) === Number(
              strategyId,
            )
            && row.tenant_id
              === tenantId
          ),
        );

      if (!stored) {
        return [
          [],
        ];
      }

      return [
        [
          {
            ...stored,
            ...(
              insertedReadOverrides
              || {}
            ),
          },
        ],
      ];
    }

    throw new Error(
      `Unexpected SQL: ${statement}`,
    );
  }

  const pool = {
    get rows() {
      return state.rows;
    },

    get calls() {
      return state.calls;
    },

    async execute(
      sql,
      params,
    ) {
      return executeStatement({
        scope: "pool",
        sql,
        params,
      });
    },

    async getConnection() {
      let transactionSnapshot =
        null;

      return {
        async beginTransaction() {
          state.calls.push({
            operation:
              "begin",
          });

          transactionSnapshot =
            cloneRows(
              state.rows,
            );
        },

        async execute(
          sql,
          params,
        ) {
          return executeStatement({
            scope:
              "connection",
            sql,
            params,
          });
        },

        async commit() {
          state.calls.push({
            operation:
              "commit",
          });

          transactionSnapshot =
            null;
        },

        async rollback() {
          state.calls.push({
            operation:
              "rollback",
          });

          if (
            transactionSnapshot
          ) {
            state.rows =
              cloneRows(
                transactionSnapshot,
              );
          }
        },

        release() {
          state.calls.push({
            operation:
              "release",
          });
        },
      };
    },
  };

  return pool;
}


function createRepository(
  pool,
  tenantId = "tenant_alpha",
) {
  return createDetectionStrategyRepository(
    null,
    pool,
    {
      dataPlaneContext:
        dataPlaneContext(
          tenantId,
        ),

      allowLegacyTenantContext:
        false,
    },
  );
}


test(
  "active strategy reads include immutable strategy and audit identity",
  async () => {
    const pool =
      createStrategyPool();

    const repository =
      createRepository(
        pool,
      );

    const result =
      await repository
        .getActiveStrategy({
          tenant_id:
            "tenant_alpha",
        });

    assert.deepEqual(
      result,
      {
        strategyId: 1,
        tenantId:
          "tenant_alpha",

        strategyType:
          "deterministic_rules",

        modelDeploymentId:
          null,

        isActive: 1,

        activatedAt:
          ACTIVATED_AT,

        deactivatedAt:
          null,

        actor:
          "migration:0014",

        changeReason:
          "Created explicit default prospective detection strategy",

        createdAt:
          CREATED_AT,

        updatedAt:
          UPDATED_AT,
      },
    );

    const select =
      pool.calls.find(
        (call) =>
          call.operation
            === "execute",
      );

    assert.match(
      select.sql,
      /LIMIT 2/i,
    );

    assert.equal(
      select.scope,
      "pool",
    );
  },
);


test(
  "approved model activation stores actor and change reason and returns the inserted strategy",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    const pool =
      createStrategyPool();

    const repository =
      createRepository(
        pool,
      );

    const result =
      await repository
        .setStrategy(
          {
            tenant_id:
              "tenant_alpha",
          },
          {
            strategyType:
              "approved_model",

            modelDeploymentId:
              ` ${APPROVED_DEPLOYMENT_ID} `,

            actor:
              " scheme-admin-1 ",

            changeReason:
              " Activate the validated production model. ",
          },
        );

    assert.deepEqual(
      result,
      {
        strategyId: 2,
        tenantId:
          "tenant_alpha",

        strategyType:
          "approved_model",

        modelDeploymentId:
          APPROVED_DEPLOYMENT_ID,

        isActive: 1,

        activatedAt:
          ACTIVATED_AT,

        deactivatedAt:
          null,

        actor:
          "scheme-admin-1",

        changeReason:
          "Activate the validated production model.",

        createdAt:
          ACTIVATED_AT,

        updatedAt:
          ACTIVATED_AT,

        changed: true,
      },
    );

    const original =
      pool.rows.find(
        (row) =>
          row.id === 1,
      );

    assert.equal(
      original.is_active,
      0,
    );

    assert.equal(
      original.deactivated_at,
      ACTIVATED_AT,
    );

    const inserted =
      pool.rows.find(
        (row) =>
          row.id === 2,
      );

    assert.equal(
      inserted.is_active,
      1,
    );

    assert.equal(
      inserted.actor,
      "scheme-admin-1",
    );

    assert.equal(
      inserted.change_reason,
      "Activate the validated production model.",
    );

    const insertCall =
      pool.calls.find(
        (call) => (
          call.operation
            === "execute"
          && call.sql.startsWith(
            "INSERT INTO detection_strategies",
          )
        ),
      );

    assert.deepEqual(
      insertCall.params,
      [
        "tenant_alpha",
        "approved_model",
        APPROVED_DEPLOYMENT_ID,
        "scheme-admin-1",
        "Activate the validated production model.",
      ],
    );

    assert.equal(
      pool.calls.some(
        (call) =>
          call.operation
            === "commit",
      ),
      true,
    );

    assert.equal(
      pool.calls.some(
        (call) =>
          call.operation
            === "rollback",
      ),
      false,
    );
  },
);


test(
  "an identical retry commits as a no-op without creating false audit history",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    const pool =
      createStrategyPool({
        initialRows: [
          strategyRow({
            id: 7,

            strategy_type:
              "approved_model",

            model_deployment_id:
              APPROVED_DEPLOYMENT_ID,

            actor:
              "scheme-admin-original",

            change_reason:
              "Original approved activation",
          }),
        ],
      });

    const repository =
      createRepository(
        pool,
      );

    const result =
      await repository
        .setStrategy(
          {
            tenant_id:
              "tenant_alpha",
          },
          {
            strategyType:
              "approved_model",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            actor:
              "scheme-admin-retry",

            changeReason:
              "Retry after response interruption",
          },
        );

    assert.equal(
      result.changed,
      false,
    );

    assert.equal(
      result.strategyId,
      7,
    );

    assert.equal(
      result.actor,
      "scheme-admin-original",
    );

    assert.equal(
      result.changeReason,
      "Original approved activation",
    );

    assert.equal(
      pool.rows.length,
      1,
    );

    assert.equal(
      pool.calls.some(
        (call) => (
          call.operation
            === "execute"
          && call.sql.startsWith(
            "UPDATE detection_strategies",
          )
        ),
      ),
      false,
    );

    assert.equal(
      pool.calls.some(
        (call) => (
          call.operation
            === "execute"
          && call.sql.startsWith(
            "INSERT INTO detection_strategies",
          )
        ),
      ),
      false,
    );

    assert.equal(
      pool.calls.some(
        (call) =>
          call.operation
            === "commit",
      ),
      true,
    );
  },
);


test(
  "strategy changes require complete audit fields before opening a transaction",
  async () => {
    const pool =
      createStrategyPool();

    const repository =
      createRepository(
        pool,
      );

    const invalidChanges = [
      {
        strategyType:
          "deterministic_rules",

        changeReason:
          "Missing actor",
      },

      {
        strategyType:
          "deterministic_rules",

        actor:
          "scheme-admin-1",
      },

      {
        strategyType:
          "deterministic_rules",

        actor:
          "a".repeat(
            256,
          ),

        changeReason:
          "Actor is too long",
      },

      {
        strategyType:
          "deterministic_rules",

        actor:
          "scheme-admin-1",

        changeReason:
          "r".repeat(
            501,
          ),
      },
    ];

    for (
      const change
      of invalidChanges
    ) {
      await assert.rejects(
        () =>
          repository.setStrategy(
            {
              tenant_id:
                "tenant_alpha",
            },
            change,
          ),
        (error) => (
          error
            instanceof
            DetectionStrategyValidationError
          && error.code
            === "DETECTION_STRATEGY_INVALID"
          && error.status === 400
        ),
      );
    }

    assert.equal(
      pool.calls.length,
      0,
    );
  },
);


test(
  "strategy validation rejects endpoints, secrets, unapproved deployments, and mixed deterministic configuration",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    const pool =
      createStrategyPool();

    const repository =
      createRepository(
        pool,
      );

    const invalidModelIds = [
      "https://models.example/review",
      "secret://model-token",
      "unapproved-model:9.9.9",
    ];

    for (
      const modelDeploymentId
      of invalidModelIds
    ) {
      await assert.rejects(
        () =>
          repository.setStrategy(
            {
              tenant_id:
                "tenant_alpha",
            },
            {
              strategyType:
                "approved_model",

              modelDeploymentId,

              actor:
                "scheme-admin-1",

              changeReason:
                "Attempt invalid model activation",
            },
          ),
        (error) => (
          error
            instanceof
            DetectionStrategyValidationError
          && error.code
            === "DETECTION_STRATEGY_INVALID"
        ),
      );
    }

    await assert.rejects(
      () =>
        repository.setStrategy(
          {
            tenant_id:
              "tenant_alpha",
          },
          {
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            actor:
              "scheme-admin-1",

            changeReason:
              "Invalid mixed configuration",
          },
        ),
      (error) => (
        error
          instanceof
          DetectionStrategyValidationError
        && error.code
          === "DETECTION_STRATEGY_INVALID"
      ),
    );

    assert.equal(
      pool.calls.length,
      0,
    );
  },
);


test(
  "zero or multiple active strategies are treated as integrity failures",
  async () => {
    for (
      const initialRows
      of [
        [],
        [
          strategyRow({
            id: 1,
          }),
          strategyRow({
            id: 2,
            actor:
              "corrupt-second-row",
          }),
        ],
      ]
    ) {
      const pool =
        createStrategyPool({
          initialRows,
        });

      const repository =
        createRepository(
          pool,
        );

      await assert.rejects(
        () =>
          repository
            .getActiveStrategy({
              tenant_id:
                "tenant_alpha",
            }),
        (error) => (
          error
            instanceof
            DetectionStrategyIntegrityError
          && error.code
            === "DETECTION_STRATEGY_INTEGRITY_ERROR"
          && error.status === 500
        ),
      );
    }
  },
);


test(
  "invalid stored audit or strategy configuration fails closed",
  async () => {
    const invalidRows = [
      strategyRow({
        actor: "",
      }),

      strategyRow({
        change_reason: null,
      }),

      strategyRow({
        activated_at: null,
      }),

      strategyRow({
        strategy_type:
          "approved_model",

        model_deployment_id:
          null,
      }),

      strategyRow({
        strategy_type:
          "deterministic_rules",

        model_deployment_id:
          APPROVED_DEPLOYMENT_ID,
      }),
    ];

    for (
      const invalidRow
      of invalidRows
    ) {
      const pool =
        createStrategyPool({
          initialRows: [
            invalidRow,
          ],
        });

      const repository =
        createRepository(
          pool,
        );

      await assert.rejects(
        () =>
          repository
            .getActiveStrategy({
              tenant_id:
                "tenant_alpha",
            }),
        (error) => (
          error
            instanceof
            DetectionStrategyIntegrityError
          && error.code
            === "DETECTION_STRATEGY_INTEGRITY_ERROR"
        ),
      );
    }
  },
);


test(
  "failed replacement rolls back the deactivation and releases the connection",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    const pool =
      createStrategyPool({
        insertedReadOverrides: {
          actor:
            "unexpected-actor",
        },
      });

    const repository =
      createRepository(
        pool,
      );

    await assert.rejects(
      () =>
        repository.setStrategy(
          {
            tenant_id:
              "tenant_alpha",
          },
          {
            strategyType:
              "approved_model",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            actor:
              "scheme-admin-1",

            changeReason:
              "Activate approved model",
          },
        ),
      (error) => (
        error
          instanceof
          DetectionStrategyIntegrityError
        && error.code
          === "DETECTION_STRATEGY_INTEGRITY_ERROR"
      ),
    );

    assert.equal(
      pool.rows.length,
      1,
    );

    assert.equal(
      pool.rows[0].id,
      1,
    );

    assert.equal(
      pool.rows[0].is_active,
      1,
    );

    assert.equal(
      pool.rows[0].deactivated_at,
      null,
    );

    assert.equal(
      pool.calls.some(
        (call) =>
          call.operation
            === "rollback",
      ),
      true,
    );

    assert.equal(
      pool.calls.at(-1)
        .operation,
      "release",
    );
  },
);


test(
  "strategy access remains pinned to the verified operational tenant",
  async () => {
    const pool =
      createStrategyPool();

    const repository =
      createRepository(
        pool,
        "tenant_alpha",
      );

    await assert.rejects(
      () =>
        repository
          .getActiveStrategy({
            tenant_id:
              "tenant_beta",
          }),
      (error) =>
        error.code
        === "DATA_PLANE_TENANT_MISMATCH",
    );

    assert.equal(
      pool.calls.length,
      0,
    );
  },
);


test(
  "legacy tenant fallback is disabled unless explicitly enabled",
  async () => {
    const pool =
      createStrategyPool();

    const repository =
      createDetectionStrategyRepository(
        null,
        pool,
      );

    await assert.rejects(
      () =>
        repository
          .getActiveStrategy({
            tenant_id:
              "tenant_alpha",
          }),
      (error) =>
        error.code
        === "DATA_PLANE_CONTEXT_REQUIRED",
    );

    assert.equal(
      pool.calls.length,
      0,
    );
  },
);
