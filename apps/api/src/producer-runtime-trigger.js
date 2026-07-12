import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runCommand({ command, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Producer trigger command failed with exit code ${code}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.exitCode = code;
      reject(error);
    });
  });
}

export function createProducerRuntimeTriggerFromEnvironment({ repoRoot }) {
  const command = process.env.REPORT_PRODUCER_TRIGGER_COMMAND || "uv";
  const baseArgs = (process.env.REPORT_PRODUCER_TRIGGER_ARGS || "run claimguard-produce-report")
    .split(" ")
    .map((arg) => arg.trim())
    .filter(Boolean);

  const producerCwd = process.env.REPORT_PRODUCER_WORKDIR || path.resolve(repoRoot || process.cwd(), "services/report-producer");
  const backend = (process.env.REPORT_STORAGE_BACKEND || "file").toLowerCase();
  const outputDir = process.env.REPORT_PRODUCER_OUTPUT_DIR || path.resolve(producerCwd, "reports");
  const topN = process.env.REPORT_PRODUCER_TOP_N || "10";

  return {
    async triggerAfterIngestion({ claims, source = "api" }) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "claimguard-ingest-"));
      const claimsPath = path.join(tempDir, "claims.json");

      try {
        await writeFile(claimsPath, `${JSON.stringify({ claims })}\n`, "utf-8");

        const args = [
          ...baseArgs,
          "--claims-json",
          claimsPath,
          "--backend",
          backend,
          "--top-n",
          topN,
          "--trigger",
          source || "ingest",
        ];

        if (backend === "file") {
          args.push("--output-dir", outputDir);
        }

        await runCommand({
          command,
          args,
          cwd: producerCwd,
          env: process.env,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}
