// No GET /investigations list endpoint exists on the API. This is a client-side
// convenience list (localStorage) of investigation IDs the current browser has
// created or opened — not a substitute for a real tenant-scoped list endpoint.
const STORAGE_KEY = "claimguard-tracked-investigations";

export function listTrackedInvestigations() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addTrackedInvestigation(investigationId) {
  if (!investigationId) return;
  const current = listTrackedInvestigations();
  if (current.includes(investigationId)) return;
  const next = [investigationId, ...current].slice(0, 50);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}