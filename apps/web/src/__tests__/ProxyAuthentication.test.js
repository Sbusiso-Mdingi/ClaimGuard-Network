import { buildUpstreamHeaders, proxyApiRequest } from "../proxy";

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
