import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { RailsView } from "../src/tree/RailsView.js";
import type { BranchDto } from "@devdb/shared";

function b(id: string, parent: string | null, over: Partial<BranchDto> = {}): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-s`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
    createdAt: id, updatedAt: id, ...over,
  };
}

describe("RailsView", () => {
  const branches = [
    b("main", null, { endpointStatus: "running", port: 54301 }),
    b("agent-fix", "main", { createdBy: "mcp", context: { agent: "claude", git_branch: "fix-1" } }),
  ];
  it("renders one row per branch with status + context chips and the SVG gutter", () => {
    renderApp(<RailsView branches={branches} onSelect={() => {}} />);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText(/running :54301/)).toBeInTheDocument();
    expect(screen.getByText(/claude · fix-1/)).toBeInTheDocument();
    const svg = document.querySelector("svg[data-testid=rails-gutter]")!;
    expect(svg.querySelectorAll("circle")).toHaveLength(2);   // one dot per branch
    expect(svg.querySelectorAll("path")).toHaveLength(1);     // one fork curve
  });
  it("clicking a row selects the branch", async () => {
    const onSelect = vi.fn();
    renderApp(<RailsView branches={branches} onSelect={onSelect} />);
    (screen.getByText("agent-fix").closest("[data-branch-row]") as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith("agent-fix");
  });
});
