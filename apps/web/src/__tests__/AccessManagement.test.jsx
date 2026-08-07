import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { vi } from "vitest";
import { RoleProvider } from "../context/RoleContext";
import { InvestigatorLayout } from "../features/investigator/InvestigatorLayout";
import AppRoot from "../AppRoot";
import { AccessOverviewPage } from "../features/access/AccessOverviewPage";
import { PermissionCataloguePage } from "../features/access/PermissionCataloguePage";
import { AccessRolesPage } from "../features/access/AccessRolesPage";
import { createSessionFetch, SESSION_FIXTURES } from "./helpers/sessionFixtures";

// ---------------------------------------------------------------------------
// Access session fixture factory (local to this test file)
// ---------------------------------------------------------------------------

function accessSession(caps) {
  return {
    authenticated: true,
    user: { userId: "access-user", displayName: "Access Admin" },
    organisation: {
      organisationId: "org-1",
      displayName: "Test Scheme",
      canonicalSlug: "test",
      organisationType: "medical_scheme",
      deploymentClass: "production",
    },
    operationalTenant: { tenantId: "tenant_1", tenantSlug: "test" },
    roles: ["access_administrator"],
    clientCapabilities: caps,
    account: {
      username: "access-user",
      workContact: "access@example.test",
      userStatus: "active",
      membershipStatus: "active",
      credentialStatus: "active",
      authenticationProvider: "local_password",
      passwordChangeAvailable: true,
      passwordMinLength: 8,
    },
    sessionActivity: { issuedAt: "2026-08-01T08:00:00Z", lastActivityAt: "2026-08-01T08:15:00Z" },
    expires: { idleAt: "2026-08-01T09:00:00Z", absoluteAt: "2026-08-01T16:00:00Z" },
    deployment: { class: "production", demo: false },
  };
}

function serviceSession(caps = []) {
  return {
    ...accessSession(caps),
    organisation: {
      organisationId: "org-svc",
      displayName: "Service Org",
      canonicalSlug: "service",
      organisationType: "service",
      deploymentClass: "production",
    },
  };
}

function platformSession(caps = []) {
  return {
    ...accessSession(caps),
    organisation: {
      organisationId: "org-platform",
      displayName: "ClaimGuard Platform",
      canonicalSlug: "platform",
      organisationType: "platform",
      deploymentClass: "production",
    },
    operationalTenant: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderLayout(session) {
  global.fetch = createSessionFetch(session);
  return render(
    <RoleProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<InvestigatorLayout ledgerStatus="Not linked" />}>
            <Route index element={<div>dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </RoleProvider>,
  );
}

function primaryNav() {
  const complementary = screen.getByRole("complementary", { name: /workspace navigation/i });
  return within(complementary).getByRole("navigation");
}

function renderPage(Page, session, fetchRouteHandler) {
  global.fetch = createSessionFetch(session, fetchRouteHandler);
  return render(
    <RoleProvider>
      <MemoryRouter initialEntries={["/admin/scheme/access"]}>
        <Page />
      </MemoryRouter>
    </RoleProvider>,
  );
}

// ---------------------------------------------------------------------------
// Part 1: Branding tests
// ---------------------------------------------------------------------------

describe("Branding", () => {
  test("login page shows Sequrin product name", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) }),
    );
    render(<AppRoot />);
    await waitFor(() => {
      expect(screen.queryByText(/checking your session/i)).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(/Sequrin/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^ClaimGuard$/i)).not.toBeInTheDocument();
  });

  test("workspace shell shows Sequrin not ClaimGuard", async () => {
    renderLayout(SESSION_FIXTURES.analyst);
    const nav = primaryNav();
    await within(nav).findByRole("link", { name: /^Claims Explorer$/i });
    const complementary = screen.getByRole("complementary", { name: /workspace navigation/i });
    expect(within(complementary).getByText(/^Sequrin$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^ClaimGuard$/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Part 2: Navigation tests
// ---------------------------------------------------------------------------

describe("Access management navigation", () => {
  test("no access nav item without any access.* capability", async () => {
    renderLayout(SESSION_FIXTURES.analyst);
    const nav = primaryNav();
    await within(nav).findByRole("link", { name: /^Claims Explorer$/i });
    expect(within(nav).queryByRole("link", { name: /^Access management$/i })).not.toBeInTheDocument();
  });

  test("schemeAdministrator without access.* caps does not get access nav item", async () => {
    renderLayout(SESSION_FIXTURES.schemeAdministrator);
    const nav = primaryNav();
    await within(nav).findByRole("link", { name: /scheme settings/i });
    expect(within(nav).queryByRole("link", { name: /^Access management$/i })).not.toBeInTheDocument();
  });

  test("access.roles.read capability shows the access management nav item", async () => {
    renderLayout(accessSession(["access.roles.read"]));
    const nav = primaryNav();
    expect(await within(nav).findByRole("link", { name: /^Access management$/i })).toBeInTheDocument();
  });

  test("service actor does not get access management nav item", async () => {
    renderLayout(serviceSession(["access.roles.read", "access.roles.manage"]));
    const nav = primaryNav();
    // Wait for session to load
    await waitFor(() => {
      expect(screen.queryByText(/checking your session/i)).not.toBeInTheDocument();
    });
    // Service actors should have no access nav item
    expect(within(nav).queryByRole("link", { name: /^Access management$/i })).not.toBeInTheDocument();
  });

  test("platform actor does not get scheme access management nav", async () => {
    renderLayout(platformSession(["tenants.manage", "platform_health.view"]));
    const nav = primaryNav();
    await within(nav).findByRole("link", { name: /^Platform Overview$/i });
    expect(within(nav).queryByRole("link", { name: /^Access management$/i })).not.toBeInTheDocument();
  });

  test("access.assignments.manage capability shows access management nav", async () => {
    renderLayout(accessSession(["access.assignments.manage"]));
    const nav = primaryNav();
    expect(await within(nav).findByRole("link", { name: /^Access management$/i })).toBeInTheDocument();
  });

  test("access.audit.read capability shows access management nav", async () => {
    renderLayout(accessSession(["access.audit.read"]));
    const nav = primaryNav();
    expect(await within(nav).findByRole("link", { name: /^Access management$/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Part 3: Read-page tests
// ---------------------------------------------------------------------------

// -- AccessOverviewPage --

describe("AccessOverviewPage", () => {
  test("loading state renders", () => {
    let resolve;
    global.fetch = vi.fn((url) => {
      if (String(url).endsWith("/api/auth/session")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => accessSession(["access.roles.read"]),
        });
      }
      if (String(url).endsWith("/api/auth/csrf")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      }
      return new Promise((res) => { resolve = res; });
    });
    render(
      <RoleProvider>
        <MemoryRouter><AccessOverviewPage /></MemoryRouter>
      </RoleProvider>,
    );
    expect(screen.getByRole("heading", { name: /access overview/i })).toBeInTheDocument();
  });

  test("successful data renders organisation and permissions", async () => {
    const mePayload = {
      organisation: "Test Scheme",
      membershipRef: "MEM-001",
      authorizationVersion: 7,
      effectivePermissions: ["access.roles.read", "access.audit.read"],
      authoritySources: ["Role: access_administrator"],
    };
    renderPage(
      AccessOverviewPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/me")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mePayload });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found" }) });
      },
    );
    expect(await screen.findByText("Test Scheme")).toBeInTheDocument();
    expect(screen.getByText("access.roles.read")).toBeInTheDocument();
  });

  test("empty state renders when no data returned", async () => {
    renderPage(
      AccessOverviewPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/me")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => null });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/no access data/i)).toBeInTheDocument();
  });

  test("403 shows forbidden state", async () => {
    renderPage(
      AccessOverviewPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/me")) {
          return Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "Forbidden" }) });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/you do not have permission to view this section/i)).toBeInTheDocument();
  });

  test("404 shows resource unavailable", async () => {
    renderPage(
      AccessOverviewPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/me")) {
          return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found" }) });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/this resource is not available/i)).toBeInTheDocument();
  });

  test("only calls /v1/access/me endpoint, no mutations", async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => accessSession(["access.roles.read"]) });
      if (String(url).endsWith("/api/auth/csrf")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      if (String(url).endsWith("/api/v1/access/me")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ organisation: "Test", effectivePermissions: [] }) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(<RoleProvider><MemoryRouter><AccessOverviewPage /></MemoryRouter></RoleProvider>);
    await screen.findByText("Test");

    const apiCalls = fetchMock.mock.calls.map(([url, opts]) => ({ url: String(url), method: (opts?.method || "GET").toUpperCase() }));
    const accessCalls = apiCalls.filter(({ url }) => url.includes("/api/v1/access/"));
    expect(accessCalls.every(({ url }) => url.includes("/api/v1/access/me"))).toBe(true);
    expect(accessCalls.every(({ method }) => method === "GET")).toBe(true);
  });
});

// -- PermissionCataloguePage --

describe("PermissionCataloguePage", () => {
  test("loading state renders heading", () => {
    let resolve;
    global.fetch = vi.fn((url) => {
      if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => accessSession(["access.roles.read"]) });
      if (String(url).endsWith("/api/auth/csrf")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      return new Promise((res) => { resolve = res; });
    });
    render(<RoleProvider><MemoryRouter><PermissionCataloguePage /></MemoryRouter></RoleProvider>);
    expect(screen.getByRole("heading", { name: /permission catalogue/i })).toBeInTheDocument();
  });

  test("successful data renders permission keys", async () => {
    const permsPayload = {
      permissions: [
        { key: "access.roles.read", label: "Read roles", category: "access", elevated: false, active: true },
        { key: "access.roles.manage", label: "Manage roles", category: "access", elevated: true, active: true },
      ],
    };
    renderPage(
      PermissionCataloguePage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/permissions")) return Promise.resolve({ ok: true, status: 200, json: async () => permsPayload });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText("access.roles.read")).toBeInTheDocument();
    expect(screen.getByText("access.roles.manage")).toBeInTheDocument();
  });

  test("empty state renders when no permissions", async () => {
    renderPage(
      PermissionCataloguePage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/permissions")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ permissions: [] }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/no permissions found/i)).toBeInTheDocument();
  });

  test("403 shows forbidden state", async () => {
    renderPage(
      PermissionCataloguePage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/permissions")) return Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "Forbidden" }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/you do not have permission to view this section/i)).toBeInTheDocument();
  });

  test("404 shows resource unavailable", async () => {
    renderPage(
      PermissionCataloguePage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/permissions")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found" }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/this resource is not available/i)).toBeInTheDocument();
  });

  test("only calls /v1/access/permissions, no mutations", async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => accessSession(["access.roles.read"]) });
      if (String(url).endsWith("/api/auth/csrf")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      if (String(url).endsWith("/api/v1/access/permissions")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ permissions: [] }) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(<RoleProvider><MemoryRouter><PermissionCataloguePage /></MemoryRouter></RoleProvider>);
    await screen.findByText(/no permissions found/i);

    const accessCalls = fetchMock.mock.calls
      .map(([url, opts]) => ({ url: String(url), method: (opts?.method || "GET").toUpperCase() }))
      .filter(({ url }) => url.includes("/api/v1/access/"));
    expect(accessCalls.every(({ url }) => url.includes("/api/v1/access/permissions"))).toBe(true);
    expect(accessCalls.every(({ method }) => method === "GET")).toBe(true);
  });
});

// -- AccessRolesPage --

describe("AccessRolesPage", () => {
  test("loading state renders heading", () => {
    let resolve;
    global.fetch = vi.fn((url) => {
      if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => accessSession(["access.roles.read"]) });
      if (String(url).endsWith("/api/auth/csrf")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      return new Promise((res) => { resolve = res; });
    });
    render(<RoleProvider><MemoryRouter><AccessRolesPage /></MemoryRouter></RoleProvider>);
    expect(screen.getByText(/^Roles$/i)).toBeInTheDocument();
  });

  test("successful data renders role names", async () => {
    const rolesPayload = {
      roles: [
        { roleId: "r1", name: "scheme_administrator", roleClass: "administrative", state: "active", version: 1, systemRole: true, permissions: [] },
        { roleId: "r2", name: "fraud_analyst", roleClass: "operational", state: "active", version: 1, systemRole: false, permissions: [{ key: "claims.view_own", elevated: false }] },
      ],
    };
    renderPage(
      AccessRolesPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/roles") && !url.includes("/api/v1/access/roles/")) return Promise.resolve({ ok: true, status: 200, json: async () => rolesPayload });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText("scheme_administrator")).toBeInTheDocument();
    expect(screen.getByText("fraud_analyst")).toBeInTheDocument();
  });

  test("empty state renders when no roles", async () => {
    renderPage(
      AccessRolesPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/roles")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ roles: [] }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/no roles found/i)).toBeInTheDocument();
  });

  test("403 shows forbidden state", async () => {
    renderPage(
      AccessRolesPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/roles")) return Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "Forbidden" }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/you do not have permission to view this section/i)).toBeInTheDocument();
  });

  test("404 shows resource unavailable", async () => {
    renderPage(
      AccessRolesPage,
      accessSession(["access.roles.read"]),
      (url) => {
        if (url.endsWith("/api/v1/access/roles")) return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: "Not found" }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/this resource is not available/i)).toBeInTheDocument();
  });

  test("access.roles.manage shows mutation-not-yet-available notice", async () => {
    renderPage(
      AccessRolesPage,
      accessSession(["access.roles.manage"]),
      (url) => {
        if (url.endsWith("/api/v1/access/roles")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ roles: [{ roleId: "r1", name: "test_role", state: "active" }] }) });
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      },
    );
    expect(await screen.findByText(/mutation controls will be available in the next implementation slice/i)).toBeInTheDocument();
  });

  test("only calls /v1/access/roles, no mutations", async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (String(url).endsWith("/api/auth/session")) return Promise.resolve({ ok: true, status: 200, json: async () => accessSession(["access.roles.read"]) });
      if (String(url).endsWith("/api/auth/csrf")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ csrfToken: "test" }) });
      if (String(url).endsWith("/api/v1/access/roles")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ roles: [] }) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(<RoleProvider><MemoryRouter><AccessRolesPage /></MemoryRouter></RoleProvider>);
    await screen.findByText(/no roles found/i);

    const accessCalls = fetchMock.mock.calls
      .map(([url, opts]) => ({ url: String(url), method: (opts?.method || "GET").toUpperCase() }))
      .filter(({ url }) => url.includes("/api/v1/access/"));
    expect(accessCalls.every(({ url }) => url.includes("/api/v1/access/roles"))).toBe(true);
    expect(accessCalls.every(({ method }) => method === "GET")).toBe(true);
  });
});
