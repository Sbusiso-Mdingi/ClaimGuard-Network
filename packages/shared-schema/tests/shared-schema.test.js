import assert from "node:assert/strict";
import test from "node:test";

import {
  backendHealthSchema,
  createBackendHealth,
  createBackendInfo,
  trpcPingResponseSchema,
} from "../src/index.js";

test("backend health payload validates", () => {
  const payload = createBackendHealth();

  assert.equal(payload.status, "ok");
  assert.equal(payload.service, "api");
  assert.equal(payload.phase, "3");
  backendHealthSchema.parse(payload);
});

test("backend info payload validates", () => {
  const payload = createBackendInfo();

  assert.equal(payload.service, "api");
  assert.equal(payload.phase, "3");
});

test("trpc ping response schema accepts backend ping data", () => {
  const payload = trpcPingResponseSchema.parse({
    service: "api",
    message: "pong",
  });

  assert.equal(payload.message, "pong");
});