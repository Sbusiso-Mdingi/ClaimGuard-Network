import React, { useEffect, useMemo, useState } from "react";
import { SignIn } from "@clerk/react";
import MonitorCheck from "lucide-react/dist/esm/icons/monitor-check.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";

import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { useWorkforceIdentity } from "../../context/WorkforceIdentityContext";
import { useReverifiedApiJson } from "../../hooks/useReverifiedApiJson";
import { apiJson, safeApiErrorMessage } from "../../lib/apiClient";
import {
  clearDesktopAuthorizationSecret,
  readDesktopAuthorizationSecret,
} from "../../lib/desktopAuthorizationSecret";

function requestSecret() {
  return readDesktopAuthorizationSecret();
}

export function DesktopAuthorizationPage() {
  const workforce = useWorkforceIdentity();
  const reverifiedApiJson = useReverifiedApiJson();
  const browserSecret = useMemo(requestSecret, []);
  const [claimStatus, setClaimStatus] = useState(browserSecret ? "claiming" : "available");
  const [state, setState] = useState({ status: "loading", request: null, error: null });

  useEffect(() => {
    let active = true;
    if (!browserSecret) return () => { active = false; };
    apiJson("/auth/desktop/authorizations/claim", {
      method: "POST",
      body: JSON.stringify({ browserSecret }),
      skipUnauthorizedHandler: true,
    }).then(() => {
      clearDesktopAuthorizationSecret();
      if (active) setClaimStatus("available");
    }).catch((error) => {
      clearDesktopAuthorizationSecret();
      if (active) {
        setClaimStatus("error");
        setState({
          status: "error",
          request: null,
          error: safeApiErrorMessage(error, "This desktop sign-in request is unavailable."),
        });
      }
    });
    return () => { active = false; };
  }, [browserSecret]);

  useEffect(() => {
    let active = true;
    if (claimStatus !== "available" || !workforce.isLoaded || !workforce.isSignedIn || !workforce.organisationId) {
      return () => { active = false; };
    }
    setState({ status: "loading", request: null, error: null });
    apiJson("/auth/desktop/authorizations/inspect", {
      method: "POST",
      skipUnauthorizedHandler: true,
    }).then((request) => {
      if (active) setState({ status: "ready", request, error: null });
    }).catch((error) => {
      if (active) setState({
        status: "error",
        request: null,
        error: safeApiErrorMessage(error, "This desktop sign-in request is unavailable."),
      });
    });
    return () => { active = false; };
  }, [claimStatus, workforce.isLoaded, workforce.isSignedIn, workforce.organisationId]);

  async function approve() {
    setState((previous) => ({ ...previous, status: "approving", error: null }));
    try {
      await reverifiedApiJson("/auth/desktop/authorizations/approve", {
        method: "POST",
      });
      setState((previous) => ({ ...previous, status: "approved" }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "ready",
        error: safeApiErrorMessage(error, "The workstation could not be authorised."),
      }));
    }
  }

  if (!workforce.managed) {
    return <main className="grid min-h-screen place-items-center bg-background p-5"><Card className="w-full max-w-lg"><CardHeader><CardTitle>Clerk is required</CardTitle><CardDescription>Desktop sign-in cannot use a local account password.</CardDescription></CardHeader></Card></main>;
  }
  if (!workforce.isLoaded) {
    return <main className="grid min-h-screen place-items-center bg-background p-5 text-muted-foreground">Opening Clerk sign-in…</main>;
  }
  if (claimStatus === "claiming") {
    return <main className="grid min-h-screen place-items-center bg-background p-5 text-muted-foreground">Securing the one-time workstation request…</main>;
  }
  if (claimStatus === "error") {
    return <main className="grid min-h-screen place-items-center bg-background p-5"><Card className="w-full max-w-lg"><CardHeader><CardTitle>Desktop sign-in unavailable</CardTitle><CardDescription role="alert">{state.error}</CardDescription></CardHeader></Card></main>;
  }
  if (!workforce.isSignedIn) {
    return <main className="grid min-h-screen place-items-center bg-background p-5"><SignIn routing="virtual" fallbackRedirectUrl="/desktop/authorize" signUpUrl="/sign-up" /></main>;
  }
  if (!workforce.organisationId) {
    return <main className="grid min-h-screen place-items-center bg-background p-5"><Card className="w-full max-w-lg"><CardHeader><CardTitle>No work organisation selected</CardTitle><CardDescription>Sequrin does not allow users to create organisations. Sign out, then use the governed Clerk invitation for the organisation licensed on this workstation.</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={() => workforce.signOut?.({ redirectUrl: "/desktop/authorize" })}>Sign out</Button></CardContent></Card></main>;
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-5 text-foreground">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><MonitorCheck className="h-6 w-6" aria-hidden="true" /></div>
          <CardTitle>Authorise Sequrin Desktop</CardTitle>
          <CardDescription>Approve only if you started sign-in from the Sequrin workstation in front of you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {state.request ? <div className="rounded-xl border border-border bg-muted/30 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Licensed organisation</p><p className="mt-1 font-display text-lg font-semibold">{state.request.licensedOrganisation.displayName}</p></div> : null}
          {state.status === "loading" ? <p className="text-sm text-muted-foreground">Checking the one-time workstation request…</p> : null}
          {state.status === "approved" ? <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="font-semibold">Workstation authorised</p><p className="mt-1 text-sm text-muted-foreground">Return to Sequrin Desktop. This one-time request cannot be used again.</p></div></div> : null}
          {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
          {state.status === "ready" || state.status === "approving" ? <Button className="w-full" onClick={approve} disabled={state.status === "approving"}>{state.status === "approving" ? "Confirming with Clerk…" : "Authorise this workstation"}</Button> : null}
          {state.status !== "approved" ? <Button className="w-full" variant="outline" onClick={() => workforce.signOut?.({ redirectUrl: "/desktop/authorize" })}>Use a different work account</Button> : null}
        </CardContent>
      </Card>
    </main>
  );
}
