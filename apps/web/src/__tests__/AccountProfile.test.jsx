import React from "react";
import { render, screen } from "@testing-library/react";
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
  global.fetch = createSessionFetch(
    SESSION_FIXTURES.schemeAdministrator,
    () => response({ available: false, message: "Not found." }, 404),
  );
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

test("delegates account security to Clerk and exposes no password form", async () => {
  render(<AppRoot />);

  expect(await screen.findByText("Passwordless workforce account")).toBeInTheDocument();
  expect(screen.getByText(/Clerk manages sign-in methods/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/auth/password"))).toBe(false);
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
