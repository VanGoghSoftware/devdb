import { useMemo } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { BranchDto } from "@devdb/shared";
import { buildTree, canvasLayout } from "./model.js";
import { BranchNode } from "./BranchNode.js";

const nodeTypes = { branch: BranchNode };

// Nodes are NOT draggable (spec Decision 3): layout is computed by canvasLayout (d3-hierarchy
// tidy tree); pan/zoom + fit-view only. Same props contract as RailsView minus onBranchFrom —
// canvas nodes route branch actions through the drawer (Task 12), not an inline menu.
export function CanvasView(a: { branches: BranchDto[]; onSelect: (id: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const l = canvasLayout(buildTree(a.branches));
    return {
      nodes: l.nodes.map((n) => ({
        id: n.id, type: "branch" as const, position: { x: n.x, y: n.y },
        data: { branch: n.branch, onSelect: a.onSelect },
      })),
      edges: l.edges.map((e) => ({ ...e, type: "smoothstep" as const })),
    };
  }, [a.branches, a.onSelect]);
  return (
    <div style={{ height: "calc(100vh - 220px)", minHeight: 360 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
