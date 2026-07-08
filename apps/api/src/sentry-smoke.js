if (!process.env.SENTRY_DSN_API) {
  console.log("SENTRY_DSN_API not set; skipping API Sentry smoke test.");
  process.exit(0);
}

console.log("SENTRY_DSN_API is set. Trigger /test-error endpoint to validate ingestion.");
