import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RoleProvider } from "../context/RoleContext";
import { InvestigatorLayout } from "../features/investigator/InvestigatorLayout";
import { createSessionFetch, SESSION_FIXTURES } from "./helpers/sessionFixtures";

function renderLayout(session = SESSION_FIXTURES.analyst) {
  global.fetch = createSessionFetch(session);
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

test("fraud analyst sees operational navigation but not scheme administration", async () => {
  renderLayout();
  expect(await screen.findByRole("link", { name: /^Claims$/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^Investigations$/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("scheme administrator sees read-only operational navigation and administration", async () => {
  renderLayout(SESSION_FIXTURES.schemeAdministrator);

  expect(await screen.findByRole("link", { name: /Scheme Administration/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^Claims$/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^Investigations$/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^Dashboard$/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Shared Fraud Registry/i })).not.toBeInTheDocument();
});

test("applications committee members see only the shared registry workspace", async () => {
  renderLayout(SESSION_FIXTURES.committee);

  expect(await screen.findByRole("link", { name: /Shared Fraud Registry/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("platform administrators see platform governance without tenant operations", async () => {
  renderLayout(SESSION_FIXTURES.platformAdministrator);

  expect(await screen.findByRole("link", { name: /Platform Administration/i })).toBeInTheDocument();
  expect(screen.getByText("Platform operations")).toBeInTheDocument();
  expect(screen.getByText("Organisation:")).toBeInTheDocument();
  expect(screen.queryByText("Scheme workspace")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("provides a keyboard skip link to the main workspace", async () => {
  renderLayout();

  expect(await screen.findByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
  expect(document.querySelector("#main-content")).toBeInTheDocument();
});

test("does not expose development or live-refresh controls", async () => {
  renderLayout();

  await screen.findByRole("link", { name: /^Claims$/i });
  expect(screen.queryByText(/Demo Mode/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Dev-only role switcher/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /live refresh/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Paused$/i)).not.toBeInTheDocument();
});
