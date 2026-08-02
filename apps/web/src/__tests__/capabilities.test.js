import { describe, expect, test } from "vitest";

import {
  defaultRouteForIdentity,
  formatIdentityRoles,
  hasAnyCapability,
  hasCapability,
  hasEveryCapability,
} from "../lib/capabilities";

describe("capability helpers", () => {
  test("route landing follows effective authority rather than a hard-coded tenant or role", () => {
    expect(defaultRouteForIdentity({ capabilities: ["tenants.manage"] })).toBe("/admin/platform");
    expect(defaultRouteForIdentity({ capabilities: ["platform_releases.view"] })).toBe("/admin/platform");
    expect(defaultRouteForIdentity({ capabilities: ["platform_administrators.manage"] })).toBe("/admin/platform");
    expect(defaultRouteForIdentity({ capabilities: ["users.manage_tenant"] })).toBe("/admin/scheme");
    expect(defaultRouteForIdentity({ capabilities: ["claims.view_own"] })).toBe("/dashboard");
    expect(defaultRouteForIdentity({ capabilities: ["investigations.view"] })).toBe("/investigations");
    expect(defaultRouteForIdentity({ capabilities: ["fraud_registry.search"] })).toBe("/committee");
    expect(defaultRouteForIdentity({ capabilities: ["fraud_registry.view"] })).toBe("/committee");
    expect(defaultRouteForIdentity({ capabilities: [] })).toBe("/access");
  });

  test("multi-role identities are authorised by server-issued capabilities", () => {
    const identity = {
      roles: ["scheme_administrator", "investigator"],
      capabilities: ["claims.view_own", "investigations.view"],
    };

    expect(hasCapability(identity, "claims.view_own")).toBe(true);
    expect(hasEveryCapability(identity, ["claims.view_own", "investigations.view"])).toBe(true);
    expect(hasAnyCapability(identity, ["tenants.manage", "investigations.view"])).toBe(true);
    expect(hasCapability(identity, "tenants.manage")).toBe(false);
    expect(formatIdentityRoles(identity)).toBe("Scheme Administrator · Investigator");
  });

  test("missing or malformed identity data fails closed", () => {
    expect(hasCapability(null, "claims.view_own")).toBe(false);
    expect(hasEveryCapability(null, ["claims.view_own"])).toBe(false);
    expect(hasAnyCapability({ capabilities: "claims.view_own" }, ["claims.view_own"])).toBe(false);
    expect(formatIdentityRoles(null)).toBe("No assigned role");
  });
});
