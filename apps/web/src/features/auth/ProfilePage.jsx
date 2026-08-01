import React, { useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.mjs";
import KeyRound from "lucide-react/dist/esm/icons/key-round.mjs";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import Mail from "lucide-react/dist/esm/icons/mail.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import UserRound from "lucide-react/dist/esm/icons/user-round.mjs";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useRole } from "../../context/RoleContext";
import { apiJson, safeApiErrorMessage } from "../../lib/apiClient";
import { formatIdentityRoles } from "../../lib/capabilities";
import {
  formatEnumLabel,
  PageFrame,
  SectionCard,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { initialsFromLabel } from "./AccountMenu";

function displayValue(value, fallback = "Not provided") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function formatDateTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ProfileField({ label, value, mono = false, children }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-background/55 px-4 py-3.5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-1.5 break-words text-sm font-medium text-foreground ${mono ? "font-data" : ""}`}>
        {children || displayValue(value)}
      </dd>
    </div>
  );
}

function StatusBadge({ value }) {
  const active = String(value || "").toLowerCase() === "active";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${active ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-secondary text-foreground"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-muted-foreground"}`} aria-hidden="true" />
      {formatEnumLabel(value)}
    </span>
  );
}

export function ProfilePage() {
  const { session, identity, logout } = useRole();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const user = session?.user || {};
  const account = session?.account || {};
  const organisation = session?.organisation || {};
  const sessionActivity = session?.sessionActivity || {};
  const roles = session?.roles || [];
  const capabilities = session?.clientCapabilities || [];
  const roleLabel = formatIdentityRoles(identity);
  const passwordMinLength = Number(account.passwordMinLength || (organisation.organisationType === "platform" ? 12 : 8));

  function updateField(event) {
    const { name, value } = event.target;
    setForm((previous) => ({ ...previous, [name]: value }));
  }

  async function changePassword(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (form.newPassword !== form.confirmPassword) {
      setError("The new password and confirmation do not match.");
      return;
    }
    if (form.newPassword.length < passwordMinLength) {
      setError(`Password must be at least ${passwordMinLength} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiJson("/auth/password/change", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
        skipUnauthorizedHandler: true,
      });
      const revoked = Number(result.otherSessionsRevoked || 0);
      setForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setSuccess(
        revoked > 0
          ? `Password changed. ${revoked} other ${revoked === 1 ? "session was" : "sessions were"} signed out.`
          : "Password changed successfully.",
      );
    } catch (caught) {
      setError(safeApiErrorMessage(caught, "The password could not be changed. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageFrame
      eyebrow="Account"
      title="Profile"
      description="Your ClaimGuard work identity, organisation access, and account security."
      actions={(
        <Button type="button" variant="outline" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" /> Sign out
        </Button>
      )}
    >
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <SectionCard
          title="Work profile"
          description="These details come from your organisation-managed ClaimGuard account."
          variant="console"
          contentClassName="p-5"
        >
          <div className="mb-5 flex items-center gap-4 rounded-xl border border-border/70 bg-secondary/35 p-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary/12 text-base font-bold text-primary sm:h-16 sm:w-16 sm:text-lg">
              {initialsFromLabel(user.displayName)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate font-display text-xl font-bold">{displayValue(user.displayName, "Authenticated account")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{roleLabel}</p>
              <div className="mt-2"><StatusBadge value={account.userStatus || user.status} /></div>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <ProfileField label="Full name" value={user.displayName} />
            <ProfileField label="Work email or contact" value={account.workContact || user.canonicalContact} />
            <ProfileField label="Username" value={account.username} mono />
            <ProfileField label="Organisation" value={organisation.displayName} />
            <ProfileField label="Organisation type" value={formatEnumLabel(organisation.organisationType)} />
            <ProfileField label="Role" value={roleLabel} />
            <ProfileField label="Account ID" value={user.userId} mono />
            <ProfileField label="Membership status">
              <StatusBadge value={account.membershipStatus} />
            </ProfileField>
          </dl>
        </SectionCard>

        <div className="space-y-5">
          <WorkspaceNotice title="Organisation-managed identity" tone="info">
            Your organisation and role cannot be changed from this profile. An authorised administrator controls them.
          </WorkspaceNotice>

          <SectionCard
            title="Access and permissions"
            description="Read-only access granted through your organisation membership."
            variant="console"
            contentClassName="p-5"
          >
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold">{displayValue(organisation.displayName)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Organisation locked</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold">{roles.map((role) => formatEnumLabel(role)).join(", ") || "No assigned role"}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{capabilities.length} effective {capabilities.length === 1 ? "permission" : "permissions"}</p>
                </div>
              </div>
              <details className="rounded-lg border border-border/70 bg-background/55 px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold">View effective permissions</summary>
                <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                  {capabilities.length > 0 ? capabilities.map((capability) => (
                    <li key={capability} className="flex gap-2">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="break-all font-data">{capability}</span>
                    </li>
                  )) : <li>No workspace permissions are assigned.</li>}
                </ul>
              </details>
            </div>
          </SectionCard>

          <SectionCard
            title="Current session"
            description="Activity for the session open in this browser."
            variant="console"
            contentClassName="p-5"
          >
            <dl className="space-y-3 text-sm">
              <div className="flex items-start gap-3">
                <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div><dt className="font-semibold">Last activity</dt><dd className="mt-0.5 text-muted-foreground">{formatDateTime(sessionActivity.lastActivityAt)}</dd></div>
              </div>
              <div className="flex items-start gap-3">
                <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div><dt className="font-semibold">Signed in</dt><dd className="mt-0.5 text-muted-foreground">{formatDateTime(sessionActivity.issuedAt)}</dd></div>
              </div>
            </dl>
          </SectionCard>
        </div>
      </section>

      <SectionCard
        title="Change password"
        description="Confirm your current password before choosing a replacement."
        variant="console"
        contentClassName="p-5"
      >
        {account.passwordChangeAvailable === false ? (
          <WorkspaceNotice title="Password managed by your identity provider">
            This account signs in through {formatEnumLabel(account.authenticationProvider)}. Change its password with that provider.
          </WorkspaceNotice>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,560px)_minmax(280px,1fr)]">
            <form className="space-y-4" onSubmit={changePassword}>
              <div className="space-y-1.5">
                <label htmlFor="current-password" className="text-sm font-semibold">Current password</label>
                <Input id="current-password" name="currentPassword" type="password" autoComplete="current-password" value={form.currentPassword} onChange={updateField} required />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-password" className="text-sm font-semibold">New password</label>
                <Input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={passwordMinLength} maxLength={128} value={form.newPassword} onChange={updateField} required aria-describedby="password-requirements" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="confirm-password" className="text-sm font-semibold">Confirm new password</label>
                <Input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={passwordMinLength} maxLength={128} value={form.confirmPassword} onChange={updateField} required />
              </div>
              <p id="password-requirements" className="text-xs leading-5 text-muted-foreground">
                Use {passwordMinLength}–128 characters. A longer, unique passphrase is recommended.
              </p>
              {error ? <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
              {success ? <p role="status" className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{success}</p> : null}
              <Button type="submit" disabled={submitting}>
                <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                {submitting ? "Changing password…" : "Change password"}
              </Button>
            </form>

            <div className="rounded-xl border border-border/70 bg-secondary/35 p-4">
              <LockKeyhole className="h-5 w-5 text-primary" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-semibold">What happens next</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                ClaimGuard keeps this session open and signs out other sessions for this account. The password itself is never stored or returned.
              </p>
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                Contact your administrator if you cannot confirm your current password.
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </PageFrame>
  );
}
