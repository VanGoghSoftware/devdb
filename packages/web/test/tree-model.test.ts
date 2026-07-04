import { describe, expect, it } from "vitest";
import type { BranchDto } from "@devdb/shared";
import { buildTree, railsLayout, canvasLayout } from "../src/tree/model.js";

function b(id: string, parent: string | null, createdAt: string): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-slug`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null,
    ancestorLsn: null, createdAt, updatedAt: createdAt,
  };
}

describe("buildTree", () => {
  it("links children under parents, sorted by createdAt", () => {
    const roots = buildTree([b("main", null, "1"), b("b2", "main", "3"), b("b1", "main", "2")]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.branch.id)).toEqual(["b1", "b2"]);
  });
  it("tolerates an orphan (parent id not in the list) by promoting it to a root", () => {
    const roots = buildTree([b("main", null, "1"), b("lost", "gone", "2")]);
    expect(roots.map((r) => r.branch.id).sort()).toEqual(["lost", "main"]);
  });
});

describe("railsLayout", () => {
  // main ── b1 ── b1a, plus main ── b2   (DFS preorder rows: main,b1,b1a,b2)
  const roots = buildTree([b("main", null, "1"), b("b1", "main", "2"), b("b1a", "b1", "3"), b("b2", "main", "4")]);
  const l = railsLayout(roots);
  it("assigns DFS preorder rows and one lane per branch in first-visit order", () => {
    expect(l.rows.map((r) => [r.branch.id, r.lane, r.row])).toEqual([
      ["main", 0, 0], ["b1", 1, 1], ["b1a", 2, 2], ["b2", 3, 3],
    ]);
    expect(l.maxLane).toBe(3);
  });
  it("parent verticals span to their last child's row; one curve per child", () => {
    expect(l.verticals).toContainEqual({ lane: 0, fromRow: 0, toRow: 3 }); // main → b2 is its last child
    expect(l.verticals).toContainEqual({ lane: 1, fromRow: 1, toRow: 2 }); // b1 → b1a
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 1, atRow: 1 });
    expect(l.curves).toContainEqual({ fromLane: 1, toLane: 2, atRow: 2 });
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 3, atRow: 3 });
  });
});

describe("canvasLayout", () => {
  it("positions the root above its children and emits one edge per parent-child pair", () => {
    const roots = buildTree([b("main", null, "1"), b("b1", "main", "2"), b("b2", "main", "3")]);
    const { nodes, edges } = canvasLayout(roots);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["main"]!.y).toBeLessThan(byId["b1"]!.y);
    expect(byId["b1"]!.x).not.toBe(byId["b2"]!.x); // siblings spread horizontally
    expect(edges).toContainEqual(expect.objectContaining({ source: "main", target: "b1" }));
    expect(edges).toHaveLength(2);
  });
});
