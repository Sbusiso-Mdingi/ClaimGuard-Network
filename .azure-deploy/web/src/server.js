import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 3002);
const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = join(srcRoot, "..", "dist");
const apiBaseUrl = process.env.CLAIMGUARD_API_BASE_URL || "http://127.0.0.1:3004";
const root = process.env.NODE_ENV === "production" ? distRoot : srcRoot;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function proxyApiRequest(req, res) {
  const upstreamUrl = new URL(req.url.replace(/^\/api/, ""), apiBaseUrl);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers: {
      accept: req.headers.accept || "application/json",
    },
  });

  const body = await upstreamResponse.arrayBuffer();
  res.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") || "application/json",
  });
  res.end(Buffer.from(body));
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    try {
      await proxyApiRequest(req, res);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    }
    return;
  }

  const requestPath = req.url === "/" ? "/index.html" : req.url || "/index.html";
  const filePath = join(root, requestPath);

  try {
    let content = await readFile(filePath, "utf8");

    if (extname(filePath) === ".html") {
      content = content
        .replaceAll("__SENTRY_DSN_WEB__", process.env.SENTRY_DSN_WEB || "")
        .replaceAll("__NODE_ENV__", process.env.NODE_ENV || "development")
        .replaceAll("__CLAIMGUARD_API_BASE_URL__", apiBaseUrl);
    }

    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    // If the file isn't found, assume this is a client-side route and
    // serve index.html so SPA routing works when served by the backend.
    try {
      const indexPath = join(root, "index.html");
      const indexContent = await readFile(indexPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexContent);
    } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    }
  }
});

server.listen(port, () => {
  console.log(`Web shell listening on :${port}`);
});