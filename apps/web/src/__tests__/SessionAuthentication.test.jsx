import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AppRoot from "../AppRoot";
import { organisationSignInUrl } from "../features/auth/LoginPage";
import { apiRequest, setCsrfToken } from "../lib/apiClient";

const safeSession = {
  authenticated: true,
  user: { userId: "user-1", displayName: "Session User" },
  organisation: {
    organisationId: "org-1", displayName: "Alpha Health", canonicalSlug: "alpha-health",
    organisationType: "medical_scheme", deploymentClass: "production",
  },
  operationalTenant: { tenantId: "tenant-alpha", tenantSlug: "alpha-health" },
  roles: ["fraud_analyst"],
  clientCapabilities: ["reports.view_own"],
  expires: { idleAt: "2026-08-01T09:00:00Z", absoluteAt: "2026-08-01T16:00:00Z" },
  deployment: { class: "production", demo: false },
};

beforeEach(() => {
  window.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ = "https";
  window.__CLAIMGUARD_ORGANISATION_HOST__ = "claimguard.example";
  window.history.pushState({}, "", "/");
  setCsrfToken(null);
});

test("unauthenticated users see organisation login and configured URL preview", async () => {
  global.fetch = vi.fn((url) => {
    if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });
  const user = userEvent.setup();
  render(<AppRoot />);
  expect(await screen.findByRole("heading", { name: /Sign in to Sequrin/i })).toBeInTheDocument();
  await user.type(screen.getByLabelText("Organisation"), "Alpha-Health");
  expect(screen.getByText("https://alpha-health.claimguard.example")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /demo identity/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/Demo Accounts/i)).not.toBeInTheDocument();
  expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("demo-accounts"), expect.anything());
});

test("never advertises a localhost sign-in address from a production host", () => {
  expect(organisationSignInUrl("ubuntu", {
    __CLAIMGUARD_ORGANISATION_URL_SCHEME__: "https",
    __CLAIMGUARD_ORGANISATION_HOST__: "localhost:3002",
    location: {
      host: "claimguard-web.azurewebsites.net",
      origin: "https://claimguard-web.azurewebsites.net",
      protocol: "https:",
    },
  })).toBe("https://claimguard-web.azurewebsites.net/o/ubuntu/login");
});

test("successful login uses cookies, stores CSRF only in memory, and sends no authority headers", async () => {
  let authenticated = false;
  global.fetch = vi.fn((url) => {
    const value = String(url);
    if (value.endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => authenticated ? safeSession : { authenticated: false } });
    if (value.endsWith("/api/auth/login")) {
      authenticated = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...safeSession, csrfToken: "csrf-memory-only" }) });
    }
    if (value.includes("/api/detection/")) return Promise.resolve({ ok: false, status: 403, json: async () => ({ available: false, message: "Forbidden" }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });

  const user = userEvent.setup();
  render(<AppRoot />);
  await user.type(await screen.findByLabelText("Organisation"), "alpha-health");
  await user.type(screen.getByLabelText("Username"), "fraud.user");
  await user.type(screen.getByLabelText("Password"), "test-value");
  await user.click(screen.getByRole("button", { name: /^Sign in$/i }));
  expect(await screen.findAllByRole("button", { name: "Open account menu for Session User" })).not.toHaveLength(0);

  const loginCall = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/api/auth/login"));
  expect(loginCall[1].credentials).toBe("same-origin");
  for (const name of ["x-claimguard-user", "x-claimguard-role", "x-claimguard-user-tenant", "x-claimguard-tenant"]) {
    expect(loginCall[1].headers.has(name)).toBe(false);
  }
  expect(window.localStorage.getItem("cg_session")).toBeNull();
  expect(window.localStorage.getItem("csrf-memory-only")).toBeNull();
});

test("wrong credentials display only the generic server error", async () => {
  global.fetch = vi.fn((url) => {
    if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    if (String(url).endsWith("/api/auth/login")) return Promise.resolve({ ok: false, status: 401, json: async () => ({ message: "The organisation or credentials could not be verified." }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });
  const user = userEvent.setup();
  render(<AppRoot />);
  await user.type(await screen.findByLabelText("Organisation"), "unknown");
  await user.type(screen.getByLabelText("Username"), "unknown");
  await user.type(screen.getByLabelText("Password"), "unknown");
  await user.click(screen.getByRole("button", { name: /^Sign in$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The organisation or credentials could not be verified.");
});

test("canonical API client attaches session CSRF to mutations and sends no authority headers", async () => {
  setCsrfToken("csrf-token");
  global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 403, json: async () => ({ code: "FORBIDDEN" }) }));
  const response = await apiRequest("/claims/ingest", { method: "POST" });
  expect(response.status).toBe(403);
  const options = global.fetch.mock.calls[0][1];
  expect(options.headers.get("x-csrf-token")).toBe("csrf-token");
  expect(options.credentials).toBe("same-origin");
  expect(options.headers.has("x-claimguard-role")).toBe(false);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
});
