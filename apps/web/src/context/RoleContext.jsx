import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiJson, setCsrfToken, setDemoAuthorityHeaders, setUnauthorizedHandler } from "../lib/apiClient";
import { CLAIMGUARD_ROLES } from "../lib/claimguardRoles";

const STORAGE_KEY = "claimguard-dev-identity";
const authenticationMode = () => window.__CLAIMGUARD_AUTHENTICATION_MODE__ || "session";

const DEMO_CAPABILITIES = Object.freeze({
  [CLAIMGUARD_ROLES.FRAUD_ANALYST]: Object.freeze([
    "claims.view_own", "reports.view_own", "investigations.create", "investigations.view",
    "investigations.add_note", "investigations.change_priority", "fraud_registry.search",
    "fraud_registry.view", "fraud_registry.review_history",
  ]),
  [CLAIMGUARD_ROLES.INVESTIGATOR]: Object.freeze([
    "claims.view_own", "reports.view_own", "investigations.create", "investigations.view",
    "investigations.update_status", "investigations.add_note", "investigations.open",
    "investigations.complete", "investigations.upload_evidence", "investigations.submit_findings",
    "investigations.confirm_fraud", "fraud_registry.search", "fraud_registry.view",
    "fraud_registry.review_history",
  ]),
  [CLAIMGUARD_ROLES.APPLICATIONS_COMMITTEE_MEMBER]: Object.freeze([
    "fraud_registry.search", "fraud_registry.view", "fraud_registry.review_history",
  ]),
  [CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR]: Object.freeze([
    "claims.view_own", "reports.view_own", "investigations.view",
    "users.manage_tenant", "tenant_status.view",
  ]),
  [CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR]: Object.freeze([
    "tenants.manage", "platform_health.view", "telemetry.view",
  ]),
});

function demoIdentity(identity) {
  return Object.freeze({
    ...identity,
    roles: Object.freeze([identity.role]),
    capabilities: DEMO_CAPABILITIES[identity.role] || Object.freeze([]),
  });
}

export const DEMO_IDENTITIES = [
  demoIdentity({ id: "analyst-alpha", label: "Fraud Analyst — Bonitas", userId: "analyst-alpha", role: CLAIMGUARD_ROLES.FRAUD_ANALYST, tenantId: "tenant_alpha", tenantLabel: "Bonitas" }),
  demoIdentity({ id: "investigator-alpha", label: "Fraud Investigator — Bonitas", userId: "investigator-alpha", role: CLAIMGUARD_ROLES.INVESTIGATOR, tenantId: "tenant_alpha", tenantLabel: "Bonitas" }),
  demoIdentity({ id: "committee-alpha", label: "Applications Committee — Bonitas", userId: "committee-alpha", role: CLAIMGUARD_ROLES.APPLICATIONS_COMMITTEE_MEMBER, tenantId: "tenant_alpha", tenantLabel: "Bonitas" }),
  demoIdentity({ id: "scheme-admin-alpha", label: "Scheme Administrator — Bonitas", userId: "scheme-admin-alpha", role: CLAIMGUARD_ROLES.SCHEME_ADMINISTRATOR, tenantId: "tenant_alpha", tenantLabel: "Bonitas" }),
  demoIdentity({ id: "platform-admin", label: "Platform Administrator — rollback mode", userId: "platform-admin", role: CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR, tenantId: "tenant_default", tenantLabel: "Platform", organisationType: "platform" }),
];

const RoleContext = createContext(null);

function sessionIdentity(session) {
  const roles = session?.roles || [];
  return {
    id: session.user.userId,
    userId: session.user.userId,
    label: session.user.displayName,
    role: roles[0] || null,
    roles,
    capabilities: session.clientCapabilities || [],
    tenantId: session.operationalTenant?.tenantId || null,
    tenantSlug: session.operationalTenant?.tenantSlug || null,
    tenantLabel: session.organisation.displayName,
    organisationId: session.organisation.organisationId,
    organisationSlug: session.organisation.canonicalSlug,
    organisationType: session.organisation.organisationType,
  };
}

export function RoleProvider({ children }) {
  const mode = authenticationMode();
  const [state, setState] = useState({ status: mode === "demo_headers" ? "authenticated" : "loading", session: null, error: null });
  const [identityId, setIdentityId] = useState(() => {
    if (mode !== "demo_headers") return null;
    try { return window.localStorage.getItem(STORAGE_KEY) || DEMO_IDENTITIES[0].id; } catch { return DEMO_IDENTITIES[0].id; }
  });
  const selectedDemoIdentity = DEMO_IDENTITIES.find((item) => item.id === identityId) || DEMO_IDENTITIES[0];

  if (mode === "demo_headers") {
    setDemoAuthorityHeaders({
      "x-claimguard-user": selectedDemoIdentity.userId,
      "x-claimguard-role": selectedDemoIdentity.role,
      "x-claimguard-user-tenant": selectedDemoIdentity.tenantId,
      "x-claimguard-tenant": selectedDemoIdentity.tenantId,
    });
  }

  const clearSession = useCallback(() => {
    setCsrfToken(null);
    setState({ status: "unauthenticated", session: null, error: null });
  }, []);

  const loadSession = useCallback(async () => {
    if (mode === "demo_headers") return;
    try {
      const session = await apiJson("/auth/session", { cache: "no-store", skipUnauthorizedHandler: true });
      if (!session.authenticated) return clearSession();
      const csrf = await apiJson("/auth/csrf", { cache: "no-store", skipUnauthorizedHandler: true });
      setCsrfToken(csrf.csrfToken);
      setState({ status: "authenticated", session, error: null });
    } catch {
      clearSession();
    }
  }, [clearSession, mode]);

  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    if (mode === "demo_headers") {
      try { window.localStorage.setItem(STORAGE_KEY, selectedDemoIdentity.id); } catch { /* isolated rollback mode only */ }
    } else {
      setDemoAuthorityHeaders(null);
      loadSession();
    }
    return () => setUnauthorizedHandler(null);
  }, [clearSession, selectedDemoIdentity.id, loadSession, mode]);

  const login = useCallback(async (credentials) => {
    setState({ status: "loading", session: null, error: null });
    try {
      const session = await apiJson("/auth/login", {
        method: "POST", body: JSON.stringify(credentials), skipUnauthorizedHandler: true,
      });
      setCsrfToken(session.csrfToken);
      const { csrfToken: _csrfToken, ...safeSession } = session;
      setState({ status: "authenticated", session: safeSession, error: null });
      return true;
    } catch (error) {
      setCsrfToken(null);
      setState({ status: "unauthenticated", session: null, error: error.message });
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try { await apiJson("/auth/logout", { method: "POST" }); } catch { /* cookie is still cleared by invalid-session handling */ }
    clearSession();
  }, [clearSession]);

  const identity = state.session ? sessionIdentity(state.session) : (mode === "demo_headers" ? selectedDemoIdentity : null);
  const value = useMemo(() => ({
    ...state,
    mode,
    authenticated: state.status === "authenticated",
    identity,
    identities: mode === "demo_headers" ? DEMO_IDENTITIES : [],
    setIdentityId: mode === "demo_headers" ? setIdentityId : () => {},
    authHeaders: Object.freeze({}),
    login,
    logout,
    reloadSession: loadSession,
  }), [state, mode, identity, login, logout, loadSession]);
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
