import { AppShell, Group, Anchor, Text, ActionIcon, Tooltip, useMantineColorScheme } from "@mantine/core";
import { Link, Outlet } from "react-router";
import { useEvents } from "./api/hooks.js";

// Top-bar shell (spec Decision 4): brand, global nav, theme toggle, SSE connection dot.
export function App() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const eventsStatus = useEvents();
  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="lg">
            <Anchor component={Link} to="/" fw={800} underline="never">
              <Text span c="blue.7" fw={800}>◆ DevDB</Text>
            </Anchor>
            <Anchor component={Link} to="/" size="sm">Dashboard</Anchor>
            <Anchor component={Link} to="/settings" size="sm">Settings</Anchor>
          </Group>
          <Group gap="sm">
            <Tooltip label={eventsStatus === "open" ? "live updates connected" : `live updates: ${eventsStatus}`}>
              <Text span data-testid="conn-dot" c={eventsStatus === "open" ? "green.6" : "yellow.6"}>●</Text>
            </Tooltip>
            <ActionIcon
              variant="subtle"
              aria-label="toggle color scheme"
              onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}
            >
              ◐
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
