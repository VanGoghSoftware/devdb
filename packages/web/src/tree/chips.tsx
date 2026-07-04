import { Badge, Tooltip } from "@mantine/core";
import type { BranchContext, BranchDto } from "@devdb/shared";

const STATUS_COLOR: Record<BranchDto["endpointStatus"], string> = {
  running: "green", starting: "yellow", stopping: "yellow", stopped: "gray", failed: "red",
};

export function StatusChip(a: { branch: Pick<BranchDto, "endpointStatus" | "port" | "endpointError"> }) {
  const { endpointStatus: s, port, endpointError } = a.branch;
  const label = s === "running" && port ? `● running :${port}` : s === "failed" ? "✕ failed" : `○ ${s}`;
  const chip = <Badge variant="light" color={STATUS_COLOR[s]} ff="monospace">{label}</Badge>;
  return s === "failed" && endpointError ? <Tooltip label={endpointError} multiline maw={420}>{chip}</Tooltip> : chip;
}

export function ContextChip(a: { context: BranchContext }) {
  const { agent, git_branch, purpose, workdir, client } = a.context;
  const label = [agent ?? client?.name, git_branch].filter(Boolean).join(" · ");
  if (!label) return null;
  const tip = [purpose && `purpose: ${purpose}`, workdir && `workdir: ${workdir}`, client && `client: ${client.name} ${client.version}`]
    .filter(Boolean).join("\n");
  return (
    <Tooltip label={tip || "no further context"} multiline maw={420}>
      <Badge variant="light" color="violet">🤖 {label}</Badge>
    </Tooltip>
  );
}
