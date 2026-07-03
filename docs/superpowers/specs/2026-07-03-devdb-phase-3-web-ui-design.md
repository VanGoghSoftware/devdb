# DevDB Phase 3 — Web UI: Design Refinement

**Date:** 2026-07-03
**Status:** Approved (Jordan, 2026-07-03)
**Relationship:** Refinement of the main design spec (`2026-07-02-devdb-design.md` §Web UI) and the handover's §5. The main spec stays authoritative for product decisions; this doc records the open product questions resolved entering phase 3 — including one scope change (SQL console deferred) amended into the parent spec. Screens and behaviors the parent spec already settles are restated here only where phase 3 pins them more precisely.

## Context

Phase 3 delivers the human's window into DevDB: watch agents fork and mutate branches live, inspect any branch, and intervene (restore, reset, stop, delete) without leaving the browser. Stack was settled long ago (React 19 + Vite + **Mantine** — Jordan's explicit choice), embedding posture too (static build served by the daemon at `:4400`, no login). Four product questions were open; all resolved below with Jordan on 2026-07-03.

## Decision 1 — Freshness: SSE events channel, events are invalidation hints

The UI learns about concurrent (MCP-agent) mutations from a new **`GET /api/events`** SSE stream. Contract:

- **Events are coarse invalidation hints, never data.** Payload `{ type, projectId?, branchId?, at }` (`at` ISO-8601 with timezone), zod-schema'd in `@devdb/shared`. Types: `project.created`, `project.deleted`, `branch.created`, `branch.updated`, `branch.deleted`, `endpoint.status`, `engine.health`. `branch.updated` covers every branch-row mutation that isn't create/delete — rename, reset, and in-place restore (timeline swap). Deliberately excluded: LSN/size churn (the branch panel refetches on demand).
- **No replay.** A client receives only future events; on every (re)connect it performs one invalidate-everything refetch. Lost events and reconnects therefore have no correctness consequences.
- **Client model:** React Query owns all server state (REST = source of truth); each event maps to query-key invalidations. UI-originated mutations invalidate directly, not via their echo.
- **Emission:** services publish after a successful local state write (post-compensation), inside the queue lane that ran the mutation. Async compute transitions (crash after start, late readiness failure) come from `ComputeManager` via an `onStatusChange` hook wired at the composition root (`index.ts`) — `compute/` keeps zero `services/` imports. Fanout follows the `LogsService` swallow-throwing-subscribers contract; backpressure follows the existing SSE discipline (slow client → drop → client reconnects).

**Rejected:** polling (works, but Jordan chose push); manual refresh (undercuts the watch-your-agents demo).

## Decision 2 — SQL console: dropped from phase 3 (deferred, not deleted)

Jordan: no SQL-client ambitions "for now at least." The SQL console screen (parent spec §Web UI) is **deferred beyond phase 3** — unscheduled, not removed from the product. Consequences:

- The §9 carried items parked on it (result pagination/cursors; duplicate-column rendering / `rowMode:"array"` revisit) stay parked with the screen.
- `POST /api/sql` remains as-is; no UI consumes it in phase 3.
- **Noted, out of phase-3 scope:** `sql.ts` materializes the full result set before applying the row cap — a memory hazard reachable via REST regardless of UI. It deserves a small standalone daemon hardening task (stream and stop at cap+1) whenever picked up; recorded in handover §9.
- Parent spec gains an amendment line recording the deferral.

## Decision 3 — Branch tree: rails AND canvas, toggleable, configurable default

The project view ships **two renderers over the same branch data**, a header toggle, and a default-view preference:

- **Rails** (the factory default of the default-view preference): hand-rolled SVG git-graph gutter. Branches form a strict tree (no merges), so layout is a DFS walk — one lane per branch, one curve from the parent's lane at the fork row. Compact rows scale to many branches.
- **Canvas:** **React Flow** (`@xyflow/react`) + `d3-hierarchy` tidy-tree layout, top-down. Nodes are Mantine cards, **not draggable** (computed layout), pan/zoom + fit-view; no minimap in v1.
- Both render identical node content (chips, actions) and open the same branch drawer; tree-building, chips, and live updates are shared code.
- The toggle switches the live view; **Settings** holds the default. Both are `localStorage` client preferences — deliberately not daemon-persisted (per-browser is correct for a local tool; no user-settings store in the daemon).

**Rejected:** single-view (Jordan wants both); hand-rolled canvas (pan/zoom/hit-testing not worth owning); nested-outline style (loses the git feel).

## Decision 4 — Layout: top-bar shell, full-width tree, transient drawer

- **App shell:** slim top bar — brand, project switcher, Dashboard / Settings, theme toggle, SSE-connection dot. No sidebar (too few global destinations).
- **Project view:** the tree owns the full width (the canvas view especially benefits). Selecting a branch opens a **drawer** over the right side; Esc/outside-click returns to the tree.

**Rejected:** persistent split pane (better for staring at one branch's logs, but costs tree room; drawer won).

---

## Scope

**In:** `packages/web` SPA; Dashboard, Project view (rails+canvas), Branch drawer, minimal Settings; daemon: `/api/events`, `PATCH /api/branches/:id` (rename), static serving + SPA fallback, status payload additions; `services/dto.ts` typing re-check (§9 item).

**Out (recorded homes):** SQL console (deferred, Decision 2) · import/export UI, job history, durability badge (phase 4; dashboard shows a static "local" storage chip) · extensions list (phase 5) · Playwright smoke (stays deferred, spec §Testing) · DevDB Hub (phase 6, separate spec).

## Architecture

- **Workspace:** `packages/web` — React 19, Vite, TypeScript strict, joins the repo's tsc gate (no `as any`/`as never`). Wire types only from `@devdb/shared`; the event schema is added there.
- **New deps** (pure JS, ≥24h-old rule, no native builds): `@mantine/core` `@mantine/hooks` `@mantine/notifications`, `@tanstack/react-query`, `@xyflow/react`, `d3-hierarchy`. Exact versions + React-19 peer compat pinned at plan time (same discipline as the MCP SDK pin).
- **Serving (prod):** Vite build output in the image; `@fastify/static` (v8, Fastify 5) at `/`; SPA fallback serves `index.html` for non-`/api`, non-`/mcp` GETs and must never shadow those prefixes. MCP rebinding guard stays scoped to `/mcp`; loopback compose binding unchanged. Dockerfile gains a web build stage; the image `pnpm install` COPY set gains `packages/web/package.json` (§3.4 trap).
- **Dev mode:** `vite dev` proxying `/api` + `/mcp` to `:4400` (no CORS added to the daemon). Known quirk to handle: Vite proxy buffering of SSE.
- **Theming:** Mantine color scheme auto/light/dark, toggle in the top bar, preference in `localStorage`.

## Daemon additions

- **`GET /api/events`** — Decision 1.
- **`PATCH /api/branches/:id`** `{ name }` — the phase-1-deferred rename lands with its UI. Reuses the create-branch name validation (single source); runs through the branch's queue lane; 409 on duplicate name within the project; emits `branch.updated`. **`slug` is immutable** (feeds compute naming and directories — rename must never touch engine artifacts). **The root branch is not renameable** (400 with explanation) — skills and agent conventions reference `main`.
- **Status payload** gains `portRange: { min, max }` and `storage: "none" | "s3" | "azure"` (hardcoded `"none"` until phase 4). Additive.
- **Typing re-check:** `createdBy` is already union-typed in shared on current main; a small plan task verifies `services/dto.ts` has no remaining bare-string casts and closes the §9 item either way.

## Screens

- **Dashboard:** engine-health strip from `StatusDto.engine` (per-component chips; banner when unhealthy) · storage chip · project cards (name, PG version badge, branch/running counts; delete in card menu) · create-project modal (name + PG version from shared `SUPPORTED_PG_VERSIONS`).
- **Project view:** header (project name, rails/canvas toggle, New branch) · tree per Decision 3/4. Row/node: mono name · status chip (`running :port` / `stopped` / `starting` / `stopping` / `failed`) · fork-context chip `🤖 <agent> · <git branch>` when `context` present (tooltip: purpose, workdir, client) · kebab: branch-from-here, copy connstring, start/stop, restore, reset, rename, delete. Empty state points at `claude mcp add … /mcp`.
- **Branch drawer:** header (inline-rename name, status, port) · fork-context block · masked connstring + copy-full · tabs **Logs** (SSE tail, follow toggle, auto-reconnect) / **Restore** (datetime + presets 5 m, 30 m, 1 h, 6 h, 24 h; radio: in-place — auto-stop notice — vs as-new-branch + name) / **Info** (last LSN, logical size, timeline id, ancestor LSN, created) · danger zone (reset-from-parent, delete; both confirmed; delete-with-children surfaces the 409 explanation).
- **Settings:** read-only (port range, storage mode, daemon version) · preferences (default tree view, theme) · disabled phase-4 stubs (Remote storage, Export targets).

## Error handling

Degraded engine → persistent banner. SSE drop → capped-backoff reconnect (1→10 s) + top-bar indicator + blanket invalidate on resume. Mutation failure → Mantine notification carrying the daemon's remediation-bearing message. Failed endpoint → red chip + `endpointError` in drawer. Unknown route ids → friendly 404 → dashboard.

## Testing

- **Web component (vitest + Testing Library, jsdom):** tree-building/lane assignment from `BranchDto[]`; events→invalidation hook against a fake EventSource; rename/restore form validation; connstring masking.
- **Daemon unit:** events fanout + per-service emission points via typed fakes; PATCH rename (validation, lane, 409, root guard); SPA-fallback route ordering.
- **Integration (container):** serve smoke (`GET /` → app shell); `/api/events` emits `branch.created` on REST create (real SSE client); rename round-trip.
- Playwright deferred (unchanged).

## Plan-time risks

1. React Flow v12 ↔ React 19 peer compatibility at version-pin time (fallback: pin the newest compatible pair).
2. Vite dev-proxy SSE buffering (events + logs tails must stream in dev).
3. SPA fallback ordering vs `/api`, `/mcp`, and 404 semantics for unknown API routes.
4. Image-size impact of the web build stage (build in a builder stage; ship static output only).

## What this refinement does NOT change

- REST/MCP tool surfaces (no MCP changes at all in phase 3), fork-context schema, redaction posture (connstring stays in the DTO; raw password field stays dropped).
- Engine interactions — zero. This phase touches `http/`, `services/` (events + rename), `state/` (nothing), `compute/` (one observer hook), plus the new `packages/web`.
- The parent spec's §Web UI feature set: everything not delivered here (SQL console, durability badge, job history, extensions list) remains product surface with a scheduled or deferred home.

## Acceptance (phase-3 demo)

1. `docker compose up` → dashboard on `:4400` (spec v1 item 1) showing engine health and the project list.
2. Create a project in the UI (PG version picker) → project view shows `main`.
3. An MCP agent creates a branch with fork context → **the tree updates live** (no manual refresh); the new node carries the agent chip; drawer shows purpose/workdir/client.
4. Toggle rails ↔ canvas: same tree, both interactive; set default view in Settings; reload honors it.
5. From the drawer: copy connstring (psql connects); watch live logs; rename the branch (tree + agent's `get_branch` both reflect it); restore as-new-branch from 30 m ago → new node appears live.
6. Stop the daemon's engine process (simulate degradation) → banner appears; recover → banner clears.
7. Delete a branch with children → blocked with explanation; delete leaf → node leaves the tree live.
