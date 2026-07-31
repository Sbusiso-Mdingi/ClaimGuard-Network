import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiJson, setCsrfToken, setUnauthorizedHandler } from "../lib/apiClient";

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
  const [state, setState] = useState({ status: "loading", session: null, error: null });

  const clearSession = useCallback(() => {
    setCsrfToken(null);
    setState({ status: "unauthenticated", session: null, error: null });
  }, []);

  const expireSession = useCallback(() => {
    setCsrfToken(null);
    setState((previous) => ({
      status: "unauthenticated",
      session: null,
      error: previous.status === "authenticated"
        ? "Your session ended. Sign in again to continue."
        : previous.error,
    }));
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const session = await apiJson("/auth/session", { cache: "no-store", skipUnauthorizedHandler: true });
      if (!session.authenticated) return clearSession();
      const csrf = await apiJson("/auth/csrf", { cache: "no-store", skipUnauthorizedHandler: true });
      setCsrfToken(csrf.csrfToken);
      setState({ status: "authenticated", session, error: null });
    } catch {
      clearSession();
    }
  }, [clearSession]);

  useEffect(() => {
    setUnauthorizedHandler(expireSession);
    loadSession();
    return () => setUnauthorizedHandler(null);
  }, [expireSession, loadSession]);

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

  const identity = state.session ? sessionIdentity(state.session) : null;
  const value = useMemo(() => ({
    ...state,
    authenticated: state.status === "authenticated",
    identity,
    login,
    logout,
    reloadSession: loadSession,
  }), [state, identity, login, logout, loadSession]);
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
