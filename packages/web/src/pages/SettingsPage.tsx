import { Card, Divider, Group, SegmentedControl, Skeleton, Stack, Text, Title, useMantineColorScheme } from "@mantine/core";
import { useState } from "react";
import { useStatus } from "../api/hooks.js";
import { getDefaultTreeView, setDefaultTreeView, type ThemePref, type TreeView } from "../prefs.js";
import { PgBuildsCard } from "../settings/PgBuildsCard.js";

export function SettingsPage() {
  const { data: status } = useStatus();
  const [view, setView] = useState<TreeView>(getDefaultTreeView());
  // Mantine's own colorSchemeManager (main.tsx, keyed to prefs.ts's THEME_STORAGE_KEY) is the
  // single source of truth for the LIVE color scheme — so the theme control is driven DIRECTLY off
  // useMantineColorScheme()'s live `colorScheme`, not a local useState seeded once from
  // getThemePref(). A seeded-once local copy would go stale the moment any other consumer (e.g.
  // the shell's top-bar toggle) changes the scheme while Settings stays mounted. onChange writes
  // through setColorScheme only — it both persists (Mantine's manager writes localStorage itself)
  // AND updates every live consumer immediately; calling prefs.ts's setThemePref alongside it would
  // be a redundant second write to the same key.
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Stack maw={640}>
      <Title order={2}>Settings</Title>

      <Card withBorder>
        <Title order={4}>Daemon</Title>
        {!status ? <Skeleton height={60} /> : (
          <Stack gap={4} mt="xs">
            <Group justify="space-between"><Text c="dimmed">Version</Text><Text ff="monospace">{status.version}</Text></Group>
            <Group justify="space-between"><Text c="dimmed">Endpoint port range</Text><Text ff="monospace">{status.portRange.min} – {status.portRange.max}</Text></Group>
            <Group justify="space-between"><Text c="dimmed">Durability</Text><Text>{status.storage === "none" ? "local" : status.storage}</Text></Group>
          </Stack>
        )}
      </Card>

      <PgBuildsCard />

      <Card withBorder>
        <Title order={4}>Preferences</Title>
        <Stack gap="sm" mt="xs">
          <Group justify="space-between">
            <Text>Default branch view</Text>
            <SegmentedControl
              value={view}
              onChange={(v) => { setView(v as TreeView); setDefaultTreeView(v as TreeView); }}
              data={[{ value: "rails", label: "rails" }, { value: "canvas", label: "canvas" }]}
            />
          </Group>
          <Group justify="space-between">
            <Text>Theme</Text>
            <SegmentedControl
              value={colorScheme}
              onChange={(v) => setColorScheme(v as ThemePref)}
              data={[{ value: "auto", label: "auto" }, { value: "light", label: "light" }, { value: "dark", label: "dark" }]}
            />
          </Group>
        </Stack>
      </Card>

      {/* Design spec §Screens/Settings names both stubs explicitly: "Remote storage, Export
          targets" — two disabled cards, not one. */}
      <Card withBorder opacity={0.65}>
        <Title order={4}>Remote storage</Title>
        <Divider my="xs" />
        <Text c="dimmed" size="sm">S3 / Azure durability — coming in phase 4.</Text>
      </Card>

      <Card withBorder opacity={0.65}>
        <Title order={4}>Export targets</Title>
        <Divider my="xs" />
        <Text c="dimmed" size="sm">Import/export destinations and job history — coming in phase 4.</Text>
      </Card>
    </Stack>
  );
}
