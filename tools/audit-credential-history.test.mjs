import assert from "node:assert/strict";
import test from "node:test";

import { detectCredentialClasses } from "./audit-credential-history.mjs";

test("detects supported credential classes without returning values", () => {
  const github = `token=ghp_${"A".repeat(30)}`;
  const newRelic = `NEW_RELIC_LICENSE_KEY=${"a".repeat(40)}`;
  const codecov = `CODECOV_TOKEN=${[
    "12345678",
    "1234",
    "1234",
    "1234",
    "123456789abc",
  ].join("-")}`;
  const storage = `DefaultEndpointsProtocol=https;AccountKey=${"Z".repeat(40)}`;

  assert.deepEqual(detectCredentialClasses(github), ["github-token"]);
  assert.deepEqual(detectCredentialClasses(newRelic), [
    "new-relic-key",
    "sensitive-assignment",
  ]);
  assert.deepEqual(detectCredentialClasses(codecov), [
    "codecov-token",
    "sensitive-assignment",
  ]);
  assert.deepEqual(detectCredentialClasses(storage), [
    "azure-storage-account-key",
  ]);
});

test("ignores documented placeholders and local test database URLs", () => {
  assert.deepEqual(
    detectCredentialClasses("NEW_RELIC_LICENSE_KEY=${{ secrets.VALUE }}"),
    [],
  );
  assert.deepEqual(
    detectCredentialClasses(
      "mysql://root:password@127.0.0.1:3306/claimguard",
    ),
    [],
  );
  assert.deepEqual(
    detectCredentialClasses("SENTRY_DSN_API=redacted"),
    [],
  );
  assert.deepEqual(
    detectCredentialClasses(
      "mysql://ci_user:a-real-looking-value@localhost:3306/claimguard",
    ),
    [],
  );
});
