import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AppRoot from "../AppRoot";
import { apiRequest, setCsrfToken, setDemoAuthorityHeaders } from "../lib/apiClient";

const safeSession = {
  authenticated: true,
  user: { userId: "user-1", displayName: "Session User" },
  organisation: {
    organisationId: "org-1", displayName: "Alpha Health", canonicalSlug: "alpha-health",
    organisationType: "medical_scheme", deploymentClass: "demo",
  },
  roles: ["fraud_analyst"],
  clientCapabilities: ["reports.view_own"],
  expires: { idleAt: "2026-07-16T09:00:00Z", absoluteAt: "2026-07-16T16:00:00Z" },
  deployment: { class: "demo", demo: true },
};

beforeEach(() => {
  window.__CLAIMGUARD_AUTHENTICATION_MODE__ = "session";
  window.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ = "https";
  window.__CLAIMGUARD_ORGANISATION_HOST__ = "claimguard.example";
  window.history.pushState({}, "", "/");
  setCsrfToken(null);
  setDemoAuthorityHeaders(null);
});

afterEach(() => {
  window.__CLAIMGUARD_AUTHENTICATION_MODE__ = "demo_headers";
});

test("unauthenticated users see organisation login and configured URL preview", async () => {
  global.fetch = vi.fn((url) => {
    if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });
  const user = userEvent.setup();
  render(<AppRoot />);
  expect(await screen.findByRole("heading", { name: /Sign in to ClaimGuard/i })).toBeInTheDocument();
  await user.type(screen.getByLabelText("Organisation"), "Alpha-Health");
  expect(screen.getByText("https://alpha-health.claimguard.example")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: /demo identity/i })).not.toBeInTheDocument();
});

test("successful login uses cookies, stores CSRF only in memory, and sends no authority headers", async () => {
  let authenticated = false;
  global.fetch = vi.fn((url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => authenticated ? safeSession : { authenticated: false } });
    if (value.endsWith("/api/auth/demo-accounts")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
    if (value.endsWith("/api/auth/login")) {
      authenticated = true;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...safeSession, csrfToken: "csrf-memory-only" }) });
    }
    if (value.includes("/api/detection/") || value.endsWith("/api/simulator/status")) {
      return Promise.resolve({ ok: false, status: 403, json: async () => ({ available: false, message: "Forbidden" }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });
  const user = userEvent.setup();
  render(<AppRoot />);
  await user.type(await screen.findByLabelText("Organisation"), "alpha-health");
  await user.type(screen.getByLabelText("Username"), "fraud.demo");
  await user.type(screen.getByLabelText("Password"), "ephemeral-test-value");
  await user.click(screen.getByRole("button", { name: /^Sign in$/i }));
  expect(await screen.findByText("Session User")).toBeInTheDocument();
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

test("demo accounts panel appears only when the gated endpoint supplies ephemeral credentials", async () => {
  global.fetch = vi.fn((url) => {
    if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    if (String(url).endsWith("/api/auth/demo-accounts")) return Promise.resolve({
      ok: true, status: 200, json: async () => ({
        available: true,
        accounts: [{
          catalogueEntryId: "catalogue-1", organisationSlug: "alpha-health", organisationName: "Alpha Health",
          roleLabel: "Investigator", usernameDisplayValue: "investigator.demo", password: "deployment-only-value",
        }],
      }),
    });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });
  render(<AppRoot />);
  expect(await screen.findByRole("heading", { name: "Demo Accounts" })).toBeInTheDocument();
  expect(screen.getByText(/Alpha Health · Investigator/)).toBeInTheDocument();
  expect(screen.getByText(/investigator.demo \/ deployment-only-value/)).toBeInTheDocument();
});

test("canonical API client attaches session CSRF to mutations and distinguishes 403", async () => {
  setCsrfToken("csrf-token");
  global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 403, json: async () => ({ code: "FORBIDDEN" }) }));
  const response = await apiRequest("/simulator/pause", { method: "POST" });
  expect(response.status).toBe(403);
  const options = global.fetch.mock.calls[0][1];
  expect(options.headers.get("x-csrf-token")).toBe("csrf-token");
  expect(options.credentials).toBe("same-origin");
  expect(options.headers.has("x-claimguard-role")).toBe(false);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
});
