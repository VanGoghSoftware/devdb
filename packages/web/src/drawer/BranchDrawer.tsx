import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Button, Card, Drawer, Group, Skeleton, Stack, Tabs, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useBranch, useDeleteBranch, useRenameBranch, useResetBranch, useStartEndpoint, useStopEndpoint } from "../api/hooks.js";
import { StatusChip, ContextChip } from "../tree/chips.js";
import { InfoTab } from "./InfoTab.js";

export function maskConnstring(conn: string): string {
  // Mask the password segment of a URL's `//user:PASSWORD@` userinfo for ANY scheme, so a format
  // shift (e.g. `postgres://` vs `postgresql://`) can never fail open and leak the password.
  return conn.replace(/(:\/\/[^:@/]+:)[^@]*@/, "$1•••@");
}

export function BranchDrawer(a: { branchId: string | null; onClose: () => void }) {
  const { data: b } = useBranch(a.branchId);
  const rename = useRenameBranch();
  const del = useDeleteBranch(); const reset = useResetBranch();
  const start = useStartEndpoint(); const stop = useStopEndpoint();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  // Edit state (editing/draft) is component-local, not keyed by branch — without this reset, an
  // in-progress rename on one branch (e.g. a child) survives a drawer re-target to another branch
  // (e.g. the root), which would render the TextInput and let Enter fire `rename.mutate(rootId)`,
  // a forbidden path the daemon 400s. Reset whenever the observed branch identity changes.
  useEffect(() => { setEditing(false); }, [a.branchId]);

  // Manual copy (not Mantine's CopyButton/useClipboard): useClipboard's `copy` calls
  // `navigator.clipboard.writeText(value).then(...)` unconditionally — it requires writeText to
  // return a real thenable. A bare `vi.fn()` test stub (no `.mockResolvedValue`, per this
  // component's own test) returns `undefined`, so `.then` throws synchronously. `await`ing the
  // call instead (mirrors BranchActionsMenu.tsx's existing copyConnstring pattern) tolerates both
  // a real Promise and a bare mock return, since `await undefined` is a no-op.
  const copyConnstring = async (conn: string) => {
    try {
      await navigator.clipboard.writeText(conn);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      notifications.show({ color: "red", message: "Failed to copy connection string" });
    }
  };

  if (!b) {
    return (
      <Drawer opened={a.branchId !== null} onClose={a.onClose} position="right" size="lg" title="Branch">
        <Skeleton height={300} />
      </Drawer>
    );
  }

  const conn = b.connectionString; // plain local binding: narrows `string | null` cleanly through the closures below

  return (
    <Drawer opened={a.branchId !== null} onClose={a.onClose} position="right" size="lg">
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          {editing && b.parentBranchId !== null ? (
            <TextInput
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Root guard belongs here too, not just on the pencil: `editing` state can be
                // true for a root branch in principle (e.g. a future code path re-enters edit
                // mode without going through the pencil's onClick), so the actual mutate call —
                // not just the affordance to open the input — must independently refuse root.
                if (e.key === "Enter" && draft.trim() && b.parentBranchId !== null) {
                  rename.mutate({ id: b.id, name: draft.trim() }, { onSettled: () => setEditing(false) });
                }
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
          ) : (
            <Title order={3} ff="monospace">{b.name}</Title>
          )}
          <ActionIcon variant="subtle" aria-label="rename"
            onClick={() => { setDraft(b.name); setEditing((v) => !v); }}
            disabled={b.parentBranchId === null} // root branch is not renameable (daemon enforces too)
          >✎</ActionIcon>
          <StatusChip branch={b} />
        </Group>

        {b.context && (
          <Group gap="xs">
            <ContextChip context={b.context} />
            {b.context.purpose && <Text size="sm" c="dimmed">“{b.context.purpose}”</Text>}
          </Group>
        )}

        {conn !== null ? (
          <Group gap="xs" wrap="nowrap">
            <Text ff="monospace" size="sm" truncate>{maskConnstring(conn)}</Text>
            <Button size="compact-xs" variant="light" onClick={() => void copyConnstring(conn)}>
              {copied ? "copied" : "copy"}
            </Button>
          </Group>
        ) : (
          <Group gap="xs">
            <Text size="sm" c="dimmed">Endpoint not running — no connection string.</Text>
            <Button size="compact-xs" onClick={() => start.mutate(b.id)} loading={start.isPending}>Start endpoint</Button>
          </Group>
        )}
        {b.endpointStatus === "failed" && b.endpointError && (
          <Alert color="red" title="Endpoint failed">{b.endpointError}</Alert>
        )}

        <Tabs defaultValue="logs">
          <Tabs.List>
            <Tabs.Tab value="logs">Logs</Tabs.Tab>
            <Tabs.Tab value="restore">Restore</Tabs.Tab>
            <Tabs.Tab value="info">Info</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="logs"><Text c="dimmed" pt="sm">Logs tab lands in Task 13.</Text></Tabs.Panel>
          <Tabs.Panel value="restore"><Text c="dimmed" pt="sm">Restore tab lands in Task 13.</Text></Tabs.Panel>
          <Tabs.Panel value="info"><InfoTab branch={b} /></Tabs.Panel>
        </Tabs>

        <Card withBorder mt="md" style={{ borderColor: "var(--mantine-color-red-3)" }}>
          <Title order={5} c="red.7">Danger zone</Title>
          <Group mt="xs">
            {(b.endpointStatus === "running" || b.endpointStatus === "starting") && (
              <Button variant="light" onClick={() => stop.mutate(b.id)} loading={stop.isPending}>Stop endpoint</Button>
            )}
            <Button color="red" variant="light" disabled={b.parentBranchId === null}
              onClick={() => window.confirm(`Reset "${b.name}" to its parent's current state? Divergent data is lost.`) && reset.mutate(b.id)}>
              Reset from parent…
            </Button>
            <Button color="red"
              onClick={() => window.confirm(`Delete branch "${b.name}"? This cannot be undone.`)
                && del.mutate(b.id, { onSuccess: a.onClose })}>
              Delete branch…
            </Button>
          </Group>
        </Card>
      </Stack>
    </Drawer>
  );
}
