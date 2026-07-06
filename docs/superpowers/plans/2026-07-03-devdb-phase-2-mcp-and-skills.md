# DevDB Phase 2 — MCP Server + Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-daemon MCP server so AI agents self-serve database branches (create/use/reset/restore, connection string in one call) plus two agent skills that establish the branch-per-task workflow — preceded by six engineering-hardening tasks that phase-1 review parked as prerequisites for the MCP surface.

**Architecture:** A session-stateful Streamable-HTTP MCP server (`@modelcontextprotocol/sdk`) mounted on the *existing* Fastify instance at `/mcp`, exposing 10 tools that wrap the existing services through the per-branch queue lanes. Wire responses (REST **and** MCP) go through explicit DTO mappers that drop `password`. Compute readiness switches from a stderr needle to polling `compute_ctl`'s auth-exempt `/metrics`; computes are spawned into their own process group. Two skills ship in a top-level `skills/` dir and via the MCP `initialize` `instructions` field.

**Tech Stack:** TypeScript / Node 22, Fastify 5, `@modelcontextprotocol/sdk` (Streamable HTTP), Zod 3, better-sqlite3, vitest (+ tsc gate), testcontainers 12.

**Spec:** `docs/superpowers/specs/2026-07-03-devdb-phase-2-mcp-skills-refinement-design.md` (refinement) + `docs/superpowers/specs/2026-07-02-devdb-design.md` §MCP server, §Agent skills, §Amendments. **Handover:** `docs/phases-2-5-handover.md` §4 (scope + parked decisions), §8 (live-engine facts).

---

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from AGENTS.md §"Hard rules", handover §3.4, and the refinement spec.

- **Supply chain:** npm deps must be **≥ 24h old** (`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`). pnpm is pinned (`packageManager: "pnpm@11.9.0"`); use plain `pnpm` (corepack's shim is broken on this machine). Every **new native dep** needs an explicit `allowBuilds` true/false decision; the MCP SDK is pure-JS (see Task 7). Docker installs use `--frozen-lockfile`, so `pnpm-lock.yaml` must be committed with any dependency change. A **new workspace importer** must have its `package.json` COPY'd into the image before `pnpm install` — Task 7 adds a dep to the *existing* `packages/daemon` importer, so no Dockerfile COPY change is needed (verified: `docker/Dockerfile:18-22` already COPYs `packages` recursively).
- **Unit tests:** typed fakes against the narrow interfaces in `packages/daemon/src/services/engine-api.ts` — **no `as never` / `as any`**. The daemon test script's tsc gate enforces test-file types: `pnpm --filter @devdb/daemon test` runs `pnpm --filter @devdb/shared build && tsc --noEmit -p tsconfig.test.json && vitest run`. Reuse the existing `fakes()` helper pattern (`packages/daemon/test/branches-service.test.ts:14-43`).
- **Integration tests:** import shared helpers from `tests/integration/helpers/` (`startDevdb`, `Devdb`, `connect`, `api`) — no per-file duplication. Full suite: `pnpm --filter @devdb/integration test` (~5 min, needs Docker).
- **Oracle rule:** engine interactions port official-Neon behavior with cited `// oracle: <file:line>` comments. **MCP is NOT an engine interaction** — it uses the official SDK, so MCP tools carry no oracle citations. The readiness (Task 5) and process-group (Task 6) tasks cite the live-engine facts in handover §4.3/§4.4/§8.7, not neon source directly.
- **No upstream reports:** never file issues/PRs/comments on external repos (neon, `@modelcontextprotocol/sdk`, testcontainers), even if a step seems to call for it. Document findings internally.
- **TDD:** write the failing test first, capture RED evidence (the failing run's output), then implement. Conventional commits; `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` on controller commits.
- **MCP response contract (spec §MCP server):** every success response is actionable text that **opens with a context line** naming the project and branch acted on (plus parent, for forks), includes the **connection string** when relevant and a **next-step hint**; every error **names its remediation**. Timestamps are **ISO-8601 with explicit timezone**.
- **Auth posture (refinement spec Decision 1):** `/mcp` is unauthenticated (localhost trust) but enables DNS-rebinding **Host/Origin validation**; compose binds published ports to `127.0.0.1`. No bearer token.
- **Verify-before-fix:** `main` moves under parallel sessions. Before each task, read the current target file and `git log` for supersession; retarget to what main actually lacks. **Task 6 (process-group kill) has a live sync point** — handover §4.4 notes Jordan has a session revisiting compute orphaning; confirm main's state before implementing.

---

## Live-engine + SDK reference map

Facts the tasks depend on (all already verified — do not re-derive the hard way):

| # | Fact | Source |
|---|---|---|
| R1 | `compute_ctl`'s external HTTP server (our `metricsPort`, 40000–40999) serves **auth-exempt** Prometheus `/metrics` with `compute_ctl_up{status="init\|running\|failed"}`; `status="running"` is set **strictly after** `apply_spec` commits. The `/status` JSON endpoint needs a JWT (empty jwks → permanent 400; `--dev` doesn't bypass). | handover §4.3, §8.7; memory `compute-ctl-readiness-signals` |
| R2 | The `"listening on IPv4 address"` needle fires **~80–140ms before** `apply_spec` completes; the auth gap (`28P01`, briefly `57P03`) only bites a branch's **first-ever** start. | handover §4.3 |
| R3 | `compute_ctl` orphans its postgres child on SIGTERM (official Neon's `compute_ctl` has no PDEATHSIG/setpgid handling for this either — DevDB's own gap, no upstream mechanism to port); `reapOrphanedPostgres` mitigates via `/proc` scan. Process-group spawn+kill is the structural fix. | handover §4.4, §8.6 |
| R4 | MCP SDK `StreamableHTTPServerTransport` supports a session-id generator (stateful mode), `DELETE` teardown, and DNS-rebinding options (rebinding flag + host/origin allowlists). `McpServer` accepts an `instructions` string surfaced in `initialize`; tool-list changes emit `notifications/tools/list_changed`. **Exact option names are pinned against the installed SDK in Task 7** (same discipline as the oracle rule for engine shapes). | refinement spec Decision 4 |

**In-repo shapes referenced repeatedly:**
- `BranchQueue.run<T>(branchId, fn)` chains per-`branchId` (`state/queue.ts`). `startLocked`/`stopLocked` live behind `EndpointsLockedApi` (`services/endpoints.ts:15-18`); must be called only while holding the branch's lane.
- `BranchRow` (`state/repos.ts:7-13`) includes `password`; `BranchDetail = BranchRow & {endpointStatus, endpointError, port, connectionString, lastRecordLsn, logicalSizeBytes, ancestorLsn}` (`services/branches.ts:12-20`). Shared `BranchDto` (`packages/shared/src/index.ts:22-38`) is the redacted wire shape (no `password`) — **missing `context` and `ancestorLsn` today**.
- Service surface the MCP tools wrap: `ProjectsService.{create,list,byIdOr404,delete}`, `BranchesService.{create,detail,list,delete,byIdOr404,connectionString}`, `EndpointsService.{start,stop,ensureRunning}`, `TimeTravelService.{lsnAtTimestamp,branchAtTimestamp,restoreInPlace,resetToParent}`, `SqlService.run`. App factory: `buildServer(deps: Deps): FastifyInstance` (`http/api.ts:39`); `GET /api/status` returns `{version, healthy, engine}` (`api.ts:61-65`).

---

## File Structure

**New files:**
- `packages/daemon/src/services/dto.ts` — `toBranchDto`, `toProjectDto` (domain→wire mappers; used by REST and MCP).
- `packages/daemon/src/logging/logger.ts` — structured logger fanning out to stderr + `LogsService`.
- `packages/daemon/src/compute/readiness.ts` — `waitComputeReady(metricsPort, …)` polling `/metrics`.
- `packages/daemon/src/mcp/format.ts` — response helpers (context line, success/error text, ISO timestamp).
- `packages/daemon/src/mcp/instructions.ts` — the `instructions`-field text.
- `packages/daemon/src/mcp/tools.ts` — the 10 tool definitions (zod input + handler over services).
- `packages/daemon/src/mcp/server.ts` — builds a per-session `McpServer`, registers tools, holds `clientInfo`.
- `packages/daemon/src/mcp/http.ts` — `registerMcp(app, deps)`: Fastify `/mcp` mount, stateful transport, session registry + idle eviction, DNS-rebinding guard.
- `skills/using-devdb/SKILL.md`, `skills/safe-db-migrations/SKILL.md` — shipped agent skills.
- `tests/integration/mcp.test.ts`, `tests/integration/mcp-concurrency.test.ts`.
- Unit tests under `packages/daemon/test/`: `queue-lane.test.ts`, `dto.test.ts`, `logger.test.ts`, `readiness.test.ts`, `mcp-tools.test.ts`, `mcp-session.test.ts`.

**Modified files:** `packages/shared/src/index.ts`; `packages/daemon/src/state/{queue,schema,db,repos}.ts`; `packages/daemon/src/services/{endpoints,timetravel,branches,projects,sql}.ts`; `packages/daemon/src/http/api.ts`; `packages/daemon/src/config.ts`; `packages/daemon/src/compute/{manager}.ts`; `packages/daemon/src/engine/process.ts`; `packages/daemon/src/index.ts` (logger wiring); `packages/daemon/package.json`; `tests/integration/{package.json,helpers/pg.ts}`; `docker/compose.yaml`; `README.md`.

---

## Task ordering & phases

- **Phase 2A — Hardening prerequisites (Tasks 1–6):** the parked decisions. These change signatures the MCP surface consumes, so they land first.
- **Phase 2B — MCP core (Tasks 7–12):** SDK dep, stateful transport + guard, tools, REST context parity.
- **Phase 2C — Config, compose, docs, skills (Tasks 13–15).**
- **Phase 2D — Integration (Tasks 16–17):** acceptance flow + concurrency.

---

## Task 1: Lane capability tokens (parked §4.1)

Make `startLocked`/`stopLocked` impossible to call without holding the branch's queue lane, replacing the JSDoc-only contract. `BranchQueue.run` mints a branded `Lane` and passes it to the work function; the locked methods require it and assert it matches the branch they operate on. Bonus: close the "empty-lane micro-window" (handover §9) where the swap starts an endpoint on the freshly-created `swapped.id` while holding the *archived* id's lane.

> **AMENDED (2026-07-03, execution):** two corrections landed during implementation/review. (1) Step 3's `declare const laneBrand: unique symbol;` is a type-only ambient declaration that erases at runtime — used as a computed key in a live object it throws `ReferenceError`. Use a real runtime symbol: `const laneBrand: unique symbol = Symbol("lane");`. (2) The branded lane proves *provenance* but not *liveness*; a review gate showed a retained lane would still satisfy the assertion. The lane is now **turn-scoped**: `BranchQueue` holds a `private activeLanes = new WeakSet<Lane>()` (add before `fn(lane)`, remove once it settles via `.finally`) and exposes `assertLane(lane, branchId)` that throws unless the lane is *currently active* AND its `branchId` matches; `startLocked`/`stopLocked` call `this.deps.queue.assertLane(...)` (the local helper is gone). Commits 49ec09a (initial) + 63f1dff (turn-scoping). Keep `laneBrand` un-exported.

**Files:**
- Modify: `packages/daemon/src/state/queue.ts`
- Modify: `packages/daemon/src/services/endpoints.ts:15-18,31-150`
- Modify: `packages/daemon/src/services/timetravel.ts:148-238`
- Test: `packages/daemon/test/queue-lane.test.ts` (new) + update any unit test that calls `startLocked`/`stopLocked` or fakes `EndpointsLockedApi`.

**Interfaces:**
- Produces: `Lane` (branded `{ readonly branchId: string }`, constructable only inside `BranchQueue`). `BranchQueue.run<T>(branchId: string, fn: (lane: Lane) => Promise<T>): Promise<T>`. `EndpointsLockedApi.startLocked(lane: Lane, branchId: string): Promise<BranchDetail>` and `stopLocked(lane: Lane, branchId: string): Promise<BranchDetail>`.
- Consumes: existing `BranchQueue` chaining; `EndpointsService`, `TimeTravelService`.

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/queue-lane.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { BranchQueue } from "../src/state/queue.js";

describe("BranchQueue lane capability", () => {
  it("passes a lane branded with the branchId to the work fn", async () => {
    const q = new BranchQueue();
    const lane = await q.run("branch-1", async (l) => l);
    expect(lane.branchId).toBe("branch-1");
  });

  it("still serializes per branch (lane does not change ordering)", async () => {
    const q = new BranchQueue();
    const order: string[] = [];
    const a = q.run("b", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a"); });
    const b = q.run("b", async () => { order.push("b"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run it, verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/queue-lane.test.ts`
Expected: FAIL — `run` currently passes no argument to `fn`, so `l.branchId` is `undefined`.

- [ ] **Step 3: Add the branded `Lane` and thread it through `run`** — `packages/daemon/src/state/queue.ts`

```typescript
declare const laneBrand: unique symbol;

/** Capability proving the holder is executing inside a specific branch's queue lane.
 *  Constructable ONLY by BranchQueue.run — the brand cannot be forged externally. */
export interface Lane {
  readonly branchId: string;
  readonly [laneBrand]: true;
}

export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();

  pendingCount(): number {
    return this.tails.size;
  }

  run<T>(branchId: string, fn: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = { branchId, [laneBrand]: true } as Lane;
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(() => fn(lane), () => fn(lane));
    const settled = next.then(() => undefined, () => undefined);
    this.tails.set(branchId, settled);
    void settled.then(() => {
      if (this.tails.get(branchId) === settled) this.tails.delete(branchId);
    });
    return next;
  }
}
```

- [ ] **Step 4: Run the lane test, verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/queue-lane.test.ts`
Expected: PASS.

- [ ] **Step 5: Require the lane in `EndpointsLockedApi` + assert it** — `packages/daemon/src/services/endpoints.ts`

Change the interface (lines 15-18) and both implementations. Add a shared guard and update signatures:

```typescript
import type { Lane } from "../state/queue.js";

export interface EndpointsLockedApi {
  startLocked(lane: Lane, branchId: string): Promise<BranchDetail>;
  stopLocked(lane: Lane, branchId: string): Promise<BranchDetail>;
}

function assertLane(lane: Lane, branchId: string): void {
  if (lane.branchId !== branchId) {
    throw new Error(`lane invariant: held lane is for ${lane.branchId}, not ${branchId}`);
  }
}
```

In `startLocked` (line 31) and `stopLocked` (line 117), change the signature to `(lane: Lane, branchId: string)` and make `assertLane(lane, branchId);` the first statement. Update the three public callers to thread the lane:

```typescript
start(branchId: string): Promise<BranchDetail> {
  return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId));
}
stop(branchId: string): Promise<BranchDetail> {
  return this.deps.queue.run(branchId, (lane) => this.stopLocked(lane, branchId));
}
ensureRunning(branchId: string): Promise<BranchDetail> {
  return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId));
}
```

- [ ] **Step 6: Thread the lane through `timetravel.ts` and close the micro-window** — `packages/daemon/src/services/timetravel.ts`

- Line 148: `return this.deps.queue.run(branchId, async (lane) => {` (receive `lane`).
- Line 162: `if (wasRunning) await this.deps.endpoints.stopLocked(lane, branch.id);`
- Line 226 (compensation): `await this.deps.endpoints.startLocked(lane, branch.id).catch(...)` (unchanged branch.id === lane.branchId).
- Line 236 (post-swap start on the NEW id) — wrap in `swapped.id`'s own lane so the assert holds AND the empty-lane micro-window closes:

```typescript
      // swapped.id is a fresh identity restoreSwap just minted; acquire ITS lane (uncontended —
      // nothing else can reference it yet) so this start is serialized under the branch it
      // actually targets, not the now-archived branchId lane we still hold. Closes the
      // "empty-lane micro-window" deferred to phase 2 in handover §9.
      if (wasRunning) {
        await this.deps.queue.run(swapped.id, (lane2) => this.deps.endpoints.startLocked(lane2, swapped.id));
      }
```

- [ ] **Step 7: Update existing unit tests + fakes** for the new `startLocked`/`stopLocked` arity

Any test constructing a fake `EndpointsLockedApi` or calling these methods must pass a lane. Because `Lane` is only mintable by `BranchQueue`, tests obtain one via a real `BranchQueue`:

```typescript
const q = new BranchQueue();
await q.run("b1", (lane) => svc.startLocked(lane, "b1"));
```

Grep first: `rg "startLocked|stopLocked|EndpointsLockedApi" packages/daemon/test`. Update each hit. For fakes, the interface now needs the `lane` param in the stub signature (still `vi.fn`, no cast).

- [ ] **Step 8: Full gate + commit**

Run: `pnpm --filter @devdb/daemon test`
Expected: tsc gate passes (proves no caller forges a `Lane` or drops the arg) and all vitest green.

```bash
git add packages/daemon/src/state/queue.ts packages/daemon/src/services/endpoints.ts \
  packages/daemon/src/services/timetravel.ts packages/daemon/test/
git commit -m "refactor: queue-issued lane capability enforces startLocked/stopLocked contract"
```

---

## Task 2: Fork-context foundation (spec §MCP fork context)

Add the persisted `context` column and its shared schema, and thread an optional `context` through the two branch-creating service methods. No MCP or wire changes yet — this is the storage + service substrate Tasks 3, 10, 11, 12 build on.

**Files:**
- Modify: `packages/shared/src/index.ts` (add `BranchContextSchema` + `BranchContext`).
- Modify: `packages/daemon/src/state/schema.ts:9-28` (add `context TEXT`).
- Modify: `packages/daemon/src/state/db.ts:15-18` (migration `REQUIRED_COLUMNS.branches.context = "TEXT"`).
- Modify: `packages/daemon/src/state/repos.ts:7-13,21-33,62-71` (`BranchRow.context`, `branchRow()` parse, `create()` accepts + persists).
- Modify: `packages/daemon/src/services/branches.ts:48-115` and `packages/daemon/src/services/timetravel.ts:68-81` (accept `context?`).
- Test: `packages/daemon/test/branch-context.test.ts` (new).

**Interfaces:**
- Produces: `BranchContextSchema` (zod) / `BranchContext = { git_branch?: string; workdir?: string; agent?: string; purpose?: string; client?: { name: string; version: string } }`. `BranchRow.context: BranchContext | null`. `BranchesRepo.create(a: { …; context?: BranchContext | null })`. `BranchesService.create(a: { …; context?: BranchContext | null })`. `TimeTravelService.branchAtTimestamp(a: { …; context?: BranchContext | null })`.
- Consumes: Task 1 lane (unaffected — same signatures).

- [ ] **Step 1: Add the shared schema** — `packages/shared/src/index.ts`

```typescript
export const BranchContextSchema = z.object({
  git_branch: z.string().optional(),
  workdir: z.string().optional(),
  agent: z.string().optional(),
  purpose: z.string().optional(),
  client: z.object({ name: z.string(), version: z.string() }).optional(),
});
export type BranchContext = z.infer<typeof BranchContextSchema>;
```

- [ ] **Step 2: Write the failing repo test** — `packages/daemon/test/branch-context.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";

describe("branch context persistence", () => {
  it("round-trips a context object through create + byId", () => {
    const state = openState(":memory:");
    const p = state.projects.create({ id: "p1", name: "proj", pgVersion: 17 });
    const ctx = { git_branch: "feat/x", workdir: "/w", agent: "claude", purpose: "try a migration" };
    const b = state.branches.create({
      id: "b1", projectId: p.id, parentBranchId: null, name: "main",
      slug: "proj-main-abc123", timelineId: "t".repeat(32), password: "pw", createdBy: "mcp",
      context: ctx,
    });
    expect(b.context).toEqual(ctx);
    expect(state.branches.byId("b1")?.context).toEqual(ctx);
  });

  it("defaults context to null when omitted", () => {
    const state = openState(":memory:");
    state.projects.create({ id: "p1", name: "proj", pgVersion: 17 });
    const b = state.branches.create({
      id: "b1", projectId: "p1", parentBranchId: null, name: "main",
      slug: "s", timelineId: "t".repeat(32), password: "pw", createdBy: "api",
    });
    expect(b.context).toBeNull();
  });
});
```

- [ ] **Step 3: Verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/branch-context.test.ts`
Expected: FAIL — `create` rejects the `context` field / `BranchRow` has no `context`.

- [ ] **Step 4: Add the column, migration, row type, mapper, and create-persist**

`state/schema.ts` — add inside the `branches` DDL (after `import_error TEXT,`): `context TEXT,`.

`state/db.ts:16-18` — extend the migration map:
```typescript
  const REQUIRED_COLUMNS: Record<string, Record<string, string>> = {
    branches: { endpoint_error: "TEXT", context: "TEXT" },
  };
```

`state/repos.ts` — add to `BranchRow` (line 7-13): `context: BranchContext | null;` (import `BranchContext` from `@devdb/shared`). In `branchRow()` (line 21-33): `context: r.context ? (JSON.parse(r.context) as BranchContext) : null,`. In `create()` (line 62-71): accept `context?: BranchContext | null` and bind `context = @context` with `context: a.context ? JSON.stringify(a.context) : null` in the INSERT.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/branch-context.test.ts`
Expected: PASS (both cases, including the additive-migration path via `:memory:` open).

- [ ] **Step 6: Thread `context` through the two service creators**

`services/branches.ts` `create()` (line 48-51): add `context?: BranchContext | null;` to the arg type, and pass `context: a.context ?? null` into `this.deps.state.branches.create({ … })` (line 92-101).

`services/timetravel.ts` `branchAtTimestamp()` (line 68-81): add `context?: BranchContext | null;` to the arg type and thread it into the branch-row creation it performs (mirror `branches.create`'s persistence).

- [ ] **Step 7: Full gate + commit**

Run: `pnpm --filter @devdb/daemon test`
Expected: green.

```bash
git add packages/shared/src/index.ts packages/daemon/src/state/ packages/daemon/src/services/branches.ts \
  packages/daemon/src/services/timetravel.ts packages/daemon/test/branch-context.test.ts
git commit -m "feat: persist optional fork context on branches (schema, migration, services)"
```

---

## Task 3: DTO mappers + password redaction + generic 409 (parked §4.2)

Wire responses currently serialize `BranchDetail` (a `BranchRow` superset) directly, leaking `password` on every branch response. Introduce explicit mappers, apply them at every REST site, surface `context` + `ancestorLsn` on the DTO, and stop `projects.ts:95` from echoing raw SQLite constraint text.

**Files:**
- Modify: `packages/shared/src/index.ts` (`BranchDto += context, ancestorLsn`).
- Create: `packages/daemon/src/services/dto.ts`.
- Modify: `packages/daemon/src/http/api.ts` (map every project/branch response).
- Modify: `packages/daemon/src/services/projects.ts:95` (generic 409).
- Test: `packages/daemon/test/dto.test.ts` (new).

**Interfaces:**
- Produces: `toBranchDto(detail: BranchDetail): BranchDto`, `toProjectDto(row: ProjectRow): ProjectDto` (exported from `services/dto.ts`). `BranchDto` gains `context: BranchContext | null` and `ancestorLsn: string | null`.
- Consumes: `BranchDetail` (Task 2 gives it `context`), `BranchContext` (Task 2).

- [ ] **Step 1: Extend `BranchDto`** — `packages/shared/src/index.ts` (add to the interface, lines 22-38):

```typescript
  context: BranchContext | null;
  ancestorLsn: string | null;
```

- [ ] **Step 2: Write the failing DTO test** — `packages/daemon/test/dto.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { toBranchDto } from "../src/services/dto.js";
import type { BranchDetail } from "../src/services/branches.js";

const detail: BranchDetail = {
  id: "b1", projectId: "p1", parentBranchId: null, name: "main", slug: "s",
  timelineId: "t".repeat(32), password: "SECRET", stickyPort: 54301, endpointStatus: "running",
  endpointError: null, importStatus: "none", importError: null, createdBy: "mcp",
  createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
  context: { agent: "claude", purpose: "x" },
  port: 54301, connectionString: "postgresql://postgres:SECRET@localhost:54301/postgres",
  lastRecordLsn: "0/1", logicalSizeBytes: 10, ancestorLsn: null,
};

describe("toBranchDto", () => {
  it("drops password but keeps connectionString + context", () => {
    const dto = toBranchDto(detail);
    expect("password" in dto).toBe(false);
    expect(dto.connectionString).toContain("SECRET"); // connstring is how the agent gets creds
    expect(dto.context).toEqual({ agent: "claude", purpose: "x" });
    expect(dto.ancestorLsn).toBeNull();
  });
  it("does not leak internal-only columns", () => {
    const dto = toBranchDto(detail) as Record<string, unknown>;
    for (const k of ["stickyPort", "importStatus", "importError"]) expect(k in dto).toBe(false);
  });
});
```

- [ ] **Step 3: Verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/dto.test.ts`
Expected: FAIL — `services/dto.ts` does not exist.

- [ ] **Step 4: Implement the mappers** — `packages/daemon/src/services/dto.ts`

```typescript
import type { BranchDto, ProjectDto, EndpointStatus } from "@devdb/shared";
import type { ProjectRow } from "../state/repos.js";
import type { BranchDetail } from "./branches.js";

export function toProjectDto(p: ProjectRow): ProjectDto {
  return { id: p.id, name: p.name, pgVersion: p.pgVersion, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

export function toBranchDto(b: BranchDetail): BranchDto {
  return {
    id: b.id, projectId: b.projectId, parentBranchId: b.parentBranchId, name: b.name, slug: b.slug,
    timelineId: b.timelineId, endpointStatus: b.endpointStatus as EndpointStatus,
    endpointError: b.endpointError, port: b.port, connectionString: b.connectionString,
    lastRecordLsn: b.lastRecordLsn, logicalSizeBytes: b.logicalSizeBytes, ancestorLsn: b.ancestorLsn,
    createdBy: b.createdBy as BranchDto["createdBy"], context: b.context,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  };
}
```

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/dto.test.ts`
Expected: PASS.

- [ ] **Step 6: Apply mappers at every REST response site** — `packages/daemon/src/http/api.ts`

Map each project/branch payload (import `toBranchDto`, `toProjectDto`). Exact sites:
- `POST /api/projects` (line 216-217): `const out = await …create(body); return reply.status(201).send({ project: toProjectDto(out.project), mainBranch: toBranchDto(await deps.services.branches.detail(out.mainBranch)) });`
- `GET /api/projects` (line 219): `return (…list()).map(toProjectDto);`
- `GET /api/projects/:id` (line 220-223): `return toProjectDto(…byIdOr404(id));`
- `POST /api/projects/:id/branches` (line 239): `return reply.status(201).send(toBranchDto(await …detail(branch)));`
- `GET /api/projects/:id/branches` (line 241-245): `return (await …list(id)).map(toBranchDto);`
- `GET /api/branches/:id` (line 246-249): `return toBranchDto(await …detail(…));`
- `POST /api/branches/:id/endpoint/start|stop` (256-263): wrap in `toBranchDto(await …)`.
- `POST /api/branches/:id/restore` (286-298) and `POST /api/branches/:id/reset` (300-303): wrap results in `toBranchDto(…)`.

(`GET /api/branches/:id/endpoint` at 264-268 already returns `{status, port}` — no password, leave it.)

- [ ] **Step 7: Genericize the project 409** — `packages/daemon/src/services/projects.ts:95`

```typescript
      throw new DevdbError(409, `project or branch identity conflicts with an existing one`);
```

(drop the `: ${(e as Error).message}` that leaked SQLite/`branches.slug` internals — matches `branches.ts:110`'s already-generic wording.)

- [ ] **Step 8: Update integration expectations if any assert on `password`**

Run: `rg "\.password" tests/integration` — expected: no hits on branch responses (the helper uses `connectionString`). If any surface, retarget them to `connectionString`.

- [ ] **Step 9: Full gate + commit**

Run: `pnpm --filter @devdb/daemon test`
Expected: green.

```bash
git add packages/shared/src/index.ts packages/daemon/src/services/dto.ts packages/daemon/src/http/api.ts \
  packages/daemon/src/services/projects.ts packages/daemon/test/dto.test.ts
git commit -m "feat: explicit wire DTOs drop password, surface context; genericize project 409"
```

---

## Task 4: Structured logging for compensation paths (parked §4.5)

Compensation/rollback paths currently use bare `console.error`, invisible to the SSE log surface. Introduce a small `Logger` that fans out to stderr (so Docker logs are unchanged) **and** `LogsService` on a subscribable `daemon:app` channel, then convert the service- and compute-layer compensation sites.

> **AMENDED (2026-07-03, execution):** Step 3's `createLogger(logs, channel = "app")` used the WRONG channel. The SSE route subscribes to `` `daemon:${component}` `` (so `/api/daemon/logs/app` reads channel `daemon:app`), and engine components ingest to their full `daemon:<name>` channel — so `createLogger`'s default must be **`"daemon:app"`** (ingest the full channel), not `"app"`, or the compensation logs land in a channel nobody reads (the feature is a silent no-op). Also: `fmt()` must be **total** — wrap `JSON.stringify(detail)` in try/catch (fallback `String`/`util.inspect`) since it runs inside best-effort compensation `.catch()` handlers where a throw would mask the original error and skip later cleanup; and all levels route to **stderr** (the `info→console.log` split contradicted the stated stderr fanout). A wiring test asserts a `logger.error` line reaches the exact `daemon:app` channel the route subscribes to. Commits 9dff797 (initial) + a7b1a02 (fix). `branches.ts:132` (read-enrichment resilience log) is intentionally left as bare `console.error` — not a compensation site.

**Files:**
- Create: `packages/daemon/src/logging/logger.ts`.
- Modify: `packages/daemon/src/http/api.ts:202-204` (add `"app"` to `DAEMON_LOG_COMPONENTS`).
- Modify: `packages/daemon/src/index.ts` (construct one `Logger`, inject into service/compute deps).
- Modify compensation sites: `services/branches.ts:106,108,131`; `services/projects.ts:107,109,206`; `services/endpoints.ts:78,85`; `services/timetravel.ts:216,218,227`; `compute/manager.ts:206,237,278,280,285`.
- Test: `packages/daemon/test/logger.test.ts` (new).

**Interfaces:**
- Produces: `Logger = { error(event: string, detail?: unknown): void; warn(event: string, detail?: unknown): void; info(event: string, detail?: unknown): void }`. `createLogger(logs: LogsService, channel?: string): Logger`. Injected as `deps.logger`.
- Consumes: `LogsService.ingest` (`services/logs.ts:11`).

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/logger.test.ts`

```typescript
import { describe, expect, it, vi } from "vitest";
import { LogsService } from "../src/services/logs.js";
import { createLogger } from "../src/logging/logger.js";

describe("createLogger", () => {
  it("ingests a formatted line into the daemon:app channel and writes stderr", () => {
    const logs = new LogsService();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger(logs);
    logger.error("compensation failed — orphaned timeline t1", new Error("boom"));
    const recent = logs.recent("app");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toContain("[error]");
    expect(recent[0]).toContain("orphaned timeline t1");
    expect(recent[0]).toContain("boom");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/logger.test.ts`
Expected: FAIL — `logging/logger.js` missing.

- [ ] **Step 3: Implement** — `packages/daemon/src/logging/logger.ts`

```typescript
import type { LogsService } from "../services/logs.js";

export interface Logger {
  error(event: string, detail?: unknown): void;
  warn(event: string, detail?: unknown): void;
  info(event: string, detail?: unknown): void;
}

function fmt(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` — ${detail.message}`;
  return ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
}

// channel is a LogsService channel name; it is exposed for SSE as `daemon:<channel>`
// via the DAEMON_LOG_COMPONENTS allowlist in http/api.ts (default "app").
export function createLogger(logs: LogsService, channel = "app"): Logger {
  const emit = (level: "error" | "warn" | "info", event: string, detail?: unknown) => {
    const line = `[${level}] ${event}${fmt(detail)}`;
    (level === "info" ? console.log : console.error)(line);
    logs.ingest(channel, line);
  };
  return {
    error: (e, d) => emit("error", e, d),
    warn: (e, d) => emit("warn", e, d),
    info: (e, d) => emit("info", e, d),
  };
}
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Expose the channel + inject the logger**

`http/api.ts:202-204` — add `"app"` to the set:
```typescript
  const DAEMON_LOG_COMPONENTS = new Set([
    "storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver", "app",
  ]);
```

`index.ts` — after `const logs = new LogsService()` (line 53), add `const logger = createLogger(logs);` and pass `logger` into the deps of `ProjectsService`/`BranchesService`/`EndpointsService`/`TimeTravelService`/`ComputeManager` (add `logger: Logger` to each service's `deps` type; the shared `ProjectsDeps` covers projects + branches).

- [ ] **Step 6: Convert the compensation sites**

Replace each listed `console.error(...)` with `this.deps.logger.error(...)` (services) or `this.logger.error(...)` (ComputeManager, per its constructor field). Keep the event text; pass the caught error as `detail`. Example — `services/branches.ts:105-108`:
```typescript
        await this.deps.pageserver.timelineDelete(project.id, timelineId).catch((c) =>
          this.deps.logger.error(`compensation failed — orphaned timeline ${timelineId} on pageserver`, c));
        await this.deps.safekeeper.timelineDelete(project.id, timelineId).catch((c) =>
          this.deps.logger.error(`compensation failed — orphaned timeline ${timelineId} on safekeeper`, c));
```
Leave `index.ts` shutdown/boot `console.error` (LogsService may be tearing down) and `engine/boot.ts` `console.log` (those are the log pump feeding channels) as-is. Update any unit test that asserted on `console.error` for a converted site to construct the service with a fake `logger` (`{ error: vi.fn(), warn: vi.fn(), info: vi.fn() }`) and assert on that.

- [ ] **Step 7: Full gate + commit**

Run: `pnpm --filter @devdb/daemon test`
Expected: green.

```bash
git add packages/daemon/src/logging packages/daemon/src/http/api.ts packages/daemon/src/index.ts \
  packages/daemon/src/services packages/daemon/src/compute/manager.ts packages/daemon/test/logger.test.ts
git commit -m "feat: route compensation logging through a LogsService-backed logger (daemon:app)"
```

---

## Task 5: Metrics-based compute readiness (parked §4.3)

Replace the "postmaster is listening" needle gate with a poll of `compute_ctl`'s auth-exempt `/metrics` for `compute_ctl_up{status="running"}` — set strictly **after** `apply_spec` commits — closing the first-start SCRAM auth window (R2). Then delete the two `connectWithRetry` masks that existed only to paper over it.

> **AMENDED (2026-07-03, execution):** the plan's readiness code was insufficient in two race-critical ways a review gate caught. (1) **`statusOf` must honor the readiness phase.** Gating only `start()`'s return leaves `ComputeManager.statusOf` returning `proc.state` ("running" at the needle) while `entry.phase` is still `"starting"`, so a concurrent unqueued `BranchesService.detail()` hands out a connection string mid-SCRAM-window — the very race being closed. `statusOf` now returns `"starting"` during phase `"starting"` (but `"failed"` if the proc crashed); `runningPorts` aligned to phase (`reservedPorts`, not `runningPorts`, governs allocation). (2) **`waitComputeReady` must be deadline-bounded and abortable.** The plan's version only checked the deadline BETWEEN attempts, so a hung `/metrics` fetch/body hangs `start()` forever; it now time-boxes each attempt with an `AbortController` (`PER_ATTEMPT_TIMEOUT_MS = 5000`, capped by remaining deadline), honors an external `signal` promptly (distinguished from the per-attempt abort), uses an abortable inter-poll sleep, and drains non-OK bodies. Also: `waitComputeReady` is an injected optional `ComputeManager` ctor arg (so unit tests don't hit real `fetch`), and `start()`'s catch wraps `proc.stop()` in try/catch (a readiness failure fires after `compute_ctl` is live; preserve the original error and always run map/dir/port cleanup — this also future-proofs Task 6's kill change). Commits bb9d7f2 (initial) + 540db5f (fix). Live retry-deletion verification deferred to Tasks 16/17 (Docker stalled this session).

**Files:**
- Create: `packages/daemon/src/compute/readiness.ts`.
- Modify: `packages/daemon/src/compute/manager.ts:139` (await readiness after `proc.start()`).
- Modify: `packages/daemon/src/services/sql.ts:30-46,74-83` (drop `connectWithRetry`, connect once).
- Modify: `tests/integration/helpers/pg.ts:26-45,47-56` (drop `connectWithRetry`, connect once).
- Test: `packages/daemon/test/readiness.test.ts` (new).

**Interfaces:**
- Produces: `parseComputeCtlUpStatus(metricsText: string): string | null`; `waitComputeReady(metricsPort: number, opts?: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<void>`.
- Consumes: `RunningCompute.metricsPort` (already allocated, `manager.ts:99-101`).

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/readiness.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { parseComputeCtlUpStatus, waitComputeReady } from "../src/compute/readiness.js";

const metrics = (s: "init" | "running" | "failed") => `# HELP compute_ctl_up ...
compute_ctl_up{status="init"} ${s === "init" ? 1 : 0}
compute_ctl_up{status="running"} ${s === "running" ? 1 : 0}
compute_ctl_up{status="failed"} ${s === "failed" ? 1 : 0}
`;

describe("parseComputeCtlUpStatus", () => {
  it("returns the status whose gauge value is 1", () => {
    expect(parseComputeCtlUpStatus(metrics("init"))).toBe("init");
    expect(parseComputeCtlUpStatus(metrics("running"))).toBe("running");
    expect(parseComputeCtlUpStatus("nothing here")).toBeNull();
  });
});

describe("waitComputeReady", () => {
  it("resolves once status flips to running", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, text: async () => metrics(calls < 3 ? "init" : "running") } as Response;
    }) as typeof fetch;
    await waitComputeReady(40123, { intervalMs: 1, fetchImpl });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("rejects on failed", async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => metrics("failed") }) as Response) as typeof fetch;
    await expect(waitComputeReady(40123, { intervalMs: 1, fetchImpl })).rejects.toThrow(/failed/);
  });

  it("rejects on timeout", async () => {
    const fetchImpl = (async () => ({ ok: true, text: async () => metrics("init") }) as Response) as typeof fetch;
    await expect(waitComputeReady(40123, { timeoutMs: 5, intervalMs: 1, fetchImpl })).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/readiness.test.ts`
Expected: FAIL — `compute/readiness.js` missing.

- [ ] **Step 3: Implement** — `packages/daemon/src/compute/readiness.ts`

```typescript
// Readiness gate for compute_ctl: poll its auth-exempt Prometheus /metrics (external-http-port)
// for compute_ctl_up{status="running"}, which compute_ctl sets strictly AFTER apply_spec commits
// (handover §4.3/§8.7). This closes the first-ever-start SCRAM window that the old "listening on
// IPv4 address" needle raced (~80-140ms early). /status is NOT usable: it demands a JWT against an
// empty jwks (permanent 400; --dev does not bypass).

export function parseComputeCtlUpStatus(metricsText: string): string | null {
  const m = metricsText.match(/^compute_ctl_up\{[^}]*status="([^"]+)"[^}]*\}\s+1(?:\.0+)?\s*$/m);
  return m ? m[1] : null;
}

export async function waitComputeReady(
  metricsPort: number,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 50_000;
  const intervalMs = opts.intervalMs ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status: string | null = null;
    try {
      const res = await fetchImpl(`http://127.0.0.1:${metricsPort}/metrics`, { signal: opts.signal });
      if (res.ok) status = parseComputeCtlUpStatus(await res.text());
    } catch {
      // metrics server not up yet, or a transient — keep polling until the deadline
    }
    if (status === "running") return;
    if (status === "failed") throw new Error(`compute_ctl reported status="failed" on metrics port ${metricsPort}`);
    if (Date.now() > deadline) {
      throw new Error(`compute readiness timed out after ${timeoutMs}ms (last status=${status ?? "unreachable"}) on :${metricsPort}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate `ComputeManager.start` on readiness** — `packages/daemon/src/compute/manager.ts`

After `await entry.proc.start();` (line 139) — the needle now only confirms compute_ctl is up enough to serve `/metrics` — add:
```typescript
      // Structural readiness gate (handover §4.3): the needle fires ~80-140ms before apply_spec
      // commits the branch's SCRAM verifier; block until compute_ctl_up{status="running"}.
      await waitComputeReady(metricsPort);
```
(import `waitComputeReady` from `./readiness.js`; `metricsPort` is in scope from line 99.)

- [ ] **Step 6: Delete the production retry mask** — `packages/daemon/src/services/sql.ts`

Remove `connectWithRetry` (lines 30-46) and its call site's retry wrapper (74-83); connect once via the same `makeClient()`/`new pg.Client(...)`. Update the sql unit test if it asserted retry behavior. Run `pnpm --filter @devdb/daemon test`.

- [ ] **Step 7: Delete the integration retry mask + verify live** — `tests/integration/helpers/pg.ts`

Remove `connectWithRetry` (26-45); in `connect` (47-56) call `client.connect()` once. Then prove the readiness gate holds under a real first-ever start:

Run: `pnpm --filter @devdb/integration test -- endpoints acceptance`
Expected: green with NO `password authentication failed` retries (previously masked). If it flakes on first-start auth, the readiness gate is wrong — do NOT restore the retry; fix `waitComputeReady`. (Docker under load flakes on unrelated timeouts — rerun once before diagnosing, per handover §3.5.)

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/compute/readiness.ts packages/daemon/src/compute/manager.ts \
  packages/daemon/src/services/sql.ts packages/daemon/test/readiness.test.ts tests/integration/helpers/pg.ts
git commit -m "feat: gate compute readiness on compute_ctl /metrics; delete SCRAM retry masks"
```

---

## Task 6: Process-group compute kill (parked §4.4)

Spawn each compute into its own process group and signal the group on stop, so `compute_ctl`'s postgres child (which it orphans on SIGTERM — R3) dies with it. `reapOrphanedPostgres` stays as a Linux-only backstop; boot-time `sweepComputesDir` still handles daemon-crash orphans.

> **AMENDED (2026-07-03, execution):** the plan's `stop()` sketch (SIGTERM → killer timer → `await exited` → `clearTimeout`) is correct for a NON-detached process but wrong for a detached group in two ways a review gate caught. (1) `compute_ctl` (the group leader) exits near-instantly on SIGTERM while its orphaned postgres — in the same group but in smart-shutdown — can survive; clearing the SIGKILL timer on the *leader's* exit means the survivor never gets the group SIGKILL, so the group-kill delivered only SIGTERM and left the actual force-kill to `reapOrphanedPostgres` (defeating §4.4's goal). The detached path now, after the leader exits, **polls the whole group** (`process.kill(-pid, 0)` → ESRCH) up to a single `deadline` and escalates a **group SIGKILL** if any member is still alive, resolving promptly when the group is empty. (2) That group-poll must NOT sit behind an unbounded `await exited`: a leader that itself ignores SIGTERM would hang `stop()` forever (wedging the `stopLocked` lane) — so the `killer = setTimeout(() => signal("SIGKILL"), timeoutMs)` is armed **before** `await exited` (a hung leader is force-killed at the deadline; SIGKILL reaches it as a group member, so `exited` then resolves). Start-failure cleanup is also group-aware. `signal()`/`killSignal` wraps every `process.kill` so `stop()` never rejects (ESRCH/EPERM = already gone). Commits fd32751 (initial) + 708c424 (group escalation) + 6ae22df (leader-await bound). Detached is scoped to computes only (asserted in tests). **Live-verified:** the full Phase-2A integration suite (7 files) passed against a fresh image, incl. endpoints stop/port-reuse.

> **SYNC POINT (handover §4.4):** Jordan has a session revisiting compute orphaning. BEFORE writing code: read current `compute/manager.ts` + `engine/process.ts` and `git log --oneline -20 main`; if a process-group or PDEATHSIG fix already landed, retarget this task to whatever remains (often just the unit test or a sibling path). Do not regress a stronger fix that main already has.

**Files:**
- Modify: `packages/daemon/src/engine/process.ts:48-52,131-146` (`detached` spawn option + group kill).
- Modify: `packages/daemon/src/compute/manager.ts:111-139` (pass `detached: true` for computes).
- Test: `packages/daemon/test/process-group.test.ts` (new).

**Interfaces:**
- Consumes: `ManagedProcess` opts (add `detached?: boolean`).
- Produces: computes spawned as group leaders; `ManagedProcess.stop` signals `-pid` when `detached`.

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/process-group.test.ts`

A real detached child that itself forks a grandchild; `stop()` must kill the whole group so the grandchild dies too.

```typescript
import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/engine/process.js";
import { setTimeout as delay } from "node:timers/promises";

describe("ManagedProcess detached group kill", () => {
  it("terminates the process group (child + grandchild) on stop", async () => {
    // parent prints its grandchild's pid, then both idle forever
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" });
      process.stdout.write("gpid:" + g.pid + "\\n");
      setInterval(()=>{},1e9);
    `;
    let grandPid = 0;
    const mp = new ManagedProcess({
      bin: process.execPath, args: ["-e", script], detached: true,
      readyNeedle: "gpid:", readyTimeoutMs: 5000,
      onLine: (l) => { const m = l.match(/gpid:(\d+)/); if (m) grandPid = Number(m[1]); },
    });
    await mp.start();
    expect(grandPid).toBeGreaterThan(0);
    await mp.stop(3000);
    await delay(200);
    // process.kill(pid, 0) throws ESRCH once the pid is gone
    expect(() => process.kill(grandPid, 0)).toThrow();
  });
});
```

(Adjust the `ManagedProcess` opts field names in the test to match `process.ts`'s actual `Opts` shape after reading it — `onLine`/`readyNeedle`/`readyTimeoutMs` are inferred from `manager.ts:123-126`.)

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/process-group.test.ts`
Expected: FAIL — grandchild survives (`stop()` kills only the direct child pid; the grandchild is orphaned, `kill(grandPid, 0)` does not throw).

- [ ] **Step 3: Implement detached spawn + group kill** — `packages/daemon/src/engine/process.ts`

Spawn (48-52):
```typescript
    child = spawn(this.opts.bin, this.opts.args, {
      env: this.opts.env ?? {},
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.opts.detached ?? false,
    });
```
Stop (131-146) — when detached, signal the negative pid (the group); fall back to the direct child on ESRCH/EPERM:
```typescript
    const pid = child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (this.opts.detached && pid) process.kill(-pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    signal("SIGTERM");
    const killer = setTimeout(() => signal("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(killer);
```
Add `detached?: boolean;` to the `Opts` interface.

- [ ] **Step 4: Spawn computes detached** — `packages/daemon/src/compute/manager.ts`

In the `ManagedProcess` construction (around 123-126), add `detached: true` to the opts. Engine binaries (broker/storcon/pageserver/safekeeper) keep `detached: false` — only computes need the group semantics.

- [ ] **Step 5: Verify GREEN + full gate**

Run: `pnpm --filter @devdb/daemon exec vitest run test/process-group.test.ts` → PASS.
Run: `pnpm --filter @devdb/daemon test` → green.

- [ ] **Step 6: Live verification** — the existing endpoints suite exercises live stop + immediate port reuse (the orphan symptom):

Run: `pnpm --filter @devdb/integration test -- endpoints`
Expected: green; stop frees the port with no lingering postgres.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/engine/process.ts packages/daemon/src/compute/manager.ts \
  packages/daemon/test/process-group.test.ts
git commit -m "feat: spawn computes in their own process group; group-kill on stop (no orphaned postgres)"
```

---

## Task 7: Add the MCP SDK dependency + pin its API surface

Add `@modelcontextprotocol/sdk` to the daemon, make the `allowBuilds` decision, add the client to the integration package, and — mirroring the oracle discipline for engine shapes — **record the exact transport/server API names** from the installed `.d.ts` so Tasks 8–11 reference facts, not guesses (R4).

**Files:**
- Modify: `packages/daemon/package.json` (dependency).
- Modify: `tests/integration/package.json` (devDependency for the test client).
- Modify: `pnpm-workspace.yaml` only if pnpm flags a build script.
- Create: `packages/daemon/test/mcp-smoke.test.ts`.
- Create: `packages/daemon/src/mcp/sdk-notes.md` (the pinned API reference).

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @devdb/daemon add @modelcontextprotocol/sdk
pnpm --filter @devdb/integration add -D @modelcontextprotocol/sdk
```
`minimumReleaseAge: 1440` makes pnpm resolve a ≥24h-old version (latest at planning time: 1.29.0; engines `node >=18`, `type: module`, pure-JS). If pnpm prints a "build scripts" approval prompt for the SDK or a transitive dep, STOP and record an explicit decision in `pnpm-workspace.yaml`'s `allowBuilds` (default **false** — the SDK needs no native build). Otherwise no `allowBuilds` change is needed.

- [ ] **Step 2: Pin the API surface** — read the installed types and write `packages/daemon/src/mcp/sdk-notes.md`

Run: `sed -n '1,80p' node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and the same for `server/mcp.d.ts`. Record, verbatim, the real names for: the transport constructor options (session-id generator, DNS-rebinding flag, host/origin allowlists, `onsessioninitialized`/`onsessionclosed`), `transport.handleRequest(req, res, parsedBody?)`, `transport.sessionId`, `McpServer` constructor (capabilities, `instructions`), `registerTool`/`tool` shape (ZodRawShape vs ZodObject), how to read client info (`server.server.getClientVersion()`), and `sendToolListChanged`. **If any name differs from what Tasks 8–11 assume, update those tasks' code to the pinned name — the pinned `.d.ts` wins.**

- [ ] **Step 3: Import smoke test** — `packages/daemon/test/mcp-smoke.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

describe("mcp sdk", () => {
  it("constructs a server and transport", () => {
    const server = new McpServer({ name: "devdb", version: "0.0.0" });
    expect(server).toBeDefined();
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "x" });
    expect(t).toBeDefined();
  });
});
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @devdb/daemon test` (tsc gate resolves the new types) → green.

```bash
git add packages/daemon/package.json tests/integration/package.json pnpm-lock.yaml pnpm-workspace.yaml \
  packages/daemon/src/mcp/sdk-notes.md packages/daemon/test/mcp-smoke.test.ts
git commit -m "chore: add @modelcontextprotocol/sdk (daemon + integration); pin SDK API surface"
```

---

## Task 8: Stateful MCP transport, `/mcp` mount, rebinding guard, session store

Mount a session-stateful Streamable-HTTP endpoint at `/mcp` on the existing Fastify app. Each `initialize` mints a session (per-session `McpServer` holding the client's `Implementation`), DNS-rebinding validation runs on every request, and an idle sweep evicts abandoned sessions (agents drop connections without a clean `DELETE`). No tools yet — this task lands the handshake.

> **AMENDED (2026-07-03, execution — SDK API pinned in Task 7, verified against installed `@modelcontextprotocol/sdk@1.29.0` `.d.ts`; supersedes the Step-7/8 code where they differ):** the plan's Step-8 `registerMcp` code used the transport's built-in DNS-rebinding options, which are **`@deprecated`** in 1.29.0. Corrections (see `packages/daemon/src/mcp/sdk-notes.md`):
> - **Rebinding guard is a Fastify hook, NOT a transport option.** Do the Host/Origin allowlist check in a Fastify `onRequest` (or `preHandler`) hook scoped to the `/mcp` routes — reject with 403 when `Host`/`Origin` is present and not in the allowlist (allowlist = `localhost`, `127.0.0.1`, `host.docker.internal` ± `:${httpPort}`, plus `cfg.mcpAllowedHosts`/`mcpAllowedOrigins`). Do NOT pass `enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins` to the transport.
> - **Transport ctor:** `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => {…} })` — `onsessioninitialized`/`onsessionclosed` ARE ctor options. Import the class from `@modelcontextprotocol/sdk/server/streamableHttp.js` (options type lives in `webStandardStreamableHttp.d.ts`).
> - **`onclose` is a post-construction property:** set `transport.onclose = () => { const id = transport.sessionId; if (id) void store.delete(id); }` AFTER `new`, not in the ctor.
> - **`McpServer`:** `new McpServer({ name: "devdb", version: <PACKAGE_VERSION> }, { capabilities: { tools: { listChanged: true } }, instructions: MCP_INSTRUCTIONS })` — capabilities/instructions in the 2nd (`ServerOptions`) arg.
> - **Client info:** read via `server.server.getClientVersion()` (the inner `Server`), returns `Implementation | undefined`.
> - Everything else (`transport.handleRequest(req.raw, reply.raw, req.body)`, `transport.sessionId`, `isInitializeRequest` from `@modelcontextprotocol/sdk/types.js`, `SessionStore`, idle sweep, `mcp.closeAll()` in `preClose`) stands as written.

> **AMENDED (2026-07-03, execution — security hardening after review):** the guard and lifecycle needed substantial hardening (three review passes incl. an attacker-mindset Fable review found a Critical bypass). Final shape: (1) the Host/Origin guard **fails CLOSED** on a missing/unparseable `Host`, rejects **duplicate** `Host`/`Origin` via a `req.raw.rawHeaders` count (Node collapses `req.headers.host` to the first value, so raw-header counting is the only Host-smuggling defense), and parses authorities via `new URL('http://'+authority).hostname` with lowercase + trailing-dot canonicalization + userinfo rejection (NOT `split(':')[0]`), applied symmetrically to request headers AND the config allowlist; IPv6 is stored bracketed (`[::1]`) because `URL().hostname` retains brackets on Node 25. (2) **CRITICAL:** the guard gates on **`req.routeOptions?.url !== "/mcp"`** (the router's matched-route pattern), NOT the raw `req.url` — the raw-string check was bypassable via `POST /%6dcp` (percent-encoded → routes to `/mcp` but the raw string ≠ `"/mcp"` → guard skipped). (3) `transport.onclose` is **pure map-removal**; `delete`/`sweep`/`closeAll` are the sole `transport.close()` owners (no double-close on the client-disconnect path). (4) the premature `tools` capability was dropped from `buildMcpServer` — the SDK auto-advertises it when Task 9 registers the first tool. Commits 2ff936c (impl) + ddc274c (guard/lifecycle fix) + 15c8005 (bypass fix). Handshake integration live-green (3/3). Open Minors (ledgered, non-exploitable): Origin path could also reject userinfo for symmetry; `countRawHeader` case-normalize its arg.

**Files:**
- Modify: `packages/daemon/src/config.ts:14-20,22-37,39-84` (`DEVDB_MCP_ALLOWED_HOSTS/ORIGINS`).
- Create: `packages/daemon/src/mcp/instructions.ts`.
- Create: `packages/daemon/src/mcp/server.ts` (`buildMcpServer`).
- Create: `packages/daemon/src/mcp/session.ts` (`SessionStore`).
- Create: `packages/daemon/src/mcp/http.ts` (`registerMcp`).
- Modify: `packages/daemon/src/http/api.ts:39-40,315` (call `registerMcp(app, deps)` before `return app`; add MCP session cleanup to the `preClose` hook).
- Test: `packages/daemon/test/mcp-session.test.ts`; integration smoke folded into Task 16's file or a minimal `tests/integration/mcp-handshake.test.ts`.

**Interfaces:**
- Produces: `registerMcp(app: FastifyInstance, deps: Deps): { closeAll: () => Promise<void> }`. `SessionStore` with `create/get/touch/delete/sweep/closeAll`. `buildMcpServer(deps: Deps, getClientInfo: () => { name: string; version: string } | undefined): McpServer`. Config gains `mcpAllowedHosts: string[]`, `mcpAllowedOrigins: string[]`.
- Consumes: pinned SDK names from Task 7; `Deps` (`http/api.ts:28-37`).

- [ ] **Step 1: Config env vars** — `packages/daemon/src/config.ts`

`EnvSchema` (14-20): add `DEVDB_MCP_ALLOWED_HOSTS: z.string().optional()`, `DEVDB_MCP_ALLOWED_ORIGINS: z.string().optional()`. `DevdbConfig` (22-37): add `mcpAllowedHosts: string[]; mcpAllowedOrigins: string[];`. `loadConfig()` return (after 84): `mcpAllowedHosts: e.DEVDB_MCP_ALLOWED_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []`, same for origins.

- [ ] **Step 2: Write the failing SessionStore test** — `packages/daemon/test/mcp-session.test.ts`

```typescript
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/mcp/session.js";

describe("SessionStore", () => {
  it("sweeps sessions idle past the TTL and closes them", () => {
    const closed: string[] = [];
    const store = new SessionStore({ ttlMs: 1000 });
    const mk = (id: string) => ({ transport: { close: async () => { closed.push(id); } }, server: {}, lastSeen: 0 }) as never;
    store.set("s1", mk("s1"));
    store.set("s2", mk("s2"));
    store.touch("s2", 2000);        // s2 seen at t=2000
    store.sweep(2500);              // t=2500: s1 idle since 0 (>1000) → evicted; s2 fresh
    expect(closed).toEqual(["s1"]);
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
  });
});
```

- [ ] **Step 3: Verify RED** → `pnpm --filter @devdb/daemon exec vitest run test/mcp-session.test.ts` (FAIL: no module).

- [ ] **Step 4: Implement `SessionStore`** — `packages/daemon/src/mcp/session.ts`

```typescript
export interface McpSession {
  transport: { close: () => Promise<void>; handleRequest: (...a: never[]) => Promise<void>; sessionId?: string };
  server: { close: () => Promise<void> };
  lastSeen: number;
}

export class SessionStore {
  private sessions = new Map<string, McpSession>();
  constructor(private opts: { ttlMs: number }) {}
  set(id: string, s: McpSession): void { this.sessions.set(id, s); }
  get(id: string): McpSession | undefined { return this.sessions.get(id); }
  touch(id: string, now: number): void { const s = this.sessions.get(id); if (s) s.lastSeen = now; }
  size(): number { return this.sessions.size; }
  async delete(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.transport.close().catch(() => {});
  }
  sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.opts.ttlMs) { this.sessions.delete(id); void s.transport.close().catch(() => {}); }
    }
  }
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.transport.close().catch(() => {})));
  }
}
```

- [ ] **Step 5: Verify GREEN** → PASS.

- [ ] **Step 6: The instructions text** — `packages/daemon/src/mcp/instructions.ts`

```typescript
// Surfaced in the MCP initialize response so agents get the branch-per-task discipline even with
// zero skills installed (refinement spec Decision 3).
export const MCP_INSTRUCTIONS = `DevDB gives each agent an isolated, writable copy of a database — worktree : files :: branch : data.

Workflow:
- Create one branch per task off \`main\`: create_branch with name "agent/<task-slug>" and a fork context
  (git_branch, workdir, purpose). It auto-starts an endpoint and returns a connection string.
- Wire that connection string into your worktree's environment. Work destructively — main is untouched.
- Never share one branch between concurrent agents. Use get_branch to re-fetch a connection string.
- reset_branch to scrap changes and match the parent again; restore_branch to recover a past point.
- delete_branch when the task is done.

Always pass fork context on create_branch so a human can tell parallel agents' branches apart.`;
```

- [ ] **Step 7: `buildMcpServer`** — `packages/daemon/src/mcp/server.ts` (tools added in Tasks 9–11; here it registers none)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../http/api.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
// import { registerTools } from "./tools.js";   // ← uncommented in Task 9

export interface ToolCtx { deps: Deps; clientInfo: () => { name: string; version: string } | undefined; }

export function buildMcpServer(deps: Deps, getClientInfo: ToolCtx["clientInfo"]): McpServer {
  const server = new McpServer(
    { name: "devdb", version: deps.cfg /* version string; see api.ts PACKAGE_VERSION */ ? "phase2" : "phase2" },
    { capabilities: { tools: { listChanged: true } }, instructions: MCP_INSTRUCTIONS },
  );
  // registerTools(server, { deps, clientInfo: getClientInfo });   // ← Task 9
  return server;
}
```
(Version string: reuse the package version. Export `PACKAGE_VERSION` from `http/api.ts` or read it here the same way; wire the real value when Task 9 lands `registerTools`.)

- [ ] **Step 8: `registerMcp`** — `packages/daemon/src/mcp/http.ts`

Glue Fastify ↔ the SDK transport. Confirm `handleRequest`/option names against `sdk-notes.md` (Task 7).

```typescript
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "../http/api.js";
import { SessionStore } from "./session.js";
import { buildMcpServer } from "./server.js";

export function registerMcp(app: FastifyInstance, deps: Deps): { closeAll: () => Promise<void> } {
  const store = new SessionStore({ ttlMs: 10 * 60_000 });
  const sweep = setInterval(() => store.sweep(Date.now()), 60_000);
  sweep.unref();

  const port = deps.cfg.httpPort;
  const baseHosts = ["localhost", "127.0.0.1", "host.docker.internal"];
  const allowedHosts = [...new Set([...baseHosts.flatMap((h) => [h, `${h}:${port}`]), ...deps.cfg.mcpAllowedHosts])];
  const allowedOrigins = deps.cfg.mcpAllowedOrigins.length
    ? deps.cfg.mcpAllowedOrigins
    : baseHosts.map((h) => `http://${h}:${port}`);

  app.post("/mcp", async (req, reply) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let session = sid ? store.get(sid) : undefined;

    if (!session && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts, allowedOrigins,
        onsessioninitialized: (id: string) => {
          store.set(id, { transport, server: server.server, lastSeen: Date.now() } as never);
        },
      });
      const server = buildMcpServer(deps, () => server.server.getClientVersion());
      transport.onclose = () => { const id = transport.sessionId; if (id) void store.delete(id); };
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
      return;
    }
    if (!session) {
      return reply.status(400).send({ error: "no valid MCP session — send an initialize request first" });
    }
    store.touch(sid!, Date.now());
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const streamOrDelete = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const session = sid ? store.get(sid) : undefined;
    if (!session) return reply.status(400).send({ error: "unknown or missing mcp-session-id" });
    store.touch(sid!, Date.now());
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", streamOrDelete);
  app.delete("/mcp", streamOrDelete);

  return { closeAll: async () => { clearInterval(sweep); await store.closeAll(); } };
}
```
(Note the `server`/`onsessioninitialized` ordering: `buildMcpServer` must be constructed before `handleRequest`; adjust so `onsessioninitialized` closes over the built `server` — in implementation, build the server first, then the transport referencing it, or store `{transport, server}` in `onsessioninitialized` using the already-built `server`. Keep the final wiring faithful to the SDK's callback timing per `sdk-notes.md`.)

- [ ] **Step 9: Mount + shutdown wiring** — `packages/daemon/src/http/api.ts`

Before `return app;` (line 315): `const mcp = registerMcp(app, deps);` and register cleanup in the existing `preClose` hook (74-76): `await mcp.closeAll();`. This ensures in-flight MCP streams are closed within the 45s shutdown budget alongside SSE.

- [ ] **Step 10: Integration handshake smoke** — `tests/integration/mcp-handshake.test.ts`

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("mcp handshake", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("initializes, exposes instructions, lists tools", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    expect(client.getInstructions()).toContain("branch per task");
    const { tools } = await client.listTools();
    expect(Array.isArray(tools)).toBe(true);   // 0 tools until Task 9
    await client.close();
  });
});
```

- [ ] **Step 11: Verify + commit**

Run: `pnpm --filter @devdb/daemon test` → green. `pnpm --filter @devdb/integration test -- mcp-handshake` → green.

```bash
git add packages/daemon/src/config.ts packages/daemon/src/mcp packages/daemon/src/http/api.ts \
  packages/daemon/test/mcp-session.test.ts tests/integration/mcp-handshake.test.ts
git commit -m "feat: session-stateful MCP transport at /mcp with DNS-rebinding guard + idle eviction"
```

---

## Task 9: Response helpers + the five read tools

Add the MCP response contract helpers and register the non-mutating tools: `get_status`, `list_projects`, `create_project`, `list_branches`, `get_branch`. Every response opens with a context line and ends with a next-step hint; every error names a remediation.

**Files:**
- Create: `packages/daemon/src/mcp/format.ts`.
- Create: `packages/daemon/src/mcp/tools.ts` (`registerTools` + the read tools).
- Modify: `packages/daemon/src/mcp/server.ts` (call `registerTools`; wire real version string).
- Modify: `packages/daemon/src/services/projects.ts` + `branches.ts` (add `byNameOr404` resolvers).
- Test: `packages/daemon/test/mcp-tools.test.ts`.

**Interfaces:**
- Produces: `text(s: string)`, `errorResult(remediation: string)`, `contextLine(a: {project: string; branch?: string; parent?: string})`, `nowIso()` in `format.ts`. `registerTools(server: McpServer, ctx: ToolCtx): void`. `ProjectsService.byNameOr404(name): ProjectRow`; `BranchesService.byProjectAndNameOr404(projectId, name): BranchRow`.
- Consumes: `toBranchDto`/`toProjectDto` (Task 3), services, `ToolCtx` (Task 8).

- [ ] **Step 1: Resolvers** — thin, clean 404s the tools reuse

`projects.ts`:
```typescript
byNameOr404(name: string): ProjectRow {
  const p = this.deps.state.projects.byName(name.trim());
  if (!p) throw new DevdbError(404, `project "${name}" not found — call list_projects to see available projects`);
  return p;
}
```
`branches.ts`:
```typescript
byProjectAndNameOr404(projectId: string, name: string): BranchRow {
  const b = this.deps.state.branches.byProjectAndName(projectId, name.trim());
  if (!b) throw new DevdbError(404, `branch "${name}" not found in this project — call list_branches`);
  return b;
}
```

- [ ] **Step 2: Write the failing tool test** — `packages/daemon/test/mcp-tools.test.ts`

Construct real services over in-memory state + engine `fakes()`, register tools onto a real `McpServer`, and call through the SDK's in-memory linked transport (or call the handler map directly). Simplest: expose the tool handlers for direct unit calls.

```typescript
import { describe, expect, it } from "vitest";
import { makeReadToolsHarness } from "./helpers/mcp-harness.js"; // builds services + ctx over :memory:

describe("read tools", () => {
  it("list_projects opens with a context line and lists created projects", async () => {
    const h = makeReadToolsHarness();
    await h.call("create_project", { name: "shop" });
    const res = await h.call("list_projects", {});
    expect(res.content[0].text).toMatch(/shop/);
  });

  it("get_branch on a missing project returns an actionable error", async () => {
    const h = makeReadToolsHarness();
    const res = await h.call("get_branch", { project: "nope", branch: "main" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/list_projects/);
  });
});
```
(Add `packages/daemon/test/helpers/mcp-harness.ts` building `{ deps, call(name, args) }` — reuse the `fakes()` engine helper + `openState(":memory:")` + a fake `logger`. Keep it typed, no `as any` on the engine fakes.)

- [ ] **Step 3: Verify RED** → module/harness missing.

- [ ] **Step 4: Implement `format.ts`**

```typescript
export interface ToolResult { content: Array<{ type: "text"; text: string }>; isError?: boolean; }
export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
export const errorResult = (remediation: string): ToolResult => ({ content: [{ type: "text", text: remediation }], isError: true });
export const nowIso = (): string => new Date().toISOString();
export function contextLine(a: { project: string; branch?: string; parent?: string }): string {
  let s = `[devdb] project "${a.project}"`;
  if (a.branch) s += ` · branch "${a.branch}"`;
  if (a.parent) s += ` (forked from "${a.parent}")`;
  return s;
}
```

- [ ] **Step 5: Implement `tools.ts` read tools + `registerTools`**

Each tool: a zod raw shape + a handler that resolves names→rows, calls services, and returns `text(...)`. Wrap every handler in a try/catch that maps `DevdbError`/`Error` to `errorResult(err.message)` (the services already phrase remediations). Example for `get_branch`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "./server.js";
import { toBranchDto, toProjectDto } from "../services/dto.js";
import { text, errorResult, contextLine } from "./format.js";

function renderBranch(dto: ReturnType<typeof toBranchDto>): string {
  const conn = dto.connectionString ? `\n  connection: ${dto.connectionString}` : "\n  (endpoint stopped)";
  const ctx = dto.context ? `\n  fork: ${JSON.stringify(dto.context)}` : "";
  return `  ${dto.name} [${dto.endpointStatus}] created_by=${dto.createdBy}${ctx}${conn}`;
}

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  const { deps } = ctx;
  const guard = (fn: (a: never) => Promise<ReturnType<typeof text>>) => async (a: never) => {
    try { return await fn(a); } catch (e) { return errorResult(e instanceof Error ? e.message : String(e)); }
  };

  server.registerTool("get_branch", {
    description: "Fetch a branch's status + connection string (the 'switch' move). Starts the endpoint by default.",
    inputSchema: { project: z.string(), branch: z.string(), ensure_running: z.boolean().default(true) },
  }, guard(async ({ project, branch, ensure_running }: { project: string; branch: string; ensure_running: boolean }) => {
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

  // get_status, list_projects, create_project, list_branches — same pattern:
  //  get_status     → { version, healthy, engine: deps.engine.status() } summarized to text.
  //  list_projects  → deps.services.projects.list().map(toProjectDto), one line each + "Next: create_branch".
  //  create_project → deps.services.projects.create({ name, pgVersion }); report project + main branch (stopped);
  //                   "Next: create_branch to get an isolated working copy."  (pgVersion via PgVersionSchema.optional())
  //  list_branches  → resolve project, deps.services.branches.list(p.id).map(toBranchDto), rendered as a tree with
  //                   created_by + fork context (renderBranch), so a human/agent sees whose fork is whose.
}
```
Wire `create_project`'s `pgVersion` to `PgVersionSchema.optional()` (supported majors are **14–17**; there is no 18 in the pinned image — do not invent it). Uncomment `registerTools(server, { deps, clientInfo: getClientInfo })` in `server.ts` and set the real version string.

- [ ] **Step 6: Verify GREEN + gate**

Run: `pnpm --filter @devdb/daemon exec vitest run test/mcp-tools.test.ts` → PASS. `pnpm --filter @devdb/daemon test` → green (tsc gate proves the zod shapes type-check against handlers).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/mcp/format.ts packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/server.ts \
  packages/daemon/src/services/projects.ts packages/daemon/src/services/branches.ts packages/daemon/test/
git commit -m "feat: MCP read tools (status, projects, list/get branches) with actionable responses"
```

---

## Task 10: `create_branch` — the flagship tool

Create a branch (optionally at a past timestamp), attach fork context merged with the session's captured `clientInfo`, auto-start its endpoint, and return the connection string with a next-step hint. `createdBy` is `"mcp"`.

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts` (add `create_branch`).
- Test: `packages/daemon/test/mcp-tools.test.ts` (extend).

**Interfaces:**
- Consumes: `TimeTravelService.lsnAtTimestamp` (resolve `at_timestamp`→LSN on the parent), `BranchesService.create` (Task 2 `context`), `EndpointsService.ensureRunning`, `ToolCtx.clientInfo`.

- [ ] **Step 1: Failing test** (extend `mcp-tools.test.ts`)

```typescript
it("create_branch returns a connection string and records fork context incl. client", async () => {
  const h = makeReadToolsHarness({ clientInfo: { name: "claude-code", version: "9.9" } });
  await h.call("create_project", { name: "shop" });
  const res = await h.call("create_branch", {
    project: "shop", name: "agent/try-index",
    context: { git_branch: "feat/idx", workdir: "/w", purpose: "add an index" },
  });
  expect(res.isError).toBeFalsy();
  expect(res.content[0].text).toMatch(/postgresql:\/\//);
  const list = await h.call("list_branches", { project: "shop" });
  expect(list.content[0].text).toMatch(/claude-code/);   // client folded into stored context
  expect(list.content[0].text).toMatch(/add an index/);
});
```
(The harness's `ensureRunning` uses the engine `fakes()` — `computes.start` returns `{ port: 1 }`, `statusOf`→"running" after start — so `connectionString` renders. Configure the fake to report running post-start, mirroring `branches-service.test.ts`.)

- [ ] **Step 2: Verify RED** → tool not registered.

- [ ] **Step 3: Implement `create_branch`** — in `tools.ts`

```typescript
server.registerTool("create_branch", {
  description: "Create an isolated branch (the 'new worktree' move). Auto-starts an endpoint and returns a connection string. Pass fork context.",
  inputSchema: {
    project: z.string(), name: z.string(),
    parent: z.string().optional(), at_timestamp: z.string().optional(),
    context: BranchContextInputSchema.optional(),  // git_branch/workdir/agent/purpose (client is server-added)
  },
}, guard(async ({ project, name, parent, at_timestamp, context }) => {
  const p = deps.services.projects.byNameOr404(project);
  const parentRow = parent ? deps.services.branches.byProjectAndNameOr404(p.id, parent) : undefined;
  let atLsn: string | undefined;
  if (at_timestamp) {
    const src = parentRow ?? deps.services.branches.byProjectAndNameOr404(p.id, "main");
    atLsn = await deps.services.timetravel.lsnAtTimestamp(src.id, at_timestamp);   // ISO tz enforced downstream
  }
  const merged = { ...(context ?? {}), client: ctx.clientInfo() };
  const branch = await deps.services.branches.create({
    projectId: p.id, name, parentBranchId: parentRow?.id, atLsn, createdBy: "mcp", context: merged,
  });
  const detail = await deps.services.endpoints.ensureRunning(branch.id);
  const dto = toBranchDto(detail);
  return text(
    `${contextLine({ project: p.name, branch: branch.name, parent: parentRow?.name ?? "main" })}\n` +
    `${renderBranch(dto)}\n` +
    `Next: wire the connection string into your worktree env; delete_branch when the task is done.`,
  );
}));
```
Define `BranchContextInputSchema` (the four caller fields, no `client`) in `format.ts` or import a client-less variant of `BranchContextSchema` from shared. Keep `merged.client` undefined-safe (a client that skipped a proper `initialize` yields `undefined`).

- [ ] **Step 4: GREEN + gate + commit**

Run: `pnpm --filter @devdb/daemon exec vitest run test/mcp-tools.test.ts` → PASS. `pnpm --filter @devdb/daemon test` → green.

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/format.ts packages/daemon/test/mcp-tools.test.ts
git commit -m "feat: create_branch MCP tool — auto-start endpoint, fork context, connection string"
```

---

## Task 11: Branch-mutation tools — `stop_endpoint`, `delete_branch`, `reset_branch`, `restore_branch`

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts`.
- Test: `packages/daemon/test/mcp-tools.test.ts` (extend).

**Interfaces:**
- Consumes: `EndpointsService.stop`, `BranchesService.delete`, `TimeTravelService.{resetToParent, restoreInPlace, branchAtTimestamp}`.
- Resolved ambiguity: `restore_branch`'s `as_new_branch?` is typed as an **optional string = the new branch's name**. Present ⇒ non-destructive recover into that new branch (recommended); absent ⇒ in-place restore (auto-stops/restarts the endpoint, and the response says so). This reconciles the spec's `as_new_branch?` flag with `branchAtTimestamp`'s required `name`.

- [ ] **Step 1: Failing tests** (extend) — cover: `reset_branch` reports parent match; `delete_branch` with children returns the "delete them first" remediation; `restore_branch` with `as_new_branch` returns a new connection string; `restore_branch` without it reports in-place.

```typescript
it("delete_branch surfaces the children-exist remediation", async () => {
  const h = makeReadToolsHarness();
  await h.call("create_project", { name: "shop" });
  await h.call("create_branch", { project: "shop", name: "parent" });
  await h.call("create_branch", { project: "shop", name: "child", parent: "parent" });
  const res = await h.call("delete_branch", { project: "shop", branch: "parent" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/delete them first/);
});
```

- [ ] **Step 2: Verify RED.**

- [ ] **Step 3: Implement the four tools** — pattern (resolve → service → `text`), all wrapped in `guard`:

```typescript
server.registerTool("stop_endpoint", { description: "Stop a branch's endpoint (frees its port).",
  inputSchema: { project: z.string(), branch: z.string() } },
  guard(async ({ project, branch }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const dto = toBranchDto(await deps.services.endpoints.stop(b.id));
    return text(`${contextLine({ project: p.name, branch: b.name })}\n  endpoint ${dto.endpointStatus}.\nNext: get_branch to restart it.`);
  }));

server.registerTool("delete_branch", { description: "Delete a branch. Fails if it has children (they are listed).",
  inputSchema: { project: z.string(), branch: z.string() } },
  guard(async ({ project, branch }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    await deps.services.branches.delete(b.id);
    return text(`${contextLine({ project: p.name, branch: b.name })}\n  deleted.`);
  }));

server.registerTool("reset_branch", { description: "Discard a branch's changes; back to the parent's current state (the 'scrap and retry' move).",
  inputSchema: { project: z.string(), branch: z.string() } },
  guard(async ({ project, branch }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    const dto = toBranchDto(await deps.services.timetravel.resetToParent(b.id));
    const conn = dto.connectionString ? `\n  connection: ${dto.connectionString}` : "";
    return text(`${contextLine({ project: p.name, branch: dto.name })}\n  reset to parent.${conn}`);
  }));

server.registerTool("restore_branch", {
  description: "Restore a branch to a past ISO-8601 timestamp. Provide as_new_branch (a name) to recover non-destructively into a new branch; omit for in-place.",
  inputSchema: { project: z.string(), branch: z.string(), to_timestamp: z.string(),
    as_new_branch: z.string().optional(), context: BranchContextInputSchema.optional() } },
  guard(async ({ project, branch, to_timestamp, as_new_branch, context }) => {
    const p = deps.services.projects.byNameOr404(project);
    const b = deps.services.branches.byProjectAndNameOr404(p.id, branch);
    if (as_new_branch) {
      const nb = await deps.services.timetravel.branchAtTimestamp({
        projectId: p.id, sourceBranchId: b.id, name: as_new_branch, isoTimestamp: to_timestamp,
        createdBy: "mcp", context: { ...(context ?? {}), client: ctx.clientInfo() },
      });
      const dto = toBranchDto(await deps.services.endpoints.ensureRunning(nb.id));
      return text(`${contextLine({ project: p.name, branch: nb.name, parent: b.name })}\n${renderBranch(dto)}\nNext: verify the recovered data, then keep or delete_branch.`);
    }
    const dto = toBranchDto(await deps.services.timetravel.restoreInPlace(b.id, to_timestamp));
    const conn = dto.connectionString ? `\n  connection: ${dto.connectionString}` : "";
    return text(`${contextLine({ project: p.name, branch: dto.name })}\n  restored in place to ${to_timestamp} (endpoint auto-stopped and restarted).${conn}`);
  }));
```

- [ ] **Step 4: GREEN + gate + commit**

Run: `pnpm --filter @devdb/daemon test` → green.

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/test/mcp-tools.test.ts
git commit -m "feat: MCP mutation tools — stop_endpoint, delete_branch, reset_branch, restore_branch"
```

---

## Task 12: REST fork-context parity

The spec requires non-MCP callers to attach the same fork context. Accept optional `context` on `POST /api/projects/:id/branches`; the DTO already returns it (Task 3).

**Files:**
- Modify: `packages/daemon/src/http/api.ts:230-240`.
- Test: `packages/daemon/test/*` unit or `tests/integration/*` — a REST create with context, asserting it round-trips in the branch DTO.

- [ ] **Step 1: Failing test** — REST `POST /api/projects/:id/branches` with a `context` body returns a branch DTO whose `context` matches. Add to an existing REST/branches test (or a small integration assertion via `api()` helper).

- [ ] **Step 2: Verify RED** (context stripped/ignored today).

- [ ] **Step 3: Implement** — `http/api.ts`

```typescript
import { PgVersionSchema, BranchContextSchema } from "@devdb/shared";
// ...
  const CreateBranch = z.object({
    name: z.string(),
    parentBranchId: z.string().optional(),
    atLsn: z.string().optional(),
    context: BranchContextSchema.optional(),
  });
  app.post("/api/projects/:id/branches", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateBranch.parse(req.body);
    const branch = await deps.services.branches.create({ projectId: id, ...body, createdBy: "api" });
    return reply.status(201).send(toBranchDto(await deps.services.branches.detail(branch)));
  });
```

- [ ] **Step 4: GREEN + gate + commit**

Run: `pnpm --filter @devdb/daemon test` → green.

```bash
git add packages/daemon/src/http/api.ts packages/daemon/test/
git commit -m "feat: REST branch create accepts optional fork context (parity with MCP)"
```

---

## Task 13: Loopback binding + README (MCP setup, skills, env vars)

Bind the published ports to `127.0.0.1` (spec posture) and document registration, skill install, and the new env vars.

**Files:**
- Modify: `docker/compose.yaml:6-8`.
- Modify: `README.md` (new sections after `## Quickstart`).

- [ ] **Step 1: Loopback binding** — `docker/compose.yaml`

```yaml
    ports:
      - "127.0.0.1:4400:4400"
      - "127.0.0.1:54300-54339:54300-54339"
```

- [ ] **Step 2: README — MCP + skills + env vars.** Add after `## Quickstart`:

```markdown
## MCP server (for AI agents)

DevDB exposes an MCP server at `http://localhost:4400/mcp` (Streamable HTTP). Register it:

    claude mcp add --transport http devdb http://localhost:4400/mcp

Tools: `list_projects`, `create_project`, `list_branches`, `create_branch` (auto-starts an endpoint
and returns a connection string), `get_branch`, `stop_endpoint`, `delete_branch`, `reset_branch`,
`restore_branch`, `get_status`. (Import/export tools arrive in a later release.)

The server is unauthenticated (localhost trust) but validates `Host`/`Origin` to block DNS-rebinding.
Reaching it from another host or a custom hostname:

- Publish wider by overriding the compose port binding (drop the `127.0.0.1:` prefix) — you accept the exposure.
- Add the hostname to the allowlist: `DEVDB_MCP_ALLOWED_HOSTS=myhost:4400` / `DEVDB_MCP_ALLOWED_ORIGINS=http://myhost:4400`.

## Agent skills

Copy the shipped skills into your agent's skills directory:

    cp -r skills/using-devdb skills/safe-db-migrations ~/.claude/skills/     # global
    # or into a project: cp -r skills/* /path/to/repo/.claude/skills/

Even with no skills installed, connected agents receive the core branch-per-task workflow via the
MCP server's `initialize` instructions.
```

- [ ] **Step 3: Commit**

```bash
git add docker/compose.yaml README.md
git commit -m "docs: loopback-bind published ports; README MCP setup, skills install, allowlist env vars"
```

---

## Task 14: `using-devdb` skill

**Files:** Create `skills/using-devdb/SKILL.md`. Match the in-repo convention (`.claude/skills/*/SKILL.md`): YAML frontmatter `name` + `description`, then `# Title` + sections. Reference MCP tool names **exactly**.

- [ ] **Step 1: Write the skill**

```markdown
---
name: using-devdb
description: Use when starting a task that will touch a database - gives each agent an isolated writable branch (worktree : files :: branch : data) via the devdb MCP server, mirroring git-worktree discipline.
---

# Using DevDB

## Overview

DevDB branches are to data what git worktrees are to code: an instant, isolated, writable copy you
work in destructively and throw away. One branch per task. Never share a branch between concurrent agents.

## Workflow

1. **Branch off `main`** with `create_branch`, name `agent/<task-slug>`, and ALWAYS pass fork context:
   - `git_branch`: `git branch --show-current`
   - `workdir`: your worktree path (`$PWD`)
   - `purpose`: one line describing the task
   The tool auto-starts an endpoint and returns a connection string.
2. **Wire the connection string** into your worktree's environment (e.g. `DATABASE_URL`).
3. **Work destructively.** `main` is untouched. Re-fetch a connection string any time with `get_branch`.
4. **Scrap and retry** with `reset_branch` (back to the parent's state) if you need a clean slate.
5. **Clean up** with `delete_branch` when the task completes.

## Rules

- One branch per task; never point two concurrent agents at the same branch.
- Always pass fork context — it's how a human tells parallel agents' branches apart in the dashboard.
- Stop endpoints you no longer need (`stop_endpoint`) to free ports; `get_branch` restarts them.
```

- [ ] **Step 2: Commit**

```bash
git add skills/using-devdb/SKILL.md
git commit -m "feat: ship using-devdb agent skill (branch-per-task discipline)"
```

---

## Task 15: `safe-db-migrations` skill

**Files:** Create `skills/safe-db-migrations/SKILL.md`.

- [ ] **Step 1: Write the skill**

```markdown
---
name: safe-db-migrations
description: Use before running a schema migration or destructive SQL against a database - rehearse it on a throwaway devdb branch, verify, then apply to main, with restore_branch as the undo.
---

# Safe DB Migrations

## Overview

Never rehearse a migration on `main`. DevDB branches make a full-fidelity dry run free.

## Workflow

1. **Rehearse:** `create_branch` off `main` (name `migration/<slug>`, with fork context). Run the
   migration against the branch's connection string.
2. **Verify:** check schema + data on the branch. Broke something? `reset_branch` and try again, or
   `delete_branch` and start over.
3. **Apply to `main`:** once the branch run is clean, run the migration against `main`.
4. **Undo:** if a migration on `main` goes wrong, `restore_branch` with `as_new_branch` to recover
   `main`'s pre-migration state into a new branch, verify, then cut over.

## Rules

- The rehearsal branch must match `main`'s starting state — branch it immediately before rehearsing.
- Keep `restore_branch` timestamps ISO-8601 with a timezone.
```

- [ ] **Step 2: Commit**

```bash
git add skills/safe-db-migrations/SKILL.md
git commit -m "feat: ship safe-db-migrations agent skill (rehearse-verify-apply)"
```

---

## Task 16: Integration — MCP acceptance flow (spec v1 items 3–4)

Drive the real container through the MCP SDK client end-to-end: create → branch with fork context → destructive write in isolation → `main` unaffected → tree shows fork context → reset → restore-as-new-branch.

**Files:** Create `tests/integration/mcp.test.ts`. Reuse `startDevdb`, `connect` (`helpers/`). Use `Client` + `StreamableHTTPClientTransport`.

**Interfaces:** Consumes the running `/mcp` and endpoint connection strings; parses tool text for the connection string.

- [ ] **Step 1: Write the test** — the flow (one `describe`, shared container):

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { connect } from "./helpers/pg.js";

const connStr = (text: string) => text.match(/postgresql:\/\/\S+/)![0];

describe("mcp acceptance flow", () => {
  let dev: Devdb; let client: Client;
  beforeAll(async () => {
    dev = await startDevdb();
    client = new Client({ name: "acceptance", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
  });
  afterAll(async () => { await client?.close(); await dev?.stop(); });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return (r.content as Array<{ text: string }>)[0].text;
  };

  it("branches isolate writes from main and support reset + restore-as-new-branch", async () => {
    await call("create_project", { name: "shop" });
    // seed main
    const mainTxt = await call("get_branch", { project: "shop", branch: "main" });
    const main = await connect(dev, connStr(mainTxt));
    await main.query("create table t (id int); insert into t values (1)");

    // agent branch with fork context
    const branchTxt = await call("create_branch", {
      project: "shop", name: "agent/mutate",
      context: { git_branch: "feat/x", workdir: "/w", purpose: "destructive test" },
    });
    const branch = await connect(dev, connStr(branchTxt));
    await branch.query("insert into t values (2), (3)");
    expect((await branch.query("select count(*)::int c from t")).rows[0].c).toBe(3);
    // main unaffected
    expect((await main.query("select count(*)::int c from t")).rows[0].c).toBe(1);

    // tree shows fork context
    const tree = await call("list_branches", { project: "shop" });
    expect(tree).toMatch(/agent\/mutate/);
    expect(tree).toMatch(/destructive test/);
    expect(tree).toMatch(/acceptance/);   // captured client name

    // reset → matches parent (1 row) again
    const resetTxt = await call("reset_branch", { project: "shop", branch: "agent/mutate" });
    const afterReset = await connect(dev, connStr(resetTxt));
    expect((await afterReset.query("select count(*)::int c from t")).rows[0].c).toBe(1);

    // restore main as a new branch at a pre-write... (record a timestamp before the next write, then write, then restore)
    // (implement with a timestamp captured after a committed write + a subsequent write, per handover §8.5:
    //  get_lsn resolves only after a LATER commit — poll accordingly.)
    await main.query("insert into t values (9)");           // advance so the restore target materializes
    const restoreTxt = await call("restore_branch", {
      project: "shop", branch: "main", to_timestamp: new Date().toISOString(), as_new_branch: "recovered",
    });
    expect(restoreTxt).toMatch(/recovered/);
    await main.end(); await branch.end(); await afterReset.end();
  });
});
```
(Wire the exact restore timestamp per handover §8.5 — `get_lsn_by_timestamp` returns `future` until a later commit advances the clock; capture the target time, commit again, then restore. Adjust to a deterministic assertion during implementation.)

- [ ] **Step 2: Run + commit**

Run: `pnpm --filter @devdb/integration test -- mcp` (rerun once if Docker-under-load flakes, per §3.5).
Expected: green.

```bash
git add tests/integration/mcp.test.ts
git commit -m "test: MCP acceptance flow (branch isolation, fork context, reset, restore-as-new-branch)"
```

---

## Task 17: Integration — MCP concurrency (parked §4.6, the product's core promise)

Agents hammer the API concurrently. Prove the queue-lane model holds under parallel create/use/delete across branches.

**Files:** Create `tests/integration/mcp-concurrency.test.ts`.

- [ ] **Step 1: Write the test** — N parallel agents, each its own MCP session (each `initialize` mints a session — exercises the session store too):

```typescript
it("parallel agents create, write, and delete isolated branches without interference", async () => {
  const N = 6;
  await call0("create_project", { name: "load" });     // via a bootstrap client
  const runAgent = async (i: number) => {
    const c = new Client({ name: `agent-${i}`, version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`)));
    const t = async (n: string, a: Record<string, unknown>) =>
      ((await c.callTool({ name: n, arguments: a })).content as Array<{ text: string }>)[0].text;
    const txt = await t("create_branch", { project: "load", name: `agent/b${i}`, context: { purpose: `p${i}` } });
    const pg = await connect(dev, connStr(txt));
    await pg.query("create table m (v int); insert into m values ($1)", [i]);
    const v = (await pg.query("select v from m")).rows[0].v;
    expect(v).toBe(i);                                   // no cross-branch bleed
    await pg.end();
    await t("delete_branch", { project: "load", branch: `agent/b${i}` });
    await c.close();
  };
  await Promise.all(Array.from({ length: N }, (_, i) => runAgent(i)));
  // all agent branches gone; main + project intact
  const tree = await call0("list_branches", { project: "load" });
  for (let i = 0; i < N; i++) expect(tree).not.toMatch(new RegExp(`agent/b${i}\\b`));
});
```
(Provide `call0` via a bootstrap client set up in `beforeAll`, mirroring Task 16. `connStr` helper shared.)

- [ ] **Step 2: Run + commit**

Run: `pnpm --filter @devdb/integration test -- mcp-concurrency`
Expected: green (no lane corruption, no port collisions, clean deletes).

```bash
git add tests/integration/mcp-concurrency.test.ts
git commit -m "test: MCP concurrency — parallel create/use/delete across isolated branches"
```

---

## Self-Review — spec coverage

Every phase-2 scope item maps to a task:

| Spec / handover item | Task(s) |
|---|---|
| §4.1 lane capability tokens | 1 |
| §4.2 DTO redaction + generic 409 | 3 |
| §4.3 metrics-based readiness (+ delete retries) | 5 |
| §4.4 process-group compute kill | 6 |
| §4.5 structured logging | 4 |
| §4.6 MCP concurrency test | 17 |
| Fork context: schema, column, persistence | 2 |
| Fork context: DTO + UI-safe surfacing | 3 |
| Fork context on create/restore + client capture | 10, 11 |
| Fork context REST parity | 12 |
| MCP server: session-stateful transport, `/mcp` mount | 8 |
| MCP auth: DNS-rebinding guard + loopback bind | 8, 13 |
| MCP `instructions` field | 8 |
| 10 tools (import/export omitted) | 9, 10, 11 |
| Response contract (context line, connstring, next-step, remediation, ISO-8601) | 9 (helpers) + all tool tasks |
| SDK dependency + allowBuilds decision | 7 |
| Skills: using-devdb, safe-db-migrations | 14, 15 |
| Skill distribution (README + instructions) | 13, 8 |
| Acceptance flow (spec v1 items 3–4) | 16 |

**Deferred to later phases (intentionally out of scope):** `import_database`/`export_branch`/`get_job` tools + `importing-databases` skill (phase 4); Claude-Code-plugin packaging (phase 5); `PATCH /api/branches/:id` rename (phase 3). **Declined:** bearer-token MCP auth (refinement Decision 1).

**Type-consistency spot check:** `Lane` (Task 1) is consumed with the same 2-arg `startLocked(lane, branchId)` shape in Tasks 1's callers; `BranchContext` (Task 2) → `BranchRow.context` → `toBranchDto`'s `BranchDto.context` (Task 3) → tool rendering (Tasks 9–11) use one type from `@devdb/shared`; `toBranchDto`/`toProjectDto` names match between Task 3 (defn) and Tasks 9–12 (use); `waitComputeReady`/`parseComputeCtlUpStatus` names match between Task 5 defn and `manager.ts` use.

**Known implementation-time confirmations (flagged in-task, not gaps):** exact SDK API names (Task 7 pins them; Tasks 8–11 defer to `sdk-notes.md`); empty-`allowedOrigins` semantics (Task 8); the restore-timestamp materialization dance (Task 16, per handover §8.5); the Task 6 sync-point with Jordan's parallel session.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-03-devdb-phase-2-mcp-and-skills.md`.** 17 tasks across four phases (hardening → MCP core → docs/skills → integration). Execute with **superpowers:subagent-driven-development** per handover §3: fresh implementer subagent per task → two parallel gates (task-reviewer subagent + review-broker scan, `REVIEW_BROKER_DOC=<repo>/docs/codebase-review.md`) → controller adjudication → fixer → focused re-review; ledger each verdict in `.superpowers/sdd/progress.md` and **copy durable content into a committed doc before removing the worktree** (handover §10.5). Create the worktree with `superpowers:using-git-worktrees` (plain `git worktree add` + absolute paths — handover §3.4) before Task 1.

