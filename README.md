# DevDB

Local Postgres with Neon-style instant branching, built for AI coding agents.
One Docker container; branches are copy-on-write and cost nothing to create.

## Quickstart

    docker compose -f docker/compose.yaml up --build -d
    curl http://localhost:4400/api/status

Open the dashboard at [http://localhost:4400](http://localhost:4400).

Create a project (comes with a `main` branch):

    curl -X POST http://localhost:4400/api/projects \
      -H 'content-type: application/json' -d '{"name":"acme"}'

Start `main`'s endpoint and connect:

    curl -X POST http://localhost:4400/api/branches/<mainBranchId>/endpoint/start
    # the start response includes connectionString — use it directly with psql
    psql 'postgresql://postgres:<password>@localhost:<port>/postgres'

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
Built on [Neon](https://github.com/neondatabase/neon)'s storage engine;
architecture informed by [neond](https://github.com/matisiekpl/neond) (Apache 2.0).
