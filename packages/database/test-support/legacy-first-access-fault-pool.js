export const LEGACY_FIRST_ACCESS_FAULT_STAGE = Object.freeze({
  CASE_INSERTION: "after_case_insertion",
  LEGACY_LINKAGE: "after_legacy_investigation_linkage",
  NEUTRAL_TRANSITION: "after_neutral_migration_transition",
  PROCESS_CHECK: "after_migration_process_check",
  BEFORE_COMMIT: "immediately_before_commit",
});

function testFault(stage) {
  const error = new Error(`Injected legacy first-access transaction fault at ${stage}.`);
  error.name = "LegacyFirstAccessTransactionTestFault";
  error.code = "LEGACY_FIRST_ACCESS_TRANSACTION_TEST_FAULT";
  error.stage = stage;
  return error;
}

function matchingStage(sql) {
  const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
  if (normalized.startsWith("INSERT INTO INVESTIGATION_CASES")) {
    return LEGACY_FIRST_ACCESS_FAULT_STAGE.CASE_INSERTION;
  }
  if (normalized.startsWith("UPDATE INVESTIGATION_CASES")
      && normalized.includes("SET LEGACY_INVESTIGATION_ID")) {
    return LEGACY_FIRST_ACCESS_FAULT_STAGE.LEGACY_LINKAGE;
  }
  if (normalized.startsWith("INSERT INTO CASE_TRANSITION_EVENTS")
      && normalized.includes("TRIAGE_PENDING")) {
    return LEGACY_FIRST_ACCESS_FAULT_STAGE.NEUTRAL_TRANSITION;
  }
  if (normalized.startsWith("INSERT INTO CASE_PROCESS_CHECKS")
      && normalized.includes("LEGACY_MIGRATION_AUTHORIZATION")) {
    return LEGACY_FIRST_ACCESS_FAULT_STAGE.PROCESS_CHECK;
  }
  return null;
}

export function createLegacyFirstAccessFaultPool(pool, faultStage) {
  if (!pool || typeof pool.getConnection !== "function"
      || typeof pool.execute !== "function" || typeof pool.query !== "function") {
    throw new TypeError("A mysql2 transaction-capable operational pool is required.");
  }
  if (!Object.values(LEGACY_FIRST_ACCESS_FAULT_STAGE).includes(faultStage)) {
    throw new TypeError(`Unknown legacy first-access fault stage: ${faultStage}`);
  }
  let injected = false;
  return {
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        beginTransaction: (...args) => connection.beginTransaction(...args),
        async execute(sql, values = []) {
          const result = await connection.execute(sql, values);
          const stage = matchingStage(sql);
          if (!injected && stage === faultStage) {
            injected = true;
            throw testFault(stage);
          }
          return result;
        },
        async commit(...args) {
          if (!injected && faultStage === LEGACY_FIRST_ACCESS_FAULT_STAGE.BEFORE_COMMIT) {
            injected = true;
            throw testFault(faultStage);
          }
          return connection.commit(...args);
        },
        rollback: (...args) => connection.rollback(...args),
        release: (...args) => connection.release(...args),
        query: (...args) => connection.query(...args),
      };
    },
    execute: (...args) => pool.execute(...args),
    query: (...args) => pool.query(...args),
  };
}
