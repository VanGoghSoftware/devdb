import { hierarchy, tree } from "d3-hierarchy";
import type { BranchDto } from "@devdb/shared";

export interface TreeNode { branch: BranchDto; children: TreeNode[] }

// Branches form a strict tree (no merges) — parentBranchId linking. Orphans (parent deleted or
// not yet fetched during an invalidation window) are promoted to roots rather than dropped: a
// transiently-inconsistent tree must render, never crash or hide branches.
//
// Defensive hardening against malformed input (the daemon guarantees acyclic parent pointers, so
// this should never trigger in practice, but a self-parent — parentBranchId === own id — or a
// mutual cycle (A's parent is B, B's parent is A) must not silently vanish branches or hang a
// later tree walk): raw parent→children linking below can legitimately contain back-edges (e.g. a
// self-parent pushes itself into its own `children`). We never trust those raw arrays directly for
// the output — instead we DFS-reassemble from the roots carrying a `visited` set, so a child
// already placed elsewhere in the tree (a back-edge) is skipped rather than re-descended into.
// Any node never reached this way (a pure-cycle component with no path from a real root, e.g. a
// self-parent or an isolated mutual cycle) is then promoted to root and assembled the same way, so
// the invariant "every input branch appears in the output exactly once, and the result is acyclic"
// holds regardless of how malformed the parentBranchId pointers are.
export function buildTree(branches: BranchDto[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(branches.map((b) => [b.id, { branch: b, children: [] }]));
  const childrenOf = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.branch.parentBranchId ? nodes.get(n.branch.parentBranchId) : undefined;
    if (parent) {
      const list = childrenOf.get(parent.branch.id);
      if (list) list.push(n); else childrenOf.set(parent.branch.id, [n]);
    } else roots.push(n);
  }

  const byCreated = (a: TreeNode, z: TreeNode) => a.branch.createdAt.localeCompare(z.branch.createdAt);
  const visited = new Set<string>();
  // Reassemble `children` via DFS, breaking back-edges: a candidate child already visited (placed
  // elsewhere, or an ancestor via a cycle) is skipped instead of re-descended into.
  const assemble = (n: TreeNode): TreeNode => {
    visited.add(n.branch.id);
    const raw = childrenOf.get(n.branch.id) ?? [];
    n.children = raw.filter((c) => !visited.has(c.branch.id)).map(assemble);
    n.children.sort(byCreated);
    return n;
  };
  roots.sort(byCreated);
  roots.forEach(assemble);
  // Anything left unvisited belongs to a cycle unreachable from a real root — promote to root
  // (in createdAt order, for deterministic output) so it still renders instead of vanishing.
  const strandedRoots = [...nodes.values()]
    .filter((n) => !visited.has(n.branch.id))
    .sort(byCreated);
  for (const n of strandedRoots) {
    if (visited.has(n.branch.id)) continue; // already pulled in as part of an earlier stranded node's cycle
    roots.push(assemble(n));
  }
  return roots;
}

export interface RailsLayout {
  rows: Array<{ branch: BranchDto; lane: number; row: number }>;
  verticals: Array<{ lane: number; fromRow: number; toRow: number }>;
  curves: Array<{ fromLane: number; toLane: number; atRow: number }>;
  maxLane: number;
}

// Git-graph gutter layout. DFS preorder = row order; every branch gets its own lane in
// first-visit order (matches the approved mockup). A parent's lane line runs from its own row
// down to its LAST child's row (where the last curve departs); each child gets one curve from
// the parent's lane into its own at its row.
export function railsLayout(roots: TreeNode[]): RailsLayout {
  const rows: RailsLayout["rows"] = [];
  const verticals: RailsLayout["verticals"] = [];
  const curves: RailsLayout["curves"] = [];
  let nextLane = 0;

  const walk = (n: TreeNode): { lane: number; row: number } => {
    const lane = nextLane++;
    const row = rows.length;
    rows.push({ branch: n.branch, lane, row });
    let lastChildRow = row;
    for (const c of n.children) {
      const child = walk(c);
      curves.push({ fromLane: lane, toLane: child.lane, atRow: child.row });
      lastChildRow = child.row;
    }
    if (n.children.length > 0) verticals.push({ lane, fromRow: row, toRow: lastChildRow });
    return { lane, row };
  };
  roots.forEach(walk);
  return { rows, verticals, curves, maxLane: Math.max(0, nextLane - 1) };
}

const NODE_W = 230;
const NODE_H = 96;

// React Flow positions via d3-hierarchy's tidy tree. Multiple roots (orphans) hang off a
// synthetic invisible root that is excluded from the output.
// A real (never-rendered) BranchDto for the synthetic root — full literal instead of a cast,
// per the repo's no-`as any`/`as never` rule (filtered out of the output before anything reads it).
const SYNTHETIC_ROOT: BranchDto = {
  id: "__root__", projectId: "__root__", parentBranchId: null, name: "__root__", slug: "__root__",
  timelineId: "", endpointStatus: "stopped", endpointError: null, port: null, connectionString: null, jdbcUrl: null,
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui", context: null, ancestorLsn: null,
  createdAt: "", updatedAt: "", runningPgVersion: null,
};

export function canvasLayout(roots: TreeNode[]): {
  nodes: Array<{ id: string; x: number; y: number; branch: BranchDto }>;
  edges: Array<{ id: string; source: string; target: string }>;
} {
  const synthetic: TreeNode = { branch: SYNTHETIC_ROOT, children: roots };
  const h = hierarchy<TreeNode>(synthetic, (n) => n.children);
  tree<TreeNode>().nodeSize([NODE_W + 40, NODE_H + 60])(h);
  const nodes: Array<{ id: string; x: number; y: number; branch: BranchDto }> = [];
  const edges: Array<{ id: string; source: string; target: string }> = [];
  for (const d of h.descendants()) {
    if (d.data.branch.id === "__root__") continue;
    nodes.push({ id: d.data.branch.id, x: d.x!, y: d.y! - (NODE_H + 60), branch: d.data.branch });
    for (const c of d.children ?? []) {
      edges.push({ id: `${d.data.branch.id}->${c.data.branch.id}`, source: d.data.branch.id, target: c.data.branch.id });
    }
  }
  return { nodes, edges };
}
