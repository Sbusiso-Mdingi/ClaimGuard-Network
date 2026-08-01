import {
  hasAnyCapability,
  hasEveryCapability,
} from "./capabilities";

export const NAV_GROUPS = [
  {
    key: "operations",
    title: "OPERATIONS",
    subtitle: "Monitor claims, investigate alerts, and review scheme risk.",
    items: [
      {
        key: "dashboard",
        to: "/dashboard",
        label: "Overview",
        capabilities: ["reports.view_own", "claims.view_own"],
        capabilityMode: "any",
      },
      {
        key: "claims",
        to: "/claims",
        label: "Claims Explorer",
        capabilities: ["claims.view_own"],
      },
      {
        key: "investigations",
        to: "/investigations",
        label: "Investigations",
        capabilities: ["investigations.view"],
      },
    ],
  },
  {
    key: "intelligence",
    title: "INTELLIGENCE",
    subtitle: "Analyse suspicious relationships, risk signals, and detection history.",
    items: [
      {
        key: "network",
        to: "/network",
        label: "Network Analysis",
        capabilities: ["reports.view_own"],
      },
      {
        key: "risk",
        to: "/risk",
        label: "Risk Intelligence",
        capabilities: ["reports.view_own"],
      },
      {
        key: "history",
        to: "/history",
        label: "Detection History",
        capabilities: ["reports.view_own"],
      },
      {
        key: "committee",
        to: "/committee",
        label: "Fraud Registry",
        capabilities: [
          "fraud_registry.search",
          "fraud_registry.view",
          "fraud_registry.review_history",
        ],
        capabilityMode: "any",
      },
    ],
  },
  {
    key: "administration",
    title: "ADMINISTRATION",
    subtitle: "Manage scheme access, policy, and platform operations.",
    items: [
      {
        key: "scheme-admin",
        to: "/admin/scheme",
        label: "Scheme Settings",
        capabilities: ["users.manage_tenant", "tenant_status.view"],
        capabilityMode: "any",
      },
      {
        key: "platform-admin",
        to: "/admin/platform",
        label: "Platform Control",
        capabilities: ["tenants.manage", "platform_health.view"],
        capabilityMode: "any",
      },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function canAccessNavItem(identity, item) {
  if (!item) return true;
  const required = item.capabilities || [];
  if (required.length === 0) return true;
  if (item.capabilityMode === "any") return hasAnyCapability(identity, required);
  return hasEveryCapability(identity, required);
}
