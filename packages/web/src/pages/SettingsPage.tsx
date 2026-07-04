import { Card, Divider, Group, SegmentedControl, Skeleton, Stack, Text, Title, useMantineColorScheme } from "@mantine/core";
import { useState } from "react";
import { useStatus } from "../api/hooks.js";
import { getDefaultTreeView, getThemePref, setDefaultTreeView, setThemePref, type ThemePref, type TreeView } from "../prefs.js";

export function SettingsPage() {
  const { data: status } = useStatus();
  const [view, setView] = useState<TreeView>(getDefaultTreeView());
  const [themePref, setTheme] = useState<ThemePref>(getThemePref());
  // Mantine's own colorSchemeManager (main.tsx, keyed to "devdb.theme") is the single source of
  // truth for the LIVE color scheme — so the theme control below writes through setColorScheme,
  // which both persists AND updates the running app immediately. setThemePref alone would only
  // persist to prefs.ts's copy of the same key; Mantine's context wouldn't observe that write
  // until the next full reload, leaving the live scheme stale. getThemePref() is used only to
  // seed this control's initial display value.
  const { setColorScheme } = useMantineColorScheme();
  return (
    <Stack maw={640}>
      <Title order={2}>Settings</Title>

      <Card withBorder>
        <Title order={4}>Daemon</Title>
        {!status ? <Skeleton height={60} /> : (
          <Stack gap={4} mt="xs">
            <Group justify="space-between"><Text c="dimmed">Version</Text><Text ff="monospace">{status.version}</Text></Group>
            <Group justify="space-between"><Text c="dimmed">Endpoint port range</Text><Text ff="monospace">{status.portRange.min} – {status.portRange.max}</Text></Group>
            <Group justify="space-between"><Text c="dimmed">Durability</Text><Text>local ({status.storage})</Text></Group>
          </Stack>
        )}
      </Card>

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
              value={themePref}
              onChange={(v) => { setTheme(v as ThemePref); setThemePref(v as ThemePref); setColorScheme(v as ThemePref); }}
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
