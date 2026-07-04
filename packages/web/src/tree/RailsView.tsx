import { Group, Text, UnstyledButton } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { buildTree, railsLayout } from "./model.js";
import { StatusChip, ContextChip } from "./chips.js";
import { BranchActionsMenu } from "./BranchActionsMenu.js";

const ROW_H = 40; const LANE_W = 16; const X0 = 10; const DOT_R = 5;
const LANE_COLORS = ["#4dabf7", "#9775fa", "#63e6be", "#ffa94d", "#f783ac", "#74c0fc", "#b197fc", "#38d9a9"];
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]!;
const x = (lane: number) => X0 + lane * LANE_W;
const y = (row: number) => row * ROW_H + ROW_H / 2;

export function RailsView(a: {
  branches: BranchDto[];
  onSelect: (branchId: string) => void;
  onBranchFrom?: (branchId: string) => void;
}) {
  const layout = railsLayout(buildTree(a.branches));
  const gutterW = X0 + (layout.maxLane + 1) * LANE_W;
  const height = layout.rows.length * ROW_H;
  return (
    <Group align="flex-start" gap={0} wrap="nowrap">
      <svg data-testid="rails-gutter" width={gutterW} height={height} style={{ flex: "none" }}>
        {layout.verticals.map((v, i) => (
          <line key={i} x1={x(v.lane)} y1={y(v.fromRow)} x2={x(v.lane)} y2={y(v.toRow)}
            stroke={laneColor(v.lane)} strokeWidth={2} />
        ))}
        {layout.curves.map((c, i) => (
          <path key={i} fill="none" stroke={laneColor(c.toLane)} strokeWidth={2}
            d={`M ${x(c.fromLane)} ${y(c.atRow) - ROW_H * 0.6} C ${x(c.fromLane)} ${y(c.atRow)}, ${x(c.toLane)} ${y(c.atRow) - ROW_H * 0.4}, ${x(c.toLane)} ${y(c.atRow)}`} />
        ))}
        {layout.rows.map((r) => (
          <circle key={r.branch.id} cx={x(r.lane)} cy={y(r.row)} r={DOT_R} fill={laneColor(r.lane)} />
        ))}
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        {layout.rows.map((r) => (
          <UnstyledButton
            key={r.branch.id}
            data-branch-row
            onClick={() => a.onSelect(r.branch.id)}
            w="100%"
            style={{ height: ROW_H, display: "flex", alignItems: "center" }}
          >
            <Group gap="xs" wrap="nowrap" w="100%">
              <Text ff="monospace" fw={600} size="sm" truncate>{r.branch.name}</Text>
              <StatusChip branch={r.branch} />
              {r.branch.context && <ContextChip context={r.branch.context} />}
              <div style={{ marginLeft: "auto" }} onClick={(e) => e.stopPropagation()}>
                <BranchActionsMenu
                  branch={r.branch}
                  onOpenDrawer={() => a.onSelect(r.branch.id)}
                  onBranchFrom={() => a.onBranchFrom?.(r.branch.id)}
                />
              </div>
            </Group>
          </UnstyledButton>
        ))}
      </div>
    </Group>
  );
}
