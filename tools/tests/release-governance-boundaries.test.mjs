import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("release catalogue verifies both gates and cannot deploy", () => {
  const workflow = read(".github/workflows/release-catalogue.yml");
  for (const required of [
    "workflow_dispatch:",
    "expected_main_sha:",
    "CATALOGUE_RELEASE",
    "--workflow ci.yml",
    "--workflow codeql.yml",
    '.conclusion == "success"',
    "package-release-artifacts.sh",
    "release-register",
  ]) {
    assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const forbidden of [
    "azure/webapps-deploy",
    "az webapp deploy",
    "release-authorize",
    "release-bootstrap",
    "release-complete",
  ]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(
    workflow,
    /^\s*uses:\s+\S+@v\d+\s*$/m,
    "Release-catalogue actions must be pinned to immutable commit SHAs.",
  );
});

test("production deployment consumes one exact approved request and verifies its artifact", () => {
  const workflow = read(".github/workflows/ci.yml");
  for (const required of [
    "promotion_request_id:",
    "release-authorize",
    "--promotion-request-id=\"$PROMOTION_REQUEST_ID\"",
    "--commit-sha=\"$GITHUB_SHA\"",
    "uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "run-id: ${{ steps.release_authorization.outputs.artifact_run_id }}",
    "name: ${{ steps.release_authorization.outputs.artifact_name }}",
    "EXPECTED_ARTIFACT_DIGEST",
    "EXPECTED_WEB_ARTIFACT_DIGEST",
    "EXPECTED_API_ARTIFACT_DIGEST",
    "release-complete",
    "release-fail",
  ]) {
    assert.ok(workflow.includes(required), `Missing governed deployment boundary: ${required}`);
  }

  const authorizeAt = workflow.indexOf("release-authorize");
  const downloadAt = workflow.indexOf("- name: Download the approved immutable release artifact");
  const verifyAt = workflow.indexOf("- name: Verify governed release artifact digests");
  const deployAt = workflow.indexOf("- name: Deploy web app with retry");
  assert.ok(authorizeAt >= 0 && authorizeAt < downloadAt);
  assert.ok(downloadAt < verifyAt && verifyAt < deployAt);
  assert.equal((workflow.match(/release-bootstrap/g) || []).length, 1);
});
