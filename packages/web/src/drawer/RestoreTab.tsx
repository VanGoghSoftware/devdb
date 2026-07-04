import { useState } from "react";
import { Alert, Button, Chip, Group, Radio, Stack, Text, TextInput } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { useRestoreBranch } from "../api/hooks.js";

const PRESETS = [
  { label: "5 m", minutes: 5 }, { label: "30 m", minutes: 30 }, { label: "1 h", minutes: 60 },
  { label: "6 h", minutes: 360 }, { label: "24 h", minutes: 1440 },
] as const;

export function RestoreTab(a: { branch: BranchDto }) {
  const restore = useRestoreBranch();
  const [mode, setMode] = useState<"in_place" | "new_branch">("in_place");
  const [to, setTo] = useState<string>(""); // ISO string, the wire value
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [customLocal, setCustomLocal] = useState("");

  const pickPreset = (p: { label: string; minutes: number }) => {
    setCustomLocal("");
    setSelectedPreset(p.label);
    setTo(new Date(Date.now() - p.minutes * 60_000).toISOString());
  };
  const pickCustom = (v: string) => {
    setCustomLocal(v);
    setSelectedPreset(null);
    setTo(v ? new Date(v).toISOString() : "");
  };

  return (
    <Stack gap="sm" pt="sm">
      <Group gap="xs">
        {PRESETS.map((p) => (
          // Chip is a real checkbox input under the hood (Mantine 9 defaults `type: "checkbox"`) —
          // it exposes onChange(checked), not onClick, so a plain click only fires the handler
          // through onChange; wire the preset pick there, gated on the checked transition.
          <Chip key={p.label} checked={selectedPreset === p.label} onChange={(checked) => checked && pickPreset(p)} variant="light">
            {p.label}
          </Chip>
        ))}
        <TextInput
          type="datetime-local"
          size="xs"
          aria-label="custom timestamp"
          value={customLocal}
          onChange={(e) => pickCustom(e.currentTarget.value)}
        />
      </Group>
      {to && <Text size="xs" c="dimmed">restore point: <Text span ff="monospace">{to}</Text></Text>}

      <Radio.Group value={mode} onChange={(v) => setMode(v as typeof mode)}>
        <Stack gap={6}>
          <Radio value="in_place" label="In place — rewind THIS branch" />
          <Radio value="new_branch" label="As a new branch — keep this one untouched" />
        </Stack>
      </Radio.Group>

      {mode === "in_place" && (
        <Alert color="yellow" variant="light">
          The endpoint will be stopped automatically for the swap, then restarted. Connections drop.
        </Alert>
      )}
      {mode === "new_branch" && (
        <TextInput label="New branch name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      )}

      <Button
        disabled={to === "" || (mode === "new_branch" && name.trim() === "")}
        loading={restore.isPending}
        onClick={() => restore.mutate({
          id: a.branch.id,
          body: mode === "in_place" ? { mode, to } : { mode, to, name: name.trim() },
        })}
      >
        Restore
      </Button>
    </Stack>
  );
}
