import { apiJson } from "../../lib/apiClient";

export async function fetchAccessMe() {
  return apiJson("/v1/access/me", { cache: "no-store" });
}

export async function fetchPermissions() {
  return apiJson("/v1/access/permissions", { cache: "no-store" });
}

export async function fetchRoles() {
  return apiJson("/v1/access/roles", { cache: "no-store" });
}

export async function fetchRole(roleId) {
  return apiJson(`/v1/access/roles/${encodeURIComponent(roleId)}`, { cache: "no-store" });
}

export async function fetchAssignments() {
  return apiJson("/v1/access/assignments", { cache: "no-store" });
}

export async function fetchDelegations() {
  return apiJson("/v1/access/delegations", { cache: "no-store" });
}

export async function fetchElevatedRequests() {
  return apiJson("/v1/access/elevated-requests", { cache: "no-store" });
}

export async function fetchAudit({ page, limit, action, actor, outcome } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (limit != null) params.set("limit", String(limit));
  if (action) params.set("action", action);
  if (actor) params.set("actor", actor);
  if (outcome) params.set("outcome", outcome);
  const qs = params.toString();
  return apiJson(`/v1/access/audit${qs ? `?${qs}` : ""}`, { cache: "no-store" });
}
