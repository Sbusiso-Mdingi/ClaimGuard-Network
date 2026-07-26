export function capabilitiesFor(identity) {
  return new Set(
    Array.isArray(identity?.capabilities)
      ? identity.capabilities
      : [],
  );
}

export function hasCapability(identity, capability) {
  return Boolean(
    capability
    && capabilitiesFor(identity).has(capability),
  );
}

export function hasEveryCapability(identity, capabilities = []) {
  const granted = capabilitiesFor(identity);
  return capabilities.every((capability) => granted.has(capability));
}

export function hasAnyCapability(identity, capabilities = []) {
  const granted = capabilitiesFor(identity);
  return capabilities.some((capability) => granted.has(capability));
}

export function defaultRouteForIdentity(identity) {
  if (hasCapability(identity, "tenants.manage")) {
    return "/admin/platform";
  }
  if (hasCapability(identity, "users.manage_tenant")) {
    return "/admin/scheme";
  }
  if (hasAnyCapability(identity, [
    "claims.view_own",
    "reports.view_own",
  ])) {
    return "/dashboard";
  }
  if (hasCapability(identity, "investigations.view")) {
    return "/investigations";
  }
  if (hasAnyCapability(identity, [
    "fraud_registry.search",
    "fraud_registry.view",
    "fraud_registry.review_history",
  ])) {
    return "/committee";
  }
  return "/access";
}

export function formatRole(role) {
  if (!role) return "Unknown role";
  return String(role)
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function formatIdentityRoles(identity) {
  const roles = Array.isArray(identity?.roles) && identity.roles.length > 0
    ? identity.roles
    : identity?.role
      ? [identity.role]
      : [];
  return roles.map(formatRole).join(" · ") || "No assigned role";
}
