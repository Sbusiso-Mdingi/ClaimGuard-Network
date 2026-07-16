const identityAuthorityHeaders = new Set([
  "x-claimguard-user", "x-claimguard-role", "x-claimguard-user-tenant", "x-claimguard-tenant",
]);
const internalServiceHeaders = new Set(["x-cg-service-actor", "x-cg-service-role", "x-cg-service-tenant"]);
const forwardingHeaders = new Set(["forwarded", "x-forwarded-for", "x-real-ip"]);

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function buildUpstreamHeaders(req, { mode = "session", trustProxy = false } = {}) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (
      hopByHopHeaders.has(lowerName) || forwardingHeaders.has(lowerName) || value == null ||
      (mode === "session" && (identityAuthorityHeaders.has(lowerName) || internalServiceHeaders.has(lowerName) || lowerName === "authorization"))
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }

  const trustedForwardedAddress = trustProxy
    ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    : "";
  const sourceAddress = trustedForwardedAddress || req.socket?.remoteAddress || "";
  if (sourceAddress) headers.set("x-forwarded-for", sourceAddress);

  return headers;
}

export async function proxyApiRequest(req, res, { baseUrl, mode = "session", trustProxy = false, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("A proxy base URL is required.");
  const upstreamUrl = new URL(req.url.replace(/^\/api/, ""), baseUrl);
  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const upstreamResponse = await fetchImpl(upstreamUrl, {
    method,
    headers: buildUpstreamHeaders(req, { mode, trustProxy }),
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  const body = await upstreamResponse.arrayBuffer();
  for (const [name, value] of upstreamResponse.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (!hopByHopHeaders.has(lowerName) && lowerName !== "set-cookie" && lowerName !== "content-length") {
      res.setHeader(name, value);
    }
  }
  const setCookies = typeof upstreamResponse.headers.getSetCookie === "function"
    ? upstreamResponse.headers.getSetCookie()
    : [upstreamResponse.headers.get("set-cookie")].filter(Boolean);
  if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);
  if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
  res.statusCode = upstreamResponse.status;
  res.end(Buffer.from(body));
}
