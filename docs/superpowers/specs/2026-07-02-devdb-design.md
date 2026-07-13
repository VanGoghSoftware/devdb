# DevDB — Design Spec

**Date:** 2026-07-02
**Status:** Approved pending final user review
**Oracle:** official [neondatabase/neon](https://github.com/neondatabase/neon) (Apache 2.0) — engine source, HTTP APIs, `control_plane`, and `compute_tools` studied, not copied; UI explicitly rebuilt from scratch.

## Product statement

DevDB is a local development Postgres server with Neon-style instant branching and point-in-time restore, packaged as a single Docker container, **designed for AI coding agents first**. Where git worktrees give parallel agents isolated working copies of code, DevDB branches give them isolated writable copies of the database: an agent asks the MCP server for a branch, gets a connection string in one call, works destructively in isolation, and throws the branch away — while a human oversees everything in a web dashboard.

## Goals

1. Instant (metadata-only) branching and point-in-time restore of local Postgres databases.
2. MCP server so agents can create/use/reset/restore branches without human help.
3. Shipped agent skills that establish the branch-per-task workflow.
4. Web dashboard: projects, branch tree, connection strings, logs, SQL console, settings.
5. Import an existing Postgres database into a branch.
6. Export branches as portable `pg_dump` artifacts to local disk, S3, or Azure Blob.
7. Optional continuous durability of all branch data to S3 **or Azure Blob**, with full recovery from bucket.

## Non-goals (v1)

- Multi-user auth, organizations, roles (localhost trust; bind 127.0.0.1).
- TLS/SNI routing, PgBouncer pooling, public-network deployment.
- Branch *merging* (branches fork; they never merge — same as Neon).
- Auto-suspend of idle endpoints (start is automated where it helps agents; stop stays explicit).
  **AMENDED 2026-07-13 (Worktree DB M5):** auto-suspend + wake-on-connect now
  SHIPS as the first post-parity milestone — idle endpoints park automatically
  (`WORKTREEDB_SUSPEND_TIMEOUT_SECONDS`, default 300, 0 disables) and wake on the
  next connection. See `docs/superpowers/plans/2026-07-13-worktreedb-m5-suspend-wake.md`
  and master-spec §8-M5 / D8. This reverses the v1 non-goal deliberately, on the
  daemon-owned-listener foundation that made a transparent wake possible.
- Native (non-Docker) packaging.
- Building Neon/Postgres from source (binaries come from a pinned engine image).

## Decisions log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Runtime | Single Docker container + one data volume |
| 2 | Control-plane language | TypeScript/Node 22 (Neon engine binaries stay Rust, driven via subprocess + HTTP) |
| 3 | "Checkpoint" semantics | Neon's meaning: durability sync status. User-facing time travel = branch/restore/reset |
| 4 | Bucket features | Both: continuous durability (S3/Azure) **and** explicit `pg_dump` exports |
| 5 | Agent connection model | Per-branch connection strings; "switch" = fetch another branch's connstring. No mutable pointer |
| 6 | Auth | None (localhost trust) |
| 7 | Engine orchestration | Faithful port of Neon's own reference process topology ("Approach A") |
| 8 | UI stack | React 19 + Vite + **Mantine** |
| 9 | PG versions | Two most recent stable majors (currently 17, 18); older kept if binaries provide them |
| 10 | Extensions | contrib + pgvector (inherited) + pg_cron + PostGIS (compiled in our image) |

## Concepts

- **Project** — a database universe pinned to a PG major version. Maps to a Neon **tenant**. Ships with default branch **`main`**.
- **Branch** — writable copy-on-write fork of a parent at a point in time. Maps to a Neon **timeline**. Instant; no data copy. Unit of agent isolation (*worktree : files :: branch : data*).
- **Endpoint** — the Postgres compute process serving a branch. Started on demand (explicitly, or automatically by MCP `create_branch`/`get_branch`), stopped explicitly. ~~Auto-suspend of idle endpoints is a non-goal for v1.~~ **AMENDED 2026-07-13 (Worktree DB M5): auto-suspend + wake-on-connect ships (see the non-goals note above).** Statuses: `stopped | starting | running | stopping | suspended | failed`.
- **Restore** — move a branch to a past timestamp/LSN, in place (destructive) or as a new branch (preferred).
- **Reset** — discard a branch's changes; back to parent's current state.
- **Checkpoint** — engine durability sync to remote storage; surfaced as an "all in sync" badge. Not a named marker.
- **Import / Export** — external PG → branch (streamed `pg_dump|pg_restore`); branch → portable `pg_dump -Fc` artifact (local/S3/Azure).

## Architecture

One container. The Node daemon is PID 1 and supervises (Neon's own reference topology):

| Process | Ports (container-internal) |
|---|---|
| storage_broker | :50051 |
| storage-controller Postgres (embedded) | :5431 |
| storage_controller | :1234 |
| pageserver | :9898 http, :64000 pg |
| safekeeper | :5454 pg, :7676 http |
| compute (per running endpoint, via `compute_ctl`) | one port each from the endpoint range |

**Exposed ports:** `4400` (REST API + Web UI + MCP, one HTTP server) and endpoint range `54300–54339` (configurable).

**Data dir** (single mounted volume): pageserver workdir, safekeeper workdir, storcon PG data, `state.db` (SQLite), per-process log files, lockfile.

**Lifecycle:** boot = acquire lockfile (DevDB's own stale-lock protocol — official Neon's local orchestration has no equivalent, since it's typically run interactively rather than supervising an unclean container shutdown) → optional state restore from bucket → start storcon-PG → broker → storcon → pageserver → safekeeper → reconcile SQLite state against real engine state (existing timelines, dead endpoints). Shutdown (SIGTERM) = stop computes → wait for durability sync ("final checkpoint") → stop engine processes in reverse order → release lock. `stop_grace_period` documented in compose file.

**Engine binaries:** multi-stage `COPY` from a published engine-binaries image **pinned by digest** (Apache 2.0, attribution in NOTICE). Our Dockerfile adds: Node runtime, our daemon, extension builds (below). If the pinned image lacks a required PG major (18), we build that compute flavor from the `neon` submodule as a fallback build stage — verified during planning.

**Simplifications vs Neon's own reference topology:** no PgBouncer (agents don't need pooling; endpoints accept direct connections), no TLS (SCRAM auth stays), no orgs/users/JWT, SQLite instead of a second embedded Postgres for management state.

## Control-plane daemon (TypeScript, Fastify)

Modules with hard boundaries:

- **ProcessSupervisor** — spawn/monitor engine binaries; ordered start/stop; log capture to ring buffer + files; crash restart with backoff.
- **Engine clients** — typed HTTP clients for pageserver/storcon/safekeeper management APIs. Rule: *make the same calls official Neon makes* (`timeline_create` with `ancestor_timeline_id`/`ancestor_start_lsn`, `timeline_info`, reset-to-LSN, tenant create via storcon). Each client method cites its neon reference (file:line or endpoint) in a comment.
- **ComputeManager** — endpoint port allocation, compute spec JSON generation (incl. `shared_preload_libraries`), `compute_ctl` launch, readiness poll, SCRAM secrets.
- **JobRunner** — imports/exports/restores as persisted jobs with SSE-streamed log channels.
- **State** — SQLite (Drizzle, WAL mode). All branch mutations flow through a per-branch queue (no interleaved operations).
- **McpServer / RestApi / StaticUi** — one Fastify instance, three faces.

### State model (SQLite)

- `projects` (id, name, pg_version, tenant_id, timestamps)
- `branches` (id, project_id, parent_branch_id, name, slug, timeline_id, password, port, endpoint_status, import_status, import_error, created_by: `ui|api|mcp`, context: nullable JSON — fork context, see §MCP server, timestamps)
- `jobs` (id, kind: import|export|restore, branch_id, status, error, log_path, lsn, size_bytes, timestamps)
- `export_targets` (id, name, kind: s3|azure|local, config JSON)
- `settings` (key, value)

## REST API

Flat, unauthenticated, under `/api`:

- `GET /api/status` — daemon + engine health, durability sync status, version
- `POST|GET /api/projects` · `GET|DELETE /api/projects/:id`
- `GET|POST /api/projects/:id/branches` — create: `{name, parent_branch_id?, at?: timestamp|lsn, context?}` — `context` = the same fork-context object MCP uses (see §MCP server), so non-MCP callers get parity
- `GET|PATCH|DELETE /api/branches/:id` — includes connection string when running
- `POST /api/branches/:id/endpoint/start|stop` · `GET /api/branches/:id/endpoint`
- `POST /api/branches/:id/restore` `{to, mode: in_place | new_branch{name}}` · `POST /api/branches/:id/reset`
- `POST /api/projects/:id/import` `{branch_name, source_connection_string}`
- `POST /api/branches/:id/exports` (returns a job) · `GET /api/jobs/:id` · `GET|POST|DELETE /api/export-targets`
- `GET /api/branches/:id/logs?channel=compute|import` (SSE) · `GET /api/daemon/logs/:component` (SSE)
- `POST /api/sql` `{branch_id, query}` (UI console backend)

Delete rules (ported): branch with children can't be deleted (error lists children); project delete tears down endpoints → timelines → tenant.

## MCP server

In-daemon, Streamable HTTP at `http://localhost:4400/mcp`, official `@modelcontextprotocol/sdk`. Setup: `claude mcp add --transport http devdb http://localhost:4400/mcp`.

**Design principles:** every success response is actionable text including the connection string when relevant and a "next step" hint, and opens with a context line naming the project and branch it acted on (plus parent, for forks) so agents and their transcripts always self-identify; every error names its remediation. Timestamps are ISO 8601.

**Tools:** `list_projects`, `create_project {name, pg_version?}`, `list_branches {project}`, `create_branch {project, name, parent?, at_timestamp?, context?}` (**auto-starts endpoint, returns connstring** — the "new worktree" move), `get_branch {project, branch, ensure_running?=true}` (the "switch" move), `stop_endpoint`, `delete_branch`, `reset_branch` (the "scrap and retry" move), `restore_branch {project, branch, to_timestamp, as_new_branch?, context?}`, `import_database {project, branch_name, source_connection_string}` (async), `export_branch {project, branch, target}` (async), `get_job {id}`, `get_status`.

> **Phasing (2026-07-03 refinement):** phase 2 registers the 10 non-import/export tools; `import_database`, `export_branch`, and `get_job` are **omitted until phase 4** (surfaced then via dynamic `tools/list_changed`), not stubbed. The MCP server runs **session-stateful** (per-session `clientInfo` powers fork context) and applies DNS-rebinding **Host/Origin validation** on `/mcp` while staying unauthenticated (localhost trust; not a bearer token). Full rationale: `2026-07-03-devdb-phase-2-mcp-skills-refinement-design.md`.

**Fork context (required):** every branch-creating tool (`create_branch`, `restore_branch` with `as_new_branch`, later `import_database`) takes a `context` object identifying the fork: `{git_branch?, workdir?, agent?, purpose?}` — the caller's current **git branch name**, its worktree/working directory, an agent/session label, and a one-line task description. The server adds what it can observe itself: `client: {name, version}` from the MCP `initialize` handshake (the transport itself is already recorded as `created_by`). The fields are optional in the tool schema (a bare call still works) but described as strongly recommended, and the shipped skills fill them automatically. Context is persisted on the branch (`branches.context`), returned by `get_branch`/`list_branches` and the REST branch DTOs, and rendered in the web UI's branch tree — this is how a human tells parallel agents' forks apart.

## Agent skills (`skills/`)

Superpowers-convention SKILL.md files, installable to `~/.claude/skills` or a project's `.claude/skills`; they reference MCP tool names exactly and version with the daemon.

1. **using-devdb** — branch-per-task discipline: branch `agent/<task-slug>` off `main`; write connstring into the worktree's env; never share a branch between concurrent agents; delete on completion; always pass fork context on `create_branch` (`git_branch` via `git branch --show-current`, `workdir` = the worktree path, `purpose` = one line on the task).
2. **safe-db-migrations** — rehearse on a branch, verify, apply to `main`; `restore_branch` as the undo for mistakes on `main`.
3. **importing-databases** — bring an external DB in as `main`/snapshot branch; Docker reachability guidance (`host.docker.internal`). *(2026-07-03 refinement: ships in **phase 4** with the import/export tools. Phase 2 ships skills 1–2, distributed via README install + the MCP `initialize` `instructions` field so zero-install agents still get the discipline.)*

## Web UI

React 19 + Vite + **Mantine**, static build embedded in the daemon at `:4400`. No login. Fresh design — no upstream visual/layout reuse.

- **Dashboard** — projects, engine health, durability badge.
- **Project view** — **git-graph-style branch tree** with endpoint status chips and per-branch actions (branch-from-here, copy connstring, start/stop, restore, reset, export, delete). Agent-created branches tagged with their fork context — creating agent, its **git branch**, purpose — as an inline chip on the tree node, full context in the branch panel; whose-fork-is-whose must be readable at a glance.
- **Branch panel** — connstring, live logs (SSE), job history, restore picker, danger zone.
- **SQL console** — branch picker, query box, results table.
- **Settings** — remote storage (none/S3/Azure) + sync status, export targets, port range.

## Import & Export

**Import** (whole-database; targets a new branch, or seeds `main` on a fresh project): create empty branch → start endpoint → `pg_restore` → progress via job log channel → `importing → ready|failed` (stderr tail kept on failure). **Three source kinds, symmetric with the export destinations — one shared `pg_restore`/custom-format engine:**
1. **Running server** — `pg_dump -Fc <source-connstring> | pg_restore` from any reachable Postgres (`host.docker.internal` for a DB on the host). Surface: MCP `import_database {source_connection_string}` (+ UI form).
2. **Uploaded `pg_dump -Fc` file** *(the initial manual-restore path)* — the user uploads a custom-format dump (web UI drag-drop + a REST multipart endpoint); `pg_restore` it into the target branch. Consumes exactly what **Export** produces, closing the import/export asymmetry. File-upload is a UI/REST path, not an MCP tool (agents don't upload files).
3. **Configured-bucket artifact (S3 / Azure Blob)** *(follow-on)* — pull a `pg_dump` artifact from the same S3/Azure bucket the durability + export config already defines, then `pg_restore`. Rides the phase-4 bucket wiring (a natural MCP-tool extension: a bucket source ref).

Sequencing within phase 4: (1) is the base import; (2) the initial manual path (no bucket dependency); (3) lands with/after §Durability's bucket config.

**Export:** `pg_dump -Fc` from the branch endpoint (auto-start if needed) streamed to destination without disk buffering: local file (data dir), S3 multipart, or Azure block blob. Job records size + LSN. Artifacts are standard custom-format dumps restorable anywhere.

## Durability & recovery

Daemon-level mode `none | s3 | azure` (config/env at boot). We generate pageserver `remote_storage` + safekeeper WAL-backup config for the chosen backend (upstream Neon supports S3, Azure, GCS natively — verified in `libs/remote_storage`; DevDB wires S3 + Azure). When enabled: layers stream continuously; `state.db` is uploaded on an interval and on graceful shutdown. Recovery: fresh container + same bucket + same config → restore `state.db`, fetch layers on demand. Switching `none → bucket` allowed; `bucket → none` blocked with explanation.

## Postgres versions & extensions

- **Versions:** the two most recent stable majors — currently **17 and 18** — selectable per project; older majors (14–16) exposed if present in the engine binaries. Policy: track new stable majors as upstream Neon supports them.
- **Extensions (every supported major):** full contrib set + **pgvector** (inherited from the pinned engine image); **pg_cron** and **PostGIS** compiled in our Dockerfile against the shipped `pg_install` headers. `shared_preload_libraries` preset (pg_cron) in generated compute config so `CREATE EXTENSION` just works. UI lists available extensions per project.

## Error handling

- Engine crash → supervised restart with backoff; degraded health in `/api/status`, UI banner, MCP `get_status`.
- Boot reconciliation — SQLite vs engine reality; report and repair drift instead of trusting either side.
- Port exhaustion → error names running endpoints.
- In-place restore requires stopped endpoint → callers auto-stop and say so.
- Import failure → branch kept `failed` + stderr tail; deletable.
- No silent cascades; children block parent deletion.
- Per-branch mutation queue serializes concurrent (MCP) operations.

## Testing

- **Unit (vitest):** daemon logic w/ mocked engine clients — state transitions, config generation, port allocation, connstrings.
- **Integration (backbone):** build image, run real container, drive via REST + MCP + real PG client: project → write → branch → verify CoW isolation both directions → restore to timestamp → import from fixture PG → export to **MinIO** and **Azurite** → disaster-recovery boot from bucket. Every feature lands with an integration test.
- **MCP contract:** official SDK client against `/mcp` in the integration tier.
- **UI:** light component tests; Playwright smoke deferred.

## Repo layout

```
packages/daemon/     TS control plane (REST + UI + MCP)
packages/web/        React + Mantine UI → embedded static build
packages/shared/     zod schemas/types shared daemon↔web
skills/              using-devdb, safe-db-migrations, importing-databases
docker/              Dockerfile, compose.yaml
tests/integration/   container-level suite
docs/                user docs · docs/superpowers/specs/ design docs
```

## Risks & open questions (to resolve in planning)

1. **PG 18 in the pinned engine image** — does the pinned image ship v18 compute? If not: fallback build stage from `neon` submodule.
2. **Exact engine API shapes** — pin pageserver/storcon endpoints + payloads by reading official Neon's own call sites against the initialized `neon` submodule.
3. **pg_cron in Neon computes** — confirm background-worker behavior in `compute_ctl`-launched computes (Neon cloud supports it; verify locally).
4. **PostGIS build time/size** — acceptable image growth; if painful, make it an opt-in image variant.
5. **Engine image digest pinning** — choose digest; document upgrade procedure.
6. **Branch-from-timestamp UX** — timestamp→LSN resolution comes from engine APIs; confirm precision/rounding behavior.

## v1 acceptance (demo script)

1. `docker compose up` → dashboard on `:4400` within seconds of engine readiness.
2. Create project (PG 18) → `main` branch; connect with `psql`; create table + rows.
3. `claude mcp add … /mcp`; agent runs `create_branch` (with fork context) → gets connstring → destructive changes on its branch; `main` unaffected; branch tree shows both, the agent's branch carrying its fork context (git branch, purpose).
4. Agent `reset_branch` → branch matches `main` again; `restore_branch --as-new-branch` recovers a pre-mistake timestamp.
5. Import an external database into a new branch; watch progress live.
6. Export a branch to MinIO (S3) and Azurite (Azure); `pg_restore` the artifact into vanilla Postgres successfully.
7. With S3 durability on: destroy container + volume, recreate from bucket, branches and data return.
8. `CREATE EXTENSION vector, postgis, pg_cron;` succeeds on a fresh branch.

## Amendments

- **2026-07-03 (Jordan): MCP fork context.** Branch-creating MCP tools must attach caller context — current **git branch name**, workdir, agent label, purpose, plus server-captured MCP client info — persisted on the branch (`branches.context`, additive migration in phase 2) and rendered in the UI branch tree, so parallel agents' forks are easily identifiable. MCP success responses also open with a context line naming the project/branch acted on. Sections updated: State model, REST API, MCP server (new "Fork context" paragraph), Agent skills, Web UI, v1 acceptance item 3.
- **2026-07-03: Phase-2 refinement (MCP auth, tool phasing, skill distribution, statefulness).** Resolved the three product questions still open entering phase 2, plus one implementation constraint: (1) `/mcp` stays unauthenticated but gains DNS-rebinding Host/Origin validation, and compose binds both port ranges to `127.0.0.1`; (2) the import/export tools (`import_database`, `export_branch`, `get_job`) are omitted until phase 4, not stubbed; (3) skills ship via README install + the MCP `instructions` field (plugin packaging parked to phase 5); (4) the MCP server runs session-stateful so `initialize` client info reaches later branch-creating calls. Full design: `2026-07-03-devdb-phase-2-mcp-skills-refinement-design.md`. Sections annotated: MCP server (Tools), Agent skills.
- **2026-07-04 (Jordan): Import gains manual-restore source kinds (phase 4).** Import is no longer only "from a running server." It spans three source kinds, symmetric with the export destinations and sharing one `pg_restore`/custom-format engine: (1) running server (existing, MCP `import_database` connstring); (2) **uploaded `pg_dump -Fc` file** — the *initial* manual-restore path, a UI drag-drop + REST multipart endpoint (not an MCP tool), which closes the asymmetry that export already emits `pg_dump` files but import couldn't consume one; (3) **artifact from a configured S3/Azure bucket** — a *follow-on* that rides §Durability's bucket wiring. Sequencing: file-upload first, bucket-import once the durability bucket config lands. Sections updated: Import & Export; v1 acceptance item 5 should gain the file-upload path when phase 4 is planned. Handover §6 carries the roadmap detail.
- **2026-07-03: Phase-3 refinement (Web UI).** (1) **SQL console deferred beyond phase 3** (Jordan: no SQL-client ambitions for now) — remains product surface, unscheduled; its §Web UI line stands as future scope. (2) The branch tree ships as **two switchable renderers** — git-graph rails (hand-rolled SVG) and a React Flow node canvas — with a configurable default view. (3) UI freshness comes from a new **`/api/events`** SSE invalidation channel (coarse hints, no replay; REST stays the source of truth). (4) Project view = full-width tree + transient branch drawer under a top-bar shell. Full design: `2026-07-03-devdb-phase-3-web-ui-design.md`. Sections affected: Web UI, REST API (events + rename), Testing (UI tier).
