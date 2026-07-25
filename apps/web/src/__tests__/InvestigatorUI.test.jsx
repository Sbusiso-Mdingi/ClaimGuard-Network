import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  DataTableShell,
  DefinitionList,
  EmptyState,
  WorkspaceNotice,
  formatEnumLabel,
} from "../features/investigator/InvestigatorUI";

describe("InvestigatorUI workspace primitives", () => {
  test("formats enum values for user-facing labels", () => {
    expect(formatEnumLabel("UNDER_INVESTIGATION")).toBe("Under Investigation");
    expect(formatEnumLabel("dead-letter")).toBe("Dead Letter");
    expect(formatEnumLabel(null, "Not available")).toBe("Not available");
  });

  test("renders accessible notice and empty-state messaging", () => {
    render(
      <div>
        <WorkspaceNotice title="Processing unavailable" tone="danger">
          Detection metrics could not be loaded.
        </WorkspaceNotice>
        <EmptyState title="No priority claims" description="No claims meet the current threshold." />
      </div>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Processing unavailable");
    expect(screen.getByText("No priority claims")).toBeInTheDocument();
    expect(screen.getByText("No claims meet the current threshold.")).toBeInTheDocument();
  });

  test("renders definition values and a labelled responsive table", () => {
    render(
      <div>
        <DefinitionList items={[{ label: "Operational tenant", value: "tenant-1", mono: true }]} />
        <DataTableShell ariaLabel="Claims summary">
          <thead><tr><th>Claim</th></tr></thead>
          <tbody><tr><td>C-1</td></tr></tbody>
        </DataTableShell>
      </div>,
    );

    expect(screen.getByText("Operational tenant")).toBeInTheDocument();
    expect(screen.getByText("tenant-1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Claims summary" })).toBeInTheDocument();
  });
});
