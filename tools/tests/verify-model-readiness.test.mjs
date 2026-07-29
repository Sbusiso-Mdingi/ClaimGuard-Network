import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT_PATH = path.join(
  REPOSITORY_ROOT,
  "infra/verify-model-readiness.sh",
);

const FAKE_CURL = `#!/usr/bin/env node
const mode = process.env.FAKE_CURL_MODE;
const attemptFile = process.env.FAKE_CURL_ATTEMPT_FILE;
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output");
const outputPath = process.argv[outputIndex + 1];
let attempt = 1;
if (fs.existsSync(attemptFile)) {
  attempt = Number(fs.readFileSync(attemptFile, "utf8")) + 1;
}
fs.writeFileSync(attemptFile, String(attempt));

if (mode === "warmup" && attempt === 1) {
  setTimeout(() => {
    process.stdout.write("000");
    process.exit(28);
  }, 100);
} else {
  const deploymentId =
    mode === "wrong-deployment"
      ? "claimguard-claim-fraud-baseline:1.0.0"
      : process.env.EXPECTED_MODEL_DEPLOYMENT_ID;
  fs.writeFileSync(
    outputPath,
    JSON.stringify({ status: "ready", deploymentId }),
  );
  process.stdout.write("200");
}
`;

function runReadinessProbe({
  mode = "success",
  url = "https://model.example.southafricanorth.azurecontainerapps.io/health/ready",
  deploymentId = "claimguard-claim-fraud-ensemble:2.1.1",
  deadline = "1",
  requestTimeout = "1",
  retry = "0",
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-readiness-"));
  try {
    const curlPath = path.join(directory, "curl");
    const attemptPath = path.join(directory, "attempt");
    writeFileSync(curlPath, FAKE_CURL);
    chmodSync(curlPath, 0o755);
    return spawnSync("bash", [SCRIPT_PATH], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_CURL_MODE: mode,
        FAKE_CURL_ATTEMPT_FILE: attemptPath,
        MODEL_READINESS_URL: url,
        EXPECTED_MODEL_DEPLOYMENT_ID: deploymentId,
        MODEL_READINESS_DEADLINE_SECONDS: deadline,
        MODEL_READINESS_REQUEST_TIMEOUT_SECONDS: requestTimeout,
        MODEL_READINESS_RETRY_SECONDS: retry,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("model readiness accepts the expected ready deployment", () => {
  const result = runReadinessProbe();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /readiness passed on attempt 1/);
});

test("model readiness retries a timed-out cold-start request", () => {
  const result = runReadinessProbe({ mode: "warmup", deadline: "2" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warm-up attempt 1: status=000/);
  assert.match(result.stdout, /readiness passed on attempt 2/);
});

test("model readiness rejects the wrong deployment identity", () => {
  const result = runReadinessProbe({ mode: "wrong-deployment" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deadline exceeded/);
});

test("model readiness rejects unsafe URLs", () => {
  const result = runReadinessProbe({
    url: "https://unexpected.invalid/health/ready",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a safe production readiness URL/);
});

test("model readiness rejects deadlines longer than five minutes", () => {
  const result = runReadinessProbe({ deadline: "301" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /between 1 and 300/);
});
