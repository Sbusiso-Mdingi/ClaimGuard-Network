import http from "node:http";

const port = Number(process.env.PORT || 3001);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "api" }));
    return;
  }

  if (req.url === "/test-error") {
    throw new Error("Phase0 API Sentry smoke test error");
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  console.log(`API shell listening on :${port}`);
});
