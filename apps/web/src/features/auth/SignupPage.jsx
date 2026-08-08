import React from "react";
import { SignUp } from "@clerk/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { useWorkforceIdentity } from "../../context/WorkforceIdentityContext";

export function SignupPage() {
  const workforce = useWorkforceIdentity();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      {workforce.managed ? (
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/" />
      ) : (
        <Card className="w-full max-w-md"><CardHeader><CardTitle>Invitation acceptance unavailable</CardTitle><CardDescription>Clerk has not been configured for this client.</CardDescription></CardHeader><CardContent><p className="text-sm text-muted-foreground">Sequrin does not provide local sign-up or password creation.</p></CardContent></Card>
      )}
    </main>
  );
}
