import React from "react";
import { render, screen } from "@testing-library/react";
import { RoleProvider } from "../context/RoleContext";
import { RequireRoleAccess } from "../features/investigator/RequireRoleAccess";

test("blocks a navKey the active demo identity does not have access to", () => {
  render(
    <RoleProvider>
      <RequireRoleAccess navKey="platform-admin">
        <div>platform content</div>
      </RequireRoleAccess>
    </RoleProvider>,
  );

  expect(screen.getByRole("heading", { name: "Access unavailable" })).toBeInTheDocument();
  expect(screen.queryByText("platform content")).not.toBeInTheDocument();
});
