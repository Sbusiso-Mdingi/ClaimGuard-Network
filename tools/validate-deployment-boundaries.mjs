#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CI_PATH = ".github/workflows/ci.yml";
const WORKER_PATH = ".github/workflows/report-worker-deploy.yml";
const LEGACY_API_PATH = ".github/workflows/main_claimguard-api.yml";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function fail(message) {
  throw new Error(message);
}

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    fail(`${label} is missing ${JSON.stringify(expected)}.`);
  }
}

function forbidText(source, forbidden, label) {
  if (source.includes(forbidden)) {
    fail(`${label} still contains ${JSON.stringify(forbidden)}.`);
  }
}

export function validateDeploymentBoundaries({ ci, worker, legacyApi }) {
  for (const required of [
    "workflow_dispatch:",
    "expected_main_sha:",
    "production_confirmation:",
    'test "$GITHUB_REF" = "refs/heads/main"',
    '[[ "$EXPECTED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'test "$EXPECTED_MAIN_SHA" = "$GITHUB_SHA"',
    'test "$PRODUCTION_CONFIRMATION" = "DEPLOY_PRODUCTION"',
  ]) {
    requireText(ci, required, "CI production authorization");
  }

  const deploymentGuard =
    "github.event_name == 'workflow_dispatch' "
    + "&& github.ref == 'refs/heads/main' "
    + "&& inputs.production_confirmation == 'DEPLOY_PRODUCTION' "
    + "&& inputs.expected_main_sha == github.sha";
  const guardedStepCount = ci.split(deploymentGuard).length - 1;
  if (guardedStepCount !== 5) {
    fail(
      "CI must apply the exact production guard to four packaging steps "
      + `and the deploy job; found ${guardedStepCount}.`,
    );
  }

  forbidText(
    ci,
    "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    "CI workflow",
  );

  for (const required of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.event == 'workflow_dispatch'",
  ]) {
    requireText(worker, required, "Report-worker deployment authorization");
  }

  for (const forbidden of [
    "azure/login",
    "azure/webapps-deploy",
    "az webapp deploy",
  ]) {
    forbidText(legacyApi, forbidden, "Retired direct API workflow");
  }
  requireText(
    legacyApi,
    "claimguard-api-deploy-retired",
    "Retired direct API workflow",
  );
}

export function validateRepositoryDeploymentBoundaries() {
  validateDeploymentBoundaries({
    ci: read(CI_PATH),
    worker: read(WORKER_PATH),
    legacyApi: read(LEGACY_API_PATH),
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateRepositoryDeploymentBoundaries();
  process.stdout.write(
    "Production deployment boundaries are explicit and fail closed.\n",
  );
}
