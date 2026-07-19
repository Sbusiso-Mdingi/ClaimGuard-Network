const MODES = new Set(["session", "demo_headers"]);

function booleanValue(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Expected a boolean configuration value, received ${value}.`);
}

function positiveNumber(value, fallback, name) {
  const number = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number.`);
  return number;
}

function positiveInteger(value, fallback, name) {
  const number = positiveNumber(value, fallback, name);
  if (!Number.isInteger(number)) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function origins(value, fallback = []) {
  const entries = value ? String(value).split(",") : fallback;
  return entries.map((entry) => new URL(entry.trim()).origin);
}

export function resolveAuthenticationConfiguration(env = process.env) {
  const mode = String(env.AUTHENTICATION_MODE || "session").trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error("AUTHENTICATION_MODE must be exactly session or demo_headers.");
  const deploymentClass = String(env.DEPLOYMENT_CLASS || (env.NODE_ENV === "production" ? "production" : "local")).trim().toLowerCase();
  const production = deploymentClass === "production" || env.NODE_ENV === "production";
  if (production && mode === "demo_headers") throw new Error("Production refuses AUTHENTICATION_MODE=demo_headers.");
  if (mode === "session" && !env.CONTROL_PLANE_MYSQL_URL?.trim()) {
    throw new Error("CONTROL_PLANE_MYSQL_URL is required in session authentication mode.");
  }
  const demoCredentialsVisible = booleanValue(env.DEMO_CREDENTIALS_VISIBLE, false);
  if (demoCredentialsVisible && deploymentClass !== "demo") {
    throw new Error("DEMO_CREDENTIALS_VISIBLE=true is permitted only when DEPLOYMENT_CLASS=demo.");
  }
  if (production && (demoCredentialsVisible || env.DEMO_CREDENTIALS_JSON)) {
    throw new Error("Production refuses demo credential exposure configuration.");
  }
  const cookieSecure = booleanValue(env.SESSION_COOKIE_SECURE, production || deploymentClass !== "local");
  if (production && !cookieSecure) throw new Error("Production session cookies must be Secure.");
  const allowedOrigins = origins(
    env.AUTH_ALLOWED_ORIGINS,
    production ? [] : ["http://localhost:3002", "http://127.0.0.1:3002", "http://localhost"],
  );
  if (mode === "session" && production && allowedOrigins.length === 0) {
    throw new Error("AUTH_ALLOWED_ORIGINS is required for production session mode.");
  }
  return Object.freeze({
    mode,
    deploymentClass,
    production,
    cookie: Object.freeze({
      name: cookieSecure ? "__Host-cg_session" : "cg_session_local",
      secure: cookieSecure,
      sameSite: "Lax",
      path: "/",
      httpOnly: true,
    }),
    idleTimeoutMs: positiveNumber(env.SESSION_IDLE_TIMEOUT_MINUTES, 30, "SESSION_IDLE_TIMEOUT_MINUTES") * 60_000,
    absoluteTimeoutMs: positiveNumber(env.SESSION_ABSOLUTE_TIMEOUT_HOURS, 8, "SESSION_ABSOLUTE_TIMEOUT_HOURS") * 3_600_000,
    throttle: Object.freeze({
      windowMs: positiveNumber(env.LOGIN_THROTTLE_WINDOW_MINUTES, 15, "LOGIN_THROTTLE_WINDOW_MINUTES") * 60_000,
      maxAttempts: positiveInteger(env.LOGIN_THROTTLE_MAX_ATTEMPTS, 8, "LOGIN_THROTTLE_MAX_ATTEMPTS"),
      baseDelayMs: positiveNumber(env.LOGIN_THROTTLE_BASE_DELAY_MS, 500, "LOGIN_THROTTLE_BASE_DELAY_MS"),
      maxDelayMs: positiveNumber(env.LOGIN_THROTTLE_MAX_DELAY_MS, 30_000, "LOGIN_THROTTLE_MAX_DELAY_MS"),
      lockoutMs: positiveNumber(env.LOGIN_THROTTLE_LOCKOUT_MINUTES, 15, "LOGIN_THROTTLE_LOCKOUT_MINUTES") * 60_000,
    }),
    allowedOrigins: Object.freeze(allowedOrigins),
    trustProxy: booleanValue(env.TRUST_PROXY, false),
    internalServiceToken: validateInternalServiceToken(env.INTERNAL_SERVICE_TOKEN),
    internalServiceOrganisationIds: Object.freeze(String(env.INTERNAL_SERVICE_ORGANISATION_IDS || "").split(",").map((value) => value.trim()).filter(Boolean)),
    internalServiceAllowedRoles: Object.freeze(String(env.INTERNAL_SERVICE_ALLOWED_ROLES || "claims_analyst").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)),
    demoCredentialsVisible,
    demoCredentials: parseDemoCredentials(env.DEMO_CREDENTIALS_JSON, { enabled: demoCredentialsVisible }),
    publicOrganisationUrlScheme: String(env.PUBLIC_ORGANISATION_URL_SCHEME || "https").trim().toLowerCase(),
    publicOrganisationHost: String(env.PUBLIC_ORGANISATION_HOST || "localhost:3002").trim().toLowerCase(),
  });
}

function validateInternalServiceToken(value) {
  if (!value) return null;
  const token = String(value);
  if (token.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 256 bits of unguessable material.");
  return token;
}

export function parseDemoCredentials(value, { enabled = false } = {}) {
  if (!enabled || !value) return Object.freeze([]);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("DEMO_CREDENTIALS_JSON must be valid JSON."); }
  if (!Array.isArray(parsed)) throw new Error("DEMO_CREDENTIALS_JSON must be an array.");
  return Object.freeze(parsed.map((entry) => Object.freeze({
    organisationSlug: String(entry.organisationSlug || "").trim().toLowerCase(),
    username: String(entry.username || "").trim().toLowerCase(),
    password: String(entry.password || ""),
  })));
}

export function isAllowedOrigin(request, configuration) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let normalized;
  try { normalized = new URL(origin).origin; } catch { return false; }
  return configuration.allowedOrigins.includes(normalized);
}
