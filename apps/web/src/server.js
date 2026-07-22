import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyApiRequest } from "./proxy.js";

const port = Number(process.env.PORT || 3002);
const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = join(srcRoot, "..", "dist");
const apiBaseUrl = process.env.CLAIMGUARD_API_BASE_URL || "http://127.0.0.1:3004";
const root = process.env.NODE_ENV === "production" ? distRoot : srcRoot;
const authenticationMode = String(process.env.AUTHENTICATION_MODE || "session").trim().toLowerCase();
if (!["session", "demo_headers"].includes(authenticationMode)) throw new Error("AUTHENTICATION_MODE must be session or demo_headers.");
if ((process.env.NODE_ENV === "production" || process.env.DEPLOYMENT_CLASS === "production") && authenticationMode === "demo_headers") {
  throw new Error("Production refuses demo_headers mode.");
}
const trustProxyValue = String(process.env.TRUST_PROXY || "false").trim().toLowerCase();
if (!["true", "false"].includes(trustProxyValue)) throw new Error("TRUST_PROXY must be true or false.");
const trustProxy = trustProxyValue === "true";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function injectRuntimeConfiguration(content) {
  const scriptString = (value) => JSON.stringify(String(value || "")).slice(1, -1);
  return content
    .replaceAll("__SENTRY_DSN_WEB__", scriptString(process.env.SENTRY_DSN_WEB || ""))
    .replaceAll("__NODE_ENV__", scriptString(process.env.NODE_ENV || "development"))
    .replaceAll("__CLAIMGUARD_API_BASE_URL__", scriptString(apiBaseUrl))
    .replaceAll("__AUTHENTICATION_MODE__", scriptString(authenticationMode))
    .replaceAll("__PUBLIC_ORGANISATION_URL_SCHEME__", scriptString(process.env.PUBLIC_ORGANISATION_URL_SCHEME || "https"))
    .replaceAll("__PUBLIC_ORGANISATION_HOST__", scriptString(process.env.PUBLIC_ORGANISATION_HOST || "localhost:3002"));
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    try {
      await proxyApiRequest(req, res, { baseUrl: apiBaseUrl, mode: authenticationMode, trustProxy });
    } catch (error) {
      console.error("Proxy error:", error);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    }
    return;
  }

  const requestPath = req.url === "/" ? "/index.html" : req.url || "/index.html";
  const filePath = join(root, requestPath);

  try {
    let content = await readFile(filePath, "utf8");

    const isHtml = extname(filePath) === ".html";
    if (isHtml) {
      content = injectRuntimeConfiguration(content);
    }

    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    const cacheControl = isHtml 
      ? "no-cache, no-store, must-revalidate" 
      : "public, max-age=31536000, immutable";

    res.writeHead(200, { 
      "content-type": contentType,
      "cache-control": cacheControl
    });
    res.end(content);
  } catch {
    // If the file isn't found, assume this is a client-side route and
    // serve index.html so SPA routing works when served by the backend.
    try {
      const indexPath = join(root, "index.html");
      const indexContent = injectRuntimeConfiguration(await readFile(indexPath, "utf8"));
      res.writeHead(200, { 
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache, no-store, must-revalidate"
      });
      res.end(indexContent);
    } catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    }
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`Web shell listening on :${port}`);
  });
}
