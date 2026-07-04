import { useEffect, useState } from "react";
import { Button, Group, Modal, SegmentedControl, Select, Skeleton, Stack, Text, TextInput, Title } from "@mantine/core";
import { Link, useParams, useSearchParams } from "react-router";
import type { BranchDto } from "@devdb/shared";
import { useBranches, useCreateBranch } from "../api/hooks.js";
import { RailsView } from "../tree/RailsView.js";
import { getDefaultTreeView, type TreeView } from "../prefs.js";

function NewBranchModal(a: { projectId: string; branches: BranchDto[]; opened: boolean; onClose: () => void; defaultParentId?: string }) {
  const create = useCreateBranch();
  const [name, setName] = useState("");
  const mainId = a.branches.find((b) => b.parentBranchId === null)?.id;
  const [parent, setParent] = useState<string | undefined>(a.defaultParentId ?? mainId);
  // The modal wrapper never unmounts (only Mantine's own <Modal opened> toggles) — so `parent`/
  // `name`'s useState initializers above only ever run once, on first mount. Without this reset,
  // reopening via "Branch from here" (which changes defaultParentId) or reopening "+ New branch"
  // after a manual parent pick both leave stale state behind: Create would silently submit the
  // PREVIOUS session's parent instead of the one implied by how the modal was just opened.
  useEffect(() => {
    if (a.opened) { setParent(a.defaultParentId ?? mainId); setName(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mainId intentionally re-read fresh
    // from the body on each open rather than listed as a dep: it's derived from `a.branches` and
    // we don't want every branch-list refetch to reset an already-open modal's in-progress edit.
  }, [a.opened, a.defaultParentId]);
  return (
    <Modal opened={a.opened} onClose={a.onClose} title="New branch">
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Select
          label="Parent branch"
          data={a.branches.map((b) => ({ value: b.id, label: b.name }))}
          value={parent ?? null}
          onChange={(v) => v && setParent(v)}
        />
        <Button
          loading={create.isPending}
          disabled={name.trim() === "" || !parent}
          onClick={() => create.mutate(
            { projectId: a.projectId, name: name.trim(), parentBranchId: parent },
            { onSuccess: a.onClose },
          )}
        >
          Create
        </Button>
      </Stack>
    </Modal>
  );
}

export function ProjectPage() {
  const { projectId } = useParams() as { projectId: string };
  const { data: branches, error } = useBranches(projectId);
  const [view, setView] = useState<TreeView>(getDefaultTreeView());
  const [params, setParams] = useSearchParams();
  const selected = params.get("branch");
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);

  const select = (id: string | null) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set("branch", id); else next.delete("branch");
      return next;
    });
  };

  // Spec §Error handling: unknown ids get a friendly state pointing home, not a blank page.
  if (error) {
    return (
      <Stack align="flex-start">
        <Title order={3}>Project not found</Title>
        <Text c="dimmed">{error instanceof Error ? error.message : "It may have been deleted."}</Text>
        <Button component={Link} to="/">Back to dashboard</Button>
      </Stack>
    );
  }
  if (!branches) return <Skeleton height={200} />;
  return (
    <Stack data-selected-branch={selected ?? undefined}>
      <Group justify="space-between">
        <Title order={2}>Branches</Title>
        <Group>
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as TreeView)}
            data={[{ value: "rails", label: "⑃ rails" }, { value: "canvas", label: "▦ canvas" }]}
          />
          <Button onClick={() => setCreating({})}>+ New branch</Button>
        </Group>
      </Group>
      {branches.length === 0 && (
        <Text c="dimmed">No branches yet. Point an agent at <Text span ff="monospace">http://localhost:4400/mcp</Text> or create one here.</Text>
      )}
      {view === "rails"
        ? <RailsView branches={branches} onSelect={select} onBranchFrom={(id) => setCreating({ parentId: id })} />
        : <div data-testid="canvas-placeholder"><Text c="dimmed">canvas view lands in Task 11</Text></div>}
      <NewBranchModal
        projectId={projectId}
        branches={branches}
        opened={creating !== null}
        onClose={() => setCreating(null)}
        defaultParentId={creating?.parentId}
      />
      {/* Task 12 mounts <BranchDrawer branchId={selected} onClose={() => select(null)} /> here */}
    </Stack>
  );
}
