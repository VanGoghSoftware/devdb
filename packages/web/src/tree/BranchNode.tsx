import { Handle, Position } from "@xyflow/react";
import { Card, Group, Text } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { StatusChip, ContextChip } from "./chips.js";

// React Flow custom node for CanvasView. Handles are present (React Flow needs them to compute
// edge anchor points) but visually hidden — nodes are not connectable/draggable (see
// CanvasView.tsx), so there is nothing for a user to grab onto them for.
export function BranchNode(a: { data: { branch: BranchDto; onSelect: (id: string) => void } }) {
  const b = a.data.branch;
  return (
    <Card
      withBorder
      padding="xs"
      w={230}
      onClick={() => a.data.onSelect(b.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); a.data.onSelect(b.id); }
      }}
      style={{ cursor: "pointer" }}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <Text ff="monospace" fw={600} size="sm" truncate>{b.name}</Text>
      <Group gap={4} mt={4}>
        <StatusChip branch={b} />
        {b.context && <ContextChip context={b.context} />}
      </Group>
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </Card>
  );
}
