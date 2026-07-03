import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgVersionSchema } from "@devdb/shared";
import type { ToolCtx } from "./server.js";
import { toBranchDto, toProjectDto } from "../services/dto.js";
import { text, errorResult, contextLine, nowIso, type ToolResult } from "./format.js";

function renderBranch(dto: ReturnType<typeof toBranchDto>): string {
  const conn = dto.connectionString ? `\n  connection: ${dto.connectionString}` : "\n  (endpoint stopped)";
  const ctx = dto.context ? `\n  fork: ${JSON.stringify(dto.context)}` : "";
  return `  ${dto.name} [${dto.endpointStatus}] created_by=${dto.createdBy}${ctx}${conn}`;
}

function renderProject(dto: ReturnType<typeof toProjectDto>): string {
  return `  ${dto.name} (pg${dto.pgVersion})`;
}

// Wraps every tool handler so a thrown DevdbError/Error becomes an actionable errorResult instead
// of an uncaught rejection — services already phrase remediations into their error messages (see
// projects.ts/branches.ts's *Or404 resolvers and every DevdbError throw site), so this layer's
// only job is translation, not re-phrasing. The SDK's own tools/call dispatcher (mcp.js) already
// has a generic try/catch -> createToolError fallback, but that produces a bare, unphrased
// message with no guarantee of matching our contract — this guard is the one place that
// guarantees OUR error shape for every tool registered through it, regardless of what the SDK's
// own fallback would have produced.
function guard<A>(fn: (a: A) => Promise<ToolResult>): (a: A) => Promise<ToolResult> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  };
}

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  const { deps } = ctx;

  server.registerTool("get_status", {
    description: "Report daemon health, version, and engine process states. Call first to confirm devdb is reachable.",
    inputSchema: {},
  }, guard(async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    const lines = Object.entries(engine).map(([name, p]) => `  ${name}: ${p.state}${p.pid ? ` (pid ${p.pid})` : ""}`);
    return text(
      `[devdb] status as of ${nowIso()}\n` +
      `  healthy: ${healthy}\n${lines.join("\n")}\n` +
      `Next: list_projects to see what's available, or create_project to start one.`,
    );
  }));

  server.registerTool("list_projects", {
    description: "List every project (each with an isolated main branch). Call before create_project to avoid duplicates.",
    inputSchema: {},
  }, guard(async () => {
    const projects = deps.services.projects.list().map(toProjectDto);
    if (projects.length === 0) {
      return text(`[devdb] no projects yet\nNext: create_project to make one.`);
    }
    const lines = projects.map(renderProject);
    return text(`[devdb] ${projects.length} project(s)\n${lines.join("\n")}\nNext: list_branches on a project, or create_project for a new one.`);
  }));

  const CreateProjectShape = { name: z.string(), pgVersion: PgVersionSchema.optional() };
  server.registerTool("create_project", {
    description: "Create a project — an isolated tenant with its own auto-created \"main\" branch. Each project is a separate database universe.",
    inputSchema: CreateProjectShape,
  }, guard(async ({ name, pgVersion }: z.infer<z.ZodObject<typeof CreateProjectShape>>) => {
    const { project, mainBranch } = await deps.services.projects.create({ name, pgVersion });
    const detail = await deps.services.branches.detail(mainBranch);
    const dto = toBranchDto(detail);
    return text(
      `${contextLine({ project: project.name })}\n` +
      `  created pg${project.pgVersion}, main branch:\n${renderBranch(dto)}\n` +
      `Next: create_branch to get an isolated working copy off "main".`,
    );
  }));

  const ListBranchesShape = { project: z.string() };
  server.registerTool("list_branches", {
    description: "List every branch in a project (name, endpoint status, who created it, fork context). Resolves the project by name.",
    inputSchema: ListBranchesShape,
  }, guard(async ({ project }: z.infer<z.ZodObject<typeof ListBranchesShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const details = await deps.services.branches.list(p.id);
    const dtos = details.map(toBranchDto);
    const lines = dtos.map(renderBranch);
    return text(
      `${contextLine({ project: p.name })}\n` +
      `  ${dtos.length} branch(es):\n${lines.join("\n")}\n` +
      `Next: get_branch to fetch a connection string, or create_branch to fork one.`,
    );
  }));

  const GetBranchShape = { project: z.string(), branch: z.string(), ensure_running: z.boolean().default(true) };
  server.registerTool("get_branch", {
    description: "Fetch a branch's status + connection string (the 'switch' move). Starts the endpoint by default.",
    inputSchema: GetBranchShape,
  }, guard(async ({ project, branch, ensure_running }: z.infer<z.ZodObject<typeof GetBranchShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const detail = ensure_running
      ? await deps.services.endpoints.ensureRunning(b.id)
      : await deps.services.branches.detail(b);
    const dto = toBranchDto(detail);
    const next = dto.connectionString
      ? "Next: wire the connection string into your worktree env."
      : "Next: pass ensure_running=true (default) to start it.";
    return text(`${contextLine({ project: p.name, branch: b.name })}\n${renderBranch(dto)}\n${next}`);
  }));
}
