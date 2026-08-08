import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  apiJson,
  setAccessTokenProvider,
  setCsrfToken,
  setUnauthorizedHandler,
} from "../lib/apiClient";
import { useWorkforceIdentity } from "./WorkforceIdentityContext";

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
  const workforceIdentity = useWorkforceIdentity();
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
    if (workforceIdentity.managed && !workforceIdentity.isLoaded) return;
    if (workforceIdentity.managed && !workforceIdentity.isSignedIn) {
      clearSession();
      return;
    }
    try {
      const session = await apiJson("/auth/session", { cache: "no-store", skipUnauthorizedHandler: true });
      if (!session.authenticated) return clearSession();
      if (!workforceIdentity.managed) {
        const csrf = await apiJson("/auth/csrf", { cache: "no-store", skipUnauthorizedHandler: true });
        setCsrfToken(csrf.csrfToken);
      }
      setState({ status: "authenticated", session, error: null });
    } catch {
      clearSession();
    }
  }, [clearSession, workforceIdentity.isLoaded, workforceIdentity.isSignedIn, workforceIdentity.managed]);

  useEffect(() => {
    setAccessTokenProvider(workforceIdentity.getToken);
    setUnauthorizedHandler(expireSession);
    loadSession();
    return () => {
      setAccessTokenProvider(null);
      setUnauthorizedHandler(null);
    };
  }, [expireSession, loadSession, workforceIdentity.getToken]);

  const logout = useCallback(async () => {
    if (!workforceIdentity.managed) {
      try { await apiJson("/auth/logout", { method: "POST" }); } catch { /* test-only legacy session */ }
    }
    clearSession();
    await workforceIdentity.signOut?.({ redirectUrl: "/sign-in" });
  }, [clearSession, workforceIdentity]);

  const identity = state.session ? sessionIdentity(state.session) : null;
  const value = useMemo(() => ({
    ...state,
    mode: workforceIdentity.managed ? "clerk" : "test-session",
    authenticated: state.status === "authenticated",
    identity,
    logout,
    reloadSession: loadSession,
  }), [state, workforceIdentity.managed, identity, logout, loadSession]);
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
