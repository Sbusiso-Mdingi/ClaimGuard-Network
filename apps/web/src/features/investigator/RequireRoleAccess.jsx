import React from "react";
import { useRole } from "../../context/RoleContext";
import { NAV_ITEMS } from "../../lib/roleNav";
import { SectionCard } from "./InvestigatorUI";

export function RequireRoleAccess({ navKey, children }) {
  const { identity } = useRole();
  const item = NAV_ITEMS.find((entry) => entry.key === navKey);
  const allowed = !item || item.roles.includes(identity.role);

  if (!allowed) {
    return (
      <SectionCard
        title="Not available for this role"
        description={`The current demo identity (${identity.label}) does not have access to this section.`}
      >
        <p className="text-sm text-muted-foreground">
          Switch identities using the development role switcher in the sidebar.
        </p>
      </SectionCard>
    );
  }

  return children;
}