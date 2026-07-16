import React from "react";
import { useRole } from "../../context/RoleContext";

export function RoleSwitcher() {
  const { identity, identities, setIdentityId, mode } = useRole();
  if (mode !== "demo_headers") return null;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-400">
        Dev-only role switcher
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Not authentication. Sets demo x-claimguard-* headers consumed by the existing API authorization middleware.
      </p>
      <select
        aria-label="Demo identity"
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        value={identity.id}
        onChange={(event) => setIdentityId(event.target.value)}
      >
        {identities.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
}
