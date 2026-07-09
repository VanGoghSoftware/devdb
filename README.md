# DevDB

Local Postgres with Neon-style instant branching, built for AI coding agents.
One Docker container; branches are copy-on-write and cost nothing to create.

## Quickstart

    docker compose -f docker/compose.yaml up --build -d
    curl http://localhost:4400/api/status

> **First build only:** the image's Neon engine base is a **private** GHCR image, so run a one-time `docker login ghcr.io` (with a `read:packages` PAT) before `--build`. See [`docker/BINARIES.md`](docker/BINARIES.md#private-registry-access).

Open the dashboard at [http://localhost:4400](http://localhost:4400).

Create a project (comes with a `main` branch):

    curl -X POST http://localhost:4400/api/projects \
      -H 'content-type: application/json' -d '{"name":"acme"}'

Start `main`'s endpoint and connect:

    curl -X POST http://localhost:4400/api/branches/<mainBranchId>/endpoint/start
    # the start response includes connectionString — use it directly with psql
    psql 'postgresql://postgres:<password>@127.0.0.1:<port>/postgres'

Branch it (instant, copy-on-write) and get an isolated database:

    curl -X POST http://localhost:4400/api/projects/<projectId>/branches \
      -H 'content-type: application/json' -d '{"name":"agent/my-task"}'

Query via the API:

    curl -X POST http://localhost:4400/api/sql \
      -H 'content-type: application/json' \
      -d '{"branchId":"<branchId>","query":"SELECT 1 AS ok"}'

Time travel:

    # non-destructive: recover a past state into a new branch
    curl -X POST http://localhost:4400/api/branches/<id>/restore \
      -H 'content-type: application/json' \
      -d '{"mode":"new_branch","to":"2026-07-02T10:00:00Z","name":"rescued"}'
    # discard a branch's changes (back to parent state)
    curl -X POST http://localhost:4400/api/branches/<id>/reset

## MCP server (for AI agents)

DevDB exposes an MCP server at `http://localhost:4400/mcp` (Streamable HTTP). Register it:

    claude mcp add --transport http devdb http://localhost:4400/mcp

Tools: `list_projects`, `create_project`, `list_branches`, `create_branch` (auto-starts an endpoint
and returns a connection string), `get_branch`, `stop_endpoint`, `delete_branch`, `reset_branch`,
`restore_branch`, `get_status`, `list_pg_builds`, `check_pg_updates`, `pull_pg_build`,
`activate_pg_build` (see [Postgres builds](#postgres-builds) below — there is deliberately no
delete-over-MCP tool; removing a build is a Settings/REST-only action). (Import/export tools arrive
in a later release.)

The server is unauthenticated (localhost trust) but validates `Host`/`Origin` to block DNS-rebinding.
Reaching it from another host or a custom hostname:

- Publish wider by overriding the compose port binding (drop the `127.0.0.1:` prefix) — you accept the exposure.
- Add the hostname to the allowlist: `DEVDB_MCP_ALLOWED_HOSTS=myhost:4400` / `DEVDB_MCP_ALLOWED_ORIGINS=http://myhost:4400`.

## Postgres builds

The image ships a digest-pinned set of Postgres majors (currently 14–17) baked in at build time.
On top of that, DevDB can pull **newer official Neon compute builds at runtime** — a bugfix minor
for a major you already run (e.g. 16.9 → 16.10), or an entirely new major not in the image — without
destroying and re-upping the container. Every pull is validated end-to-end against your *live*
storage (a throwaway compute boots for real and runs smoke SQL) before it becomes activatable, so a
build that doesn't actually work with your storage never gets a chance to run your data.

Three equivalent surfaces:

- **Settings card** (web UI) — per major: active version + source, "check for updates", pull with
  live progress, an installed-builds list with activate/rollback/delete, and a degraded-downgrade
  banner if one ever applies.
- **REST** — `GET /api/pg-builds` (list), `POST /api/pg-builds/check` (look for a newer release),
  `POST /api/pg-builds/pull` (returns `202` immediately; poll the list or the `pg_builds` SSE event
  for progress), `POST /api/pg-builds/:id/activate`, `DELETE /api/pg-builds/:id`.
- **MCP** — `list_pg_builds`, `check_pg_updates`, `pull_pg_build`, `activate_pg_build`. There is
  deliberately no delete tool over MCP — removing a build is infrastructure-destructive and stays a
  human-in-Settings action.

**Adopt on restart, never mid-flight.** Activating a build only changes which binary the *next*
endpoint start uses — a running endpoint keeps the binary it started with. If a newer build becomes
active while an endpoint of that major is up, the branch drawer / tree shows a
"restart to adopt \<version\>" chip; restart the endpoint whenever you're ready, there's no forced
cutover.

**Downgrades are never silent.** The neon extension's catalog version lives in your data and
upgrades forward-only, so going backward is the direction that can actually cause trouble.
Activating an older build than the major has already run pops a confirmation ("Activating 16.9 is a
downgrade below 16.10. The neon extension's catalog upgrades forward-only. Continue?") — proceeding
is a deliberate, consented rollback, not an accident. If DevDB itself ever resolves a major to a
version older than it last ran (e.g. a downloaded build's directory went missing and only an older
baked one remains), it flags that major as degraded in `/api/status` and the UI rather than starting
silently on the lower version.

**Egress is honest and opt-in.** The daemon never checks for updates or pulls anything on its own —
only an explicit check or pull from the UI/REST/MCP touches the network, and only to
`auth.docker.io` (token exchange) and `registry-1.docker.io` (the official `neondatabase` org on
Docker Hub). Everything else — including all normal branching/endpoint traffic — stays fully
offline-capable. Behind a mirror or in an air-gapped environment, point the pull path at your own
registry with `DEVDB_PG_REGISTRY_BASE` (default `https://registry-1.docker.io`) and
`DEVDB_PG_IMAGE_TEMPLATE` (default `neondatabase/compute-node-v{major}`, must contain the literal
`{major}` placeholder).

**Disk.** Each downloaded build costs roughly 250 MB on the `/data` volume. DevDB keeps the active
build plus one previous per major as a fast rollback target. Garbage collection happens **at daemon
boot** (part of reconciliation) and on **manual delete** from the Settings card or REST — there is no
background/continuous collector running during normal operation. A build still in use by a running
compute is never eligible for GC or delete (`DELETE` 409s on it), and baked builds are never
GC/delete-eligible at all. Reclaim space explicitly any time from the Settings card, or restart the
daemon to trigger boot GC.

**New majors: works if your storage build supports it.** Pulling a newer *minor* of an already-baked
major is the first-class, always-works case. Pulling a **new major** works too, but it's gated by
what the baked storage engine can actually serve — per-tenant WAL redo runs inside the baked
pageserver, so a major that storage release predates can't be served no matter which compute
binaries you have. Rather than guess, DevDB just tries it: the same validation gate that every pull
goes through (a real compute against your real storage, smoke-tested) answers this empirically. If
it fails, that's the storage engine's ceiling, not a bug — the guaranteed way to add a new major is
still a fresh image with a newer baked storage release.

**Troubleshooting: gate fails on protocol negotiation.** If validation fails specifically because the
downloaded compute and the baked pageserver can't agree on the Neon storage protocol version (a skew
between a very fresh compute build and an old baked storage release), it can be pinned explicitly via
`neon.protocol_version` in the endpoint's pgconf. This isn't automated or exposed in the UI — treat it
as a documented escape hatch for that specific failure mode, not a routine setting.

## Agent skills

Copy the shipped skills into your agent's skills directory:

    cp -r skills/using-devdb skills/safe-db-migrations ~/.claude/skills/     # global
    # or into a project: cp -r skills/* /path/to/repo/.claude/skills/

Even with no skills installed, connected agents receive the core branch-per-task workflow via the
MCP server's `initialize` instructions.

## Developing the UI

The daemon serves the built UI from `DEVDB_WEB_DIST` (set in the image). For UI development,
run the daemon (or the container) as usual, then:

    pnpm --filter @devdb/web dev

Vite serves the SPA on :5173 and proxies `/api` + `/mcp` to `localhost:4400` — no CORS, and
SSE (live logs, /api/events) streams through the proxy unbuffered.

## Troubleshooting

**"lockfile /data/.lock exists" on startup.** DevDB uses an exclusive-create
lockfile in its data volume to stop two instances from sharing one data dir.
An unclean shutdown (host reboot, `docker kill`, an OOM kill) skips the normal
cleanup that removes it, so the NEXT startup finds it still there and refuses
to boot — a safety check, not a crash. If you're sure no other devdb
container is using this volume, clear it with:

    docker compose -f docker/compose.yaml run --rm devdb rm /data/.lock

Then start normally (`docker compose -f docker/compose.yaml up -d`).

**Upgrading from a neond-engine devdb volume.** DevDB's storage controller keeps
its own small catalog Postgres (`storcon_db`) on the `/data` volume. The catalog
major changed when the engine moved off the prebuilt neond image, so a volume
first created by an older image can carry a `storage_controller_pg_data` from a
different Postgres major than the current image ships. Postgres cannot open a
data directory from another major, so rather than let it FATAL-loop cryptically,
the daemon refuses to boot and prints the major it found versus the major this
image ships. Either **start fresh with a new volume**, or **keep running the
previous image**; automated migration of an existing volume lands with
import/export (a later phase).

**Where did my logs go?** `docker compose logs devdb` carries all engine and
compute output (storage controller, pageserver, safekeeper, and every
compute's `compute_ctl`/postgres) — it's the container's own stdout/stderr,
so no separate log file to find.

Status: Phase 1 is complete — engine, branching, endpoints, time travel, logs
(SSE), and restart resilience are all live and integration-proven end to end.
Phase 2 (MCP server + agent skills) is live per above. Phase 3 (the embedded
web UI — dashboard, git-graph branch tree with live updates, branch drawer,
logs, restore) is live and served from the image at `:4400`. Import/export and
S3/Azure durability land in subsequent phases.
Built on [Neon](https://github.com/neondatabase/neon)'s storage engine (Apache 2.0);
architecture and orchestration are DevDB's own.
