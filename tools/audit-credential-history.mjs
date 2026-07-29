#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const COMMIT_MARKER = "@@CLAIMGUARD_COMMIT@@";
const PLACEHOLDER_VALUES = new Set([
  "",
  "...",
  "change-me",
  "changeme",
  "example",
  "password",
  "placeholder",
  "redacted",
  "replace-me",
  "secret",
  "test",
]);

const detectors = Object.freeze([
  {
    id: "github-token",
    expression:
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  },
  {
    id: "sentry-dsn",
    expression:
      /https?:\/\/[A-Za-z0-9_-]{8,}(?::[A-Za-z0-9_-]+)?@[A-Za-z0-9.-]*(?:ingest|sentry)[A-Za-z0-9.-]*\/\d+/gi,
  },
  {
    id: "new-relic-key",
    expression:
      /\b(?:NEW_RELIC_(?:LICENSE_KEY|API_KEY)|Api-Key)\b[^\r\n]{0,32}(?:NRAK-[A-Z0-9]{20,}|[A-Fa-f0-9]{40})\b/g,
  },
  {
    id: "codecov-token",
    expression:
      /\bCODECOV_TOKEN\b[^\r\n]{0,32}(?:[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}|[A-Za-z0-9_-]{32,})\b/g,
  },
  {
    id: "azure-storage-account-key",
    expression: /\bAccountKey=[^;\s"'<>]{20,}/g,
  },
  {
    id: "azure-sas-signature",
    expression: /[?&]sig=[A-Za-z0-9%+/_=-]{16,}/g,
  },
  {
    id: "private-key",
    expression:
      /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
]);

const sensitiveAssignment =
  /\b(?:AZURE_CLIENT_SECRET|CAMBER_TOKEN|CODECOV_TOKEN|DIGITALOCEAN_ACCESS_TOKEN|MODEL_AUTH_CLIENT_SECRET|NEW_RELIC_(?:API_KEY|LICENSE_KEY)|SENTRY_AUTH_TOKEN|SENTRY_DSN_(?:API|WEB))\b\s*[:=]\s*["']?([^"'`\s,;]+)/gi;

const mysqlCredential =
  /\bmysql:\/\/([^:\s/]+):([^@\s/]+)@([^/\s]+)/gi;

function isPlaceholder(value) {
  const normalized = String(value)
    .trim()
    .replace(/^[<{[]+|[>}\]]+$/g, "")
    .toLowerCase();
  return (
    PLACEHOLDER_VALUES.has(normalized) ||
    normalized.startsWith("$") ||
    normalized.includes("${") ||
    normalized.includes("process.env") ||
    normalized.includes("readenvironmentvariable") ||
    normalized.includes("example.invalid") ||
    normalized.includes("<") ||
    normalized.includes(">")
  );
}

export function detectCredentialClasses(line) {
  const findings = new Set();

  for (const detector of detectors) {
    detector.expression.lastIndex = 0;
    if (detector.expression.test(line)) findings.add(detector.id);
  }

  sensitiveAssignment.lastIndex = 0;
  for (const match of line.matchAll(sensitiveAssignment)) {
    if (!isPlaceholder(match[1])) findings.add("sensitive-assignment");
  }

  mysqlCredential.lastIndex = 0;
  for (const match of line.matchAll(mysqlCredential)) {
    const [, username, password, hostname] = match;
    const bareHostname = hostname.replace(/:\d+$/, "");
    if (
      !isPlaceholder(username) &&
      !isPlaceholder(password) &&
      !(username === "u" && password === "p" && bareHostname === "h") &&
      !/^(?:127\.0\.0\.1|localhost)$/i.test(bareHostname) &&
      !/\.(?:example|invalid|test)$/i.test(bareHostname)
    ) {
      findings.add("mysql-uri-credential");
    }
  }

  return [...findings].sort();
}

function normalizeDiffPath(value) {
  if (!value || value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

async function scanHistory(repository) {
  const git = spawn(
    "git",
    [
      "-C",
      repository,
      "log",
      "--all",
      "--full-history",
      "--no-color",
      "--no-ext-diff",
      "--unified=0",
      `--format=${COMMIT_MARKER}%H\t%aI`,
      "--patch",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  git.stderr.setEncoding("utf8");
  git.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  let commit = null;
  let committedAt = null;
  let oldPath = null;
  let newPath = null;
  const unique = new Map();
  const lines = createInterface({ input: git.stdout, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.startsWith(COMMIT_MARKER)) {
      const metadata = line.slice(COMMIT_MARKER.length).split("\t");
      [commit, committedAt] = metadata;
      oldPath = null;
      newPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = normalizeDiffPath(line.slice(4).split("\t", 1)[0]);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = normalizeDiffPath(line.slice(4).split("\t", 1)[0]);
      continue;
    }
    if (!commit || (!line.startsWith("+") && !line.startsWith("-"))) {
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const side = line[0] === "+" ? "added" : "removed";
    const path = side === "added" ? newPath : oldPath;
    if (!path) continue;

    for (const detector of detectCredentialClasses(line.slice(1))) {
      const key = [commit, path, side, detector].join("\u0000");
      unique.set(key, {
        commit,
        committedAt,
        path,
        side,
        detector,
      });
    }
  }

  const exitCode = await new Promise((resolve, reject) => {
    git.on("error", reject);
    git.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git log exited with ${exitCode}`);
  }

  return [...unique.values()].sort((left, right) =>
    [
      left.committedAt,
      left.commit,
      left.path,
      left.side,
      left.detector,
    ]
      .join("\u0000")
      .localeCompare(
        [
          right.committedAt,
          right.commit,
          right.path,
          right.side,
          right.detector,
        ].join("\u0000"),
      ),
  );
}

function parseArguments(argv) {
  const result = {
    failOnFindings: false,
    json: false,
    repository: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      result.json = true;
    } else if (argument === "--fail-on-findings") {
      result.failOnFindings = true;
    } else if (argument === "--repository") {
      result.repository = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const findings = await scanHistory(options.repository);
  const report = {
    repository: options.repository,
    findings,
    findingCount: findings.length,
    redacted: true,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(`Redacted credential-history findings: ${findings.length}`);
  for (const finding of findings) {
    console.log(
      [
        finding.detector,
        finding.side,
        finding.committedAt,
        finding.commit,
        finding.path,
      ].join("\t"),
    );
  }
  if (options.failOnFindings && findings.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
