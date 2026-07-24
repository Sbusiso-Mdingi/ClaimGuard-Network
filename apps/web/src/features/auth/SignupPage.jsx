import React, { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { apiJson } from "../../lib/apiClient";

export function SignupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") || "";

  const [status, setStatus] = useState("loading"); // loading, ready, error, success
  const [errorMsg, setErrorMsg] = useState("");
  const [invitation, setInvitation] = useState(null);

  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorMsg("No invitation token provided.");
      return;
    }

    apiJson(`/auth/invitation/${token}`, { cache: "no-store", skipUnauthorizedHandler: true })
      .then((data) => {
        if (data.available) {
          setInvitation(data);
          setStatus("ready");
        } else {
          setStatus("error");
          setErrorMsg(data.message || "Invalid invitation.");
        }
      })
      .catch((err) => {
        setStatus("error");
        setErrorMsg(err.message || "Failed to validate invitation.");
      });
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setErrorMsg("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setErrorMsg("Password must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg("");

    try {
      const result = await apiJson("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          token,
          displayName,
          username,
          password,
        }),
        skipUnauthorizedHandler: true,
      });

      if (result.available) {
        setStatus("success");
      } else {
        setErrorMsg(result.message || "Signup failed.");
      }
    } catch (err) {
      setErrorMsg(err.message || "Signup failed due to an unexpected error.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <p className="text-muted-foreground animate-pulse">Verifying invitation...</p>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invalid Invitation</CardTitle>
            <CardDescription>We could not process this signup link.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive">{errorMsg}</p>
            <Button onClick={() => navigate("/login")} className="mt-4 w-full">Go to Login</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (status === "success") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Account Created</CardTitle>
            <CardDescription>Your administrator account has been set up successfully.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm">You can now sign in to your organisation.</p>
            <Button onClick={() => navigate(`/o/${invitation.canonicalSlug}/login`)} className="w-full">
              Proceed to Login
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Complete Your Setup</CardTitle>
          <CardDescription>
            You have been invited to manage <strong>{invitation.organisationName}</strong>.
            <br />
            Invited email: {invitation.email}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <label className="block text-sm font-medium">Full Name
              <Input
                aria-label="Full Name"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm font-medium">Username
              <Input
                aria-label="Username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm font-medium">Password
              <Input
                aria-label="Password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>
            <label className="block text-sm font-medium">Confirm Password
              <Input
                aria-label="Confirm Password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
            </label>
            {errorMsg ? <p role="alert" className="text-sm text-destructive">{errorMsg}</p> : null}
            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? "Creating Account…" : "Create Account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
