import { useEffect, useRef, useState } from "react";
import {
  ActionIcon, Alert, Button, Card, Drawer, Group, Skeleton, Stack, Tabs, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useBranch, useDeleteBranch, useRenameBranch, useResetBranch, useStartEndpoint, useStopEndpoint } from "../api/hooks.js";
import { StatusChip, ContextChip } from "../tree/chips.js";
import { InfoTab } from "./InfoTab.js";
import { LogsTab } from "./LogsTab.js";
import { RestoreTab } from "./RestoreTab.js";

export function maskConnstring(conn: string): string {
  // Mask the password for display in whichever form the string carries it, so neither can fail
  // open and leak the password:
  //  - libpq userinfo `://user:PASSWORD@` for ANY scheme (a `postgres://` vs `postgresql://` shift
  //    must not matter), AND
  //  - JDBC query param `?…&password=PASSWORD…` (JDBC URLs carry creds as params, not userinfo).
  // Order matters (broker P4): mask the JDBC `?…&password=…` query param FIRST. A query password
  // can legally contain `@`, and the userinfo pattern below is not bounded to the authority, so
  // masking userinfo first could match THROUGH that `@` and leave a suffix visible. After the query
  // pass no `@` remains in any query password, so the userinfo pass only masks a real `://user:pass@`.
  return conn
    .replace(/([?&]password=)[^&]*/gi, "$1•••")
    .replace(/(:\/\/[^:@/]+:)[^@]*@/, "$1•••@");
}

export function BranchDrawer(a: { branchId: string | null; onClose: () => void }) {
  const { data: b } = useBranch(a.branchId);
  const rename = useRenameBranch();
  const del = useDeleteBranch(); const reset = useResetBranch();
  const start = useStartEndpoint(); const stop = useStopEndpoint();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<null | "conn" | "jdbc">(null);
  const copyTimer = useRef<number | undefined>(undefined);

  // Edit state (editing/draft) is component-local, not keyed by branch — without this reset, an
  // in-progress rename on one branch (e.g. a child) survives a drawer re-target to another branch
  // (e.g. the root), which would render the TextInput and let Enter fire `rename.mutate(rootId)`,
  // a forbidden path the daemon 400s. Reset whenever the observed branch identity changes.
  // Reset both the rename edit state AND the copy feedback when the drawer re-targets a different
  // branch — otherwise a lingering "copied" from the previous branch (or a still-pending timeout)
  // could flash on the next one (broker P5).
  useEffect(() => { setEditing(false); setCopied(null); }, [a.branchId]);

  // Manual copy (not Mantine's CopyButton/useClipboard): useClipboard's `copy` calls
  // `navigator.clipboard.writeText(value).then(...)` unconditionally — it requires writeText to
  // return a real thenable. A bare `vi.fn()` test stub (no `.mockResolvedValue`, per this
  // component's own test) returns `undefined`, so `.then` throws synchronously. `await`ing the
  // call instead (mirrors BranchActionsMenu.tsx's existing copyConnstring pattern) tolerates both
  // a real Promise and a bare mock return, since `await undefined` is a no-op.
  const copyValue = async (value: string, which: "conn" | "jdbc") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      // One managed timer: clear any pending reset so a fast conn→jdbc copy doesn't let the first
      // timeout wipe the second's "copied" early (broker P5).
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1000);
    } catch {
      notifications.show({ color: "red", message: "Failed to copy" });
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
  const jdbc = b.jdbcUrl; // paired with conn (both non-null iff the endpoint is running with a known port)

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

        {conn !== null && jdbc !== null ? (
          <Stack gap={4}>
            <Group gap="xs" wrap="nowrap">
              <Text ff="monospace" size="sm" truncate>{maskConnstring(conn)}</Text>
              <Button size="compact-xs" variant="light" aria-label="copy connection string"
                onClick={() => void copyValue(conn, "conn")}>
                {copied === "conn" ? "copied" : "copy"}
              </Button>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Text c="dimmed" size="xs">JDBC</Text>
              <Text ff="monospace" size="sm" truncate>{maskConnstring(jdbc)}</Text>
              <Button size="compact-xs" variant="light" aria-label="copy JDBC URL"
                onClick={() => void copyValue(jdbc, "jdbc")}>
                {copied === "jdbc" ? "copied" : "copy"}
              </Button>
            </Group>
          </Stack>
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
          {/* Keyed by branch id so re-targeting the drawer remounts fresh — no stale logs buffer /
              restore selection / leaked EventSource (both tabs hold branch-scoped component-local
              state that a prop-only update, without a key, would otherwise carry across branches). */}
          <Tabs.Panel value="logs">{b && <LogsTab key={b.id} branchId={b.id} />}</Tabs.Panel>
          <Tabs.Panel value="restore">{b && <RestoreTab key={b.id} branch={b} />}</Tabs.Panel>
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
