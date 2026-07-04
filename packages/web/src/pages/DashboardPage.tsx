import { useState } from "react";
import {
  Alert, Badge, Button, Card, Group, Menu, Modal, Select, SimpleGrid, Skeleton, Stack, Text, TextInput, Title,
} from "@mantine/core";
import { Link } from "react-router";
import { SUPPORTED_PG_VERSIONS, DEFAULT_PG_VERSION } from "@devdb/shared";
import { useCreateProject, useDeleteProject, useProjects, useStatus } from "../api/hooks.js";

function EngineStrip() {
  const { data } = useStatus();
  if (!data) return <Skeleton height={28} />;
  return (
    <Stack gap="xs">
      {!data.healthy && (
        <Alert color="red" title="Engine degraded">
          One or more engine components are not running — see the component chips below. Branch
          operations may fail until the engine recovers (it restarts automatically with backoff).
        </Alert>
      )}
      <Group gap="xs">
        {Object.entries(data.engine).map(([name, p]) => (
          <Badge key={name} variant="light" color={p.state === "running" ? "green" : "red"}>
            {name}: {p.state}
          </Badge>
        ))}
        <Badge variant="outline" color="gray">{data.storage === "none" ? "local" : data.storage} storage</Badge>
        <Badge variant="outline" color="gray">v{data.version}</Badge>
      </Group>
    </Stack>
  );
}

function CreateProjectModal(a: { opened: boolean; onClose: () => void }) {
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [pg, setPg] = useState(String(DEFAULT_PG_VERSION));
  return (
    <Modal opened={a.opened} onClose={a.onClose} title="New project">
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Select
          label="PostgreSQL version"
          data={SUPPORTED_PG_VERSIONS.map((v) => ({ value: String(v), label: `PG ${v}` }))}
          value={pg}
          onChange={(v) => v && setPg(v)}
        />
        <Button
          loading={create.isPending}
          disabled={name.trim() === ""}
          onClick={() => create.mutate({ name: name.trim(), pgVersion: Number(pg) }, { onSuccess: a.onClose })}
        >
          Create
        </Button>
      </Stack>
    </Modal>
  );
}

export function DashboardPage() {
  const { data: projects } = useProjects();
  const del = useDeleteProject();
  const [creating, setCreating] = useState(false);
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Projects</Title>
        <Button onClick={() => setCreating(true)}>+ New project</Button>
      </Group>
      <EngineStrip />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {(projects ?? []).map((p) => (
          <Card key={p.id} withBorder component={Link} to={`/projects/${p.id}`} style={{ textDecoration: "none" }}>
            <Group justify="space-between">
              <Text fw={700}>{p.name}</Text>
              <Group gap="xs">
                <Badge variant="light">PG {p.pgVersion}</Badge>
                <Menu withinPortal position="bottom-end">
                  <Menu.Target>
                    <Text span c="dimmed" onClick={(e) => e.preventDefault()} aria-label={`actions for ${p.name}`}>⋯</Text>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      color="red"
                      onClick={(e) => {
                        e.preventDefault();
                        if (window.confirm(`Delete project "${p.name}" and ALL its branches?`)) del.mutate(p.id);
                      }}
                    >
                      Delete project…
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>
            <Text size="sm" c="dimmed">created {new Date(p.createdAt).toLocaleString()}</Text>
          </Card>
        ))}
      </SimpleGrid>
      {projects && projects.length === 0 && (
        <Text c="dimmed">No projects yet — create one, then point an agent at <Text span ff="monospace">claude mcp add --transport http devdb http://localhost:4400/mcp</Text></Text>
      )}
      <CreateProjectModal opened={creating} onClose={() => setCreating(false)} />
    </Stack>
  );
}
