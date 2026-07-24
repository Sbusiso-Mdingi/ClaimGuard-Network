const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|set-cookie|password|secret|token|csrf)/i;
const TOKEN_QUERY_PATTERN = /([?&](?:token|invitationToken|invite|code)=)[^&#\s]*/gi;
const INVITATION_PATH_PATTERN = /(\/auth\/invitation\/)[^/?#\s]+/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;

export function redactSensitiveText(value) {
  return String(value)
    .replace(TOKEN_QUERY_PATTERN, "$1[REDACTED]")
    .replace(INVITATION_PATH_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]");
}

function scrubValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, seen));
  }

  const scrubbed = {};

  for (const [key, item] of Object.entries(value)) {
    scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : scrubValue(item, seen);
  }

  return scrubbed;
}

export function scrubSentryEvent(event) {
  return scrubValue(event);
}

export function scrubSentryBreadcrumb(breadcrumb) {
  return scrubValue(breadcrumb);
}
