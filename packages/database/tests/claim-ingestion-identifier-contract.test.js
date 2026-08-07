import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositorySourceUrl = new URL("../src/claim-ingestion-repository.js", import.meta.url);
const simulatorSourceUrl = new URL("../../../tools/scheme-simulator/simulator.py", import.meta.url);

test("claim ingestion repository mirrors the migrated identifier widths", async () => {
  const source = await readFile(repositorySourceUrl, "utf8");
  const expected = [
    [/requireText\(\s*rawClaim\.claim_id,\s*`claims\[\$\{index\}\]\.claim_id`,\s*128\s*\)/, "claim_id"],
    [/requireText\(\s*rawClaim\.scheme_id,\s*`claims\[\$\{index\}\]\.scheme_id`,\s*64\s*\)/, "scheme_id"],
    [/requireText\(\s*rawClaim\.member_id,\s*`claims\[\$\{index\}\]\.member_id`,\s*128\s*\)/, "member_id"],
    [/requireText\(\s*rawClaim\.provider_id,\s*`claims\[\$\{index\}\]\.provider_id`,\s*128\s*\)/, "provider_id"],
    [/requireText\(\s*rawClaim\.billing_code,\s*`claims\[\$\{index\}\]\.billing_code`,\s*64\s*\)/, "billing_code"],
  ];
  for (const [pattern, field] of expected) {
    assert.match(source, pattern, `${field} validator must match migration 0010 and the public schema`);
  }
});

test("Windows simulator accepts the canonical 64-character scheme identifier", async () => {
  const source = await readFile(simulatorSourceUrl, "utf8");
  assert.match(source, /len\(scheme_id\) > 64/);
  assert.doesNotMatch(source, /len\(scheme_id\) > 8/);
});
