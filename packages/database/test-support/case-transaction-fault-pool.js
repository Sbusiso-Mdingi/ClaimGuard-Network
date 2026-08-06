export const CASE_TRANSACTION_FAULT_STAGE = Object.freeze({
  OPERATION_RESERVATION: "operation-reservation",
  IDEMPOTENCY_INTENT_PERSISTENCE: "idempotency-intent-persistence",
  CASE_ROW_ACQUISITION: "case-row-acquisition",
  CONDITIONAL_STATE_UPDATE: "conditional-state-update",
  TRANSITION_EVENT_INSERTION: "transition-event-insertion",
  AUTHORIZATION_CONTEXT_INSERTION: "authorization-context-insertion",
  PROCESS_CHECK_INSERTION: "process-check-insertion",
  REPORT_METADATA_UPDATE: "report-metadata-update",
  OUTCOME_INSERTION: "outcome-insertion",
  OPERATION_RESULT_FINALIZATION: "operation-result-finalization",
  COMMIT: "commit",
});

const VALID_STAGES = new Set(Object.values(CASE_TRANSACTION_FAULT_STAGE));

export class CaseTransactionInjectedFault extends Error {
  constructor(stage) {
    super(`Injected governed case transaction failure at ${stage}.`);
    this.name = "CaseTransactionInjectedFault";
    this.code = "CASE_TRANSACTION_TEST_FAULT";
    this.stage = stage;
  }
}

function normalizedSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function executionStage(sql, params) {
  if (/^SELECT case_id, tenant_id, signal_id,[\s\S]*FROM investigation_cases[\s\S]*FOR UPDATE$/i.test(sql)) {
    return { before: CASE_TRANSACTION_FAULT_STAGE.CASE_ROW_ACQUISITION };
  }
  if (/^INSERT INTO case_transition_operations\b/i.test(sql)) {
    return {
      before: CASE_TRANSACTION_FAULT_STAGE.OPERATION_RESERVATION,
      after: CASE_TRANSACTION_FAULT_STAGE.IDEMPOTENCY_INTENT_PERSISTENCE,
    };
  }
  if (/^INSERT INTO case_transition_events\b/i.test(sql)) {
    return { before: CASE_TRANSACTION_FAULT_STAGE.TRANSITION_EVENT_INSERTION };
  }
  if (/^INSERT INTO case_process_checks\b/i.test(sql)) {
    return {
      before: params?.[3] === "AUTHORIZATION_CONTEXT"
        ? CASE_TRANSACTION_FAULT_STAGE.AUTHORIZATION_CONTEXT_INSERTION
        : CASE_TRANSACTION_FAULT_STAGE.PROCESS_CHECK_INSERTION,
    };
  }
  if (/^INSERT INTO case_outcomes\b/i.test(sql)) {
    return { before: CASE_TRANSACTION_FAULT_STAGE.OUTCOME_INSERTION };
  }
  if (/^UPDATE investigation_cases\b/i.test(sql)) {
    return {
      before: sql.includes("report_completing_investigator_id")
        ? CASE_TRANSACTION_FAULT_STAGE.REPORT_METADATA_UPDATE
        : CASE_TRANSACTION_FAULT_STAGE.CONDITIONAL_STATE_UPDATE,
    };
  }
  if (/^UPDATE case_transition_operations SET result_payload\b/i.test(sql)) {
    return { before: CASE_TRANSACTION_FAULT_STAGE.OPERATION_RESULT_FINALIZATION };
  }
  return {};
}

function maybeThrow(configuredStage, actualStage) {
  if (configuredStage === actualStage) {
    throw new CaseTransactionInjectedFault(configuredStage);
  }
}

/**
 * Test-only mysql2 pool proxy for deterministic case-transaction failures.
 *
 * It accepts one bounded named stage and never accepts SQL, callbacks, request
 * data or environment configuration. Production operational bundles do not
 * import this module.
 */
export function createCaseTransactionFaultPool(pool, stage) {
  if (!pool || typeof pool.getConnection !== "function") {
    throw new TypeError("A mysql2 transaction-capable pool is required.");
  }
  if (!VALID_STAGES.has(stage)) {
    throw new TypeError("A recognised case transaction fault stage is required.");
  }

  return {
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        beginTransaction: (...args) => connection.beginTransaction(...args),
        rollback: (...args) => connection.rollback(...args),
        release: (...args) => connection.release(...args),
        query: (...args) => connection.query(...args),
        async commit(...args) {
          maybeThrow(stage, CASE_TRANSACTION_FAULT_STAGE.COMMIT);
          return connection.commit(...args);
        },
        async execute(sql, params = []) {
          const statement = normalizedSql(sql);
          const classified = executionStage(statement, params);
          maybeThrow(stage, classified.before);
          const result = await connection.execute(sql, params);
          maybeThrow(stage, classified.after);
          return result;
        },
      };
    },
    execute: (...args) => pool.execute(...args),
    query: (...args) => pool.query(...args),
  };
}
