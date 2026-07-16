import { ControlPlaneValidationError } from "./errors.js";

export const ORGANISATION_TYPES = Object.freeze(["medical_scheme", "platform"]);
export const ORGANISATION_STATUSES = Object.freeze(["draft", "provisioning", "ready_for_activation", "active", "suspended", "failed", "archived"]);
export const USER_STATUSES = Object.freeze(["invited", "active", "disabled", "locked", "archived"]);
export const CREDENTIAL_STATUSES = Object.freeze(["pending_activation", "active", "disabled", "locked", "archived"]);
export const AUTHENTICATION_PROVIDERS = Object.freeze(["local_password", "oidc", "managed_identity"]);
export const MEMBERSHIP_STATUSES = Object.freeze(["invited", "active", "disabled", "expired", "revoked"]);
export const PROVISIONING_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "compensating", "compensated", "quarantined"]);
export const ROUTE_TYPES = Object.freeze(["legacy_shared", "private_database", "platform_none"]);
export const CANONICAL_ROLE_ALIASES = Object.freeze({
  scheme_user: "claims_analyst",
  new_applications_officer: "applications_committee_member",
});

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const FORBIDDEN_AUDIT_KEYS = new Set([
  "claim", "claims", "claim_payload", "member", "members", "diagnosis", "diagnoses",
  "prescription", "prescriptions", "medical_information", "investigation_note", "investigation_notes",
  "evidence_body", "evidence_bodies", "private_fraud_reason", "password", "password_hash",
  "session_token", "bearer_token", "csrf_token", "connection_string", "secret_value",
]);

export function normalizeOrganisationSlug(value) {
  if (typeof value !== "string") throw new ControlPlaneValidationError("Organisation slug is required.", "INVALID_ORGANISATION_SLUG");
  const normalized = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new ControlPlaneValidationError(
      "Organisation slug must contain lowercase ASCII letters, digits, or internal hyphens and must be 2-63 characters.",
      "INVALID_ORGANISATION_SLUG",
    );
  }
  return normalized;
}

export function normalizeUsername(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlPlaneValidationError("Username is required.", "INVALID_USERNAME");
  }
  return value.trim().toLowerCase();
}

export function requireEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new ControlPlaneValidationError(`${fieldName} must be one of: ${allowed.join(", ")}.`, `INVALID_${fieldName.toUpperCase()}`);
  }
  return value;
}

export function canonicalRoleKey(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CANONICAL_ROLE_ALIASES[normalized] || normalized;
}

export function validateSecretReference(value, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new ControlPlaneValidationError("Secret reference is required.", "SECRET_REFERENCE_REQUIRED");
    return null;
  }
  const reference = String(value).trim();
  const lowered = reference.toLowerCase();
  if (
    lowered.startsWith("mysql://") ||
    lowered.startsWith("mysql2://") ||
    lowered.includes("password=") ||
    lowered.includes("pwd=") ||
    /:\/\/[^/@:]+:[^/@]+@/.test(reference)
  ) {
    throw new ControlPlaneValidationError("A secret reference must not contain a connection string or secret value.", "SECRET_VALUE_NOT_PERMITTED");
  }
  const isAzureResourceId = /^\/subscriptions\/[a-z0-9-]+\/resourcegroups\//i.test(reference);
  const isReferenceUri = /^(?:https|kv|keyvault|secret|azure-keyvault):\/\//i.test(reference);
  if ((!isAzureResourceId && !isReferenceUri) || /[?#]/.test(reference)) {
    throw new ControlPlaneValidationError(
      "A secret reference must be a Key Vault-style URI or Azure resource identifier without query or fragment values.",
      "INVALID_SECRET_REFERENCE",
    );
  }
  return reference;
}

export function assertNoPlaintextPassword(input) {
  if (!input || typeof input !== "object") return;
  for (const key of Object.keys(input)) {
    if (["password", "plaintext_password", "plaintextpassword", "raw_password", "rawpassword"].includes(key.toLowerCase())) {
      throw new ControlPlaneValidationError("Plaintext password fields are not accepted.", "PLAINTEXT_PASSWORD_NOT_PERMITTED");
    }
  }
}

export function assertSafeControlPlaneSummary(value, path = "summary") {
  if (value == null) return value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeControlPlaneSummary(item, `${path}[${index}]`));
    return value;
  }
  if (typeof value !== "object") return value;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_AUDIT_KEYS.has(key.toLowerCase())) {
      throw new ControlPlaneValidationError(`${path}.${key} is not permitted in control-plane audit data.`, "PRIVATE_DATA_NOT_PERMITTED");
    }
    assertSafeControlPlaneSummary(item, `${path}.${key}`);
  }
  return value;
}

export function safeErrorSummary(error) {
  const type = String(error?.name || "Error").slice(0, 128);
  const code = String(error?.code || "UNCLASSIFIED").slice(0, 128);
  return { type, summary: `${type}:${code}`.slice(0, 512) };
}
