import React, { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { useInvestigatorData } from "./hooks/useInvestigatorData";
import { useLedgerStatus } from "./hooks/useLedgerStatus";
import { ErrorBoundary } from "./features/investigator/ErrorBoundary";
import { InvestigatorLayout } from "./features/investigator/InvestigatorLayout";
import { RoleProvider, useRole } from "./context/RoleContext";
import { LoginPage } from "./features/auth/LoginPage";
import { SignupPage } from "./features/auth/SignupPage";
import { RequireRoleAccess } from "./features/investigator/RequireRoleAccess";
import {
  defaultRouteForIdentity,
  hasAnyCapability,
} from "./lib/capabilities";

function lazyNamed(importer, exportName) {
  return lazy(async () => {
    const module = await importer();
    return { default: module[exportName] };
  });
}

const DashboardPage = lazyNamed(() => import("./features/investigator/DashboardPage"), "DashboardPage");
const ClaimsExplorerPage = lazyNamed(() => import("./features/investigator/ClaimsExplorerPage"), "ClaimsExplorerPage");
const ClaimDetailsPage = lazyNamed(() => import("./features/investigator/ClaimDetailsPage"), "ClaimDetailsPage");
const NetworkPage = lazyNamed(() => import("./features/investigator/NetworkPage"), "NetworkPage");
const RiskPage = lazyNamed(() => import("./features/investigator/RiskPage"), "RiskPage");
const HistoryPage = lazyNamed(() => import("./features/investigator/HistoryPage"), "HistoryPage");
const InvestigationsPage = lazyNamed(() => import("./features/investigator/InvestigationsPage"), "InvestigationsPage");
const InvestigationWorkspacePage = lazyNamed(() => import("./features/investigator/InvestigationWorkspacePage"), "InvestigationWorkspacePage");
const CommitteeRegistryPage = lazyNamed(() => import("./features/investigator/CommitteeRegistryPage"), "CommitteeRegistryPage");
const SchemeAdminPage = lazyNamed(() => import("./features/investigator/SchemeAdminPage"), "SchemeAdminPage");
const PlatformAdminPage = lazyNamed(() => import("./features/investigator/PlatformAdminPage"), "PlatformAdminPage");
const ProfilePage = lazyNamed(() => import("./features/auth/ProfilePage"), "ProfilePage");

function StatusScreen({ title, description, actionLabel, onAction }) {
  return (
    <div className="mx-auto mt-10 max-w-xl p-4">
      <Card>
        <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
        {actionLabel ? <CardContent><Button onClick={onAction}>{actionLabel}</Button></CardContent> : null}
      </Card>
    </div>
  );
}

function RoleLanding() {
  const { identity } = useRole();
  return <Navigate to={defaultRouteForIdentity(identity)} replace />;
}

function InvestigatorRoutes() {
  const { identity } = useRole();
  const location = useLocation();
  const operationalWorkspaceEnabled = identity.organisationType !== "platform" && hasAnyCapability(identity, [
    "claims.view_own", "reports.view_own", "investigations.view",
  ]);
  const needsSharedOperationalData = location.pathname === "/dashboard"
    || location.pathname.startsWith("/claims")
    || location.pathname === "/network"
    || location.pathname === "/risk"
    || location.pathname === "/history";
  const data = useInvestigatorData({ enabled: operationalWorkspaceEnabled && needsSharedOperationalData });
  const ledger = useLedgerStatus({ enabled: operationalWorkspaceEnabled && needsSharedOperationalData });

  function renderResourceContent(readyElement, { status, error, loadingTitle, loadingDescription, errorTitle, errorDescription }) {
    if (status === "loading") return <StatusScreen title={loadingTitle} description={loadingDescription || "Fetching tenant-scoped operational data..."} />;
    if (status === "error") return <StatusScreen title={errorTitle} description={error || errorDescription || "The requested API resource is unavailable."} actionLabel="Retry" onAction={data.refreshNow} />;
    return readyElement;
  }

  return (
    <Suspense fallback={<StatusScreen title="Opening workspace" description="Loading the authorised ClaimGuard view…" />}>
      <Routes>
        <Route path="/" element={<InvestigatorLayout ledgerStatus={ledger.status} />}>
          <Route index element={<RoleLanding />} />
          <Route path="dashboard" element={<RequireRoleAccess navKey="dashboard">{renderResourceContent(<DashboardPage metrics={data.metrics} graph={data.claimsOverview?.graph || data.graph} status={data.status} lastRefresh={data.lastRefresh} />, { status: data.error ? "error" : data.status, error: data.error, loadingTitle: "Loading Dashboard", errorTitle: "Dashboard Unavailable" })}</RequireRoleAccess>} />
          <Route path="claims" element={<RequireRoleAccess navKey="claims"><ClaimsExplorerPage claims={data.claims} claimsStatus={data.claimsStatus} claimsError={data.claimsError} claimsPagination={data.claimsPagination} onRetryClaims={data.refreshClaims} onPageChange={data.loadClaimsPage} /></RequireRoleAccess>} />
          <Route path="claims/:claimId" element={<RequireRoleAccess navKey="claims"><ClaimDetailsPage report={data.report} graph={data.claimsOverview?.graph || data.graph} risk={data.risk} /></RequireRoleAccess>} />
          <Route path="network" element={<RequireRoleAccess navKey="network">{renderResourceContent(<NetworkPage graph={data.claimsOverview?.graph || data.graph} />, { status: data.claimsOverviewStatus === "error" ? data.graphStatus : data.claimsOverviewStatus, error: data.claimsOverviewError || data.graphError, loadingTitle: "Loading Network Graph", errorTitle: "Network Graph Unavailable" })}</RequireRoleAccess>} />
          <Route path="risk" element={<RequireRoleAccess navKey="risk">{renderResourceContent(<RiskPage risk={data.risk} report={data.report} />, { status: data.riskStatus, error: data.riskError, loadingTitle: "Loading Risk Panel", errorTitle: "Risk Panel Unavailable" })}</RequireRoleAccess>} />
          <Route path="history" element={<RequireRoleAccess navKey="history">{renderResourceContent(<HistoryPage snapshots={data.snapshots} />, { status: data.reportStatus, error: data.reportError, loadingTitle: "Loading Detection History", errorTitle: "Detection History Unavailable" })}</RequireRoleAccess>} />
          <Route path="investigations" element={<RequireRoleAccess navKey="investigations"><InvestigationsPage /></RequireRoleAccess>} />
          <Route path="investigations/:investigationId" element={<RequireRoleAccess navKey="investigations"><InvestigationWorkspacePage /></RequireRoleAccess>} />
          <Route path="committee" element={<RequireRoleAccess navKey="committee"><CommitteeRegistryPage /></RequireRoleAccess>} />
          <Route path="admin/scheme" element={<RequireRoleAccess navKey="scheme-admin"><SchemeAdminPage /></RequireRoleAccess>} />
          <Route path="admin/platform" element={<RequireRoleAccess navKey="platform-admin"><PlatformAdminPage /></RequireRoleAccess>} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="access" element={<StatusScreen title="No workspace access" description="This account is authenticated but has no ClaimGuard workspace capabilities. Ask an administrator to review its organisation membership and roles." />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function AuthenticationBoundary() {
  const { status, authenticated } = useRole();
  if (status === "loading") return <StatusScreen title="Checking your session" description="Verifying the secure server-side session…" />;
  if (!authenticated) return <LoginPage />;
  return <InvestigatorRoutes />;
}

export default function AppRoot() {
  return (
    <ErrorBoundary>
      <RoleProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/auth/signup" element={<SignupPage />} />
            <Route path="*" element={<AuthenticationBoundary />} />
          </Routes>
        </BrowserRouter>
      </RoleProvider>
    </ErrorBoundary>
  );
}
