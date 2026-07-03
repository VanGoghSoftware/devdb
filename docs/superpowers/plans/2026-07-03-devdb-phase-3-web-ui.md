# DevDB Phase 3 — Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The human's live window into DevDB — a Mantine SPA embedded in the daemon at `:4400` (dashboard, dual-renderer branch tree, branch drawer, settings) fed by a new `/api/events` SSE invalidation channel, plus the small daemon delta that supports it (events, rename, status additions, static serving).

**Architecture:** New `packages/web` (React 19 + Vite 8, built to static assets the daemon serves via `@fastify/static` with an SPA fallback). React Query owns all server state from REST; `/api/events` streams coarse invalidation hints (never data, no replay) published by services post-write and by `ComputeManager`/`ManagedProcess` observer hooks wired at the composition root. The branch tree renders the same tree model through two switchable renderers: hand-rolled SVG rails and a React Flow canvas.

**Tech Stack:** React 19.2, Vite 8, Mantine 9.4, TanStack React Query 5, React Flow (`@xyflow/react` 12), `d3-hierarchy` 3, react-router 8, vitest 4 + Testing Library (web); Fastify 5 + `@fastify/static` 9, zod, better-sqlite3 (daemon, unchanged stack).

**Specs:** `docs/superpowers/specs/2026-07-03-devdb-phase-3-web-ui-design.md` (authoritative for the four resolved decisions) + parent spec `2026-07-02-devdb-design.md` §Web UI.

## Global Constraints

- **Process:** execute in an isolated worktree (never on `main`); two gates per task — independent task-reviewer subagent AND a review-broker scan (`REVIEW_BROKER_DOC=<repo>/docs/codebase-review.md`, absolute `focusFiles`/`repoRoot`). Verify each task's premise against current `main` before implementing (parallel sessions move it).
- **Package manager:** plain `pnpm` only (corepack shim broken on this machine). Dependencies must be ≥ 24h old — enforced by `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`; every new dep below was verified ≥ 24h old and React-19/Vite-8/Fastify-5 compatible on 2026-07-03. No native builds among them (no `allowBuilds` changes).
- **TypeScript:** no `as any` / `as never` anywhere (tsc gates enforce). `packages/web` joins the same discipline: its test script runs `tsc --noEmit` before vitest.
- **Wire types:** the web app never redefines a DTO — everything imports from `@devdb/shared`. New wire shapes (event schema, StatusDto additions) are added to shared first.
- **Events contract (spec Decision 1):** events are coarse invalidation hints `{ type, projectId?, branchId?, at }` — never data payloads. No replay: a client receives only future events and blanket-invalidates on every (re)connect. Emission happens after a successful local state write (post-compensation), inside the queue lane that ran the mutation. Fanout swallows throwing subscribers (LogsService contract).
- **SPA fallback must never shadow `/api` or `/mcp`** (spec Decision 4 / plan-time risk 3). The MCP rebinding guard stays scoped to `/mcp`; no CORS is added to the daemon (dev mode uses the Vite proxy).
- **Rename semantics (spec §Daemon additions):** `slug` is immutable; the root branch (`parentBranchId === null`) is not renameable (400); duplicate name in project → 409; validation reuses the create-branch `NAME_RE`.
- **No MCP changes. No engine-interaction changes** — the `ManagedProcess`/`EngineRuntime` hooks are pure observers (no payloads → oracle rule untouched).
- **TDD:** every task captures RED evidence (failing test output) before implementing. Frequent conventional commits (`feat:`/`fix:`/`test:`/`docs:` …).
- Docker installs use `--frozen-lockfile`; `packages/web` is covered by the existing `COPY packages ./packages` (the §3.4 COPY trap applies only to packages outside `packages/`).

### Pinned dependency versions (verified on npm 2026-07-03, all ≥ 24h old)

| Package | Version | Where |
|---|---|---|
| react / react-dom | `^19.2.7` | web deps |
| @mantine/core / hooks / notifications | `^9.4.1` (peers `react ^19.2.0` ✓) | web deps |
| @tanstack/react-query | `^5.101.2` | web deps |
| @xyflow/react | `^12.11.1` (peers `react >=17` ✓) | web deps |
| d3-hierarchy | `^3.1.2` | web deps |
| react-router | `^8.1.0` (peers `react >=19.2.7` ✓) | web deps |
| vite / @vitejs/plugin-react | `^8.1.3` / `^6.0.3` (plugin peers `vite ^8` ✓) | web dev |
| vitest | `^4.1.9` (supports `vite ^8` ✓ — daemon keeps its `^3`) | web dev |
| jsdom | `^29.1.1` | web dev |
| @testing-library/react / dom / jest-dom / user-event | `^16.3.2` / `^10.4.1` / `^6.9.1` / `^14.6.1` | web dev |
| @types/react / react-dom / d3-hierarchy | `^19.2.17` / `^19.2.3` / `^3.1.7` | web dev |
| typescript | `^5.7.0` (repo standard) | web dev |
| @fastify/static | `^9.1.3` (fastify-5 line; Task 14's register test is the compat gate — if register throws a fastify-version error, fall back to `^8`) | daemon deps |

## File Structure

```
packages/shared/src/index.ts            MODIFY  DevdbEvent schema/types; StatusDto += portRange/storage
packages/daemon/src/services/events.ts  CREATE  EventsService (publish/subscribe, swallow contract)
packages/daemon/src/services/{projects,branches,timetravel,endpoints}.ts
                                        MODIFY  emission points; branches also gains rename()
packages/daemon/src/state/repos.ts      MODIFY  updateName(); BranchRow.createdBy narrowed
packages/daemon/src/services/dto.ts     MODIFY  drop the two §9 casts
packages/daemon/src/engine/process.ts   MODIFY  state getter + onStateChange observer
packages/daemon/src/engine/boot.ts      MODIFY  forward component state changes (optional hook)
packages/daemon/src/compute/manager.ts  MODIFY  onStatusChange observer (4th ctor arg)
packages/daemon/src/http/api.ts         MODIFY  sseStream() extraction; /api/events; PATCH rename; status additions; Deps.events
packages/daemon/src/http/static.ts      CREATE  registerWebUi() — @fastify/static + SPA fallback
packages/daemon/src/config.ts           MODIFY  webDistDir (DEVDB_WEB_DIST, optional)
packages/daemon/src/index.ts            MODIFY  EventsService construction + wiring
packages/web/**                         CREATE  the SPA (structure detailed in Task 6)
docker/Dockerfile                       MODIFY  ENV DEVDB_WEB_DIST (build already covers web via pnpm -r build)
README.md                               MODIFY  UI quickstart + dev-mode section
tests/integration/helpers/sse.ts        CREATE  minimal SSE reader for integration tests
tests/integration/{web-ui,events}.test.ts CREATE container-level coverage
```

`packages/web/src` layout (locked here; Task 6 scaffolds it):

```
main.tsx theme.ts prefs.ts App.tsx routes.tsx
api/client.ts api/keys.ts api/hooks.ts api/events.ts
tree/model.ts tree/chips.tsx tree/BranchActionsMenu.tsx tree/RailsView.tsx tree/CanvasView.tsx tree/BranchNode.tsx
pages/DashboardPage.tsx pages/ProjectPage.tsx pages/SettingsPage.tsx
drawer/BranchDrawer.tsx drawer/LogsTab.tsx drawer/RestoreTab.tsx drawer/InfoTab.tsx
```

---

### Task 1: Event schema (shared) + EventsService + `/api/events` SSE route

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `packages/daemon/src/services/events.ts`
- Modify: `packages/daemon/src/http/api.ts` (extract `sseStream()` from `sse()`; add route; `Deps.events`)
- Modify: `packages/daemon/test/api.test.ts`, `packages/daemon/test/mcp-http.test.ts` (their `fakeDeps()` helpers gain `events`)
- Test: `packages/daemon/test/events.test.ts` (new), `packages/daemon/test/api.test.ts` (route tests)

**Interfaces:**
- Consumes: `LogsService`-style fanout conventions; the existing hardened `sse()` in api.ts.
- Produces: `DevdbEvent`, `DevdbEventType`, `DevdbEventSchema` (shared); `EventsService` with `publish(e: { type: DevdbEventType; projectId?: string; branchId?: string }): void` and `subscribe(cb: (e: DevdbEvent) => void): () => void`; `Deps.events: EventsService` (required); `GET /api/events`. Tasks 2–3 publish through this; Task 7 consumes the wire format (`data: <JSON DevdbEvent>\n\n`).

- [ ] **Step 1: Add the event schema to shared**

Append to `packages/shared/src/index.ts`:

```ts
// Phase 3: /api/events wire schema. Events are coarse INVALIDATION HINTS, never data — the UI
// refetches via REST on receipt (spec 2026-07-03-devdb-phase-3-web-ui-design.md, Decision 1).
// branch.updated covers every branch-row mutation that isn't create/delete: rename, reset,
// in-place restore (timeline swap). LSN/size churn is deliberately NOT an event.
export const DevdbEventTypeSchema = z.enum([
  "project.created", "project.deleted",
  "branch.created", "branch.updated", "branch.deleted",
  "endpoint.status", "engine.health",
]);
export type DevdbEventType = z.infer<typeof DevdbEventTypeSchema>;

export const DevdbEventSchema = z.object({
  type: DevdbEventTypeSchema,
  projectId: z.string().optional(),
  branchId: z.string().optional(),
  at: z.string(), // ISO-8601 with timezone (server-stamped)
});
export type DevdbEvent = z.infer<typeof DevdbEventSchema>;
```

Run: `pnpm --filter @devdb/shared build` — must compile.

- [ ] **Step 2: Write the failing EventsService test**

Create `packages/daemon/test/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EventsService } from "../src/services/events.js";

describe("EventsService", () => {
  it("delivers published events to subscribers with a server timestamp", () => {
    const svc = new EventsService();
    const seen: unknown[] = [];
    svc.subscribe((e) => seen.push(e));
    svc.publish({ type: "branch.created", projectId: "p1", branchId: "b1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "branch.created", projectId: "p1", branchId: "b1" });
    expect(new Date((seen[0] as { at: string }).at).toString()).not.toBe("Invalid Date");
  });

  it("unsubscribe stops delivery; other subscribers unaffected", () => {
    const svc = new EventsService();
    const a: unknown[] = []; const b: unknown[] = [];
    const unsubA = svc.subscribe((e) => a.push(e));
    svc.subscribe((e) => b.push(e));
    unsubA();
    svc.publish({ type: "engine.health" });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("a throwing subscriber never breaks delivery to the rest (LogsService swallow contract)", () => {
    const svc = new EventsService();
    const seen: unknown[] = [];
    svc.subscribe(() => { throw new Error("boom"); });
    svc.subscribe((e) => seen.push(e));
    expect(() => svc.publish({ type: "project.deleted", projectId: "p1" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("a subscriber that unsubscribes itself mid-publish does not skip others", () => {
    const svc = new EventsService();
    const seen: string[] = [];
    const unsub = svc.subscribe(() => { seen.push("self"); unsub(); });
    svc.subscribe(() => seen.push("other"));
    svc.publish({ type: "engine.health" });
    expect(seen).toEqual(["self", "other"]);
  });
});
```

- [ ] **Step 3: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/events.test.ts`
Expected: FAIL — `Cannot find module '../src/services/events.js'`.

- [ ] **Step 4: Implement EventsService**

Create `packages/daemon/src/services/events.ts`:

```ts
import type { DevdbEvent, DevdbEventType } from "@devdb/shared";

// In-process state-change fanout behind GET /api/events (spec Decision 1). Events are coarse
// invalidation hints — publishers pass ids only; `at` is stamped here. Deliberately NO ring
// buffer / replay (unlike LogsService): the SSE contract is "future events only; the client
// blanket-invalidates on every (re)connect", so missed events have no correctness consequences.
export class EventsService {
  private subs = new Set<(e: DevdbEvent) => void>();

  publish(e: { type: DevdbEventType; projectId?: string; branchId?: string }): void {
    const evt: DevdbEvent = { ...e, at: new Date().toISOString() };
    // Snapshot before iterating — a subscriber unsubscribing (itself or another) mid-publish
    // must not mutate the Set out from under this loop. Same shape as LogsService.ingest.
    for (const cb of [...this.subs]) {
      try {
        cb(evt);
      } catch {
        // A throwing subscriber (e.g. an SSE write against a dying socket) must never break
        // delivery to other subscribers or the publishing mutation — swallow by contract.
      }
    }
  }

  subscribe(cb: (e: DevdbEvent) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }
}
```

- [ ] **Step 5: Run to verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/events.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Write the failing route tests**

Append to `packages/daemon/test/api.test.ts` (mirror the listen+fetch pattern of the existing `GET /api/daemon/logs/:component` SSE tests at ~line 651; `fakeDeps()` gains `events` in Step 8):

```ts
it("GET /api/events — text/event-stream; delivers ONLY post-connect events as JSON (no replay)", async () => {
  const events = new EventsService();
  const app = buildServer(fakeDeps({ events }));
  await app.listen({ port: 0 });
  const base = `http://localhost:${(app.server.address() as { port: number }).port}`;
  try {
    events.publish({ type: "project.created", projectId: "before" }); // pre-connect: must NOT arrive
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    events.publish({ type: "branch.created", projectId: "p1", branchId: "b1" });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data: ");
    const evt = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
    expect(evt).toMatchObject({ type: "branch.created", projectId: "p1", branchId: "b1" });
    expect(text).not.toContain("before");
    ac.abort();
  } finally {
    await app.close();
  }
});

it("GET /api/events — client disconnect unsubscribes from EventsService (no leak)", async () => {
  const events = new EventsService();
  const app = buildServer(fakeDeps({ events }));
  await app.listen({ port: 0 });
  const base = `http://localhost:${(app.server.address() as { port: number }).port}`;
  try {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    await res.body!.getReader().read().catch(() => {});
    ac.abort();
    // Publish after abort settles; delivery to a torn-down socket must not throw the publish.
    await new Promise((r) => setTimeout(r, 50));
    expect(() => events.publish({ type: "engine.health" })).not.toThrow();
  } finally {
    await app.close();
  }
});
```

Adjust `fakeDeps` usage: if the file's helper is a plain object literal builder without an overrides parameter, add one (`fakeDeps(overrides: Partial<Deps> = {})` spreading overrides last) — minimal, mechanical.

- [ ] **Step 7: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/api.test.ts -t "api/events"`
Expected: FAIL — route not found (404) / `events` not in Deps type.

- [ ] **Step 8: Implement — sseStream() extraction, Deps.events, route**

In `packages/daemon/src/http/api.ts`:

1. Add to imports: `import type { EventsService } from "../services/events.js";`
2. Add to `Deps`: `events: EventsService;` (required — the route depends on it unconditionally; unlike `logger?`, there is exactly one deps-construction helper per test file to update).
3. Generalize the existing hardened `sse(reply, channel)` into `sseStream(reply, source)` — **move** the body, don't copy it. All hardening comments (hijack, flushHeaders, backpressure teardown, error listener, openSseResponses) move verbatim; only the two coupling points change:

```ts
interface SseSource {
  replay: string[];                                  // already-serialized SSE payload strings
  subscribe: (cb: (payload: string) => void) => () => void;
}

function sseStream(reply: FastifyReply, source: SseSource): void {
  // ... existing sse() body, with `deps.logs.recent(channel)` replaced by `source.replay`
  // and `deps.logs.subscribe(channel, cb)` replaced by `source.subscribe(cb)`.
}

// Logs SSE keeps replay-then-live semantics, now as a thin adapter:
function sse(reply: FastifyReply, channel: string): void {
  sseStream(reply, {
    replay: deps.logs.recent(channel),
    subscribe: (cb) => deps.logs.subscribe(channel, cb),
  });
}
```

4. Add the route (after the `/api/daemon/logs/:component` route):

```ts
// Phase 3 (spec Decision 1): state-change invalidation hints. NO replay — `replay: []` is the
// contract, not an optimization: clients blanket-invalidate on every (re)connect, which is what
// makes lost events and reconnects free of correctness concerns.
app.get("/api/events", async (_req, reply) => {
  sseStream(reply, {
    replay: [],
    subscribe: (cb) => deps.events.subscribe((e) => cb(JSON.stringify(e))),
  });
});
```

5. In `packages/daemon/test/api.test.ts` and `packages/daemon/test/mcp-http.test.ts`: add `import { EventsService } from "../src/services/events.js";` and `events: new EventsService(),` to each file's deps helper.

- [ ] **Step 9: Run the full unit suite (tsc gate + vitest)**

Run: `pnpm --filter @devdb/daemon test`
Expected: all green — including the pre-existing logs-SSE tests, which are the safety net proving the `sseStream()` extraction preserved the hardened behavior.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/index.ts packages/daemon/src/services/events.ts packages/daemon/src/http/api.ts packages/daemon/test/events.test.ts packages/daemon/test/api.test.ts packages/daemon/test/mcp-http.test.ts
git commit -m "feat(events): shared event schema, EventsService fanout, GET /api/events SSE (no replay)"
```

---

### Task 2: Event emission at every service mutation point

**Files:**
- Modify: `packages/daemon/src/services/projects.ts` (create ~line 108 return, delete ~line 219)
- Modify: `packages/daemon/src/services/branches.ts` (create ~line 101, delete ~line 172)
- Modify: `packages/daemon/src/services/timetravel.ts` (`swapOntoNewTimeline` success point ~line 259)
- Modify: `packages/daemon/src/services/endpoints.ts` (all six `updateEndpoint` sites via one helper)
- Test: `packages/daemon/test/{branches-service,endpoints-service,timetravel,projects-service}.test.ts` (extend existing files; if there is no projects-service test file, add assertions to where ProjectsService is covered)

**Interfaces:**
- Consumes: `EventsService.publish` (Task 1).
- Produces: the emission map below — Task 16's integration tests and Task 7's client assume exactly these events fire. `ProjectsDeps` gains `events?: EventsService` (OPTIONAL — the same pattern as `logs?`, so the many existing direct service constructions in unit tests stay valid).

**Emission map (binding):**

| Mutation | Event | Where |
|---|---|---|
| `ProjectsService.create` | `project.created {projectId}` | immediately before the success `return` (~line 108), after project + main branch rows exist. ONE event — clients invalidate projects AND branches on it; no separate `branch.created` for main. |
| `ProjectsService.delete` | `project.deleted {projectId}` | immediately after `state.projects.delete(project.id)` (~line 219) |
| `BranchesService.create` | `branch.created {projectId, branchId}` | inside the queue lane's `try`, after `state.branches.create` returns — restructure `return this.deps.state.branches.create({...})` to `const row = ...; publish; return row;`. Note: `TimeTravelService.branchAtTimestamp` delegates here, so restore-as-new-branch emits automatically — add NO emission there. |
| `BranchesService.delete` | `branch.deleted {projectId, branchId}` | after `state.branches.delete(branch.id)` (~line 172), next to the `logs?.evict` call |
| `TimeTravelService.swapOntoNewTimeline` | `branch.updated {projectId, branchId}` | at the single success point, immediately before `return this.deps.branches.detail(...)` (~line 259) — one seam covers BOTH `restoreInPlace` and `resetToParent` |
| `EndpointsService` (all 6 `updateEndpoint` sites) | `endpoint.status {projectId, branchId}` | via the `setEndpointStatus` helper below |

- [ ] **Step 1: Write the failing tests**

Pattern (adapt names to each file's existing fixtures; a REAL `EventsService` + collector subscriber is cheaper and more honest than a fake — same rationale the codebase records for `LogsService`). Example for `packages/daemon/test/branches-service.test.ts`:

```ts
it("create() publishes branch.created with project + branch ids after the row exists", async () => {
  const events = new EventsService();
  const seen: DevdbEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const svc = makeBranchesService({ events }); // thread through the file's existing builder
  const row = await svc.create({ projectId: project.id, name: "dev" });
  expect(seen).toEqual([expect.objectContaining({ type: "branch.created", projectId: project.id, branchId: row.id })]);
});

it("a create() that fails engine-side publishes NOTHING", async () => {
  const events = new EventsService();
  const seen: DevdbEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const svc = makeBranchesService({ events, pageserver: failingPageserver }); // timelineCreate rejects
  await expect(svc.create({ projectId: project.id, name: "dev" })).rejects.toThrow();
  expect(seen).toEqual([]);
});

it("delete() publishes branch.deleted after the row is gone", async () => {
  const events = new EventsService();
  const seen: DevdbEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const svc = makeBranchesService({ events });
  const row = await svc.create({ projectId: project.id, name: "doomed" });
  await svc.delete(row.id);
  expect(seen.filter((e) => e.type === "branch.deleted")).toEqual([
    expect.objectContaining({ projectId: project.id, branchId: row.id }),
  ]);
});
```

For `endpoints-service.test.ts`: assert the full `endpoint.status` sequence for a successful start (`starting` write → `running` write ⇒ exactly 2 events), a failed start (⇒ `starting` + `failed` = 2 events), and stop (⇒ `stopping` + `stopped` = 2 events). For `timetravel.test.ts`: `resetToParent` and `restoreInPlace` each publish exactly one `branch.updated`; `branchAtTimestamp` publishes exactly one `branch.created` (via delegation — assert no duplicate).

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/branches-service.test.ts test/endpoints-service.test.ts test/timetravel.test.ts`
Expected: FAIL — services don't accept/publish events yet (type error on `events` in deps → that IS the RED for the tsc gate; capture it).

- [ ] **Step 3: Implement**

1. In `packages/daemon/src/services/projects.ts`, extend `ProjectsDeps` with `events?: EventsService` (+ type import). Every other service reuses this via their existing `ProjectsDeps & {...}` intersections — no further deps-type edits.
2. Insert `this.deps.events?.publish({ ... })` at exactly the six seams in the emission map. Each insertion is one line plus (for `branches.create`) the capture-then-return restructure:

```ts
// branches.ts create(), inside the lane's try — was: return this.deps.state.branches.create({...});
const row = this.deps.state.branches.create({
  /* existing fields unchanged */
});
this.deps.events?.publish({ type: "branch.created", projectId: project.id, branchId: row.id });
return row;
```

3. In `packages/daemon/src/services/endpoints.ts`, add the private helper and route all six `updateEndpoint` calls through it:

```ts
// Every endpoint status persisted to SQLite is also announced on /api/events — one seam so a
// transition can never be written without being announced (spec Decision 1 emission table).
private setEndpointStatus(branch: { id: string; projectId: string }, a: { status: string; port: number | null; error?: string | null }): void {
  this.deps.state.branches.updateEndpoint(branch.id, a);
  this.deps.events?.publish({ type: "endpoint.status", projectId: branch.projectId, branchId: branch.id });
}
```

(The two compensation-path `updateEndpoint` calls wrapped in their own try/catch keep that wrapping — `setEndpointStatus` goes inside it.)

- [ ] **Step 4: Run to verify GREEN, then the full suite**

Run: `pnpm --filter @devdb/daemon test`
Expected: all green (existing tests unaffected — `events` is optional in deps).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/services packages/daemon/test
git commit -m "feat(events): publish invalidation hints at every service mutation seam"
```

---

### Task 3: Async status observers — ManagedProcess, ComputeManager, EngineRuntime + composition-root wiring

**Files:**
- Modify: `packages/daemon/src/engine/process.ts` (state getter + `onStateChange`)
- Modify: `packages/daemon/src/compute/manager.ts` (`onStatusChange` 4th ctor arg)
- Modify: `packages/daemon/src/engine/boot.ts` (component-state hook, 4th ctor arg)
- Modify: `packages/daemon/src/index.ts` (wire EventsService into everything)
- Test: `packages/daemon/test/process.test.ts`, `packages/daemon/test/manager.test.ts` (extend)

**Interfaces:**
- Consumes: `EventsService` (Task 1).
- Produces: `ManagedProcessOptions.onStateChange?: (state: "stopped" | "starting" | "running" | "failed") => void`; `ComputeManager` ctor `(cfg, logger, waitReady?, onStatusChange?: (branchId: string) => void)`; `EngineRuntime` ctor gains optional 4th arg `onComponentStateChange?: (component: string, state: string) => void`. Task 16 relies on crash → `endpoint.status` event reaching SSE clients.

**Why:** services (Task 2) cover every transition the daemon *initiates*. A compute crashing after start — or an engine component dying/restarting — changes `statusOf()`/`engine.status()` with no service write. These observer hooks announce those, keeping `compute/` and `engine/` free of `services/` imports (wired only in `index.ts`).

- [ ] **Step 1: Write the failing ManagedProcess test**

Append to `packages/daemon/test/process.test.ts` (reuse the file's existing fake-child/script harness):

```ts
it("onStateChange fires on every distinct transition, and observer throws are swallowed", async () => {
  const states: string[] = [];
  const proc = makeProc({ // the file's existing builder for a fast-exiting real child
    onStateChange: (s) => { states.push(s); if (s === "running") throw new Error("observer boom"); },
  });
  await proc.start();          // starting -> running
  await proc.stop();           // -> stopped
  expect(states).toEqual(["starting", "running", "stopped"]);
});

it("crash after readiness reports failed via onStateChange", async () => {
  const states: string[] = [];
  // reuse the existing "crash after readiness flips state to failed" fixture, adding the observer
  const proc = makeCrashingProc({ onStateChange: (s) => states.push(s) });
  await proc.start();
  await waitForExit(proc);     // per the existing crash test's technique
  expect(states).toEqual(["starting", "running", "failed"]);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/process.test.ts`
Expected: FAIL — `onStateChange` not a known option (tsc gate) — capture output.

- [ ] **Step 3: Implement the ManagedProcess observer**

In `packages/daemon/src/engine/process.ts`:

```ts
export type ManagedProcessState = "stopped" | "starting" | "running" | "failed";
// in the options interface, alongside onLine:
onStateChange?: (state: ManagedProcessState) => void;
```

Replace the public mutable field with a getter + private setter (verified 2026-07-03: no writer of `.state` exists outside this file):

```ts
private _state: ManagedProcessState = "stopped";
get state(): ManagedProcessState { return this._state; }
private setState(s: ManagedProcessState): void {
  if (this._state === s) return;
  this._state = s;
  try {
    this.opts.onStateChange?.(s);
  } catch {
    // observer errors must never break the child lifecycle — same swallow contract as onLine.
  }
}
```

Replace all six `this.state = ...` assignments (lines ~67, 79, 125, 139, 142, 159) with `this.setState(...)`.

- [ ] **Step 4: Write the failing ComputeManager test**

Append to `packages/daemon/test/manager.test.ts` (reuse its mocked-ManagedProcess harness):

```ts
it("onStatusChange fires across the compute lifecycle: reserve, running, stopping, gone", async () => {
  const ticks: string[] = [];
  const mgr = makeManager({ onStatusChange: (branchId) => ticks.push(`${branchId}:${mgr.statusOf(branchId)}`) });
  await mgr.start({ branch, pgVersion: 17 });
  await mgr.stop(branch.id);
  expect(ticks[0]).toBe(`${branch.id}:starting`);          // map-slot reservation
  expect(ticks).toContain(`${branch.id}:running`);          // phase flip after readiness
  expect(ticks).toContain(`${branch.id}:stopping`);
  expect(ticks[ticks.length - 1]).toBe(`${branch.id}:stopped`); // entry removed
});

it("a failed start announces the terminal state after cleanup", async () => {
  const ticks: string[] = [];
  const mgr = makeFailingManager({ onStatusChange: (id) => ticks.push(mgr.statusOf(id)) });
  await expect(mgr.start({ branch, pgVersion: 17 })).rejects.toThrow();
  expect(ticks[ticks.length - 1]).toBe("stopped"); // entry deleted by the catch's cleanup
});
```

- [ ] **Step 5: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/manager.test.ts`
Expected: FAIL — unknown option / no notifications.

- [ ] **Step 6: Implement the ComputeManager observer**

In `packages/daemon/src/compute/manager.ts`:

```ts
constructor(
  private cfg: DevdbConfig,
  private logger: Logger,
  private waitReady: typeof waitComputeReady = waitComputeReady,
  // Announces "statusOf(branchId) may have changed" — index.ts forwards to /api/events. Coarse
  // by design: over-firing is harmless (events are invalidation hints), missing a transition is not.
  private onStatusChange?: (branchId: string) => void,
) {}

private notifyStatus(branchId: string): void {
  try {
    this.onStatusChange?.(branchId);
  } catch {
    // observer must never break compute lifecycle — swallow, same contract as listener fanout.
  }
}
```

Call `this.notifyStatus(a.branch.id)` at: (1) after `this.computes.set(a.branch.id, entry)`; (2) after `entry.phase = "running"`; (3) in `start()`'s catch after the map-entry delete; and `this.notifyStatus(branchId)` in `stop()` after `entry.phase = "stopping"` and again after the entry is removed (its finally). Additionally, wire the per-compute process observer inside `start()`'s `new ManagedProcess({...})` options:

```ts
onStateChange: () => this.notifyStatus(a.branch.id), // crash-after-running reaches /api/events
```

- [ ] **Step 7: EngineRuntime hook + index.ts wiring**

In `packages/daemon/src/engine/boot.ts`: add an optional 4th ctor arg `private onComponentStateChange?: (component: string, state: string) => void`, and in `launch(spec)` pass into the `ManagedProcess` options:

```ts
onStateChange: (s) => this.onComponentStateChange?.(spec.name, s),
```

(`storconDb`/EmbeddedPostgres is excluded deliberately: its state only changes during boot/shutdown when no SSE client can observe it; `/api/status` remains the truth either way.)

In `packages/daemon/src/index.ts` (inside `main()`, after `const logger = createLogger(logs);`):

```ts
const events = new EventsService();
engine = new EngineRuntime(cfg, state, logs, () => events.publish({ type: "engine.health" }));
// ... unchanged boot steps ...
computes = new ComputeManager(cfg, logger, undefined, (branchId) => {
  const b = state.branches.byId(branchId);
  events.publish({ type: "endpoint.status", branchId, projectId: b?.projectId });
});
```

Thread `events` into every service deps bag (`projects`, `branches`, `endpoints`, `timetravel`) and into `buildServer({ ..., events, ... })`. Add the import.

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm --filter @devdb/daemon test`
Expected: all green (process-group tests included — they construct ManagedProcess directly and must be unaffected).

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src packages/daemon/test
git commit -m "feat(events): observer hooks for async compute/engine state changes, wired at composition root"
```

---

### Task 4: `PATCH /api/branches/:id` — rename

**Files:**
- Modify: `packages/daemon/src/state/repos.ts` (BranchesRepo gains `updateName`)
- Modify: `packages/daemon/src/services/branches.ts` (gains `rename()`)
- Modify: `packages/daemon/src/http/api.ts` (PATCH route)
- Test: `packages/daemon/test/branches-service.test.ts`, `packages/daemon/test/api.test.ts`

**Interfaces:**
- Consumes: `NAME_RE` (already in branches.ts), `BranchQueue.run`, `events?.publish` (Task 2 pattern).
- Produces: `BranchesService.rename(id: string, newName: string): Promise<BranchRow>`; `PATCH /api/branches/:id` body `{ name: string }` → 200 `BranchDto`. Task 7's client and Task 12's drawer call this. `slug` never changes (it feeds compute naming/dirs).

- [ ] **Step 1: Write the failing service tests**

Append to `packages/daemon/test/branches-service.test.ts`:

```ts
describe("rename", () => {
  it("renames a child branch, bumps updatedAt, keeps slug, emits branch.updated", async () => {
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const svc = makeBranchesService({ events });
    const b = await svc.create({ projectId: project.id, name: "dev" });
    const out = await svc.rename(b.id, "dev-renamed");
    expect(out.name).toBe("dev-renamed");
    expect(out.slug).toBe(b.slug);                       // immutable — feeds compute naming/dirs
    expect(out.updatedAt >= b.updatedAt).toBe(true);
    expect(seen.filter((e) => e.type === "branch.updated")).toEqual([
      expect.objectContaining({ projectId: project.id, branchId: b.id }),
    ]);
  });

  it("refuses to rename the root branch with a 400 naming the reason", async () => {
    const svc = makeBranchesService({});
    // The fixture project's root: the branch project.create seeded with no parent.
    const main = state.branches.byProjectAndName(project.id, "main")!;
    expect(main.parentBranchId).toBeNull();
    await expect(svc.rename(main.id, "primary")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("409s on a duplicate name in the same project; renaming to its own name is a no-op success", async () => {
    const svc = makeBranchesService({});
    const a = await svc.create({ projectId: project.id, name: "a" });
    await svc.create({ projectId: project.id, name: "b" });
    await expect(svc.rename(a.id, "b")).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.rename(a.id, "a")).resolves.toMatchObject({ name: "a" });
  });

  it("400s on a name failing NAME_RE", async () => {
    const svc = makeBranchesService({});
    const b = await svc.create({ projectId: project.id, name: "ok" });
    await expect(svc.rename(b.id, "  ")).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon exec vitest run test/branches-service.test.ts -t rename`
Expected: FAIL — `svc.rename is not a function`.

- [ ] **Step 3: Implement repo + service**

`packages/daemon/src/state/repos.ts`, in `BranchesRepo` (same `strftime` idiom as `updateEndpoint`):

```ts
updateName(id: string, name: string): void {
  this.db.prepare(
    "UPDATE branches SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(name, id);
}
```

`packages/daemon/src/services/branches.ts`:

```ts
// Phase 3 (spec §Daemon additions): rename mutates NAME only — slug is immutable (it feeds
// compute naming and directories; a rename must never touch engine artifacts). The root branch
// is not renameable: skills and agent conventions reference "main" by name.
async rename(id: string, newName: string): Promise<BranchRow> {
  const name = newName.trim();
  const branch = this.byIdOr404(id);
  if (!NAME_RE.test(name)) throw new DevdbError(400, `invalid branch name: ${JSON.stringify(newName)}`);
  if (branch.parentBranchId === null) {
    throw new DevdbError(400, `the root branch cannot be renamed — agent skills and workflows reference it by name`);
  }
  return this.deps.queue.run(id, async () => {
    const current = this.deps.state.branches.byId(id);
    if (!current) throw new DevdbError(404, `branch ${id} not found`);
    if (current.name !== name && this.deps.state.branches.byProjectAndName(current.projectId, name)) {
      throw new DevdbError(409, `branch "${name}" already exists in this project`);
    }
    this.deps.state.branches.updateName(id, name);
    this.deps.events?.publish({ type: "branch.updated", projectId: current.projectId, branchId: id });
    return this.deps.state.branches.byId(id)!;
  });
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm --filter @devdb/daemon exec vitest run test/branches-service.test.ts`
Expected: all pass.

- [ ] **Step 5: Route + route tests (RED → GREEN)**

Append to `packages/daemon/test/api.test.ts` (mocked-service style used by the file's other route tests):

```ts
it("PATCH /api/branches/:id — 200 with the renamed branch DTO", async () => {
  const branches = fakeBranches();
  (branches.rename as ReturnType<typeof vi.fn>).mockResolvedValue(fakeBranchRow({ name: "renamed" }));
  (branches.detail as ReturnType<typeof vi.fn>).mockResolvedValue(fakeBranchDetail({ name: "renamed" }));
  const app = buildServer(fakeDeps({ services: fakeServices({ branches }) }));
  const res = await app.inject({ method: "PATCH", url: "/api/branches/b1", payload: { name: "renamed" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().name).toBe("renamed");
  expect(branches.rename).toHaveBeenCalledWith("b1", "renamed");
});

it("PATCH /api/branches/:id — zod 400 on a missing name", async () => {
  const app = buildServer(fakeDeps({}));
  const res = await app.inject({ method: "PATCH", url: "/api/branches/b1", payload: {} });
  expect(res.statusCode).toBe(400);
});
```

Run RED, then add to `packages/daemon/src/http/api.ts` (after the DELETE branches route):

```ts
const RenameBranch = z.object({ name: z.string() });
app.patch("/api/branches/:id", async (req) => {
  const { id } = req.params as { id: string };
  const body = RenameBranch.parse(req.body);
  const row = await deps.services.branches.rename(id, body.name);
  return toBranchDto(await deps.services.branches.detail(row));
});
```

(`fakeBranches()` in the test file gains `rename: vi.fn()` — same shape as its other method fakes. If `fakeBranchRow` doesn't exist, reuse `fakeBranchDetail` — a `BranchDetail` is a `BranchRow` superset.)

- [ ] **Step 6: Full unit suite, then commit**

Run: `pnpm --filter @devdb/daemon test` — all green.

```bash
git add packages/daemon/src packages/daemon/test
git commit -m "feat(api): PATCH /api/branches/:id rename — slug immutable, root guarded, queued, announced"
```

---

### Task 5: Status payload additions + §9 dto typing close-out

**Files:**
- Modify: `packages/shared/src/index.ts` (StatusDto)
- Modify: `packages/daemon/src/http/api.ts` (status route)
- Modify: `packages/daemon/src/state/repos.ts` (BranchRow.createdBy narrowed at the row boundary)
- Modify: `packages/daemon/src/services/dto.ts` (drop both casts)
- Test: `packages/daemon/test/api.test.ts`, `packages/daemon/test/dto.test.ts`

**Interfaces:**
- Produces: `StatusDto` gains `portRange: { min: number; max: number }` and `storage: "none" | "s3" | "azure"`. Tasks 8/11 render these. `BranchRow.createdBy: "ui" | "api" | "mcp"` — closes handover §9's dto item.

- [ ] **Step 1: Failing status-route test**

Append to `packages/daemon/test/api.test.ts`:

```ts
it("GET /api/status — includes portRange and storage (phase-4 modes hardcoded 'none')", async () => {
  const app = buildServer(fakeDeps({}));
  const res = await app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.portRange).toEqual({ min: 54300, max: 54339 }); // from the test config env
  expect(body.storage).toBe("none");
});
```

Run: `pnpm --filter @devdb/daemon exec vitest run test/api.test.ts -t "portRange"` — FAIL (fields absent).

- [ ] **Step 2: Implement**

`packages/shared/src/index.ts` — extend `StatusDto`:

```ts
export interface StatusDto {
  version: string;
  healthy: boolean;
  engine: Record<string, { state: "running" | "stopped" | "failed"; pid: number | null }>;
  portRange: { min: number; max: number };
  storage: "none" | "s3" | "azure"; // typed for phase 4; the daemon returns "none" until then
}
```

`packages/daemon/src/http/api.ts` — status route return becomes:

```ts
return {
  version: PACKAGE_VERSION, healthy, engine,
  portRange: deps.cfg.portRange,
  storage: "none" as const, // phase 4 wires real modes (spec §Daemon additions)
};
```

`packages/daemon/src/state/repos.ts` — in the `BranchRow` interface, retype `createdBy` from `string` to `"ui" | "api" | "mcp"`, and in the `branchRow()` mapper give the field a single documented boundary cast:

```ts
// Row boundary: created_by is constrained by every write path (services pass the literal union;
// there is no other writer), so this is the one place the string column narrows to the union —
// letting dto.ts and everything downstream drop their per-use casts (handover §9 close-out).
createdBy: r.created_by as BranchRow["createdBy"],
```

`packages/daemon/src/services/dto.ts` — drop both casts:

```ts
endpointStatus: b.endpointStatus,   // BranchDetail already types this as EndpointStatus
createdBy: b.createdBy,             // BranchRow now carries the union
```

Grep to confirm the item is fully closed: `grep -rn "as BranchDto\[\|as EndpointStatus" packages/daemon/src` → expect no hits.

- [ ] **Step 3: Full unit suite, then commit**

Run: `pnpm --filter @devdb/daemon test` — all green (the tsc gate is the real assertion for the typing change).

```bash
git add packages/shared/src/index.ts packages/daemon/src packages/daemon/test
git commit -m "feat(api): status exposes portRange+storage; close §9 dto bare-string casts at the row boundary"
```

---

### Task 6: `packages/web` scaffold — workspace, Vite, Mantine shell, router, prefs

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`
- Create: `packages/web/src/main.tsx`, `src/theme.ts`, `src/prefs.ts`, `src/App.tsx`, `src/routes.tsx`, `src/pages/{DashboardPage,ProjectPage,SettingsPage}.tsx` (stubs for 8/10/11)
- Create: `packages/web/test/setup.ts`, `packages/web/test/render.tsx` (shared provider harness), `packages/web/test/app.test.tsx`

**Interfaces:**
- Produces: the app shell + routes (`/`, `/projects/:projectId`, `/settings`); `prefs.ts` API `getPref/setPref` with keys `devdb.defaultTreeView` (`"rails" | "canvas"`, default `"rails"`) and `devdb.theme` (`"auto" | "light" | "dark"`, default `"auto"`); `test/render.tsx`'s `renderApp(ui, opts?)` used by every later component test. Tasks 7–13 fill the stubs.

- [ ] **Step 1: Package + config files**

`packages/web/package.json`:

```json
{
  "name": "@devdb/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "test": "tsc --noEmit -p tsconfig.json && vitest run"
  },
  "dependencies": {
    "@devdb/shared": "workspace:*",
    "@mantine/core": "^9.4.1",
    "@mantine/hooks": "^9.4.1",
    "@mantine/notifications": "^9.4.1",
    "@tanstack/react-query": "^5.101.2",
    "@xyflow/react": "^12.11.1",
    "d3-hierarchy": "^3.1.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router": "^8.1.0"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.1",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/d3-hierarchy": "^3.1.7",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "jsdom": "^29.1.1",
    "typescript": "^5.7.0",
    "vite": "^8.1.3",
    "vitest": "^4.1.9"
  }
}
```

`packages/web/tsconfig.json` — standalone, NOT extending `tsconfig.base.json` (the base pins `module: NodeNext` for the Node packages; a Vite app needs bundler resolution — this is the one sanctioned divergence, mirrored on the base's strictness):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`packages/web/vite.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: the daemon owns :4400; Vite serves the SPA and proxies API + MCP so no CORS
    // surface is ever added to the daemon. SSE streams through http-proxy unbuffered by default —
    // do NOT add compression middleware here (it would buffer /api/events and the log tails).
    proxy: {
      "/api": { target: "http://localhost:4400", changeOrigin: true },
      "/mcp": { target: "http://localhost:4400", changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
```

`packages/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevDB</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Failing shell test first**

`packages/web/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`packages/web/test/render.tsx` — the provider harness every component test reuses:

```tsx
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

export function renderApp(ui: ReactElement, opts: { route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? makeQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>{ui}</MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}
```

`packages/web/test/app.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { App } from "../src/App.js";

describe("App shell", () => {
  it("renders the brand and global nav", () => {
    renderApp(<App />);
    expect(screen.getByText("DevDB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });
});
```

Run: `pnpm install` (workspace root — links the new package), then `pnpm --filter @devdb/web test`
Expected: FAIL — `../src/App.js` does not exist. (This is the scaffold's RED.)

- [ ] **Step 3: Implement the shell**

`packages/web/src/prefs.ts`:

```ts
// Client preferences are deliberately localStorage, not daemon-persisted (spec Decision 3):
// per-browser is correct for a local tool, and the daemon stays free of a user-settings store.
export type TreeView = "rails" | "canvas";
export type ThemePref = "auto" | "light" | "dark";

const KEYS = { defaultTreeView: "devdb.defaultTreeView", theme: "devdb.theme" } as const;

export function getDefaultTreeView(): TreeView {
  return localStorage.getItem(KEYS.defaultTreeView) === "canvas" ? "canvas" : "rails";
}
export function setDefaultTreeView(v: TreeView): void {
  localStorage.setItem(KEYS.defaultTreeView, v);
}
export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEYS.theme);
  return v === "light" || v === "dark" ? v : "auto";
}
export function setThemePref(v: ThemePref): void {
  localStorage.setItem(KEYS.theme, v);
}
```

`packages/web/src/theme.ts`:

```ts
import { createTheme } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
  fontFamilyMonospace: "ui-monospace, Menlo, Monaco, monospace",
});
```

`packages/web/src/App.tsx`:

```tsx
import { AppShell, Group, Anchor, Text, ActionIcon, useMantineColorScheme } from "@mantine/core";
import { Link, Outlet } from "react-router";

// Top-bar shell (spec Decision 4): brand, global nav, theme toggle. The SSE connection dot is
// added by Task 7 (it needs the events stream). No sidebar — too few global destinations.
export function App() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
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
```

`packages/web/src/routes.tsx`:

```tsx
import { createBrowserRouter } from "react-router";
import { App } from "./App.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "projects/:projectId", element: <ProjectPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
```

`packages/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@xyflow/react/dist/style.css";
import { router } from "./routes.js";
import { theme } from "./theme.js";
import { getThemePref } from "./prefs.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme={getThemePref()}>
        <Notifications position="top-right" />
        <RouterProvider router={router} />
      </MantineProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

Page stubs (each replaced by its own task):

```tsx
// packages/web/src/pages/DashboardPage.tsx   (Task 8 replaces)
import { Text } from "@mantine/core";
export function DashboardPage() { return <Text>Dashboard</Text>; }

// packages/web/src/pages/ProjectPage.tsx     (Task 10 replaces)
import { Text } from "@mantine/core";
export function ProjectPage() { return <Text>Project</Text>; }

// packages/web/src/pages/SettingsPage.tsx    (Task 11 replaces)
import { Text } from "@mantine/core";
export function SettingsPage() { return <Text>Settings</Text>; }
```

- [ ] **Step 4: Verify GREEN + build + workspace suite**

Run: `pnpm --filter @devdb/web test` — shell test passes (tsc gate + vitest).
Run: `pnpm --filter @devdb/web build` — `vite build` emits `packages/web/dist/index.html` + assets.
Run: `pnpm --filter @devdb/daemon test` — daemon suite still green. (Do NOT run the root `pnpm test` here — `pnpm -r test` includes `@devdb/integration`, a ~5-minute Docker suite that belongs to Task 16's gate.)

- [ ] **Step 5: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(web): scaffold packages/web — Vite 8 + React 19 + Mantine 9 shell, router, prefs, test harness"
```

---

### Task 7: API client, query keys/hooks, events stream + invalidation

**Files:**
- Create: `packages/web/src/api/client.ts`, `src/api/keys.ts`, `src/api/hooks.ts`, `src/api/events.ts`
- Modify: `packages/web/src/App.tsx` (mount `useEvents`, render the connection dot)
- Test: `packages/web/test/events.test.ts`, `packages/web/test/hooks.test.tsx`

**Interfaces:**
- Consumes: `DevdbEvent`/`DevdbEventSchema`, `BranchDto`, `ProjectDto`, `StatusDto` (shared); REST routes incl. Task 4's PATCH.
- Produces (used by every later task):
  - `api.status(): Promise<StatusDto>`; `api.projects.{list,create,delete}`; `api.branches.{list,get,create,delete,rename,start,stop,restore,reset}` — signatures in the code below.
  - `keys` — `status: ["status"]`, `projects: ["projects"]`, `branches(projectId): ["branches", projectId]`, `branch(id): ["branch", id]`.
  - Hooks: `useStatus()`, `useProjects()`, `useBranches(projectId)`, `useBranch(id)`, and mutation hooks that invalidate + toast errors.
  - `mapEventToKeys(e: DevdbEvent): QueryKey[]` (pure) and `startEvents(opts): () => void` with injectable `makeSource` (jsdom has no EventSource).
  - `useEvents(): EventsStatus` — mounted once in `App`; drives the top-bar connection dot.

- [ ] **Step 1: Failing tests for the pure pieces**

`packages/web/test/events.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mapEventToKeys, startEvents } from "../src/api/events.js";

describe("mapEventToKeys", () => {
  it("project events invalidate projects and all branch lists", () => {
    expect(mapEventToKeys({ type: "project.created", projectId: "p1", at: "t" }))
      .toEqual([["projects"], ["branches"]]);
  });
  it("branch events invalidate the project's branch list and the branch detail", () => {
    expect(mapEventToKeys({ type: "branch.updated", projectId: "p1", branchId: "b1", at: "t" }))
      .toEqual([["branches", "p1"], ["branch", "b1"]]);
  });
  it("a branch event missing projectId falls back to all branch lists", () => {
    expect(mapEventToKeys({ type: "endpoint.status", branchId: "b1", at: "t" }))
      .toEqual([["branches"], ["branch", "b1"]]);
  });
  it("engine.health invalidates status", () => {
    expect(mapEventToKeys({ type: "engine.health", at: "t" })).toEqual([["status"]]);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
}

describe("startEvents", () => {
  it("parses valid events, ignores garbage, reports status transitions", () => {
    vi.useFakeTimers();
    const seen: unknown[] = []; const statuses: string[] = [];
    const stop = startEvents({
      onEvent: (e) => seen.push(e),
      onOpen: () => {},
      onStatus: (s) => statuses.push(s),
      makeSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    });
    const es = FakeEventSource.instances.at(-1)!;
    es.onopen?.();
    es.onmessage?.({ data: JSON.stringify({ type: "branch.created", projectId: "p", branchId: "b", at: "t" }) });
    es.onmessage?.({ data: "not json" });
    expect(seen).toHaveLength(1);
    expect(statuses).toEqual(["connecting", "open"]);
    stop();
    expect(es.closed).toBe(true);
    vi.useRealTimers();
  });

  it("reconnects with doubling backoff capped at 10s, resetting on open", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    startEvents({
      onEvent: () => {}, onOpen: () => {}, onStatus: (s) => statuses.push(s),
      makeSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    });
    FakeEventSource.instances.at(-1)!.onerror?.();          // schedules reconnect at 1s
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances.at(-1)!.onerror?.();          // 2s
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(statuses.filter((s) => s === "reconnecting").length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
});
```

Run: `pnpm --filter @devdb/web exec vitest run test/events.test.ts` — FAIL (module missing). Capture RED.

- [ ] **Step 2: Implement client, keys, events**

`packages/web/src/api/client.ts`:

```ts
import type { BranchDto, ProjectDto, StatusDto, BranchContext } from "@devdb/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Daemon errors carry remediation-bearing messages (phase-2 convention) — surface verbatim.
    const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export type RestoreBody =
  | { mode: "in_place"; to: string }
  | { mode: "new_branch"; to: string; name: string };

export const api = {
  status: () => req<StatusDto>("/api/status"),
  projects: {
    list: () => req<ProjectDto[]>("/api/projects"),
    create: (b: { name: string; pgVersion?: number }) =>
      req<{ project: ProjectDto; mainBranch: BranchDto }>("/api/projects", { method: "POST", body: JSON.stringify(b) }),
    delete: (id: string) => req<void>(`/api/projects/${id}`, { method: "DELETE" }),
  },
  branches: {
    list: (projectId: string) => req<BranchDto[]>(`/api/projects/${projectId}/branches`),
    get: (id: string) => req<BranchDto>(`/api/branches/${id}`),
    create: (projectId: string, b: { name: string; parentBranchId?: string; context?: BranchContext }) =>
      req<BranchDto>(`/api/projects/${projectId}/branches`, { method: "POST", body: JSON.stringify(b) }),
    delete: (id: string) => req<void>(`/api/branches/${id}`, { method: "DELETE" }),
    rename: (id: string, name: string) =>
      req<BranchDto>(`/api/branches/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    start: (id: string) => req<BranchDto>(`/api/branches/${id}/endpoint/start`, { method: "POST" }),
    stop: (id: string) => req<BranchDto>(`/api/branches/${id}/endpoint/stop`, { method: "POST" }),
    restore: (id: string, body: RestoreBody) =>
      req<BranchDto>(`/api/branches/${id}/restore`, { method: "POST", body: JSON.stringify(body) }),
    reset: (id: string) => req<BranchDto>(`/api/branches/${id}/reset`, { method: "POST" }),
  },
};
```

`packages/web/src/api/keys.ts`:

```ts
export const keys = {
  status: ["status"] as const,
  projects: ["projects"] as const,
  branches: (projectId: string) => ["branches", projectId] as const,
  allBranches: ["branches"] as const,
  branch: (id: string) => ["branch", id] as const,
};
```

`packages/web/src/api/events.ts`:

```ts
import { DevdbEventSchema, type DevdbEvent } from "@devdb/shared";
import type { QueryKey } from "@tanstack/react-query";
import { keys } from "./keys.js";

// Invalidation map (spec Decision 1): events are hints; REST is truth. Coarse on purpose.
export function mapEventToKeys(e: DevdbEvent): QueryKey[] {
  switch (e.type) {
    case "project.created":
    case "project.deleted":
      return [[...keys.projects], [...keys.allBranches]];
    case "branch.created":
    case "branch.updated":
    case "branch.deleted":
    case "endpoint.status": {
      const list: QueryKey = e.projectId ? [...keys.branches(e.projectId)] : [...keys.allBranches];
      return e.branchId ? [list, [...keys.branch(e.branchId)]] : [list];
    }
    case "engine.health":
      return [[...keys.status]];
  }
}

export type EventsStatus = "connecting" | "open" | "reconnecting";

// EventSource wrapper with explicit capped backoff (1s → 10s, reset on open). Native EventSource
// auto-retry exists but gives no status signal and no cap control — we own the lifecycle so the
// top-bar dot can show truth. `makeSource` is injectable: jsdom has no EventSource.
export function startEvents(a: {
  onEvent: (e: DevdbEvent) => void;
  onOpen: () => void;
  onStatus: (s: EventsStatus) => void;
  makeSource?: (url: string) => EventSource;
}): () => void {
  const make = a.makeSource ?? ((u: string) => new EventSource(u));
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let stopped = false;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    a.onStatus(everOpened ? "reconnecting" : "connecting");
    es = make("/api/events");
    es.onopen = () => {
      everOpened = true;
      delay = 1000; // reset backoff
      a.onStatus("open");
      a.onOpen(); // blanket invalidate on EVERY (re)connect — the no-replay contract's other half
    };
    es.onmessage = (m) => {
      try {
        const parsed = DevdbEventSchema.safeParse(JSON.parse(m.data as string));
        if (parsed.success) a.onEvent(parsed.data);
      } catch {
        // garbage on the stream is ignored — hints only, REST is truth
      }
    };
    es.onerror = () => {
      es?.close();
      if (stopped) return;
      a.onStatus("reconnecting");
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
```

Run: `pnpm --filter @devdb/web exec vitest run test/events.test.ts` — GREEN.

- [ ] **Step 3: Hooks + App integration (failing test first)**

`packages/web/test/hooks.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { makeQueryClient } from "./render.js";
import { useEvents } from "../src/api/hooks.js";

vi.mock("../src/api/events.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/api/events.js")>();
  return { ...mod, startEvents: vi.fn(() => () => {}) };
});
import { startEvents } from "../src/api/events.js";

describe("useEvents", () => {
  it("starts the stream once, blanket-invalidates on open, and invalidates mapped keys per event", async () => {
    const client = makeQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}><MantineProvider>{children}</MantineProvider></QueryClientProvider>
    );
    renderHook(() => useEvents(), { wrapper });
    expect(startEvents).toHaveBeenCalledTimes(1);
    const opts = (startEvents as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    opts.onOpen();
    expect(invalidate).toHaveBeenCalledWith(); // blanket
    opts.onEvent({ type: "branch.created", projectId: "p1", branchId: "b1", at: "t" });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["branches", "p1"] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["branch", "b1"] });
    });
  });
});
```

Run RED, then create `packages/web/src/api/hooks.ts`:

```ts
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { api, type RestoreBody } from "./client.js";
import { keys } from "./keys.js";
import { mapEventToKeys, startEvents, type EventsStatus } from "./events.js";

export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: api.status });
}
export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.projects.list });
}
export function useBranches(projectId: string) {
  return useQuery({ queryKey: keys.branches(projectId), queryFn: () => api.branches.list(projectId) });
}
export function useBranch(id: string | null) {
  return useQuery({
    queryKey: keys.branch(id ?? "none"),
    queryFn: () => api.branches.get(id!),
    enabled: id !== null,
  });
}

function onError(e: unknown): void {
  notifications.show({ color: "red", title: "Request failed", message: e instanceof Error ? e.message : String(e) });
}

// One mutation-hook factory: run the call, toast failures with the daemon's remediation-bearing
// message, invalidate directly (UI-originated mutations don't wait for their event echo).
function useApiMutation<TArgs, TOut>(fn: (a: TArgs) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onError,
    onSettled: () => qc.invalidateQueries(),
  });
}

export function useCreateProject() { return useApiMutation(api.projects.create); }
export function useDeleteProject() { return useApiMutation(api.projects.delete); }
export function useCreateBranch() {
  return useApiMutation((a: { projectId: string; name: string; parentBranchId?: string }) =>
    api.branches.create(a.projectId, { name: a.name, parentBranchId: a.parentBranchId }));
}
export function useDeleteBranch() { return useApiMutation(api.branches.delete); }
export function useRenameBranch() {
  return useApiMutation((a: { id: string; name: string }) => api.branches.rename(a.id, a.name));
}
export function useStartEndpoint() { return useApiMutation(api.branches.start); }
export function useStopEndpoint() { return useApiMutation(api.branches.stop); }
export function useRestoreBranch() {
  return useApiMutation((a: { id: string; body: RestoreBody }) => api.branches.restore(a.id, a.body));
}
export function useResetBranch() { return useApiMutation(api.branches.reset); }

// Mounted ONCE in App. Blanket invalidate on every (re)connect; per-event mapped invalidation.
export function useEvents(): EventsStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<EventsStatus>("connecting");
  useEffect(() => {
    return startEvents({
      onOpen: () => void qc.invalidateQueries(),
      onEvent: (e) => { for (const k of mapEventToKeys(e)) void qc.invalidateQueries({ queryKey: k }); },
      onStatus: setStatus,
    });
  }, [qc]);
  return status;
}
```

Modify `packages/web/src/App.tsx` — inside the component add `const eventsStatus = useEvents();`, and in the right-hand `Group` before the theme toggle render the dot:

```tsx
<Tooltip label={eventsStatus === "open" ? "live updates connected" : `live updates: ${eventsStatus}`}>
  <Text span data-testid="conn-dot" c={eventsStatus === "open" ? "green.6" : "yellow.6"}>●</Text>
</Tooltip>
```

(Add `Tooltip` to the Mantine import; add `import { useEvents } from "./api/hooks.js";`. `test/app.test.tsx` gains the same `vi.mock` of `../src/api/events.js` used above so the shell test stays hermetic — assert the dot renders with `data-testid="conn-dot"`.)

- [ ] **Step 4: Full web suite, then commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): typed API client, query hooks, /api/events stream with mapped invalidation + connection dot"
```

---

### Task 8: Dashboard — engine health, storage chip, project cards, create/delete project

**Files:**
- Modify: `packages/web/src/pages/DashboardPage.tsx` (replace stub)
- Test: `packages/web/test/dashboard.test.tsx`

**Interfaces:**
- Consumes: `useStatus`, `useProjects`, `useCreateProject`, `useDeleteProject` (Task 7); `SUPPORTED_PG_VERSIONS`, `DEFAULT_PG_VERSION` (shared).
- Produces: project cards navigate to `/projects/:id` — Task 10's page is the destination.

- [ ] **Step 1: Failing tests**

`packages/web/test/dashboard.test.tsx` (mock the client module — hooks run real):

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { DashboardPage } from "../src/pages/DashboardPage.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(),
    projects: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    branches: {},
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto, ProjectDto, StatusDto } from "@devdb/shared";

// FULLY-typed fixtures (repo rule: no `as any`/`as never`, tests included). Because the fixtures
// carry their DTO types, vi.mocked(api.x).mockResolvedValue(fixture) needs no cast at all —
// the mock's generic flows from the real module's type through vi.mocked.
const status: StatusDto = {
  version: "0.1.0", healthy: true,
  engine: { pageserver: { state: "running", pid: 1 }, safekeeper: { state: "running", pid: 2 } },
  portRange: { min: 54300, max: 54339 }, storage: "none",
};
const projects: ProjectDto[] = [
  { id: "p1", name: "shop-api", pgVersion: 17, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z" },
];
const mainBranch: BranchDto = {
  id: "b-main", projectId: "p1", parentBranchId: null, name: "main", slug: "main-s",
  timelineId: "t".repeat(32), endpointStatus: "stopped", endpointError: null, port: null,
  connectionString: null, lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui",
  context: null, ancestorLsn: null, createdAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(api.status).mockResolvedValue(status);
  vi.mocked(api.projects.list).mockResolvedValue(projects);
});

describe("DashboardPage", () => {
  it("renders engine component chips, storage chip, and project cards", async () => {
    renderApp(<DashboardPage />);
    expect(await screen.findByText("shop-api")).toBeInTheDocument();
    expect(screen.getByText(/pageserver/)).toBeInTheDocument();
    expect(screen.getByText(/local storage/i)).toBeInTheDocument();
    expect(screen.getByText(/PG 17/)).toBeInTheDocument();
  });

  it("shows a degraded banner when unhealthy", async () => {
    vi.mocked(api.status).mockResolvedValue({ ...status, healthy: false, engine: { pageserver: { state: "failed", pid: null } } });
    renderApp(<DashboardPage />);
    expect(await screen.findByText(/engine degraded/i)).toBeInTheDocument();
  });

  it("creates a project through the modal with a PG version picker", async () => {
    vi.mocked(api.projects.create).mockResolvedValue({ project: projects[0]!, mainBranch });
    renderApp(<DashboardPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new project/i }));
    await userEvent.type(screen.getByLabelText(/name/i), "billing");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(api.projects.create).toHaveBeenCalledWith({ name: "billing", pgVersion: 17 }));
  });
});
```

This typed-fixture pattern (DTO-typed consts + cast-free `mockResolvedValue`) is the binding convention for EVERY web test file in this plan — the repo's no-`as any`/`as never` rule includes tests.

- [ ] **Step 2: RED**

Run: `pnpm --filter @devdb/web exec vitest run test/dashboard.test.tsx`
Expected: FAIL — stub renders none of it.

- [ ] **Step 3: Implement**

`packages/web/src/pages/DashboardPage.tsx`:

```tsx
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
        <Badge variant="outline" color="gray">local storage</Badge>
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
```

- [ ] **Step 4: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): dashboard — engine health strip, project cards, create/delete project"
```

---

### Task 9: Tree model — buildTree, rails layout, canvas layout, chips, actions menu

**Files:**
- Create: `packages/web/src/tree/model.ts`, `src/tree/chips.tsx`, `src/tree/BranchActionsMenu.tsx`
- Test: `packages/web/test/tree-model.test.ts`, `packages/web/test/chips.test.tsx`

**Interfaces:**
- Consumes: `BranchDto` (shared).
- Produces (Tasks 10–12 consume exactly these):

```ts
export interface TreeNode { branch: BranchDto; children: TreeNode[] }
export function buildTree(branches: BranchDto[]): TreeNode[];            // roots (parentless + orphans), children sorted by createdAt
export interface RailsLayout {
  rows: Array<{ branch: BranchDto; lane: number; row: number }>;         // DFS preorder
  verticals: Array<{ lane: number; fromRow: number; toRow: number }>;    // parent lane spans to its last child's row
  curves: Array<{ fromLane: number; toLane: number; atRow: number }>;    // one per child, departing the parent lane
  maxLane: number;
}
export function railsLayout(roots: TreeNode[]): RailsLayout;
export function canvasLayout(roots: TreeNode[]): {
  nodes: Array<{ id: string; x: number; y: number; branch: BranchDto }>;
  edges: Array<{ id: string; source: string; target: string }>;
};
// chips.tsx
export function StatusChip(a: { branch: BranchDto }): JSX.Element;       // running :port green · starting/stopping yellow · stopped gray · failed red
export function ContextChip(a: { context: BranchContext }): JSX.Element; // 🤖 agent · git_branch, tooltip purpose/workdir/client
// BranchActionsMenu.tsx — kebab wired to Task 7 mutations + callbacks the pages provide
export function BranchActionsMenu(a: { branch: BranchDto; onOpenDrawer: () => void; onBranchFrom: () => void }): JSX.Element;
```

- [ ] **Step 1: Failing model tests**

`packages/web/test/tree-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BranchDto } from "@devdb/shared";
import { buildTree, railsLayout, canvasLayout } from "../src/tree/model.js";

function b(id: string, parent: string | null, createdAt: string): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-slug`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null,
    ancestorLsn: null, createdAt, updatedAt: createdAt,
  };
}

describe("buildTree", () => {
  it("links children under parents, sorted by createdAt", () => {
    const roots = buildTree([b("main", null, "1"), b("b2", "main", "3"), b("b1", "main", "2")]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.branch.id)).toEqual(["b1", "b2"]);
  });
  it("tolerates an orphan (parent id not in the list) by promoting it to a root", () => {
    const roots = buildTree([b("main", null, "1"), b("lost", "gone", "2")]);
    expect(roots.map((r) => r.branch.id).sort()).toEqual(["lost", "main"]);
  });
});

describe("railsLayout", () => {
  // main ── b1 ── b1a, plus main ── b2   (DFS preorder rows: main,b1,b1a,b2)
  const roots = buildTree([b("main", null, "1"), b("b1", "main", "2"), b("b1a", "b1", "3"), b("b2", "main", "4")]);
  const l = railsLayout(roots);
  it("assigns DFS preorder rows and one lane per branch in first-visit order", () => {
    expect(l.rows.map((r) => [r.branch.id, r.lane, r.row])).toEqual([
      ["main", 0, 0], ["b1", 1, 1], ["b1a", 2, 2], ["b2", 3, 3],
    ]);
    expect(l.maxLane).toBe(3);
  });
  it("parent verticals span to their last child's row; one curve per child", () => {
    expect(l.verticals).toContainEqual({ lane: 0, fromRow: 0, toRow: 3 }); // main → b2 is its last child
    expect(l.verticals).toContainEqual({ lane: 1, fromRow: 1, toRow: 2 }); // b1 → b1a
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 1, atRow: 1 });
    expect(l.curves).toContainEqual({ fromLane: 1, toLane: 2, atRow: 2 });
    expect(l.curves).toContainEqual({ fromLane: 0, toLane: 3, atRow: 3 });
  });
});

describe("canvasLayout", () => {
  it("positions the root above its children and emits one edge per parent-child pair", () => {
    const roots = buildTree([b("main", null, "1"), b("b1", "main", "2"), b("b2", "main", "3")]);
    const { nodes, edges } = canvasLayout(roots);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["main"]!.y).toBeLessThan(byId["b1"]!.y);
    expect(byId["b1"]!.x).not.toBe(byId["b2"]!.x); // siblings spread horizontally
    expect(edges).toContainEqual(expect.objectContaining({ source: "main", target: "b1" }));
    expect(edges).toHaveLength(2);
  });
});
```

Run RED: `pnpm --filter @devdb/web exec vitest run test/tree-model.test.ts` — module missing.

- [ ] **Step 2: Implement the model**

`packages/web/src/tree/model.ts`:

```ts
import { hierarchy, tree } from "d3-hierarchy";
import type { BranchDto } from "@devdb/shared";

export interface TreeNode { branch: BranchDto; children: TreeNode[] }

// Branches form a strict tree (no merges) — parentBranchId linking. Orphans (parent deleted or
// not yet fetched during an invalidation window) are promoted to roots rather than dropped: a
// transiently-inconsistent tree must render, never crash or hide branches.
export function buildTree(branches: BranchDto[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(branches.map((b) => [b.id, { branch: b, children: [] }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.branch.parentBranchId ? nodes.get(n.branch.parentBranchId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const byCreated = (a: TreeNode, z: TreeNode) => a.branch.createdAt.localeCompare(z.branch.createdAt);
  const sortRec = (n: TreeNode) => { n.children.sort(byCreated); n.children.forEach(sortRec); };
  roots.sort(byCreated);
  roots.forEach(sortRec);
  return roots;
}

export interface RailsLayout {
  rows: Array<{ branch: BranchDto; lane: number; row: number }>;
  verticals: Array<{ lane: number; fromRow: number; toRow: number }>;
  curves: Array<{ fromLane: number; toLane: number; atRow: number }>;
  maxLane: number;
}

// Git-graph gutter layout. DFS preorder = row order; every branch gets its own lane in
// first-visit order (matches the approved mockup). A parent's lane line runs from its own row
// down to its LAST child's row (where the last curve departs); each child gets one curve from
// the parent's lane into its own at its row.
export function railsLayout(roots: TreeNode[]): RailsLayout {
  const rows: RailsLayout["rows"] = [];
  const verticals: RailsLayout["verticals"] = [];
  const curves: RailsLayout["curves"] = [];
  let nextLane = 0;

  const walk = (n: TreeNode): { lane: number; row: number } => {
    const lane = nextLane++;
    const row = rows.length;
    rows.push({ branch: n.branch, lane, row });
    let lastChildRow = row;
    for (const c of n.children) {
      const child = walk(c);
      curves.push({ fromLane: lane, toLane: child.lane, atRow: child.row });
      lastChildRow = child.row;
    }
    if (n.children.length > 0) verticals.push({ lane, fromRow: row, toRow: lastChildRow });
    return { lane, row };
  };
  roots.forEach(walk);
  return { rows, verticals, curves, maxLane: Math.max(0, nextLane - 1) };
}

const NODE_W = 230;
const NODE_H = 96;

// React Flow positions via d3-hierarchy's tidy tree. Multiple roots (orphans) hang off a
// synthetic invisible root that is excluded from the output.
// A real (never-rendered) BranchDto for the synthetic root — full literal instead of a cast,
// per the repo's no-`as any`/`as never` rule (filtered out of the output before anything reads it).
const SYNTHETIC_ROOT: BranchDto = {
  id: "__root__", projectId: "__root__", parentBranchId: null, name: "__root__", slug: "__root__",
  timelineId: "", endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "ui", context: null, ancestorLsn: null,
  createdAt: "", updatedAt: "",
};

export function canvasLayout(roots: TreeNode[]): {
  nodes: Array<{ id: string; x: number; y: number; branch: BranchDto }>;
  edges: Array<{ id: string; source: string; target: string }>;
} {
  const synthetic: TreeNode = { branch: SYNTHETIC_ROOT, children: roots };
  const h = hierarchy<TreeNode>(synthetic, (n) => n.children);
  tree<TreeNode>().nodeSize([NODE_W + 40, NODE_H + 60])(h);
  const nodes: Array<{ id: string; x: number; y: number; branch: BranchDto }> = [];
  const edges: Array<{ id: string; source: string; target: string }> = [];
  for (const d of h.descendants()) {
    if (d.data.branch.id === "__root__") continue;
    nodes.push({ id: d.data.branch.id, x: d.x!, y: d.y! - (NODE_H + 60), branch: d.data.branch });
    for (const c of d.children ?? []) {
      edges.push({ id: `${d.data.branch.id}->${c.data.branch.id}`, source: d.data.branch.id, target: c.data.branch.id });
    }
  }
  return { nodes, edges };
}
```

(Filtering happens on `id === "__root__"` — keep the exclusion check in `descendants()` exactly as written.)

- [ ] **Step 3: Chips + actions menu (failing test, then implement)**

`packages/web/test/chips.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { StatusChip, ContextChip } from "../src/tree/chips.js";
import type { BranchDto } from "@devdb/shared";

const base = { endpointError: null } as Pick<BranchDto, "endpointError">;

describe("chips", () => {
  it("running shows the port; failed shows red with the error in a tooltip", () => {
    renderApp(<StatusChip branch={{ ...base, endpointStatus: "running", port: 54303 } as BranchDto} />);
    expect(screen.getByText(/running :54303/)).toBeInTheDocument();
  });
  it("context chip shows agent and git branch", () => {
    renderApp(<ContextChip context={{ agent: "claude", git_branch: "fix-checkout" }} />);
    expect(screen.getByText(/claude · fix-checkout/)).toBeInTheDocument();
  });
});
```

`packages/web/src/tree/chips.tsx`:

```tsx
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
```

`packages/web/src/tree/BranchActionsMenu.tsx`:

```tsx
import { Menu, ActionIcon } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { BranchDto } from "@devdb/shared";
import { useDeleteBranch, useResetBranch, useStartEndpoint, useStopEndpoint } from "../api/hooks.js";

export function BranchActionsMenu(a: { branch: BranchDto; onOpenDrawer: () => void; onBranchFrom: () => void }) {
  const start = useStartEndpoint(); const stop = useStopEndpoint();
  const del = useDeleteBranch(); const reset = useResetBranch();
  const b = a.branch;
  const copyConnstring = () => {
    if (!b.connectionString) {
      notifications.show({ color: "yellow", message: "No connection string — endpoint is not running. Start it first." });
      return;
    }
    void navigator.clipboard.writeText(b.connectionString);
    notifications.show({ color: "green", message: "Connection string copied" });
  };
  return (
    <Menu withinPortal position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label={`actions for ${b.name}`}>⋯</ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={a.onOpenDrawer}>Open panel</Menu.Item>
        <Menu.Item onClick={a.onBranchFrom}>Branch from here…</Menu.Item>
        <Menu.Item onClick={copyConnstring}>Copy connection string</Menu.Item>
        {b.endpointStatus === "running" || b.endpointStatus === "starting"
          ? <Menu.Item onClick={() => stop.mutate(b.id)}>Stop endpoint</Menu.Item>
          : <Menu.Item onClick={() => start.mutate(b.id)}>Start endpoint</Menu.Item>}
        <Menu.Divider />
        <Menu.Item color="red" disabled={b.parentBranchId === null}
          onClick={() => window.confirm(`Reset "${b.name}" to its parent's current state? All divergent data is lost.`) && reset.mutate(b.id)}>
          Reset from parent…
        </Menu.Item>
        <Menu.Item color="red"
          onClick={() => window.confirm(`Delete branch "${b.name}"? This cannot be undone.`) && del.mutate(b.id)}>
          Delete…
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
```

- [ ] **Step 4: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): tree model (buildTree, rails+canvas layouts), status/context chips, branch actions menu"
```

---

### Task 10: RailsView + ProjectPage assembly (toggle, new-branch modal, drawer param)

**Files:**
- Create: `packages/web/src/tree/RailsView.tsx`
- Modify: `packages/web/src/pages/ProjectPage.tsx` (replace stub)
- Test: `packages/web/test/rails.test.tsx`, `packages/web/test/project-page.test.tsx`

**Interfaces:**
- Consumes: `railsLayout`/`buildTree` (Task 9), `useBranches`/`useCreateBranch` (Task 7), chips + menu (Task 9), `getDefaultTreeView` (Task 6).
- Produces: `RailsView({ branches, onSelect })`; ProjectPage renders the toggle (`rails | canvas`) with the canvas slot filled by a placeholder `<div data-testid="canvas-placeholder">` that Task 11 replaces; drawer selection = `?branch=<id>` search param (deep-linkable) — Task 12 mounts the drawer off the same param.

**Geometry constants (binding for tests):** `ROW_H = 40`, `LANE_W = 16`, `X0 = 10`, `DOT_R = 5`; gutter width `X0 + (maxLane + 1) * LANE_W`; row y-center `row * ROW_H + ROW_H / 2`; curve = cubic from `(x(fromLane), y(atRow) - ROW_H * 0.6)` to `(x(toLane), y(atRow))`.

- [ ] **Step 1: Failing RailsView test**

`packages/web/test/rails.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { RailsView } from "../src/tree/RailsView.js";
import type { BranchDto } from "@devdb/shared";

function b(id: string, parent: string | null, over: Partial<BranchDto> = {}): BranchDto {
  return {
    id, projectId: "p1", parentBranchId: parent, name: id, slug: `${id}-s`, timelineId: "t".repeat(32),
    endpointStatus: "stopped", endpointError: null, port: null, connectionString: null,
    lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
    createdAt: id, updatedAt: id, ...over,
  };
}

describe("RailsView", () => {
  const branches = [
    b("main", null, { endpointStatus: "running", port: 54301 }),
    b("agent-fix", "main", { createdBy: "mcp", context: { agent: "claude", git_branch: "fix-1" } }),
  ];
  it("renders one row per branch with status + context chips and the SVG gutter", () => {
    renderApp(<RailsView branches={branches} onSelect={() => {}} />);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText(/running :54301/)).toBeInTheDocument();
    expect(screen.getByText(/claude · fix-1/)).toBeInTheDocument();
    const svg = document.querySelector("svg[data-testid=rails-gutter]")!;
    expect(svg.querySelectorAll("circle")).toHaveLength(2);   // one dot per branch
    expect(svg.querySelectorAll("path")).toHaveLength(1);     // one fork curve
  });
  it("clicking a row selects the branch", async () => {
    const onSelect = vi.fn();
    renderApp(<RailsView branches={branches} onSelect={onSelect} />);
    (screen.getByText("agent-fix").closest("[data-branch-row]") as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith("agent-fix");
  });
});
```

Run RED.

- [ ] **Step 2: Implement RailsView**

`packages/web/src/tree/RailsView.tsx`:

```tsx
import { Group, Text, UnstyledButton } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { buildTree, railsLayout } from "./model.js";
import { StatusChip, ContextChip } from "./chips.js";
import { BranchActionsMenu } from "./BranchActionsMenu.js";

const ROW_H = 40; const LANE_W = 16; const X0 = 10; const DOT_R = 5;
const LANE_COLORS = ["#4dabf7", "#9775fa", "#63e6be", "#ffa94d", "#f783ac", "#74c0fc", "#b197fc", "#38d9a9"];
const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length]!;
const x = (lane: number) => X0 + lane * LANE_W;
const y = (row: number) => row * ROW_H + ROW_H / 2;

export function RailsView(a: {
  branches: BranchDto[];
  onSelect: (branchId: string) => void;
  onBranchFrom?: (branchId: string) => void;
}) {
  const layout = railsLayout(buildTree(a.branches));
  const gutterW = X0 + (layout.maxLane + 1) * LANE_W;
  const height = layout.rows.length * ROW_H;
  return (
    <Group align="flex-start" gap={0} wrap="nowrap">
      <svg data-testid="rails-gutter" width={gutterW} height={height} style={{ flex: "none" }}>
        {layout.verticals.map((v, i) => (
          <line key={i} x1={x(v.lane)} y1={y(v.fromRow)} x2={x(v.lane)} y2={y(v.toRow)}
            stroke={laneColor(v.lane)} strokeWidth={2} />
        ))}
        {layout.curves.map((c, i) => (
          <path key={i} fill="none" stroke={laneColor(c.toLane)} strokeWidth={2}
            d={`M ${x(c.fromLane)} ${y(c.atRow) - ROW_H * 0.6} C ${x(c.fromLane)} ${y(c.atRow)}, ${x(c.toLane)} ${y(c.atRow) - ROW_H * 0.4}, ${x(c.toLane)} ${y(c.atRow)}`} />
        ))}
        {layout.rows.map((r) => (
          <circle key={r.branch.id} cx={x(r.lane)} cy={y(r.row)} r={DOT_R} fill={laneColor(r.lane)} />
        ))}
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        {layout.rows.map((r) => (
          <UnstyledButton
            key={r.branch.id}
            data-branch-row
            onClick={() => a.onSelect(r.branch.id)}
            w="100%"
            style={{ height: ROW_H, display: "flex", alignItems: "center" }}
          >
            <Group gap="xs" wrap="nowrap" w="100%">
              <Text ff="monospace" fw={600} size="sm" truncate>{r.branch.name}</Text>
              <StatusChip branch={r.branch} />
              {r.branch.context && <ContextChip context={r.branch.context} />}
              <div style={{ marginLeft: "auto" }} onClick={(e) => e.stopPropagation()}>
                <BranchActionsMenu
                  branch={r.branch}
                  onOpenDrawer={() => a.onSelect(r.branch.id)}
                  onBranchFrom={() => a.onBranchFrom?.(r.branch.id)}
                />
              </div>
            </Group>
          </UnstyledButton>
        ))}
      </div>
    </Group>
  );
}
```

- [ ] **Step 3: ProjectPage (failing test, then implement)**

`packages/web/test/project-page.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "./render.js";
import { ProjectPage } from "../src/pages/ProjectPage.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: { list: vi.fn() },
    branches: { list: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn(), rename: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), reset: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

const main: BranchDto = {
  id: "b-main", projectId: "p1", parentBranchId: null, name: "main", slug: "main-s", timelineId: "t".repeat(32),
  endpointStatus: "running", endpointError: null, port: 54301, connectionString: "postgresql://postgres:pw@localhost:54301/postgres",
  lastRecordLsn: null, logicalSizeBytes: null, createdBy: "api", context: null, ancestorLsn: null,
  createdAt: "1", updatedAt: "1",
};

function renderPage(route = "/projects/p1") {
  return renderApp(
    <Routes><Route path="/projects/:projectId" element={<ProjectPage />} /></Routes>,
    { route },
  );
}

beforeEach(() => vi.mocked(api.branches.list).mockResolvedValue([main]));

describe("ProjectPage", () => {
  it("renders the rails view by default with the view toggle", async () => {
    renderPage();
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /rails/i })).toBeChecked();
  });
  it("toggle switches to the canvas slot", async () => {
    renderPage();
    await screen.findByText("main");
    await userEvent.click(screen.getByRole("radio", { name: /canvas/i }));
    expect(screen.getByTestId("canvas-placeholder")).toBeInTheDocument();
  });
  it("creates a branch through the modal (defaults parent to main)", async () => {
    vi.mocked(api.branches.create).mockResolvedValue({ ...main, id: "b2", name: "dev" });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /new branch/i }));
    await userEvent.type(screen.getByLabelText(/name/i), "dev");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(api.branches.create).toHaveBeenCalledWith("p1", { name: "dev", parentBranchId: "b-main" }));
  });
  it("selecting a branch writes ?branch= to the URL", async () => {
    renderPage();
    (await screen.findByText("main")).closest("[data-branch-row]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(window.location.search === "?branch=b-main" || document.querySelector("[data-selected-branch=b-main]")).toBeTruthy());
  });
});
```

(MemoryRouter doesn't drive `window.location` — implement selection via `useSearchParams` and assert through `data-selected-branch` on the page root; keep the test's second disjunct.)

Implement `packages/web/src/pages/ProjectPage.tsx`:

```tsx
import { useState } from "react";
import { Button, Group, Modal, SegmentedControl, Select, Skeleton, Stack, Text, TextInput, Title } from "@mantine/core";
import { Link, useParams, useSearchParams } from "react-router";
import type { BranchDto } from "@devdb/shared";
import { useBranches, useCreateBranch } from "../api/hooks.js";
import { RailsView } from "../tree/RailsView.js";
import { getDefaultTreeView, type TreeView } from "../prefs.js";

function NewBranchModal(a: { projectId: string; branches: BranchDto[]; opened: boolean; onClose: () => void; defaultParentId?: string }) {
  const create = useCreateBranch();
  const [name, setName] = useState("");
  const mainId = a.branches.find((b) => b.parentBranchId === null)?.id;
  const [parent, setParent] = useState<string | undefined>(a.defaultParentId ?? mainId);
  return (
    <Modal opened={a.opened} onClose={a.onClose} title="New branch">
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Select
          label="Parent branch"
          data={a.branches.map((b) => ({ value: b.id, label: b.name }))}
          value={parent ?? null}
          onChange={(v) => v && setParent(v)}
        />
        <Button
          loading={create.isPending}
          disabled={name.trim() === "" || !parent}
          onClick={() => create.mutate(
            { projectId: a.projectId, name: name.trim(), parentBranchId: parent },
            { onSuccess: a.onClose },
          )}
        >
          Create
        </Button>
      </Stack>
    </Modal>
  );
}

export function ProjectPage() {
  const { projectId } = useParams() as { projectId: string };
  const { data: branches, error } = useBranches(projectId);
  const [view, setView] = useState<TreeView>(getDefaultTreeView());
  const [params, setParams] = useSearchParams();
  const selected = params.get("branch");
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);

  const select = (id: string | null) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set("branch", id); else next.delete("branch");
      return next;
    });
  };

  // Spec §Error handling: unknown ids get a friendly state pointing home, not a blank page.
  if (error) {
    return (
      <Stack align="flex-start">
        <Title order={3}>Project not found</Title>
        <Text c="dimmed">{error instanceof Error ? error.message : "It may have been deleted."}</Text>
        <Button component={Link} to="/">Back to dashboard</Button>
      </Stack>
    );
  }
  if (!branches) return <Skeleton height={200} />;
  return (
    <Stack data-selected-branch={selected ?? undefined}>
      <Group justify="space-between">
        <Title order={2}>Branches</Title>
        <Group>
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as TreeView)}
            data={[{ value: "rails", label: "⑃ rails" }, { value: "canvas", label: "▦ canvas" }]}
          />
          <Button onClick={() => setCreating({})}>+ New branch</Button>
        </Group>
      </Group>
      {branches.length === 0 && (
        <Text c="dimmed">No branches yet. Point an agent at <Text span ff="monospace">http://localhost:4400/mcp</Text> or create one here.</Text>
      )}
      {view === "rails"
        ? <RailsView branches={branches} onSelect={select} onBranchFrom={(id) => setCreating({ parentId: id })} />
        : <div data-testid="canvas-placeholder"><Text c="dimmed">canvas view lands in Task 11</Text></div>}
      <NewBranchModal
        projectId={projectId}
        branches={branches}
        opened={creating !== null}
        onClose={() => setCreating(null)}
        defaultParentId={creating?.parentId}
      />
      {/* Task 12 mounts <BranchDrawer branchId={selected} onClose={() => select(null)} /> here */}
    </Stack>
  );
}
```

- [ ] **Step 4: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): rails renderer + project page with view toggle, new-branch modal, ?branch= selection"
```

---

### Task 11: CanvasView (React Flow) + Settings page

**Files:**
- Create: `packages/web/src/tree/CanvasView.tsx`, `src/tree/BranchNode.tsx`
- Modify: `packages/web/src/pages/ProjectPage.tsx` (replace the canvas placeholder)
- Modify: `packages/web/src/pages/SettingsPage.tsx` (replace stub)
- Test: `packages/web/test/canvas.test.tsx`, `packages/web/test/settings.test.tsx`

**Interfaces:**
- Consumes: `canvasLayout` (Task 9), chips (Task 9), prefs (Task 6), `useStatus` (Task 7).
- Produces: `CanvasView({ branches, onSelect })` — same props contract as RailsView minus `onBranchFrom` (canvas nodes use the drawer for actions).

- [ ] **Step 1: Failing tests**

`packages/web/test/canvas.test.tsx` — note: React Flow needs layout measurements jsdom lacks; test through the layout fn + node rendering, not RF internals:

```tsx
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "./render.js";
import { CanvasView } from "../src/tree/CanvasView.js";
// fixture builder b() as in rails.test.tsx

describe("CanvasView", () => {
  it("renders a React Flow node per branch with chips", () => {
    renderApp(<CanvasView branches={[b("main", null), b("dev", "main")]} onSelect={() => {}} />);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });
});
```

`packages/web/test/settings.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { getDefaultTreeView } from "../src/prefs.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: { status: vi.fn().mockResolvedValue({
    version: "0.1.0", healthy: true, engine: {}, portRange: { min: 54300, max: 54339 }, storage: "none",
  }), projects: {}, branches: {} },
}));

beforeEach(() => localStorage.clear());

describe("SettingsPage", () => {
  it("shows read-only daemon facts", async () => {
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/54300\s*–\s*54339/)).toBeInTheDocument();
    expect(screen.getByText(/local \(none\)/i)).toBeInTheDocument();
  });
  it("changes the default tree view preference in localStorage", async () => {
    renderApp(<SettingsPage />);
    await userEvent.click(await screen.findByRole("radio", { name: /canvas/i }));
    expect(getDefaultTreeView()).toBe("canvas");
  });
  it("renders the phase-4 stubs disabled", async () => {
    renderApp(<SettingsPage />);
    expect(await screen.findByText(/remote storage/i)).toBeInTheDocument();
    expect(screen.getByText(/coming in phase 4/i)).toBeInTheDocument();
  });
});
```

Run RED.

- [ ] **Step 2: Implement**

`packages/web/src/tree/BranchNode.tsx`:

```tsx
import { Handle, Position } from "@xyflow/react";
import { Card, Group, Text } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";
import { StatusChip, ContextChip } from "./chips.js";

export function BranchNode(a: { data: { branch: BranchDto; onSelect: (id: string) => void } }) {
  const b = a.data.branch;
  return (
    <Card withBorder padding="xs" w={230} onClick={() => a.data.onSelect(b.id)} style={{ cursor: "pointer" }}>
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <Text ff="monospace" fw={600} size="sm" truncate>{b.name}</Text>
      <Group gap={4} mt={4}>
        <StatusChip branch={b} />
        {b.context && <ContextChip context={b.context} />}
      </Group>
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </Card>
  );
}
```

`packages/web/src/tree/CanvasView.tsx`:

```tsx
import { useMemo } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { BranchDto } from "@devdb/shared";
import { buildTree, canvasLayout } from "./model.js";
import { BranchNode } from "./BranchNode.js";

const nodeTypes = { branch: BranchNode };

// Nodes are NOT draggable (spec Decision 3): layout is computed; pan/zoom + fit-view only.
export function CanvasView(a: { branches: BranchDto[]; onSelect: (id: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const l = canvasLayout(buildTree(a.branches));
    return {
      nodes: l.nodes.map((n) => ({
        id: n.id, type: "branch" as const, position: { x: n.x, y: n.y },
        data: { branch: n.branch, onSelect: a.onSelect },
      })),
      edges: l.edges.map((e) => ({ ...e, type: "smoothstep" as const })),
    };
  }, [a.branches, a.onSelect]);
  return (
    <div style={{ height: "calc(100vh - 220px)", minHeight: 360 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
```

In `ProjectPage.tsx`, replace the placeholder branch of the ternary with:

```tsx
: <CanvasView branches={branches} onSelect={select} />}
```

(+ import. Keep `data-testid="canvas-placeholder"` OUT — update the Task 10 test to assert the React Flow container instead: `document.querySelector(".react-flow")`.)

`packages/web/src/pages/SettingsPage.tsx`:

```tsx
import { Card, Divider, Group, SegmentedControl, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useStatus } from "../api/hooks.js";
import { getDefaultTreeView, getThemePref, setDefaultTreeView, setThemePref, type ThemePref, type TreeView } from "../prefs.js";
import { useMantineColorScheme } from "@mantine/core";

export function SettingsPage() {
  const { data: status } = useStatus();
  const [view, setView] = useState<TreeView>(getDefaultTreeView());
  const [themePref, setTheme] = useState<ThemePref>(getThemePref());
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

      <Card withBorder opacity={0.65}>
        <Title order={4}>Remote storage</Title>
        <Divider my="xs" />
        <Text c="dimmed" size="sm">S3 / Azure durability and export targets — coming in phase 4.</Text>
      </Card>
    </Stack>
  );
}
```

- [ ] **Step 3: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green (Task 10's toggled test updated to assert `.react-flow`).

```bash
git add packages/web
git commit -m "feat(web): React Flow canvas view + settings (prefs, read-only daemon facts, phase-4 stubs)"
```

---

### Task 12: Branch drawer — header/rename, context, connstring, Info tab, danger zone

**Files:**
- Create: `packages/web/src/drawer/BranchDrawer.tsx`, `src/drawer/InfoTab.tsx`
- Modify: `packages/web/src/pages/ProjectPage.tsx` (mount the drawer)
- Test: `packages/web/test/drawer.test.tsx`

**Interfaces:**
- Consumes: `useBranch`, `useRenameBranch`, `useDeleteBranch`, `useResetBranch`, `useStartEndpoint`, `useStopEndpoint` (Task 7), chips (Task 9).
- Produces: `BranchDrawer({ branchId, onClose })` — `branchId: string | null`, opened iff non-null. Tabs container with slots `logs` / `restore` filled by Task 13 (placeholder panels until then).
- **Masking rule (binding):** display form replaces the password segment `postgresql://user:SECRET@` with `postgresql://user:•••@` via `conn.replace(/^(postgresql:\/\/[^:@/]+:)[^@]*@/, "$1•••@")`; the copy button writes the UNMASKED string.

- [ ] **Step 1: Failing tests**

`packages/web/test/drawer.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { BranchDrawer } from "../src/drawer/BranchDrawer.js";

vi.mock("../src/api/client.js", () => ({
  ApiError: class extends Error {},
  api: {
    status: vi.fn(), projects: {},
    branches: { get: vi.fn(), rename: vi.fn(), delete: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), restore: vi.fn(), list: vi.fn(), create: vi.fn() },
  },
}));
import { api } from "../src/api/client.js";
import type { BranchDto } from "@devdb/shared";

const branch: BranchDto = {
  id: "b1", projectId: "p1", parentBranchId: "b-main", name: "agent-fix", slug: "agent-fix-s",
  timelineId: "t".repeat(32), endpointStatus: "running", endpointError: null, port: 54303,
  connectionString: "postgresql://postgres:S3CRET@localhost:54303/postgres",
  lastRecordLsn: "0/169AD58", logicalSizeBytes: 24117248, createdBy: "mcp",
  context: { agent: "claude", git_branch: "fix-1", purpose: "repro the bug" },
  ancestorLsn: "0/1690000", createdAt: "2026-07-03T10:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
};

beforeEach(() => vi.mocked(api.branches.get).mockResolvedValue(branch));

describe("BranchDrawer", () => {
  it("shows masked connstring; copy writes the real one", async () => {
    const write = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: write } });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/postgresql:\/\/postgres:•••@localhost:54303/)).toBeInTheDocument();
    expect(screen.queryByText(/S3CRET/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(write).toHaveBeenCalledWith(branch.connectionString);
  });

  it("renames inline through the pencil", async () => {
    vi.mocked(api.branches.rename).mockResolvedValue({ ...branch, name: "better-name" });
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const input = screen.getByDisplayValue("agent-fix");
    await userEvent.clear(input);
    await userEvent.type(input, "better-name{enter}");
    await waitFor(() => expect(api.branches.rename).toHaveBeenCalledWith("b1", "better-name"));
  });

  it("shows fork context and Info metadata", async () => {
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    expect(await screen.findByText(/repro the bug/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /info/i }));
    expect(screen.getByText("0/169AD58")).toBeInTheDocument();
    expect(screen.getByText(/23\.0 MB/)).toBeInTheDocument(); // 24117248 bytes
  });

  it("danger zone: delete confirms then mutates", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.branches.delete).mockResolvedValue(undefined);
    renderApp(<BranchDrawer branchId="b1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /delete branch/i }));
    await waitFor(() => expect(api.branches.delete).toHaveBeenCalledWith("b1"));
  });
});
```

Run RED.

- [ ] **Step 2: Implement**

`packages/web/src/drawer/InfoTab.tsx`:

```tsx
import { Stack, Group, Text } from "@mantine/core";
import type { BranchDto } from "@devdb/shared";

export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const Row = (a: { k: string; v: string | null }) => (
  <Group justify="space-between" wrap="nowrap">
    <Text c="dimmed" size="sm">{a.k}</Text>
    <Text ff="monospace" size="sm" truncate>{a.v ?? "—"}</Text>
  </Group>
);

export function InfoTab(a: { branch: BranchDto }) {
  const b = a.branch;
  return (
    <Stack gap={6} pt="sm">
      <Row k="Last record LSN" v={b.lastRecordLsn} />
      <Row k="Logical size" v={formatBytes(b.logicalSizeBytes)} />
      <Row k="Timeline" v={b.timelineId} />
      <Row k="Ancestor LSN" v={b.ancestorLsn} />
      <Row k="Created by" v={b.createdBy} />
      <Row k="Created" v={new Date(b.createdAt).toLocaleString()} />
      <Row k="Slug" v={b.slug} />
    </Stack>
  );
}
```

`packages/web/src/drawer/BranchDrawer.tsx`:

```tsx
import { useState } from "react";
import {
  ActionIcon, Alert, Button, Card, CopyButton, Drawer, Group, Skeleton, Stack, Tabs, Text, TextInput, Title,
} from "@mantine/core";
import { useBranch, useDeleteBranch, useRenameBranch, useResetBranch, useStartEndpoint, useStopEndpoint } from "../api/hooks.js";
import { StatusChip, ContextChip } from "../tree/chips.js";
import { InfoTab } from "./InfoTab.js";

export function maskConnstring(conn: string): string {
  return conn.replace(/^(postgresql:\/\/[^:@/]+:)[^@]*@/, "$1•••@");
}

export function BranchDrawer(a: { branchId: string | null; onClose: () => void }) {
  const { data: b } = useBranch(a.branchId);
  const rename = useRenameBranch();
  const del = useDeleteBranch(); const reset = useResetBranch();
  const start = useStartEndpoint(); const stop = useStopEndpoint();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <Drawer opened={a.branchId !== null} onClose={a.onClose} position="right" size="lg"
      title={b ? undefined : "Branch"}>
      {!b ? <Skeleton height={300} /> : (
        <Stack gap="sm">
          <Group gap="xs" wrap="nowrap">
            {editing ? (
              <TextInput
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) {
                    rename.mutate({ id: b.id, name: draft.trim() }, { onSettled: () => setEditing(false) });
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
                autoFocus
              />
            ) : (
              <Title order={3} ff="monospace">{b.name}</Title>
            )}
            <ActionIcon variant="subtle" aria-label="rename"
              onClick={() => { setDraft(b.name); setEditing((v) => !v); }}
              disabled={b.parentBranchId === null} // root branch is not renameable (daemon enforces too)
            >✎</ActionIcon>
            <StatusChip branch={b} />
          </Group>

          {b.context && (
            <Group gap="xs">
              <ContextChip context={b.context} />
              {b.context.purpose && <Text size="sm" c="dimmed">“{b.context.purpose}”</Text>}
            </Group>
          )}

          {b.connectionString ? (
            <Group gap="xs" wrap="nowrap">
              <Text ff="monospace" size="sm" truncate>{maskConnstring(b.connectionString)}</Text>
              <CopyButton value={b.connectionString}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="light" onClick={copy}>{copied ? "copied" : "copy"}</Button>
                )}
              </CopyButton>
            </Group>
          ) : (
            <Group gap="xs">
              <Text size="sm" c="dimmed">Endpoint not running — no connection string.</Text>
              <Button size="compact-xs" onClick={() => start.mutate(b.id)} loading={start.isPending}>Start endpoint</Button>
            </Group>
          )}
          {b.endpointStatus === "failed" && b.endpointError && (
            <Alert color="red" title="Endpoint failed">{b.endpointError}</Alert>
          )}

          <Tabs defaultValue="logs">
            <Tabs.List>
              <Tabs.Tab value="logs">Logs</Tabs.Tab>
              <Tabs.Tab value="restore">Restore</Tabs.Tab>
              <Tabs.Tab value="info">Info</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="logs"><Text c="dimmed" pt="sm">Logs tab lands in Task 13.</Text></Tabs.Panel>
            <Tabs.Panel value="restore"><Text c="dimmed" pt="sm">Restore tab lands in Task 13.</Text></Tabs.Panel>
            <Tabs.Panel value="info"><InfoTab branch={b} /></Tabs.Panel>
          </Tabs>

          <Card withBorder mt="md" style={{ borderColor: "var(--mantine-color-red-3)" }}>
            <Title order={5} c="red.7">Danger zone</Title>
            <Group mt="xs">
              {(b.endpointStatus === "running" || b.endpointStatus === "starting") && (
                <Button variant="light" onClick={() => stop.mutate(b.id)} loading={stop.isPending}>Stop endpoint</Button>
              )}
              <Button color="red" variant="light" disabled={b.parentBranchId === null}
                onClick={() => window.confirm(`Reset "${b.name}" to its parent's current state? Divergent data is lost.`) && reset.mutate(b.id)}>
                Reset from parent…
              </Button>
              <Button color="red"
                onClick={() => window.confirm(`Delete branch "${b.name}"? This cannot be undone.`)
                  && del.mutate(b.id, { onSuccess: a.onClose })}>
                Delete branch…
              </Button>
            </Group>
          </Card>
        </Stack>
      )}
    </Drawer>
  );
}
```

In `ProjectPage.tsx`, replace the Task-12 placeholder comment with:

```tsx
<BranchDrawer branchId={selected} onClose={() => select(null)} />
```

- [ ] **Step 3: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): branch drawer — inline rename, masked connstring copy, fork context, info tab, danger zone"
```

---

### Task 13: Drawer tabs — live logs (SSE) + restore

**Files:**
- Create: `packages/web/src/drawer/LogsTab.tsx`, `src/drawer/RestoreTab.tsx`
- Modify: `packages/web/src/drawer/BranchDrawer.tsx` (fill the two placeholder panels)
- Test: `packages/web/test/logs-tab.test.tsx`, `packages/web/test/restore-tab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/branches/:id/logs` — server frames each line as `data: <JSON string>\n\n` (see api.ts `sse()`: `write(\`data: ${JSON.stringify(line)}\n\n\`)`), so the client `JSON.parse`s each `message.data` back to the raw line. `useRestoreBranch` (Task 7).
- Produces: `LogsTab({ branchId, makeSource? })`, `RestoreTab({ branch })`. Restore presets (binding, spec §Screens): 5 m, 30 m, 1 h, 6 h, 24 h.

- [ ] **Step 1: Failing tests**

`packages/web/test/logs-tab.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen, act } from "@testing-library/react";
import { renderApp } from "./render.js";
import { LogsTab } from "../src/drawer/LogsTab.js";

class FakeES {
  static last: FakeES | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  close() { this.closed = true; }
}

describe("LogsTab", () => {
  it("connects to the branch log stream and renders JSON-decoded lines in order", () => {
    renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    expect(FakeES.last!.url).toBe("/api/branches/b1/logs");
    act(() => {
      FakeES.last!.onmessage?.({ data: JSON.stringify("LOG:  statement: BEGIN") });
      FakeES.last!.onmessage?.({ data: JSON.stringify("LOG:  duration: 2.31 ms") });
    });
    const lines = screen.getAllByTestId("log-line").map((el) => el.textContent);
    expect(lines).toEqual(["LOG:  statement: BEGIN", "LOG:  duration: 2.31 ms"]);
  });
  it("closes the stream on unmount", () => {
    const { unmount } = renderApp(<LogsTab branchId="b1" makeSource={(u) => new FakeES(u) as unknown as EventSource} />);
    unmount();
    expect(FakeES.last!.closed).toBe(true);
  });
});
```

`packages/web/test/restore-tab.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "./render.js";
import { RestoreTab } from "../src/drawer/RestoreTab.js";
// Duplicate drawer.test.tsx's vi.mock("../src/api/client.js", ...) factory block and its typed
// `branch: BranchDto` fixture VERBATIM into this file — vi.mock factories are hoisted per-file
// and cannot be imported from a shared helper (see "Notes for the executor").

describe("RestoreTab", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }).setSystemTime(new Date("2026-07-03T12:00:00Z")));

  it("as-new-branch: preset 30 m builds an ISO timestamp 30 minutes back and posts new_branch mode", async () => {
    vi.mocked(api.branches.restore).mockResolvedValue(branch);
    renderApp(<RestoreTab branch={branch} />);
    await userEvent.click(screen.getByRole("radio", { name: /as a new branch/i }));
    await userEvent.click(screen.getByRole("button", { name: /30 m/i }));
    await userEvent.type(screen.getByLabelText(/new branch name/i), "before-mistake");
    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(api.branches.restore).toHaveBeenCalledWith("b1", {
      mode: "new_branch", to: "2026-07-03T11:30:00.000Z", name: "before-mistake",
    }));
  });

  it("in-place shows the auto-stop notice and posts in_place mode", async () => {
    vi.mocked(api.branches.restore).mockResolvedValue(branch);
    renderApp(<RestoreTab branch={branch} />);
    expect(screen.getByText(/endpoint will be stopped/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /5 m/i }));
    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(api.branches.restore).toHaveBeenCalledWith("b1", {
      mode: "in_place", to: "2026-07-03T11:55:00.000Z",
    }));
  });
});
```

Run RED.

- [ ] **Step 2: Implement**

`packages/web/src/drawer/LogsTab.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Group, ScrollArea, Switch, Text } from "@mantine/core";

const MAX_LINES = 500; // mirror the server-side ring

export function LogsTab(a: { branchId: string; makeSource?: (url: string) => EventSource }) {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const make = a.makeSource ?? ((u: string) => new EventSource(u));
    // The logs SSE replays the recent ring then tails live (api.ts sse()); each event's data is a
    // JSON-encoded string line. EventSource's native auto-reconnect + the server's replay make a
    // simple always-reconnect client correct here (unlike /api/events, which needs owned backoff).
    const es = make(`/api/branches/${a.branchId}/logs`);
    es.onmessage = (m) => {
      try {
        const line: unknown = JSON.parse(m.data as string);
        if (typeof line === "string") setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
      } catch { /* non-JSON frame — ignore */ }
    };
    return () => es.close();
  }, [a.branchId, a.makeSource]);

  useEffect(() => {
    // Optional-call guard: jsdom's HTMLElement has no scrollTo implementation — the follow
    // behavior is real-browser-only, and tests must not crash on the missing method.
    if (follow) viewport.current?.scrollTo?.({ top: viewport.current.scrollHeight });
  }, [lines, follow]);

  return (
    <>
      <Group justify="flex-end" py={4}>
        <Switch size="xs" label="follow" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
      </Group>
      <ScrollArea h={320} viewportRef={viewport} bg="dark.8" style={{ borderRadius: 6 }}>
        <div style={{ padding: 8 }}>
          {lines.length === 0 && <Text size="xs" c="dimmed" p="xs">no output yet — start the endpoint or run a query</Text>}
          {lines.map((l, i) => (
            <Text key={i} data-testid="log-line" ff="monospace" size="xs" c="green.3" style={{ whiteSpace: "pre-wrap" }}>{l}</Text>
          ))}
        </div>
      </ScrollArea>
    </>
  );
}
```

`packages/web/src/drawer/RestoreTab.tsx`:

```tsx
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
  const [preset, setPreset] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [customLocal, setCustomLocal] = useState("");

  const pickPreset = (p: { label: string; minutes: number }) => {
    setCustomLocal("");
    setPreset(p.label);
    setTo(new Date(Date.now() - p.minutes * 60_000).toISOString());
  };
  const pickCustom = (v: string) => {
    setCustomLocal(v);
    setPreset(null);
    setTo(v ? new Date(v).toISOString() : "");
  };

  return (
    <Stack gap="sm" pt="sm">
      <Group gap="xs">
        {PRESETS.map((p) => (
          <Chip key={p.label} checked={preset === p.label} onClick={() => pickPreset(p)} variant="light">
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
```

(Preset chips also render as buttons/checkboxes accessibly — the tests target them by their visible label via `getByRole("button", { name: /30 m/i })`; if Mantine `Chip` exposes role `checkbox` instead, adjust the role in the tests, not the component.)

Fill the two `Tabs.Panel`s in `BranchDrawer.tsx`:

```tsx
<Tabs.Panel value="logs">{b && <LogsTab branchId={b.id} />}</Tabs.Panel>
<Tabs.Panel value="restore">{b && <RestoreTab branch={b} />}</Tabs.Panel>
```

- [ ] **Step 3: GREEN + commit**

Run: `pnpm --filter @devdb/web test` — all green.

```bash
git add packages/web
git commit -m "feat(web): drawer logs tab (SSE tail, follow) + restore tab (presets, in-place vs new-branch)"
```

---

### Task 14: Daemon static serving + SPA fallback

**Files:**
- Modify: `packages/daemon/package.json` (add `@fastify/static ^9.1.3`)
- Modify: `packages/daemon/src/config.ts` (`webDistDir`)
- Create: `packages/daemon/src/http/static.ts`
- Modify: `packages/daemon/src/http/api.ts` (call `registerWebUi` near the end of `buildServer`)
- Test: `packages/daemon/test/static.test.ts`

**Interfaces:**
- Consumes: `DevdbConfig`.
- Produces: `DEVDB_WEB_DIST` env → `cfg.webDistDir: string | null` (null = UI not served — the dev-daemon case; the Docker image sets it in Task 15). `registerWebUi(app, cfg, logger?)`.

- [ ] **Step 1: Failing tests**

`packages/daemon/test/static.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/http/api.js";
// Build a LOCAL minimal-deps helper in this file (do not import api.test.ts): mirror its recipe —
// cfg from loadConfig() under the suite's env fixture with `webDistDir` overridden per test,
// state from openState(":memory:"), fakeEngine()/fakeLogs()/new EventsService(), and vi.fn()
// service fakes for the handful of service methods no test here ever calls.

function makeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "devdb-webdist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><div id=\"root\">devdb-app</div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

describe("web UI static serving + SPA fallback", () => {
  it("serves index.html at /, real assets at their path, and index.html for SPA deep links", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
    expect((await app.inject({ url: "/" })).body).toContain("devdb-app");
    expect((await app.inject({ url: "/assets/app.js" })).statusCode).toBe(200);
    const deep = await app.inject({ url: "/projects/abc123?branch=b1" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("devdb-app");
  });

  it("NEVER swallows /api or /mcp: unknown API routes stay JSON 404; POST is never index.html", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: makeWebDist() }) }));
    const apiMiss = await app.inject({ url: "/api/nope" });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.headers["content-type"]).toContain("application/json");
    const postMiss = await app.inject({ method: "POST", url: "/definitely/not/a/route" });
    expect(postMiss.statusCode).toBe(404);
    const mcpGet = await app.inject({ url: "/mcp", headers: { host: "evil.example" } });
    expect(mcpGet.body).not.toContain("devdb-app"); // guard's own response, not the SPA
  });

  it("with webDistDir null the app behaves exactly as before (no static routes)", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: null }) }));
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  });

  it("with webDistDir pointing at a missing directory, boot does not crash and UI is skipped", async () => {
    const app = buildServer(fakeDeps({ cfg: fakeCfg({ webDistDir: "/nonexistent/webdist" }) }));
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  });
});
```

Run RED — `webDistDir` not in config type.

- [ ] **Step 2: Implement**

`packages/daemon/src/config.ts` — add to the interface: `webDistDir: string | null;` and in `loadConfig()`:

```ts
// Phase 3: directory of the built web UI (vite output). Unset => UI not served — the local-dev
// daemon case, where `pnpm --filter @devdb/web dev` serves the SPA and proxies /api here.
// The Docker image sets DEVDB_WEB_DIST=/app/packages/web/dist (docker/Dockerfile).
const webDistDir = e.DEVDB_WEB_DIST?.trim() ? e.DEVDB_WEB_DIST.trim() : null;
```

`packages/daemon/src/http/static.ts`:

```ts
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { DevdbConfig } from "../config.js";

// Serves the built SPA and owns the SPA fallback. Registered LAST in buildServer so every real
// route (REST, MCP, SSE) keeps priority. Fallback policy (spec Decision 4 / global constraint):
//   - /api/* and /mcp* NEVER fall back to index.html — unknown API paths stay JSON 404s;
//   - only GET/HEAD navigations fall back (a POST to an unknown path is a 404, not the app);
//   - everything else (e.g. /projects/<id> deep links) gets index.html and the router takes over.
// @fastify/static's wildcard GET/HEAD route serves real files and calls the app's not-found
// handler on a miss — which is exactly where the policy below lives.
export function registerWebUi(app: FastifyInstance, cfg: DevdbConfig): void {
  if (!cfg.webDistDir) return;
  if (!existsSync(cfg.webDistDir)) {
    app.log.warn(`DEVDB_WEB_DIST=${cfg.webDistDir} does not exist — web UI will not be served`);
    return;
  }
  void app.register(fastifyStatic, { root: cfg.webDistDir });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    const isApiSurface = url.startsWith("/api/") || url === "/api" || url.startsWith("/mcp");
    const isNavigation = req.raw.method === "GET" || req.raw.method === "HEAD";
    if (isApiSurface || !isNavigation) {
      return reply.status(404).send({ error: `route ${req.raw.method} ${url} not found` });
    }
    return reply.sendFile("index.html");
  });
}
```

In `packages/daemon/src/http/api.ts`, immediately before `return app;`:

```ts
registerWebUi(app, deps.cfg); // must stay last — SPA fallback owns the not-found handler
```

Add the dependency: in `packages/daemon/package.json` dependencies, `"@fastify/static": "^9.1.3"`, then `pnpm install`. (If `fastifyStatic` registration throws a fastify-version mismatch at test time, drop the pin to `^8` — both majors carry the identical `root`/`sendFile` API used here.)

`fakeCfg` in tests: extend the existing config-construction helper (or `loadConfig` env fixture) with `webDistDir` — mechanical.

- [ ] **Step 3: GREEN + full suite + commit**

Run: `pnpm --filter @devdb/daemon test` — all green, including all pre-existing route tests (proving no route was shadowed).

```bash
git add packages/daemon pnpm-lock.yaml
git commit -m "feat(daemon): serve the built web UI with an SPA fallback that never shadows /api or /mcp"
```

---

### Task 15: Docker image + README

**Files:**
- Modify: `docker/Dockerfile` (ENV only — the existing `COPY packages ./packages` + `pnpm -r build` already build web in topological order since web depends on `@devdb/shared`)
- Modify: `README.md` (UI quickstart + dev mode)

**Interfaces:**
- Consumes: Task 14's `DEVDB_WEB_DIST`; Task 6's `vite build` output at `packages/web/dist`.
- Produces: `devdb:dev` image serving the UI at `:4400` — Task 16's integration tests boot exactly this.

- [ ] **Step 1: Record the current image size (the honest baseline)**

Run: `docker images devdb:dev --format '{{.Size}}'` — record in the task report/ledger. If no image exists, build once on the pre-task commit first.

- [ ] **Step 2: Dockerfile ENV**

In `docker/Dockerfile`, extend the ENV block:

```dockerfile
ENV NEON_BINARIES_DIR=/usr/local/share/neon/bin \
    PG_INSTALL_DIR=/usr/local/share/neon/pg_install \
    DEVDB_DATA_DIR=/data \
    DEVDB_HTTP_PORT=4400 \
    DEVDB_PORT_RANGE=54300-54339 \
    DEVDB_WEB_DIST=/app/packages/web/dist
```

No other Dockerfile change: `packages/web` sources arrive via the existing `COPY --chown=node:node packages ./packages`, `pnpm install --frozen-lockfile` covers its (lockfile-resolved) deps, and `pnpm -r build` builds `@devdb/shared` before `@devdb/web` by workspace topology.

- [ ] **Step 3: Build + smoke + size delta**

```bash
docker build -f docker/Dockerfile -t devdb:dev .
docker run -d --rm --name devdb-smoke -p 127.0.0.1:4400:4400 devdb:dev
sleep 25   # engine boot
curl -sf http://127.0.0.1:4400/ | grep -q 'id="root"' && echo "UI OK"
curl -sf http://127.0.0.1:4400/api/status | grep -q '"portRange"' && echo "API OK"
curl -sf http://127.0.0.1:4400/projects/deep-link | grep -q 'id="root"' && echo "SPA fallback OK"
docker rm -f devdb-smoke
docker images devdb:dev --format '{{.Size}}'
```

Expected: three OK lines. **Size policy:** record the delta vs Step 1. If the image grew by more than ~300 MB, do NOT restructure now — note "web-builder stage + runtime install `--filter '!@devdb/web'`" as the follow-up in the ledger and continue (spec plan-time risk 4 names this exact fallback).

- [ ] **Step 4: README**

Add to the quickstart section: the dashboard is at `http://localhost:4400` after `docker compose up`; add a "Developing the UI" section:

```markdown
## Developing the UI

The daemon serves the built UI from `DEVDB_WEB_DIST` (set in the image). For UI development,
run the daemon (or the container) as usual, then:

    pnpm --filter @devdb/web dev

Vite serves the SPA on :5173 and proxies `/api` + `/mcp` to `localhost:4400` — no CORS, and
SSE (live logs, /api/events) streams through the proxy unbuffered.
```

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile README.md
git commit -m "feat(docker): serve the web UI from the image (DEVDB_WEB_DIST); README UI quickstart + dev mode"
```

---

### Task 16: Integration tests — UI serving, events channel, rename round-trip

**Files:**
- Create: `tests/integration/helpers/sse.ts`
- Create: `tests/integration/web-ui.test.ts`, `tests/integration/events.test.ts`
- Test: the files themselves + the FULL integration suite as the phase gate

**Interfaces:**
- Consumes: `startDevdb()` (`tests/integration/helpers/container.ts` — `dev.base` is the mapped `:4400`); the REST surface incl. Task 4's PATCH; Task 1's `/api/events`.

- [ ] **Step 1: SSE helper**

`tests/integration/helpers/sse.ts`:

```ts
// Minimal SSE consumer for integration tests: connects with fetch, yields each `data:` payload.
// Deliberately no EventSource dependency — undici's fetch streams the body directly.
export async function connectSse(url: string, signal: AbortSignal): Promise<AsyncGenerator<string>> {
  const res = await fetch(url, { signal });
  if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  async function* gen(): AsyncGenerator<string> {
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data: ")) yield line.slice(6);
        }
      }
    }
  }
  return gen();
}

export async function nextMatching(
  gen: AsyncGenerator<string>, pred: (payload: string) => boolean, timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SSE: no matching event before timeout");
    const race = await Promise.race([
      gen.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), remaining)),
    ]);
    if (race.done) throw new Error("SSE stream ended before a matching event");
    if (pred(race.value)) return race.value;
  }
}
```

- [ ] **Step 2: The two test files**

`tests/integration/web-ui.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("web UI serving", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("serves the app shell at /", async () => {
    const res = await fetch(`${dev.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="root"');
  });

  it("serves the fingerprinted assets referenced by index.html", async () => {
    const html = await (await fetch(`${dev.base}/`)).text();
    const assetPath = html.match(/\/assets\/[^"]+\.js/)?.[0];
    expect(assetPath).toBeTruthy();
    expect((await fetch(`${dev.base}${assetPath}`)).status).toBe(200);
  });

  it("SPA-falls-back on deep links but keeps unknown API routes as JSON 404", async () => {
    const deep = await fetch(`${dev.base}/projects/00000000-0000-0000-0000-000000000000`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('id="root"');
    const apiMiss = await fetch(`${dev.base}/api/definitely-not-a-route`);
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers.get("content-type")).toContain("application/json");
  });
});
```

`tests/integration/events.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";
import { connectSse, nextMatching } from "./helpers/sse.js";

describe("/api/events invalidation channel", () => {
  let dev: Devdb;
  const ac = new AbortController();
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { ac.abort(); await dev?.stop(); });

  it("streams project/branch/endpoint lifecycle + rename as typed events", async () => {
    const gen = await connectSse(`${dev.base}/api/events`, ac.signal);

    // project.created
    const pRes = await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "events-proj" }),
    });
    expect(pRes.status).toBe(201);
    const { project } = await pRes.json();
    const created = JSON.parse(await nextMatching(gen, (p) => p.includes('"project.created"')));
    expect(created).toMatchObject({ type: "project.created", projectId: project.id });

    // branch.created
    const bRes = await fetch(`${dev.base}/api/projects/${project.id}/branches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dev" }),
    });
    expect(bRes.status).toBe(201);
    const branch = await bRes.json();
    const bEvt = JSON.parse(await nextMatching(gen, (p) => p.includes('"branch.created"')));
    expect(bEvt).toMatchObject({ type: "branch.created", projectId: project.id, branchId: branch.id });

    // endpoint.status sequence on start (starting → running at minimum)
    const sRes = await fetch(`${dev.base}/api/branches/${branch.id}/endpoint/start`, { method: "POST" });
    expect(sRes.status).toBe(200);
    JSON.parse(await nextMatching(gen, (p) => p.includes('"endpoint.status"')));

    // rename → branch.updated + round-trip visible via GET
    const rRes = await fetch(`${dev.base}/api/branches/${branch.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "dev-renamed" }),
    });
    expect(rRes.status).toBe(200);
    const uEvt = JSON.parse(await nextMatching(gen, (p) => p.includes('"branch.updated"')));
    expect(uEvt).toMatchObject({ type: "branch.updated", branchId: branch.id });
    const got = await (await fetch(`${dev.base}/api/branches/${branch.id}`)).json();
    expect(got.name).toBe("dev-renamed");
    expect(got.slug).toBe(branch.slug); // immutable

    // root branch rename refused
    const branches = await (await fetch(`${dev.base}/api/projects/${project.id}/branches`)).json();
    const main = branches.find((b: { parentBranchId: string | null }) => b.parentBranchId === null);
    const rootRename = await fetch(`${dev.base}/api/branches/${main.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "primary" }),
    });
    expect(rootRename.status).toBe(400);
  }, 120_000);
});
```

- [ ] **Step 3: Run the new files, then the FULL suite (phase gate)**

Run: `pnpm --filter @devdb/integration exec vitest run web-ui.test.ts events.test.ts`
Expected: green against a freshly built image (build first if Task 15's image is stale).

Run: `pnpm --filter @devdb/integration test`
Expected: the whole container-level suite green (~6 min) — this is the phase's merge gate together with the daemon + web unit suites.

- [ ] **Step 4: Commit**

```bash
git add tests/integration
git commit -m "test(integration): web UI serving, /api/events lifecycle, rename round-trip"
```

---

## Acceptance runbook (spec §Acceptance mapped to tasks)

| Spec acceptance item | Covered by |
|---|---|
| 1. `docker compose up` → dashboard with health + projects | Tasks 8, 15 (smoke), 16 (`web-ui.test.ts`) |
| 2. Create project in UI (PG picker) → project view shows `main` | Tasks 8, 10 |
| 3. MCP agent creates branch → tree updates live with agent chip; drawer shows context | Tasks 1–3, 7, 9, 12; `events.test.ts` proves the event path end-to-end |
| 4. Rails ↔ canvas toggle; Settings default honored on reload | Tasks 10, 11 |
| 5. Drawer: copy connstring, live logs, rename (visible to agents), restore-as-new appears live | Tasks 12, 13, 4, 16 |
| 6. Engine degradation banner appears/clears | Tasks 3, 8 |
| 7. Delete with children blocked with explanation; leaf delete leaves tree live | Tasks 9/12 (confirm + 409 toast), 2 (events) |

Manual demo pass of items 3–7 against the built image is part of the finishing checklist (the integration suite automates their API halves; the visual halves take two minutes of clicking).

## Notes for the executor

- Task order is dependency order; 1–5 are daemon-only, 6–13 web-only (after 6, web tasks depend only on earlier web tasks), 14–16 close the loop. There is no parallel dispatch — one implementer at a time (SDD rule).
- The Dashboard/ProjectPage/Drawer test files share the `vi.mock("../src/api/client.js", ...)` shape — keep the mock factory literal in each file (vitest hoisting) rather than extracting a helper that trips `vi.mock` hoisting.
- If `main` has moved when a task starts, re-read the touched files first (verify-on-main rule) — especially `api.ts` and `manager.ts`, which Jordan patches directly.



