import React from "react";
import { useRole } from "../../context/RoleContext";
import { canAccessNavItem, NAV_ITEMS } from "../../lib/roleNav";
import { SectionCard } from "./InvestigatorUI";

export function RequireRoleAccess({ navKey, children }) {
  const { identity } = useRole();
  const item = NAV_ITEMS.find((entry) => entry.key === navKey);
  const allowed = item ? canAccessNavItem(identity, item) : false;

  if (!allowed) {
    const subject = identity?.label ? `(${identity.label})` : "";
    return (
      <SectionCard
        title="Access unavailable"
        description={`The authenticated account ${subject} does not have the required capability for this section.`}
      >
        <p className="text-sm text-muted-foreground">
          Access is derived from your active server-side organisation membership and capabilities.
        </p>
      </SectionCard>
    );
  }

  return children;
}
