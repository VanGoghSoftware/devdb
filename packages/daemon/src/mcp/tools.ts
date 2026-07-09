import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgVersionSchema } from "@devdb/shared";
import { PACKAGE_VERSION } from "../http/api.js";
import type { ToolCtx } from "./server.js";
import { DevdbError } from "../services/errors.js";
import { toBranchDto, toProjectDto } from "../services/dto.js";
import type { PgBuildRow } from "../state/repos.js";
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

// Shared by create_branch and restore_branch's as_new_branch path (Task 11): both durably create
// a NEW branch first, then auto-start its endpoint via ensureRunning() — and both need IDENTICAL
// partial-success handling if that auto-start throws. The branch (the valuable data fork) already
// exists at that point; letting the throw escape to guard() would turn a partial success into an
// opaque, generic error, and an agent would retry the CREATE call with the same name, hit a 409
// duplicate, and be stuck with an orphaned branch it doesn't know exists. Do NOT delete the branch
// (the endpoint is restartable — EndpointsService.startLocked's own catch block already persisted
// a durable `endpointError` on the branch row before re-throwing, services/endpoints.ts) — instead
// read the branch back to surface that persisted error, and name the recovery so a retry uses
// get_branch, never another create call.
async function startNewBranchOrPartialSuccess(
  deps: ToolCtx["deps"],
  branch: { id: string; name: string },
  contextLineArgs: { project: string; branch: string; parent?: string },
): Promise<{ ok: true; detail: Awaited<ReturnType<typeof deps.services.branches.detail>> } | { ok: false; result: ToolResult }> {
  try {
    const detail = await deps.services.endpoints.ensureRunning(branch.id);
    return { ok: true, detail };
  } catch {
    // Re-fetch the row by id (not `branches.detail(branch)` with the pre-start `branch` object in
    // hand) — `detail()` only re-derives LIVE compute status/port on top of whatever row it's
    // handed, it does NOT re-read the row from SQLite itself, so the stale in-memory `branch` from
    // before ensureRunning() ran would still show `endpointError: null` even though startLocked's
    // catch block just persisted it.
    const failed = await deps.services.branches.detail(deps.services.branches.byIdOr404(branch.id));
    return {
      ok: false,
      result: errorResult(
        `${contextLine(contextLineArgs)}\n` +
        `  branch CREATED, but its endpoint failed to start: ${failed.endpointError ?? "unknown error"}\n` +
        `Next: fix the cause and call get_branch "${branch.name}" to retry the endpoint, or delete_branch "${branch.name}" to discard.`,
      ),
    };
  }
}

// Task 11 (dynamic-pg-builds): "16.9" when a minor is known, "16.x" while still downloading/
// unknown — same fallback dto.ts's toPgBuildDto uses for the wire DTO's `version` field, kept
// consistent here so an agent sees the identical string whether it reads the REST DTO or this
// tool's text.
function versionString(row: PgBuildRow): string {
  return row.minor === null ? `${row.major}.x` : `${row.major}.${row.minor}`;
}

// One subline per non-active build row: "[ready] 16.9 baked" / "[ready] 16.10 release 9124" /
// "[failed] release 9101: gate: …". Baked rows render "baked" (there's no meaningful release tag
// to show — registry.ts seeds them with releaseTag: "baked"); downloaded rows render
// "release <tag>" so an agent can tell which OCI tag a given build came from (the same releaseTag
// field the REST DTO exposes, see dto.ts's toPgBuildDto doc comment).
function renderBuildSubline(row: PgBuildRow): string {
  const originLabel = row.source === "baked" ? "baked" : `release ${row.releaseTag}`;
  if (row.status === "failed") {
    return `  [failed] ${originLabel}: ${row.error ?? "unknown error"}`;
  }
  // A benign no-op (its digest/minor was already installed): show its message, distinctly from a
  // failure so an agent doesn't read it as one or retry it (a retry just re-no-ops).
  if (row.status === "skipped") {
    return `  [skipped] ${row.error ?? "already installed (up to date)"}`;
  }
  return `  [${row.status}] ${versionString(row)} ${originLabel}`;
}

// Fix round 1 (review of Task 11 commit cfec31c, P3): `others` is no longer guaranteed non-empty
// when there's no active row — list_pg_builds now visits every major registry.list() knows about
// (see its own call site below), including one whose ONLY rows are in-flight/failed, so the
// no-active branch must say something more useful than a bare "no active build" (which reads as
// "nothing is happening" even mid-pull). Prefers "pulling" when a downloading/validating row is
// actually in flight (the common case right after pull_pg_build fires); falls back to "last pull
// failed" when every other row for this major is failed (no pull in flight at all); "no active
// build" alone remains the fallback for the (believed-impossible today, since seedBaked/adopt/pull
// are the only writers and registry.list() only returns majors with >=1 row) case of a major with
// literally no other rows to describe either.
function noActiveSuffix(others: PgBuildRow[]): string {
  if (others.some((r) => r.status === "downloading" || r.status === "validating")) return " yet (pulling)";
  // "last pull failed" only when a REAL failure is all that's left — a benign `skipped` no-op is not
  // a failure, so it neither triggers this suffix nor suppresses it when a genuine failure sits beside it.
  const nonSkipped = others.filter((r) => r.status !== "skipped");
  if (nonSkipped.length > 0 && nonSkipped.every((r) => r.status === "failed")) return " (last pull failed)";
  return "";
}

// Renders one major's block: the active line (or a "no active build" line if none resolved — see
// noActiveSuffix() above for how that line adapts to in-flight/failed-only majors), then a subline
// per OTHER row for that major (active row is already named on the header line, so it's excluded
// from the sublines to avoid saying the same build twice). `rows` may include EVERY status
// (ready/downloading/validating/failed) for this major — not just ready ones — so every row still
// gets a subline via renderBuildSubline() regardless of status.
function renderMajorBlock(major: number, rows: PgBuildRow[], degraded: boolean, updateAvailable: string | null): string {
  const active = rows.find((r) => r.active && r.status === "ready") ?? null;
  const others = rows.filter((r) => r !== active);
  const lines: string[] = [];
  if (degraded) {
    lines.push(`⚠ PG ${major} is running BELOW its last-run minor — re-pull to clear`);
  }
  lines.push(
    active
      ? `PG ${major} — active ${versionString(active)} (${active.source}, release ${active.releaseTag})`
      : `PG ${major} — no active build${noActiveSuffix(others)}`,
  );
  for (const row of others) lines.push(renderBuildSubline(row));
  // updateAvailable is non-null ONLY for an "unverified" latest (a digest we haven't confirmed is
  // newer — null for current/incompatible), so word it honestly, not as a confident "update".
  if (updateAvailable) lines.push(`unverified: PG ${major} → ${updateAvailable} (pull to verify)`);
  return lines.join("\n");
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

    // Fix 1 (task-10 fix wave, Important; factored into a shared helper in task 11 since
    // restore_branch's as_new_branch path needs IDENTICAL handling) — see
    // startNewBranchOrPartialSuccess()'s doc comment above for the full rationale.
    const contextArgs = { project: p.name, branch: branch.name, parent: parentRow?.name ?? "main" };
    const started = await startNewBranchOrPartialSuccess(deps, branch, contextArgs);
    if (!started.ok) return started.result;

    const dto = toBranchDto(started.detail);
    return text(
      `${contextLine(contextArgs)}\n` +
      `${renderBranch(dto, 0, null)}\n` +
      `Next: wire the connection string into your worktree env; delete_branch when the task is done.`,
    );
  }));

  server.registerTool("stop_endpoint", {
    description: "Stop a branch's endpoint (frees its port).",
    inputSchema: { project: z.string(), branch: z.string() },
  }, guard("stop_endpoint", deps, async ({ project, branch }: { project: string; branch: string }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const dto = toBranchDto(await deps.services.endpoints.stop(b.id));
    return text(
      `${contextLine({ project: p.name, branch: b.name })}\n` +
      `  endpoint ${dto.endpointStatus}.\n` +
      `Next: get_branch to restart it.`,
    );
  }));

  server.registerTool("delete_branch", {
    description: "Delete a branch. Fails if it has children (they are listed).",
    inputSchema: { project: z.string(), branch: z.string() },
  }, guard("delete_branch", deps, async ({ project, branch }: { project: string; branch: string }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    // A children-exist failure throws a DevdbError (services/branches.ts's delete()) naming the
    // children and "delete them first" — guard() surfaces that message verbatim, no extra handling
    // needed here.
    await deps.services.branches.delete(b.id);
    // Fix 3 (task-11 fix wave, fold): the response contract requires a next-step hint on every
    // success — every other mutation tool in this file already names one; delete_branch's success
    // previously stopped at "deleted." with nothing after.
    return text(
      `${contextLine({ project: p.name, branch: b.name })}\n  deleted.\n` +
      `Next: list_branches to confirm, or create_branch to start a new working copy.`,
    );
  }));

  server.registerTool("reset_branch", {
    description: "Discard a branch's changes; back to the parent's current state (the 'scrap and retry' move).",
    inputSchema: { project: z.string(), branch: z.string() },
  }, guard("reset_branch", deps, async ({ project, branch }: { project: string; branch: string }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const dto = toBranchDto(await deps.services.timetravel.resetToParent(b.id));
    const conn = dto.connectionString ? `\n  connection: ${dto.connectionString}` : "";
    return text(
      `${contextLine({ project: p.name, branch: dto.name })}\n` +
      `  reset to parent.${conn}\n` +
      `Next: get_branch to confirm the connection string, or reset_branch again after further edits.`,
    );
  }));

  // Fix 1 (task-11 fix wave, CRITICAL — destructive footgun): `as_new_branch` used to be a bare
  // `z.string().optional()`, so an empty string satisfied the schema — and the handler branched on
  // TRUTHINESS (`if (as_new_branch)`), so `as_new_branch: ""` (a caller who clearly INTENDED the
  // non-destructive new-branch path but supplied an empty name) silently fell through to the
  // DESTRUCTIVE in-place restore of the SOURCE branch. `.trim().min(1)` rejects an empty/
  // whitespace-only name at the SDK's own inputSchema validation boundary — BEFORE either restore
  // path's handler body ever runs, so a bad name fails safely (a validation error, no side effect)
  // rather than silently diverting to the destructive path. `.trim()` matters on its own: without
  // it, a whitespace-only name like "   " would pass `.min(1)` (length 3) and still reach the
  // handler as a truthy-but-garbage value.
  const RestoreBranchShape = {
    project: z.string(), branch: z.string(), to_timestamp: z.string(),
    as_new_branch: z.string().trim().min(1).optional(), context: BranchContextInputSchema.optional(),
  };
  server.registerTool("restore_branch", {
    description: "Restore a branch to a past ISO-8601 timestamp. Provide as_new_branch (a name) to recover non-destructively into a new branch (recommended); omit for in-place restore (the endpoint is auto-stopped and restarted around it).",
    inputSchema: RestoreBranchShape,
  }, guard("restore_branch", deps, async ({ project, branch, to_timestamp, as_new_branch, context }: z.infer<z.ZodObject<typeof RestoreBranchShape>>) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);

    // Belt-and-suspenders alongside the schema fix above: branch on PRESENCE
    // (`as_new_branch !== undefined`), not truthiness. Once the schema guarantees a supplied value
    // is non-empty, this distinction is moot for THIS field specifically — but branching on
    // presence rather than truthiness is the correct discipline for an optional-string "which path"
    // selector in general (the schema is the one line of defense that can drift or be relaxed
    // later; the handler's own branch condition should not silently rely on it never doing so).
    if (as_new_branch !== undefined) {
      // Same session-client merge discipline as create_branch: the caller's own fork context plus
      // the server-captured clientInfo, `client` spread LAST so a spoofed context.client can never
      // win (belt-and-suspenders with the schema itself having no `client` key at all).
      const merged = { ...(context ?? {}), client: ctx.clientInfo() };
      const nb = await deps.services.timetravel.branchAtTimestamp({
        projectId: p.id, sourceBranchId: b.id, name: as_new_branch, isoTimestamp: to_timestamp,
        createdBy: "mcp", context: merged,
      });

      const contextArgs = { project: p.name, branch: nb.name, parent: b.name };
      const started = await startNewBranchOrPartialSuccess(deps, nb, contextArgs);
      if (!started.ok) return started.result;

      const dto = toBranchDto(started.detail);
      return text(
        `${contextLine(contextArgs)}\n` +
        `${renderBranch(dto, 0, null)}\n` +
        `Next: verify the recovered data, then keep it or delete_branch "${nb.name}" once you're done.`,
      );
    }

    const dto = toBranchDto(await deps.services.timetravel.restoreInPlace(b.id, to_timestamp));
    // Fix 4 (task-11 fix wave, fold): swapOntoNewTimeline (services/timetravel.ts) only restarts
    // the endpoint on the swapped identity `if (wasRunning)` beforehand — a branch with NO running
    // endpoint at restore time comes back stopped, no connectionString. The pre-fix message
    // unconditionally claimed "endpoint auto-stopped and restarted" regardless, which is simply
    // false in that case. Rendered conditionally from the DTO instead: connectionString present
    // (equivalently, endpointStatus === "running") means the restart genuinely happened, so the
    // restart claim + connection string both render; otherwise the restored branch is stopped, so
    // the message says so and points at get_branch (the same "how do I get a connection" next step
    // every other stopped-endpoint response in this file already uses, e.g. get_branch's own
    // `ensure_running` next-step hint above).
    const body = dto.connectionString
      ? `  restored in place to ${to_timestamp}; endpoint restarted, connection: ${dto.connectionString}`
      : `  restored in place to ${to_timestamp} (endpoint is stopped — get_branch to start it).`;
    return text(
      `${contextLine({ project: p.name, branch: dto.name })}\n${body}\n` +
      `Next: verify the restored data.`,
    );
  }));

  // Task 11 (dynamic-pg-builds): the four pg-builds tools — agents self-serve a missing major or
  // a newer minor without a human touching the REST API/UI. Deliberately NO MCP delete tool: the
  // spec keeps infra-destructive operations (removing a build from disk) human-only; an agent
  // that wants a build gone has no MCP path to force it, only DELETE /api/pg-builds/:id via a
  // human or the web UI. None of these four tools has a project/branch scope, so — like
  // get_status above — they open with an ad hoc "[devdb] ..." header, not contextLine() (which
  // requires naming a project).
  server.registerTool("list_pg_builds", {
    description: "List every Postgres build, grouped by major version: which one is active, every other ready/downloading/validating/failed build, degraded-downgrade warnings, and any update news from a prior check_pg_updates call.",
    inputSchema: {},
  }, guard("list_pg_builds", deps, async () => {
    // Fix round 1 (review of Task 11 commit cfec31c, P3): the major set MUST come from
    // `registry.list()` (every row of every status) — NOT `registry.installedMajors()`, which only
    // returns majors that have at least one READY row (BuildRegistry.installedMajors(), registry.ts
    // — filters on `row.status === "ready"` before collecting the major). `pull_pg_build`'s own
    // response text tells agents to "poll list_pg_builds" for progress; deriving the set from
    // installedMajors() meant a pull of a brand-new major (no ready row for it yet) was invisible
    // for the ENTIRE downloading/validating window, and stayed invisible forever if the pull ended
    // failed — the self-service "add a major" flow looked like it silently never started. The REST
    // route (GET /api/pg-builds, http/api.ts) and the web UI already read `registry.list()`
    // directly for exactly this reason; this brings the MCP tool's rendering in line with them.
    const rows = deps.registry.list();
    if (rows.length === 0) {
      return text(`[devdb] no Postgres builds installed\nNext: pull_pg_build to install one.`);
    }
    const majors = [...new Set(rows.map((r) => r.major))].sort((a, b) => a - b);
    const degraded = new Set(deps.registry.degradedMajors());
    const blocks = majors.map((major) =>
      renderMajorBlock(
        major,
        rows.filter((r) => r.major === major),
        degraded.has(major),
        deps.provisioner.updateAvailableFor(major),
      ),
    );
    // "tracked", not "installed": with the fix above, a major can appear here on the strength of a
    // downloading/failed row alone, with nothing actually installed yet — "installed" would be a
    // false claim for exactly the majors this fix makes visible.
    return text(
      `[devdb] ${majors.length} Postgres major(s) tracked as of ${nowIso()}\n${blocks.join("\n")}\n` +
      `Next: check_pg_updates to look for news, or activate_pg_build to switch a major's active build.`,
    );
  }));

  const CheckPgUpdatesShape = { majors: z.array(PgVersionSchema).optional() };
  server.registerTool("check_pg_updates", {
    description: "Check the OCI registry's 'latest' per major and classify it honestly — current / unverified (worth a pull to verify) / incompatible (won't load on this runtime) — egress: hits the network. Populates list_pg_builds' trailing 'unverified:' lines.",
    inputSchema: CheckPgUpdatesShape,
  }, guard("check_pg_updates", deps, async ({ majors }: z.infer<z.ZodObject<typeof CheckPgUpdatesShape>>) => {
    const targets = majors ?? deps.registry.installedMajors();
    const result = await deps.provisioner.check(targets);
    // Honest per-state wording (see Provisioner.CheckState): "unverified" is the only offerable
    // outcome (a `latest` we haven't confirmed is newer — pull to verify); "current" is up to date;
    // "incompatible" means `latest` already failed to load on this runtime and re-pulling re-fails.
    const stateLabel: Record<string, string> = {
      current: "up to date",
      unverified: "latest unverified — pull to verify",
      incompatible: "latest incompatible with this runtime — not installable",
    };
    const lines = Object.entries(result).map(
      ([major, r]) => `  PG ${major}: ${stateLabel[r.state] ?? r.state} (${r.tag}@${r.digest.replace(/^sha256:/, "").slice(0, 12)})`,
    );
    return text(
      `[devdb] checked ${targets.length} major(s) as of ${nowIso()}\n${lines.join("\n")}\n` +
      `Next: pull_pg_build for any major with an unverified latest.`,
    );
  }));

  const PullPgBuildShape = { major: PgVersionSchema, tag: z.string().min(1).optional() };
  server.registerTool("pull_pg_build", {
    description: "Start pulling a Postgres build for a major (defaults to the 'latest' OCI tag). Async: returns immediately with the buildId — poll list_pg_builds for status.",
    inputSchema: PullPgBuildShape,
  }, guard("pull_pg_build", deps, async ({ major, tag }: z.infer<z.ZodObject<typeof PullPgBuildShape>>) => {
    // Fire-and-return: the pipeline (extract/fixup/validate/auto-activate) runs after
    // provisioner.pull() resolves its own synchronous "downloading row inserted" step — awaiting
    // anything past that here would block this tool call for the full pull (up to the 90s
    // validation-gate budget alone), the opposite of the documented immediate-return contract.
    const { buildId } = await deps.provisioner.pull({ major, tag });
    // "Progress: ... logs channel pgbuild:<id>" (not a REST path): provisioner.ts ingests pull
    // progress to LogsService channel `pgbuild:${buildId}` (see its private log() helper), but no
    // SSE route in http/api.ts currently serves that channel family — GET /api/daemon/logs/:component
    // only allowlists the fixed engine-process component set (daemonLogChannel), and
    // GET /api/branches/:id/logs serves a DIFFERENT channel (`branch:<id>:compute`, keyed by
    // branch id, not build id). Naming a REST path here that 404s would be a broken hint, so this
    // names the channel (useful today via list_pg_builds' polling loop, and for whichever future
    // route/UI surfaces it) without asserting a currently-working URL.
    //
    // Enhancement (Sonnet Minor, review of Task 11 commit cfec31c, fold): names GET /api/events as
    // the non-polling alternative — Provisioner.publish() (provisioner.ts, its own doc comment at
    // the top of the class names this same route as the intended alternative to polling) emits a
    // `pg_builds` invalidation event on EVERY pipeline transition (downloading -> validating ->
    // ready/failed, and activate), so a caller that would rather watch an SSE stream than poll
    // list_pg_builds on a timer has a real route to do that with, not just the poll instruction.
    return text(
      `pull started (build ${buildId}). Poll list_pg_builds — status downloading → validating → ready (auto-activates).\n` +
      `Progress: daemon logs channel pgbuild:${buildId}. Or watch GET /api/events for a "pg_builds" event instead of polling.`,
    );
  }));

  const ActivatePgBuildShape = { major: PgVersionSchema, version: z.string().regex(/^\d+\.\d+$/), id: z.string().optional() };
  server.registerTool("activate_pg_build", {
    description: "Make a specific ready build the active one for its major. Refuses downgrades below the last-run minor — an agent cannot silently roll a branch back; downgrading requires human consent via the web UI or REST. Pass the build id to disambiguate when two ready builds share a major.minor (a same-minor rebuild at a new digest).",
    inputSchema: ActivatePgBuildShape,
  }, guard("activate_pg_build", deps, async ({ major, version, id }: z.infer<z.ZodObject<typeof ActivatePgBuildShape>>) => {
    const candidates = deps.registry.list().filter((r) => r.major === major);
    const ready = candidates.filter((r) => r.status === "ready" && versionString(r) === version);
    // #11: content-addressed storage means two ready rows can legitimately share one major.minor (a
    // same-minor rebuild at a new digest). find() would silently pick the oldest — instead require an
    // explicit build id to disambiguate rather than guess which rebuild the agent meant.
    let target: PgBuildRow | undefined;
    if (id !== undefined) {
      target = ready.find((r) => r.id === id);
      if (!target) {
        return errorResult(
          `no ready build ${version} for PG ${major} with id ${id}` +
          (ready.length > 0 ? ` — ready ids at ${version}: ${ready.map((r) => r.id).join(", ")}` : ` — none ready at ${version}`),
        );
      }
    } else if (ready.length > 1) {
      return errorResult(
        `ambiguous: ${ready.length} ready builds at ${version} for PG ${major} — re-call with id to pick one: ` +
        ready.map((r) => `${r.id} (digest ${r.imageDigest.replace(/^sha256:/, "").slice(0, 12)})`).join(", "),
      );
    } else {
      target = ready[0];
    }
    if (!target) {
      const available = candidates.filter((r) => r.status === "ready").map(versionString);
      return errorResult(
        `no ready build ${version} for PG ${major}` +
        (available.length > 0 ? ` — available: ${available.join(", ")}` : ` — none ready; pull_pg_build first`),
      );
    }

    // FIX-8 (Jordan's decision, 2026-07-05): "Refuse downgrades over MCP." An agent must NOT be
    // able to unilaterally roll a branch back to an older minor — downgrading is a human decision,
    // gated behind explicit consent (the web UI Settings card's confirm dialog, or REST
    // `POST /api/pg-builds/:id/activate {consented:true}`). Determine downgrade-ness BEFORE calling
    // activate at all: the SAME predicate BuildRegistry.activate uses internally (registry.ts)
    // against the pg_majors high-water mark, reached directly via deps.state (Deps.state is the
    // same StateDb instance the registry itself holds) since BuildRegistry has no public
    // lastRunMinor passthrough. Checking here — rather than calling activate() with no consent and
    // catching its 409 — means a downgrade target is REFUSED WITHOUT EVER CALLING
    // provisioner.activate: no risk of the guard's own 409 path being changed out from under this
    // check later and silently reintroducing an activation attempt on the agent's behalf.
    const lastRun = deps.state.pgMajors.lastRunMinor(major);
    const isDowngrade = target.minor !== null && lastRun !== null && target.minor < lastRun;
    if (isDowngrade) {
      return errorResult(
        `refused: ${version} is a downgrade below the last-run PG ${major}.${lastRun} — MCP cannot consent to downgrades on an agent's behalf.\n` +
        `Downgrades require human consent: use the web UI Settings card (confirm dialog) or ` +
        `POST /api/pg-builds/:id/activate with {"consented":true}.`,
      );
    }

    // Not a downgrade (minor >= last-run high-water, or no high-water recorded yet) — activates
    // unchanged. No `{consented: true}` passed: this path never needs consent (registry.ts's
    // activate() only demands it when isDowngrade), and MCP must never auto-consent regardless —
    // see the refusal branch above for the downgrade case, which never reaches this call at all.
    const row = await deps.provisioner.activate(target.id);
    return text(
      `[devdb] activated ${versionString(row)} for PG ${major}\n` +
      `Next: list_pg_builds to confirm, or restart any running endpoint on this major to pick it up.`,
    );
  }));
}
