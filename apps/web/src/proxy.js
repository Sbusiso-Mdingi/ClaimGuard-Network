const rejectedClientIdentityHeaders = new Set([
  "x-claimguard-user", "x-claimguard-role", "x-claimguard-user-tenant", "x-claimguard-tenant",
  "x-cg-service-actor", "x-cg-service-role", "x-cg-service-tenant", "x-cg-service-organisation",
  "authorization",
]);
const forwardingHeaders = new Set(["forwarded", "x-forwarded-for", "x-real-ip"]);
const clerkManagedHeaders = new Set([
  "clerk-proxy-url", "clerk-secret-key", "x-client-ip", "x-forwarded-host", "x-forwarded-proto",
]);

const hopByHopHeaders = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length",
]);

export function buildUpstreamHeaders(req, { trustProxy = false } = {}) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (
      hopByHopHeaders.has(lowerName) || forwardingHeaders.has(lowerName) ||
      rejectedClientIdentityHeaders.has(lowerName) || value == null
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

export function normalizeClientIp(value) {
  const first = String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
  if (!first) return "";
  const bracketedIpv6 = first.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) return bracketedIpv6[1];
  const ipv4WithPort = first.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return ipv4WithPort ? ipv4WithPort[1] : first;
}

export function resolveOriginalClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const platformClientIp = normalizeClientIp(req.headers?.["x-client-ip"]);
    if (platformClientIp) return platformClientIp;
    const forwardedClientIp = normalizeClientIp(req.headers?.["x-forwarded-for"]);
    if (forwardedClientIp) return forwardedClientIp;
  }
  return normalizeClientIp(req.socket?.remoteAddress);
}

export function buildClerkFrontendApiHeaders(
  req,
  { proxyUrl, secretKey, trustProxy = false } = {},
) {
  const parsedProxyUrl = new URL(proxyUrl);
  if (parsedProxyUrl.protocol !== "https:") throw new Error("The Clerk proxy URL must use HTTPS.");
  if (!String(secretKey || "").trim()) throw new Error("A Clerk secret key is required for the frontend API proxy.");

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    const lowerName = name.toLowerCase();
    if (
      hopByHopHeaders.has(lowerName) || forwardingHeaders.has(lowerName)
      || clerkManagedHeaders.has(lowerName) || value == null
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }

  const clientIp = resolveOriginalClientIp(req, { trustProxy });
  if (!clientIp) throw new Error("The original client IP is unavailable for the Clerk frontend API proxy.");
  headers.set("clerk-proxy-url", parsedProxyUrl.toString().replace(/\/$/, ""));
  headers.set("clerk-secret-key", String(secretKey).trim());
  headers.set("x-forwarded-for", clientIp);
  headers.set("x-forwarded-host", parsedProxyUrl.host);
  headers.set("x-forwarded-proto", "https");
  return headers;
}

async function forwardUpstreamResponse(upstreamResponse, res) {
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

export async function proxyApiRequest(req, res, { baseUrl, trustProxy = false, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("A proxy base URL is required.");
  const upstreamUrl = new URL(req.url.replace(/^\/api/, ""), baseUrl);
  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const upstreamResponse = await fetchImpl(upstreamUrl, {
    method,
    headers: buildUpstreamHeaders(req, { trustProxy }),
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  await forwardUpstreamResponse(upstreamResponse, res);
}

export async function proxyClerkFrontendApiRequest(
  req,
  res,
  {
    proxyUrl,
    secretKey,
    trustProxy = false,
    frontendApiBaseUrl = "https://frontend-api.clerk.dev",
    fetchImpl = fetch,
  } = {},
) {
  const parsedProxyUrl = new URL(proxyUrl);
  const incomingUrl = new URL(req.url || "/", parsedProxyUrl.origin);
  const proxyPath = parsedProxyUrl.pathname.replace(/\/$/, "");
  if (
    incomingUrl.origin !== parsedProxyUrl.origin
    || (incomingUrl.pathname !== proxyPath && !incomingUrl.pathname.startsWith(`${proxyPath}/`))
  ) {
    throw new Error("The request is outside the configured Clerk proxy path.");
  }

  const upstreamPath = incomingUrl.pathname.slice(proxyPath.length) || "/";
  const upstreamUrl = new URL(`${upstreamPath}${incomingUrl.search}`, frontendApiBaseUrl);
  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const upstreamResponse = await fetchImpl(upstreamUrl, {
    method,
    headers: buildClerkFrontendApiHeaders(req, { proxyUrl, secretKey, trustProxy }),
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
  });

  await forwardUpstreamResponse(upstreamResponse, res);
}
