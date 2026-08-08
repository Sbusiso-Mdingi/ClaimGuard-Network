import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyApiRequest, proxyClerkFrontendApiRequest } from "./proxy.js";
import { injectRuntimeConfiguration } from "./runtime-configuration.js";

const port = Number(process.env.PORT || 3002);
const srcRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = join(srcRoot, "..", "dist");
const apiBaseUrl = process.env.CLAIMGUARD_API_BASE_URL || "http://127.0.0.1:3004";
const clerkProxyUrl = String(process.env.CLERK_PROXY_URL || "").trim();
const clerkSecretKey = String(process.env.CLERK_SECRET_KEY || "").trim();
const root = process.env.NODE_ENV === "production" ? distRoot : srcRoot;
const trustProxyValue = String(process.env.TRUST_PROXY || "false").trim().toLowerCase();
if (!["true", "false"].includes(trustProxyValue)) throw new Error("TRUST_PROXY must be true or false.");
const trustProxy = trustProxyValue === "true";
if (Boolean(clerkProxyUrl) !== Boolean(clerkSecretKey)) {
  throw new Error("CLERK_PROXY_URL and CLERK_SECRET_KEY must be configured together.");
}
if (clerkProxyUrl) {
  const parsedClerkProxyUrl = new URL(clerkProxyUrl);
  if (parsedClerkProxyUrl.protocol !== "https:") throw new Error("CLERK_PROXY_URL must use HTTPS.");
  if (parsedClerkProxyUrl.search || parsedClerkProxyUrl.hash) {
    throw new Error("CLERK_PROXY_URL must not include a query string or fragment.");
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  if (req.url === "/__clerk" || req.url?.startsWith("/__clerk/")) {
    if (!clerkProxyUrl || !clerkSecretKey) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "clerk_proxy_unavailable" }));
      return;
    }
    try {
      await proxyClerkFrontendApiRequest(req, res, {
        proxyUrl: clerkProxyUrl,
        secretKey: clerkSecretKey,
        trustProxy,
      });
    } catch (error) {
      console.error("Clerk frontend API proxy error:", error?.message || "unknown error");
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "clerk_proxy_bad_gateway" }));
    }
    return;
  }

  if (req.url?.startsWith("/api/")) {
    try {
      await proxyApiRequest(req, res, { baseUrl: apiBaseUrl, trustProxy });
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
    if (isHtml) content = injectRuntimeConfiguration(content, { apiBaseUrl, clerkProxyUrl });
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    const cacheControl = isHtml ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": contentType, "cache-control": cacheControl });
    res.end(content);
  } catch {
    try {
      const indexPath = join(root, "index.html");
      const indexContent = injectRuntimeConfiguration(
        await readFile(indexPath, "utf8"),
        { apiBaseUrl, clerkProxyUrl },
      );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate" });
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
