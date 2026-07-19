import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RoleProvider } from "../context/RoleContext";
import { InvestigatorLayout } from "../features/investigator/InvestigatorLayout";

beforeEach(() => {
  window.localStorage.setItem("claimguard-dev-identity", "analyst-alpha");
});

function renderLayout() {
  return render(
    <RoleProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <InvestigatorLayout
                liveRefreshEnabled={false}
                setLiveRefreshEnabled={() => {}}
                refreshNow={() => {}}
                lastRefresh={null}
                ledgerStatus="Not linked"
              />
            }
          >
            <Route index element={<div>dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </RoleProvider>,
  );
}

test("default demo identity (Claims Analyst) does not see Scheme Administration nav", () => {
  renderLayout();
  expect(screen.queryByRole("link", { name: /Scheme Administration/i })).not.toBeInTheDocument();
});

test("switching the dev role switcher to Scheme Administrator reveals admin nav and hides analyst nav", async () => {
  const user = userEvent.setup();
  renderLayout();

  const [identitySelect] = screen.getAllByRole("combobox", { name: /demo identity/i });
  await user.selectOptions(identitySelect, "scheme-admin-alpha");

  expect(await screen.findByRole("link", { name: /Scheme Administration/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Claims Explorer/i })).not.toBeInTheDocument();
});
