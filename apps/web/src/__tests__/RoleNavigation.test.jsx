import React from "react";
import { render, screen, within } from "@testing-library/react";
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

function primaryNav() {
  const workspaceNavigationRegion = screen.getByRole("complementary", { name: /workspace navigation/i });
  return within(workspaceNavigationRegion).getByRole("navigation");
}

test("fraud analyst sees operational navigation but not scheme administration", async () => {
  renderLayout();
  const nav = primaryNav();
  expect(await within(nav).findByRole("link", { name: /^Claims Explorer$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Investigations$/i })).toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /scheme admin(istration)?|scheme settings/i })).not.toBeInTheDocument();
});

test("scheme administrator sees read-only operational navigation and administration", async () => {
  renderLayout(SESSION_FIXTURES.schemeAdministrator);
  const nav = primaryNav();

  expect(await within(nav).findByRole("link", { name: /scheme admin(istration)?|scheme settings/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Claims Explorer$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Investigations$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Overview$/i })).toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /shared fraud registry/i })).not.toBeInTheDocument();
});

test("applications committee members see only the shared registry workspace", async () => {
  renderLayout(SESSION_FIXTURES.committee);
  const nav = primaryNav();

  expect(await within(nav).findByRole("link", { name: /shared fraud registry|fraud registry/i })).toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Claims Explorer$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /scheme admin(istration)?|scheme settings/i })).not.toBeInTheDocument();
});

test("platform administrators see platform governance without tenant operations", async () => {
  renderLayout(SESSION_FIXTURES.platformAdministrator);
  const nav = primaryNav();
  const workspaceNavigationRegion = screen.getByRole("complementary", { name: /workspace navigation/i });
  const mainRegion = screen.getByRole("main");

  expect(await within(nav).findByRole("link", { name: /^Platform Overview$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Schemes & Provisioning$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Claims Integrations$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Releases & Promotions$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Platform Administrators$/i })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: /^Detection Engine$/i })).toBeInTheDocument();
  expect(within(workspaceNavigationRegion).getByText("Platform operations")).toBeInTheDocument();
  expect(within(mainRegion).getByText("Organisation:")).toBeInTheDocument();
  expect(screen.queryByText("Scheme workspace")).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Claims$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Claims Explorer$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /^Investigations$/i })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: /scheme admin(istration)?|scheme settings/i })).not.toBeInTheDocument();
});

test("provides a keyboard skip link to the main workspace", async () => {
  renderLayout();

  expect(await screen.findByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
  expect(document.querySelector("#main-content")).toBeInTheDocument();
});

test("does not expose development or live-refresh controls", async () => {
  renderLayout();
  const nav = primaryNav();

  await within(nav).findByRole("link", { name: /^Claims Explorer$/i });
  expect(screen.queryByText(/Demo Mode/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Dev-only role switcher/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /live refresh/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Paused$/i)).not.toBeInTheDocument();
});
