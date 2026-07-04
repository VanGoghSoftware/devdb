import { Menu, ActionIcon } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { BranchDto } from "@devdb/shared";
import { useDeleteBranch, useResetBranch, useStartEndpoint, useStopEndpoint } from "../api/hooks.js";

export function BranchActionsMenu(a: { branch: BranchDto; onOpenDrawer: () => void; onBranchFrom: () => void }) {
  const start = useStartEndpoint(); const stop = useStopEndpoint();
  const del = useDeleteBranch(); const reset = useResetBranch();
  const b = a.branch;
  const copyConnstring = async () => {
    if (!b.connectionString) {
      notifications.show({ color: "yellow", message: "No connection string — endpoint is not running. Start it first." });
      return;
    }
    if (!navigator.clipboard) {
      notifications.show({ color: "red", message: "Clipboard is unavailable in this browser" });
      return;
    }
    try {
      await navigator.clipboard.writeText(b.connectionString);
      notifications.show({ color: "green", message: "Connection string copied" });
    } catch {
      notifications.show({ color: "red", message: "Failed to copy connection string" });
    }
  };
  return (
    <Menu withinPortal position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label={`actions for ${b.name}`}>⋯</ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={a.onOpenDrawer}>Open panel</Menu.Item>
        <Menu.Item onClick={a.onBranchFrom}>Branch from here…</Menu.Item>
        <Menu.Item onClick={copyConnstring}>Copy connection string</Menu.Item>
        {b.endpointStatus === "running" || b.endpointStatus === "starting"
          ? <Menu.Item onClick={() => stop.mutate(b.id)}>Stop endpoint</Menu.Item>
          : <Menu.Item onClick={() => start.mutate(b.id)}>Start endpoint</Menu.Item>}
        <Menu.Divider />
        <Menu.Item color="red" disabled={b.parentBranchId === null}
          onClick={() => window.confirm(`Reset "${b.name}" to its parent's current state? All divergent data is lost.`) && reset.mutate(b.id)}>
          Reset from parent…
        </Menu.Item>
        <Menu.Item color="red"
          onClick={() => window.confirm(`Delete branch "${b.name}"? This cannot be undone.`) && del.mutate(b.id)}>
          Delete…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
