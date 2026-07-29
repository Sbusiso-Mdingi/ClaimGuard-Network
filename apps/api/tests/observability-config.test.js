import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

test("New Relic keeps SQL obfuscated and does not forward application logs", () => {
  const previousEnvironment = process.env.CLAIMGUARD_ENVIRONMENT;
  process.env.CLAIMGUARD_ENVIRONMENT = "test";

  try {
    const { config } = require("../newrelic.cjs");
    assert.equal(config.transaction_tracer.record_sql, "obfuscated");
    assert.equal(config.slow_sql.enabled, true);
    assert.equal(config.application_logging.forwarding.enabled, false);
    assert.equal(config.labels.environment, "test");
    assert.ok(config.attributes.exclude.includes("request.headers.*"));
    assert.ok(config.attributes.exclude.includes("request.parameters.*"));
  } finally {
    if (previousEnvironment === undefined) {
      delete process.env.CLAIMGUARD_ENVIRONMENT;
    } else {
      process.env.CLAIMGUARD_ENVIRONMENT = previousEnvironment;
    }
  }
});
