import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { CanvasView } from "../src/tree/CanvasView.js";
import type { BranchDto } from "@devdb/shared";

// React Flow needs real layout measurements (width/height) jsdom lacks. We do not test RF's
// internal pan/zoom/layout — only that the custom BranchNode renders per branch (name + chips),
// matching the CanvasView test in rails.test.tsx's fixture style.
function b(id: string, parent: string | null, over: Partial<BranchDto> = {}): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-s`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null, jdbcUrl: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
    createdAt: id, updatedAt: id, runningPgVersion: null, ...over,
  };
}

describe("CanvasView", () => {
  it("renders a React Flow node per branch with chips", () => {
    renderApp(<CanvasView branches={[b("main", null), b("dev", "main")]} onSelect={() => {}} />);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("clicking a node selects the branch", () => {
    const onSelect = vi.fn();
    renderApp(<CanvasView branches={[b("main", null), b("dev", "main")]} onSelect={onSelect} />);
    screen.getByText("dev").click();
    expect(onSelect).toHaveBeenCalledWith("dev");
  });

  // Fix 4 (P4): BranchNode's Card is click-to-select but was mouse-only — a11y parity with the
  // RailsView row fix (role="button" + tabIndex + Enter/Space onKeyDown). Focus the node and
  // activate it via keyboard only, no .click().
  it("activating a node via Enter on the keyboard selects the branch", async () => {
    const onSelect = vi.fn();
    renderApp(<CanvasView branches={[b("main", null), b("dev", "main")]} onSelect={onSelect} />);
    const node = screen.getByText("dev").closest('[role="button"]') as HTMLElement;
    node.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("dev");
  });

  it("activating a node via Space on the keyboard selects the branch", async () => {
    const onSelect = vi.fn();
    renderApp(<CanvasView branches={[b("main", null), b("dev", "main")]} onSelect={onSelect} />);
    const node = screen.getByText("main").closest('[role="button"]') as HTMLElement;
    node.focus();
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("main");
  });

  it("renders status and context chips on nodes", () => {
    renderApp(
      <CanvasView
        branches={[
          b("main", null, { endpointStatus: "running", port: 54301 }),
          b("agent-fix", "main", { createdBy: "mcp", context: { agent: "claude", git_branch: "fix-1" } }),
        ]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/running :54301/)).toBeInTheDocument();
    expect(screen.getByText(/claude · fix-1/)).toBeInTheDocument();
  });
});
