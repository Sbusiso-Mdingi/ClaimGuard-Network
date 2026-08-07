import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import Shield from "lucide-react/dist/esm/icons/shield.mjs";
import { useRole } from "../../context/RoleContext";
import { hasAnyCapability } from "../../lib/capabilities";

const TABS = [
  {
    label: "Overview",
    to: "/admin/scheme/access",
    end: true,
    capabilities: [],
  },
  {
    label: "Permissions",
    to: "/admin/scheme/access/permissions",
    capabilities: ["access.roles.read", "access.roles.manage"],
  },
  {
    label: "Roles",
    to: "/admin/scheme/access/roles",
    capabilities: ["access.roles.read", "access.roles.manage"],
  },
  {
    label: "Assignments",
    to: "/admin/scheme/access/assignments",
    capabilities: ["access.assignments.read", "access.assignments.manage"],
  },
  {
    label: "Delegations",
    to: "/admin/scheme/access/delegations",
    capabilities: ["access.delegations.read", "access.delegations.grant", "access.delegations.revoke"],
  },
  {
    label: "Elevated Requests",
    to: "/admin/scheme/access/elevated",
    capabilities: ["access.elevated_permissions.review"],
  },
  {
    label: "Audit",
    to: "/admin/scheme/access/audit",
    capabilities: ["access.audit.read"],
  },
];

export function AccessManagementLayout() {
  const { identity } = useRole();

  const visibleTabs = TABS.filter((tab) =>
    tab.capabilities.length === 0 || hasAnyCapability(identity, tab.capabilities),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <Shield className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="font-display text-lg font-semibold text-foreground">Access management</h2>
      </div>

      <nav
        aria-label="Access management sections"
        role="tablist"
        className="flex flex-wrap gap-1 border-b border-border pb-0"
      >
        {visibleTabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            role="tab"
            className={({ isActive }) =>
              `inline-flex items-center px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <main id="access-main-content">
        <Outlet />
      </main>
    </div>
  );
}
