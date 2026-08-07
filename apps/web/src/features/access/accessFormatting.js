export function formatPermissionKey(key) {
  if (!key) return "—";
  return String(key);
}

export function formatStatus(status) {
  if (!status) return "Unknown";
  return String(status).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDate(dateStr) {
  if (!dateStr) return "—";
  try {
    return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(dateStr));
  } catch {
    return String(dateStr);
  }
}

export function formatElevatedDecision(decision) {
  const map = {
    pending: "Pending independent review",
    approved: "Approved",
    rejected: "Rejected",
    superseded: "Superseded",
  };
  return map[String(decision).toLowerCase()] || formatStatus(decision);
}
