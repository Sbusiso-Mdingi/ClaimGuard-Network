export class ApiError extends Error {
  constructor(message, { status, code = null, payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const UNSAFE_ERROR_DETAIL = /\b(?:mysql(?:d)?(?:_[a-z0-9]+)*|sqlstate|stmt_execute|database driver|stack trace|select\s+.+\s+from|insert\s+into|update\s+.+\s+set)\b/i;

export function safeApiErrorMessage(error, fallback = "The service is temporarily unavailable.") {
  const payload = error instanceof ApiError ? error.payload : null;
  const candidate = String(
    (error instanceof Error ? error.message : "") || fallback,
  ).trim();
  const message = !candidate || UNSAFE_ERROR_DETAIL.test(candidate)
    ? fallback
    : candidate;
  const requestId = String(payload?.requestId || payload?.request_id || "").trim();
  return requestId ? `${message} Request ID: ${requestId}.` : message;
}

let csrfToken = null;
let unauthorizedHandler = null;
let accessTokenProvider = null;

export function setCsrfToken(value) {
  csrfToken = typeof value === "string" && value ? value : null;
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

export function setAccessTokenProvider(provider) {
  accessTokenProvider = typeof provider === "function" ? provider : null;
}

export async function apiRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = new Headers(options.headers || {});
  const accessToken = accessTokenProvider
    ? await accessTokenProvider().catch(() => null)
    : null;
  if (accessToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${accessToken}`);
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
