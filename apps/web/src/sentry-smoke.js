if (!process.env.SENTRY_DSN_WEB) {
  console.log("SENTRY_DSN_WEB not set; skipping web Sentry smoke test.");
  process.exit(0);
}

console.log("SENTRY_DSN_WEB is set. Open the app and trigger a test error to validate ingestion.");
