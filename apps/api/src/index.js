import http from "node:http";

import * as Sentry from "@sentry/node";

const port = Number(process.env.PORT || 3001);

if (process.env.SENTRY_DSN_API) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_API,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0,
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "api" }));
    return;
  }

  if (req.url === "/test-error") {
    const error = new Error("Phase0 API Sentry smoke test error");
    Sentry.captureException(error);
    await Sentry.flush(2000);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "sentry_smoke_test_triggered" }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`API shell listening on :${port}`);
});
