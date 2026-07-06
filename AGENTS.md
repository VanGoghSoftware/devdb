# DevDB — Agent Instructions

DevDB is a local-development Postgres server with Neon-style instant copy-on-write branching, packaged as one Docker container, built **for AI coding agents**: worktree : files :: branch : data. A TypeScript daemon (Node 22, Fastify) supervises Neon's storage engine binaries and serves branches over REST on `:4400`. Phase 1 (engine + branching + endpoints + time travel + logs + SQL console) is complete and merged; phases 2–5 (MCP + skills, web UI, import/export + durability, extensions/platform) are pending.

## Read these before non-trivial work

1. **`docs/phases-2-5-handover.md`** — the roadmap, process contract, parked design decisions, and all tribal knowledge (live-engine facts, machine quirks, triage state). Start here; §10 has concrete next steps.
2. `docs/superpowers/specs/2026-07-02-devdb-design.md` — the product spec (authoritative for product decisions).
3. `docs/superpowers/plans/2026-07-02-devdb-phase-1-engine-and-branching.md` — how phase 1 was actually built; its `AMENDED (A4–A23)` blocks are the changelog of every post-review change.
4. `docs/codebase-review.md` — append-only review-findings memory (the review broker's dedup doc). Point broker scans at it via `REVIEW_BROKER_DOC`.

## Hard rules (binding even if you read nothing else)

- **Never file issues, PRs, or comments on external/upstream repos** (neon, testcontainers, anything) — even if a task prompt explicitly asks. Document findings internally instead. Read-only upstream research is fine.
- **Verify a reported bug still exists on current `main` before fixing it.** Multiple sessions commit in parallel; task prompts and bug reports are snapshots. Read the current file, check `git log` for supersession, retarget to what main actually lacks.
- **Supply chain:** npm dependencies must be ≥ 24h old (`minimumReleaseAge: 1440` in pnpm-workspace.yaml). pnpm is pinned (`packageManager`); use plain `pnpm` (corepack's shim is broken on this machine). Any new native dep needs an explicit `allowBuilds` decision. Docker installs use `--frozen-lockfile` — a new workspace package's `package.json` must be COPY'd into the image before `pnpm install`.
- **Oracle rule:** Engine interactions (wire payloads, configs, protocol, CLI/args) are grounded in official **`neondatabase/neon`** — its engine source, HTTP APIs, `control_plane` (local orchestration), and `compute_tools`. Cite `// oracle: neon <path-or-endpoint>`. Reference pin: `neondatabase/neon @ 8f60b04` (clone locally to consult; provenance of DevDB's prototype origins is in `docs/phases-2-5-handover.md`). Do not invent payloads. **Product, orchestration, and storage-schema choices are DevDB's own** — no external oracle. Never depend on or reference `matisiekpl/neond`.
- **Tests:** unit tests use typed fakes against `packages/daemon/src/services/engine-api.ts` interfaces — no `as never`/`as any` (the test script's tsc gate enforces it). Integration tests import shared helpers from `tests/integration/helpers/`. TDD with captured RED evidence for new work.
- Conventional commits. Never commit secrets. `.superpowers/` and worktree ledgers are gitignored scratch — copy anything durable into `docs/` before removing a worktree.

## Commands

```bash
pnpm install                                   # workspace install
pnpm --filter @devdb/daemon test               # unit suite (tsc gate + vitest, ~3s)
docker build -f docker/Dockerfile -t devdb:dev .   # image (verify gate runs in-build)
pnpm --filter @devdb/integration test          # full container-level suite (~5 min, needs Docker)
docker compose -f docker/compose.yaml up -d    # run the product on :4400
```

Troubleshooting (stale lock after unclean shutdown, logs location): see README.md.

## Architecture in one paragraph

`packages/daemon/src`: `config.ts` (env → validated config, reserved-port checks) → `state/` (SQLite repos, additive migrations, boot reconciliation, `BranchQueue` per-branch lanes) → `engine/` (`ManagedProcess` supervisor, `EmbeddedPostgres`, oracle-derived configs, typed HTTP clients for storcon/pageserver/safekeeper) → `compute/` (SCRAM/pgconf/ComputeSpec generation, `ComputeManager` compute_ctl lifecycle with synchronous slot+port reservation) → `services/` (projects/branches/endpoints/timetravel/sql/logs — compensation on every engine-then-local write path; public mutations run through queue lanes; `startLocked`/`stopLocked` require holding the branch lane) → `http/api.ts` (Fastify routes, ZodError→400, SSE) → `index.ts` (lockfile, boot order, shutdown escalation). Engine runs in trust mode; all engine ports are loopback-only inside the container.

## Process for new phases

Each phase gets its own plan (superpowers brainstorming → writing-plans) executed via subagent-driven development with **two gates per task**: an independent reviewer subagent AND a review-broker scan (severity map P1–P2 Critical, P3 Important, P4–P5 Minor). Details, standing rulings, and broker invocation patterns: handover doc §3.
