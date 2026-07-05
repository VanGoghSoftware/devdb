import { Stack, Group, Text, Badge } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { useStatus } from "../api/hooks.js";

export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const Row = (a: { k: string; v: string | null }) => (
  <Group justify="space-between" wrap="nowrap">
    <Text c="dimmed" size="sm">{a.k}</Text>
    <Text ff="monospace" size="sm" truncate>{a.v ?? "—"}</Text>
  </Group>
);

export function InfoTab(a: { branch: BranchDto }) {
  const b = a.branch;
  const { data: status } = useStatus();
  // Restart-to-adopt chip: the running compute was started from a pinned build path (Task 8/10's
  // runningPgVersion), so a build activated AFTER the endpoint started won't be picked up until a
  // restart — surface that gap instead of leaving it silent. No chip while stopped (nothing is
  // "running" to be stale) or once the running version already matches the major's active build.
  const major = b.runningPgVersion?.split(".")[0];
  const activeVersion = major !== undefined ? status?.pgBuilds[major]?.activeVersion : undefined;
  const showAdoptChip = b.runningPgVersion !== null && activeVersion !== undefined && activeVersion !== b.runningPgVersion;
  return (
    <Stack gap={6} pt="sm">
      <Row k="Last record LSN" v={b.lastRecordLsn} />
      <Row k="Logical size" v={formatBytes(b.logicalSizeBytes)} />
      <Row k="Timeline" v={b.timelineId} />
      <Row k="Ancestor LSN" v={b.ancestorLsn} />
      <Row k="Created by" v={b.createdBy} />
      <Row k="Created" v={new Date(b.createdAt).toLocaleString()} />
      <Row k="Slug" v={b.slug} />
      <Group justify="space-between" wrap="nowrap">
        <Text c="dimmed" size="sm">Running version</Text>
        <Group gap="xs" wrap="nowrap">
          <Text ff="monospace" size="sm" truncate>{b.runningPgVersion ?? "—"}</Text>
          {showAdoptChip && <Badge color="yellow" variant="light">restart to adopt {activeVersion}</Badge>}
        </Group>
      </Group>
    </Stack>
  );
}
