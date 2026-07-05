import { useState } from "react";
import { Alert, Badge, Box, Button, Card, Group, Loader, Stack, Text, Title, Tooltip } from "@mantine/core";
import type { PgBuildDto } from "@devdb/shared";
import {
  useActivatePgBuild, useCheckPgUpdates, useDeletePgBuild, usePgBuilds, usePullPgBuild, useStatus,
} from "../api/hooks.js";

// One row of the installed-builds list under a major. Downloaded/baked "ready" rows get inline
// Activate/Delete; in-flight rows show a spinner; failed rows show the error + a retry.
function BuildRow(a: { row: PgBuildDto; activeMinor: number | null }) {
  const activate = useActivatePgBuild();
  const del = useDeletePgBuild();
  const pull = usePullPgBuild();
  const { row } = a;

  if (row.status === "downloading" || row.status === "validating") {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm">{row.version ?? `${row.major}.x`} · {row.source} · {row.status}</Text>
      </Group>
    );
  }

  if (row.status === "failed") {
    return (
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" c="dimmed">{row.error ?? "pull failed"}</Text>
        <Button
          size="compact-xs"
          loading={pull.isPending}
          onClick={() => pull.mutate({ major: row.major, tag: row.releaseTag })}
        >
          Retry pull
        </Button>
      </Group>
    );
  }

  // "ready" row: version · source · status, plus Activate (hidden when active) and Delete.
  const isDowngrade = !row.active && a.activeMinor !== null && row.minor !== null && row.minor < a.activeMinor;
  // Fix round 1 (Important, review of a616617): the daemon's assertRemovable (registry.ts) 409s
  // ANY source:"baked" row unconditionally, independent of active/inUse — and a baked build goes
  // active:false/inUse:false (while staying "ready" and listed) the instant a downloaded build
  // for the same major activates (resolveActives). The old `row.active || row.inUse` left that
  // row's Delete enabled, so clicking it always 409s.
  const deleteDisabled = row.active || row.inUse || row.source === "baked";
  // Same precedence order assertRemovable checks in (active, then baked, then in-use), so the
  // tooltip names the reason the daemon would actually give.
  const deleteDisabledReason = row.active
    ? "the active build can't be deleted"
    : row.source === "baked"
      ? "baked builds ship in the image and can't be deleted"
      : "in use by a running endpoint";

  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm">{row.version ?? `${row.major}.x`} · {row.source} · {row.status}</Text>
      <Group gap="xs">
        {!row.active && (
          <Button
            size="compact-xs"
            variant="light"
            loading={activate.isPending}
            onClick={() => {
              if (
                !isDowngrade ||
                window.confirm(
                  `Activating ${row.version} is a downgrade below ${a.activeMinor !== null ? `${row.major}.${a.activeMinor}` : ""}. The neon extension's catalog upgrades forward-only. Continue?`,
                )
              ) {
                activate.mutate({ id: row.id, consented: isDowngrade ? true : undefined });
              }
            }}
          >
            Activate
          </Button>
        )}
        {/* Fix round 2 (P4): a disabled Button doesn't emit the hover/focus events Tooltip relies
            on (Tooltip clones its reference props onto its single child), so wrapping the bare
            disabled Button leaves this tooltip unreachable. Mantine's documented workaround for
            disabled controls: give Tooltip a non-disabled wrapper as its direct child instead —
            the wrapper receives the hover/focus events; the Button inside stays disabled (no
            click-through, since the wrapper has no onClick of its own). */}
        <Tooltip label={deleteDisabledReason} disabled={!deleteDisabled}>
          <Box component="span" data-disabled={deleteDisabled || undefined}>
            <Button
              size="compact-xs"
              color="red"
              variant="light"
              disabled={deleteDisabled}
              loading={del.isPending}
              onClick={() => {
                if (window.confirm(`Delete Postgres build ${row.version}? This cannot be undone.`)) del.mutate(row.id);
              }}
            >
              Delete
            </Button>
          </Box>
        </Tooltip>
      </Group>
    </Group>
  );
}

function MajorSection(a: {
  major: number;
  activeVersion: string | null;
  source: "baked" | "downloaded" | null;
  degradedDowngrade: boolean;
  updateAvailable: string | null;
  builds: PgBuildDto[];
}) {
  const pull = usePullPgBuild();
  const activeRow = a.builds.find((b) => b.active);
  const activeMinor = activeRow?.minor ?? null;

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Title order={5}>PG {a.major}</Title>
          {a.activeVersion && (
            <Badge color={a.source === "downloaded" ? "green" : "gray"}>
              {a.activeVersion} · {a.source}
            </Badge>
          )}
          {a.updateAvailable && (
            <>
              <Badge color="blue" variant="light">update available</Badge>
              <Button
                size="compact-xs"
                loading={pull.isPending}
                onClick={() => pull.mutate({ major: a.major })}
              >
                Pull
              </Button>
            </>
          )}
        </Group>
      </Group>
      {a.degradedDowngrade && (
        <Alert color="orange">
          Running below the last-used minor — re-pull a newer build to clear this.
        </Alert>
      )}
      <Stack gap={4}>
        {a.builds.map((row) => <BuildRow key={row.id} row={row} activeMinor={activeMinor} />)}
      </Stack>
    </Stack>
  );
}

export function PgBuildsCard() {
  const { data: status } = useStatus();
  const { data: builds } = usePgBuilds();
  const check = useCheckPgUpdates();
  // "isNew" per major from the last Check-for-updates resolution — component-local, cleared by
  // nothing (a fresh check overwrites it); status.pgBuilds' own updateAvailable field is a
  // per-major server memory of the SAME thing but only refreshed on an actual check, so we track
  // the just-resolved result locally to render the badge synchronously in the same test tick a
  // status refetch might not have landed yet.
  const [checkResult, setCheckResult] = useState<Record<string, { tag: string; isNew: boolean }>>({});

  if (!status) return null;
  // #8: union the ready majors (status.pgBuilds) with every major that has ANY build row
  // (usePgBuilds) — an in-flight/failed NEW-major pull has a row but no status.pgBuilds entry yet.
  const majors = [...new Set([
    ...Object.keys(status.pgBuilds).map(Number),
    ...(builds ?? []).map((b) => b.major),
  ])].sort((x, y) => x - y);

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Title order={4}>Postgres builds</Title>
        <Button
          size="compact-sm"
          variant="light"
          loading={check.isPending}
          onClick={() => check.mutate(undefined, { onSuccess: (r) => setCheckResult(r) })}
        >
          Check for updates
        </Button>
      </Group>
      <Stack gap="md" mt="xs">
        {majors.map((major) => {
          const majorStatus = status.pgBuilds[String(major)]; // undefined for a major present only via an in-flight build row
          const majorBuilds = (builds ?? []).filter((b) => b.major === major);
          const checked = checkResult[String(major)];
          return (
            <MajorSection
              key={major}
              major={major}
              activeVersion={majorStatus?.activeVersion ?? null}
              source={majorStatus?.source ?? null}
              degradedDowngrade={majorStatus?.degradedDowngrade ?? false}
              updateAvailable={checked?.isNew ? checked.tag : (majorStatus?.updateAvailable ?? null)}
              builds={majorBuilds}
            />
          );
        })}
      </Stack>
    </Card>
  );
}
