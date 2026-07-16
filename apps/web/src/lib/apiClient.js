export class ApiError extends Error {
  constructor(message, { status, code = null, payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

let csrfToken = null;
let unauthorizedHandler = null;
let demoAuthorityHeaders = null;

export function setCsrfToken(value) {
  csrfToken = typeof value === "string" && value ? value : null;
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

export function setDemoAuthorityHeaders(headers) {
  demoAuthorityHeaders = headers && typeof headers === "object" ? Object.freeze({ ...headers }) : null;
}

export async function apiRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = new Headers(options.headers || {});
  if (demoAuthorityHeaders) {
    for (const [name, value] of Object.entries(demoAuthorityHeaders)) headers.set(name, value);
  }
  if (mutating && csrfToken) headers.set("x-csrf-token", csrfToken);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 401 && !options.skipUnauthorizedHandler) {
    setCsrfToken(null);
    unauthorizedHandler?.();
  }
  return response;
}

export async function apiJson(path, options = {}) {
  const response = await apiRequest(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.message || `API request failed (${response.status}).`, {
      status: response.status, code: payload?.code || null, payload,
    });
  }
  return payload;
}
