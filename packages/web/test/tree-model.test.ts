import { describe, expect, it } from "vitest";
import type { BranchDto } from "@devdb/shared";
import { buildTree, railsLayout, canvasLayout, type TreeNode } from "../src/tree/model.js";

function b(id: string, parent: string | null, createdAt: string): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-slug`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null, jdbcUrl: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null,
    ancestorLsn: null, createdAt, updatedAt: createdAt, runningPgVersion: null,
  };
}

// Flattens a forest (pre-order) — used to assert "every input branch appears exactly once"
// without caring about the exact tree shape.
function flatten(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => { out.push(n.branch.id); n.children.forEach(walk); };
  roots.forEach(walk);
  return out;
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

  // Defensive hardening (Fix 3): the daemon guarantees acyclic parentBranchId pointers, but a
  // self-parent or mutual cycle must not silently drop branches from the tree or hang a walk.
  describe("cycle hardening (malformed input)", () => {
    it("does not drop a self-parent branch (parentBranchId === own id)", () => {
      const input = [b("main", null, "1"), b("selfy", "selfy", "2")];
      const roots = buildTree(input);
      // RED evidence (pre-fix): flatten(roots) was ["main"] — selfy was linked into its own
      // `children` array and, since it has a "known" parent (itself), was never promoted to
      // root either — vanishing from the tree entirely.
      expect(flatten(roots).sort()).toEqual(["main", "selfy"]);
      expect(flatten(roots)).toHaveLength(input.length);
    });

    it("does not drop either branch in a mutual two-node cycle (A's parent is B, B's parent is A)", () => {
      const input = [b("a", "b", "1"), b("b", "a", "2")];
      const roots = buildTree(input);
      expect(flatten(roots).sort()).toEqual(["a", "b"]);
      expect(flatten(roots)).toHaveLength(input.length);
    });

    it("preserves total branch count across buildTree for a mix of normal, orphan, self-parent, and cyclic branches", () => {
      const input = [
        b("main", null, "1"),
        b("child", "main", "2"),
        b("lost", "gone", "3"),
        b("selfy", "selfy", "4"),
        b("a", "b", "5"),
        b("b", "a", "6"),
      ];
      const roots = buildTree(input);
      const flat = flatten(roots);
      expect(flat).toHaveLength(input.length);
      expect(new Set(flat)).toEqual(new Set(input.map((x) => x.id)));
    });

    it("railsLayout and canvasLayout terminate and include every branch for a self-parent input", () => {
      const input = [b("main", null, "1"), b("selfy", "selfy", "2")];
      const roots = buildTree(input);
      const rails = railsLayout(roots);
      expect(rails.rows.map((r) => r.branch.id).sort()).toEqual(["main", "selfy"]);
      const canvas = canvasLayout(roots);
      expect(canvas.nodes.map((n) => n.id).sort()).toEqual(["main", "selfy"]);
    });

    it("railsLayout and canvasLayout terminate and include every branch for a mutual-cycle input", () => {
      const input = [b("main", null, "1"), b("a", "b", "2"), b("b", "a", "3")];
      const roots = buildTree(input);
      const rails = railsLayout(roots);
      expect(rails.rows.map((r) => r.branch.id).sort()).toEqual(["a", "b", "main"]);
      const canvas = canvasLayout(roots);
      expect(canvas.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "main"]);
    });
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
  it("parent verticals span to their last child's row; exactly one curve per child, no extras", () => {
    // main has children [b1, b2] (2 verticals-worth of curves) and b1 has [b1a] — 2 parents
    // have children at all (main, b1), so exactly 2 verticals; 3 branches have a parent
    // (b1, b1a, b2), so exactly 3 curves. Tightened from containEqual (Fix 4): a regression
    // that emits spurious extra verticals/curves must fail this test.
    expect(l.verticals).toHaveLength(2);
    expect(l.curves).toHaveLength(3);
    expect(l.verticals).toContainEqual({ lane: 0, fromRow: 0, toRow: 3 }); // main → b2 is its last child
    expect(l.verticals).toContainEqual({ lane: 1, fromRow: 1, toRow: 2 }); // b1 → b1a
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 1, atRow: 1 });
    expect(l.curves).toContainEqual({ fromLane: 1, toLane: 2, atRow: 2 });
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 3, atRow: 3 });
  });

  it("multi-root: independent roots produce independent lane/curve sets with no cross-root connector", () => {
    // Two wholly separate roots, each with one child. A cross-root connector would show up as an
    // extra vertical/curve entry or as a curve linking lanes across the two components.
    const multi = buildTree([
      b("r1", null, "1"), b("r1-child", "r1", "2"),
      b("r2", null, "3"), b("r2-child", "r2", "4"),
    ]);
    const ml = railsLayout(multi);
    expect(ml.rows.map((r) => [r.branch.id, r.lane, r.row])).toEqual([
      ["r1", 0, 0], ["r1-child", 1, 1], ["r2", 2, 2], ["r2-child", 3, 3],
    ]);
    // One vertical per root (each has exactly one child); one curve per child — no cross-root pair.
    expect(ml.verticals).toHaveLength(2);
    expect(ml.curves).toHaveLength(2);
    expect(ml.verticals).toEqual(
      expect.arrayContaining([
        { lane: 0, fromRow: 0, toRow: 1 },
        { lane: 2, fromRow: 2, toRow: 3 },
      ]),
    );
    expect(ml.curves).toEqual(
      expect.arrayContaining([
        { fromLane: 0, toLane: 1, atRow: 1 },
        { fromLane: 2, toLane: 3, atRow: 3 },
      ]),
    );
    // No curve mixes a lane from one root's component with the other's.
    for (const c of ml.curves) {
      const sameComponent = (c.fromLane === 0 && c.toLane === 1) || (c.fromLane === 2 && c.toLane === 3);
      expect(sameComponent).toBe(true);
    }
  });
});

describe("canvasLayout", () => {
  it("positions the root above its children and emits one edge per parent-child pair", () => {
    const branches = [b("main", null, "1"), b("b1", "main", "2"), b("b2", "main", "3")];
    const roots = buildTree(branches);
    const { nodes, edges } = canvasLayout(roots);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["main"]!.y).toBeLessThan(byId["b1"]!.y);
    expect(byId["b1"]!.x).not.toBe(byId["b2"]!.x); // siblings spread horizontally
    expect(edges).toContainEqual(expect.objectContaining({ source: "main", target: "b1" }));
    expect(edges).toHaveLength(2);
    // Tightened (Fix 4): exact node count/id-set, and the synthetic multi-root anchor must never
    // leak into the output.
    expect(nodes).toHaveLength(branches.length);
    expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(branches.map((x) => x.id)));
    expect(nodes.some((n) => n.id === "__root__")).toBe(false);
  });

  it("multi-root/orphan input emits only real parent→child edges — no synthetic-root edges", () => {
    const branches = [
      b("main", null, "1"), b("b1", "main", "2"),
      b("lost", "gone", "3"), // orphan → promoted to a second root
    ];
    const roots = buildTree(branches);
    const { nodes, edges } = canvasLayout(roots);
    expect(nodes).toHaveLength(branches.length);
    expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(branches.map((x) => x.id)));
    expect(nodes.some((n) => n.id === "__root__")).toBe(false);
    // Exactly one real edge (main → b1); "lost" is a root with no parent, so no edge for it, and
    // no edge should ever reference the synthetic "__root__" anchor.
    expect(edges).toHaveLength(1);
    expect(edges).toEqual([expect.objectContaining({ source: "main", target: "b1" })]);
    expect(edges.some((e) => e.source === "__root__" || e.target === "__root__")).toBe(false);
  });
});
