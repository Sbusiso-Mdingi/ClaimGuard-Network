import {
  buildClerkFrontendApiHeaders,
  buildUpstreamHeaders,
  normalizeClientIp,
  proxyApiRequest,
  proxyClerkFrontendApiRequest,
} from "../proxy";

test("proxy forwards session headers but always strips client identity assertions", () => {
  const headers = buildUpstreamHeaders({ headers: {
    cookie: "__Host-cg_session=opaque",
    origin: "https://web.example",
    "x-csrf-token": "csrf",
    "x-request-id": "corr",
    "x-forwarded-for": "attacker-controlled",
    "x-claimguard-user": "attacker",
    "x-claimguard-role": "platform_administrator",
    "x-claimguard-user-tenant": "tenant-attacker",
    "x-claimguard-tenant": "tenant-attacker",
    "x-cg-service-actor": "service-attacker",
    "x-cg-service-role": "internal_service",
    "x-cg-service-tenant": "tenant-attacker",
    "x-cg-service-organisation": "org-attacker",
    authorization: "Bearer browser-controlled",
  }, socket: { remoteAddress: "192.0.2.10" } }, { trustProxy: false });

  expect(headers.get("cookie")).toBe("__Host-cg_session=opaque");
  expect(headers.get("origin")).toBe("https://web.example");
  expect(headers.get("x-csrf-token")).toBe("csrf");
  expect(headers.get("x-request-id")).toBe("corr");
  for (const name of [
    "x-claimguard-user", "x-claimguard-role", "x-claimguard-user-tenant", "x-claimguard-tenant",
    "x-cg-service-actor", "x-cg-service-role", "x-cg-service-tenant", "x-cg-service-organisation",
    "authorization",
  ]) {
    expect(headers.has(name)).toBe(false);
  }
  expect(headers.get("x-forwarded-for")).toBe("192.0.2.10");
});

test("proxy preserves multiple Set-Cookie values and required attributes", async () => {
  const responseHeaders = new Map();
  const res = {
    statusCode: 0,
    setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
    hasHeader(name) { return responseHeaders.has(name.toLowerCase()); },
    end: vi.fn(),
  };
  const upstream = {
    status: 200,
    headers: {
      entries() { return [["content-type", "application/json"]][Symbol.iterator](); },
      getSetCookie() { return ["__Host-cg_session=one; Secure; HttpOnly; Path=/; SameSite=Lax", "secondary=two; Secure; Path=/"]; },
    },
    async arrayBuffer() { return new TextEncoder().encode("{}").buffer; },
  };
  await proxyApiRequest({ url: "/api/auth/login", method: "GET", headers: {} }, res, {
    baseUrl: "http://api.test", fetchImpl: vi.fn(() => Promise.resolve(upstream)),
  });
  expect(res.statusCode).toBe(200);
  expect(responseHeaders.get("set-cookie")).toHaveLength(2);
  expect(responseHeaders.get("set-cookie")[0]).toMatch(/Secure; HttpOnly; Path=\/; SameSite=Lax/);
});

test("Clerk proxy overwrites security headers and preserves browser authentication material", () => {
  const headers = buildClerkFrontendApiHeaders({
    headers: {
      authorization: "Bearer clerk-browser-token",
      cookie: "__client=opaque",
      origin: "https://claimguard-web.azurewebsites.net",
      "clerk-proxy-url": "https://attacker.example/proxy",
      "clerk-secret-key": "attacker-secret",
      "x-client-ip": "203.0.113.24",
      "x-forwarded-for": "198.51.100.9",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
    socket: { remoteAddress: "192.0.2.10" },
  }, {
    proxyUrl: "https://claimguard-web.azurewebsites.net/__clerk",
    secretKey: "sk_live_server_only",
    trustProxy: true,
  });

  expect(headers.get("authorization")).toBe("Bearer clerk-browser-token");
  expect(headers.get("cookie")).toBe("__client=opaque");
  expect(headers.get("origin")).toBe("https://claimguard-web.azurewebsites.net");
  expect(headers.get("clerk-proxy-url")).toBe("https://claimguard-web.azurewebsites.net/__clerk");
  expect(headers.get("clerk-secret-key")).toBe("sk_live_server_only");
  expect(headers.get("x-forwarded-for")).toBe("203.0.113.24");
  expect(headers.get("x-forwarded-host")).toBe("claimguard-web.azurewebsites.net");
  expect(headers.get("x-forwarded-proto")).toBe("https");
});

test("Clerk proxy normalizes Azure client address forms", () => {
  expect(normalizeClientIp("203.0.113.24:43120")).toBe("203.0.113.24");
  expect(normalizeClientIp("[2001:db8::24]:43120")).toBe("2001:db8::24");
  expect(normalizeClientIp("2001:db8::24")).toBe("2001:db8::24");
});

test("Clerk proxy forwards the exact path, query, redirect, and cookies", async () => {
  const responseHeaders = new Map();
  const res = {
    statusCode: 0,
    setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); },
    hasHeader(name) { return responseHeaders.has(name.toLowerCase()); },
    end: vi.fn(),
  };
  const upstream = {
    status: 307,
    headers: {
      entries() { return [["location", "https://claimguard-web.azurewebsites.net/sign-in"]][Symbol.iterator](); },
      getSetCookie() { return ["__client=session; Secure; HttpOnly; Path=/; SameSite=Lax"]; },
    },
    async arrayBuffer() { return new Uint8Array().buffer; },
  };
  const fetchImpl = vi.fn(() => Promise.resolve(upstream));

  await proxyClerkFrontendApiRequest({
    url: "/__clerk/v1/client?foo=bar",
    method: "GET",
    headers: { cookie: "__client=opaque" },
    socket: { remoteAddress: "192.0.2.10" },
  }, res, {
    proxyUrl: "https://claimguard-web.azurewebsites.net/__clerk",
    secretKey: "sk_live_server_only",
    fetchImpl,
  });

  expect(fetchImpl.mock.calls[0][0].toString()).toBe("https://frontend-api.clerk.dev/v1/client?foo=bar");
  expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
  expect(res.statusCode).toBe(307);
  expect(responseHeaders.get("location")).toBe("https://claimguard-web.azurewebsites.net/sign-in");
  expect(responseHeaders.get("set-cookie")[0]).toMatch(/Secure; HttpOnly; Path=\/; SameSite=Lax/);
});

test("Clerk proxy rejects requests outside its configured path", async () => {
  await expect(proxyClerkFrontendApiRequest({
    url: "/api/health",
    method: "GET",
    headers: {},
    socket: { remoteAddress: "192.0.2.10" },
  }, {}, {
    proxyUrl: "https://claimguard-web.azurewebsites.net/__clerk",
    secretKey: "sk_live_server_only",
  })).rejects.toThrow(/outside the configured Clerk proxy path/);
});
