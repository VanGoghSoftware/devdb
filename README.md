# DevDB

Local Postgres with Neon-style instant branching, built for AI coding agents.
One Docker container; branches are copy-on-write and cost nothing to create.

## Quickstart

    docker compose -f docker/compose.yaml up --build -d
    curl http://localhost:4400/api/status

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

Status: Phase 1 is complete — engine, branching, endpoints, time travel, logs
(SSE), and restart resilience are all live and integration-proven end to end.
Web UI, an MCP server for agents, import/export, and S3/Azure durability land
in subsequent phases.
Built on [Neon](https://github.com/neondatabase/neon)'s storage engine;
architecture informed by [neond](https://github.com/matisiekpl/neond) (Apache 2.0).
