import { hierarchy, tree } from "d3-hierarchy";
import type { BranchDto } from "@devdb/shared";

export interface TreeNode { branch: BranchDto; children: TreeNode[] }

// Branches form a strict tree (no merges) — parentBranchId linking. Orphans (parent deleted or
// not yet fetched during an invalidation window) are promoted to roots rather than dropped: a
// transiently-inconsistent tree must render, never crash or hide branches.
export function buildTree(branches: BranchDto[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(branches.map((b) => [b.id, { branch: b, children: [] }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.branch.parentBranchId ? nodes.get(n.branch.parentBranchId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const byCreated = (a: TreeNode, z: TreeNode) => a.branch.createdAt.localeCompare(z.branch.createdAt);
  const sortRec = (n: TreeNode) => { n.children.sort(byCreated); n.children.forEach(sortRec); };
  roots.sort(byCreated);
  roots.forEach(sortRec);
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
  timelineId: "", endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui", context: null, ancestorLsn: null,
  createdAt: "", updatedAt: "",
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
