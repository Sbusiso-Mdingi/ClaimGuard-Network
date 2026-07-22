import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { useInvestigatorData } from "./hooks/useInvestigatorData";
import { ErrorBoundary } from "./features/investigator/ErrorBoundary";
import { InvestigatorLayout } from "./features/investigator/InvestigatorLayout";
import { DashboardPage } from "./features/investigator/DashboardPage";
import { ClaimsExplorerPage } from "./features/investigator/ClaimsExplorerPage";
import { ClaimDetailsPage } from "./features/investigator/ClaimDetailsPage";
import { NetworkPage } from "./features/investigator/NetworkPage";
import { RiskPage } from "./features/investigator/RiskPage";
import { HistoryPage } from "./features/investigator/HistoryPage";

// 1. Added top-level context and page imports
import { RoleProvider, useRole } from "./context/RoleContext";
import { LoginPage } from "./features/auth/LoginPage";
import { InvestigationsPage } from "./features/investigator/InvestigationsPage";
import { InvestigationWorkspacePage } from "./features/investigator/InvestigationWorkspacePage";
import { CommitteeRegistryPage } from "./features/investigator/CommitteeRegistryPage";
import { SchemeAdminPage } from "./features/investigator/SchemeAdminPage";
import { PlatformAdminPage } from "./features/investigator/PlatformAdminPage";
import { RequireRoleAccess } from "./features/investigator/RequireRoleAccess";

function StatusScreen({ title, description, actionLabel, onAction }) {
  return (
    <div className="mx-auto mt-10 max-w-xl p-4">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {actionLabel ? (
          <CardContent>
            <Button onClick={onAction}>{actionLabel}</Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

function InvestigatorRoutes() {
  const { identity } = useRole();
  const platformOnly = identity.organisationType === "platform";
  const data = useInvestigatorData({ enabled: !platformOnly });

  function renderPageContent(readyElement, options = {}) {
    if (data.status === "loading") {
      return (
        <StatusScreen
          title={options.loadingTitle || "Loading Investigator Workspace"}
          description={options.loadingDescription || "Fetching detection report, graph, and risk APIs..."}
        />
      );
    }

    if (data.status === "error") {
      return (
        <StatusScreen
          title={options.errorTitle || "Unable to Load Investigator Data"}
          description={data.error || options.errorDescription || "The API responses were unavailable."}
          actionLabel="Retry"
          onAction={data.refreshNow}
        />
      );
    }

    return readyElement;
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <InvestigatorLayout
            liveRefreshEnabled={data.liveRefreshEnabled}
            setLiveRefreshEnabled={data.setLiveRefreshEnabled}
            refreshNow={data.refreshNow}
            lastRefresh={data.lastRefresh}
            ledgerStatus={data.metrics.ledgerStatus}
            dataSource={data.dataSource}
          />
        }
      >
        <Route
          index
          element={
            platformOnly ? <Navigate to="/admin/platform" replace /> : <RequireRoleAccess navKey="dashboard">
              {renderPageContent(
                <DashboardPage metrics={data.metrics} graph={data.graph} status={data.status} lastRefresh={data.lastRefresh} />,
                {
                  loadingTitle: "Loading Dashboard",
                  errorTitle: "Dashboard Unavailable",
                },
              )}
            </RequireRoleAccess>
          }
        />
        <Route
          path="claims"
          element={
            <RequireRoleAccess navKey="claims">
              {renderPageContent(<ClaimsExplorerPage claims={data.claims} claimsStatus={data.claimsStatus} claimsError={data.claimsError} onRetryClaims={data.refreshNow} />, {
                loadingTitle: "Loading Claims Explorer",
                errorTitle: "Claims Explorer Unavailable",
              })}
            </RequireRoleAccess>
          }
        />
        <Route
          path="claims/:claimId"
          element={
            <RequireRoleAccess navKey="claims">
              {renderPageContent(<ClaimDetailsPage report={data.report} graph={data.graph} risk={data.risk} />, {
                loadingTitle: "Loading Claim Details",
                errorTitle: "Claim Details Unavailable",
              })}
            </RequireRoleAccess>
          }
        />
        <Route
          path="network"
          element={
            <RequireRoleAccess navKey="network">
              {renderPageContent(<NetworkPage graph={data.graph} />, {
                loadingTitle: "Loading Network Graph",
                errorTitle: "Network Graph Unavailable",
              })}
            </RequireRoleAccess>
          }
        />
        <Route
          path="risk"
          element={
            <RequireRoleAccess navKey="risk">
              {renderPageContent(<RiskPage risk={data.risk} report={data.report} />, {
                loadingTitle: "Loading Risk Panel",
                errorTitle: "Risk Panel Unavailable",
              })}
            </RequireRoleAccess>
          }
        />
        <Route
          path="history"
          element={
            <RequireRoleAccess navKey="history">
              {renderPageContent(<HistoryPage snapshots={data.snapshots} />, {
                loadingTitle: "Loading Detection History",
                errorTitle: "Detection History Unavailable",
              })}
            </RequireRoleAccess>
          }
        />

        {/* 2. Added new role-protected workflow and administration routing paths here */}
        <Route path="investigations" element={<RequireRoleAccess navKey="investigations"><InvestigationsPage /></RequireRoleAccess>} />
        <Route path="investigations/:investigationId" element={<RequireRoleAccess navKey="investigations"><InvestigationWorkspacePage /></RequireRoleAccess>} />
        <Route path="committee" element={<RequireRoleAccess navKey="committee"><CommitteeRegistryPage /></RequireRoleAccess>} />
        <Route path="admin/scheme" element={<RequireRoleAccess navKey="scheme-admin"><SchemeAdminPage /></RequireRoleAccess>} />
        <Route path="admin/platform" element={<RequireRoleAccess navKey="platform-admin"><PlatformAdminPage /></RequireRoleAccess>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function AuthenticationBoundary() {
  const { status, authenticated, mode } = useRole();
  if (status === "loading") {
    return <StatusScreen title="Checking your session" description="Verifying the secure server-side session…" />;
  }
  if (!authenticated && mode === "session") return <LoginPage />;
  return <InvestigatorRoutes />;
}

export default function AppRoot() {
  return (
    <ErrorBoundary>
      {/* 3. Wrapped the router with the RoleProvider state element wrapper */}
      <RoleProvider>
        <BrowserRouter>
          <AuthenticationBoundary />
        </BrowserRouter>
      </RoleProvider>
    </ErrorBoundary>
  );
}
