# Worktree DB — Go rewrite design

**Date:** 2026-07-11 · **Status:** approved (Jordan, section-by-section) · **Owner:** Jordan
**Repos:** workshop = `VanGoghSoftware/devdb` (this repo) · showroom = `VanGoghSoftware/worktreedb` (empty, private)

This is the **master spec** for rewriting the DevDB daemon in Go as **Worktree DB**. It fixes the
decisions, architecture, milestones, and process; each milestone gets its own implementation plan
(writing-plans) referencing this document. It lives in the devdb repo deliberately — see §3.

---

## 1. Goal

Rewrite the product — today a TypeScript daemon (Node 22/Fastify) + React web UI — as a **Go
daemon** named **Worktree DB** (display "Worktree DB", code identifier `worktreedb`), in the
fresh `github.com/VanGoghSoftware/worktreedb` repo with **clean git history**, reaching **full
functional parity** with today's product, then immediately shipping **auto-suspend + wake-on-
connect** as the first post-parity milestone.

The engine build pipeline (docker/neon-build, cmd/worktreedb-build, the GHCR publish workflow)
**stays in the devdb repo**. The new repo only consumes the published engine images; the sole
cross-repo contract is the engine image digest pin (§10).

## 2. Decisions (Jordan, 2026-07-10/11)

| # | Decision | Choice |
|---|---|---|
| D1 | Functional target | **Full parity, phased** — nothing dropped; milestones each dogfoodable |
| D2 | Web UI | **Copy + rename** the React/Mantine app; Go REST API stays **byte-compatible** so it runs unchanged (visible similarity to devdb's packages/web accepted until the parked restyle) |
| D3 | Data volumes | **Fresh start** — Worktree DB only initializes fresh volumes; no TS-schema migration; phase-4 export/import is the eventual bridge |
| D4 | Commit policy (worktreedb repo) | Conventional commits, **no AI co-author trailers** (devdb repo policy unchanged) |
| D5 | Docs | **Workshop/showroom split** — specs/plans/ledgers/review docs live in devdb; worktreedb gets only clean self-contained docs |
| D6 | Env prefix | **`WORKTREEDB_*`**; local image `worktreedb:dev`; HTTP port 4400 |
| D7 | Approach | **Idiomatic re-architecture, full depth** — external contract identical, internals redesigned Go-first **including the state model** |
| D8 | Endpoint data path | **Daemon-owned listeners (L4 proxy) from day one**; suspend+wake behavior ships as the **first post-parity milestone**, never inside the parity gate |

## 3. Clean-history rules (what "clean" means, operationally)

- worktreedb's history, code, comments, and docs never mention: the TypeScript implementation,
  the devdb repo, or `matisiekpl/neond`. It presents as a self-contained Go implementation.
- **Allowed and expected:** `// oracle: neon <path-or-endpoint>` citations to official
  `neondatabase/neon` — the engine is openly Neon's storage engine (the image is literally named
  `worktreedb-neon-engine`); engine-protocol grounding continues exactly as in the devdb oracle
  rule.
- The copied web app is a visible exception by decision D2 (one squashed `feat: web ui` commit,
  all devdb→worktreedb strings renamed).
- All rewrite paperwork that needs TS references (this spec, milestone plans, progress ledgers,
  the review-broker dedup doc) lives in the devdb repo. `REVIEW_BROKER_DOC` is pointed at the
  workshop doc per-session and is never written into worktreedb files.
- worktreedb's own AGENTS.md/CLAUDE.md describe the Go system and its process on their own terms.

## 4. System shape

- One module `github.com/VanGoghSoftware/worktreedb`, one binary `cmd/worktreedbd`.
- `internal/` packages: `config`, `store`, `runtime` (owner framework), `engine`, `compute`,
  `proxy`, `builds`, `oci`, `api`, `mcp`, `events`. `web/` holds the copied React app,
  `//go:embed`ed into the binary (optional `WORKTREEDB_WEB_DIST` dev override serves from disk).
- Docker image, multi-stage: node builds the web dist → golang builds the static daemon
  (`CGO_ENABLED=0`) → runtime `FROM ghcr.io/vangoghsoftware/worktreedb-neon-engine@<digest>` +
  the binary. No Node runtime is required by the daemon (the engine base happens to ship node —
  slimming that base is a devdb-pipeline backlog item, out of scope here).
- Env (defaults match TS semantics): `WORKTREEDB_HTTP_PORT` (4400), `WORKTREEDB_DATA_DIR`
  (/data), `WORKTREEDB_PORT_RANGE` (54300-54339), `WORKTREEDB_NEON_BIN_DIR`,
  `WORKTREEDB_PG_INSTALL_DIR`, `WORKTREEDB_MCP_ALLOWED_HOSTS/_ORIGINS`,
  `WORKTREEDB_PG_REGISTRY_BASE/_IMAGE_TEMPLATE/_TOKEN` (same Docker-Hub-default + GHCR-opt-in
  posture; token secret, never logged/DTO'd), `WORKTREEDB_WEB_DIST` (optional).

## 5. State model (the heart of the redesign)

SQLite (WAL, single writer, `modernc.org/sqlite`), but the schema is **spec / status /
operations**, not imperative status rows:

- **spec** — desired state; written only by API/MCP; every write bumps `spec_generation`.
- **status** — observed state; written only by the resource's owner, stamped with
  `observed_generation`. A convergence commit for a stale generation is abandoned.
- **operations** — durable intent log for multi-step work (create/restore branch, pull build,
  cascaded deletes): kind, target, params, step cursor, phase, error. Owners execute step-wise;
  incomplete operations are resumed or failed-forward at boot **by per-kind policy chosen to
  match TS-observable behavior at the parity gate** (e.g. crash-mid-pull boots to `failed` +
  retry-allowed, like today's `failInterrupted`; resume-instead is a post-parity flip).

Schema v1 (fresh volumes only, D3): `projects`, `branches` (endpoint spec/status folded in —
the 1-endpoint-per-branch invariant is structural; includes the sticky `port_slot`),
`pg_builds` + `pg_actives` (active pointer per major + `last_run_minor` high-water),
`operations`, `meta` (schema_version, instance id). Events are an in-memory bus (not persisted,
as in TS), emitted on **status transitions** — emission discipline by construction.

Structurally eliminated bug classes (each named for its TS ancestor, each carried as a
regression test): hand-written compensation on engine-then-local writes (convergence replaces
it); interrupted-row/orphan-dir boot sweeps (uniform operation resume subsumes
`failInterrupted`/`adoptVolumeBuilds`/ENOTEMPTY reclaim); the restore ancestry-divergence item
deferred from phase 4 (restore is a durable operation with a step cursor); stop-during-start
status clobbers (generation-checked commits).

## 6. Runtime

**Owners (actors).** One goroutine per branch (its inbox serializes all mutations for that
branch — the TS lane contract made structural), one **builds owner** (single in-flight pull
preserves the global-pull-mutex 409), one **engine supervisor**. Loop: read spec + incomplete
operations → converge → write generation-stamped status.

**Cross-owner rule** (folds in the deferred endpoint-vs-build-lane concurrency pass): a branch
owner resolves its `pgbin` and registers the in-use ref inside its own convergence step; the
builds owner consults those refs before any remove. Same guarantee as TS `runningPgbins()`, now
a stated protocol between single-writer actors instead of a synchronicity argument.

**Engine supervisor.** Owns pageserver/safekeeper/storage_broker/storage_controller + the
true-upstream vanilla-PG storcon catalog as children: spawn order, readiness probes, the
storcon-major guard (read `PG_VERSION`, refuse foreign major), process-group kill, log fan-in.
Restart policy exists but ships **off at parity** (engine death → `degraded`, matching TS).

**Endpoint data path — daemon-owned listeners.** The daemon permanently owns the published range
54300–54339 as **slots**; computes bind ephemeral loopback ports (`127.0.0.1:0`); a
goroutine-per-connection L4 splice joins them (no Postgres protocol awareness — SCRAM and the
SSLRequest dance pass through as bytes; `TCPConn` splice keeps COPY-heavy workloads cheap).
This deletes the reserve-then-probe/TOCTOU port class and the suspended-mid-start re-check
class at the root. Per-endpoint live connection count is the idle signal (compute_ctl `/status`
needs a JWT even with `--dev`; only `/metrics` is auth-free — we need neither).
`suspend_timeout_seconds` stays `-1` in the ComputeSpec: policy lives in the daemon only.

- **Bind-on-running at parity:** a slot's listener is bound only while the endpoint is logically
  running, so a stopped endpoint still yields ECONNREFUSED — byte-identical to TS. The suspend
  milestone flips suspended endpoints to stay bound and wake on accept.
- **Suspend falls out of the state model:** idle sweeper parks the compute and writes
  `status: suspended` while `spec: running` is unchanged; wake = the proxy nudging the branch
  owner to re-converge toward its own spec — through the inbox, so wake-vs-delete/restore is
  serialized by construction. User stop = `spec: stopped`. Suspended-vs-stopped is in the data;
  surfacing it is an additive status field at M5. Wake latency budget ~1–2 s (proxy holds the
  accepted connection during start); documented for GUI users at M5.
- Never suspend with open connections (conn-count rule gives this by construction).

## 7. External surface & parity

- **REST byte-compatible** with today's `/api/*`: projects/branches/endpoints CRUD + rename,
  timetravel, logs SSE, events SSE, status (incl. pgBuilds block), pg-builds
  (list/check/pull 202+buildId/activate/delete, 409 semantics, benign `skipped` rows),
  storcon-guard refusal surface. A thin DTO layer maps spec/status → the TS wire shapes;
  the internal redesign never leaks. SQL console remains dropped (P3 decision).
- **MCP parity:** same 10 tools and behaviors (create_branch partial-success, downgrade refusal,
  fork-context capture), stateful sessions, Host/Origin DNS-rebinding guard re-implemented as a
  contract. SDK: official `modelcontextprotocol/go-sdk`; feature coverage verified during M3
  planning (fallback: `mark3labs/mcp-go`). Skills renamed: `using-worktreedb`,
  `safe-db-migrations`.
- **Web:** the copied app consumes the API unchanged; embedded serving with the same
  SPA-fallback hardening.
- **Verification is dual:**
  1. Go-native: unit tests against typed fakes of engine clients (no untyped casts — enforced in
     review); testcontainers-go integration tests for the new seams (owner serialization,
     generation abandonment, proxy splice, operation resume).
  2. **The TS integration suite as the parity oracle:** the devdb suite, parameterized
     workshop-side on env prefix + image name, runs against `worktreedb:dev`. Known
     helper-portability item: the pg-builds test injects state via `docker exec node -e`
     (better-sqlite3), which the Go image cannot serve — that helper must be made
     image-agnostic (e.g. offline volume edit via a one-off container). **Assertions are never
     modified.**
- **Discipline: parity first, divergence after.** M4's gate is the full suite green, full stop —
  every failure is a porting bug. Known TS gaps go to the backlog (§11), none land early.

## 8. Milestones

Each = one plan (workshop), executed via SDD in worktreedb with two gates per task.

- **M1 · Kernel boots.** Bootstrap (go.mod, AGENTS/CLAUDE, golangci-lint, CI skeleton,
  Dockerfile FROM engine digest, .gitignore) → config → store (schema v1) → owner framework →
  engine supervisor + guard → `/api/status`. **Accept:** container boots healthy on a fresh
  volume; refuses a foreign-major volume; unit + boot integration green.
- **M2 · Branching core.** Project/branch owners, compute lifecycle (spec-gen/SCRAM/pgconf,
  ephemeral binds), proxy slots + splice (bind-on-running), timetravel as operations,
  logs/events SSE, REST for those resources. **Accept:** the TS suite's core files (everything
  except the pg-builds and MCP files) green via the cross-run.
- **M3 · Builds + MCP.** OCI client (hardened extraction semantics as contract), builds owner
  (gate → activate policy → boot adoption), pg-builds REST; MCP server + guard + tools + skills.
  **Accept:** pg-builds + MCP suite files green.
- **M4 · UI + packaging + parity gate.** Web copy/rename/embed, compose/README, image polish.
  **Accept: full TS suite green, unmodified assertions.** Dogfood cutover to `:4400`.
- **M5 · Suspend + wake** (first post-parity; suspend and wake ship together — suspend without
  wake dead-ends connstrings): idle sweeper (zero conns for N minutes; default 5, configurable,
  0 = never), wake-on-accept,
  `suspended` status surfacing (additive API), docs. Includes the **explicit amendment** of the
  2026-07-02 product spec's "no auto-suspend in v1" non-goal — recorded, not silently
  contradicted.

## 9. Process & stack (worktreedb repo)

- SDD with two gates per task (independent reviewer + review-broker; broker dedup doc lives
  workshop-side). Conventional commits, **no AI trailers** (D4) — threaded into every
  implementer/fix dispatch. Never implement on the repo's main directly (worktrees, as here).
- Supply chain: stdlib-first; Go sumdb verification (default) + pinned go.mod; every new
  dependency is an explicit decision. Pinned stack: stdlib `net/http` mux, `modernc.org/sqlite`
  (CGO off), `log/slog`, `jackc/pgx/v5`, official MCP go-sdk, hand-rolled OCI client,
  `testcontainers-go`, `golangci-lint`.
- Oracle rule carries over: engine interactions grounded in official `neondatabase/neon`
  (`// oracle:` citations); product/orchestration/schema choices are Worktree DB's own.

## 10. Cross-repo contract

- worktreedb's Dockerfile pins `worktreedb-neon-engine@<digest>`; bumps are deliberate,
  following a devdb-pipeline republish (devdb's check-manifest cross-checks its own copy).
- CI: grant the worktreedb repo Actions read access on the 5 GHCR packages so `GITHUB_TOKEN`
  pulls the engine base — no PAT in CI. Local builds use Jordan's existing `docker login`.
- The TS-suite parameterization (env prefix, image name, image-agnostic state-injection helper)
  is a devdb-repo change and stays there.

## 11. Post-parity backlog (written, none before the gate)

M5 (suspend+wake) first, then: `starting` in the status DTO union; engine auto-restart with
backoff (supervisor policy flip); resume-interrupted-pulls (operation policy flip); dual-stack
listeners (needs compose publish change too — kills the localhost-vs-127.0.0.1 papercut);
engine-image base slimming (devdb pipeline); the parked Octopus-style UI restyle; phase 4
(import/export + durability — now on the operations-log foundation) and phase 5.

## 12. Non-goals

- No TS-volume migration (D3). No auto-suspend before M5 (D8). No engine build changes in the
  new repo (pipeline stays in devdb). No UI redesign during the rewrite. No public release of
  the GHCR packages or the worktreedb repo — that remains gated on Jordan's license review.
