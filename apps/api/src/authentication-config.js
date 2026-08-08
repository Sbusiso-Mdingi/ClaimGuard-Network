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
  const mode = String(env.AUTHENTICATION_MODE || "clerk").trim().toLowerCase();
  if (!new Set(["clerk", "session"]).has(mode)) {
    throw new Error(
      "ClaimGuard refuses unsupported authentication modes: AUTHENTICATION_MODE must be exactly clerk.",
    );
  }
  if (mode === "session" && env.NODE_ENV !== "test") {
    throw new Error("Local-password session authentication is test-only; Clerk is required at runtime.");
  }
  if (env.DEMO_CREDENTIALS_VISIBLE || env.DEMO_CREDENTIALS_JSON) {
    throw new Error("Demo credential exposure configuration is no longer supported.");
  }
  const deploymentClass = String(env.DEPLOYMENT_CLASS || (env.NODE_ENV === "production" ? "production" : "local")).trim().toLowerCase();
  const production = deploymentClass === "production" || env.NODE_ENV === "production";
  if (!env.CONTROL_PLANE_MYSQL_URL?.trim()) {
    throw new Error("CONTROL_PLANE_MYSQL_URL is required for workforce authentication.");
  }
  const cookieSecure = booleanValue(env.SESSION_COOKIE_SECURE, production || deploymentClass !== "local");
  if (production && !cookieSecure) throw new Error("Production session cookies must be Secure.");
  const allowedOrigins = origins(
    env.AUTH_ALLOWED_ORIGINS,
    production ? [] : ["http://localhost:3002", "http://127.0.0.1:3002", "http://localhost"],
  );
  if (production && allowedOrigins.length === 0) {
    throw new Error("AUTH_ALLOWED_ORIGINS is required for production Clerk mode.");
  }
  const clerkWebOrigin = env.CLERK_WEB_ORIGIN
    ? new URL(String(env.CLERK_WEB_ORIGIN).trim()).origin
    : (production ? null : allowedOrigins[0]);
  if (mode === "clerk" && !clerkWebOrigin) {
    throw new Error("CLERK_WEB_ORIGIN is required for production Clerk mode.");
  }
  if (mode === "clerk" && !allowedOrigins.includes(clerkWebOrigin)) {
    throw new Error("CLERK_WEB_ORIGIN must be included in AUTH_ALLOWED_ORIGINS.");
  }
  const clerkPublishableKey = String(env.CLERK_PUBLISHABLE_KEY || "").trim();
  const clerkSecretKey = String(env.CLERK_SECRET_KEY || "").trim();
  if (mode === "clerk" && (!clerkPublishableKey || !clerkSecretKey)) {
    throw new Error("CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are required in Clerk authentication mode.");
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
    publicOrganisationUrlScheme: String(env.PUBLIC_ORGANISATION_URL_SCHEME || "https").trim().toLowerCase(),
    publicOrganisationHost: String(env.PUBLIC_ORGANISATION_HOST || "localhost:3002").trim().toLowerCase(),
    clerk: Object.freeze({
      publishableKey: clerkPublishableKey,
      secretKey: clerkSecretKey,
      webOrigin: clerkWebOrigin,
      authorizedParties: Object.freeze([...allowedOrigins]),
      // OAuth/social identities stay disallowed even if a dashboard setting is
      // changed accidentally. Enterprise SSO has a separate explicit gate.
      allowedExternalAccountProviders: Object.freeze([]),
      enterpriseSsoEnabled: booleanValue(env.CLERK_ENTERPRISE_SSO_ENABLED, false),
    }),
  });
}

export function isAllowedOrigin(request, configuration) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let normalized;
  try { normalized = new URL(origin).origin; } catch { return false; }
  return configuration.allowedOrigins.includes(normalized);
}
