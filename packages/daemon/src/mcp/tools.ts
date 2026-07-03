import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgVersionSchema } from "@devdb/shared";
import { PACKAGE_VERSION } from "../http/api.js";
import type { ToolCtx } from "./server.js";
import { DevdbError } from "../services/errors.js";
import { toBranchDto, toProjectDto } from "../services/dto.js";
import { text, errorResult, contextLine, nowIso, type ToolResult } from "./format.js";

type BranchDto = ReturnType<typeof toBranchDto>;

// `depth` controls indentation (2 spaces per ancestor level, root branches at depth 0) and
// `parentName` (set for every non-root branch) renders an explicit "(from <parent>)" label right
// next to the name — Fix 4 below needs BOTH signals legible in the same line so an agent doesn't
// have to count leading whitespace to know whose fork a branch is: the label names the parent
// outright, and the indentation still visually nests deeper generations (a fork-of-a-fork) under
// their immediate parent, one level per hop.
function renderBranch(dto: BranchDto, depth: number, parentName: string | null): string {
  const indent = "  ".repeat(depth + 1);
  const fork = parentName ? ` (from "${parentName}")` : "";
  const conn = dto.connectionString ? `\n${indent}  connection: ${dto.connectionString}` : "\n" + indent + "  (endpoint stopped)";
  const ctx = dto.context ? `\n${indent}  fork: ${JSON.stringify(dto.context)}` : "";
  return `${indent}${dto.name}${fork} [${dto.endpointStatus}] created_by=${dto.createdBy}${ctx}${conn}`;
}

function renderProject(dto: ReturnType<typeof toProjectDto>): string {
  return `  ${dto.name} (pg${dto.pgVersion})`;
}

// Fix 4 (task-9 fix wave): list_branches must convey the branch TREE (parent/child ancestry), not
// a flat repo-order list — the spec's stated contract ("returns the branch tree: status +
// created_by + fork context") loses exactly the ancestry information once more than one non-main
// branch exists, and an agent has no other way to tell whose fork is whose. Builds a parent->
// children structure from each BranchDto's `id`/`parentBranchId` (populated by services/dto.ts's
// toBranchDto, itself passing BranchRow's own `parentBranchId` straight through) and walks it
// depth-first (root branches — `parentBranchId === null`, i.e. exactly "main" today, since only
// project.create() ever creates a parentless branch — first, each in list-order, followed
// immediately by its own descendants before moving to the next root) so a branch's full lineage
// is always contiguous in the output, never interleaved with an unrelated sibling subtree.
//
// A parent id that doesn't resolve to any branch IN THIS SAME LIST (should be impossible — every
// branch's parent lives in the same project, per branches.ts's create() FK, and list() fetches
// every branch for that project — but the rendering must not silently drop a branch or throw on
// a data inconsistency) falls back to treating that branch as a root: it still appears, just
// without a fork label, rather than vanishing from the output entirely.
function renderBranchTree(dtos: BranchDto[]): string {
  const byId = new Map(dtos.map((d) => [d.id, d]));
  const childrenOf = new Map<string, BranchDto[]>();
  const roots: BranchDto[] = [];
  for (const d of dtos) {
    const parentId = d.parentBranchId && byId.has(d.parentBranchId) ? d.parentBranchId : null;
    if (parentId === null) {
      roots.push(d);
    } else {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(d);
      childrenOf.set(parentId, siblings);
    }
  }

  const lines: string[] = [];
  function walk(node: BranchDto, depth: number, parentName: string | null): void {
    lines.push(renderBranch(node, depth, parentName));
    for (const child of childrenOf.get(node.id) ?? []) {
      walk(child, depth + 1, node.name);
    }
  }
  for (const root of roots) walk(root, 0, null);
  return lines.join("\n");
}

// Wraps every tool handler so a thrown error becomes an actionable errorResult instead of an
// uncaught rejection. The SDK's own tools/call dispatcher (mcp.js) already has a generic
// try/catch -> createToolError fallback, but that produces a bare, unphrased message with no
// guarantee of matching our contract — this guard is the one place that guarantees OUR error
// shape for every tool registered through it, regardless of what the SDK's own fallback would
// have produced. Tasks 10-11 register their tools through this SAME guard(), so a fix here covers
// every tool the MCP server exposes, not just these 5.
//
// Fix 1 (task-9 fix wave, Important): the pre-fix version did `errorResult(e.message)` for EVERY
// caught throw, with no discrimination — so an unexpected/programming bug (e.g. a TypeError from
// a service dependency, not a deliberate service-layer error) surfaced to the agent as an ordinary
// tool error carrying the RAW internal message, and was logged nowhere. Two failure classes now:
//   - `DevdbError` (services/errors.ts) is a DELIBERATE, ACTIONABLE service error — every throw
//     site (projects.ts/branches.ts's *Or404 resolvers, create()'s validation, etc.) already
//     phrases its message as a caller-actionable remediation, so this layer's only job for THIS
//     class is translation (message -> errorResult), not re-phrasing. Surfaced verbatim, as
//     before.
//   - Anything else (TypeError, a rejected promise from a dependency that isn't a DevdbError,
//     etc.) is treated as a BUG, not a user-facing failure condition: its raw message must not
//     reach the caller (it was never written to be caller-actionable, and may leak internal
//     detail), so the response is a generic, constant remediation instead. The error (with its
//     stack — `logger.error`'s second parameter is `unknown`, and every existing Logger consumer
//     already passes the raw caught error there for the same reason, see projects.ts/branches.ts's
//     compensation `.catch()` callbacks) is logged via the injected Logger so the failure is NOT
//     silently swallowed — findable in the daemon logs, which is exactly what the generic
//     remediation below tells the caller to go check. `ctx.deps.logger` is optional (see
//     http/api.ts's Deps.logger comment) — falls back to `console.error` so a caller that hasn't
//     wired one (e.g. an older test fixture) still logs SOMEWHERE rather than silently dropping
//     the bug on the floor.
function guard<A>(name: string, deps: ToolCtx["deps"], fn: (a: A) => Promise<ToolResult>): (a: A) => Promise<ToolResult> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      if (e instanceof DevdbError) {
        return errorResult(e.message);
      }
      const log = deps.logger?.error ?? console.error;
      log(`mcp tool ${name} failed`, e);
      return errorResult("internal error — check the daemon logs");
    }
  };
}

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  const { deps } = ctx;

  server.registerTool("get_status", {
    description: "Report daemon health, version, and engine process states. Call first to confirm devdb is reachable.",
    inputSchema: {},
  }, guard("get_status", deps, async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    const lines = Object.entries(engine).map(([name, p]) => `  ${name}: ${p.state}${p.pid ? ` (pid ${p.pid})` : ""}`);
    return text(
      // Fix 2 (task-9 fix wave): description promises version+health+engine, but the text
      // previously omitted the version — reuses PACKAGE_VERSION (the SAME value GET /api/status
      // returns, http/api.ts) rather than a second, independently-drifting literal.
      `[devdb] status as of ${nowIso()} (devdb v${PACKAGE_VERSION})\n` +
      `  healthy: ${healthy}\n${lines.join("\n")}\n` +
      `Next: list_projects to see what's available, or create_project to start one.`,
    );
  }));

  server.registerTool("list_projects", {
    description: "List every project (each with an isolated main branch). Call before create_project to avoid duplicates.",
    inputSchema: {},
  }, guard("list_projects", deps, async () => {
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
  }, guard("create_project", deps, async ({ name, pgVersion }: z.infer<z.ZodObject<typeof CreateProjectShape>>) => {
    const { project, mainBranch } = await deps.services.projects.create({ name, pgVersion });
    const detail = await deps.services.branches.detail(mainBranch);
    const dto = toBranchDto(detail);
    return text(
      `${contextLine({ project: project.name })}\n` +
      `  created pg${project.pgVersion}, main branch:\n${renderBranch(dto, 0, null)}\n` +
      `Next: create_branch to get an isolated working copy off "main".`,
    );
  }));

  const ListBranchesShape = { project: z.string() };
  server.registerTool("list_branches", {
    description: "List every branch in a project as a tree (name, endpoint status, who created it, fork context, and parent ancestry). Resolves the project by name.",
    inputSchema: ListBranchesShape,
  }, guard("list_branches", deps, async ({ project }: z.infer<z.ZodObject<typeof ListBranchesShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const details = await deps.services.branches.list(p.id);
    const dtos = details.map(toBranchDto);
    // Fix 4 (task-9 fix wave): renders the branch TREE (ancestry legible per-node via an explicit
    // "(from <parent>)" label + depth indentation — see renderBranchTree()'s doc comment), not a
    // flat repo-order list — losing parent/child ancestry meant an agent couldn't tell whose fork
    // was whose once more than one non-main branch existed.
    return text(
      `${contextLine({ project: p.name })}\n` +
      `  ${dtos.length} branch(es):\n${renderBranchTree(dtos)}\n` +
      `Next: get_branch to fetch a connection string, or create_branch to fork one.`,
    );
  }));

  const GetBranchShape = { project: z.string(), branch: z.string(), ensure_running: z.boolean().default(true) };
  server.registerTool("get_branch", {
    description: "Fetch a branch's status + connection string (the 'switch' move). Starts the endpoint by default.",
    inputSchema: GetBranchShape,
  }, guard("get_branch", deps, async ({ project, branch, ensure_running }: z.infer<z.ZodObject<typeof GetBranchShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const detail = ensure_running
      ? await deps.services.endpoints.ensureRunning(b.id)
      : await deps.services.branches.detail(b);
    const dto = toBranchDto(detail);
    const next = dto.connectionString
      ? "Next: wire the connection string into your worktree env."
      : "Next: pass ensure_running=true (default) to start it.";
    return text(`${contextLine({ project: p.name, branch: b.name })}\n${renderBranch(dto, 0, null)}\n${next}`);
  }));

  // Client-less fork-context input: the four CALLER-supplied fields from shared's
  // BranchContextSchema, minus `client` — `client` is populated server-side from the connected
  // MCP session's own captured clientInfo (ctx.clientInfo(), below), never accepted as caller
  // input. Accepting it here would let a caller spoof which agent/version actually made the fork,
  // defeating the whole point of recording it.
  //
  // Fix 2 (task-10 fix wave, fold): this shape has NO `client` key at all — the SDK's own zod
  // validation strips an adversarial `context.client` before the handler below ever sees it, so
  // the spoof-safety guarantee holds independent of the merge's spread order (belt AND suspenders
  // with `{ ...(context ?? {}), client: ctx.clientInfo() }` below, which overwrites it either way).
  const BranchContextInputShape = {
    git_branch: z.string().optional(),
    workdir: z.string().optional(),
    agent: z.string().optional(),
    purpose: z.string().optional(),
  };
  const BranchContextInputSchema = z.object(BranchContextInputShape);

  const CreateBranchShape = {
    project: z.string(), name: z.string(),
    parent: z.string().optional(), at_timestamp: z.string().optional(),
    context: BranchContextInputSchema.optional(),
  };
  server.registerTool("create_branch", {
    description: "Create an isolated branch (the 'new worktree' move), optionally at a past timestamp. Auto-starts an endpoint and returns a connection string. Pass fork context (git_branch/workdir/agent/purpose) so other agents can see why this branch exists.",
    inputSchema: CreateBranchShape,
  }, guard("create_branch", deps, async ({ project, name, parent, at_timestamp, context }: z.infer<z.ZodObject<typeof CreateBranchShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const parentRow = parent ? deps.services.branches.byProjectAndNameOr404(p.id, parent) : undefined;

    let atLsn: string | undefined;
    if (at_timestamp) {
      const src = parentRow ?? deps.services.branches.byProjectAndNameOr404(p.id, "main");
      atLsn = await deps.services.timetravel.lsnAtTimestamp(src.id, at_timestamp);
    }

    // Merges the caller's own fork context with the session's captured clientInfo — clientInfo()
    // is undefined-safe (a client that skipped a proper `initialize` handshake yields undefined,
    // see server.ts's ToolCtx.clientInfo doc), so `client` simply comes out undefined in that
    // case rather than throwing.
    const merged = { ...(context ?? {}), client: ctx.clientInfo() };

    const branch = await deps.services.branches.create({
      projectId: p.id, name, parentBranchId: parentRow?.id, atLsn, createdBy: "mcp", context: merged,
    });

    // Fix 1 (task-10 fix wave, Important): the branch (the valuable data fork) already exists at
    // this point — ONLY the auto-start is wrapped here, so a pre-create failure (bad project/
    // parent, above) still flows through the shared guard() normally. If ensureRunning() throws
    // (port exhaustion, compute launch failure), letting that escape to guard() would turn a
    // partial success into an opaque, generic error — the agent would see a failure, retry
    // create_branch with the SAME name, hit a 409 duplicate, and be stuck with an orphaned branch
    // it doesn't know exists. Do NOT delete the branch (the endpoint is restartable —
    // EndpointsService.startLocked's own catch block already persisted a durable `endpointError` on
    // the branch row before re-throwing, services/endpoints.ts) — instead read the branch back to
    // surface that persisted error, and name the recovery so a retry uses get_branch, never another
    // create_branch.
    let detail;
    try {
      detail = await deps.services.endpoints.ensureRunning(branch.id);
    } catch {
      // Re-fetch the row by id (not `branches.detail(branch)` with the pre-start `branch` object
      // in hand) — `detail()` only re-derives LIVE compute status/port on top of whatever row it's
      // handed, it does NOT re-read the row from SQLite itself, so the stale in-memory `branch`
      // from before ensureRunning() ran would still show `endpointError: null` even though
      // startLocked's catch block just persisted it.
      const failed = await deps.services.branches.detail(deps.services.branches.byIdOr404(branch.id));
      return errorResult(
        `${contextLine({ project: p.name, branch: branch.name, parent: parentRow?.name ?? "main" })}\n` +
        `  branch CREATED, but its endpoint failed to start: ${failed.endpointError ?? "unknown error"}\n` +
        `Next: fix the cause and call get_branch "${branch.name}" to retry the endpoint, or delete_branch "${branch.name}" to discard.`,
      );
    }

    const dto = toBranchDto(detail);
    return text(
      `${contextLine({ project: p.name, branch: branch.name, parent: parentRow?.name ?? "main" })}\n` +
      `${renderBranch(dto, 0, null)}\n` +
      `Next: wire the connection string into your worktree env; delete_branch when the task is done.`,
    );
  }));
}
