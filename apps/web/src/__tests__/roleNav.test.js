import { describe, expect, test } from "vitest";

import { canAccessNavItem, NAV_ITEMS } from "../lib/roleNav";

function navItem(key) {
  return NAV_ITEMS.find((item) => item.key === key);
}

describe("capability-driven navigation", () => {
  test("grants ordinary tenant claim access independently of role ordering", () => {
    const identity = {
      role: "scheme_administrator",
      roles: ["scheme_administrator", "investigator"],
      capabilities: ["claims.view_own"],
    };

    expect(canAccessNavItem(identity, navItem("claims"))).toBe(true);
    expect(canAccessNavItem(identity, navItem("investigations"))).toBe(false);
  });

  test("supports any-capability dashboard and administration policies", () => {
    expect(canAccessNavItem(
      { capabilities: ["claims.view_own"] },
      navItem("dashboard"),
    )).toBe(true);

    expect(canAccessNavItem(
      { capabilities: ["tenant_status.view"] },
      navItem("scheme-admin"),
    )).toBe(true);

    expect(canAccessNavItem(
      { capabilities: ["platform_health.view"] },
      navItem("platform-admin"),
    )).toBe(true);
  });

  test("fails closed when required capabilities are absent", () => {
    expect(canAccessNavItem({ capabilities: [] }, navItem("claims"))).toBe(false);
    expect(canAccessNavItem(null, navItem("platform-admin"))).toBe(false);
    expect(canAccessNavItem({ capabilities: [] }, null)).toBe(true);
  });
});
