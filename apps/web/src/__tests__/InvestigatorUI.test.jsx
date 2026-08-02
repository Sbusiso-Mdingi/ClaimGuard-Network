import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  CopyableIdentifier,
  DataTableShell,
  DefinitionList,
  EmptyState,
  WorkspaceNotice,
  TablePagination,
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
        <DataTableShell ariaLabel="Claims summary" maxHeight="320px">
          <thead><tr><th>Claim</th></tr></thead>
          <tbody><tr><td>C-1</td></tr></tbody>
        </DataTableShell>
      </div>,
    );

    expect(screen.getByText("Operational tenant")).toBeInTheDocument();
    expect(screen.getByText("tenant-1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Claims summary" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Claims summary scroll area" })).toHaveStyle({ maxHeight: "320px" });
  });

  test("shows complete copyable identifiers and paginates bounded histories", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onPageChange = vi.fn();
    const identifier = "33333333-3333-4333-8333-333333333333";

    render(
      <div>
        <CopyableIdentifier value={identifier} label="promotion request ID" />
        <TablePagination page={2} pageCount={4} onPageChange={onPageChange} itemLabel="promotion requests" />
      </div>,
    );

    expect(screen.getByText(identifier)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy promotion request ID" }));
    expect(writeText).toHaveBeenCalledWith(identifier);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
