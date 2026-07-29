#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function required(value, name) {
  const rendered = String(value || "").trim();
  if (!rendered) throw new Error(`${name} is required.`);
  return rendered;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function createReleaseManifest({
  commitSha,
  webArtifactPath,
  apiArtifactPath,
  outputPath,
}) {
  const canonicalCommit = required(commitSha, "commitSha").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(canonicalCommit)) {
    throw new Error("commitSha must be an exact 40-character Git commit SHA.");
  }
  const webArtifactDigest = await sha256(resolve(webArtifactPath));
  const apiArtifactDigest = await sha256(resolve(apiArtifactPath));
  const digestInput = JSON.stringify({
    schemaVersion: "claimguard.release-manifest.v1",
    commitSha: canonicalCommit,
    webArtifactDigest,
    apiArtifactDigest,
  });
  const artifactDigest = crypto.createHash("sha256").update(digestInput).digest("hex");
  const manifest = {
    schemaVersion: "claimguard.release-manifest.v1",
    commitSha: canonicalCommit,
    artifactDigest,
    webArtifactDigest,
    apiArtifactDigest,
  };
  await writeFile(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createReleaseManifest({
    commitSha: process.argv[2],
    webArtifactPath: process.argv[3],
    apiArtifactPath: process.argv[4],
    outputPath: process.argv[5],
  }).then((manifest) => {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
