import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableCaseTransactionError,
} from "../src/case-workflow-repository.js";

test("governed case retries recognise bounded MySQL concurrency signals", () => {
  assert.equal(isRetryableCaseTransactionError({ code: "ER_LOCK_DEADLOCK" }), true);
  assert.equal(isRetryableCaseTransactionError({ errno: 1213 }), true);
  assert.equal(isRetryableCaseTransactionError({ sqlState: "40001" }), true);
  assert.equal(isRetryableCaseTransactionError({ code: "ER_LOCK_WAIT_TIMEOUT" }), true);
  assert.equal(isRetryableCaseTransactionError({ errno: 1205 }), true);
});

test("governed case retries do not absorb unrelated database failures", () => {
  for (const error of [
    { code: "ER_PARSE_ERROR", errno: 1064, sqlState: "42000" },
    { code: "ER_ACCESS_DENIED_ERROR", errno: 1045, sqlState: "28000" },
    { code: "ER_NO_REFERENCED_ROW_2", errno: 1452, sqlState: "23000" },
    new Error("unexpected failure"),
  ]) {
    assert.equal(isRetryableCaseTransactionError(error), false);
  }
});
