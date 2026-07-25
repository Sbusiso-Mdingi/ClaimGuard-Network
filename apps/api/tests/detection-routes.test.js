import assert from "node:assert/strict";
import test from "node:test";

import { detectionResponse } from "../src/routes/detection-routes.js";

function responseContext() {
  return {
    json(body, status) {
      return { body, status };
    },
  };
}

test("pending detection resources use 202 instead of an expected 404", () => {
  const result = detectionResponse(responseContext(), {
    status: 404,
    body: {
      available: false,
      code: "TENANT_REPORT_NOT_FOUND",
      message: "No report has been generated yet.",
    },
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.available, false);
  assert.equal(result.body.code, "TENANT_REPORT_NOT_FOUND");
});

test("non-pending detection response statuses are preserved", () => {
  const result = detectionResponse(responseContext(), {
    status: 503,
    body: {
      available: false,
      code: "REPORT_STORAGE_UNAVAILABLE",
    },
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "REPORT_STORAGE_UNAVAILABLE");
});
