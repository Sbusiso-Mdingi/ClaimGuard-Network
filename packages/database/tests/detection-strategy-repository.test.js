import assert from "node:assert/strict";
import test from "node:test";

import { createDetectionStrategyRepository } from "../src/detection-strategy-repository.js";

function context() {
  return {
    operationalTenantId: "tenant_alpha",
  };
}

function poolStub({ rows = [] } = {}) {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push({ operation: "begin" });
    },
    async execute(sql, params) {
      calls.push({ operation: "execute", sql, params });
      return [rows];
    },
    async commit() {
      calls.push({ operation: "commit" });
    },
    async rollback() {
      calls.push({ operation: "rollback" });
    },
    release() {
      calls.push({ operation: "release" });
    },
  };
  return {
    calls,
    async execute(sql, params) {
      calls.push({ operation: "pool-execute", sql, params });
      return [rows];
    },
    async getConnection() {
      return connection;
    },
  };
}

test("approved model selection stores only an allowlisted deployment identifier", async () => {
  const previous = process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS = "claim-review-ensemble-1.1.0";
  try {
    const pool = poolStub();
    const repository = createDetectionStrategyRepository(null, pool, {
      dataPlaneContext: context(),
      allowLegacyTenantContext: false,
    });

    const result = await repository.setStrategy(
      { tenant_id: "tenant_alpha" },
      {
        strategyType: "approved_model",
        modelDeploymentId: "claim-review-ensemble-1.1.0",
      },
    );

    assert.deepEqual(result, {
      tenantId: "tenant_alpha",
      strategyType: "approved_model",
      modelDeploymentId: "claim-review-ensemble-1.1.0",
    });
    const insert = pool.calls.find(
      (call) => call.operation === "execute" && /INSERT INTO detection_strategies/.test(call.sql),
    );
    assert.deepEqual(insert.params, [
      "tenant_alpha",
      "approved_model",
      "claim-review-ensemble-1.1.0",
      undefined,
      undefined,
    ]);
    assert.equal(pool.calls.some((call) => call.operation === "commit"), true);
    assert.equal(pool.calls.some((call) => call.operation === "rollback"), false);
  } finally {
    if (previous === undefined) delete process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
    else process.env.APPROVED_MODEL_DEPLOYMENT_IDS = previous;
  }
});

test("strategy validation rejects endpoints, secrets, and unapproved deployments before writes", async () => {
  const previous = process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS = "approved-v1";
  try {
    const pool = poolStub();
    const repository = createDetectionStrategyRepository(null, pool, {
      dataPlaneContext: context(),
      allowLegacyTenantContext: false,
    });

    for (const modelDeploymentId of [
      "https://models.example/review",
      "secret://model-token",
      "unapproved-v2",
    ]) {
      await assert.rejects(
        () => repository.setStrategy(
          { tenant_id: "tenant_alpha" },
          { strategyType: "approved_model", modelDeploymentId },
        ),
        (error) => error.code === "DETECTION_STRATEGY_INVALID",
      );
    }
    await assert.rejects(
      () => repository.setStrategy(
        { tenant_id: "tenant_alpha" },
        { strategyType: "deterministic_rules", modelDeploymentId: "approved-v1" },
      ),
      (error) => error.code === "DETECTION_STRATEGY_INVALID",
    );
    assert.equal(pool.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
    else process.env.APPROVED_MODEL_DEPLOYMENT_IDS = previous;
  }
});

test("strategy access is pinned to the verified operational tenant", async () => {
  const pool = poolStub();
  const repository = createDetectionStrategyRepository(null, pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  await assert.rejects(
    () => repository.getActiveStrategy({ tenant_id: "tenant_beta" }),
    (error) => error.code === "DATA_PLANE_TENANT_MISMATCH",
  );
  assert.equal(pool.calls.length, 0);
});
