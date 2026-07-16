import React from "react";
import { useRole } from "../../context/RoleContext";
import { NAV_ITEMS } from "../../lib/roleNav";
import { SectionCard } from "./InvestigatorUI";

export function RequireRoleAccess({ navKey, children }) {
  const { identity } = useRole();
  const item = NAV_ITEMS.find((entry) => entry.key === navKey);
  const activeRoles = identity.roles || [identity.role].filter(Boolean);
  const allowed = !item || item.roles.some((role) => activeRoles.includes(role));

  if (!allowed) {
    return (
      <SectionCard
        title="Not available for this role"
        description={`The authenticated account (${identity.label}) does not have access to this section.`}
      >
        <p className="text-sm text-muted-foreground">
          Access is derived from your active server-side organisation membership.
        </p>
      </SectionCard>
    );
  }

  return children;
}
