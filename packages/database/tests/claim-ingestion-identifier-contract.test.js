import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositorySourceUrl = new URL("../src/claim-ingestion-repository.js", import.meta.url);
const simulatorSourceUrl = new URL("../../../tools/scheme-simulator/simulator.py", import.meta.url);

test("claim ingestion repository mirrors the migrated identifier widths", async () => {
  const source = await readFile(repositorySourceUrl, "utf8");
  const expected = [
    [/`claims\[\$\{index\}\]\.claim_id`,\s*128,/, "claim_id"],
    [/`claims\[\$\{index\}\]\.scheme_id`,\s*64,/, "scheme_id"],
    [/`claims\[\$\{index\}\]\.member_id`,\s*128,/, "member_id"],
    [/`claims\[\$\{index\}\]\.provider_id`,\s*128,/, "provider_id"],
    [/`claims\[\$\{index\}\]\.billing_code`,\s*64,/, "billing_code"],
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
