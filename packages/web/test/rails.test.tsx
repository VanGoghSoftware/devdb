import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { RailsView } from "../src/tree/RailsView.js";
import { buildTree, railsLayout } from "../src/tree/model.js";
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

  // Fix 3 (P4): guard the renderer's three independent maps (rows -> circle, curves -> path,
  // verticals -> line) against a dropped/duplicated element by asserting an EXACT count against
  // the layout the model itself computed for a multi-branch fixture (main -> b1 -> b1a,
  // main -> b2), not just "at least" or a count hardcoded to only the two-branch fixture above.
  it("renders exactly one circle/path/line per row/curve/vertical the layout computes", () => {
    const branchingFixture = [
      b("main", null, { endpointStatus: "running", port: 54301, createdAt: "1" }),
      b("b1", "main", { createdAt: "2" }),
      b("b1a", "b1", { createdAt: "3" }),
      b("b2", "main", { createdAt: "4" }),
    ];
    const layout = railsLayout(buildTree(branchingFixture));
    renderApp(<RailsView branches={branchingFixture} onSelect={() => {}} />);
    const svg = document.querySelector("svg[data-testid=rails-gutter]")!;
    const countChildren = (tag: string) => [...svg.children].filter((el) => el.tagName.toLowerCase() === tag).length;
    expect(countChildren("circle")).toBe(layout.rows.length);
    expect(countChildren("path")).toBe(layout.curves.length);
    expect(countChildren("line")).toBe(layout.verticals.length);
    // Pin the fixture's own expected counts too, so a future change to railsLayout's algorithm
    // that happens to keep counts-match-layout true (e.g. a bug that drops a row AND its curve
    // together) doesn't silently pass this test.
    expect(layout.rows.length).toBe(4);
    expect(layout.curves.length).toBe(3);
    expect(layout.verticals.length).toBe(2);
  });

  // Fix 4 (P4): the actions kebab sits inside the row button but its wrapper stops propagation
  // (RailsView.tsx's `onClick={(e) => e.stopPropagation()}` div) specifically so opening the menu
  // doesn't ALSO select/open the row. Guard that wiring directly.
  it("clicking the actions kebab does not also select the row", async () => {
    const onSelect = vi.fn();
    renderApp(<RailsView branches={branches} onSelect={onSelect} />);
    const kebab = await screen.findByRole("button", { name: /actions for main/i });
    kebab.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
