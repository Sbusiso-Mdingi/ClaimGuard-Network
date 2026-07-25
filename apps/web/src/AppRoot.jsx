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
import { RoleProvider, useRole } from "./context/RoleContext";
import { LoginPage } from "./features/auth/LoginPage";
import { SignupPage } from "./features/auth/SignupPage";
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

function hasAnyCapability(identity, capabilities) {
  const granted = new Set(identity?.capabilities || []);
  return capabilities.some((capability) => granted.has(capability));
}

function InvestigatorRoutes() {
  const { identity } = useRole();
  const platformOnly = identity.organisationType === "platform";
  const operationalWorkspaceEnabled = !platformOnly && hasAnyCapability(identity, [
    "claims.view_own",
    "reports.view_own",
    "investigations.view",
  ]);
  const data = useInvestigatorData({ enabled: operationalWorkspaceEnabled });

  function renderResourceContent(readyElement, { status, error, loadingTitle, loadingDescription, errorTitle, errorDescription }) {
    if (status === "loading") {
      return (
        <StatusScreen
          title={loadingTitle}
          description={loadingDescription || "Fetching tenant-scoped operational data..."}
        />
      );
    }

    if (status === "error") {
      return (
        <StatusScreen
          title={errorTitle}
          description={error || errorDescription || "The requested API resource is unavailable."}
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
            platformOnly ? <Navigate to="/admin/platform" replace /> : (
              <RequireRoleAccess navKey="dashboard">
                {renderResourceContent(
                  <DashboardPage metrics={data.metrics} graph={data.graph} status={data.status} lastRefresh={data.lastRefresh} />,
                  {
                    status: data.error ? "error" : data.status,
                    error: data.error,
                    loadingTitle: "Loading Dashboard",
                    errorTitle: "Dashboard Unavailable",
                  },
                )}
              </RequireRoleAccess>
            )
          }
        />
        <Route
          path="claims"
          element={
            <RequireRoleAccess navKey="claims">
              <ClaimsExplorerPage
                claims={data.claims}
                claimsStatus={data.claimsStatus}
                claimsError={data.claimsError}
                claimsPagination={data.claimsPagination}
                onRetryClaims={data.refreshClaims}
                onPageChange={data.loadClaimsPage}
              />
            </RequireRoleAccess>
          }
        />
        <Route
          path="claims/:claimId"
          element={
            <RequireRoleAccess navKey="claims">
              <ClaimDetailsPage report={data.report} graph={data.graph} risk={data.risk} />
            </RequireRoleAccess>
          }
        />
        <Route
          path="network"
          element={
            <RequireRoleAccess navKey="network">
              {renderResourceContent(<NetworkPage graph={data.graph} />, {
                status: data.graphStatus,
                error: data.graphError,
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
              {renderResourceContent(<RiskPage risk={data.risk} report={data.report} />, {
                status: data.riskStatus,
                error: data.riskError,
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
              {renderResourceContent(<HistoryPage snapshots={data.snapshots} />, {
                status: data.reportStatus,
                error: data.reportError,
                loadingTitle: "Loading Detection History",
                errorTitle: "Detection History Unavailable",
              })}
            </RequireRoleAccess>
          }
        />

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
