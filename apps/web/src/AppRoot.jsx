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
  const data = useInvestigatorData();

  if (data.status === "loading") {
    return <StatusScreen title="Loading Investigator Workspace" description="Fetching detection report, graph, and risk APIs..." />;
  }

  if (data.status === "error") {
    return (
      <StatusScreen
        title="Unable to Load Investigator Data"
        description={data.error || "The API responses were unavailable."}
        actionLabel="Retry"
        onAction={data.refreshNow}
      />
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <InvestigatorLayout
            mode={data.mode}
            setMode={data.setMode}
            refreshNow={data.refreshNow}
            lastRefresh={data.lastRefresh}
            ledgerStatus={data.metrics.ledgerStatus}
          />
        }
      >
        <Route index element={<DashboardPage metrics={data.metrics} status={data.status} lastRefresh={data.lastRefresh} />} />
        <Route path="claims" element={<ClaimsExplorerPage claims={data.claims} />} />
        <Route path="claims/:claimId" element={<ClaimDetailsPage claims={data.claims} report={data.report} graph={data.graph} risk={data.risk} />} />
        <Route path="network" element={<NetworkPage graph={data.graph} />} />
        <Route path="risk" element={<RiskPage risk={data.risk} report={data.report} />} />
        <Route path="history" element={<HistoryPage snapshots={data.snapshots} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function AppRoot() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <InvestigatorRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
