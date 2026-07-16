import { buildUpstreamHeaders, proxyApiRequest } from "../proxy";

test("session proxy forwards Cookie, Origin, CSRF, and correlation headers but strips authority assertions", () => {
  const headers = buildUpstreamHeaders({ headers: {
    cookie: "__Host-cg_session=opaque",
    origin: "https://web.example",
    "x-csrf-token": "csrf",
    "x-request-id": "corr",
    "x-forwarded-for": "attacker-controlled",
    "x-claimguard-role": "platform_administrator",
    authorization: "Bearer browser-controlled",
  }, socket: { remoteAddress: "192.0.2.10" } }, { mode: "session", trustProxy: false });
  expect(headers.get("cookie")).toBe("__Host-cg_session=opaque");
  expect(headers.get("origin")).toBe("https://web.example");
  expect(headers.get("x-csrf-token")).toBe("csrf");
  expect(headers.get("x-request-id")).toBe("corr");
  expect(headers.has("x-claimguard-role")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
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
    baseUrl: "http://api.test", mode: "session", fetchImpl: vi.fn(() => Promise.resolve(upstream)),
  });
  expect(res.statusCode).toBe(200);
  expect(responseHeaders.get("set-cookie")).toHaveLength(2);
  expect(responseHeaders.get("set-cookie")[0]).toMatch(/Secure; HttpOnly; Path=\/; SameSite=Lax/);
});
