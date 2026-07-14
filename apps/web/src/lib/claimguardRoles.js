// Mirrors the backend's role string constants (apps/api/src/authorization-policy.js)
// for UI labeling only. No permission logic is duplicated here — the API remains
// the sole authority and enforces every action independently of this file.
export const CLAIMGUARD_ROLES = Object.freeze({
  SCHEME_USER: "scheme_user",
  FRAUD_ANALYST: "fraud_analyst",
  INVESTIGATOR: "investigator",
  NEW_APPLICATIONS_OFFICER: "new_applications_officer",
  SCHEME_ADMINISTRATOR: "scheme_administrator",
  PLATFORM_ADMINISTRATOR: "platform_administrator",
});