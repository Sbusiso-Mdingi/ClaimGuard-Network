import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { CLAIMGUARD_ROLES } from "../lib/claimguardRoles";

const STORAGE_KEY = "claimguard-dev-identity";

// DEV-ONLY. These are not real accounts — they exist purely to exercise the
// existing header-based authorization already implemented by the API
// (x-claimguard-user / -role / -user-tenant / -tenant). Real auth (Entra ID
// etc.) is out of scope for this phase and is not implemented here.
export const DEMO_IDENTITIES = [
  { id: "analyst-alpha", label: "Claims Analyst — Bonitas", userId: "analyst-alpha", role: CLAIMGUARD_ROLES.FRAUD_ANALYST, tenantId: "tenant_alpha", tenantLabel: "Bonitas" },
  { id: "investigator-alpha", label: "Fraud Investigator — Bonitas", userId: "investigator-alpha", role: CLAIMGUARD_ROLES.INVESTIGATOR, tenantId: "tenant_alpha", tenantLabel: "Bonitas" },
  { id: "committee-alpha", label: "Applications Committee — Bonitas", userId: "committee-alpha", role: CLAIMGUARD_ROLES.NEW_APPLICATIONS_OFFICER, tenantId: "tenant_alpha", tenantLabel: "Bonitas" },
  { id: "scheme-admin-alpha", label: "Scheme Administrator — Bonitas", userId: "scheme-admin-alpha", role: CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR, tenantId: "tenant_alpha", tenantLabel: "Bonitas" },
  { id: "investigator-beta", label: "Fraud Investigator — Discovery Health", userId: "investigator-beta", role: CLAIMGUARD_ROLES.INVESTIGATOR, tenantId: "tenant_beta", tenantLabel: "Discovery Health" },
  { id: "platform-admin", label: "Platform Administrator (ClaimGuard staff)", userId: "platform-admin", role: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR, tenantId: "tenant_default", tenantLabel: "Platform" },
];

const RoleContext = createContext(null);

export function RoleProvider({ children }) {
  const [identityId, setIdentityId] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || DEMO_IDENTITIES[0].id;
    } catch {
      return DEMO_IDENTITIES[0].id;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, identityId);
    } catch {
      /* ignore */
    }
  }, [identityId]);

  const identity = DEMO_IDENTITIES.find((item) => item.id === identityId) || DEMO_IDENTITIES[0];

  const authHeaders = useMemo(
    () => ({
      "x-claimguard-user": identity.userId,
      "x-claimguard-role": identity.role,
      "x-claimguard-user-tenant": identity.tenantId,
      "x-claimguard-tenant": identity.tenantId,
    }),
    [identity],
  );

  const value = useMemo(
    () => ({ identity, identities: DEMO_IDENTITIES, setIdentityId, authHeaders }),
    [identity, authHeaders],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}