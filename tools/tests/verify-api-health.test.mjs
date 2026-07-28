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
const SCRIPT_PATH = path.join(REPOSITORY_ROOT, "infra/verify-api-health.sh");

const FAKE_CURL = `#!/usr/bin/env node
const mode = process.env.FAKE_CURL_MODE;
if (mode === "success") {
  process.stdout.write("200");
  process.exit(0);
}
setTimeout(() => {
  process.stdout.write("000");
  process.exit(28);
}, 600);
`;

function runHealthProbe({
  mode = "success",
  apiName = "claimguard-api",
  deadline = "1",
  requestTimeout = "1",
  retry = "0",
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "api-health-"));
  try {
    const curlPath = path.join(directory, "curl");
    writeFileSync(curlPath, FAKE_CURL);
    chmodSync(curlPath, 0o755);
    return spawnSync("bash", [SCRIPT_PATH], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_CURL_MODE: mode,
        AZURE_WEBAPP_API: apiName,
        API_HEALTH_DEADLINE_SECONDS: deadline,
        API_HEALTH_REQUEST_TIMEOUT_SECONDS: requestTimeout,
        API_HEALTH_RETRY_SECONDS: retry,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("post-restart health requires both probes to return 200", () => {
  const result = runHealthProbe();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /health passed on attempt 1/);
});

test("post-restart health fails after its bounded deadline", () => {
  const result = runHealthProbe({ mode: "timeout" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deadline exceeded/);
});

test("post-restart health rejects unsafe App Service names", () => {
  const result = runHealthProbe({ apiName: "https://unexpected.invalid" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a safe App Service name/);
});

test("post-restart health rejects deadlines longer than five minutes", () => {
  const result = runHealthProbe({ deadline: "301" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /between 1 and 300/);
});
