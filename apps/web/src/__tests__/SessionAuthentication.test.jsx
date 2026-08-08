import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import AppRoot from "../AppRoot";
import { apiRequest, setCsrfToken } from "../lib/apiClient";

beforeEach(() => {
  window.history.pushState({}, "", "/");
  setCsrfToken(null);
});

test("never renders a local password login when Clerk is unavailable", async () => {
  global.fetch = vi.fn((url) => {
    if (String(url).endsWith("/api/auth/session")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found." }) });
  });

  render(<AppRoot />);

  expect(await screen.findByRole("heading", { name: "Workforce sign-in unavailable" })).toBeInTheDocument();
  expect(screen.getByText(/local passwords are not accepted/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^sign in$/i })).not.toBeInTheDocument();
});

test("canonical API client sends no browser-controlled authority headers", async () => {
  setCsrfToken("csrf-token");
  global.fetch = vi.fn(() => Promise.resolve({
    ok: false,
    status: 403,
    json: async () => ({ code: "FORBIDDEN" }),
  }));

  const response = await apiRequest("/claims/ingest", { method: "POST" });

  expect(response.status).toBe(403);
  const options = global.fetch.mock.calls[0][1];
  expect(options.headers.get("x-csrf-token")).toBe("csrf-token");
  expect(options.credentials).toBe("same-origin");
  for (const name of [
    "x-claimguard-user",
    "x-claimguard-role",
    "x-claimguard-user-tenant",
    "x-claimguard-tenant",
  ]) {
    expect(options.headers.has(name)).toBe(false);
  }
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
});
