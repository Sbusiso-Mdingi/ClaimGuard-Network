import React, { useEffect, useState } from "react";
import { useRole } from "../../context/RoleContext";
import { PageFrame, SectionCard } from "./InvestigatorUI";
import { DetectionEngineSettings } from "./DetectionEngineSettings";
import { apiJson } from "../../lib/apiClient";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

function PlannedCapability({ title }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1">Planned capability — backend already supports required foundations. No dedicated management API exists yet.</p>
    </div>
  );
}

function UserManagementPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState({ displayName: "", username: "", password: "", roleKey: "claims_analyst" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function loadUsers() {
    setLoading(true);
    try {
      const result = await apiJson("/admin/scheme/users", { cache: "no-store" });
      setUsers(result.users || []);
    } catch (err) {
      setError(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function handleCreateUser(e) {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    try {
      await apiJson("/admin/scheme/users", {
        method: "POST",
        body: newUser,
      });
      setNewUser({ displayName: "", username: "", password: "", roleKey: "claims_analyst" });
      await loadUsers();
    } catch (err) {
      setError(err.message || "Failed to create user");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDisableUser(userId) {
    if (!window.confirm("Are you sure you want to disable this user?")) return;
    setLoading(true);
    setError("");
    try {
      await apiJson(`/admin/scheme/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      await loadUsers();
    } catch (err) {
      setError(err.message || "Failed to disable user");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <form onSubmit={handleCreateUser} className="grid gap-4 rounded-xl border border-border p-4">
        <h4 className="font-semibold">Create New User</h4>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium">Display Name
            <Input value={newUser.displayName} onChange={e => setNewUser(p => ({...p, displayName: e.target.value}))} required />
          </label>
          <label className="block text-sm font-medium">Username
            <Input value={newUser.username} onChange={e => setNewUser(p => ({...p, username: e.target.value}))} required />
          </label>
          <label className="block text-sm font-medium">Password
            <Input type="password" value={newUser.password} onChange={e => setNewUser(p => ({...p, password: e.target.value}))} required minLength={8} />
          </label>
          <label className="block text-sm font-medium">Role
            <select className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newUser.roleKey} onChange={e => setNewUser(p => ({...p, roleKey: e.target.value}))}>
              <option value="claims_analyst">Claims Analyst</option>
              <option value="fraud_analyst">Fraud Analyst</option>
              <option value="investigator">Investigator</option>
              <option value="applications_committee_member">Applications Committee Member</option>
              <option value="scheme_administrator">Scheme Administrator</option>
            </select>
          </label>
        </div>
        <Button type="submit" disabled={isSubmitting}>Create User</Button>
      </form>

      <div className="space-y-3">
        <h4 className="font-semibold">Existing Users</h4>
        {users.length === 0 && !loading && <p className="text-sm text-muted-foreground">No users found.</p>}
        {users.map(user => (
          <div key={user.userId} className="flex items-center justify-between rounded-xl border border-border p-4">
            <div>
              <p className="font-medium">{user.displayName} <span className="text-xs text-muted-foreground">({user.username})</span></p>
              <p className="text-sm text-muted-foreground">Roles: {user.roles.join(", ")} | Status: {user.userStatus}</p>
            </div>
            {user.userStatus === "active" && (
              <Button variant="destructive" size="sm" onClick={() => handleDisableUser(user.userId)} disabled={loading}>Disable</Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SchemeAdminPage() {
  const { identity } = useRole();

  return (
    <PageFrame
      eyebrow="Scheme Administration"
      title={identity.tenantLabel || identity.tenantId}
      description="Tenant-scoped administrative settings for this medical scheme."
    >
      <SectionCard title="Tenant information" description="Identity currently active in this demo session.">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Tenant ID</p>
            <p className="mt-1 font-data text-sm">{identity.tenantId}</p>
          </div>
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Scheme</p>
            <p className="mt-1 text-sm font-semibold">{identity.tenantLabel}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="User Management" description="Manage users and roles within your scheme.">
        <UserManagementPanel />
      </SectionCard>

      <SectionCard title="Administration" description="Other scheme administrator capabilities.">
        <div className="grid gap-3 md:grid-cols-2">
          <PlannedCapability title="Tenant / scheme configuration" />
          <DetectionEngineSettings tenantId={identity.tenantId} />
          <PlannedCapability title="Operational metrics for this tenant" />
        </div>
      </SectionCard>
    </PageFrame>
  );
}
