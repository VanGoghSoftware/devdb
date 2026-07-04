import { Stack, Group, Text } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";

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
  return (
    <Stack gap={6} pt="sm">
      <Row k="Last record LSN" v={b.lastRecordLsn} />
      <Row k="Logical size" v={formatBytes(b.logicalSizeBytes)} />
      <Row k="Timeline" v={b.timelineId} />
      <Row k="Ancestor LSN" v={b.ancestorLsn} />
      <Row k="Created by" v={b.createdBy} />
      <Row k="Created" v={new Date(b.createdAt).toLocaleString()} />
      <Row k="Slug" v={b.slug} />
    </Stack>
  );
}
