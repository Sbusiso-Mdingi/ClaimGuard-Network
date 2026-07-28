import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RoleProvider } from "../context/RoleContext";
import { InvestigatorLayout } from "../features/investigator/InvestigatorLayout";

beforeEach(() => {
  window.localStorage.setItem("claimguard-dev-identity", "analyst-alpha");
});

function renderLayout(identityId = "analyst-alpha") {
  window.localStorage.setItem("claimguard-dev-identity", identityId);
  return render(
    <RoleProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <InvestigatorLayout ledgerStatus="Not linked" />
            }
          >
            <Route index element={<div>dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </RoleProvider>,
  );
}

test("fraud analyst sees operational navigation but not scheme administration", () => {
  renderLayout();
  expect(screen.getByRole("link", { name: /Claims/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Investigations/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("scheme administrator sees read-only operational navigation and administration", () => {
  renderLayout("scheme-admin-alpha");

  expect(screen.getByRole("link", { name: /Scheme Administration/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Claims/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Investigations/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Shared Fraud Registry/i })).not.toBeInTheDocument();
});

test("applications committee members see only the shared registry workspace", () => {
  renderLayout("committee-alpha");

  expect(screen.getByRole("link", { name: /Shared Fraud Registry/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("platform administrators see platform governance without tenant operations", () => {
  renderLayout("platform-admin");

  expect(screen.getByRole("link", { name: /Platform Administration/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("provides a keyboard skip link to the main workspace", () => {
  renderLayout();

  expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
  expect(document.querySelector("#main-content")).toBeInTheDocument();
});

test("does not expose development or live-refresh controls", () => {
  renderLayout();

  expect(screen.queryByText(/Demo Mode/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Dev-only role switcher/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /live refresh/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Paused$/i)).not.toBeInTheDocument();
});
