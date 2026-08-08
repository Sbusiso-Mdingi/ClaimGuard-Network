import React, { createContext, useContext, useMemo } from "react";
import { useAuth, useClerk } from "@clerk/react";

const WorkforceIdentityContext = createContext(Object.freeze({
  managed: false,
  isLoaded: true,
  isSignedIn: null,
  organisationId: null,
  getToken: null,
  signOut: null,
  openUserProfile: null,
}));

export function ClerkWorkforceIdentityBridge({ children }) {
  const auth = useAuth();
  const clerk = useClerk();
  const value = useMemo(() => ({
    managed: true,
    isLoaded: auth.isLoaded,
    isSignedIn: auth.isSignedIn,
    organisationId: auth.orgId || null,
    getToken: auth.getToken,
    signOut: clerk.signOut,
    openUserProfile: clerk.openUserProfile,
  }), [auth.getToken, auth.isLoaded, auth.isSignedIn, auth.orgId, clerk.openUserProfile, clerk.signOut]);
  return (
    <WorkforceIdentityContext.Provider value={value}>
      {children}
    </WorkforceIdentityContext.Provider>
  );
}

export function useWorkforceIdentity() {
  return useContext(WorkforceIdentityContext);
}
