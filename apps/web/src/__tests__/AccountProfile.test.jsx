import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AppRoot from "../AppRoot";
import { createSessionFetch, SESSION_FIXTURES } from "./helpers/sessionFixtures";

function response(payload, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

beforeEach(() => {
  window.history.pushState({}, "", "/profile");
  global.fetch = createSessionFetch(SESSION_FIXTURES.schemeAdministrator, (requestUrl, options) => {
    if (requestUrl.endsWith("/api/auth/password/change")) {
      return response({ available: true, changedAt: "2026-08-01T08:30:00Z", otherSessionsRevoked: 2 });
    }
    return response({ available: false, message: "Not found." }, 404);
  });
});

test("shows the signed-in work identity and organisation-managed access", async () => {
  render(<AppRoot />);

  expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
  expect(screen.getAllByText("Scheme Administrator").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Bonitas").length).toBeGreaterThan(0);
  expect(screen.getByText("scheme-admin-alpha@example.test")).toBeInTheDocument();
  expect(screen.getAllByText("scheme-admin-alpha", { selector: "dd" }).length).toBe(2);
  expect(screen.getByText(/organisation and role cannot be changed/i)).toBeInTheDocument();
  expect(screen.getByText("users.manage_tenant")).toBeInTheDocument();
  expect(global.fetch.mock.calls.some(([url]) => /\/api\/(?:claims|detection)/.test(String(url)))).toBe(false);
});

test("changes the password with CSRF and reports revoked sessions", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  await user.type(await screen.findByLabelText("Current password"), "current-secret");
  await user.type(screen.getByLabelText("New password"), "new-secret-value");
  await user.type(screen.getByLabelText("Confirm new password"), "new-secret-value");
  await user.click(screen.getByRole("button", { name: "Change password" }));

  expect(await screen.findByText(/2 other sessions were signed out/i)).toBeInTheDocument();
  const changeCall = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/api/auth/password/change"));
  expect(changeCall).toBeTruthy();
  expect(changeCall[1].method).toBe("POST");
  expect(changeCall[1].headers.get("x-csrf-token")).toBe("csrf-session-fixture");
  expect(JSON.parse(changeCall[1].body)).toEqual({
    currentPassword: "current-secret",
    newPassword: "new-secret-value",
  });
  await waitFor(() => expect(screen.getByLabelText("Current password")).toHaveValue(""));
});

test("account menu links to profile and does not include preferences", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  const menuButtons = await screen.findAllByRole("button", { name: /open account menu for scheme administrator/i });
  await user.click(menuButtons.at(-1));
  const menu = screen.getByRole("menu", { name: "Account" });
  expect(menu).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Profile" })).toHaveAttribute("href", "/profile");
  expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.queryByText(/preferences/i)).not.toBeInTheDocument();
});
