import React from "react";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.mjs";
import KeyRound from "lucide-react/dist/esm/icons/key-round.mjs";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import UserRound from "lucide-react/dist/esm/icons/user-round.mjs";
import { Button } from "../../components/ui/button";
import { useRole } from "../../context/RoleContext";
import { useWorkforceIdentity } from "../../context/WorkforceIdentityContext";
import { formatIdentityRoles } from "../../lib/capabilities";
import { PRODUCT_NAME } from "../../lib/productBrand";
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
  const workforce = useWorkforceIdentity();
  const user = session?.user || {};
  const account = session?.account || {};
  const organisation = session?.organisation || {};
  const sessionActivity = session?.sessionActivity || {};
  const roles = session?.roles || [];
  const capabilities = session?.clientCapabilities || [];
  const roleLabel = formatIdentityRoles(identity);

  return (
    <PageFrame
      eyebrow="Account"
      title="Profile"
      description={`Your ${PRODUCT_NAME} work identity, organisation access, and account security.`}
      actions={(
        <Button type="button" variant="outline" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" /> Sign out
        </Button>
      )}
    >
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <SectionCard
          title="Work profile"
          description={`These details come from your organisation-managed ${PRODUCT_NAME} account.`}
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
        title="Account security"
        description="Clerk manages sign-in methods, verified email, MFA, recovery, and active sessions."
        variant="console"
        contentClassName="p-5"
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,560px)_minmax(280px,1fr)]">
          <WorkspaceNotice title="Passwordless workforce account" tone="info">
            Sequrin never accepts or stores your login password. Use Clerk to manage your verified work email, authenticator app, backup codes, and active sessions.
          </WorkspaceNotice>
          <div className="rounded-xl border border-border/70 bg-secondary/35 p-4">
            <LockKeyhole className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 className="mt-3 text-sm font-semibold">Clerk security centre</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Consumer social sign-in is disabled. Sensitive administrative actions require fresh Clerk verification.</p>
            <Button type="button" className="mt-4" onClick={() => workforce.openUserProfile?.()} disabled={!workforce.openUserProfile}>
              <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" /> Manage account security
            </Button>
          </div>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
