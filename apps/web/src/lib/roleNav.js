export const NAV_GROUPS = [
  {
    key: "your-scheme",
    title: "YOUR SCHEME",
    subtitle: "Tenant workspace views scoped to your active medical scheme.",
    items: [
      {
        key: "dashboard",
        to: "/",
        label: "Dashboard",
        capabilities: ["reports.view_own", "claims.view_own"],
        capabilityMode: "any",
      },
      {
        key: "claims",
        to: "/claims",
        label: "Claims",
        capabilities: ["claims.view_own"],
      },
      {
        key: "investigations",
        to: "/investigations",
        label: "Investigations",
        capabilities: ["investigations.view"],
      },
      {
        key: "network",
        to: "/network",
        label: "Network",
        capabilities: ["reports.view_own"],
      },
      {
        key: "risk",
        to: "/risk",
        label: "Risk",
        capabilities: ["reports.view_own"],
      },
      {
        key: "history",
        to: "/history",
        label: "History",
        capabilities: ["reports.view_own"],
      },
    ],
  },
  {
    key: "shared-ecosystem",
    title: "SHARED ECOSYSTEM",
    subtitle: "Confirmed fraud records shared between participating medical schemes.",
    items: [
      {
        key: "committee",
        to: "/committee",
        label: "Shared Fraud Registry",
        capabilities: ["fraud_registry.search", "fraud_registry.view"],
        capabilityMode: "any",
      },
    ],
  },
  {
    key: "administration",
    title: "ADMINISTRATION",
    subtitle: "Tenant and platform governance controls.",
    items: [
      {
        key: "scheme-admin",
        to: "/admin/scheme",
        label: "Scheme Administration",
        capabilities: ["users.manage_tenant", "tenant_status.view"],
        capabilityMode: "any",
      },
      {
        key: "platform-admin",
        to: "/admin/platform",
        label: "Platform Administration",
        capabilities: ["tenants.manage", "platform_health.view"],
        capabilityMode: "any",
      },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function canAccessNavItem(identity, item) {
  if (!item) return true;
  const granted = new Set(identity?.capabilities || []);
  const required = item.capabilities || [];
  if (required.length === 0) return true;
  if (item.capabilityMode === "any") return required.some((capability) => granted.has(capability));
  return required.every((capability) => granted.has(capability));
}
