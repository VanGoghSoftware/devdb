import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { buildTree, canvasLayout } from "../src/tree/model.js";
import type { BranchDto } from "@devdb/shared";

// Fix 5 (P4): canvas.test.tsx exercises CanvasView against the REAL @xyflow/react (needed for
// realistic node/handle rendering), which means it can only observe what ends up in the DOM — it
// cannot directly assert the actual `nodes`/`edges`/`nodesDraggable`/`nodesConnectable` PROPS
// CanvasView.tsx hands to <ReactFlow>. Mock the module here instead: the stub below renders none
// of React Flow's real machinery, it just captures whatever props it was called with so this test
// can assert on them directly — the component-level contract (not just "something rendered").
let capturedProps: Record<string, unknown> | undefined;
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    capturedProps = props;
    return <div data-testid="rf-stub">{props.children as React.ReactNode}</div>;
  },
  Background: () => null,
  Controls: () => null,
  // BranchNode.tsx (imported transitively via CanvasView -> nodeTypes) also imports Handle/Position
  // from this same module — mocking the whole module means BranchNode gets these too, so it must
  // still receive harmless stand-ins rather than undefined.
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}));

// Imported AFTER vi.mock so CanvasView's own `import { ... } from "@xyflow/react"` resolves to the
// mock above (vi.mock is hoisted, but keeping the import order matching makes the dependency clear).
const { CanvasView } = await import("../src/tree/CanvasView.js");

function b(id: string, parent: string | null, over: Partial<BranchDto> = {}): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-s`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null, jdbcUrl: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
    createdAt: id, updatedAt: id, ...over,
  };
}

describe("CanvasView React Flow prop wiring", () => {
  it("passes nodesDraggable=false and nodesConnectable=false (spec Decision 3: layout-computed, not user-draggable)", () => {
    renderApp(<CanvasView branches={[b("main", null)]} onSelect={() => {}} />);
    expect(screen.getByTestId("rf-stub")).toBeInTheDocument();
    expect(capturedProps?.nodesDraggable).toBe(false);
    expect(capturedProps?.nodesConnectable).toBe(false);
  });

  it("passes nodes/edges matching canvasLayout(buildTree(branches)) exactly (ids + edge count)", () => {
    const branches = [
      b("main", null, { createdAt: "1" }),
      b("b1", "main", { createdAt: "2" }),
      b("b1a", "b1", { createdAt: "3" }),
      b("b2", "main", { createdAt: "4" }),
    ];
    const expected = canvasLayout(buildTree(branches));
    renderApp(<CanvasView branches={branches} onSelect={() => {}} />);

    const nodes = capturedProps?.nodes as Array<{ id: string }>;
    const edges = capturedProps?.edges as Array<{ id: string; source: string; target: string }>;

    expect(nodes.map((n) => n.id).sort()).toEqual(expected.nodes.map((n) => n.id).sort());
    expect(edges).toHaveLength(expected.edges.length);
    expect(
      edges.map((e) => `${e.source}->${e.target}`).sort(),
    ).toEqual(expected.edges.map((e) => `${e.source}->${e.target}`).sort());
  });
});
