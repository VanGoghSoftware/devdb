# Worktree DB M2 — Branching Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the branching core of the Go daemon: engine HTTP clients, project + per-branch owners over the spec/status schema, the compute lifecycle (SCRAM/pgconf/ComputeSpec, compute_ctl with group-kill, `/metrics` readiness), the daemon-owned L4 proxy (slots + splice, bind-on-running), timetravel restore/reset as durable operations (plan fingerprint lands here), logs + events SSE, and the byte-parity REST surface for all of it — so the reference integration suite's core files run green against `worktreedb:dev`.

**Architecture:** API handlers write **spec** (and bump `spec_generation`); one goroutine per branch (a `runtime.Owner`) converges observed state toward spec and is the ONLY writer of `status_*` (generation-checked commits abandon stale observations — the structural fix for stop-during-start clobbers). Multi-step work (restore/reset) runs as durable rows in `operations` with a persisted plan fingerprint. The daemon permanently owns the published port range as proxy **slots**; computes bind ephemeral loopback ports; a goroutine-per-connection L4 splice joins them, listener bound only while the endpoint is logically running (stopped ⇒ ECONNREFUSED). Master spec: `docs/superpowers/specs/2026-07-11-worktreedb-go-rewrite-design.md` (§5–§7, §8-M2). M1 carry-overs folded in: computes run `Detached: true`; sentinel operation errors; plan-fingerprint decision (due now); CatalogDB proc-contract fix (P4-3); pre-boot signal handling (P4-4).

**Tech Stack:** Go 1.25 stdlib (`net/http` mux, `crypto/pbkdf2`, `crypto/hmac`, `crypto/sha256`), `modernc.org/sqlite`, `log/slog`, **`github.com/jackc/pgx/v5`** (new in this milestone — pre-approved by master spec §9; its `pgconn` subpackage serves the SQL-console path), `testcontainers-go` (integration only), `golangci-lint`.

## Global Constraints

- **Repo split:** all product code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`); implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` (never directly on its `main`). Task 16 is the ONE devdb-repo task (`~/git/devdb`). This plan and the ledger stay in devdb (workshop) — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers of any kind** (spec D4) — this overrides any harness default. The devdb-repo commit in Task 16 keeps devdb's usual trailer policy.
- **Clean-history rule (spec §3):** worktreedb code, comments, tests, commit messages, and docs NEVER mention the TypeScript implementation, the devdb repo, `matisiekpl/neond`, Fastify, Node, or "parity with the old daemon". The system is presented on its own terms. `// oracle: neon <path-or-endpoint>` citations to official `neondatabase/neon` are REQUIRED at every engine wire fact (payload shapes, endpoints, CLI args, config keys); the oracle citations embedded in this plan's code blocks are pre-verified — transcribe them verbatim. Reference clone: `~/git/neon @ 8f60b04`. Do not invent payloads.
- **Dependency policy:** stdlib first. Exactly ONE new module in M2: `github.com/jackc/pgx/v5` (Task 12; only its `pgconn` subpackage is imported). Pin = the committed `go.mod` line + `go.sum` (Go sumdb verifies); `go get` only, **no `go mod tidy`** (repo posture per the M1 review: markers are hand-maintained; tidy only when a dep change forces it — `go get` alone suffices here). Anything else needs an explicit recorded decision.
- **State-model rules (binding on every task):** desired state = `spec_*` columns, written only by the service layer on behalf of API calls, every write bumps `spec_generation`; observed state = `status_*`, written only through `store.CommitStatus` from the branch's owner goroutine (or a job holding that owner's lane); `store.ErrStaleGeneration` ⇒ abandon and re-converge. Multi-step work goes through the `operations` log. Never write status from a request handler.
- **Concurrency rules:** every mutation of a branch runs inside that branch's owner (via `Owner.Do` for spec convergence or `Owner.Run` for jobs); branch **create** runs inside the PARENT's owner. `Process.OnStateChange`/`Supervisor.onComponent` callbacks run under the Process mutex — they may only do non-blocking work (`Owner.Nudge`, a bus publish) and must never call back into Process/Supervisor.

### Parity contracts owned by this milestone (byte-exact; the reference suite asserts these)

**Connection strings** (host is the IPv4 literal — `localhost` resolves to ::1 on IPv6-preferring hosts while ports publish on 127.0.0.1 only; passwords are 32 alphanumerics so no escaping is ever needed):

```
postgresql://postgres:<password>@127.0.0.1:<port>/postgres
jdbc:postgresql://127.0.0.1:<port>/postgres?user=postgres&password=<password>&sslmode=disable
```

**Wire DTOs** (JSON field names exactly; absent = omitted key, empty = `null`):
- Project: `id, name, pgVersion, createdAt, updatedAt`
- Branch: `id, projectId, parentBranchId, name, slug, timelineId, endpointStatus, endpointError, port, connectionString, jdbcUrl, lastRecordLsn, logicalSizeBytes, createdBy, context, ancestorLsn, createdAt, updatedAt, runningPgVersion` — and NEVER: `password`, `stickyPort`/`portSlot`, `importStatus`, `importError` (redaction is asserted live).
- `POST /api/projects` → 201 `{"project": <ProjectDto>, "mainBranch": <BranchDto>}`; `POST .../branches` → 201 BranchDto; deletes → 204 empty; `GET /api/branches/:id/endpoint` → `{"status": "...", "port": <int|null>}`; `POST /api/sql` → `{"rows":[...],"rowCount":N,"fields":[...],"truncated":false}`.
- `/api/status`: `version, healthy, engine{<name>:{state,pid}}, portRange{min,max}, storage:"none", pgBuilds:{}` (pgBuilds stays `{}` until the builds milestone).
- Endpoint status union: `stopped | starting | running | stopping | failed`.
- Error envelope: `{"error": "<message>"}` with the right status; body-validation failures: 400 `{"error":"invalid request body","issues":["<field>: <why>", ...]}`.

**Daemon-authored strings** (exact copies; `%s`/`%d` shown where dynamic):
- 409 `project "%s" already exists — choose a different name, or use the existing project (call list_projects to see it)`
- 400 `invalid project name: %q — names must start with a letter or digit and contain only letters, digits, spaces, underscores, or hyphens (max 63 characters)`
- 400 `Postgres %d is not installed — installed majors: %s. Pull it via POST /api/pg-builds/pull.`
- 404 `project %s not found` · 404 `branch %s not found`
- 400 `invalid branch name: %q` · 409 `branch "%s" already exists in project "%s"` · 409 `branch "%s" already exists in this project`
- 400 `parentBranchId cannot be null — root branches only exist via project create` · 400 `parent branch belongs to a different project` · 409 `parent branch "%s" was deleted while creating "%s"`
- 409 `branch "%s" has child branches: %s — delete them first`
- 400 `the root branch cannot be renamed — agent skills and workflows reference it by name`
- 409 `no free endpoint port in range — running endpoints: %s. Stop one or widen WORKTREEDB_PORT_RANGE.` (entries are `projectName/branchName`, comma+space joined)
- 400 `timestamp query parameter required` · 400 `timestamp must include an explicit timezone (Z or ±HH:MM)` · 400 `invalid timestamp: %s`
- 400 `cannot resolve %s on "%s": %s (kind=%s)` where the reason is `that timestamp is ahead of this branch's history` (kind=future) or `that timestamp is before this branch's retained history` (any other non-present kind)
- 400 `target point not available on this branch: %s` (first 300 bytes of the engine body)
- 409 `endpoint is mid-transition — retry when it settles`
- 400 `branch "%s" has no parent — reset needs a parent to reset to. Reset a child branch instead, or use restore_branch to go to a past point on "%s".`
- 400 `empty query` · 502 `endpoint for "%s" is not running`
- 404 `unknown daemon component: %q`
- SSE frames: `data: <payload>\n\n`; headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, then an immediate flush. Logs channels replay last 200 lines each JSON-string-encoded (`data: "a line"`); `/api/events` has NO replay and streams event objects (`data: {"type":"branch.created","projectId":"…","branchId":"…","at":"…"}`) — `projectId`/`branchId` omitted when absent, `at` server-stamped ISO-8601 UTC with milliseconds.
- Event types this milestone emits: `project.created` (project create — main branch does NOT also get `branch.created`), `project.deleted`, `branch.created`, `branch.updated` (rename AND restore/reset swap), `branch.deleted`, `endpoint.status` (every persisted endpoint transition), `engine.health` (engine component state change).
- Unknown `/api/*` route: 404 JSON `{"message":"Route <METHOD>:<path> not found","error":"Not Found","statusCode":404}`.
- Archive identity on in-place restore/reset: old row renamed `<name>_<tag>_archived_<stamp>` (tag `pitr` | `reset`; stamp = ISO-8601 ms UTC with `:` and `.` replaced by `-`), slug `<slugify(oldSlug)>-<tag>-<first 6 of new timeline id>`; the replacement row keeps the original name/slug/password/port-slot/parent and the restored branch named `main` must still be named `main`.

**Engine ports (loopback-only, from M1 config — never re-derive):** broker 50051, storcon 1234, storcon_db 5431, pageserver http 9898, pageserver pg 64000, safekeeper pg 5454, safekeeper http 7676, tracer 4318. Published range default `54300-54339` (`WORKTREEDB_PORT_RANGE`).

**Machine quirks / tribal facts:**
- docker + `docker-credential-desktop` live at `/Applications/Docker.app/Contents/Resources/bin` — put on PATH for image builds AND testcontainers runs (`export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"`). Engine binaries in-image at `/usr/local/share/neon` (bin + pg_install).
- compute_ctl readiness: `/metrics` (the `--external-http-port`) is auth-free and carries `compute_ctl_up{status="…"}`; `/status` demands a JWT even with `--dev` (permanent 400 against an empty jwks) — do NOT use it; the log needle `listening on IPv4 address` fires ~80–140 ms before apply_spec commits the SCRAM verifier, so the needle alone is only the process-start gate and `/metrics` polling is the readiness gate.
- compute_ctl orphans its postgres child on SIGTERM instead of waiting for it — computes MUST run `Detached: true` so `engine.Process.Stop` group-kills the whole tree (M1 carry-over; the M1 engine children stay non-detached).
- The compute-SIGTERM-mid-query 57P01 flake is handled TEST-side in the reference suite (withConnection reconnect+retry) — the Go daemon needs no accommodation.
- The reference suite runs sequentially (`fileParallelism: false`); machine load is suite-level — re-run an isolated file before treating a red as real.

## File map (M2 end state, worktreedb repo — new/modified only)

```
internal/store/schema.go        MODIFY: schema v2 columns (branch identity, plan_fingerprint)
internal/store/store.go         MODIFY: versioned migration, SetSpecEndpoint, spec helpers
internal/store/rows.go          CREATE: ProjectRow/BranchRow structs + CRUD + RestoreSwap + boot reset
internal/store/operations.go    MODIFY: plan_fingerprint column, sentinel errors
internal/store/store_test.go    MODIFY: + rows/migration/sentinel tests
internal/runtime/owner.go       MODIFY: Owner.Run (serialized jobs through the inbox)
internal/runtime/operation.go   MODIFY: PlanFingerprint + verification in RunOperation
internal/runtime/runtime_test.go MODIFY
internal/engine/clients.go      CREATE: storcon/pageserver/safekeeper HTTP clients + APIError
internal/engine/clients_test.go CREATE
internal/events/bus.go          CREATE: state-change event bus (no replay)
internal/events/loghub.go       CREATE: per-channel log rings + live subscribers
internal/events/events_test.go  CREATE
internal/compute/secrets.go     CREATE: password gen + SCRAM-SHA-256 verifier
internal/compute/pgconf.go      CREATE: postgresql.conf + pg_hba.conf generation
internal/compute/spec.go        CREATE: ComputeSpec config.json generation
internal/compute/pgbin.go       CREATE: baked PostgreSQL install resolution
internal/compute/readiness.go   CREATE: /metrics poller (compute_ctl_up)
internal/compute/manager.go     CREATE: compute lifecycle (launch/ready/stop, Detached)
internal/compute/*_test.go      CREATE
internal/proxy/proxy.go         CREATE: slot table + bind-on-running L4 splice + conn counts
internal/proxy/proxy_test.go    CREATE
internal/service/core.go        CREATE: Core deps + narrow engine/compute/proxy interfaces
internal/service/errors.go      CREATE: HTTP-mappable service error
internal/service/slug.go        CREATE: slugify
internal/service/registry.go    CREATE: per-branch owner registry (create/destroy with branch)
internal/service/endpoints.go   CREATE: endpoint converge + start/stop/detail
internal/service/projects.go    CREATE: project create/list/get/delete
internal/service/branches.go    CREATE: branch create/list/rename/delete
internal/service/timetravel.go  CREATE: lsn resolve + restore/reset as durable operations
internal/service/sql.go         CREATE: SQL console over pgconn
internal/service/*_test.go      CREATE
internal/api/server.go          MODIFY: full REST surface + error envelope
internal/api/dto.go             CREATE: wire DTO structs + mappers (redaction by construction)
internal/api/sse.go             CREATE: SSE writer (replay + live, backpressure-drop)
internal/api/*_test.go          MODIFY/CREATE
cmd/worktreedbd/main.go         MODIFY: boot order, reconciliation, wiring, shutdown (P4-3/P4-4)
integration/branching_test.go   CREATE: //go:build integration — container-level branching core
AGENTS.md                       MODIFY: dependency allowlist + pgx entry (Task 12)
go.mod / go.sum                 MODIFY: + jackc/pgx/v5 (Task 12)

devdb repo (Task 16 only):
tests/integration/helpers/container.ts   MODIFY: env-prefix + image parameterization
tests/integration/endpoints.test.ts      MODIFY: prefix-derived env key + assertion
docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md  CREATE: gate files + invocation
```

**Task dependency order:** 1 → 2 → {3, 4, 5} → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16. Tasks 3/4/5 are independent of each other.

---

### Task 1: store — schema v2, branch/project rows, boot reset

The M1 schema ships spec/status/generations but lacks the branch identity columns this milestone's wire surface needs (`password`, `created_by`, `context`, `updated_at`) and the operations `plan_fingerprint`. Add them via a versioned, additive migration (fresh volumes get the full v2 DDL; a v1 volume gets `ALTER TABLE`s — M1 volumes have zero branch rows, so the defaults are never observable). Then add the typed row layer every service task builds on.

**Files:**
- Modify: `~/git/worktreedb/internal/store/schema.go`
- Modify: `~/git/worktreedb/internal/store/store.go`
- Create: `~/git/worktreedb/internal/store/rows.go`
- Modify: `~/git/worktreedb/internal/store/store_test.go`

**Interfaces:**
- Consumes: M1 `store.Store` (`Open`, `WithTx`, `CommitStatus`, `SpecGen`, `BumpSpecGen`, `NewID`, `NowISO`, `ErrStaleGeneration`).
- Produces (later tasks rely on these exact names):
  - `type ProjectRow struct { ID, Name string; PgMajor int; TenantID, CreatedAt string }`
  - `type BranchRow struct { ID, ProjectID, Name, Slug string; ParentBranchID *string; TimelineID string; ForkLSN *string; Password, CreatedBy string; ContextJSON *string; CreatedAt, UpdatedAt string; SpecEndpoint string; SpecGen int64; PortSlot *int; StatusEndpoint string; StatusPort *int; StatusPgbin, StatusError *string; ObservedGen int64 }`
  - `func (s *Store) CreateProject(ctx, p ProjectParams) (ProjectRow, error)` with `ProjectParams{ID, Name string; PgMajor int}`
  - `func (s *Store) ProjectByID(ctx, id) (ProjectRow, bool, error)` · `ProjectByName(ctx, name)` · `Projects(ctx) ([]ProjectRow, error)` · `DeleteProject(ctx, id) error`
  - `func (s *Store) CreateBranch(ctx, p BranchParams) (BranchRow, error)` with `BranchParams{ID, ProjectID string; ParentBranchID *string; Name, Slug, TimelineID string; ForkLSN *string; Password, CreatedBy string; ContextJSON *string}`
  - `func (s *Store) BranchByID(ctx, id) (BranchRow, bool, error)` · `BranchByProjectAndName(ctx, projectID, name)` · `BranchesByProject(ctx, projectID) ([]BranchRow, error)` · `BranchesByParent(ctx, parentID) ([]BranchRow, error)` · `RenameBranch(ctx, id, name) error` · `DeleteBranch(ctx, id) error`
  - `func (s *Store) RestoreSwap(ctx, p RestoreSwapParams) (BranchRow, error)` with `RestoreSwapParams{OldBranchID, NewBranchID, NewTimelineID, ArchiveName, ArchiveSlug string; ReparentedTimelineIDs []string}`
  - `func (s *Store) ResetEndpointsOnBoot(ctx) (int64, error)`
  - `func SetSpecEndpoint(tx *sql.Tx, id, spec string) error` (package-level, like `SpecGen`)
  - `type EndpointStatusUpdate struct { Endpoint string; Port *int; Pgbin *string; Error *string; PortSlot *int }` and `func ApplyEndpointStatus(tx *sql.Tx, id string, u EndpointStatusUpdate) error`

- [ ] **Step 1: Write the failing tests** — append to `internal/store/store_test.go`:

```go
func TestSchemaV2MigratesAV1Volume(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.db")
	// Simulate an M1 volume: raw v1 DDL (no password/created_by/context/updated_at on
	// branches, no plan_fingerprint on operations) + schema_version '1'.
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	v1 := `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, pg_major INTEGER NOT NULL,
  tenant_id TEXT NOT NULL, created_at TEXT NOT NULL,
  spec_generation INTEGER NOT NULL DEFAULT 1, status_phase TEXT NOT NULL DEFAULT 'pending',
  status_message TEXT, observed_generation INTEGER NOT NULL DEFAULT 0, status_updated_at TEXT
) STRICT;
CREATE TABLE branches (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, slug TEXT NOT NULL, parent_branch_id TEXT REFERENCES branches(id),
  timeline_id TEXT NOT NULL, fork_lsn TEXT, created_at TEXT NOT NULL,
  spec_endpoint TEXT NOT NULL DEFAULT 'stopped', spec_generation INTEGER NOT NULL DEFAULT 1,
  port_slot INTEGER, status_endpoint TEXT NOT NULL DEFAULT 'stopped', status_port INTEGER,
  status_pgbin TEXT, status_error TEXT, observed_generation INTEGER NOT NULL DEFAULT 0,
  status_updated_at TEXT, UNIQUE (project_id, slug)
) STRICT;
CREATE TABLE operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT, params TEXT NOT NULL DEFAULT '{}',
  step_cursor INTEGER NOT NULL DEFAULT 0 CHECK (step_cursor >= 0),
  phase TEXT NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending','running','done','failed')),
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
`
	if _, err := db.Exec(v1); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open on a v1 volume: %v", err)
	}
	defer s.Close()
	v, ok, err := s.GetMeta(context.Background(), "schema_version")
	if err != nil || !ok || v != "2" {
		t.Fatalf("schema_version after migration = %q, %v, %v; want \"2\"", v, ok, err)
	}
	// The migrated table must accept a full v2 insert.
	if _, err := s.CreateProject(context.Background(), ProjectParams{ID: "p1", Name: "acme", PgMajor: 17}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBranch(context.Background(), BranchParams{
		ID: "b1", ProjectID: "p1", Name: "main", Slug: "acme-main-abc123",
		TimelineID: "t1", Password: "pw", CreatedBy: "api",
	}); err != nil {
		t.Fatalf("CreateBranch on migrated volume: %v", err)
	}
}

func TestProjectAndBranchRowsRoundTrip(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, ProjectParams{ID: "p1", Name: "acme", PgMajor: 16})
	if err != nil {
		t.Fatal(err)
	}
	if p.TenantID != "p1" || p.PgMajor != 16 || p.CreatedAt == "" {
		t.Fatalf("project row: %+v", p)
	}
	if _, err := s.CreateProject(ctx, ProjectParams{ID: "p2", Name: "acme", PgMajor: 16}); err == nil {
		t.Fatal("duplicate project name must violate UNIQUE")
	}
	ctxJSON := `{"agent":"claude"}`
	b, err := s.CreateBranch(ctx, BranchParams{
		ID: "b1", ProjectID: "p1", Name: "main", Slug: "acme-main-abc123",
		TimelineID: "t1", Password: "secret", CreatedBy: "api", ContextJSON: &ctxJSON,
	})
	if err != nil {
		t.Fatal(err)
	}
	if b.SpecEndpoint != "stopped" || b.StatusEndpoint != "stopped" || b.SpecGen != 1 || b.ObservedGen != 0 {
		t.Fatalf("fresh branch defaults: %+v", b)
	}
	if b.UpdatedAt == "" || b.Password != "secret" || b.ContextJSON == nil || *b.ContextJSON != ctxJSON {
		t.Fatalf("identity columns: %+v", b)
	}
	got, ok, err := s.BranchByProjectAndName(ctx, "p1", "main")
	if err != nil || !ok || got.ID != "b1" {
		t.Fatalf("BranchByProjectAndName: %+v %v %v", got, ok, err)
	}
	child, err := s.CreateBranch(ctx, BranchParams{
		ID: "b2", ProjectID: "p1", ParentBranchID: &b.ID, Name: "dev", Slug: "acme-dev-def456",
		TimelineID: "t2", Password: "pw2", CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	kids, err := s.BranchesByParent(ctx, "b1")
	if err != nil || len(kids) != 1 || kids[0].ID != "b2" {
		t.Fatalf("BranchesByParent: %+v %v", kids, err)
	}
	if err := s.RenameBranch(ctx, child.ID, "dev-renamed"); err != nil {
		t.Fatal(err)
	}
	got2, _, _ := s.BranchByID(ctx, child.ID)
	if got2.Name != "dev-renamed" || got2.Slug != "acme-dev-def456" || got2.UpdatedAt == "" {
		t.Fatalf("rename must change name only: %+v", got2)
	}
	if err := s.DeleteBranch(ctx, "b1"); err == nil {
		t.Fatal("deleting a branch with children must violate the FK")
	}
	if err := s.DeleteBranch(ctx, "b2"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteBranch(ctx, "b1"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProject(ctx, "p1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ProjectByID(ctx, "p1"); ok {
		t.Fatal("project must be gone")
	}
}

func TestEndpointStatusApplyAndSpecHelpers(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustProjectAndBranch(t, s, "p1", "b1")
	var gen int64
	if err := s.WithTx(ctx, func(tx *sql.Tx) error {
		if err := SetSpecEndpoint(tx, "b1", "running"); err != nil {
			return err
		}
		var err error
		gen, err = BumpSpecGen(tx, "branches", "b1")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if gen != 2 {
		t.Fatalf("gen = %d, want 2", gen)
	}
	port, slot := 54300, 54300
	pgbin := "/usr/local/share/neon/pg_install/v17/bin"
	if err := s.CommitStatus(ctx, "branches", "b1", gen, func(tx *sql.Tx) error {
		return ApplyEndpointStatus(tx, "b1", EndpointStatusUpdate{
			Endpoint: "running", Port: &port, Pgbin: &pgbin, PortSlot: &slot,
		})
	}); err != nil {
		t.Fatal(err)
	}
	b, _, _ := s.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "running" || b.StatusPort == nil || *b.StatusPort != 54300 ||
		b.PortSlot == nil || *b.PortSlot != 54300 || b.ObservedGen != gen {
		t.Fatalf("after commit: %+v", b)
	}
	// A nil PortSlot leaves the sticky assignment untouched; nil Port/Error clear.
	if err := s.CommitStatus(ctx, "branches", "b1", gen, func(tx *sql.Tx) error {
		return ApplyEndpointStatus(tx, "b1", EndpointStatusUpdate{Endpoint: "stopped"})
	}); err != nil {
		t.Fatal(err)
	}
	b, _, _ = s.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "stopped" || b.StatusPort != nil || b.PortSlot == nil || *b.PortSlot != 54300 {
		t.Fatalf("stop must clear port but keep the sticky slot: %+v", b)
	}
}

func TestResetEndpointsOnBoot(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mustProjectAndBranch(t, s, "p1", "b1")
	var gen int64
	_ = s.WithTx(ctx, func(tx *sql.Tx) error {
		_ = SetSpecEndpoint(tx, "b1", "running")
		gen, _ = BumpSpecGen(tx, "branches", "b1")
		return nil
	})
	failMsg := "boom"
	if err := s.CommitStatus(ctx, "branches", "b1", gen, func(tx *sql.Tx) error {
		return ApplyEndpointStatus(tx, "b1", EndpointStatusUpdate{Endpoint: "running", Error: &failMsg})
	}); err != nil {
		t.Fatal(err)
	}
	n, err := s.ResetEndpointsOnBoot(ctx)
	if err != nil || n != 1 {
		t.Fatalf("reset: n=%d err=%v", n, err)
	}
	b, _, _ := s.BranchByID(ctx, "b1")
	if b.SpecEndpoint != "stopped" || b.StatusEndpoint != "stopped" || b.StatusPort != nil {
		t.Fatalf("boot reset: %+v", b)
	}
	if b.ObservedGen != b.SpecGen {
		t.Fatalf("boot reset must stamp observed=spec: %+v", b)
	}
	if b.StatusError == nil || *b.StatusError != "boom" {
		t.Fatal("boot reset must PRESERVE the diagnostic status_error")
	}
}

func TestRestoreSwapArchivesAndReparents(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.CreateProject(ctx, ProjectParams{ID: "p1", Name: "acme", PgMajor: 17}); err != nil {
		t.Fatal(err)
	}
	slot := 54301
	old, err := s.CreateBranch(ctx, BranchParams{
		ID: "old", ProjectID: "p1", Name: "main", Slug: "acme-main-aaaaaa",
		TimelineID: "tl-old", Password: "pw", CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WithTx(ctx, func(tx *sql.Tx) error {
		return ApplyEndpointStatus(tx, "old", EndpointStatusUpdate{Endpoint: "stopped", PortSlot: &slot})
	}); err != nil {
		t.Fatal(err)
	}
	// two children: one whose timeline the engine reparented, one left on the old row
	for _, c := range []struct{ id, tl string }{{"c1", "tl-c1"}, {"c2", "tl-c2"}} {
		if _, err := s.CreateBranch(ctx, BranchParams{
			ID: c.id, ProjectID: "p1", ParentBranchID: &old.ID, Name: c.id, Slug: "acme-" + c.id + "-bbbbbb",
			TimelineID: c.tl, Password: "pw", CreatedBy: "api",
		}); err != nil {
			t.Fatal(err)
		}
	}
	swapped, err := s.RestoreSwap(ctx, RestoreSwapParams{
		OldBranchID: "old", NewBranchID: "new", NewTimelineID: "tl-new",
		ArchiveName: "main_pitr_archived_2026-07-11T09-00-00-000Z", ArchiveSlug: "acme-main-aaaaaa-pitr-tl-new",
		ReparentedTimelineIDs: []string{"tl-c1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if swapped.ID != "new" || swapped.Name != "main" || swapped.Slug != "acme-main-aaaaaa" ||
		swapped.TimelineID != "tl-new" || swapped.Password != "pw" ||
		swapped.PortSlot == nil || *swapped.PortSlot != 54301 || swapped.SpecEndpoint != "stopped" {
		t.Fatalf("swapped row: %+v", swapped)
	}
	archived, _, _ := s.BranchByID(ctx, "old")
	if archived.Name != "main_pitr_archived_2026-07-11T09-00-00-000Z" || archived.PortSlot != nil {
		t.Fatalf("archived row: %+v", archived)
	}
	c1, _, _ := s.BranchByID(ctx, "c1")
	c2, _, _ := s.BranchByID(ctx, "c2")
	if c1.ParentBranchID == nil || *c1.ParentBranchID != "new" || c2.ParentBranchID == nil || *c2.ParentBranchID != "new" {
		t.Fatalf("children must point at the new identity: c1=%+v c2=%+v", c1, c2)
	}
}
```

Add the two shared helpers once (top of the test file, near the existing helpers):

```go
func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func mustProjectAndBranch(t *testing.T, s *Store, projectID, branchID string) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.CreateProject(ctx, ProjectParams{ID: projectID, Name: "proj-" + projectID, PgMajor: 17}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBranch(ctx, BranchParams{
		ID: branchID, ProjectID: projectID, Name: "main", Slug: "proj-main-" + branchID,
		TimelineID: "tl-" + branchID, Password: "pw", CreatedBy: "api",
	}); err != nil {
		t.Fatal(err)
	}
}
```

If `openTestStore`/`mustProjectAndBranch` collide with existing helper names in the file, reuse the existing ones instead of duplicating.

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -run 'TestSchemaV2|TestProjectAndBranchRows|TestEndpointStatusApply|TestResetEndpoints|TestRestoreSwap' 2>&1 | tail -20`
Expected: compile errors (`undefined: ProjectParams`, `undefined: SetSpecEndpoint`, …). Capture the output in the task report.

- [ ] **Step 3: Extend the schema** — in `internal/store/schema.go`, rename the const to `schemaDDL` (update the one reference in `store.go`) and change exactly two tables. `branches` gains four columns after `created_at`:

```sql
  password            TEXT NOT NULL DEFAULT '',
  created_by          TEXT NOT NULL DEFAULT 'api',
  context             TEXT,
  updated_at          TEXT,
```

`operations` gains one column after `error`:

```sql
  plan_fingerprint TEXT NOT NULL DEFAULT '',
```

Update the header comment: "Schema v2. v1 volumes are migrated additively in store.Open (see migrate)."

- [ ] **Step 4: Add the versioned migration** — in `internal/store/store.go`, replace `stampMetaDefaults` with a `migrate` step. `Open` becomes:

```go
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer by construction (see the comment above)
	if _, err := db.Exec(schemaDDL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

const schemaVersion = "2"

// migrate stamps a fresh database at the current schema version and upgrades
// older volumes additively. schemaDDL is CREATE TABLE IF NOT EXISTS, so on an
// existing volume it never alters a table — version-gated ALTERs here do.
func (s *Store) migrate() error {
	ctx := context.Background()
	v, ok, err := s.GetMeta(ctx, "schema_version")
	if err != nil {
		return err
	}
	switch {
	case !ok: // fresh database: schemaDDL just created the full v2 shape
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, schemaVersion); err != nil {
			return err
		}
	case v == "1":
		for _, stmt := range []string{
			`ALTER TABLE branches ADD COLUMN password TEXT NOT NULL DEFAULT ''`,
			`ALTER TABLE branches ADD COLUMN created_by TEXT NOT NULL DEFAULT 'api'`,
			`ALTER TABLE branches ADD COLUMN context TEXT`,
			`ALTER TABLE branches ADD COLUMN updated_at TEXT`,
			`ALTER TABLE operations ADD COLUMN plan_fingerprint TEXT NOT NULL DEFAULT ''`,
		} {
			if _, err := s.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("migrate v1→v2: %w", err)
			}
		}
		if err := s.SetMeta(ctx, "schema_version", schemaVersion); err != nil {
			return err
		}
	case v == schemaVersion:
		// current
	default:
		return fmt.Errorf("data volume has schema_version %s, newer than this daemon understands (%s)", v, schemaVersion)
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES ('instance_id', ?) ON CONFLICT(key) DO NOTHING`, NewID()); err != nil {
		return err
	}
	return nil
}
```

Also add the two spec/status helpers at the bottom of `store.go`:

```go
// SetSpecEndpoint writes the branch's DESIRED endpoint state. Callers must
// bump the spec generation in the same transaction (BumpSpecGen) — the pair
// is what owners converge against.
func SetSpecEndpoint(tx *sql.Tx, id, spec string) error {
	if spec != "running" && spec != "stopped" {
		return fmt.Errorf("invalid spec_endpoint %q", spec)
	}
	_, err := tx.Exec(`UPDATE branches SET spec_endpoint = ? WHERE id = ?`, spec, id)
	return err
}

// EndpointStatusUpdate is one observed-state write. Port/Pgbin/Error nil
// CLEAR their columns; PortSlot nil leaves the sticky slot untouched (it is
// an assignment, not a per-transition observation).
type EndpointStatusUpdate struct {
	Endpoint string
	Port     *int
	Pgbin    *string
	Error    *string
	PortSlot *int
}

func ApplyEndpointStatus(tx *sql.Tx, id string, u EndpointStatusUpdate) error {
	_, err := tx.Exec(
		`UPDATE branches SET status_endpoint = ?, status_port = ?, status_pgbin = ?, status_error = ?,
		        port_slot = COALESCE(?, port_slot)
		  WHERE id = ?`,
		u.Endpoint, u.Port, u.Pgbin, u.Error, u.PortSlot, id)
	return err
}
```

- [ ] **Step 5: Write `internal/store/rows.go`** (complete file):

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ProjectRow is a project's full persisted state. TenantID always equals ID —
// one project is one storage-engine tenant by this daemon's own modeling
// choice; the column exists so the identity is explicit at the storage layer.
type ProjectRow struct {
	ID       string
	Name     string
	PgMajor  int
	TenantID string
	CreatedAt string
}

type ProjectParams struct {
	ID      string
	Name    string
	PgMajor int
}

func (s *Store) CreateProject(ctx context.Context, p ProjectParams) (ProjectRow, error) {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO projects (id, name, pg_major, tenant_id, created_at) VALUES (?,?,?,?,?)`,
		p.ID, p.Name, p.PgMajor, p.ID, NowISO())
	if err != nil {
		return ProjectRow{}, err
	}
	row, _, err := s.ProjectByID(ctx, p.ID)
	return row, err
}

func scanProject(r interface{ Scan(...any) error }) (ProjectRow, error) {
	var p ProjectRow
	err := r.Scan(&p.ID, &p.Name, &p.PgMajor, &p.TenantID, &p.CreatedAt)
	return p, err
}

const projectCols = `id, name, pg_major, tenant_id, created_at`

func (s *Store) ProjectByID(ctx context.Context, id string) (ProjectRow, bool, error) {
	p, err := scanProject(s.db.QueryRowContext(ctx,
		`SELECT `+projectCols+` FROM projects WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return ProjectRow{}, false, nil
	}
	return p, err == nil, err
}

func (s *Store) ProjectByName(ctx context.Context, name string) (ProjectRow, bool, error) {
	p, err := scanProject(s.db.QueryRowContext(ctx,
		`SELECT `+projectCols+` FROM projects WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return ProjectRow{}, false, nil
	}
	return p, err == nil, err
}

func (s *Store) Projects(ctx context.Context) ([]ProjectRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+projectCols+` FROM projects ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectRow
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeleteProject propagates a FOREIGN KEY violation when branches still
// reference the project — callers drain branches first (children before
// parents) and treat the violation as a retryable race, not a crash.
func (s *Store) DeleteProject(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	return err
}

// BranchRow is a branch's full persisted state: identity columns plus the
// spec/status pair the owner converges. ContextJSON carries the caller's
// fork-context object verbatim (already validated/normalized by the API
// layer); nil means none was supplied.
type BranchRow struct {
	ID             string
	ProjectID      string
	Name           string
	Slug           string
	ParentBranchID *string
	TimelineID     string
	ForkLSN        *string
	Password       string
	CreatedBy      string
	ContextJSON    *string
	CreatedAt      string
	UpdatedAt      string

	SpecEndpoint string
	SpecGen      int64
	PortSlot     *int

	StatusEndpoint string
	StatusPort     *int
	StatusPgbin    *string
	StatusError    *string
	ObservedGen    int64
}

type BranchParams struct {
	ID             string
	ProjectID      string
	ParentBranchID *string
	Name           string
	Slug           string
	TimelineID     string
	ForkLSN        *string
	Password       string
	CreatedBy      string
	ContextJSON    *string
}

func (s *Store) CreateBranch(ctx context.Context, p BranchParams) (BranchRow, error) {
	now := NowISO()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, fork_lsn,
		                       password, created_by, context, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.ID, p.ProjectID, p.ParentBranchID, p.Name, p.Slug, p.TimelineID, p.ForkLSN,
		p.Password, p.CreatedBy, p.ContextJSON, now, now)
	if err != nil {
		return BranchRow{}, err
	}
	row, _, err := s.BranchByID(ctx, p.ID)
	return row, err
}

const branchCols = `id, project_id, name, slug, parent_branch_id, timeline_id, fork_lsn,
	password, created_by, context, created_at, COALESCE(updated_at, created_at),
	spec_endpoint, spec_generation, port_slot,
	status_endpoint, status_port, status_pgbin, status_error, observed_generation`

func scanBranch(r interface{ Scan(...any) error }) (BranchRow, error) {
	var b BranchRow
	err := r.Scan(&b.ID, &b.ProjectID, &b.Name, &b.Slug, &b.ParentBranchID, &b.TimelineID, &b.ForkLSN,
		&b.Password, &b.CreatedBy, &b.ContextJSON, &b.CreatedAt, &b.UpdatedAt,
		&b.SpecEndpoint, &b.SpecGen, &b.PortSlot,
		&b.StatusEndpoint, &b.StatusPort, &b.StatusPgbin, &b.StatusError, &b.ObservedGen)
	return b, err
}

func (s *Store) BranchByID(ctx context.Context, id string) (BranchRow, bool, error) {
	b, err := scanBranch(s.db.QueryRowContext(ctx,
		`SELECT `+branchCols+` FROM branches WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return BranchRow{}, false, nil
	}
	return b, err == nil, err
}

func (s *Store) BranchByProjectAndName(ctx context.Context, projectID, name string) (BranchRow, bool, error) {
	b, err := scanBranch(s.db.QueryRowContext(ctx,
		`SELECT `+branchCols+` FROM branches WHERE project_id = ? AND name = ?`, projectID, name))
	if errors.Is(err, sql.ErrNoRows) {
		return BranchRow{}, false, nil
	}
	return b, err == nil, err
}

func (s *Store) BranchesByProject(ctx context.Context, projectID string) ([]BranchRow, error) {
	return s.branchQuery(ctx, `SELECT `+branchCols+` FROM branches WHERE project_id = ? ORDER BY created_at, id`, projectID)
}

func (s *Store) BranchesByParent(ctx context.Context, parentID string) ([]BranchRow, error) {
	return s.branchQuery(ctx, `SELECT `+branchCols+` FROM branches WHERE parent_branch_id = ?`, parentID)
}

func (s *Store) branchQuery(ctx context.Context, q string, args ...any) ([]BranchRow, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BranchRow
	for rows.Next() {
		b, err := scanBranch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// RenameBranch mutates NAME only — slug is immutable (it feeds compute naming
// and directories; a rename must never touch engine artifacts).
func (s *Store) RenameBranch(ctx context.Context, id, name string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE branches SET name = ?, updated_at = ? WHERE id = ?`, name, NowISO(), id)
	return err
}

func (s *Store) DeleteBranch(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM branches WHERE id = ?`, id)
	return err
}

// ResetEndpointsOnBoot forces every branch's desired AND observed endpoint
// state to "stopped" at daemon boot: any compute that was running died with
// the previous container, and endpoints deliberately do not auto-restart on
// boot. status_error is diagnostic HISTORY and is preserved. Stamping
// observed_generation = spec_generation marks the rows converged so owners
// don't churn at boot.
func (s *Store) ResetEndpointsOnBoot(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE branches SET spec_endpoint = 'stopped', status_endpoint = 'stopped',
		        status_port = NULL, status_pgbin = NULL,
		        observed_generation = spec_generation, status_updated_at = ?
		  WHERE spec_endpoint != 'stopped' OR status_endpoint != 'stopped'`, NowISO())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RestoreSwapParams: archive the old branch row under a new name/slug and
// insert a replacement carrying the ORIGINAL identity (name/slug/password/
// port_slot/parent/created_by/context) on a new timeline. Children whose
// timelines the engine reparented point at the new row; remaining children
// are repointed too (their timelines still descend through the new one).
// This is this daemon's own state-model choice, not an engine contract.
type RestoreSwapParams struct {
	OldBranchID           string
	NewBranchID           string
	NewTimelineID         string
	ArchiveName           string
	ArchiveSlug           string
	ReparentedTimelineIDs []string
}

func (s *Store) RestoreSwap(ctx context.Context, p RestoreSwapParams) (BranchRow, error) {
	err := s.WithTx(ctx, func(tx *sql.Tx) error {
		old, err := scanBranch(tx.QueryRow(`SELECT `+branchCols+` FROM branches WHERE id = ?`, p.OldBranchID))
		if err != nil {
			return fmt.Errorf("restore swap: old branch %s: %w", p.OldBranchID, err)
		}
		if _, err := tx.Exec(
			`UPDATE branches SET name = ?, slug = ?, port_slot = NULL WHERE id = ?`,
			p.ArchiveName, p.ArchiveSlug, p.OldBranchID); err != nil {
			return err
		}
		now := NowISO()
		if _, err := tx.Exec(
			`INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id,
			                       password, port_slot, created_by, context, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			p.NewBranchID, old.ProjectID, old.ParentBranchID, old.Name, old.Slug, p.NewTimelineID,
			old.Password, old.PortSlot, old.CreatedBy, old.ContextJSON, now, now); err != nil {
			return err
		}
		if len(p.ReparentedTimelineIDs) > 0 {
			q := `UPDATE branches SET parent_branch_id = ? WHERE project_id = ? AND timeline_id IN (?` +
				strings.Repeat(",?", len(p.ReparentedTimelineIDs)-1) + `)`
			args := []any{p.NewBranchID, old.ProjectID}
			for _, tl := range p.ReparentedTimelineIDs {
				args = append(args, tl)
			}
			if _, err := tx.Exec(q, args...); err != nil {
				return err
			}
		}
		_, err = tx.Exec(
			`UPDATE branches SET parent_branch_id = ? WHERE parent_branch_id = ? AND id != ?`,
			p.NewBranchID, p.OldBranchID, p.NewBranchID)
		return err
	})
	if err != nil {
		return BranchRow{}, err
	}
	row, _, err := s.BranchByID(ctx, p.NewBranchID)
	return row, err
}
```

Add `"strings"` to the imports.

- [ ] **Step 6: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -count=1 && go vet ./... && golangci-lint run`
Expected: all PASS, 0 lint issues (the whole existing store suite must stay green too).

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/store && git commit -m "feat(store): schema v2 branch identity columns, row layer, restore swap, boot reset"
```

---

### Task 2: runtime — Owner.Run lanes, operation sentinels, plan fingerprint

Three tightly-coupled hardening items whose due date is this milestone: (1) `Owner.Run` — arbitrary jobs serialized through the owner inbox (the lane primitive branch create/delete/rename/restore run through); (2) sentinel `ErrOperationNotActive` (M1 deferred-Minor 2 — lands with its first programmatic consumer, `RunOperation`'s finish handling and its tests); (3) the **plan fingerprint**: `CreateOperation` persists a fingerprint of the ordered step names; `RunOperation` refuses to run against a mismatched plan — this catches same-length/reordered step-list skew across binaries, not just out-of-range cursors (closing the M1 `RunOperation` NOTE).

**Files:**
- Modify: `~/git/worktreedb/internal/runtime/owner.go`
- Modify: `~/git/worktreedb/internal/runtime/operation.go`
- Modify: `~/git/worktreedb/internal/store/operations.go`
- Modify: `~/git/worktreedb/internal/runtime/runtime_test.go`, `~/git/worktreedb/internal/store/store_test.go`

**Interfaces:**
- Consumes: Task 1's store (schema v2 with `plan_fingerprint`).
- Produces:
  - `func (o *Owner) Run(ctx context.Context, fn func(context.Context) error) error` — fn executes on the owner loop, serialized with Do/nudge converges; same panic recovery (`ErrConvergePanicked`), same `ErrOwnerStopped` semantics as `Do`.
  - `store.ErrOperationNotActive` (sentinel; `AdvanceOperation`/`FinishOperation` wrap it).
  - `store.CreateOperation(ctx, kind, targetID, paramsJSON, planFingerprint string) (string, error)` — NEW 5th parameter (M1 has no production callers; update the store tests' call sites).
  - `store.Operation.PlanFingerprint string` field.
  - `runtime.PlanFingerprint(steps []Step) string` — sha256 over step names joined by `\n`, first 16 hex chars.
  - `runtime.RunOperation(ctx, s, opID, startCursor, steps)` — unchanged signature; now loads the operation row and fails it (diagnosably) when the persisted fingerprint is non-empty and differs from `PlanFingerprint(steps)`.

- [ ] **Step 1: Write the failing tests.** In `internal/runtime/runtime_test.go` add:

```go
func TestOwnerRunSerializesWithConverges(t *testing.T) {
	var order []string
	var mu sync.Mutex
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	block := make(chan struct{})
	o := NewOwner("t", func(ctx context.Context) error {
		mu.Lock()
		order = append(order, "converge")
		mu.Unlock()
		<-block
		return nil
	}, log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o.Start(ctx)
	done := make(chan error, 1)
	go func() { done <- o.Do(ctx) }() // occupies the loop until block closes
	time.Sleep(20 * time.Millisecond)
	ran := make(chan struct{})
	go func() {
		_ = o.Run(ctx, func(ctx context.Context) error {
			mu.Lock()
			order = append(order, "job")
			mu.Unlock()
			close(ran)
			return nil
		})
	}()
	select {
	case <-ran:
		t.Fatal("Run executed while a converge held the loop — not serialized")
	case <-time.After(50 * time.Millisecond):
	}
	close(block)
	<-done
	select {
	case <-ran:
	case <-time.After(time.Second):
		t.Fatal("Run never executed after the loop freed up")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "converge" || order[1] != "job" {
		t.Fatalf("order = %v", order)
	}
}

func TestOwnerRunRecoversPanicsAndFailsFastWhenStopped(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	o := NewOwner("t", func(ctx context.Context) error { return nil }, log)
	if err := o.Run(context.Background(), func(ctx context.Context) error { return nil }); !errors.Is(err, ErrOwnerStopped) {
		t.Fatalf("Run before Start = %v, want ErrOwnerStopped", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	o.Start(ctx)
	err := o.Run(context.Background(), func(ctx context.Context) error { panic("boom") })
	if !errors.Is(err, ErrConvergePanicked) {
		t.Fatalf("panicking Run = %v, want ErrConvergePanicked", err)
	}
	// the loop survived the panic
	if err := o.Run(context.Background(), func(ctx context.Context) error { return nil }); err != nil {
		t.Fatalf("Run after panic = %v", err)
	}
	cancel()
	o.Wait()
	if err := o.Run(context.Background(), func(ctx context.Context) error { return nil }); !errors.Is(err, ErrOwnerStopped) {
		t.Fatalf("Run after stop = %v, want ErrOwnerStopped", err)
	}
}

func TestRunOperationRefusesMismatchedFingerprint(t *testing.T) {
	s := openStore(t) // runtime_test.go's existing M1 store helper
	ctx := context.Background()
	steps := []Step{
		{Name: "a", Do: func(ctx context.Context) error { return nil }},
		{Name: "b", Do: func(ctx context.Context) error { return nil }},
	}
	otherPlan := []Step{
		{Name: "a", Do: func(ctx context.Context) error { return nil }},
		{Name: "c", Do: func(ctx context.Context) error { return nil }},
	}
	opID, err := s.CreateOperation(ctx, "test.kind", "t1", "{}", PlanFingerprint(steps))
	if err != nil {
		t.Fatal(err)
	}
	err = RunOperation(ctx, s, opID, 0, otherPlan)
	if err == nil || !strings.Contains(err.Error(), "fingerprint") {
		t.Fatalf("mismatched plan must fail diagnosably, got %v", err)
	}
	op, ok, _ := s.OperationByID(ctx, opID)
	if !ok || op.Phase != "failed" {
		t.Fatalf("operation must be failed, got %+v", op)
	}
	// A matching plan runs to done.
	opID2, _ := s.CreateOperation(ctx, "test.kind", "t1", "{}", PlanFingerprint(steps))
	if err := RunOperation(ctx, s, opID2, 0, steps); err != nil {
		t.Fatal(err)
	}
	op2, _, _ := s.OperationByID(ctx, opID2)
	if op2.Phase != "done" || op2.PlanFingerprint != PlanFingerprint(steps) {
		t.Fatalf("op2 = %+v", op2)
	}
}

func TestPlanFingerprintIsOrderSensitive(t *testing.T) {
	a := []Step{{Name: "x"}, {Name: "y"}}
	b := []Step{{Name: "y"}, {Name: "x"}}
	if PlanFingerprint(a) == PlanFingerprint(b) {
		t.Fatal("fingerprint must be order-sensitive")
	}
	if len(PlanFingerprint(a)) != 16 {
		t.Fatalf("fingerprint length = %d, want 16", len(PlanFingerprint(a)))
	}
}
```

In `internal/store/store_test.go` add:

```go
func TestOperationNotActiveIsSentinel(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	id, err := s.CreateOperation(ctx, "k", "t", "{}", "abc")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.FinishOperation(ctx, id, "done", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvanceOperation(ctx, id, 1); !errors.Is(err, ErrOperationNotActive) {
		t.Fatalf("Advance on terminal op = %v, want ErrOperationNotActive", err)
	}
	if err := s.FinishOperation(ctx, id, "failed", "x"); !errors.Is(err, ErrOperationNotActive) {
		t.Fatalf("Finish on terminal op = %v, want ErrOperationNotActive", err)
	}
	op, ok, err := s.OperationByID(ctx, id)
	if err != nil || !ok || op.PlanFingerprint != "abc" {
		t.Fatalf("fingerprint must round-trip: %+v %v %v", op, ok, err)
	}
}
```

Existing `CreateOperation` call sites in the M1 tests gain a trailing `""` fingerprint argument — update them mechanically.

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/runtime/ ./internal/store/ 2>&1 | tail -15`
Expected: compile errors (`o.Run undefined`, `not enough arguments in call to s.CreateOperation`, `undefined: ErrOperationNotActive`, `undefined: PlanFingerprint`).

- [ ] **Step 3: Implement `Owner.Run`.** In `internal/runtime/owner.go`:

Replace the `request` struct (this also deletes the stale "nil for coalesced nudges" clause — M1 review P5-4):

```go
// request is one serialized unit of work for the owner loop: fn nil means
// "run the default converge". reply always receives exactly one error.
type request struct {
	fn    func(ctx context.Context) error
	reply chan error
}
```

In `loop`, replace the inbox case:

```go
		case req := <-o.inbox:
			if req.fn != nil {
				req.reply <- o.guard(ctx, req.fn)
			} else {
				req.reply <- o.converge(ctx)
			}
```

Rename the panic-recovery body so both paths share it:

```go
// guard runs fn with the owner's panic recovery: a panicking unit of work is
// converted into ErrConvergePanicked and the loop survives.
func (o *Owner) guard(ctx context.Context, fn func(ctx context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			o.log.Error("owner work panicked", "owner", o.name, "panic", r)
			err = fmt.Errorf("%w: %v", ErrConvergePanicked, r)
		}
	}()
	return fn(ctx)
}

func (o *Owner) converge(ctx context.Context) error { return o.guard(ctx, o.conv) }
```

Refactor `Do` to share a submit path and add `Run`:

```go
// Do runs one converge synchronously through the inbox and returns its error.
func (o *Owner) Do(ctx context.Context) error { return o.submit(ctx, request{reply: make(chan error, 1)}) }

// Run executes fn on the owner loop, serialized with every other converge and
// job for this resource — the lane primitive multi-step mutations (create/
// delete/rename/restore) go through. Same lifecycle semantics as Do:
// ErrOwnerStopped before Start or after termination.
func (o *Owner) Run(ctx context.Context, fn func(ctx context.Context) error) error {
	return o.submit(ctx, request{fn: fn, reply: make(chan error, 1)})
}

func (o *Owner) submit(ctx context.Context, req request) error {
	if !o.started.Load() {
		return ErrOwnerStopped
	}
	select {
	case o.inbox <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-o.done:
		return ErrOwnerStopped
	}
	select {
	case err := <-req.reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-o.done:
		// The loop replies (buffered) before it can exit, so a received
		// request always has an answer — prefer it over the sentinel.
		select {
		case err := <-req.reply:
			return err
		default:
			return ErrOwnerStopped
		}
	}
}
```

- [ ] **Step 4: Implement the sentinels and fingerprint.** In `internal/store/operations.go`:

```go
// ErrOperationNotActive is returned by AdvanceOperation/FinishOperation when
// the operation is already terminal (done/failed) or does not exist — the
// cross-owner backstop made matchable.
var ErrOperationNotActive = errors.New("operation is not active")
```

Change both `n == 0` returns to:

```go
		return fmt.Errorf("operation %s: %w", id, ErrOperationNotActive)
```

`Operation` gains `PlanFingerprint string` after `Error`; `CreateOperation` becomes:

```go
func (s *Store) CreateOperation(ctx context.Context, kind, targetID, paramsJSON, planFingerprint string) (string, error) {
	id := NewID()
	now := NowISO()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO operations (id, kind, target_id, params, plan_fingerprint, created_at, updated_at)
		 VALUES (?,?,?,?,?,?,?)`,
		id, kind, targetID, paramsJSON, planFingerprint, now, now)
	return id, err
}
```

Both SELECTs (`IncompleteOperations`, `OperationByID`) add `COALESCE(plan_fingerprint,'')` to the column list and `&o.PlanFingerprint` to the Scan (keep column/scan order aligned).

In `internal/runtime/operation.go` add (imports gain `crypto/sha256`, `encoding/hex`, `strings`):

```go
// PlanFingerprint identifies a step list by its ordered step names: sha256
// over the names joined with "\n", truncated to 16 hex chars. Persisted at
// operation creation and re-checked before any (re-)execution, it catches
// step-list skew across binaries — same-length renames and reorders included,
// which the cursor range check alone cannot see.
func PlanFingerprint(steps []Step) string {
	names := make([]string, len(steps))
	for i, s := range steps {
		names[i] = s.Name
	}
	sum := sha256.Sum256([]byte(strings.Join(names, "\n")))
	return hex.EncodeToString(sum[:])[:16]
}
```

And at the top of `RunOperation`, before the cursor sanity check:

```go
	op, ok, err := s.OperationByID(ctx, opID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("operation %s not found", opID)
	}
	if fp := PlanFingerprint(steps); op.PlanFingerprint != "" && op.PlanFingerprint != fp {
		ferr := fmt.Errorf("operation %s: persisted plan fingerprint %s does not match this binary's %d-step plan (%s)",
			opID, op.PlanFingerprint, len(steps), fp)
		_ = s.FinishOperation(ctx, opID, "failed", ferr.Error())
		return ferr
	}
```

Also close the M1 review's "swallowed finish error" flag on the step-failure path — replace the `_ = s.FinishOperation(...)` after a step error with:

```go
			if finErr := s.FinishOperation(ctx, opID, "failed", ferr.Error()); finErr != nil {
				return fmt.Errorf("%w (finishing the operation also failed: %v)", ferr, finErr)
			}
```

(keep the out-of-range-cursor path's `_ =` finish — that error already dominates and the row may be arbitrarily corrupt there). Update the M1 `RunOperation` NOTE comment: the fingerprint deferral is now DONE — reword the comment to describe the check above instead of deferring it.

- [ ] **Step 5: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/... -race -count=1 && golangci-lint run`
Expected: all packages PASS, 0 issues.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/runtime internal/store && git commit -m "feat(runtime): owner job lanes, operation plan fingerprint, sentinel not-active errors"
```

---

### Task 3: engine — storcon/pageserver/safekeeper HTTP clients

Thin, typed, oracle-cited clients over the engine's loopback HTTP APIs. One shared error type carries operation/status/body so callers can classify (LSN-range 400s, transient scheduling 409s). The storcon tenant-create retries the engine's own warming-up window.

**Files:**
- Create: `~/git/worktreedb/internal/engine/clients.go`
- Create: `~/git/worktreedb/internal/engine/clients_test.go`

**Interfaces:**
- Consumes: `config.EnginePorts` (M1).
- Produces (exact — the service layer's narrow interfaces in Task 8 mirror these method sets):
  - `type APIError struct { Op string; Status int; Body string }` with `Error() string` = `"<op>: engine returned <status>: <body>"`; `Status == 0` means transport failure.
  - `func CheckID(id string) error` — 32 lowercase hex or error.
  - `type TenantConfig struct` (json-tagged) + `var DefaultTenantConfig`.
  - `type StorconClient struct{...}` / `func NewStorconClient(port int) *StorconClient` with `TenantCreate(ctx, tenantID string, cfg TenantConfig) error` and `GetLsnByTimestamp(ctx, tenantID, timelineID, isoTimestamp string) (LsnByTimestamp, error)`; `LsnByTimestamp{LSN string; Kind string}`.
  - `type PageserverClient` / `NewPageserverClient(port int)` with `TimelineCreate(ctx, tenantID string, req TimelineCreateRequest) error`, `TimelineInfo(ctx, tenantID, timelineID string) (TimelineInfo, error)`, `TimelineDelete(ctx, tenantID, timelineID string) error`, `TimelineDetachAncestor(ctx, tenantID, timelineID string) (DetachAncestorResult, error)`, `TenantDelete(ctx, tenantID string) error`.
  - `type SafekeeperClient` / `NewSafekeeperClient(port int)` with `TimelineDelete`, `TenantDelete` (same signatures as pageserver's).
  - `TimelineCreateRequest{NewTimelineID string; AncestorTimelineID string; AncestorStartLSN string; PgVersion int; ReadOnly *bool}` (omitempty semantics as tagged below), `TimelineInfo{TimelineID string; AncestorLSN *string; LastRecordLSN *string; CurrentLogicalSize *int64}`, `DetachAncestorResult{ReparentedTimelines []string}`.

- [ ] **Step 1: Write the failing tests** — `internal/engine/clients_test.go` (complete file):

```go
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

const (
	tid = "11111111111111111111111111111111"
	tlid = "22222222222222222222222222222222"
)

func TestCheckID(t *testing.T) {
	if err := CheckID(tid); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "xyz", strings.ToUpper(tid), tid + "00"} {
		if err := CheckID(bad); err == nil {
			t.Fatalf("CheckID(%q) must fail", bad)
		}
	}
}

func TestTenantCreateFlattensConfigAndRetriesWarmup(t *testing.T) {
	var bodies []map[string]any
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/tenant" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		bodies = append(bodies, m)
		attempts++
		if attempts < 3 {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"msg":"Conflict: Failed to schedule shard(s): No pageserver found matching constraint"}`))
			return
		}
		w.WriteHeader(201)
	}))
	defer srv.Close()
	c := NewStorconClient(portOf(t, srv))
	c.Sleep = func(ctx context.Context, ms int) error { return nil } // no real backoff in tests
	if err := c.TenantCreate(context.Background(), tid, DefaultTenantConfig); err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3 (two transient 409s then success)", attempts)
	}
	b := bodies[0]
	// oracle-shaped body: config fields FLATTENED onto the top level, no nested "config"
	if b["new_tenant_id"] != tid || b["gc_period"] != "1h" || b["pitr_interval"] != "7 days" {
		t.Fatalf("body = %v", b)
	}
	if _, nested := b["config"]; nested {
		t.Fatal("TenantConfig must flatten, not nest under \"config\"")
	}
	if v, present := b["generation"]; !present || v != nil {
		t.Fatalf("generation must be present and null, got %v (present=%v)", v, present)
	}
}

func TestTenantCreateDoesNotRetryPermanent409(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"msg":"tenant already exists"}`))
	}))
	defer srv.Close()
	c := NewStorconClient(portOf(t, srv))
	c.Sleep = func(ctx context.Context, ms int) error { return nil }
	err := c.TenantCreate(context.Background(), tid, DefaultTenantConfig)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 409 {
		t.Fatalf("err = %v", err)
	}
	if attempts != 1 {
		t.Fatalf("permanent 409 must not retry, attempts = %d", attempts)
	}
}

func TestGetLsnByTimestamp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/v1/tenant/" + tid + "/timeline/" + tlid + "/get_lsn_by_timestamp"
		if r.URL.Path != want {
			t.Errorf("path = %s, want %s", r.URL.Path, want)
		}
		if r.URL.Query().Get("timestamp") != "2026-07-11T09:00:00.000Z" {
			t.Errorf("timestamp = %s", r.URL.Query().Get("timestamp"))
		}
		_, _ = w.Write([]byte(`{"lsn":"0/169AD58","kind":"present"}`))
	}))
	defer srv.Close()
	c := NewStorconClient(portOf(t, srv))
	out, err := c.GetLsnByTimestamp(context.Background(), tid, tlid, "2026-07-11T09:00:00.000Z")
	if err != nil || out.LSN != "0/169AD58" || out.Kind != "present" {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}

func TestPageserverTimelineLifecycle(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/tenant/"+tid+"/timeline":
			raw, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			if m["new_timeline_id"] != tlid || m["ancestor_timeline_id"] != "33333333333333333333333333333333" ||
				m["ancestor_start_lsn"] != "0/1000" || m["read_only"] != false {
				t.Errorf("create body = %v", m)
			}
			if _, has := m["pg_version"]; has {
				t.Error("branch create must not carry pg_version")
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"timeline_id":"` + tlid + `"}`))
		case r.Method == "GET":
			_, _ = w.Write([]byte(`{"timeline_id":"` + tlid + `","last_record_lsn":"0/2000","current_logical_size":42,"ancestor_lsn":"0/1000"}`))
		case r.Method == "PUT" && strings.HasSuffix(r.URL.Path, "/detach_ancestor"):
			_, _ = w.Write([]byte(`{"reparented_timelines":["44444444444444444444444444444444"]}`))
		case r.Method == "DELETE":
			w.WriteHeader(404) // tolerated: delete is idempotent from the caller's view
		}
	}))
	defer srv.Close()
	c := NewPageserverClient(portOf(t, srv))
	ctx := context.Background()
	ro := false
	if err := c.TimelineCreate(ctx, tid, TimelineCreateRequest{
		NewTimelineID: tlid, AncestorTimelineID: "33333333333333333333333333333333",
		AncestorStartLSN: "0/1000", ReadOnly: &ro,
	}); err != nil {
		t.Fatal(err)
	}
	info, err := c.TimelineInfo(ctx, tid, tlid)
	if err != nil || info.LastRecordLSN == nil || *info.LastRecordLSN != "0/2000" ||
		info.CurrentLogicalSize == nil || *info.CurrentLogicalSize != 42 || info.AncestorLSN == nil {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	det, err := c.TimelineDetachAncestor(ctx, tid, tlid)
	if err != nil || len(det.ReparentedTimelines) != 1 {
		t.Fatalf("detach=%+v err=%v", det, err)
	}
	if err := c.TimelineDelete(ctx, tid, tlid); err != nil {
		t.Fatal("404 on delete must be tolerated:", err)
	}
	if err := c.TenantDelete(ctx, tid); err != nil {
		t.Fatal(err)
	}
}

func TestSafekeeperDeletesTolerate404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	}))
	defer srv.Close()
	c := NewSafekeeperClient(portOf(t, srv))
	if err := c.TimelineDelete(context.Background(), tid, tlid); err != nil {
		t.Fatal(err)
	}
	if err := c.TenantDelete(context.Background(), tid); err != nil {
		t.Fatal(err)
	}
}

func TestAPIErrorSurfacesBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte("kaboom"))
	}))
	defer srv.Close()
	c := NewPageserverClient(portOf(t, srv))
	err := c.TenantDelete(context.Background(), tid)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 500 || apiErr.Body != "kaboom" || apiErr.Op != "tenant_delete" {
		t.Fatalf("err = %#v", err)
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/engine/ -run 'TestCheckID|TestTenantCreate|TestGetLsn|TestPageserver|TestSafekeeper|TestAPIError' 2>&1 | tail -10`
Expected: compile errors (`undefined: CheckID`, `undefined: NewStorconClient`, …).

- [ ] **Step 3: Write `internal/engine/clients.go`** (complete file):

```go
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// APIError is any non-OK answer from an engine HTTP API (Status 0 = the
// request never got an HTTP answer at all). Body is the raw response text so
// callers can classify engine-specific failures without re-fetching.
type APIError struct {
	Op     string
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s: engine returned %d: %s", e.Op, e.Status, e.Body)
}

var engineIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// CheckID guards the path interpolation below: tenant/timeline ids are
// opaque 32-lowercase-hex identifiers (shaped like the engine's TenantId/
// TimelineId — oracle: neon libs/utils/src/id.rs); anything else never
// reaches a URL.
func CheckID(id string) error {
	if !engineIDRe.MatchString(id) {
		return fmt.Errorf("invalid engine id: %q (expected 32 lowercase hex chars)", id)
	}
	return nil
}

var engineHTTPClient = &http.Client{Timeout: 60 * time.Second}

func doEngine(ctx context.Context, op, method, rawURL string, body []byte, okStatuses []int) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := engineHTTPClient.Do(req)
	if err != nil {
		return nil, &APIError{Op: op, Status: 0, Body: err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	for _, ok := range okStatuses {
		if res.StatusCode == ok {
			return raw, nil
		}
	}
	return nil, &APIError{Op: op, Status: res.StatusCode, Body: string(raw)}
}

// oracle: neon libs/pageserver_api/src/models.rs TenantConfig field names
// (gc_period/gc_horizon/pitr_interval/checkpoint_distance/checkpoint_timeout),
// set via the same fields flattened onto storage_controller's POST /v1/tenant body.
type TenantConfig struct {
	GCPeriod           string `json:"gc_period"`
	GCHorizon          int64  `json:"gc_horizon"`
	PitrInterval       string `json:"pitr_interval"`
	CheckpointDistance int64  `json:"checkpoint_distance"`
	CheckpointTimeout  string `json:"checkpoint_timeout"`
}

var DefaultTenantConfig = TenantConfig{
	GCPeriod: "1h", GCHorizon: 67108864, PitrInterval: "7 days",
	CheckpointDistance: 268435456, CheckpointTimeout: "5m",
}

// Right after every engine component reports running, the storage controller
// still marks a freshly attached pageserver "warming-up" until its next
// heartbeat tick (~5s cadence, internal to storage_controller). A tenant
// create landing in that window is well-formed but rejected with this exact
// scheduling message; the match is deliberately narrow so a REAL 409 (tenant
// already exists, zero pageservers) still surfaces.
const transientSchedulingMsg = "Failed to schedule shard(s): No pageserver found matching constraint"

type StorconClient struct {
	Base string
	// Sleep is injectable so tests exercise the retry loop without waiting
	// out the real backoff. ms is the requested delay in milliseconds.
	Sleep func(ctx context.Context, ms int) error
}

func NewStorconClient(port int) *StorconClient {
	return &StorconClient{
		Base: fmt.Sprintf("http://127.0.0.1:%d", port),
		Sleep: func(ctx context.Context, ms int) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(ms) * time.Millisecond):
				return nil
			}
		},
	}
}

// oracle: neon storage_controller POST /v1/tenant (storage_controller/src/http.rs,
// handle_tenant_create), expect 201. TenantCreateRequest has no nested `config`
// field: the TenantConfig fields flatten onto the top-level body alongside
// new_tenant_id/generation/placement_policy.
func (c *StorconClient) TenantCreate(ctx context.Context, tenantID string, cfg TenantConfig) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	body := map[string]any{
		"new_tenant_id":       tenantID,
		"generation":          nil,
		"placement_policy":    nil,
		"gc_period":           cfg.GCPeriod,
		"gc_horizon":          cfg.GCHorizon,
		"pitr_interval":       cfg.PitrInterval,
		"checkpoint_distance": cfg.CheckpointDistance,
		"checkpoint_timeout":  cfg.CheckpointTimeout,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	const maxAttempts = 3
	for attempt := 1; ; attempt++ {
		_, err := doEngine(ctx, "tenant_create", "POST", c.Base+"/v1/tenant", raw, []int{201})
		if err == nil {
			return nil
		}
		apiErr, ok := err.(*APIError)
		transient := ok && apiErr.Status == 409 && strings.Contains(apiErr.Body, transientSchedulingMsg)
		if !transient || attempt == maxAttempts {
			return err
		}
		if serr := c.Sleep(ctx, 2000*attempt); serr != nil {
			return serr
		}
	}
}

type LsnByTimestamp struct {
	LSN  string `json:"lsn"`
	Kind string `json:"kind"`
}

// oracle: neon pageserver GET …/timeline/:timeline_id/get_lsn_by_timestamp
// (pageserver/src/http/routes.rs, get_lsn_by_timestamp_handler) — storcon
// proxies this pageserver route (no route of its own in storage_controller/src/http.rs).
func (c *StorconClient) GetLsnByTimestamp(ctx context.Context, tenantID, timelineID, isoTimestamp string) (LsnByTimestamp, error) {
	var out LsnByTimestamp
	if err := CheckID(tenantID); err != nil {
		return out, err
	}
	if err := CheckID(timelineID); err != nil {
		return out, err
	}
	u := fmt.Sprintf("%s/v1/tenant/%s/timeline/%s/get_lsn_by_timestamp?timestamp=%s",
		c.Base, tenantID, timelineID, url.QueryEscape(isoTimestamp))
	raw, err := doEngine(ctx, "get_lsn_by_timestamp", "GET", u, nil, []int{200})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, &APIError{Op: "get_lsn_by_timestamp", Status: 200, Body: "invalid JSON from engine: " + string(raw)}
	}
	return out, nil
}

type PageserverClient struct{ Base string }

func NewPageserverClient(port int) *PageserverClient {
	return &PageserverClient{Base: fmt.Sprintf("http://127.0.0.1:%d", port)}
}

// TimelineCreateRequest is pageserver POST /v1/tenant/:tenant_shard_id/timeline's
// body with the mode variant's fields flattened (branch: ancestor_timeline_id
// [+ ancestor_start_lsn]; bootstrap: pg_version).
// oracle: neon pageserver/src/http/routes.rs timeline_create_handler +
// TimelineCreateRequestMode (contract in pageserver/src/http/openapi_spec.yml).
type TimelineCreateRequest struct {
	NewTimelineID      string `json:"new_timeline_id"`
	AncestorTimelineID string `json:"ancestor_timeline_id,omitempty"`
	AncestorStartLSN   string `json:"ancestor_start_lsn,omitempty"`
	PgVersion          int    `json:"pg_version,omitempty"`
	ReadOnly           *bool  `json:"read_only,omitempty"`
}

type TimelineInfo struct {
	TimelineID         string  `json:"timeline_id"`
	AncestorLSN        *string `json:"ancestor_lsn"`
	LastRecordLSN      *string `json:"last_record_lsn"`
	CurrentLogicalSize *int64  `json:"current_logical_size"`
}

func (c *PageserverClient) tl(tenantID, timelineID string) string {
	return fmt.Sprintf("%s/v1/tenant/%s/timeline/%s", c.Base, tenantID, timelineID)
}

// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline (routes.rs;
// create + create-at-LSN via ancestor_start_lsn), 200/201 on success.
func (c *PageserverClient) TimelineCreate(ctx context.Context, tenantID string, req TimelineCreateRequest) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_, err = doEngine(ctx, "timeline_create", "POST", c.Base+"/v1/tenant/"+tenantID+"/timeline", raw, []int{200, 201})
	return err
}

// oracle: neon pageserver GET /v1/tenant/:tenant_shard_id/timeline/:timeline_id
// (routes.rs, timeline_detail_handler; force-await-initial-logical-size unset).
func (c *PageserverClient) TimelineInfo(ctx context.Context, tenantID, timelineID string) (TimelineInfo, error) {
	var out TimelineInfo
	if err := CheckID(tenantID); err != nil {
		return out, err
	}
	if err := CheckID(timelineID); err != nil {
		return out, err
	}
	raw, err := doEngine(ctx, "timeline_info", "GET", c.tl(tenantID, timelineID), nil, []int{200})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, &APIError{Op: "timeline_info", Status: 200, Body: "invalid JSON from engine: " + string(raw)}
	}
	return out, nil
}

// oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id/timeline/:timeline_id
// (routes.rs, timeline_delete_handler). Deletion is async engine-side (202);
// 404 is tolerated so the caller's delete is idempotent.
func (c *PageserverClient) TimelineDelete(ctx context.Context, tenantID, timelineID string) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	if err := CheckID(timelineID); err != nil {
		return err
	}
	_, err := doEngine(ctx, "timeline_delete", "DELETE", c.tl(tenantID, timelineID), nil, []int{200, 202, 404})
	return err
}

type DetachAncestorResult struct {
	ReparentedTimelines []string `json:"reparented_timelines"`
}

// oracle: neon pageserver PUT /v1/tenant/:tenant_shard_id/timeline/:timeline_id/detach_ancestor
// (routes.rs, timeline_detach_ancestor_handler).
func (c *PageserverClient) TimelineDetachAncestor(ctx context.Context, tenantID, timelineID string) (DetachAncestorResult, error) {
	var out DetachAncestorResult
	if err := CheckID(tenantID); err != nil {
		return out, err
	}
	if err := CheckID(timelineID); err != nil {
		return out, err
	}
	raw, err := doEngine(ctx, "timeline_detach_ancestor", "PUT", c.tl(tenantID, timelineID)+"/detach_ancestor", nil, []int{200})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, &APIError{Op: "timeline_detach_ancestor", Status: 200, Body: "invalid JSON from engine: " + string(raw)}
	}
	return out, nil
}

// oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id (routes.rs, tenant_delete_handler)
func (c *PageserverClient) TenantDelete(ctx context.Context, tenantID string) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	_, err := doEngine(ctx, "tenant_delete", "DELETE", c.Base+"/v1/tenant/"+tenantID, nil, []int{200, 202, 404})
	return err
}

type SafekeeperClient struct{ Base string }

func NewSafekeeperClient(port int) *SafekeeperClient {
	return &SafekeeperClient{Base: fmt.Sprintf("http://127.0.0.1:%d", port)}
}

// oracle: neon safekeeper DELETE /v1/tenant/:tenant_id/timeline/:timeline_id
// (safekeeper/src/http/routes.rs, timeline_delete_handler); the storage
// controller's own typed wrapper is safekeeper_client.rs::delete_timeline.
func (c *SafekeeperClient) TimelineDelete(ctx context.Context, tenantID, timelineID string) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	if err := CheckID(timelineID); err != nil {
		return err
	}
	_, err := doEngine(ctx, "sk_timeline_delete", "DELETE",
		fmt.Sprintf("%s/v1/tenant/%s/timeline/%s", c.Base, tenantID, timelineID), nil, []int{200, 404})
	return err
}

// oracle: neon safekeeper DELETE /v1/tenant/:tenant_id (safekeeper/src/http/routes.rs,
// tenant_delete_handler); storage controller wrapper safekeeper_client.rs::delete_tenant.
func (c *SafekeeperClient) TenantDelete(ctx context.Context, tenantID string) error {
	if err := CheckID(tenantID); err != nil {
		return err
	}
	_, err := doEngine(ctx, "sk_tenant_delete", "DELETE", c.Base+"/v1/tenant/"+tenantID, nil, []int{200, 404})
	return err
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/engine/ -race -count=1 && golangci-lint run`
Expected: PASS (including all pre-existing engine tests), 0 issues.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/engine && git commit -m "feat(engine): typed storcon/pageserver/safekeeper http clients"
```

---

### Task 4: events — the state-change bus and the log hub

Two in-memory fanout primitives in `internal/events` (the streaming package): `Bus` — typed state-change events behind `GET /api/events` (no replay by contract: clients blanket-invalidate on every (re)connect, which is what makes lost events correctness-free); `LogHub` — bounded per-channel ring buffers + live subscribers behind the log SSE routes. Emission discipline for the bus lives in the service layer (status transitions publish); this task is the plumbing.

**Files:**
- Create: `~/git/worktreedb/internal/events/bus.go`
- Create: `~/git/worktreedb/internal/events/loghub.go`
- Create: `~/git/worktreedb/internal/events/events_test.go`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `type Event struct { Type string `json:"type"`; ProjectID string `json:"projectId,omitempty"`; BranchID string `json:"branchId,omitempty"`; At string `json:"at"` }`
  - `func NewBus() *Bus` · `func (b *Bus) Publish(eventType, projectID, branchID string)` (stamps `At`) · `func (b *Bus) Subscribe(cb func(Event)) (unsubscribe func())`
  - `func NewLogHub() *LogHub` · `(h *LogHub) Ingest(channel, line string)` · `Recent(channel string, n int) []string` · `Subscribe(channel string, cb func(line string)) (unsubscribe func())` · `Evict(channel string)`
  - `func DaemonLogChannel(component string) string` = `"daemon:" + component`; branch compute channels are `"branch:<branchID>:compute"` (spelled at call sites).

- [ ] **Step 1: Write the failing tests** — `internal/events/events_test.go` (complete file):

```go
package events

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBusPublishStampsAndFansOut(t *testing.T) {
	b := NewBus()
	var mu sync.Mutex
	var got []Event
	unsub := b.Subscribe(func(e Event) { mu.Lock(); got = append(got, e); mu.Unlock() })
	b.Publish("project.created", "p1", "")
	b.Publish("endpoint.status", "p1", "b1")
	mu.Lock()
	if len(got) != 2 || got[0].Type != "project.created" || got[1].BranchID != "b1" {
		mu.Unlock()
		t.Fatalf("got = %+v", got)
	}
	at := got[0].At
	mu.Unlock()
	ts, err := time.Parse("2006-01-02T15:04:05.000Z", at)
	if err != nil || time.Since(ts) > time.Minute {
		t.Fatalf("At = %q must be ISO-8601 UTC with milliseconds: %v", at, err)
	}
	// wire shape: empty ids are OMITTED, never empty strings
	raw, _ := json.Marshal(got[0])
	if strings.Contains(string(raw), "branchId") {
		t.Fatalf("empty branchId must be omitted: %s", raw)
	}
	unsub()
	b.Publish("project.deleted", "p1", "")
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatal("unsubscribed callback must not fire")
	}
}

func TestBusSurvivesPanickingAndUnsubscribingSubscribers(t *testing.T) {
	b := NewBus()
	var later []string
	b.Subscribe(func(e Event) { panic("bad subscriber") })
	var unsub2 func()
	unsub2 = b.Subscribe(func(e Event) { unsub2() }) // unsubscribes itself mid-publish
	b.Subscribe(func(e Event) { later = append(later, e.Type) })
	b.Publish("branch.created", "p", "b")
	if len(later) != 1 {
		t.Fatalf("delivery must continue past a panicking/unsubscribing subscriber: %v", later)
	}
}

func TestLogHubRingAndReplay(t *testing.T) {
	h := NewLogHub()
	for i := 0; i < 600; i++ {
		h.Ingest("daemon:pageserver", fmt.Sprintf("line-%d", i))
	}
	all := h.Recent("daemon:pageserver", 500)
	if len(all) != 500 || all[0] != "line-100" || all[499] != "line-599" {
		t.Fatalf("ring must cap at 500: len=%d first=%s last=%s", len(all), all[0], all[len(all)-1])
	}
	if got := h.Recent("daemon:pageserver", 200); len(got) != 200 || got[0] != "line-400" {
		t.Fatalf("Recent(200): len=%d first=%s", len(got), got[0])
	}
	if got := h.Recent("no:such:channel", 200); len(got) != 0 {
		t.Fatal("unknown channel must replay nothing")
	}
}

func TestLogHubSubscribeAndEvict(t *testing.T) {
	h := NewLogHub()
	var got []string
	unsub := h.Subscribe("branch:b1:compute", func(l string) { got = append(got, l) })
	h.Ingest("branch:b1:compute", "one")
	h.Ingest("branch:b2:compute", "other-channel")
	if len(got) != 1 || got[0] != "one" {
		t.Fatalf("got = %v", got)
	}
	unsub()
	h.Ingest("branch:b1:compute", "two")
	if len(got) != 1 {
		t.Fatal("unsubscribed callback must not fire")
	}
	h.Evict("branch:b1:compute")
	if len(h.Recent("branch:b1:compute", 200)) != 0 {
		t.Fatal("evict must drop the ring")
	}
}

func TestDaemonLogChannel(t *testing.T) {
	if DaemonLogChannel("pageserver") != "daemon:pageserver" {
		t.Fatal(DaemonLogChannel("pageserver"))
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/events/ 2>&1 | tail -5`
Expected: build fails (`no required module provides package .../internal/events` resolves once files exist; first run: directory missing → create files next).

- [ ] **Step 3: Write `internal/events/bus.go`** (complete file):

```go
// Package events carries the daemon's two in-memory fanout streams: the
// state-change event bus behind GET /api/events and the per-channel log hub
// behind the log SSE routes. Neither persists anything — events are coarse
// invalidation hints (ids only, never payloads) and logs are bounded rings.
package events

import (
	"sync"
	"time"
)

// Event is one invalidation hint on the /api/events wire. Empty ProjectID/
// BranchID are omitted from the JSON — subscribers treat every field beyond
// Type as optional context.
type Event struct {
	Type      string `json:"type"`
	ProjectID string `json:"projectId,omitempty"`
	BranchID  string `json:"branchId,omitempty"`
	At        string `json:"at"`
}

type Bus struct {
	mu   sync.Mutex
	next int
	subs map[int]func(Event)
}

func NewBus() *Bus { return &Bus{subs: map[int]func(Event){}} }

// Publish stamps At server-side and fans out to a snapshot of the current
// subscribers. A panicking subscriber (e.g. a write against a dying SSE
// socket) never breaks delivery to the others or the publishing mutation.
// Publish must stay non-blocking-fast: it is called from owner converges and
// from engine OnStateChange observers that run under a Process mutex.
func (b *Bus) Publish(eventType, projectID, branchID string) {
	e := Event{
		Type: eventType, ProjectID: projectID, BranchID: branchID,
		At: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	b.mu.Lock()
	cbs := make([]func(Event), 0, len(b.subs))
	for _, cb := range b.subs {
		cbs = append(cbs, cb)
	}
	b.mu.Unlock()
	for _, cb := range cbs {
		func() {
			defer func() { _ = recover() }()
			cb(e)
		}()
	}
}

func (b *Bus) Subscribe(cb func(Event)) func() {
	b.mu.Lock()
	id := b.next
	b.next++
	b.subs[id] = cb
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.subs, id)
		b.mu.Unlock()
	}
}
```

- [ ] **Step 4: Write `internal/events/loghub.go`** (complete file):

```go
package events

import "sync"

const ringCap = 500

// DaemonLogChannel names an engine/daemon component's log channel; branch
// compute output lives on "branch:<branchID>:compute".
func DaemonLogChannel(component string) string { return "daemon:" + component }

// LogHub is a bounded ring buffer per channel plus live subscriber fanout.
// Consumers replay Recent() then Subscribe() for the live tail (the SSE
// routes do exactly that).
type LogHub struct {
	mu    sync.Mutex
	rings map[string][]string
	next  int
	subs  map[string]map[int]func(string)
}

func NewLogHub() *LogHub {
	return &LogHub{rings: map[string][]string{}, subs: map[string]map[int]func(string){}}
}

func (h *LogHub) Ingest(channel, line string) {
	h.mu.Lock()
	ring := append(h.rings[channel], line)
	if len(ring) > ringCap {
		ring = ring[1:]
	}
	h.rings[channel] = ring
	cbs := make([]func(string), 0, len(h.subs[channel]))
	for _, cb := range h.subs[channel] {
		cbs = append(cbs, cb)
	}
	h.mu.Unlock()
	for _, cb := range cbs {
		func() {
			defer func() { _ = recover() }() // a throwing subscriber never breaks ingest
			cb(line)
		}()
	}
}

func (h *LogHub) Recent(channel string, n int) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	ring := h.rings[channel]
	if n > len(ring) {
		n = len(ring)
	}
	out := make([]string, n)
	copy(out, ring[len(ring)-n:])
	return out
}

func (h *LogHub) Subscribe(channel string, cb func(string)) func() {
	h.mu.Lock()
	set := h.subs[channel]
	if set == nil {
		set = map[int]func(string){}
		h.subs[channel] = set
	}
	id := h.next
	h.next++
	set[id] = cb
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if set, ok := h.subs[channel]; ok {
			delete(set, id)
			if len(set) == 0 {
				delete(h.subs, channel) // never leak an empty set per historical channel
			}
		}
	}
}

// Evict drops a channel outright — called when the channel's subject is gone
// for good (a deleted branch's compute channel is never written or read
// again; branch ids are never reused), so rings don't accumulate over the
// daemon's lifetime keyed by historical branch ids.
func (h *LogHub) Evict(channel string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rings, channel)
	delete(h.subs, channel)
}
```

- [ ] **Step 5: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/events/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/events && git commit -m "feat(events): state-change bus and per-channel log hub"
```

---

### Task 5: compute — secrets, postgres config, ComputeSpec, baked pgbin

Pure generators for everything a compute launch writes to disk: the branch password + SCRAM-SHA-256 verifier, `postgresql.conf`, `pg_hba.conf`, the compute_ctl `config.json` (ComputeSpec + compute_ctl_config), and resolution of the baked PostgreSQL install for a major. All stdlib (`crypto/pbkdf2` is standard library on Go ≥1.24).

**Files:**
- Create: `~/git/worktreedb/internal/compute/secrets.go`
- Create: `~/git/worktreedb/internal/compute/pgconf.go`
- Create: `~/git/worktreedb/internal/compute/spec.go`
- Create: `~/git/worktreedb/internal/compute/pgbin.go`
- Create: `~/git/worktreedb/internal/compute/generators_test.go`

**Interfaces:**
- Consumes: `config.EnginePorts` (for the pageserver/safekeeper ports baked into the spec).
- Produces:
  - `func GeneratePassword() string` — 32 chars from `[A-Za-z0-9]`, crypto/rand.
  - `func ScramSHA256Verifier(password string, salt []byte, iterations int) (string, error)` — `SCRAM-SHA-256$<iter>:<b64 salt>$<b64 storedKey>:<b64 serverKey>`.
  - `const PGHBA string` (exact content below).
  - `func PostgresqlConf(port int, hbaPath string, safekeeperPg int) string`.
  - `type SpecParams struct { TenantID, TimelineID string; Port int; HBAPath, Password string; PageserverPg, SafekeeperPg int }` and `func ConfigJSON(p SpecParams) (string, error)`.
  - `func InstalledMajors(pgInstallDir string) ([]int, error)` — sorted majors with a `v<N>` dir; `func BakedPgbin(pgInstallDir string, major int) (string, error)` — `<dir>/v<N>/bin`, error if absent.

- [ ] **Step 1: Write the failing tests** — `internal/compute/generators_test.go` (complete file):

```go
package compute

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestGeneratePassword(t *testing.T) {
	seen := map[string]bool{}
	re := regexp.MustCompile(`^[A-Za-z0-9]{32}$`)
	for i := 0; i < 50; i++ {
		p := GeneratePassword()
		if !re.MatchString(p) {
			t.Fatalf("password %q must be 32 alphanumerics", p)
		}
		if seen[p] {
			t.Fatal("duplicate password across 50 draws")
		}
		seen[p] = true
	}
}

// Known-vector test: fixed salt + iterations pin the whole derivation
// (PBKDF2 → HMAC "Client Key"/"Server Key" → SHA-256 stored key).
func TestScramVerifierStructureAndDeterminism(t *testing.T) {
	salt := []byte("0123456789abcdef")
	v1, err := ScramSHA256Verifier("secret", salt, 4096)
	if err != nil {
		t.Fatal(err)
	}
	v2, _ := ScramSHA256Verifier("secret", salt, 4096)
	if v1 != v2 {
		t.Fatal("verifier must be deterministic for a fixed salt")
	}
	parts := strings.Split(v1, "$")
	if len(parts) != 3 || parts[0] != "SCRAM-SHA-256" {
		t.Fatalf("shape: %q", v1)
	}
	iterSalt := strings.SplitN(parts[1], ":", 2)
	if iterSalt[0] != "4096" || iterSalt[1] != base64.StdEncoding.EncodeToString(salt) {
		t.Fatalf("iterations:salt = %q", parts[1])
	}
	keys := strings.SplitN(parts[2], ":", 2)
	for _, k := range keys {
		raw, err := base64.StdEncoding.DecodeString(k)
		if err != nil || len(raw) != 32 {
			t.Fatalf("key %q must be 32 bytes base64", k)
		}
	}
	if keys[0] == keys[1] {
		t.Fatal("stored key and server key must differ")
	}
}

func TestPostgresqlConf(t *testing.T) {
	conf := PostgresqlConf(43512, "/data/computes/x/pg_hba.conf", 5454)
	for _, want := range []string{
		"listen_addresses='127.0.0.1'",
		"port=43512",
		"shared_preload_libraries=neon",
		"neon.safekeepers=localhost:5454",
		"password_encryption=scram-sha-256",
		"hba_file='/data/computes/x/pg_hba.conf'",
		"fsync=off",
		"wal_level=logical",
		"synchronous_standby_names=walproposer",
	} {
		if !strings.Contains(conf, want) {
			t.Fatalf("postgresql.conf missing %q:\n%s", want, conf)
		}
	}
	if !strings.HasSuffix(conf, "\n") {
		t.Fatal("must end with a newline")
	}
}

func TestPGHBAShape(t *testing.T) {
	if !strings.Contains(PGHBA, "host    all       cloud_admin   127.0.0.1/32  trust") ||
		!strings.Contains(PGHBA, "host    all       all           all           scram-sha-256") {
		t.Fatalf("pg_hba: %s", PGHBA)
	}
}

func TestConfigJSON(t *testing.T) {
	out, err := ConfigJSON(SpecParams{
		TenantID:   "11111111111111111111111111111111",
		TimelineID: "22222222222222222222222222222222",
		Port:       43512, HBAPath: "/d/pg_hba.conf", Password: "pw",
		PageserverPg: 64000, SafekeeperPg: 5454,
	})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Spec map[string]json.RawMessage `json:"spec"`
		Ctl  struct {
			Jwks struct {
				Keys []any `json:"keys"`
			} `json:"jwks"`
		} `json:"compute_ctl_config"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Ctl.Jwks.Keys == nil || len(doc.Ctl.Jwks.Keys) != 0 {
		t.Fatal("compute_ctl_config.jwks must be {\"keys\": []}")
	}
	must := func(key, wantJSON string) {
		t.Helper()
		raw, ok := doc.Spec[key]
		if !ok {
			t.Fatalf("spec.%s missing", key)
		}
		if string(raw) != wantJSON {
			t.Fatalf("spec.%s = %s, want %s", key, raw, wantJSON)
		}
	}
	must("format_version", "1")
	must("tenant_id", `"11111111111111111111111111111111"`)
	must("timeline_id", `"22222222222222222222222222222222"`)
	must("endpoint_id", `"compute-22222222222222222222222222222222"`)
	must("mode", `"Primary"`)
	must("suspend_timeout_seconds", "-1") // policy lives in the daemon, never in the spec
	must("skip_pg_catalog_updates", "false")
	must("pageserver_connstring", `"postgres://cloud_admin@127.0.0.1:64000"`)
	// nested values carry MarshalIndent whitespace — compare decoded, not raw
	var sks []string
	if err := json.Unmarshal(doc.Spec["safekeeper_connstrings"], &sks); err != nil || len(sks) != 1 || sks[0] != "127.0.0.1:5454" {
		t.Fatalf("safekeeper_connstrings = %s (%v)", doc.Spec["safekeeper_connstrings"], err)
	}
	var pci struct {
		ShardCount int `json:"shard_count"`
		Shards     map[string]struct {
			Pageservers []struct {
				ID       int     `json:"id"`
				LibpqURL string  `json:"libpq_url"`
				GrpcURL  *string `json:"grpc_url"`
			} `json:"pageservers"`
		} `json:"shards"`
		PreferProtocol string `json:"prefer_protocol"`
	}
	if err := json.Unmarshal(doc.Spec["pageserver_connection_info"], &pci); err != nil {
		t.Fatal(err)
	}
	sh, ok := pci.Shards["0000"]
	if !ok || len(sh.Pageservers) != 1 || sh.Pageservers[0].LibpqURL != "postgres://cloud_admin@127.0.0.1:64000" ||
		pci.PreferProtocol != "libpq" {
		t.Fatalf("pageserver_connection_info = %s", doc.Spec["pageserver_connection_info"])
	}
	var cluster struct {
		Roles []struct {
			Name              string `json:"name"`
			EncryptedPassword string `json:"encrypted_password"`
		} `json:"roles"`
		Databases []struct {
			Name  string `json:"name"`
			Owner string `json:"owner"`
		} `json:"databases"`
		PostgresqlConf string `json:"postgresql_conf"`
	}
	if err := json.Unmarshal(doc.Spec["cluster"], &cluster); err != nil {
		t.Fatal(err)
	}
	if len(cluster.Roles) != 1 || cluster.Roles[0].Name != "postgres" ||
		!strings.HasPrefix(cluster.Roles[0].EncryptedPassword, "SCRAM-SHA-256$4096:") {
		t.Fatalf("roles = %+v", cluster.Roles)
	}
	if len(cluster.Databases) != 1 || cluster.Databases[0].Name != "postgres" || cluster.Databases[0].Owner != "postgres" {
		t.Fatalf("databases = %+v", cluster.Databases)
	}
	if !strings.Contains(cluster.PostgresqlConf, "port=43512") {
		t.Fatal("cluster.postgresql_conf must embed the generated conf")
	}
	// invalid engine ids never reach a spec
	if _, err := ConfigJSON(SpecParams{TenantID: "nope", TimelineID: "22222222222222222222222222222222"}); err == nil {
		t.Fatal("bad tenant id must error")
	}
}

func TestInstalledMajorsAndBakedPgbin(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{"v14", "v16", "v17", "vanilla_v17", "junk"} {
		if err := os.MkdirAll(filepath.Join(dir, d, "bin"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	majors, err := InstalledMajors(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(majors) != 3 || majors[0] != 14 || majors[1] != 16 || majors[2] != 17 {
		t.Fatalf("majors = %v (vanilla_v17/junk must not count)", majors)
	}
	p, err := BakedPgbin(dir, 16)
	if err != nil || p != filepath.Join(dir, "v16", "bin") {
		t.Fatalf("pgbin = %q err=%v", p, err)
	}
	if _, err := BakedPgbin(dir, 15); err == nil {
		t.Fatal("missing major must error")
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/compute/ 2>&1 | tail -5`
Expected: compile errors (package doesn't exist yet / undefined symbols).

- [ ] **Step 3: Write `internal/compute/secrets.go`** (complete file):

```go
// Package compute owns the compute lifecycle: secrets and config generation
// for compute_ctl, the launch/readiness/stop manager, and resolution of the
// PostgreSQL installs computes run on.
package compute

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math/big"
)

// Branch-password policy: 32 alphanumerics. Alphanumeric-only is load-bearing
// for the connection-string contract — the password embeds verbatim in
// postgresql:// and jdbc: URLs with no escaping.
const passwordCharset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

func GeneratePassword() string {
	out := make([]byte, 32)
	max := big.NewInt(int64(len(passwordCharset)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err) // crypto/rand failure is unrecoverable for secret generation
		}
		out[i] = passwordCharset[n.Int64()]
	}
	return string(out)
}

// oracle: neon libs/proxy/postgres-protocol2/src/password/mod.rs → scram_sha_256 —
// SCRAM-SHA-256 is the engine-required verifier format (PBKDF2 salted password,
// HMAC "Client Key"/"Server Key", SHA-256 stored key, layout
// "SCRAM-SHA-256$<iterations>:<salt>$<storedkey>:<serverkey>").
func ScramSHA256Verifier(password string, salt []byte, iterations int) (string, error) {
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	if err != nil {
		return "", fmt.Errorf("scram verifier: %w", err)
	}
	clientKeyMac := hmac.New(sha256.New, salted)
	clientKeyMac.Write([]byte("Client Key"))
	clientKey := clientKeyMac.Sum(nil)
	storedKey := sha256.Sum256(clientKey)
	serverKeyMac := hmac.New(sha256.New, salted)
	serverKeyMac.Write([]byte("Server Key"))
	serverKey := serverKeyMac.Sum(nil)
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s",
		iterations,
		base64.StdEncoding.EncodeToString(salt),
		base64.StdEncoding.EncodeToString(storedKey[:]),
		base64.StdEncoding.EncodeToString(serverKey)), nil
}

// NewScramSalt returns a fresh 16-byte SCRAM salt.
func NewScramSalt() []byte {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
```

- [ ] **Step 4: Write `internal/compute/pgconf.go`** (complete file):

```go
package compute

import (
	"fmt"
	"strings"
)

// pgQuote single-quotes a GUC value, doubling embedded quotes.
func pgQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", "''") + "'" }

// oracle: neon compute_tools/src/config.rs → write_postgres_conf (postgresql.conf
// assembly from the ComputeSpec). Deviations: no ssl block, no cert files.
// listen_addresses is the loopback literal: computes are private to the
// daemon — external traffic enters through the daemon-owned slot listeners,
// never a compute socket. Values containing dots or paths MUST be quoted
// (the GUC lexer tokenizes an unquoted dotted value).
func PostgresqlConf(port int, hbaPath string, safekeeperPg int) string {
	kv := [][2]string{
		{"max_wal_senders", "10"}, {"wal_log_hints", "off"}, {"max_replication_slots", "10"},
		{"hot_standby", "on"},
		{"shared_buffers", "128MB"}, {"effective_cache_size", "512MB"}, {"work_mem", "8MB"},
		{"maintenance_work_mem", "128MB"}, {"max_connections", "100"},
		{"effective_io_concurrency", "100"}, {"random_page_cost", "1.1"},
		{"fsync", "off"}, {"synchronous_commit", "on"},
		{"wal_level", "logical"}, {"wal_sender_timeout", "60s"}, {"wal_keep_size", "0"},
		{"restart_after_crash", "off"},
		{"listen_addresses", pgQuote("127.0.0.1")}, {"port", fmt.Sprintf("%d", port)},
		{"shared_preload_libraries", "neon"},
		{"jit", "off"},
		{"statement_timeout", "0"}, {"idle_in_transaction_session_timeout", "600000"},
		{"autovacuum_max_workers", "4"}, {"autovacuum_naptime", "10s"},
		{"autovacuum_vacuum_scale_factor", "0.05"}, {"autovacuum_analyze_scale_factor", "0.02"},
		{"autovacuum_vacuum_cost_limit", "2000"},
		{"log_min_duration_statement", "1000"}, {"log_connections", "on"},
		{"log_disconnections", "on"}, {"log_checkpoints", "on"}, {"log_lock_waits", "on"},
		{"log_temp_files", "0"}, {"log_autovacuum_min_duration", "1000"},
		{"log_line_prefix", "'%m [%p] %q%u@%d '"},
		{"max_replication_write_lag", "500MB"}, {"max_replication_flush_lag", "10GB"},
		{"synchronous_standby_names", "walproposer"},
		{"neon.safekeepers", fmt.Sprintf("localhost:%d", safekeeperPg)},
		{"password_encryption", "scram-sha-256"},
		{"hba_file", pgQuote(hbaPath)},
	}
	var b strings.Builder
	for _, pair := range kv {
		b.WriteString(pair[0])
		b.WriteString("=")
		b.WriteString(pair[1])
		b.WriteString("\n")
	}
	return b.String()
}

// oracle: neon compute_tools/src/spec.rs → update_pg_hba + params.rs::PG_HBA_ALL_MD5,
// hostssl lines dropped (no TLS). Deviation: the oracle appends one catch-all
// onto initdb's pg_hba defaults; this daemon writes the whole file, with trust
// for cloud_admin on loopback and SCRAM for everyone else.
const PGHBA = `# TYPE  DATABASE  USER          ADDRESS       METHOD
local   all       cloud_admin                 trust
host    all       cloud_admin   127.0.0.1/32  trust
host    all       cloud_admin   ::1/128       trust
host    all       all           all           scram-sha-256
`
```

- [ ] **Step 5: Write `internal/compute/spec.go`** (complete file):

```go
package compute

import (
	"encoding/json"
	"fmt"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

type SpecParams struct {
	TenantID     string
	TimelineID   string
	Port         int
	HBAPath      string
	Password     string
	PageserverPg int
	SafekeeperPg int
}

// oracle: neon libs/compute_api/src/spec.rs (ComputeSpec struct) +
// compute_tools/src/spec_apply.rs (how compute_ctl consumes it); this daemon
// emits the minimal spec compute_ctl requires to boot. Deviations:
// storage_auth_token omitted (trust mode); suspend_timeout_seconds pinned -1
// (suspend policy lives in the daemon, never in the spec).
// compute_ctl_config.jwks must be a JwkSet OBJECT ({"keys": []}), not an
// array — compute_ctl's ComputeCtlConfig deserializer requires the jwks key
// and expects jsonwebtoken::jwk::JwkSet { keys: Vec<Jwk> }.
func ConfigJSON(p SpecParams) (string, error) {
	if err := engine.CheckID(p.TenantID); err != nil {
		return "", err
	}
	if err := engine.CheckID(p.TimelineID); err != nil {
		return "", err
	}
	verifier, err := ScramSHA256Verifier(p.Password, NewScramSalt(), 4096)
	if err != nil {
		return "", err
	}
	pageserverURL := fmt.Sprintf("postgres://cloud_admin@127.0.0.1:%d", p.PageserverPg)
	spec := map[string]any{
		"format_version": 1.0,
		"features":       []any{},
		"cluster": map[string]any{
			"cluster_id": nil,
			"name":       nil,
			"state":      nil,
			"roles": []map[string]any{
				{"name": "postgres", "encrypted_password": verifier, "options": nil},
			},
			"databases": []map[string]any{
				{"name": "postgres", "owner": "postgres", "options": nil, "restrict_conn": false, "invalid": false},
			},
			"postgresql_conf": PostgresqlConf(p.Port, p.HBAPath, p.SafekeeperPg),
			"settings":        nil,
		},
		"delta_operations":        nil,
		"skip_pg_catalog_updates": false,
		"tenant_id":               p.TenantID,
		"timeline_id":             p.TimelineID,
		"pageserver_connection_info": map[string]any{
			"shard_count": 0,
			"stripe_size": nil,
			"shards": map[string]any{
				"0000": map[string]any{
					"pageservers": []map[string]any{
						{"id": 1, "libpq_url": pageserverURL, "grpc_url": nil},
					},
				},
			},
			"prefer_protocol": "libpq",
		},
		"pageserver_connstring":            pageserverURL,
		"endpoint_id":                      "compute-" + p.TimelineID,
		"safekeeper_connstrings":           []string{fmt.Sprintf("127.0.0.1:%d", p.SafekeeperPg)},
		"mode":                             "Primary",
		"remote_extensions":                nil,
		"pgbouncer_settings":               nil,
		"reconfigure_concurrency":          1,
		"drop_subscriptions_before_start":  false,
		"audit_log_level":                  "Disabled",
		"suspend_timeout_seconds":          -1,
	}
	doc := map[string]any{
		"spec":               spec,
		"compute_ctl_config": map[string]any{"jwks": map[string]any{"keys": []any{}}},
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
```

- [ ] **Step 6: Write `internal/compute/pgbin.go`** (complete file):

```go
package compute

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

var majorDirRe = regexp.MustCompile(`^v(\d+)$`)

// InstalledMajors lists the PostgreSQL majors baked into the install dir
// (v14, v15, …), sorted ascending. vanilla_v17 (the storage-controller
// catalog's own tree) deliberately does not count — computes never run on it.
func InstalledMajors(pgInstallDir string) ([]int, error) {
	entries, err := os.ReadDir(pgInstallDir)
	if err != nil {
		return nil, err
	}
	var majors []int
	for _, e := range entries {
		if m := majorDirRe.FindStringSubmatch(e.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			majors = append(majors, n)
		}
	}
	sort.Ints(majors)
	return majors, nil
}

// BakedPgbin resolves the bin directory computes launch with (--pgbin).
func BakedPgbin(pgInstallDir string, major int) (string, error) {
	dir := filepath.Join(pgInstallDir, fmt.Sprintf("v%d", major))
	if _, err := os.Stat(dir); err != nil {
		return "", fmt.Errorf("no PostgreSQL %d install at %s: %w", major, dir, err)
	}
	return filepath.Join(dir, "bin"), nil
}
```

- [ ] **Step 7: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/compute/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 8: Commit**

```bash
cd ~/git/worktreedb && git add internal/compute && git commit -m "feat(compute): scram secrets, postgres config, compute spec, baked install resolution"
```

---

### Task 6: compute — the manager (launch, readiness, group-kill stop)

The compute lifecycle: one entry per branch; `Start` writes the config files into a fresh dir under `<dataDir>/computes/`, grabs three ephemeral loopback ports, launches `compute_ctl` via `engine.Process` with **`Detached: true`** (compute_ctl orphans its postgres child on SIGTERM — only a group kill reaches the whole tree), waits for the log needle AND then polls `/metrics` for `compute_ctl_up{status="running"}` (the needle alone fires before the SCRAM verifier commits). `Stop` group-kills, then removes the dir — safe because `engine.Process.Stop` confirms the process group empty before returning, which deletes the leftover-writer directory-removal race class at the root.

Simplification vs. a lane-free design, stated for reviewers: per-branch owner lanes (Task 8) serialize every Start/Stop for a branch, and shutdown calls `StopAll` only after all owners have quiesced (Task 14's ordering) — so the manager needs a plain mutex + phase guard, not an abort-fence dance against concurrent same-branch teardown.

**Files:**
- Create: `~/git/worktreedb/internal/compute/readiness.go`
- Create: `~/git/worktreedb/internal/compute/manager.go`
- Create: `~/git/worktreedb/internal/compute/readiness_test.go`
- Create: `~/git/worktreedb/internal/compute/manager_test.go`

**Interfaces:**
- Consumes: `engine.ProcOpts`/`engine.NewProcess`/`engine.ProcState` (M1); Task 5's generators.
- Produces:
  - `func ParseComputeCtlUpStatus(metricsText string) (string, bool)`
  - `func WaitComputeReady(ctx context.Context, metricsPort int, opts ReadyOpts) error` with `ReadyOpts{Timeout, Interval time.Duration; HTTPClient *http.Client}` (defaults 50s / 100ms).
  - `type Proc interface { Start(ctx context.Context) error; Stop(timeout time.Duration); State() engine.ProcState }` (the launch seam; `engine.Process` satisfies it).
  - `type ManagerOpts struct { NeonBinDir, ComputesDir string; Log *slog.Logger; Launch func(engine.ProcOpts) Proc; WaitReady func(ctx context.Context, metricsPort int) error }` — Launch/WaitReady nil ⇒ real implementations.
  - `func NewManager(o ManagerOpts) *Manager`
  - `type StartParams struct { BranchID, BranchName, Slug, TenantID, TimelineID, Password, PgbinPath string; OnLine func(string); OnExit func() }`
  - `func (m *Manager) Start(ctx context.Context, p StartParams) (computePort int, err error)`
  - `func (m *Manager) Stop(branchID string)` (total — never errors; logs internally)
  - `func (m *Manager) StopAll()`
  - `func (m *Manager) StatusOf(branchID string) string` — `stopped|starting|running|stopping|failed`
  - `func (m *Manager) RunningPgbin(branchID string) string` (empty when none) · `func (m *Manager) RunningPgbins() []string` — every entry's pgbin regardless of phase (the in-use protocol the builds milestone consumes).

- [ ] **Step 1: Write the failing readiness tests** — `internal/compute/readiness_test.go` (complete file):

```go
package compute

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseComputeCtlUpStatus(t *testing.T) {
	cases := []struct {
		text string
		want string
		ok   bool
	}{
		{`compute_ctl_up{build_tag="x",status="running"} 1`, "running", true},
		{"# HELP compute_ctl_up …\ncompute_ctl_up{status=\"configuration_pending\"} 1\n", "configuration_pending", true},
		{`compute_ctl_up{status="failed"} 1.0`, "failed", true},
		{`compute_ctl_up{status="running"} 0`, "", false}, // gauge not set
		{`something_else 1`, "", false},
	}
	for _, c := range cases {
		got, ok := ParseComputeCtlUpStatus(c.text)
		if got != c.want || ok != c.ok {
			t.Fatalf("Parse(%q) = %q,%v; want %q,%v", c.text, got, ok, c.want, c.ok)
		}
	}
}

func metricsServer(t *testing.T, responses *[]string) int {
	t.Helper()
	i := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			t.Errorf("path = %s", r.URL.Path)
		}
		body := (*responses)[min(i, len(*responses)-1)]
		i++
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	p, _ := strconv.Atoi(u.Port())
	return p
}

func TestWaitComputeReadyPollsUntilRunning(t *testing.T) {
	responses := []string{
		`compute_ctl_up{status="init"} 1`,
		`compute_ctl_up{status="configuration_pending"} 1`,
		`compute_ctl_up{status="running"} 1`,
	}
	port := metricsServer(t, &responses)
	if err := WaitComputeReady(context.Background(), port, ReadyOpts{Timeout: 5 * time.Second, Interval: time.Millisecond}); err != nil {
		t.Fatal(err)
	}
}

func TestWaitComputeReadyFailsFastOnFailedStatus(t *testing.T) {
	responses := []string{`compute_ctl_up{status="failed"} 1`}
	port := metricsServer(t, &responses)
	err := WaitComputeReady(context.Background(), port, ReadyOpts{Timeout: 5 * time.Second, Interval: time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), `status="failed"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestWaitComputeReadyTimesOutNamingLastStatus(t *testing.T) {
	responses := []string{`compute_ctl_up{status="init"} 1`}
	port := metricsServer(t, &responses)
	err := WaitComputeReady(context.Background(), port, ReadyOpts{Timeout: 30 * time.Millisecond, Interval: time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "init") {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 2: Write the failing manager tests** — `internal/compute/manager_test.go` (complete file):

```go
package compute

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

// fakeProc satisfies Proc without spawning anything.
type fakeProc struct {
	mu       sync.Mutex
	state    engine.ProcState
	startErr error
	stopped  int
	opts     engine.ProcOpts
}

func (f *fakeProc) Start(ctx context.Context) error {
	if f.startErr != nil {
		f.mu.Lock()
		f.state = engine.StateFailed
		f.mu.Unlock()
		return f.startErr
	}
	f.mu.Lock()
	f.state = engine.StateRunning
	f.mu.Unlock()
	return nil
}
func (f *fakeProc) Stop(timeout time.Duration) { f.mu.Lock(); f.stopped++; f.state = engine.StateStopped; f.mu.Unlock() }
func (f *fakeProc) State() engine.ProcState    { f.mu.Lock(); defer f.mu.Unlock(); return f.state }

func testManager(t *testing.T, launch func(engine.ProcOpts) Proc, ready func(context.Context, int) error) *Manager {
	t.Helper()
	if ready == nil {
		ready = func(context.Context, int) error { return nil }
	}
	return NewManager(ManagerOpts{
		NeonBinDir:  "/usr/local/share/neon/bin",
		ComputesDir: filepath.Join(t.TempDir(), "computes"),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Launch:      launch,
		WaitReady:   ready,
	})
}

func startParams() StartParams {
	return StartParams{
		BranchID: "b1", BranchName: "main", Slug: "acme-main-abc123",
		TenantID: "11111111111111111111111111111111", TimelineID: "22222222222222222222222222222222",
		Password: "pw", PgbinPath: "/usr/local/share/neon/pg_install/v17/bin",
	}
}

func TestManagerStartWritesConfigAndLaunchesDetached(t *testing.T) {
	var captured engine.ProcOpts
	proc := &fakeProc{}
	m := testManager(t, func(o engine.ProcOpts) Proc { captured = o; proc.opts = o; return proc }, nil)
	port, err := m.Start(context.Background(), startParams())
	if err != nil {
		t.Fatal(err)
	}
	if port <= 0 {
		t.Fatalf("compute port = %d", port)
	}
	if !captured.Detached {
		t.Fatal("computes MUST run Detached (group kill reaches the postgres child)")
	}
	if captured.Name != "compute-acme-main-abc123" || !strings.HasSuffix(captured.Bin, "/compute_ctl") {
		t.Fatalf("opts = %+v", captured)
	}
	if captured.ReadyNeedle != "listening on IPv4 address" {
		t.Fatalf("needle = %q", captured.ReadyNeedle)
	}
	args := strings.Join(captured.Args, " ")
	for _, want := range []string{"--pgdata ", "--pgbin /usr/local/share/neon/pg_install/v17/bin",
		"--compute-id compute-22222222222222222222222222222222", "--config ",
		"--external-http-port ", "--internal-http-port "} {
		if !strings.Contains(args, want) {
			t.Fatalf("args missing %q: %s", want, args)
		}
	}
	// config.json + pg_hba.conf were written into the entry's dir
	var configPath string
	for i, a := range captured.Args {
		if a == "--config" {
			configPath = captured.Args[i+1]
		}
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(configPath), "pg_hba.conf")); err != nil {
		t.Fatal(err)
	}
	if m.StatusOf("b1") != "running" {
		t.Fatalf("status = %s", m.StatusOf("b1"))
	}
	if m.RunningPgbin("b1") != "/usr/local/share/neon/pg_install/v17/bin" || len(m.RunningPgbins()) != 1 {
		t.Fatal("pgbin must be tracked")
	}
}

func TestManagerStartFailureCleansUp(t *testing.T) {
	proc := &fakeProc{startErr: errors.New("spawn failed")}
	m := testManager(t, func(o engine.ProcOpts) Proc { return proc }, nil)
	if _, err := m.Start(context.Background(), startParams()); err == nil {
		t.Fatal("must surface the launch error")
	}
	if m.StatusOf("b1") != "stopped" {
		t.Fatalf("failed launch must leave no entry, status = %s", m.StatusOf("b1"))
	}
	// a fresh start after the failure is possible
	proc2 := &fakeProc{}
	m2 := testManager(t, func(o engine.ProcOpts) Proc { return proc2 }, nil)
	if _, err := m2.Start(context.Background(), startParams()); err != nil {
		t.Fatal(err)
	}
}

func TestManagerReadinessFailureStopsTheProc(t *testing.T) {
	proc := &fakeProc{}
	m := testManager(t, func(o engine.ProcOpts) Proc { return proc },
		func(ctx context.Context, port int) error { return errors.New("readiness timed out") })
	if _, err := m.Start(context.Background(), startParams()); err == nil {
		t.Fatal("readiness failure must surface")
	}
	if proc.stopped == 0 {
		t.Fatal("a live compute_ctl must be stopped when readiness fails — never orphaned")
	}
	if m.StatusOf("b1") != "stopped" {
		t.Fatalf("status = %s", m.StatusOf("b1"))
	}
}

func TestManagerDuplicateStartRefused(t *testing.T) {
	proc := &fakeProc{}
	m := testManager(t, func(o engine.ProcOpts) Proc { return proc }, nil)
	if _, err := m.Start(context.Background(), startParams()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(context.Background(), startParams()); err == nil ||
		!strings.Contains(err.Error(), "already") {
		t.Fatalf("duplicate start = %v", err)
	}
}

func TestManagerStopRemovesEntryAndDir(t *testing.T) {
	proc := &fakeProc{}
	var dir string
	m := testManager(t, func(o engine.ProcOpts) Proc {
		for i, a := range o.Args {
			if a == "--pgdata" {
				dir = filepath.Dir(o.Args[i+1])
			}
		}
		return proc
	}, nil)
	if _, err := m.Start(context.Background(), startParams()); err != nil {
		t.Fatal(err)
	}
	m.Stop("b1")
	if proc.stopped != 1 {
		t.Fatal("proc must be stopped")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("compute dir must be removed, stat err = %v", err)
	}
	if m.StatusOf("b1") != "stopped" || len(m.RunningPgbins()) != 0 {
		t.Fatal("entry must be gone")
	}
	m.Stop("b1") // idempotent
}

func TestManagerCrashReportsFailedAndFiresOnExit(t *testing.T) {
	proc := &fakeProc{}
	exited := make(chan struct{}, 1)
	p := startParams()
	p.OnExit = func() { exited <- struct{}{} }
	var opts engine.ProcOpts
	m := testManager(t, func(o engine.ProcOpts) Proc { opts = o; return proc }, nil)
	if _, err := m.Start(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	// simulate compute_ctl dying on its own
	proc.mu.Lock()
	proc.state = engine.StateFailed
	proc.mu.Unlock()
	opts.OnStateChange(engine.StateFailed)
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("OnExit must fire on a state change to failed")
	}
	if m.StatusOf("b1") != "failed" {
		t.Fatalf("status = %s", m.StatusOf("b1"))
	}
}

func TestManagerOnLineReachesSubscriber(t *testing.T) {
	proc := &fakeProc{}
	var lines []string
	p := startParams()
	p.OnLine = func(l string) { lines = append(lines, l) }
	var opts engine.ProcOpts
	m := testManager(t, func(o engine.ProcOpts) Proc { opts = o; return proc }, nil)
	if _, err := m.Start(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	opts.OnLine("hello from compute_ctl")
	if len(lines) != 1 || lines[0] != "hello from compute_ctl" {
		t.Fatalf("lines = %v", lines)
	}
}
```

- [ ] **Step 3: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/compute/ 2>&1 | tail -8`
Expected: compile errors (`undefined: ParseComputeCtlUpStatus`, `undefined: NewManager`, …).

- [ ] **Step 4: Write `internal/compute/readiness.go`** (complete file):

```go
package compute

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"
)

// Readiness gate for compute_ctl: poll its auth-exempt Prometheus /metrics
// (the --external-http-port) for compute_ctl_up{status="running"}, which
// compute_ctl sets strictly AFTER apply_spec commits. This closes the
// first-start SCRAM window the "listening on IPv4 address" log needle races
// (the needle fires ~80–140 ms early). /status is NOT usable: it demands a
// JWT against an empty jwks (permanent 400; --dev does not bypass).
var computeCtlUpRe = regexp.MustCompile(`(?m)^compute_ctl_up\{[^}]*status="([^"]+)"[^}]*\}\s+1(?:\.0+)?\s*$`)

func ParseComputeCtlUpStatus(metricsText string) (string, bool) {
	m := computeCtlUpRe.FindStringSubmatch(metricsText)
	if m == nil {
		return "", false
	}
	return m[1], true
}

type ReadyOpts struct {
	Timeout    time.Duration // default 50s
	Interval   time.Duration // default 100ms
	HTTPClient *http.Client  // default: 5s-per-attempt client
}

// WaitComputeReady polls until compute_ctl_up reports "running". Each attempt
// is individually time-boxed (the HTTP client timeout) so one hung connect
// can never eat the whole budget; status "failed" fails fast.
func WaitComputeReady(ctx context.Context, metricsPort int, opts ReadyOpts) error {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 50 * time.Second
	}
	interval := opts.Interval
	if interval == 0 {
		interval = 100 * time.Millisecond
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	deadline := time.Now().Add(timeout)
	last := "unreachable"
	url := fmt.Sprintf("http://127.0.0.1:%d/metrics", metricsPort)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return err
		}
		if res, err := client.Do(req); err == nil {
			raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
			_ = res.Body.Close()
			if res.StatusCode == 200 {
				if status, ok := ParseComputeCtlUpStatus(string(raw)); ok {
					last = status
					if status == "running" {
						return nil
					}
					if status == "failed" {
						return fmt.Errorf(`compute_ctl reported status="failed" on metrics port %d`, metricsPort)
					}
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("compute readiness timed out after %s (last status=%s) on :%d", timeout, last, metricsPort)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}
```

- [ ] **Step 5: Write `internal/compute/manager.go`** (complete file):

```go
package compute

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

// Proc is the slice of engine.Process the manager drives — a seam so unit
// tests never spawn real processes.
type Proc interface {
	Start(ctx context.Context) error
	Stop(timeout time.Duration)
	State() engine.ProcState
}

type ManagerOpts struct {
	NeonBinDir  string
	ComputesDir string
	Log         *slog.Logger
	// Engine ports baked into every compute spec — single-sourced from
	// config by the caller (defaults cover tests).
	PageserverPg int
	SafekeeperPg int
	// Launch constructs the child process handle; nil = real engine.Process.
	Launch func(engine.ProcOpts) Proc
	// WaitReady blocks until the compute is serving with its spec applied;
	// nil = the real /metrics poller (WaitComputeReady with defaults).
	WaitReady func(ctx context.Context, metricsPort int) error
}

type computeEntry struct {
	proc        Proc
	computePort int
	dir         string
	pgbin       string
	phase       string // starting | running | stopping
}

// Manager owns the compute processes, one per branch. Concurrency posture:
// per-branch serialization is provided by the caller (each branch's owner
// lane runs at most one Start/Stop for that branch at a time), and StopAll
// runs only after every owner has quiesced at shutdown — so a mutex around
// the entries map plus per-entry phases is sufficient here.
type Manager struct {
	opts    ManagerOpts
	mu      sync.Mutex
	entries map[string]*computeEntry
}

func NewManager(o ManagerOpts) *Manager {
	if o.PageserverPg == 0 {
		o.PageserverPg = 64000
	}
	if o.SafekeeperPg == 0 {
		o.SafekeeperPg = 5454
	}
	if o.Launch == nil {
		o.Launch = func(po engine.ProcOpts) Proc { return engine.NewProcess(po) }
	}
	if o.WaitReady == nil {
		o.WaitReady = func(ctx context.Context, metricsPort int) error {
			return WaitComputeReady(ctx, metricsPort, ReadyOpts{})
		}
	}
	return &Manager{opts: o, entries: map[string]*computeEntry{}}
}

type StartParams struct {
	BranchID   string
	BranchName string
	Slug       string
	TenantID   string
	TimelineID string
	Password   string
	PgbinPath  string
	// OnLine receives every compute_ctl output line (registered before launch
	// so failure output is never missed). OnExit fires when the process
	// leaves the running state on its own — it is dispatched from the
	// Process's OnStateChange (which runs under the Process mutex), so it
	// must be non-blocking and must not call back into this Manager.
	OnLine func(string)
	OnExit func()
}

// ephemeralPort asks the kernel for a free loopback port by binding :0 and
// releasing it. The tiny hand-back window is acceptable: only this daemon's
// own children bind loopback ports inside the container, and the kernel
// avoids immediately reissuing just-released ephemeral ports.
func ephemeralPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		return 0, err
	}
	return port, nil
}

// Start launches the branch's compute and blocks until it is ready to serve
// with its spec applied. On any failure everything acquired is torn back
// down and no entry remains.
func (m *Manager) Start(ctx context.Context, p StartParams) (int, error) {
	m.mu.Lock()
	if _, exists := m.entries[p.BranchID]; exists {
		status := m.statusLocked(p.BranchID)
		m.mu.Unlock()
		return 0, fmt.Errorf("endpoint for branch %s already %s", p.BranchName, status)
	}
	entry := &computeEntry{pgbin: p.PgbinPath, phase: "starting"}
	m.entries[p.BranchID] = entry
	m.mu.Unlock()

	port, err := m.launch(ctx, p, entry)
	if err != nil {
		// Failure cleanup: stop whatever launched, then remove entry + dir.
		if entry.proc != nil {
			entry.proc.Stop(30 * time.Second)
		}
		if entry.dir != "" {
			if rmErr := os.RemoveAll(entry.dir); rmErr != nil {
				m.opts.Log.Error("compute start cleanup: dir removal failed", "dir", entry.dir, "err", rmErr)
			}
		}
		m.mu.Lock()
		delete(m.entries, p.BranchID)
		m.mu.Unlock()
		return 0, err
	}
	m.mu.Lock()
	entry.phase = "running"
	m.mu.Unlock()
	return port, nil
}

func (m *Manager) launch(ctx context.Context, p StartParams, entry *computeEntry) (int, error) {
	computePort, err := ephemeralPort()
	if err != nil {
		return 0, err
	}
	metricsPort, err := ephemeralPort()
	if err != nil {
		return 0, err
	}
	internalPort, err := ephemeralPort()
	if err != nil {
		return 0, err
	}
	entry.computePort = computePort

	if err := os.MkdirAll(m.opts.ComputesDir, 0o755); err != nil {
		return 0, err
	}
	dir, err := os.MkdirTemp(m.opts.ComputesDir, "compute_"+p.TimelineID+"_")
	if err != nil {
		return 0, err
	}
	entry.dir = dir
	hbaPath := filepath.Join(dir, "pg_hba.conf")
	if err := os.WriteFile(hbaPath, []byte(PGHBA), 0o644); err != nil {
		return 0, err
	}
	specJSON, err := ConfigJSON(SpecParams{
		TenantID: p.TenantID, TimelineID: p.TimelineID, Port: computePort,
		HBAPath: hbaPath, Password: p.Password,
		PageserverPg: m.opts.PageserverPg, SafekeeperPg: m.opts.SafekeeperPg,
	})
	if err != nil {
		return 0, err
	}
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte(specJSON), 0o644); err != nil {
		return 0, err
	}

	// oracle: neon compute_tools/src/bin/compute_ctl.rs Cli struct (--pgdata/
	// --pgbin/--connstr/--compute-id/--config/--external-http-port/
	// --internal-http-port). An explicit --internal-http-port per compute is
	// required: the default 3081 collides across concurrent computes. The
	// "listening on IPv4 address" needle is only the process-start gate; the
	// /metrics poll (WaitReady) is the readiness gate.
	opts := engine.ProcOpts{
		Name: "compute-" + p.Slug,
		Bin:  filepath.Join(m.opts.NeonBinDir, "compute_ctl"),
		Args: []string{
			"--pgdata", filepath.Join(dir, "pg_data"),
			"--pgbin", p.PgbinPath,
			"--compute-id", "compute-" + p.TimelineID,
			"--connstr", fmt.Sprintf("postgresql://cloud_admin@localhost:%d/postgres", computePort),
			"--config", configPath,
			"--external-http-port", fmt.Sprintf("%d", metricsPort),
			"--internal-http-port", fmt.Sprintf("%d", internalPort),
		},
		ReadyNeedle:  "listening on IPv4 address",
		ReadyTimeout: 50 * time.Second,
		// Group kill on stop: compute_ctl orphans its postgres child on
		// SIGTERM instead of waiting for it; only a process-group signal
		// reaches the whole tree.
		Detached: true,
		OnLine:   p.OnLine,
		// Runs under the Process mutex — forward the signal and nothing else.
		OnStateChange: func(st engine.ProcState) {
			if st == engine.StateFailed && p.OnExit != nil {
				p.OnExit()
			}
		},
	}
	proc := m.opts.Launch(opts)
	entry.proc = proc
	if err := proc.Start(ctx); err != nil {
		return 0, err
	}
	if err := m.opts.WaitReady(ctx, metricsPort); err != nil {
		return 0, err
	}
	return computePort, nil
}

// Stop tears the branch's compute down completely: group-kill (Process.Stop
// confirms the whole group gone before returning, so nothing still writes
// into the directory), then remove the compute dir, then drop the entry.
// Total: failures are logged, never returned — a stop must always settle.
func (m *Manager) Stop(branchID string) {
	m.mu.Lock()
	entry, ok := m.entries[branchID]
	if !ok {
		m.mu.Unlock()
		return
	}
	entry.phase = "stopping"
	m.mu.Unlock()

	if entry.proc != nil {
		entry.proc.Stop(30 * time.Second)
	}
	if entry.dir != "" {
		if err := os.RemoveAll(entry.dir); err != nil {
			m.opts.Log.Error("compute stop: dir removal failed", "dir", entry.dir, "err", err)
		}
	}
	m.mu.Lock()
	delete(m.entries, branchID)
	m.mu.Unlock()
}

// StopAll is shutdown-only: callers guarantee no concurrent Start (owners
// have quiesced by the time this runs).
func (m *Manager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.entries))
	for id := range m.entries {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Stop(id)
	}
}

func (m *Manager) StatusOf(branchID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked(branchID)
}

func (m *Manager) statusLocked(branchID string) string {
	entry, ok := m.entries[branchID]
	if !ok {
		return "stopped"
	}
	if entry.phase == "stopping" {
		return "stopping"
	}
	if entry.proc == nil {
		return "starting"
	}
	switch entry.proc.State() {
	case engine.StateRunning:
		if entry.phase == "starting" {
			return "starting" // needle fired but the spec-applied gate hasn't passed
		}
		return "running"
	case engine.StateFailed, engine.StateStopped:
		return "failed"
	default:
		return "starting"
	}
}

// RunningPgbin/RunningPgbins report which install paths computes currently
// hold open, regardless of phase — the in-use protocol a future build-removal
// guard consults before deleting an install.
func (m *Manager) RunningPgbin(branchID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.entries[branchID]; ok {
		return e.pgbin
	}
	return ""
}

func (m *Manager) RunningPgbins() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.entries))
	for _, e := range m.entries {
		out = append(out, e.pgbin)
	}
	return out
}
```

`ManagerOpts.PageserverPg/SafekeeperPg` keep the engine ports single-sourced: Task 14 passes `cfg.Engine.PageserverPg`/`cfg.Engine.SafekeeperPg`; the zero-value defaults only serve tests.

- [ ] **Step 6: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/compute/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/compute && git commit -m "feat(compute): manager with detached compute_ctl launch, metrics readiness, group-kill stop"
```

---

### Task 7: proxy — slot table + bind-on-running L4 splice

The daemon permanently owns the published port range as **slots**. A branch endpoint claims a slot while starting (`Reserve` — sticky `port_slot` preferred, else lowest free), gets a real listener only once its compute is up (`Bind`), and loses both on stop (`Release`) — so a stopped endpoint yields ECONNREFUSED, byte-identical to a process that isn't listening. The listener accepts on all interfaces (docker-proxy delivers published traffic from the bridge), dials the compute's loopback port, and splices bytes both ways with no protocol awareness — SCRAM and the SSLRequest dance pass through as bytes. Per-endpoint live connection counts are tracked now (the suspend milestone's idle signal) but consumed by nothing yet.

**Files:**
- Create: `~/git/worktreedb/internal/proxy/proxy.go`
- Create: `~/git/worktreedb/internal/proxy/proxy_test.go`

**Interfaces:**
- Consumes: `config.PortRange`.
- Produces:
  - `var ErrExhausted = errors.New("no free endpoint port in range")`
  - `func New(rng config.PortRange, log *slog.Logger) *Proxy`
  - `func (p *Proxy) Reserve(branchID string, sticky *int) (int, error)` — claims a slot (no listener yet); idempotent for a branch that already holds one (returns it).
  - `func (p *Proxy) Bind(branchID string, computePort int) error` — listener on `:<slot>`, splice to `127.0.0.1:<computePort>`.
  - `func (p *Proxy) Release(branchID string)` — closes the listener AND all live spliced connections, frees the slot; no-op when the branch holds nothing.
  - `func (p *Proxy) SlotOf(branchID string) (int, bool)` · `func (p *Proxy) ConnCount(branchID string) int64` (0 when unbound).
  - `func (p *Proxy) Shutdown()` — Release everything (daemon shutdown).

- [ ] **Step 1: Write the failing tests** — `internal/proxy/proxy_test.go` (complete file):

```go
package proxy

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

// echoBackend simulates a compute: accepts loopback connections and echoes
// bytes back with a prefix, so the test proves BOTH directions of the splice.
func echoBackend(t *testing.T) (port int, closeFn func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1024)
				for {
					n, err := c.Read(buf)
					if err != nil {
						return
					}
					if _, err := c.Write(append([]byte("echo:"), buf[:n]...)); err != nil {
						return
					}
				}
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, func() { _ = ln.Close() }
}

func freeRange(t *testing.T, n int) config.PortRange {
	t.Helper()
	// Find n consecutive free ports by binding :0 once and probing upward.
	// Test-only heuristic: bind the candidates to confirm.
	base := 0
	for attempt := 0; attempt < 50; attempt++ {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		start := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		ok := true
		var held []net.Listener
		for i := 0; i < n; i++ {
			l, err := net.Listen("tcp", fmt.Sprintf(":%d", start+i))
			if err != nil {
				ok = false
				break
			}
			held = append(held, l)
		}
		for _, l := range held {
			_ = l.Close()
		}
		if ok {
			base = start
			break
		}
	}
	if base == 0 {
		t.Fatal("could not find a free port range")
	}
	return config.PortRange{Min: base, Max: base + n - 1}
}

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestReserveStickyAndLowestFree(t *testing.T) {
	rng := config.PortRange{Min: 54300, Max: 54302} // Reserve never binds, so any range works
	p := New(rng, testLog())
	sticky := 54301
	got, err := p.Reserve("b1", &sticky)
	if err != nil || got != 54301 {
		t.Fatalf("sticky reserve = %d, %v", got, err)
	}
	got2, err := p.Reserve("b2", nil)
	if err != nil || got2 != 54300 {
		t.Fatalf("lowest-free reserve = %d, %v", got2, err)
	}
	// idempotent for the same branch
	again, err := p.Reserve("b1", nil)
	if err != nil || again != 54301 {
		t.Fatalf("re-reserve = %d, %v", again, err)
	}
	// out-of-range sticky is ignored, not an error
	badSticky := 99999
	got3, err := p.Reserve("b3", &badSticky)
	if err != nil || got3 != 54302 {
		t.Fatalf("out-of-range sticky = %d, %v", got3, err)
	}
	if _, err := p.Reserve("b4", nil); !errors.Is(err, ErrExhausted) {
		t.Fatalf("exhaustion = %v", err)
	}
	p.Release("b2")
	got4, err := p.Reserve("b4", nil)
	if err != nil || got4 != 54300 {
		t.Fatalf("released slot must be reusable: %d, %v", got4, err)
	}
}

func TestBindSpliceAndConnCount(t *testing.T) {
	backendPort, closeBackend := echoBackend(t)
	defer closeBackend()
	rng := freeRange(t, 2)
	p := New(rng, testLog())
	slot, err := p.Reserve("b1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Bind("b1", backendPort); err != nil {
		t.Fatal(err)
	}
	defer p.Release("b1")

	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", slot))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := conn.Read(buf)
	if err != nil || string(buf[:n]) != "echo:ping" {
		t.Fatalf("splice round-trip = %q, %v", buf[:n], err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for p.ConnCount("b1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := p.ConnCount("b1"); got != 1 {
		t.Fatalf("ConnCount = %d, want 1", got)
	}
	_ = conn.Close()
	for p.ConnCount("b1") != 0 && time.Now().Before(deadline.Add(2*time.Second)) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := p.ConnCount("b1"); got != 0 {
		t.Fatalf("ConnCount after close = %d, want 0", got)
	}
}

func TestReleaseYieldsConnectionRefusedAndKillsLiveConns(t *testing.T) {
	backendPort, closeBackend := echoBackend(t)
	defer closeBackend()
	rng := freeRange(t, 2)
	p := New(rng, testLog())
	slot, _ := p.Reserve("b1", nil)
	if err := p.Bind("b1", backendPort); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", slot))
	if err != nil {
		t.Fatal(err)
	}
	p.Release("b1")
	// live connection is torn down
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("read on a released endpoint's connection must fail")
	}
	_ = conn.Close()
	// new connections are refused — the stopped-endpoint contract
	if _, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", slot), time.Second); err == nil {
		t.Fatal("dial after Release must be refused")
	} else if !strings.Contains(err.Error(), "refus") && !strings.Contains(err.Error(), "reset") {
		t.Logf("note: refusal surfaced as %v (acceptable, platform-dependent)", err)
	}
	if _, ok := p.SlotOf("b1"); ok {
		t.Fatal("slot must be freed")
	}
}

func TestBindWithoutReserveFails(t *testing.T) {
	p := New(config.PortRange{Min: 54300, Max: 54301}, testLog())
	if err := p.Bind("nope", 12345); err == nil {
		t.Fatal("Bind without Reserve must fail")
	}
}

func TestDialFailureClosesClientConn(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	slot, _ := p.Reserve("b1", nil)
	// backend port that nothing listens on
	if err := p.Bind("b1", 1); err != nil {
		t.Fatal(err)
	}
	defer p.Release("b1")
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", slot))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 8)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("client conn must be closed when the backend dial fails")
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/proxy/ 2>&1 | tail -5`
Expected: compile errors (package missing / undefined symbols).

- [ ] **Step 3: Write `internal/proxy/proxy.go`** (complete file):

```go
// Package proxy owns the daemon's published endpoint ports as SLOTS: the
// port range is the daemon's for its whole life; a branch endpoint claims a
// slot while starting, gets a listener only while it is logically running
// (bind-on-running: a stopped endpoint refuses connections exactly like a
// process that isn't there), and traffic is spliced at L4 to the compute's
// ephemeral loopback port with no protocol awareness — SCRAM and the
// SSLRequest dance pass through as bytes. Owning the range as slots deletes
// the probe-for-a-free-port race class outright: allocation is a map lookup
// under one mutex, and nothing else in the container ever binds these ports.
package proxy

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

var ErrExhausted = errors.New("no free endpoint port in range")

type endpoint struct {
	slot     int
	target   string // 127.0.0.1:<computePort>, "" until Bind
	listener net.Listener
	conns    map[net.Conn]struct{} // client-side conns, for teardown
	connsMu  sync.Mutex
	live     atomic.Int64 // per-endpoint live connection count (the future idle signal)
	closed   atomic.Bool
}

type Proxy struct {
	rng config.PortRange
	log *slog.Logger

	mu       sync.Mutex
	bySlot   map[int]*endpoint
	byBranch map[string]*endpoint
}

func New(rng config.PortRange, log *slog.Logger) *Proxy {
	return &Proxy{rng: rng, log: log, bySlot: map[int]*endpoint{}, byBranch: map[string]*endpoint{}}
}

// Reserve claims a slot for the branch without binding it: the claim exists
// for the whole starting→running→stopping arc so two concurrently starting
// branches can never settle on the same slot. Sticky (the branch's persisted
// port_slot) is preferred when free and in range; otherwise the lowest free
// slot wins. Idempotent per branch.
func (p *Proxy) Reserve(branchID string, sticky *int) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.byBranch[branchID]; ok {
		return e.slot, nil
	}
	slot := 0
	if sticky != nil && *sticky >= p.rng.Min && *sticky <= p.rng.Max {
		if _, taken := p.bySlot[*sticky]; !taken {
			slot = *sticky
		}
	}
	if slot == 0 {
		for s := p.rng.Min; s <= p.rng.Max; s++ {
			if _, taken := p.bySlot[s]; !taken {
				slot = s
				break
			}
		}
	}
	if slot == 0 {
		return 0, ErrExhausted
	}
	e := &endpoint{slot: slot, conns: map[net.Conn]struct{}{}}
	p.bySlot[slot] = e
	p.byBranch[branchID] = e
	return slot, nil
}

// Bind opens the slot's listener and starts splicing to the compute. The
// listener binds all interfaces: published traffic arrives from the bridge
// (docker-proxy), in-container clients use loopback.
func (p *Proxy) Bind(branchID string, computePort int) error {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("proxy: branch %s holds no reserved slot", branchID)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", e.slot))
	if err != nil {
		return fmt.Errorf("proxy: bind slot %d: %w", e.slot, err)
	}
	e.target = fmt.Sprintf("127.0.0.1:%d", computePort)
	e.listener = ln
	go p.acceptLoop(e)
	return nil
}

func (p *Proxy) acceptLoop(e *endpoint) {
	for {
		client, err := e.listener.Accept()
		if err != nil {
			return // listener closed (Release) — the loop's only exit
		}
		go p.splice(e, client)
	}
}

// splice joins one client connection to the compute: dial the backend, then
// copy bytes both ways until either side ends. goroutine-per-connection;
// *net.TCPConn copies use the kernel path (sendfile/splice) where available.
func (p *Proxy) splice(e *endpoint, client net.Conn) {
	backend, err := net.DialTimeout("tcp", e.target, 10*time.Second)
	if err != nil {
		p.log.Warn("proxy: backend dial failed", "target", e.target, "err", err)
		_ = client.Close()
		return
	}
	e.connsMu.Lock()
	if e.closed.Load() {
		e.connsMu.Unlock()
		_ = client.Close()
		_ = backend.Close()
		return
	}
	e.conns[client] = struct{}{}
	e.connsMu.Unlock()
	e.live.Add(1)
	defer func() {
		e.live.Add(-1)
		e.connsMu.Lock()
		delete(e.conns, client)
		e.connsMu.Unlock()
		_ = client.Close()
		_ = backend.Close()
	}()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(backend, client); halfClose(backend); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, backend); halfClose(client); done <- struct{}{} }()
	<-done
	<-done
}

// halfClose signals EOF to the peer without dropping the other direction —
// a client that finishes sending (COPY … \. ) still reads its results.
func halfClose(c net.Conn) {
	if tcp, ok := c.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
}

// Release closes the listener AND every live spliced connection, then frees
// the slot. This is the stop path: new connections are refused immediately
// (bind-on-running) and in-flight ones die with the endpoint.
func (p *Proxy) Release(branchID string) {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	if ok {
		delete(p.byBranch, branchID)
		delete(p.bySlot, e.slot)
	}
	p.mu.Unlock()
	if !ok {
		return
	}
	e.closed.Store(true)
	if e.listener != nil {
		_ = e.listener.Close()
	}
	e.connsMu.Lock()
	for c := range e.conns {
		_ = c.Close()
	}
	e.connsMu.Unlock()
}

func (p *Proxy) SlotOf(branchID string) (int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.byBranch[branchID]; ok {
		return e.slot, true
	}
	return 0, false
}

// ConnCount is the live spliced-connection count for the branch's endpoint —
// tracked now, consumed by the suspend milestone's idle sweeper later.
func (p *Proxy) ConnCount(branchID string) int64 {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	p.mu.Unlock()
	if !ok {
		return 0
	}
	return e.live.Load()
}

// Shutdown releases every endpoint (daemon shutdown).
func (p *Proxy) Shutdown() {
	p.mu.Lock()
	ids := make([]string, 0, len(p.byBranch))
	for id := range p.byBranch {
		ids = append(ids, id)
	}
	p.mu.Unlock()
	for _, id := range ids {
		p.Release(id)
	}
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/proxy/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/proxy && git commit -m "feat(proxy): slot-owned endpoint ports with bind-on-running l4 splice and conn counts"
```

---

### Task 8: service — core, owner registry, endpoint convergence

The heart of the milestone: `internal/service` is the orchestration seam between the API (which writes spec) and the resources (whose owners write status). This is a plan-level refinement of spec §4's package list — putting orchestration inside `api` would blur the "handlers never write status" boundary. This task delivers the `Core` aggregate with narrow dependency interfaces (unit tests use typed fakes — no processes, no sockets), the per-branch **owner registry** (owners created/destroyed with their branch — the runtime framework's first dynamic multi-owner use), and the **endpoint converge**: the loop that drives observed endpoint state to spec, with generation-checked commits, event emission on every persisted transition, sticky slots, and the port-exhaustion 409.

Convergence rules (encode exactly):
- The API start/stop paths write `spec_endpoint` + bump the generation, then run one synchronous converge (`Owner.Do`).
- A converge observing `observed_generation == spec_generation` with reality matching the row is done. `status_endpoint == "failed"` at the current generation is **terminal until the spec generation moves** — a crashed compute is never silently restarted; the user's next start (gen bump) recovers it.
- A commit rejected with `store.ErrStaleGeneration` means the spec moved mid-flight (stop-during-start): abandon, loop, re-read — the newer spec wins. Never clobber.
- Every commit that changes `(status_endpoint, status_port)` publishes `endpoint.status`.
- Order on start: reserve slot → resolve pgbin → commit `starting` → compute Start (+readiness) → proxy Bind → commit `running` (+ sticky `port_slot`). Order on stop: commit `stopping` → proxy Release (new conns refused immediately) → compute Stop (group kill) → commit `stopped`.

**Files:**
- Create: `~/git/worktreedb/internal/service/core.go`
- Create: `~/git/worktreedb/internal/service/errors.go`
- Create: `~/git/worktreedb/internal/service/slug.go`
- Create: `~/git/worktreedb/internal/service/registry.go`
- Create: `~/git/worktreedb/internal/service/endpoints.go`
- Create: `~/git/worktreedb/internal/service/fakes_test.go`
- Create: `~/git/worktreedb/internal/service/endpoints_test.go`
- Create: `~/git/worktreedb/internal/service/registry_test.go`

**Interfaces:**
- Consumes: Tasks 1–7 (`store` rows + `CommitStatus`, `runtime.Owner.Do/Run/Nudge`, `engine` client types, `events.Bus/LogHub`, `compute.Manager` shape, `proxy.Proxy` shape).
- Produces:
  - `type Error struct { Status int; Message string }` with `Error() string` = Message; `func Errf(status int, format string, a ...any) *Error`.
  - `func Slugify(parts ...string) string` — lowercase, non-alphanumeric runs → `-`, trim, join with `-`, drop empties.
  - `type StorconAPI / PageserverAPI / SafekeeperAPI / ComputeAPI / ProxyAPI interface` — narrow method sets (below) satisfied structurally by the real clients/manager/proxy.
  - `type Core struct` (fields below) — later tasks add methods to this same struct in sibling files.
  - `func NewRegistry(rootCtx context.Context, log *slog.Logger) *Registry` · `(r *Registry) Add(branchID string, converge func(context.Context) error) *runtime.Owner` (idempotent) · `Get(branchID) (*runtime.Owner, bool)` · `Remove(branchID)` (cancel + wait + delete) · `Shutdown()`.
  - `func (c *Core) RegisterBranchOwner(branchID string) *runtime.Owner`
  - `func (c *Core) StartEndpoint(ctx, branchID string) (BranchDetail, error)` · `StopEndpoint` · `EnsureRunning` (same as StartEndpoint — one queued body, so the check runs inside the lane) · `func (c *Core) BranchDetail(ctx, branchID string) (BranchDetail, error)` · `func (c *Core) EndpointStatus(ctx, branchID string) (status string, port *int, err error)`.
  - `type BranchDetail struct { Row store.BranchRow; ConnectionString, JdbcURL *string; LastRecordLsn *string; LogicalSizeBytes *int64; AncestorLsn *string }`
  - `func (c *Core) setSpecAndConvergeLocked(ctx, branchID, spec string) error` — for jobs already holding the branch's lane (Task 11's restore steps).
  - `func ConnectionString(password string, port int) string` · `func JdbcURL(password string, port int) string`.

- [ ] **Step 1: Write the typed fakes** — `internal/service/fakes_test.go` (complete file; every service test task reuses these):

```go
package service

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/proxy"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

type fakeStorcon struct {
	mu            sync.Mutex
	tenants       []string
	createErr     error
	lsn           engine.LsnByTimestamp
	lsnErr        error
	lastTimestamp string
}

func (f *fakeStorcon) TenantCreate(ctx context.Context, tenantID string, cfg engine.TenantConfig) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return f.createErr
	}
	f.tenants = append(f.tenants, tenantID)
	return nil
}

func (f *fakeStorcon) GetLsnByTimestamp(ctx context.Context, tenantID, timelineID, isoTimestamp string) (engine.LsnByTimestamp, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastTimestamp = isoTimestamp
	if f.lsnErr != nil {
		return engine.LsnByTimestamp{}, f.lsnErr
	}
	if f.lsn.LSN == "" {
		return engine.LsnByTimestamp{LSN: "0/1000", Kind: "present"}, nil
	}
	return f.lsn, nil
}

type timelineCall struct {
	Tenant string
	Req    engine.TimelineCreateRequest
}

type fakePageserver struct {
	mu           sync.Mutex
	creates      []timelineCall
	deletes      []string // "tenant/timeline"
	tenantDels   []string
	createErr    error
	detachErr    error
	infoErr      error
	reparented   []string
	info         engine.TimelineInfo
}

func (f *fakePageserver) TimelineCreate(ctx context.Context, tenantID string, req engine.TimelineCreateRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return f.createErr
	}
	f.creates = append(f.creates, timelineCall{Tenant: tenantID, Req: req})
	return nil
}

func (f *fakePageserver) TimelineInfo(ctx context.Context, tenantID, timelineID string) (engine.TimelineInfo, error) {
	if f.infoErr != nil {
		return engine.TimelineInfo{}, f.infoErr
	}
	return f.info, nil
}

func (f *fakePageserver) TimelineDelete(ctx context.Context, tenantID, timelineID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, tenantID+"/"+timelineID)
	return nil
}

func (f *fakePageserver) TimelineDetachAncestor(ctx context.Context, tenantID, timelineID string) (engine.DetachAncestorResult, error) {
	if f.detachErr != nil {
		return engine.DetachAncestorResult{}, f.detachErr
	}
	return engine.DetachAncestorResult{ReparentedTimelines: f.reparented}, nil
}

func (f *fakePageserver) TenantDelete(ctx context.Context, tenantID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenantDels = append(f.tenantDels, tenantID)
	return nil
}

type fakeSafekeeper struct {
	mu         sync.Mutex
	deletes    []string
	tenantDels []string
}

func (f *fakeSafekeeper) TimelineDelete(ctx context.Context, tenantID, timelineID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, tenantID+"/"+timelineID)
	return nil
}

func (f *fakeSafekeeper) TenantDelete(ctx context.Context, tenantID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tenantDels = append(f.tenantDels, tenantID)
	return nil
}

type fakeComputes struct {
	mu       sync.Mutex
	status   map[string]string // branchID → status ("stopped" default)
	ports    map[string]int
	startErr error
	starts   []compute.StartParams
	stops    []string
	nextPort int
}

func newFakeComputes() *fakeComputes {
	return &fakeComputes{status: map[string]string{}, ports: map[string]int{}, nextPort: 43000}
}

func (f *fakeComputes) Start(ctx context.Context, p compute.StartParams) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.startErr != nil {
		return 0, f.startErr
	}
	f.starts = append(f.starts, p)
	f.nextPort++
	f.status[p.BranchID] = "running"
	f.ports[p.BranchID] = f.nextPort
	return f.nextPort, nil
}

func (f *fakeComputes) Stop(branchID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, branchID)
	delete(f.status, branchID)
	delete(f.ports, branchID)
}

func (f *fakeComputes) StatusOf(branchID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.status[branchID]; ok {
		return s
	}
	return "stopped"
}

func (f *fakeComputes) RunningPgbins() []string { return nil }
func (f *fakeComputes) StopAll()                {}

type fakeProxy struct {
	mu       sync.Mutex
	slots    map[string]int
	bound    map[string]int // branchID → computePort
	min      int
	max      int
	reserves int
}

func newFakeProxy(min, max int) *fakeProxy {
	return &fakeProxy{slots: map[string]int{}, bound: map[string]int{}, min: min, max: max}
}

func (f *fakeProxy) Reserve(branchID string, sticky *int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reserves++
	if s, ok := f.slots[branchID]; ok {
		return s, nil
	}
	taken := map[int]bool{}
	for _, s := range f.slots {
		taken[s] = true
	}
	if sticky != nil && *sticky >= f.min && *sticky <= f.max && !taken[*sticky] {
		f.slots[branchID] = *sticky
		return *sticky, nil
	}
	for s := f.min; s <= f.max; s++ {
		if !taken[s] {
			f.slots[branchID] = s
			return s, nil
		}
	}
	return 0, proxy.ErrExhausted // the REAL sentinel — converge classification is tested against it
}

func (f *fakeProxy) Bind(branchID string, computePort int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bound[branchID] = computePort
	return nil
}

func (f *fakeProxy) Release(branchID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.slots, branchID)
	delete(f.bound, branchID)
}

func (f *fakeProxy) ConnCount(branchID string) int64 { return 0 }

// newTestCore builds a Core over the fakes plus a real on-disk store and a
// real registry — the concurrency seams under test are the real ones.
type testCore struct {
	core    *Core
	st      *store.Store
	storcon *fakeStorcon
	ps      *fakePageserver
	sk      *fakeSafekeeper
	comps   *fakeComputes
	prox    *fakeProxy
	bus     *events.Bus
	hub     *events.LogHub
	cancel  context.CancelFunc
}

func newTestCore(t *testing.T) *testCore {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	tc := &testCore{
		st: st, storcon: &fakeStorcon{}, ps: &fakePageserver{}, sk: &fakeSafekeeper{},
		comps: newFakeComputes(), prox: newFakeProxy(54300, 54301),
		bus: events.NewBus(), hub: events.NewLogHub(), cancel: cancel,
	}
	tc.core = &Core{
		Cfg:        &config.Config{PortRange: config.PortRange{Min: 54300, Max: 54301}, PgInstallDir: "/pg", Engine: config.EnginePorts{}},
		Store:      st,
		Storcon:    tc.storcon,
		Pageserver: tc.ps,
		Safekeeper: tc.sk,
		Computes:   tc.comps,
		Proxy:      tc.prox,
		Hub:        tc.hub,
		Bus:        tc.bus,
		Owners:     NewRegistry(ctx, log),
		Log:        log,
		PgbinFor:   func(major int) (string, error) { return "/pg/v17/bin", nil },
		InstalledMajors: func() []int { return []int{14, 15, 16, 17} },
	}
	t.Cleanup(tc.core.Owners.Shutdown)
	return tc
}

// seedBranch inserts a project + branch directly and registers its owner —
// the fixture for endpoint/timetravel tests that don't exercise create.
func (tc *testCore) seedBranch(t *testing.T, projectID, branchID string) store.BranchRow {
	t.Helper()
	ctx := context.Background()
	if _, ok, err := tc.st.ProjectByID(ctx, projectID); err != nil {
		t.Fatal(err)
	} else if !ok {
		if _, err := tc.st.CreateProject(ctx, store.ProjectParams{ID: projectID, Name: "proj-" + projectID, PgMajor: 17}); err != nil {
			t.Fatal(err)
		}
	}
	b, err := tc.st.CreateBranch(ctx, store.BranchParams{
		ID: branchID, ProjectID: projectID, Name: "main", Slug: "proj-main-" + branchID,
		TimelineID: engineID(branchID), Password: "PW" + branchID, CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	tc.core.RegisterBranchOwner(branchID)
	return b
}

// engineID derives a deterministic 32-hex id from a seed (test-only).
func engineID(seed string) string {
	const hexdig = "0123456789abcdef"
	out := make([]byte, 32)
	for i := range out {
		out[i] = hexdig[(i+len(seed)+int(seed[i%len(seed)]))%16]
	}
	return string(out)
}
```

The fakes file imports `github.com/VanGoghSoftware/worktreedb/internal/proxy` solely for the `proxy.ErrExhausted` sentinel — the converge's exhaustion classification is tested against the true value, never a lookalike.

- [ ] **Step 2: Write the failing endpoint/registry tests** — `internal/service/endpoints_test.go` (complete file):

```go
package service

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
)

func collectEvents(tc *testCore) (*[]events.Event, func()) {
	var mu sync.Mutex
	var got []events.Event
	unsub := tc.bus.Subscribe(func(e events.Event) { mu.Lock(); got = append(got, e); mu.Unlock() })
	return &got, unsub
}

func TestStartEndpointHappyPath(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	evts, unsub := collectEvents(tc)
	defer unsub()

	d, err := tc.core.StartEndpoint(context.Background(), "b1")
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.StatusEndpoint != "running" || d.Row.StatusPort == nil || *d.Row.StatusPort != 54300 {
		t.Fatalf("detail = %+v", d.Row)
	}
	if d.Row.PortSlot == nil || *d.Row.PortSlot != 54300 {
		t.Fatal("sticky slot must persist")
	}
	if d.ConnectionString == nil || *d.ConnectionString != "postgresql://postgres:PWb1@127.0.0.1:54300/postgres" {
		t.Fatalf("connectionString = %v", d.ConnectionString)
	}
	if d.JdbcURL == nil || *d.JdbcURL != "jdbc:postgresql://127.0.0.1:54300/postgres?user=postgres&password=PWb1&sslmode=disable" {
		t.Fatalf("jdbcUrl = %v", d.JdbcURL)
	}
	// proxy bound to the compute port the manager returned
	if tc.prox.bound["b1"] == 0 {
		t.Fatal("proxy must be bound")
	}
	// events: starting then running
	var kinds []string
	for _, e := range *evts {
		if e.Type == "endpoint.status" {
			kinds = append(kinds, e.Type)
		}
	}
	if len(kinds) < 2 {
		t.Fatalf("expected >=2 endpoint.status events (starting, running), got %d", len(kinds))
	}
	// idempotent second start: no compute restart, no extra events
	before := len(*evts)
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	if len(tc.comps.starts) != 1 {
		t.Fatal("second start must not relaunch the compute")
	}
	if len(*evts) != before {
		t.Fatal("a no-change converge must not publish endpoint.status")
	}
}

func TestStopEndpointReleasesAndPublishes(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	evts, unsub := collectEvents(tc)
	defer unsub()
	d, err := tc.core.StopEndpoint(context.Background(), "b1")
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.StatusEndpoint != "stopped" || d.Row.StatusPort != nil {
		t.Fatalf("detail = %+v", d.Row)
	}
	if d.Row.PortSlot == nil || *d.Row.PortSlot != 54300 {
		t.Fatal("sticky slot survives a stop")
	}
	if d.ConnectionString != nil || d.JdbcURL != nil {
		t.Fatal("stopped endpoints carry no connection strings")
	}
	if len(tc.comps.stops) == 0 {
		t.Fatal("compute must be stopped")
	}
	if _, held := tc.prox.slots["b1"]; held {
		t.Fatal("slot must be released")
	}
	if len(*evts) < 2 {
		t.Fatalf("stopping+stopped events expected, got %d", len(*evts))
	}
}

func TestStartFailureRecordsFailedAndNextStartRecovers(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	tc.comps.startErr = errFake("compute exploded")
	_, err := tc.core.StartEndpoint(context.Background(), "b1")
	if err == nil || !strings.Contains(err.Error(), "compute exploded") {
		t.Fatalf("err = %v", err)
	}
	d, _ := tc.core.BranchDetail(context.Background(), "b1")
	if d.Row.StatusEndpoint != "failed" || d.Row.StatusError == nil {
		t.Fatalf("row = %+v", d.Row)
	}
	if _, held := tc.prox.slots["b1"]; held {
		t.Fatal("failed start must release its slot claim")
	}
	// a later start (new spec generation) recovers
	tc.comps.startErr = nil
	d2, err := tc.core.StartEndpoint(context.Background(), "b1")
	if err != nil || d2.Row.StatusEndpoint != "running" {
		t.Fatalf("recovery start = %+v, %v", d2.Row, err)
	}
	if d2.Row.StatusError != nil {
		t.Fatal("recovery must clear status_error")
	}
}

func TestPortExhaustion409NamesRunningEndpoints(t *testing.T) {
	tc := newTestCore(t) // fake proxy has exactly 2 slots
	tc.seedBranch(t, "p1", "b1")
	tc.seedBranch(t, "p2", "b2")
	tc.seedBranch(t, "p3", "b3")
	for _, id := range []string{"b1", "b2"} {
		if _, err := tc.core.StartEndpoint(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	_, err := tc.core.StartEndpoint(context.Background(), "b3")
	serr, ok := err.(*Error)
	if !ok || serr.Status != 409 {
		t.Fatalf("err = %v", err)
	}
	for _, want := range []string{"proj-p1/main", "proj-p2/main", "WORKTREEDB_PORT_RANGE", "no free endpoint port in range — running endpoints: "} {
		if !strings.Contains(serr.Message, want) {
			t.Fatalf("409 message missing %q: %s", want, serr.Message)
		}
	}
	// stop one → the 409'd branch starts on the freed slot
	if _, err := tc.core.StopEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	d, err := tc.core.StartEndpoint(context.Background(), "b3")
	if err != nil || *d.Row.StatusPort != 54300 {
		t.Fatalf("freed-slot reuse: %+v %v", d.Row, err)
	}
}

func TestCrashDetectionCommitsFailedWithoutRestart(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	// the compute dies on its own
	tc.comps.mu.Lock()
	delete(tc.comps.status, "b1")
	tc.comps.mu.Unlock()
	owner, _ := tc.core.Owners.Get("b1")
	owner.Nudge()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d, _ := tc.core.BranchDetail(context.Background(), "b1")
		if d.Row.StatusEndpoint == "failed" {
			if len(tc.comps.starts) != 1 {
				t.Fatal("a crashed compute must NOT be auto-restarted at the same spec generation")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("crash was never observed as failed")
}

func TestStopDuringStartNewerSpecWins(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	release := make(chan struct{})
	blocking := &blockingComputes{inner: tc.comps, release: release, entered: make(chan struct{}, 1)}
	tc.core.Computes = blocking

	done := make(chan error, 1)
	go func() {
		_, err := tc.core.StartEndpoint(context.Background(), "b1")
		done <- err
	}()
	<-blocking.entered // the converge is inside compute Start
	// a stop lands: spec flips + gen bumps while the start is mid-flight
	stopDone := make(chan error, 1)
	go func() {
		_, err := tc.core.StopEndpoint(context.Background(), "b1")
		stopDone <- err
	}()
	time.Sleep(50 * time.Millisecond) // let the stop's spec write land (its Do queues behind the start converge)
	close(release)
	<-done
	if err := <-stopDone; err != nil {
		t.Fatal(err)
	}
	d, _ := tc.core.BranchDetail(context.Background(), "b1")
	if d.Row.StatusEndpoint != "stopped" {
		t.Fatalf("newer spec (stop) must win, got %s", d.Row.StatusEndpoint)
	}
	if len(blocking.inner.stops) == 0 {
		t.Fatal("the started compute must have been stopped by the re-converge")
	}
}

// blockingComputes wraps the fake so a Start blocks until released — the
// interleaving harness for stop-during-start.
type blockingComputes struct {
	inner   *fakeComputes
	release chan struct{}
	entered chan struct{} // buffered(1): signals the converge is inside Start
}

func (b *blockingComputes) Start(ctx context.Context, p compute.StartParams) (int, error) {
	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-b.release
	return b.inner.Start(ctx, p)
}
func (b *blockingComputes) Stop(branchID string)            { b.inner.Stop(branchID) }
func (b *blockingComputes) StatusOf(branchID string) string { return b.inner.StatusOf(branchID) }
func (b *blockingComputes) RunningPgbins() []string         { return b.inner.RunningPgbins() }
func (b *blockingComputes) StopAll()                        { b.inner.StopAll() }

func errFake(msg string) error { return &Error{Status: 500, Message: msg} }
```

And `internal/service/registry_test.go` (complete file):

```go
package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
)

func TestRegistryAddGetRemove(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := NewRegistry(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var converges atomic.Int64
	o := r.Add("b1", func(ctx context.Context) error { converges.Add(1); return nil })
	if o2 := r.Add("b1", func(ctx context.Context) error { return nil }); o2 != o {
		t.Fatal("Add must be idempotent per id")
	}
	got, ok := r.Get("b1")
	if !ok || got != o {
		t.Fatal("Get must return the registered owner")
	}
	if err := o.Do(context.Background()); err != nil || converges.Load() != 1 {
		t.Fatalf("owner must be started: %v", err)
	}
	r.Remove("b1")
	if _, ok := r.Get("b1"); ok {
		t.Fatal("removed owner must be gone")
	}
	if err := o.Do(context.Background()); !errors.Is(err, runtime.ErrOwnerStopped) {
		t.Fatalf("removed owner must be stopped: %v", err)
	}
	r.Remove("b1") // idempotent
	r.Shutdown()
}
```

- [ ] **Step 3: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/service/ 2>&1 | tail -8`
Expected: compile errors (package under construction).

- [ ] **Step 4: Write `internal/service/errors.go` and `internal/service/slug.go`** (complete files):

```go
package service

import "fmt"

// Error is a client-visible failure: Status is the HTTP status the API layer
// maps it to, Message the exact wire text ({"error": Message}).
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func Errf(status int, format string, a ...any) *Error {
	return &Error{Status: status, Message: fmt.Sprintf(format, a...)}
}
```

```go
package service

import (
	"regexp"
	"strings"
)

var slugRun = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify lowercases each part, collapses non-alphanumeric runs to "-",
// trims, drops empties, and joins with "-". Idempotent on its own output.
func Slugify(parts ...string) string {
	var out []string
	for _, p := range parts {
		s := strings.Trim(slugRun.ReplaceAllString(strings.ToLower(p), "-"), "-")
		if s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, "-")
}
```

- [ ] **Step 5: Write `internal/service/core.go`** (complete file):

```go
// Package service orchestrates the daemon's resources: it is the only layer
// that writes spec on behalf of API calls, and it hosts the owner converges
// that are the only writers of status. HTTP handlers stay thin over this
// package; engine/compute/proxy details stay below it.
package service

import (
	"context"
	"log/slog"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Narrow structural interfaces: exactly the methods this package consumes.
// Production wiring passes the real clients/manager/proxy (they satisfy these
// structurally); unit tests pass typed fakes — no untyped casts anywhere.

type StorconAPI interface {
	TenantCreate(ctx context.Context, tenantID string, cfg engine.TenantConfig) error
	GetLsnByTimestamp(ctx context.Context, tenantID, timelineID, isoTimestamp string) (engine.LsnByTimestamp, error)
}

type PageserverAPI interface {
	TimelineCreate(ctx context.Context, tenantID string, req engine.TimelineCreateRequest) error
	TimelineInfo(ctx context.Context, tenantID, timelineID string) (engine.TimelineInfo, error)
	TimelineDelete(ctx context.Context, tenantID, timelineID string) error
	TimelineDetachAncestor(ctx context.Context, tenantID, timelineID string) (engine.DetachAncestorResult, error)
	TenantDelete(ctx context.Context, tenantID string) error
}

type SafekeeperAPI interface {
	TimelineDelete(ctx context.Context, tenantID, timelineID string) error
	TenantDelete(ctx context.Context, tenantID string) error
}

type ComputeAPI interface {
	Start(ctx context.Context, p compute.StartParams) (computePort int, err error)
	Stop(branchID string)
	StatusOf(branchID string) string
	RunningPgbins() []string
	StopAll()
}

type ProxyAPI interface {
	Reserve(branchID string, sticky *int) (int, error)
	Bind(branchID string, computePort int) error
	Release(branchID string)
	ConnCount(branchID string) int64
}

// Core aggregates the daemon's orchestration dependencies. Resource methods
// live in sibling files (endpoints.go, projects.go, branches.go,
// timetravel.go, sql.go) — one seam, one construction site (main).
type Core struct {
	Cfg        *config.Config
	Store      *store.Store
	Storcon    StorconAPI
	Pageserver PageserverAPI
	Safekeeper SafekeeperAPI
	Computes   ComputeAPI
	Proxy      ProxyAPI
	Hub        *events.LogHub
	Bus        *events.Bus
	Owners     *Registry
	Log        *slog.Logger
	// PgbinFor resolves the PostgreSQL install computes launch with for a
	// major; InstalledMajors is the create-time whitelist. Both are funcs so
	// a future dynamic-build registry can replace the baked resolution
	// without this package changing shape.
	PgbinFor        func(major int) (string, error)
	InstalledMajors func() []int
}
```

- [ ] **Step 6: Write `internal/service/registry.go`** (complete file):

```go
package service

import (
	"context"
	"log/slog"
	"sync"

	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
)

type ownerEntry struct {
	owner  *runtime.Owner
	cancel context.CancelFunc
}

// Registry holds one runtime.Owner per live branch — created with the branch
// (or at boot for existing rows), destroyed with it. Owners are start-once:
// Remove cancels the owner's context and waits for its loop to exit, so a
// removed branch can never have a converge in flight afterwards.
type Registry struct {
	root context.Context
	log  *slog.Logger

	mu     sync.Mutex
	owners map[string]*ownerEntry
}

func NewRegistry(root context.Context, log *slog.Logger) *Registry {
	return &Registry{root: root, log: log, owners: map[string]*ownerEntry{}}
}

// Add registers (and starts) the owner for branchID; idempotent — an existing
// owner is returned untouched, so double registration can never spawn a
// second loop for the same branch.
func (r *Registry) Add(branchID string, converge func(context.Context) error) *runtime.Owner {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.owners[branchID]; ok {
		return e.owner
	}
	ctx, cancel := context.WithCancel(r.root)
	o := runtime.NewOwner("branch:"+branchID, converge, r.log)
	o.Start(ctx)
	r.owners[branchID] = &ownerEntry{owner: o, cancel: cancel}
	return o
}

func (r *Registry) Get(branchID string) (*runtime.Owner, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.owners[branchID]
	if !ok {
		return nil, false
	}
	return e.owner, true
}

// Remove stops the branch's owner and waits for its loop to exit. Callers
// remove AFTER the branch row is gone, from outside the owner's own loop
// (removing from inside a Run would deadlock on Wait).
func (r *Registry) Remove(branchID string) {
	r.mu.Lock()
	e, ok := r.owners[branchID]
	if ok {
		delete(r.owners, branchID)
	}
	r.mu.Unlock()
	if !ok {
		return
	}
	e.cancel()
	e.owner.Wait()
}

// Shutdown stops every owner (daemon shutdown) and waits for all loops.
func (r *Registry) Shutdown() {
	r.mu.Lock()
	entries := make([]*ownerEntry, 0, len(r.owners))
	for _, e := range r.owners {
		entries = append(entries, e)
	}
	r.owners = map[string]*ownerEntry{}
	r.mu.Unlock()
	for _, e := range entries {
		e.cancel()
	}
	for _, e := range entries {
		e.owner.Wait()
	}
}
```

- [ ] **Step 7: Write `internal/service/endpoints.go`** (complete file):

```go
package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/proxy"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// ConnectionString/JdbcURL are the user-facing dial strings. Host is the IPv4
// literal 127.0.0.1 — endpoint ports publish on IPv4 loopback only, and
// "localhost" resolves to ::1 first on IPv6-preferring hosts, refusing
// external clients. Passwords are 32 alphanumerics by construction, so both
// strings embed them verbatim. No sslmode in the libpq form (trust-mode
// plaintext); the JDBC form carries creds as query params (JDBC URLs have no
// user:pass@ userinfo) and sslmode=disable explicitly.
func ConnectionString(password string, port int) string {
	return fmt.Sprintf("postgresql://postgres:%s@127.0.0.1:%d/postgres", password, port)
}

func JdbcURL(password string, port int) string {
	return fmt.Sprintf("jdbc:postgresql://127.0.0.1:%d/postgres?user=postgres&password=%s&sslmode=disable", port, password)
}

// BranchDetail is a branch row plus its derived/enriched read-model — the
// source every branch DTO is built from.
type BranchDetail struct {
	Row              store.BranchRow
	ConnectionString *string
	JdbcURL          *string
	LastRecordLsn    *string
	LogicalSizeBytes *int64
	AncestorLsn      *string
}

// RegisterBranchOwner creates (idempotently) the branch's owner with the
// endpoint converge bound to its id.
func (c *Core) RegisterBranchOwner(branchID string) *runtime.Owner {
	return c.Owners.Add(branchID, func(ctx context.Context) error {
		return c.convergeEndpoint(ctx, branchID)
	})
}

func (c *Core) branchOr404(ctx context.Context, branchID string) (store.BranchRow, error) {
	b, ok, err := c.Store.BranchByID(ctx, branchID)
	if err != nil {
		return store.BranchRow{}, err
	}
	if !ok {
		return store.BranchRow{}, Errf(404, "branch %s not found", branchID)
	}
	return b, nil
}

func (c *Core) projectOr404(ctx context.Context, projectID string) (store.ProjectRow, error) {
	p, ok, err := c.Store.ProjectByID(ctx, projectID)
	if err != nil {
		return store.ProjectRow{}, err
	}
	if !ok {
		return store.ProjectRow{}, Errf(404, "project %s not found", projectID)
	}
	return p, nil
}

// StartEndpoint writes the desired state and runs one synchronous converge.
// The generation bump is what makes a retry after "failed" a recovery: the
// converge treats failed-at-current-generation as terminal, and a fresh
// generation re-arms it.
func (c *Core) StartEndpoint(ctx context.Context, branchID string) (BranchDetail, error) {
	return c.setSpecAndConverge(ctx, branchID, "running")
}

func (c *Core) StopEndpoint(ctx context.Context, branchID string) (BranchDetail, error) {
	return c.setSpecAndConverge(ctx, branchID, "stopped")
}

// EnsureRunning shares StartEndpoint's whole body: the "already running"
// check happens inside the converge, inside the owner lane — checking before
// entering the lane would race a concurrent stop.
func (c *Core) EnsureRunning(ctx context.Context, branchID string) (BranchDetail, error) {
	return c.StartEndpoint(ctx, branchID)
}

func (c *Core) setSpecAndConverge(ctx context.Context, branchID, spec string) (BranchDetail, error) {
	if _, err := c.branchOr404(ctx, branchID); err != nil {
		return BranchDetail{}, err
	}
	owner, ok := c.Owners.Get(branchID)
	if !ok {
		return BranchDetail{}, Errf(404, "branch %s not found", branchID)
	}
	if err := c.writeSpecEndpoint(ctx, branchID, spec); err != nil {
		return BranchDetail{}, err
	}
	if err := owner.Do(ctx); err != nil {
		return BranchDetail{}, err
	}
	return c.BranchDetail(ctx, branchID)
}

func (c *Core) writeSpecEndpoint(ctx context.Context, branchID, spec string) error {
	return c.Store.WithTx(ctx, func(tx *sql.Tx) error {
		if err := store.SetSpecEndpoint(tx, branchID, spec); err != nil {
			return err
		}
		_, err := store.BumpSpecGen(tx, "branches", branchID)
		return err
	})
}

// setSpecAndConvergeLocked is the in-lane variant for jobs ALREADY running
// inside this branch's owner (restore steps): it writes spec and invokes the
// converge directly — going through Owner.Do from inside the lane would
// deadlock on the inbox.
func (c *Core) setSpecAndConvergeLocked(ctx context.Context, branchID, spec string) error {
	if err := c.writeSpecEndpoint(ctx, branchID, spec); err != nil {
		return err
	}
	return c.convergeEndpoint(ctx, branchID)
}

// convergeEndpoint drives observed endpoint state toward spec. It loops
// because a spec write can land mid-convergence (stop during start): a
// stale-generation commit abandons the observation and the next pass reads
// the newer spec — the newer intent always wins, nothing clobbers.
func (c *Core) convergeEndpoint(ctx context.Context, branchID string) error {
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		b, ok, err := c.Store.BranchByID(ctx, branchID)
		if err != nil {
			return err
		}
		if !ok {
			return nil // branch deleted — nothing to converge
		}
		mgr := c.Computes.StatusOf(branchID)

		// Crash detection: the row claims running but the compute is not.
		// Commit failed at the SAME generation — the spec did not change, so
		// this is a pure observation. failed-at-current-generation is
		// terminal: no restart until a fresh spec write bumps the generation.
		if b.StatusEndpoint == "running" && mgr != "running" {
			c.Computes.Stop(branchID)
			c.Proxy.Release(branchID)
			msg := "compute exited unexpectedly"
			if b.StatusError != nil {
				msg = *b.StatusError
			}
			if err := c.commitEndpoint(ctx, b, b.SpecGen, store.EndpointStatusUpdate{Endpoint: "failed", Error: &msg}); err != nil &&
				!errors.Is(err, store.ErrStaleGeneration) {
				return err
			}
			continue
		}

		converged := b.ObservedGen == b.SpecGen &&
			((b.SpecEndpoint == "running" && b.StatusEndpoint == "running" && mgr == "running") ||
				(b.SpecEndpoint == "running" && b.StatusEndpoint == "failed") ||
				(b.SpecEndpoint == "stopped" && (b.StatusEndpoint == "stopped" || b.StatusEndpoint == "failed") && mgr == "stopped"))
		if converged {
			return nil
		}

		switch b.SpecEndpoint {
		case "running":
			lastErr = c.convergeToRunning(ctx, b)
		case "stopped":
			lastErr = c.convergeToStopped(ctx, b)
		default:
			return fmt.Errorf("branch %s: unknown spec_endpoint %q", branchID, b.SpecEndpoint)
		}
		if errors.Is(lastErr, store.ErrStaleGeneration) {
			continue // spec moved mid-flight: abandon this observation, re-read
		}
		return lastErr
	}
	return fmt.Errorf("branch %s: convergence did not settle after 5 attempts (last: %v)", branchID, lastErr)
}

func (c *Core) convergeToRunning(ctx context.Context, b store.BranchRow) error {
	gen := b.SpecGen
	// A dead prior compute (failed entry) is cleaned up first so the start
	// below begins from zero — this is the recovery path for a failed
	// endpoint re-started through the API.
	if c.Computes.StatusOf(b.ID) != "stopped" {
		c.Computes.Stop(b.ID)
	}
	c.Proxy.Release(b.ID)

	if err := c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{Endpoint: "starting"}); err != nil {
		return err
	}
	slot, err := c.Proxy.Reserve(b.ID, b.PortSlot)
	if err != nil {
		if errors.Is(err, proxy.ErrExhausted) {
			serr := c.portExhaustedError(ctx)
			c.commitFailed(ctx, b, gen, serr.Message)
			return serr
		}
		c.commitFailed(ctx, b, gen, err.Error())
		return err
	}
	project, ok, err := c.Store.ProjectByID(ctx, b.ProjectID)
	if err != nil || !ok {
		c.Proxy.Release(b.ID)
		msg := fmt.Sprintf("project %s not found for branch %s", b.ProjectID, b.ID)
		c.commitFailed(ctx, b, gen, msg)
		return fmt.Errorf("%s (%v)", msg, err)
	}
	pgbin, err := c.PgbinFor(project.PgMajor)
	if err != nil {
		c.Proxy.Release(b.ID)
		c.commitFailed(ctx, b, gen, err.Error())
		return err
	}
	owner, _ := c.Owners.Get(b.ID)
	computePort, err := c.Computes.Start(ctx, compute.StartParams{
		BranchID: b.ID, BranchName: b.Name, Slug: b.Slug,
		TenantID: b.ProjectID, TimelineID: b.TimelineID,
		Password: b.Password, PgbinPath: pgbin,
		OnLine: func(line string) { c.Hub.Ingest("branch:"+b.ID+":compute", line) },
		// Dispatched from under the child Process's mutex: Nudge is
		// non-blocking by contract, and the converge it wakes does the real
		// work (crash detection above).
		OnExit: func() {
			if owner != nil {
				owner.Nudge()
			}
		},
	})
	if err != nil {
		c.Proxy.Release(b.ID)
		c.commitFailed(ctx, b, gen, truncateErr(err))
		return err
	}
	if err := c.Proxy.Bind(b.ID, computePort); err != nil {
		c.Computes.Stop(b.ID)
		c.Proxy.Release(b.ID)
		c.commitFailed(ctx, b, gen, truncateErr(err))
		return err
	}
	if err := c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{
		Endpoint: "running", Port: &slot, Pgbin: &pgbin, PortSlot: &slot,
	}); err != nil {
		// Stale: a stop landed while we started — the caller's converge loop
		// re-reads and stops what we just launched. Nothing to unwind here.
		return err
	}
	return nil
}

func (c *Core) convergeToStopped(ctx context.Context, b store.BranchRow) error {
	gen := b.SpecGen
	if err := c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{Endpoint: "stopping"}); err != nil {
		return err
	}
	c.Proxy.Release(b.ID)  // new connections refused immediately (bind-on-running)
	c.Computes.Stop(b.ID)  // group kill: compute_ctl AND its postgres child
	return c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{Endpoint: "stopped"})
}

// commitFailed records a failed observation, tolerating a stale generation
// (a concurrent spec write wins; the converge loop handles it).
func (c *Core) commitFailed(ctx context.Context, b store.BranchRow, gen int64, msg string) {
	if err := c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{Endpoint: "failed", Error: &msg}); err != nil &&
		!errors.Is(err, store.ErrStaleGeneration) {
		c.Log.Error("failed-status commit failed", "branch", b.ID, "err", err)
	}
}

// commitEndpoint is the single seam every persisted endpoint transition goes
// through: a generation-checked status write plus the endpoint.status event —
// a transition can never be written without being announced. Publishes only
// when (status, port) actually changed, so redundant converges are silent.
func (c *Core) commitEndpoint(ctx context.Context, b store.BranchRow, gen int64, u store.EndpointStatusUpdate) error {
	changed := b.StatusEndpoint != u.Endpoint || !eqIntPtr(b.StatusPort, u.Port)
	if err := c.Store.CommitStatus(ctx, "branches", b.ID, gen, func(tx *sql.Tx) error {
		return store.ApplyEndpointStatus(tx, b.ID, u)
	}); err != nil {
		return err
	}
	if changed {
		c.Bus.Publish("endpoint.status", b.ProjectID, b.ID)
	}
	return nil
}

func eqIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func truncateErr(err error) string {
	msg := err.Error()
	if len(msg) > 2000 {
		msg = msg[:2000]
	}
	return msg
}

// portExhaustedError names every currently-running endpoint project-qualified
// (projectName/branchName) so a 409 spanning several projects' "main"
// branches never reads as an ambiguous "main, main".
func (c *Core) portExhaustedError(ctx context.Context) *Error {
	var names []string
	projects, err := c.Store.Projects(ctx)
	if err == nil {
		for _, p := range projects {
			branches, berr := c.Store.BranchesByProject(ctx, p.ID)
			if berr != nil {
				continue
			}
			for _, b := range branches {
				if b.StatusEndpoint == "running" {
					names = append(names, p.Name+"/"+b.Name)
				}
			}
		}
	}
	sort.Strings(names)
	return Errf(409, "no free endpoint port in range — running endpoints: %s. Stop one or widen WORKTREEDB_PORT_RANGE.",
		strings.Join(names, ", "))
}

// BranchDetail assembles the read model: row + connection strings (running
// only) + timeline enrichment. Engine enrichment is best-effort — a briefly
// unavailable pageserver must not 500 a branch listing; an *engine.APIError
// logs and yields nulls, anything else surfaces (programming bugs must).
func (c *Core) BranchDetail(ctx context.Context, branchID string) (BranchDetail, error) {
	b, err := c.branchOr404(ctx, branchID)
	if err != nil {
		return BranchDetail{}, err
	}
	return c.detailOf(ctx, b)
}

func (c *Core) detailOf(ctx context.Context, b store.BranchRow) (BranchDetail, error) {
	d := BranchDetail{Row: b}
	if b.StatusEndpoint == "running" && b.StatusPort != nil {
		cs := ConnectionString(b.Password, *b.StatusPort)
		ju := JdbcURL(b.Password, *b.StatusPort)
		d.ConnectionString = &cs
		d.JdbcURL = &ju
	}
	info, err := c.Pageserver.TimelineInfo(ctx, b.ProjectID, b.TimelineID)
	if err != nil {
		var apiErr *engine.APIError
		if !errors.As(err, &apiErr) {
			return BranchDetail{}, err
		}
		c.Log.Warn("timeline enrichment unavailable", "branch", b.ID, "err", apiErr.Error())
		return d, nil
	}
	d.LastRecordLsn = info.LastRecordLSN
	d.LogicalSizeBytes = info.CurrentLogicalSize
	d.AncestorLsn = info.AncestorLSN
	return d, nil
}

// EndpointStatus is the GET …/endpoint read: current status + port.
func (c *Core) EndpointStatus(ctx context.Context, branchID string) (string, *int, error) {
	b, err := c.branchOr404(ctx, branchID)
	if err != nil {
		return "", nil, err
	}
	return b.StatusEndpoint, b.StatusPort, nil
}
```

- [ ] **Step 8: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1 && go test ./internal/... -race -count=1 && golangci-lint run`
Expected: all PASS, 0 issues. Pay attention to `-race` on the stop-during-start test — it exercises the real owner loop.

- [ ] **Step 9: Commit**

```bash
cd ~/git/worktreedb && git add internal/service && git commit -m "feat(service): core orchestration, per-branch owner registry, endpoint convergence"
```

---

### Task 9: service — projects

Project create/list/get/delete over the Core. Create: validate name + major whitelist → storcon tenant create (tenant id = project id) → pageserver bootstrap timeline → both local rows in one transaction → `project.created` (the seeded main branch does NOT also emit `branch.created`) → register the main branch's owner. Compensation: a failure after tenant create deletes the tenant on pageserver AND safekeeper — loud on failure, never silent. Delete: drain branches children-first (each leaf inside its own owner lane), delete the tenant on both components, then the project row with a bounded FK-retry sweep, then `project.deleted`.

**Files:**
- Create: `~/git/worktreedb/internal/service/projects.go`
- Create: `~/git/worktreedb/internal/service/projects_test.go`

**Interfaces:**
- Consumes: Task 8's Core, registry, converge; Task 1 rows; Task 3 client types.
- Produces:
  - `func (c *Core) CreateProject(ctx, name string, pgVersion *int) (store.ProjectRow, BranchDetail, error)`
  - `func (c *Core) Projects(ctx) ([]store.ProjectRow, error)` · `func (c *Core) ProjectByIDOr404(ctx, id string) (store.ProjectRow, error)` · `func (c *Core) DeleteProject(ctx, id string) error`
  - `const DefaultPgMajor = 17`
  - `func (c *Core) teardownBranchLocked(ctx, b store.BranchRow) error` — the shared in-lane leaf teardown branch-delete (Task 10) reuses.

- [ ] **Step 1: Write the failing tests** — `internal/service/projects_test.go` (complete file):

```go
package service

import (
	"context"
	"strings"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

func TestCreateProjectHappyPath(t *testing.T) {
	tc := newTestCore(t)
	evts, unsub := collectEvents(tc)
	defer unsub()
	p, main, err := tc.core.CreateProject(context.Background(), "acme", nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.PgMajor != 17 {
		t.Fatalf("default major = %d, want 17", p.PgMajor)
	}
	if p.ID != p.TenantID {
		t.Fatal("project id must be the tenant id")
	}
	if len(tc.storcon.tenants) != 1 || tc.storcon.tenants[0] != p.ID {
		t.Fatalf("tenant create calls = %v", tc.storcon.tenants)
	}
	// bootstrap timeline: pg_version set, NO ancestor
	if len(tc.ps.creates) != 1 {
		t.Fatalf("timeline creates = %d", len(tc.ps.creates))
	}
	req := tc.ps.creates[0].Req
	if req.PgVersion != 17 || req.AncestorTimelineID != "" || req.NewTimelineID != main.Row.TimelineID {
		t.Fatalf("bootstrap req = %+v", req)
	}
	if main.Row.Name != "main" || main.Row.ParentBranchID != nil || main.Row.CreatedBy != "api" {
		t.Fatalf("main = %+v", main.Row)
	}
	if !strings.HasPrefix(main.Row.Slug, "acme-main-") || len(main.Row.Slug) != len("acme-main-")+6 {
		t.Fatalf("slug = %q (want acme-main-<6 hex of timeline>)", main.Row.Slug)
	}
	if len(main.Row.Password) != 32 {
		t.Fatalf("password = %q", main.Row.Password)
	}
	if _, ok := tc.core.Owners.Get(main.Row.ID); !ok {
		t.Fatal("main branch owner must be registered")
	}
	// emission map: ONE project.created, no branch.created for the seeded main
	var kinds []string
	for _, e := range *evts {
		kinds = append(kinds, e.Type)
	}
	if len(kinds) != 1 || kinds[0] != "project.created" {
		t.Fatalf("events = %v", kinds)
	}
}

func TestCreateProjectValidation(t *testing.T) {
	tc := newTestCore(t)
	cases := []struct {
		name    string
		major   *int
		status  int
		message string
	}{
		{"!bad", nil, 400, "invalid project name"},
		{"", nil, 400, "invalid project name"},
		{strings.Repeat("a", 64), nil, 400, "invalid project name"},
		{"ok name", intp(13), 400, "Postgres 13 is not installed — installed majors: 14, 15, 16, 17. Pull it via POST /api/pg-builds/pull."},
	}
	for _, cse := range cases {
		_, _, err := tc.core.CreateProject(context.Background(), cse.name, cse.major)
		serr, ok := err.(*Error)
		if !ok || serr.Status != cse.status || !strings.Contains(serr.Message, cse.message) {
			t.Fatalf("CreateProject(%q,%v) = %v", cse.name, cse.major, err)
		}
	}
	// duplicate name → 409 with the remediation
	if _, _, err := tc.core.CreateProject(context.Background(), "acme", nil); err != nil {
		t.Fatal(err)
	}
	_, _, err := tc.core.CreateProject(context.Background(), "acme", nil)
	serr, ok := err.(*Error)
	if !ok || serr.Status != 409 ||
		serr.Message != `project "acme" already exists — choose a different name, or use the existing project (call list_projects to see it)` {
		t.Fatalf("dup = %v", err)
	}
}

func TestCreateProjectCompensatesEngineOnLocalFailure(t *testing.T) {
	tc := newTestCore(t)
	tc.ps.createErr = errFake("timeline create exploded")
	_, _, err := tc.core.CreateProject(context.Background(), "acme", nil)
	if err == nil {
		t.Fatal("must surface the failure")
	}
	if len(tc.ps.tenantDels) != 1 || len(tc.sk.tenantDels) != 1 {
		t.Fatalf("tenant compensation must hit pageserver AND safekeeper: ps=%v sk=%v",
			tc.ps.tenantDels, tc.sk.tenantDels)
	}
	if rows, _ := tc.core.Projects(context.Background()); len(rows) != 0 {
		t.Fatal("no project row may survive a failed create")
	}
}

func TestDeleteProjectDrainsChildrenFirst(t *testing.T) {
	tc := newTestCore(t)
	_, main, err := tc.core.CreateProject(context.Background(), "acme", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Seed the child directly (branch create is a later task's surface):
	// row + owner is all the drain needs.
	child, err := tc.st.CreateBranch(context.Background(), store.BranchParams{
		ID: store.NewID(), ProjectID: main.Row.ProjectID, ParentBranchID: &main.Row.ID,
		Name: "dev", Slug: "acme-dev-abcdef", TimelineID: engineID("dev"),
		Password: "PWchild", CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	tc.core.RegisterBranchOwner(child.ID)
	if _, err := tc.core.StartEndpoint(context.Background(), child.ID); err != nil {
		t.Fatal(err)
	}
	evts, unsub := collectEvents(tc)
	defer unsub()
	if err := tc.core.DeleteProject(context.Background(), main.Row.ProjectID); err != nil {
		t.Fatal(err)
	}
	// child compute stopped, timelines deleted on both components (child then main)
	if len(tc.comps.stops) == 0 {
		t.Fatal("running child compute must be stopped")
	}
	if len(tc.ps.deletes) != 2 || len(tc.sk.deletes) != 2 {
		t.Fatalf("timeline deletes ps=%v sk=%v", tc.ps.deletes, tc.sk.deletes)
	}
	if !strings.HasSuffix(tc.ps.deletes[0], "/"+child.TimelineID) {
		t.Fatal("children must be torn down before parents")
	}
	if len(tc.ps.tenantDels) != 1 || len(tc.sk.tenantDels) != 1 {
		t.Fatal("tenant must be deleted on both components")
	}
	if rows, _ := tc.core.Projects(context.Background()); len(rows) != 0 {
		t.Fatal("project row must be gone")
	}
	if _, ok := tc.core.Owners.Get(child.ID); ok {
		t.Fatal("deleted branches' owners must be removed")
	}
	// events: branch.deleted (x2) then project.deleted — endpoint.status
	// transitions from the child stop are also fine; assert presence + order
	// of the deleted trio.
	var seq []string
	for _, e := range *evts {
		if e.Type == "branch.deleted" || e.Type == "project.deleted" {
			seq = append(seq, e.Type)
		}
	}
	if len(seq) != 3 || seq[2] != "project.deleted" {
		t.Fatalf("delete events = %v", seq)
	}
}

func TestDeleteProject404(t *testing.T) {
	tc := newTestCore(t)
	err := tc.core.DeleteProject(context.Background(), "nope")
	serr, ok := err.(*Error)
	if !ok || serr.Status != 404 || serr.Message != "project nope not found" {
		t.Fatalf("err = %v", err)
	}
}

func intp(v int) *int { return &v }
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestCreateProject|TestDeleteProject' 2>&1 | tail -8`
Expected: compile errors (`c.CreateProject undefined`, …).

- [ ] **Step 3: Write `internal/service/projects.go`** (complete file):

```go
package service

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

const DefaultPgMajor = 17

var projectNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$`)

func majorsList(majors []int) string {
	parts := make([]string, len(majors))
	for i, m := range majors {
		parts[i] = fmt.Sprintf("%d", m)
	}
	return strings.Join(parts, ", ")
}

// CreateProject provisions a storage-engine tenant (tenant id = project id —
// one project is one tenant), bootstraps its root timeline, and seeds the
// main branch. Engine work happens first; the two local rows land in one
// transaction; a failure after the tenant exists compensates by deleting it
// on both engine components — loud on compensation failure, never silent.
func (c *Core) CreateProject(ctx context.Context, name string, pgVersion *int) (store.ProjectRow, BranchDetail, error) {
	name = strings.TrimSpace(name)
	if !projectNameRe.MatchString(name) {
		return store.ProjectRow{}, BranchDetail{}, Errf(400,
			"invalid project name: %q — names must start with a letter or digit and contain only letters, digits, spaces, underscores, or hyphens (max 63 characters)", name)
	}
	if _, exists, err := c.Store.ProjectByName(ctx, name); err != nil {
		return store.ProjectRow{}, BranchDetail{}, err
	} else if exists {
		return store.ProjectRow{}, BranchDetail{}, Errf(409,
			`project "%s" already exists — choose a different name, or use the existing project (call list_projects to see it)`, name)
	}
	major := DefaultPgMajor
	if pgVersion != nil {
		major = *pgVersion
	}
	installed := c.InstalledMajors()
	found := false
	for _, m := range installed {
		if m == major {
			found = true
			break
		}
	}
	if !found {
		return store.ProjectRow{}, BranchDetail{}, Errf(400,
			"Postgres %d is not installed — installed majors: %s. Pull it via POST /api/pg-builds/pull.", major, majorsList(installed))
	}

	projectID := store.NewID() // doubles as the tenant id (32-hex, engine-shaped)
	if err := c.Storcon.TenantCreate(ctx, projectID, engine.DefaultTenantConfig); err != nil {
		return store.ProjectRow{}, BranchDetail{}, err
	}
	row, main, err := c.seedProjectRows(ctx, projectID, name, major)
	if err != nil {
		// compensation: never leave a live tenant on the engine for a create
		// that failed after TenantCreate succeeded.
		if cerr := c.Pageserver.TenantDelete(ctx, projectID); cerr != nil {
			c.Log.Error("compensation failed — orphaned tenant on pageserver", "tenant", projectID, "err", cerr)
		}
		if cerr := c.Safekeeper.TenantDelete(ctx, projectID); cerr != nil {
			c.Log.Error("compensation failed — orphaned tenant on safekeeper", "tenant", projectID, "err", cerr)
		}
		return store.ProjectRow{}, BranchDetail{}, err
	}
	c.RegisterBranchOwner(main.ID)
	c.Bus.Publish("project.created", projectID, "")
	detail, err := c.detailOf(ctx, main)
	return row, detail, err
}

func (c *Core) seedProjectRows(ctx context.Context, projectID, name string, major int) (store.ProjectRow, store.BranchRow, error) {
	// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline
	// (routes.rs; bootstrap variant — pg_version set, no ancestor).
	timelineID := store.NewID()
	if err := c.Pageserver.TimelineCreate(ctx, projectID, engine.TimelineCreateRequest{
		NewTimelineID: timelineID, PgVersion: major,
	}); err != nil {
		return store.ProjectRow{}, store.BranchRow{}, err
	}
	branchID := store.NewID()
	password := compute.GeneratePassword()
	slug := fmt.Sprintf("%s-%s", Slugify(name, "main"), timelineID[:6])
	// The two inserts run back-to-back; a constraint violation is an
	// identity conflict. (SQLite single writer: nothing interleaves between
	// them in this process; the explicit rollback below keeps "no project
	// without its main branch" true if the second insert fails.)
	project, err := c.Store.CreateProject(ctx, store.ProjectParams{ID: projectID, Name: name, PgMajor: major})
	if err != nil {
		return store.ProjectRow{}, store.BranchRow{}, classifyConstraint(err)
	}
	main, err := c.Store.CreateBranch(ctx, store.BranchParams{
		ID: branchID, ProjectID: projectID, Name: "main", Slug: slug,
		TimelineID: timelineID, Password: password, CreatedBy: "api",
	})
	if err != nil {
		// roll the project row back so no project exists without its main
		_ = c.Store.DeleteProject(ctx, projectID)
		return store.ProjectRow{}, store.BranchRow{}, classifyConstraint(err)
	}
	return project, main, nil
}

func classifyConstraint(err error) error {
	if err != nil && strings.Contains(err.Error(), "constraint") {
		return Errf(409, "project or branch identity conflicts with an existing one")
	}
	return err
}

func (c *Core) Projects(ctx context.Context) ([]store.ProjectRow, error) {
	return c.Store.Projects(ctx)
}

func (c *Core) ProjectByIDOr404(ctx context.Context, id string) (store.ProjectRow, error) {
	return c.projectOr404(ctx, id)
}

// DeleteProject drains the project's branches children-first — each leaf
// torn down inside its OWN owner lane, so a concurrent endpoint start or
// child create on that leaf either finishes first or waits its turn — then
// deletes the engine tenant and the project row. The row delete retries a
// bounded number of FK sweeps: a branch created in the window between the
// last empty snapshot and the delete is picked up by a re-drain instead of
// surfacing as a raw constraint error.
func (c *Core) DeleteProject(ctx context.Context, id string) error {
	project, err := c.projectOr404(ctx, id)
	if err != nil {
		return err
	}
	if err := c.drainBranches(ctx, project.ID); err != nil {
		return err
	}
	// oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id (routes.rs,
	// tenant_delete_handler) + safekeeper DELETE /v1/tenant/:tenant_id
	// (http/routes.rs, tenant_delete_handler) — the engine-facing pair; the
	// drain/retry choreography around them is this daemon's own.
	if err := c.Pageserver.TenantDelete(ctx, project.ID); err != nil {
		return err
	}
	if err := c.Safekeeper.TenantDelete(ctx, project.ID); err != nil {
		return err
	}
	const maxFinalSweeps = 3
	for attempt := 1; ; attempt++ {
		err := c.Store.DeleteProject(ctx, project.ID)
		if err == nil {
			c.Bus.Publish("project.deleted", project.ID, "")
			return nil
		}
		if !strings.Contains(err.Error(), "constraint") || attempt >= maxFinalSweeps {
			return err
		}
		c.Log.Error("project delete: FK on final row delete — a branch appeared after the last sweep; re-draining",
			"project", project.ID, "attempt", attempt)
		if derr := c.drainBranches(ctx, project.ID); derr != nil {
			return derr
		}
	}
}

// drainBranches repeatedly snapshots the project's branches and tears down
// the current leaves until none remain. Fresh snapshot every round: a branch
// created mid-delete is simply picked up as a leaf in a later round.
func (c *Core) drainBranches(ctx context.Context, projectID string) error {
	for {
		remaining, err := c.Store.BranchesByProject(ctx, projectID)
		if err != nil {
			return err
		}
		if len(remaining) == 0 {
			return nil
		}
		hasChild := map[string]bool{}
		for _, b := range remaining {
			if b.ParentBranchID != nil {
				hasChild[*b.ParentBranchID] = true
			}
		}
		var leaves []store.BranchRow
		for _, b := range remaining {
			if !hasChild[b.ID] {
				leaves = append(leaves, b)
			}
		}
		if len(leaves) == 0 {
			return Errf(500, "branch tree has a cycle or dangling parent — aborting project delete")
		}
		for _, leaf := range leaves {
			owner, ok := c.Owners.Get(leaf.ID)
			if !ok {
				// row exists but no owner: already being removed by a racing
				// deleter — the next snapshot settles it.
				continue
			}
			leafID := leaf.ID
			if err := owner.Run(ctx, func(ctx context.Context) error {
				b, ok, err := c.Store.BranchByID(ctx, leafID)
				if err != nil || !ok {
					return err // already gone: nothing to do
				}
				// Re-check for children inside the lane: the leaves snapshot
				// predates this job reaching the front of the lane, and a
				// child created in the interim must not be orphaned. Skip;
				// the next round picks both up.
				kids, err := c.Store.BranchesByParent(ctx, b.ID)
				if err != nil {
					return err
				}
				if len(kids) > 0 {
					return nil
				}
				return c.teardownBranchLocked(ctx, b)
			}); err != nil {
				return err
			}
			c.Owners.Remove(leafID)
		}
	}
}

// teardownBranchLocked destroys one branch: compute + slot, engine timelines
// on both components, the local row, its log channel, and the announcement.
// MUST be called from inside the branch's own owner lane; the caller removes
// the owner from the registry after the lane job returns.
func (c *Core) teardownBranchLocked(ctx context.Context, b store.BranchRow) error {
	c.Proxy.Release(b.ID)
	c.Computes.Stop(b.ID)
	// oracle: neon pageserver DELETE /v1/tenant/:tenant_shard_id/timeline/:timeline_id
	// (routes.rs, timeline_delete_handler) + safekeeper DELETE
	// /v1/tenant/:tenant_id/timeline/:timeline_id (http/routes.rs,
	// timeline_delete_handler) — the engine-facing pair in this sequence.
	if err := c.Pageserver.TimelineDelete(ctx, b.ProjectID, b.TimelineID); err != nil {
		return err
	}
	if err := c.Safekeeper.TimelineDelete(ctx, b.ProjectID, b.TimelineID); err != nil {
		return err
	}
	if err := c.Store.DeleteBranch(ctx, b.ID); err != nil {
		return err
	}
	c.Hub.Evict("branch:" + b.ID + ":compute")
	c.Bus.Publish("branch.deleted", b.ProjectID, b.ID)
	return nil
}

```

The import block for this file: `context`, `fmt`, `regexp`, `strings`, plus `internal/compute` (password generation), `internal/engine`, `internal/store` — no `database/sql` (no transaction is opened here; the single-writer store plus the explicit rollback carry the invariant).

- [ ] **Step 4: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service && git commit -m "feat(service): project lifecycle with tenant provisioning, compensation, children-first delete"
```

---

### Task 10: service — branches (create under the parent lane, rename, delete, list)

Branch create runs inside the PARENT's owner lane (a concurrent delete of that parent serializes with it — both share the parent's lane); in-lane re-checks catch a parent deleted or a name taken while queued. Rename is name-only (slug immutable; root branch refuses). Delete refuses when children exist and reuses Task 9's `teardownBranchLocked`.

**Files:**
- Create: `~/git/worktreedb/internal/service/branches.go`
- Create: `~/git/worktreedb/internal/service/branches_test.go`

**Interfaces:**
- Consumes: Tasks 8–9.
- Produces:
  - `type CreateBranchParams struct { ProjectID, Name string; ParentBranchID *string; ParentSpecified bool; AtLsn *string; CreatedBy string; ContextJSON *string }` — `ParentSpecified` distinguishes "absent" (default to main) from an explicit null (400).
  - `func (c *Core) CreateBranch(ctx, p CreateBranchParams) (BranchDetail, error)`
  - `func (c *Core) BranchesByProject(ctx, projectID string) ([]BranchDetail, error)` (404s on a missing project)
  - `func (c *Core) RenameBranch(ctx, branchID, newName string) (BranchDetail, error)`
  - `func (c *Core) DeleteBranch(ctx, branchID string) error`
  - `func (c *Core) classifyLsnRangeError(err error) error` (shared with Task 11).

- [ ] **Step 1: Write the failing tests** — `internal/service/branches_test.go` (complete file):

```go
package service

import (
	"context"
	"strings"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

func mustProject(t *testing.T, tc *testCore, name string) (projectID string, mainID string) {
	t.Helper()
	p, main, err := tc.core.CreateProject(context.Background(), name, nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.ID, main.Row.ID
}

func TestCreateBranchDefaultsToMainParent(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	evts, unsub := collectEvents(tc)
	defer unsub()
	d, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{
		ProjectID: projectID, Name: "agent/task-1", CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.ParentBranchID == nil || *d.Row.ParentBranchID != mainID {
		t.Fatalf("parent = %v, want main", d.Row.ParentBranchID)
	}
	// engine call: branch mode — ancestor set, read_only false, NO pg_version
	last := tc.ps.creates[len(tc.ps.creates)-1].Req
	if last.AncestorTimelineID == "" || last.PgVersion != 0 || last.ReadOnly == nil || *last.ReadOnly != false {
		t.Fatalf("branch create req = %+v", last)
	}
	if last.AncestorStartLSN != "" {
		t.Fatal("no atLsn was requested")
	}
	if _, ok := tc.core.Owners.Get(d.Row.ID); !ok {
		t.Fatal("new branch's owner must be registered")
	}
	found := false
	for _, e := range *evts {
		if e.Type == "branch.created" && e.BranchID == d.Row.ID && e.ProjectID == projectID {
			found = true
		}
	}
	if !found {
		t.Fatal("branch.created must be published")
	}
}

func TestCreateBranchValidationAndConflicts(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()

	_, err := tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: "nope", Name: "x", CreatedBy: "api"})
	if serr, ok := err.(*Error); !ok || serr.Status != 404 || serr.Message != "project nope not found" {
		t.Fatalf("missing project = %v", err)
	}
	_, err = tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: projectID, Name: "!bad!", CreatedBy: "api"})
	if serr, ok := err.(*Error); !ok || serr.Status != 400 || !strings.Contains(serr.Message, "invalid branch name") {
		t.Fatalf("bad name = %v", err)
	}
	_, err = tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: projectID, Name: "x", ParentSpecified: true, ParentBranchID: nil, CreatedBy: "api"})
	if serr, ok := err.(*Error); !ok || serr.Status != 400 ||
		serr.Message != "parentBranchId cannot be null — root branches only exist via project create" {
		t.Fatalf("null parent = %v", err)
	}
	otherProject, _ := mustProject(t, tc, "other")
	otherMain, _, _ := tc.st.BranchByProjectAndName(ctx, otherProject, "main")
	_, err = tc.core.CreateBranch(ctx, CreateBranchParams{
		ProjectID: projectID, Name: "x", ParentSpecified: true, ParentBranchID: &otherMain.ID, CreatedBy: "api",
	})
	if serr, ok := err.(*Error); !ok || serr.Status != 400 || serr.Message != "parent branch belongs to a different project" {
		t.Fatalf("cross-project parent = %v", err)
	}
	if _, err := tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"}); err != nil {
		t.Fatal(err)
	}
	_, err = tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"})
	if serr, ok := err.(*Error); !ok || serr.Status != 409 ||
		serr.Message != `branch "dev" already exists in project "acme"` {
		t.Fatalf("dup = %v", err)
	}
	_ = mainID // main participates only as the implicit default parent above
}

func TestCreateBranchClassifiesLsnRangeError(t *testing.T) {
	tc := newTestCore(t)
	projectID, _ := mustProject(t, tc, "acme")
	// An engine LSN-range failure on a create-at-LSN maps to the
	// client-actionable 400 (compensation on engine failures after a
	// successful timeline create is covered by the restore tests).
	tc.ps.createErr = &engine.APIError{Op: "timeline_create", Status: 400, Body: "requested LSN is out of range for the ancestor"}
	lsn := "0/DEADBEEF"
	_, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{
		ProjectID: projectID, Name: "pitr", AtLsn: &lsn, CreatedBy: "api",
	})
	serr, ok := err.(*Error)
	if !ok || serr.Status != 400 || !strings.HasPrefix(serr.Message, "target point not available on this branch: ") {
		t.Fatalf("lsn-range classify = %v", err)
	}
}

func TestRenameBranch(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	d, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"})
	if err != nil {
		t.Fatal(err)
	}
	evts, unsub := collectEvents(tc)
	defer unsub()
	ren, err := tc.core.RenameBranch(context.Background(), d.Row.ID, "dev-renamed")
	if err != nil || ren.Row.Name != "dev-renamed" || ren.Row.Slug != d.Row.Slug {
		t.Fatalf("rename = %+v, %v", ren.Row, err)
	}
	if len(*evts) != 1 || (*evts)[0].Type != "branch.updated" {
		t.Fatalf("events = %v", *evts)
	}
	// same-name rename is a true no-op: no event
	if _, err := tc.core.RenameBranch(context.Background(), d.Row.ID, "dev-renamed"); err != nil {
		t.Fatal(err)
	}
	if len(*evts) != 1 {
		t.Fatal("no-op rename must not publish")
	}
	// duplicate 409
	if _, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{ProjectID: projectID, Name: "taken", CreatedBy: "api"}); err != nil {
		t.Fatal(err)
	}
	_, err = tc.core.RenameBranch(context.Background(), d.Row.ID, "taken")
	if serr, ok := err.(*Error); !ok || serr.Status != 409 || serr.Message != `branch "taken" already exists in this project` {
		t.Fatalf("dup rename = %v", err)
	}
	// root refuses
	_, err = tc.core.RenameBranch(context.Background(), mainID, "primary")
	if serr, ok := err.(*Error); !ok || serr.Status != 400 ||
		serr.Message != "the root branch cannot be renamed — agent skills and workflows reference it by name" {
		t.Fatalf("root rename = %v", err)
	}
}

func TestDeleteBranchRefusesChildrenThenSucceeds(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	child, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"})
	if err != nil {
		t.Fatal(err)
	}
	err = tc.core.DeleteBranch(context.Background(), mainID)
	serr, ok := err.(*Error)
	if !ok || serr.Status != 409 || serr.Message != `branch "main" has child branches: dev — delete them first` {
		t.Fatalf("children refusal = %v", err)
	}
	if err := tc.core.DeleteBranch(context.Background(), child.Row.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := tc.core.Owners.Get(child.Row.ID); ok {
		t.Fatal("owner must be removed with the branch")
	}
	if err := tc.core.DeleteBranch(context.Background(), mainID); err != nil {
		t.Fatal(err)
	}
}

func TestBranchesByProjectListsDetails(t *testing.T) {
	tc := newTestCore(t)
	projectID, _ := mustProject(t, tc, "acme")
	if _, err := tc.core.CreateBranch(context.Background(), CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"}); err != nil {
		t.Fatal(err)
	}
	list, err := tc.core.BranchesByProject(context.Background(), projectID)
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %d, %v", len(list), err)
	}
	if _, err := tc.core.BranchesByProject(context.Background(), "nope"); err == nil {
		t.Fatal("missing project must 404")
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestCreateBranch|TestRename|TestDeleteBranch|TestBranchesBy' 2>&1 | tail -8`
Expected: compile errors.

- [ ] **Step 3: Write `internal/service/branches.go`** (complete file):

```go
package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/compute"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

var branchNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 /._-]{0,62}$`)

type CreateBranchParams struct {
	ProjectID string
	Name      string
	// ParentSpecified distinguishes an ABSENT parentBranchId (default to the
	// project's main branch) from an explicit null (a 400 — root branches
	// only exist via project create).
	ParentBranchID  *string
	ParentSpecified bool
	AtLsn           *string
	CreatedBy       string
	ContextJSON     *string
}

// CreateBranch forks a timeline under the parent and inserts the branch row.
// The whole mutation runs inside the PARENT's owner lane: a concurrent
// delete of the parent (which runs in the same lane) can never interleave —
// in-lane re-checks catch a parent that vanished or a name taken while this
// job waited its turn.
func (c *Core) CreateBranch(ctx context.Context, p CreateBranchParams) (BranchDetail, error) {
	name := strings.TrimSpace(p.Name)
	project, ok, err := c.Store.ProjectByID(ctx, p.ProjectID)
	if err != nil {
		return BranchDetail{}, err
	}
	if !ok {
		return BranchDetail{}, Errf(404, "project %s not found", p.ProjectID)
	}
	if !branchNameRe.MatchString(name) {
		return BranchDetail{}, Errf(400, "invalid branch name: %q", p.Name)
	}
	if _, exists, err := c.Store.BranchByProjectAndName(ctx, project.ID, name); err != nil {
		return BranchDetail{}, err
	} else if exists {
		return BranchDetail{}, Errf(409, `branch "%s" already exists in project "%s"`, name, project.Name)
	}

	var parent store.BranchRow
	switch {
	case !p.ParentSpecified:
		main, ok, err := c.Store.BranchByProjectAndName(ctx, project.ID, "main")
		if err != nil {
			return BranchDetail{}, err
		}
		if !ok {
			return BranchDetail{}, Errf(500, `project "%s" has no main branch`, project.Name)
		}
		parent = main
	case p.ParentBranchID == nil:
		return BranchDetail{}, Errf(400, "parentBranchId cannot be null — root branches only exist via project create")
	default:
		pb, err := c.branchOr404(ctx, *p.ParentBranchID)
		if err != nil {
			return BranchDetail{}, err
		}
		if pb.ProjectID != project.ID {
			return BranchDetail{}, Errf(400, "parent branch belongs to a different project")
		}
		parent = pb
	}

	owner, ok := c.Owners.Get(parent.ID)
	if !ok {
		return BranchDetail{}, Errf(409, `parent branch "%s" was deleted while creating "%s"`, parent.Name, name)
	}
	var row store.BranchRow
	runErr := owner.Run(ctx, func(ctx context.Context) error {
		// in-lane re-checks: the world may have moved while we queued
		if _, stillThere, err := c.Store.BranchByID(ctx, parent.ID); err != nil {
			return err
		} else if !stillThere {
			return Errf(409, `parent branch "%s" was deleted while creating "%s"`, parent.Name, name)
		}
		if _, taken, err := c.Store.BranchByProjectAndName(ctx, project.ID, name); err != nil {
			return err
		} else if taken {
			return Errf(409, `branch "%s" already exists in project "%s"`, name, project.Name)
		}
		// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline
		// (routes.rs, timeline_create_handler; branch mode — ancestor_timeline_id
		// [+ ancestor_start_lsn], read_only false).
		timelineID := store.NewID()
		ro := false
		req := engine.TimelineCreateRequest{
			NewTimelineID: timelineID, AncestorTimelineID: parent.TimelineID, ReadOnly: &ro,
		}
		if p.AtLsn != nil {
			req.AncestorStartLSN = *p.AtLsn
		}
		if err := c.Pageserver.TimelineCreate(ctx, project.ID, req); err != nil {
			if p.AtLsn != nil {
				return c.classifyLsnRangeError(err)
			}
			return err
		}
		created, err := c.Store.CreateBranch(ctx, store.BranchParams{
			ID: store.NewID(), ProjectID: project.ID, ParentBranchID: &parent.ID,
			Name: name, Slug: fmt.Sprintf("%s-%s", Slugify(project.Name, name), timelineID[:6]),
			TimelineID: timelineID, ForkLSN: p.AtLsn,
			Password: compute.GeneratePassword(), CreatedBy: p.CreatedBy, ContextJSON: p.ContextJSON,
		})
		if err != nil {
			// compensation: never leave a live timeline behind a failed create.
			if cerr := c.Pageserver.TimelineDelete(ctx, project.ID, timelineID); cerr != nil {
				c.Log.Error("compensation failed — orphaned timeline on pageserver", "timeline", timelineID, "err", cerr)
			}
			if cerr := c.Safekeeper.TimelineDelete(ctx, project.ID, timelineID); cerr != nil {
				c.Log.Error("compensation failed — orphaned timeline on safekeeper", "timeline", timelineID, "err", cerr)
			}
			return classifyConstraint(err)
		}
		row = created
		return nil
	})
	if runErr != nil {
		return BranchDetail{}, runErr
	}
	c.RegisterBranchOwner(row.ID)
	c.Bus.Publish("branch.created", project.ID, row.ID)
	return c.detailOf(ctx, row)
}

// classifyLsnRangeError reclassifies the engine's unmaterializable-
// ancestor_start_lsn failures into a client-actionable 400 — the requested
// point isn't on this branch's retained history. Any other engine error is a
// real infra problem and passes through untouched.
// oracle: neon pageserver CreateTimelineError::AncestorLsn/AncestorNotActive/
// AncestorArchived (pageserver/src/tenant.rs; mapped in http/routes.rs,
// timeline_create_handler).
var lsnRangeRe = regexp.MustCompile(`(?i)lsn|out of range|bad request|not found`)

func (c *Core) classifyLsnRangeError(err error) error {
	var apiErr *engine.APIError
	if !errors.As(err, &apiErr) {
		return err
	}
	text := apiErr.Body + " " + apiErr.Error()
	if lsnRangeRe.MatchString(text) {
		body := apiErr.Body
		if len(body) > 300 {
			body = body[:300]
		}
		return Errf(400, "target point not available on this branch: %s", body)
	}
	return err
}

// BranchesByProject returns detail read-models for every branch (404 on a
// missing project — list routes check the project first).
func (c *Core) BranchesByProject(ctx context.Context, projectID string) ([]BranchDetail, error) {
	if _, err := c.projectOr404(ctx, projectID); err != nil {
		return nil, err
	}
	rows, err := c.Store.BranchesByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]BranchDetail, 0, len(rows))
	for _, b := range rows {
		d, err := c.detailOf(ctx, b)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

// RenameBranch mutates NAME only — slug is immutable (it feeds compute
// naming and directories). The root branch is not renameable: agent skills
// and conventions reference "main" by name.
func (c *Core) RenameBranch(ctx context.Context, branchID, newName string) (BranchDetail, error) {
	name := strings.TrimSpace(newName)
	b, err := c.branchOr404(ctx, branchID)
	if err != nil {
		return BranchDetail{}, err
	}
	if !branchNameRe.MatchString(name) {
		return BranchDetail{}, Errf(400, "invalid branch name: %q", newName)
	}
	if b.ParentBranchID == nil {
		return BranchDetail{}, Errf(400, "the root branch cannot be renamed — agent skills and workflows reference it by name")
	}
	owner, ok := c.Owners.Get(branchID)
	if !ok {
		return BranchDetail{}, Errf(404, "branch %s not found", branchID)
	}
	if err := owner.Run(ctx, func(ctx context.Context) error {
		current, ok, err := c.Store.BranchByID(ctx, branchID)
		if err != nil {
			return err
		}
		if !ok {
			return Errf(404, "branch %s not found", branchID)
		}
		if current.Name == name {
			return nil // true no-op: no write, no event
		}
		if _, taken, err := c.Store.BranchByProjectAndName(ctx, current.ProjectID, name); err != nil {
			return err
		} else if taken {
			return Errf(409, `branch "%s" already exists in this project`, name)
		}
		if err := c.Store.RenameBranch(ctx, branchID, name); err != nil {
			return err
		}
		c.Bus.Publish("branch.updated", current.ProjectID, branchID)
		return nil
	}); err != nil {
		return BranchDetail{}, err
	}
	return c.BranchDetail(ctx, branchID)
}

// DeleteBranch refuses while children exist, then tears the branch down
// inside its own lane and removes its owner.
func (c *Core) DeleteBranch(ctx context.Context, branchID string) error {
	if _, err := c.branchOr404(ctx, branchID); err != nil {
		return err
	}
	owner, ok := c.Owners.Get(branchID)
	if !ok {
		return Errf(404, "branch %s not found", branchID)
	}
	if err := owner.Run(ctx, func(ctx context.Context) error {
		current, ok, err := c.Store.BranchByID(ctx, branchID)
		if err != nil {
			return err
		}
		if !ok {
			return Errf(404, "branch %s not found", branchID)
		}
		children, err := c.Store.BranchesByParent(ctx, current.ID)
		if err != nil {
			return err
		}
		if len(children) > 0 {
			names := make([]string, len(children))
			for i, ch := range children {
				names[i] = ch.Name
			}
			return Errf(409, `branch "%s" has child branches: %s — delete them first`, current.Name, strings.Join(names, ", "))
		}
		return c.teardownBranchLocked(ctx, current)
	}); err != nil {
		return err
	}
	c.Owners.Remove(branchID)
	return nil
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues (the whole service package — Tasks 8–9's tests stay green).

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service && git commit -m "feat(service): branch create under the parent lane, rename, delete, listings"
```

---

### Task 11: service — timetravel as durable operations

Restore/reset land here — the first REAL operation kinds, which is why the plan fingerprint came due in Task 2. `restore_in_place` = new timeline branched at the target LSN from the branch's OWN timeline → detach_ancestor (reparents children) → row identity swap; `reset_to_parent` = fresh fork of the PARENT's head + the same swap, NO detach. Both run inside the branch's owner lane as a durable `operations` row executed step-wise (`stop_endpoint` → `create_timeline` → `detach_ancestor` → `swap_rows`), fingerprint persisted at creation. **Boot policy: fail-forward** (`interrupted by restart`) for both kinds — an interrupted restore surfaces as a failed operation, retry-allowed; flipping to resume is a post-parity option the step cursor already supports. Compensation on step failure mirrors the create paths: delete the half-created timeline on both components, restart the endpoint if it was running. `branch_at_timestamp` (non-destructive PITR) is just `CreateBranch` with a resolved LSN.

**Files:**
- Create: `~/git/worktreedb/internal/service/timetravel.go`
- Create: `~/git/worktreedb/internal/service/timetravel_test.go`

**Interfaces:**
- Consumes: Tasks 8–10 (`setSpecAndConvergeLocked`, `CreateBranch`, `classifyLsnRangeError`, `teardownBranchLocked` is NOT used here), Task 2 (`runtime.RunOperation`, `PlanFingerprint`, `store.CreateOperation`).
- Produces:
  - `func (c *Core) LsnAtTimestamp(ctx, branchID, isoTimestamp string) (string, error)`
  - `type BranchAtParams struct { ProjectID, SourceBranchID, Name, To string; CreatedBy string; ContextJSON *string }` and `func (c *Core) BranchAtTimestamp(ctx, p BranchAtParams) (BranchDetail, error)`
  - `func (c *Core) RestoreInPlace(ctx, branchID, to string) (BranchDetail, error)`
  - `func (c *Core) ResetToParent(ctx, branchID string) (BranchDetail, error)`
  - Operation kinds (exact strings): `"restore_in_place"`, `"reset_to_parent"`; `func TimetravelBootPolicies() map[string]runtime.BootPolicy` (both `FailForwardOnBoot`) — Task 14 passes this to `ResumeIncomplete`.

- [ ] **Step 1: Write the failing tests** — `internal/service/timetravel_test.go` (complete file):

```go
package service

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

func TestLsnAtTimestampValidatesAndResolves(t *testing.T) {
	tc := newTestCore(t)
	_, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()

	if _, err := tc.core.LsnAtTimestamp(ctx, "nope", "2026-07-11T09:00:00Z"); err.(*Error).Status != 404 {
		t.Fatal(err)
	}
	_, err := tc.core.LsnAtTimestamp(ctx, mainID, "2026-07-11T09:00:00")
	if serr, ok := err.(*Error); !ok || serr.Status != 400 ||
		serr.Message != "timestamp must include an explicit timezone (Z or ±HH:MM)" {
		t.Fatalf("naive timestamp = %v", err)
	}
	_, err = tc.core.LsnAtTimestamp(ctx, mainID, "2026-13-45T99:00:00Z")
	if serr, ok := err.(*Error); !ok || serr.Status != 400 || !strings.HasPrefix(serr.Message, "invalid timestamp: ") {
		t.Fatalf("unparseable = %v", err)
	}
	lsn, err := tc.core.LsnAtTimestamp(ctx, mainID, "2026-07-11T09:00:00+02:00")
	if err != nil || lsn != "0/1000" {
		t.Fatalf("lsn = %q, %v", lsn, err)
	}
	// the engine receives normalized UTC-with-milliseconds
	if tc.storcon.lastTimestamp != "2026-07-11T07:00:00.000Z" {
		t.Fatalf("normalized timestamp = %q", tc.storcon.lastTimestamp)
	}
	// kind != present → the actionable 400 pair
	tc.storcon.lsn = engine.LsnByTimestamp{LSN: "0/1", Kind: "future"}
	_, err = tc.core.LsnAtTimestamp(ctx, mainID, "2026-07-11T09:00:00Z")
	if serr, ok := err.(*Error); !ok || serr.Status != 400 ||
		!strings.Contains(serr.Message, `that timestamp is ahead of this branch's history (kind=future)`) ||
		!strings.Contains(serr.Message, `on "main"`) {
		t.Fatalf("future = %v", err)
	}
	tc.storcon.lsn = engine.LsnByTimestamp{LSN: "0/1", Kind: "past"}
	_, err = tc.core.LsnAtTimestamp(ctx, mainID, "2026-07-11T09:00:00Z")
	if serr, ok := err.(*Error); !ok || !strings.Contains(serr.Message, "before this branch's retained history (kind=past)") {
		t.Fatalf("past = %v", err)
	}
}

func TestBranchAtTimestampCreatesAtResolvedLsn(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	d, err := tc.core.BranchAtTimestamp(context.Background(), BranchAtParams{
		ProjectID: projectID, SourceBranchID: mainID, Name: "rescued",
		To: "2026-07-11T09:00:00Z", CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.Name != "rescued" || d.Row.ParentBranchID == nil || *d.Row.ParentBranchID != mainID {
		t.Fatalf("row = %+v", d.Row)
	}
	last := tc.ps.creates[len(tc.ps.creates)-1].Req
	if last.AncestorStartLSN != "0/1000" {
		t.Fatalf("create must carry the resolved LSN: %+v", last)
	}
}

func TestRestoreInPlaceSwapsIdentityAndRestarts(t *testing.T) {
	tc := newTestCore(t)
	_, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()
	if _, err := tc.core.StartEndpoint(ctx, mainID); err != nil {
		t.Fatal(err)
	}
	tc.ps.reparented = []string{} // no children to reparent
	evts, unsub := collectEvents(tc)
	defer unsub()

	d, err := tc.core.RestoreInPlace(ctx, mainID, "2026-07-11T09:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.ID == mainID {
		t.Fatal("in-place restore must mint a NEW row id")
	}
	if d.Row.Name != "main" {
		t.Fatalf("restored branch must keep its name, got %q", d.Row.Name)
	}
	if d.Row.StatusEndpoint != "running" {
		t.Fatalf("wasRunning restore must restart, got %s", d.Row.StatusEndpoint)
	}
	// archived row: renamed, still present
	archived, _, _ := tc.st.BranchByID(ctx, mainID)
	if !strings.HasPrefix(archived.Name, "main_pitr_archived_") {
		t.Fatalf("archived name = %q", archived.Name)
	}
	// engine sequence: create at LSN from OWN timeline, then detach
	last := tc.ps.creates[len(tc.ps.creates)-1].Req
	if last.AncestorTimelineID != archived.TimelineID || last.AncestorStartLSN != "0/1000" {
		t.Fatalf("restore create req = %+v", last)
	}
	// durable operation: done, fingerprinted
	ops, err := tc.st.IncompleteOperations(ctx)
	if err != nil || len(ops) != 0 {
		t.Fatalf("no operation may stay incomplete: %v %v", ops, err)
	}
	// branch.updated announced for the swapped identity
	found := false
	for _, e := range *evts {
		if e.Type == "branch.updated" && e.BranchID == d.Row.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("branch.updated for the swapped branch must be published")
	}
	// new owner registered; archived owner still present (it is a live row)
	if _, ok := tc.core.Owners.Get(d.Row.ID); !ok {
		t.Fatal("swapped branch needs an owner")
	}
}

func TestRestoreRefusedMidTransition(t *testing.T) {
	tc := newTestCore(t)
	_, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()
	// Force a mid-transition status directly (no converge in flight — this
	// pins the guard, not the race).
	if err := tc.st.WithTx(ctx, func(tx *sql.Tx) error {
		return store.ApplyEndpointStatus(tx, mainID, store.EndpointStatusUpdate{Endpoint: "starting"})
	}); err != nil {
		t.Fatal(err)
	}
	_, err := tc.core.RestoreInPlace(ctx, mainID, "2026-07-11T09:00:00Z")
	if serr, ok := err.(*Error); !ok || serr.Status != 409 || serr.Message != "endpoint is mid-transition — retry when it settles" {
		t.Fatalf("mid-transition = %v", err)
	}
}

func TestRestoreCompensatesOnDetachFailure(t *testing.T) {
	tc := newTestCore(t)
	_, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()
	if _, err := tc.core.StartEndpoint(ctx, mainID); err != nil {
		t.Fatal(err)
	}
	tc.ps.detachErr = errFake("detach exploded")
	_, err := tc.core.RestoreInPlace(ctx, mainID, "2026-07-11T09:00:00Z")
	if err == nil {
		t.Fatal("must surface")
	}
	// the half-created timeline was deleted on both components
	if len(tc.ps.deletes) == 0 || len(tc.sk.deletes) == 0 {
		t.Fatalf("compensation deletes: ps=%v sk=%v", tc.ps.deletes, tc.sk.deletes)
	}
	// original identity intact and running again
	d, _ := tc.core.BranchDetail(ctx, mainID)
	if d.Row.Name != "main" || d.Row.StatusEndpoint != "running" {
		t.Fatalf("original must be restored to running: %+v", d.Row)
	}
	// the operation row is failed
	// (list all: none incomplete; the failed one is terminal)
	ops, _ := tc.st.IncompleteOperations(ctx)
	if len(ops) != 0 {
		t.Fatalf("ops must be terminal: %v", ops)
	}
}

func TestResetToParentGuards(t *testing.T) {
	tc := newTestCore(t)
	projectID, mainID := mustProject(t, tc, "acme")
	ctx := context.Background()
	// root has no parent
	_, err := tc.core.ResetToParent(ctx, mainID)
	if serr, ok := err.(*Error); !ok || serr.Status != 400 ||
		serr.Message != `branch "main" has no parent — reset needs a parent to reset to. Reset a child branch instead, or use restore_branch to go to a past point on "main".` {
		t.Fatalf("no-parent = %v", err)
	}
	child, err := tc.core.CreateBranch(ctx, CreateBranchParams{ProjectID: projectID, Name: "dev", CreatedBy: "api"})
	if err != nil {
		t.Fatal(err)
	}
	grand, err := tc.core.CreateBranch(ctx, CreateBranchParams{
		ProjectID: projectID, Name: "dev2", ParentSpecified: true, ParentBranchID: &child.Row.ID, CreatedBy: "api",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = tc.core.ResetToParent(ctx, child.Row.ID)
	if serr, ok := err.(*Error); !ok || serr.Status != 409 ||
		serr.Message != `branch "dev" has child branches: dev2 — delete them first` {
		t.Fatalf("children = %v", err)
	}
	if err := tc.core.DeleteBranch(ctx, grand.Row.ID); err != nil {
		t.Fatal(err)
	}
	d, err := tc.core.ResetToParent(ctx, child.Row.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Row.ID == child.Row.ID || d.Row.Name != "dev" {
		t.Fatalf("reset swap = %+v", d.Row)
	}
	// reset forks the PARENT's head: ancestor = main's timeline, NO LSN, NO detach
	last := tc.ps.creates[len(tc.ps.creates)-1].Req
	mainRow, _, _ := tc.st.BranchByID(ctx, mainID)
	if last.AncestorTimelineID != mainRow.TimelineID || last.AncestorStartLSN != "" {
		t.Fatalf("reset create req = %+v", last)
	}
}
```

The timetravel test file's imports: `context`, `database/sql`, `strings`, `testing`, plus `internal/engine` and `internal/store`.

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestLsnAt|TestBranchAt|TestRestore|TestReset' 2>&1 | tail -8`
Expected: compile errors.

- [ ] **Step 3: Write `internal/service/timetravel.go`** (complete file):

```go
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Operation kinds. The kind string is part of the durable contract: boot
// resume policy is keyed on it, and rows created by an older binary with an
// unknown kind fail forward safely.
const (
	OpRestoreInPlace = "restore_in_place"
	OpResetToParent  = "reset_to_parent"
)

// TimetravelBootPolicies: interrupted restores/resets FAIL FORWARD at boot
// ("interrupted by restart", terminal, retry-allowed). The step cursor and
// plan fingerprint already support flipping either kind to ResumeOnBoot; that
// flip is a deliberate post-parity decision, not this milestone's.
func TimetravelBootPolicies() map[string]runtime.BootPolicy {
	return map[string]runtime.BootPolicy{
		OpRestoreInPlace: runtime.FailForwardOnBoot,
		OpResetToParent:  runtime.FailForwardOnBoot,
	}
}

// timestamps must carry an explicit timezone: a bare local time resolves to
// different instants on different machines — a correctness trap for PITR.
var tsWithZoneRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)

// LsnAtTimestamp resolves an ISO instant to an LSN on the branch's timeline.
// oracle: neon pageserver GET …/timeline/:timeline_id/get_lsn_by_timestamp
// (routes.rs, get_lsn_by_timestamp_handler), reached via storcon which
// proxies the route.
func (c *Core) LsnAtTimestamp(ctx context.Context, branchID, isoTimestamp string) (string, error) {
	b, err := c.branchOr404(ctx, branchID)
	if err != nil {
		return "", err
	}
	if !tsWithZoneRe.MatchString(isoTimestamp) {
		return "", Errf(400, "timestamp must include an explicit timezone (Z or ±HH:MM)")
	}
	parsed, perr := time.Parse(time.RFC3339, strings.Replace(isoTimestamp, " ", "T", 1))
	if perr != nil {
		return "", Errf(400, "invalid timestamp: %s", isoTimestamp)
	}
	normalized := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
	out, err := c.Storcon.GetLsnByTimestamp(ctx, b.ProjectID, b.TimelineID, normalized)
	if err != nil {
		return "", err
	}
	if out.Kind != "present" {
		why := "that timestamp is before this branch's retained history"
		if out.Kind == "future" {
			why = "that timestamp is ahead of this branch's history"
		}
		return "", Errf(400, `cannot resolve %s on "%s": %s (kind=%s)`, isoTimestamp, b.Name, why, out.Kind)
	}
	return out.LSN, nil
}

type BranchAtParams struct {
	ProjectID      string
	SourceBranchID string
	Name           string
	To             string
	CreatedBy      string
	ContextJSON    *string
}

// BranchAtTimestamp is non-destructive PITR: a new, ordinary branch at the
// resolved LSN. Nothing about the source branch changes.
func (c *Core) BranchAtTimestamp(ctx context.Context, p BranchAtParams) (BranchDetail, error) {
	lsn, err := c.LsnAtTimestamp(ctx, p.SourceBranchID, p.To)
	if err != nil {
		return BranchDetail{}, err
	}
	return c.CreateBranch(ctx, CreateBranchParams{
		ProjectID: p.ProjectID, Name: p.Name,
		ParentSpecified: true, ParentBranchID: &p.SourceBranchID,
		AtLsn: &lsn, CreatedBy: p.CreatedBy, ContextJSON: p.ContextJSON,
	})
}

// RestoreInPlace rewinds the branch itself: a new timeline branched at the
// target LSN from the branch's OWN timeline, children reparented via
// detach_ancestor, then the row identity swap (the old row is archived).
// oracle: neon pageserver POST /v1/tenant/:tenant_shard_id/timeline
// (create-at-LSN) + PUT …/timeline/:timeline_id/detach_ancestor (routes.rs)
// for the engine-facing steps; the identity swap and the endpoint stop/
// restart around it are this daemon's own state-model choices.
func (c *Core) RestoreInPlace(ctx context.Context, branchID, to string) (BranchDetail, error) {
	lsn, err := c.LsnAtTimestamp(ctx, branchID, to)
	if err != nil {
		return BranchDetail{}, err
	}
	return c.swapOntoNewTimeline(ctx, branchID, swapOpts{
		kind: OpRestoreInPlace, archiveTag: "pitr", atLsn: &lsn, detachAncestor: true,
		ancestorOfOwnTimeline: true,
	})
}

// ResetToParent forks the parent's CURRENT head under the same swap
// machinery — no detach (the new timeline's ancestor already IS the parent).
func (c *Core) ResetToParent(ctx context.Context, branchID string) (BranchDetail, error) {
	return c.swapOntoNewTimeline(ctx, branchID, swapOpts{
		kind: OpResetToParent, archiveTag: "reset", atLsn: nil, detachAncestor: false,
	})
}

type swapOpts struct {
	kind       string
	archiveTag string
	atLsn      *string
	// detachAncestor: restore only — collapse the old ancestor chain and
	// reparent children onto the new timeline.
	detachAncestor bool
	// ancestorOfOwnTimeline: restore branches from the row's OWN timeline;
	// reset resolves the parent's inside the lane (with its guards).
	ancestorOfOwnTimeline bool
}

func (c *Core) swapOntoNewTimeline(ctx context.Context, branchID string, opts swapOpts) (BranchDetail, error) {
	owner, ok := c.Owners.Get(branchID)
	if !ok {
		return BranchDetail{}, Errf(404, "branch %s not found", branchID)
	}
	var swapped store.BranchRow
	var wasRunning bool
	runErr := owner.Run(ctx, func(ctx context.Context) error {
		b, ok, err := c.Store.BranchByID(ctx, branchID)
		if err != nil {
			return err
		}
		if !ok {
			return Errf(404, "branch %s not found", branchID)
		}
		if b.StatusEndpoint == "starting" || b.StatusEndpoint == "stopping" {
			return Errf(409, "endpoint is mid-transition — retry when it settles")
		}
		wasRunning = b.StatusEndpoint == "running"

		var ancestorTimelineID string
		if opts.ancestorOfOwnTimeline {
			ancestorTimelineID = b.TimelineID
		} else {
			// reset guards, checked lane-fresh: parent exists, no children
			if b.ParentBranchID == nil {
				return Errf(400,
					`branch "%s" has no parent — reset needs a parent to reset to. Reset a child branch instead, or use restore_branch to go to a past point on "%s".`,
					b.Name, b.Name)
			}
			children, err := c.Store.BranchesByParent(ctx, b.ID)
			if err != nil {
				return err
			}
			if len(children) > 0 {
				names := make([]string, len(children))
				for i, ch := range children {
					names[i] = ch.Name
				}
				return Errf(409, `branch "%s" has child branches: %s — delete them first`, b.Name, strings.Join(names, ", "))
			}
			parent, ok, err := c.Store.BranchByID(ctx, *b.ParentBranchID)
			if err != nil {
				return err
			}
			if !ok {
				return Errf(404, "branch %s not found", *b.ParentBranchID)
			}
			ancestorTimelineID = parent.TimelineID
		}

		newTimelineID := store.NewID()
		stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
		var reparented []string
		timelineCreated := false

		steps := []runtime.Step{
			{Name: "stop_endpoint", Do: func(ctx context.Context) error {
				if !wasRunning {
					return nil
				}
				// In-lane spec write + direct converge: the endpoint stop
				// persists the same stopping→stopped arc a user stop would.
				return c.setSpecAndConvergeLocked(ctx, branchID, "stopped")
			}},
			{Name: "create_timeline", Do: func(ctx context.Context) error {
				ro := false
				req := engine.TimelineCreateRequest{
					NewTimelineID: newTimelineID, AncestorTimelineID: ancestorTimelineID, ReadOnly: &ro,
				}
				if opts.atLsn != nil {
					req.AncestorStartLSN = *opts.atLsn
				}
				if err := c.Pageserver.TimelineCreate(ctx, b.ProjectID, req); err != nil {
					if opts.atLsn != nil {
						return c.classifyLsnRangeError(err)
					}
					return err
				}
				timelineCreated = true
				return nil
			}},
			{Name: "detach_ancestor", Do: func(ctx context.Context) error {
				if !opts.detachAncestor {
					return nil
				}
				out, err := c.Pageserver.TimelineDetachAncestor(ctx, b.ProjectID, newTimelineID)
				if err != nil {
					return err
				}
				reparented = out.ReparentedTimelines
				return nil
			}},
			{Name: "swap_rows", Do: func(ctx context.Context) error {
				row, err := c.Store.RestoreSwap(ctx, store.RestoreSwapParams{
					OldBranchID:   branchID,
					NewBranchID:   store.NewID(),
					NewTimelineID: newTimelineID,
					ArchiveName:   fmt.Sprintf("%s_%s_archived_%s", b.Name, opts.archiveTag, stamp),
					ArchiveSlug:   fmt.Sprintf("%s-%s-%s", Slugify(b.Slug), opts.archiveTag, newTimelineID[:6]),
					ReparentedTimelineIDs: reparented,
				})
				if err != nil {
					return err
				}
				swapped = row
				return nil
			}},
		}
		params, _ := json.Marshal(map[string]any{
			"branch_id": branchID, "kind": opts.kind, "to_lsn": opts.atLsn, "new_timeline_id": newTimelineID,
		})
		opID, err := c.Store.CreateOperation(ctx, opts.kind, branchID, string(params), runtime.PlanFingerprint(steps))
		if err != nil {
			return err
		}
		if runErr := runtime.RunOperation(ctx, c.Store, opID, 0, steps); runErr != nil {
			// Compensation (the swap never happened — swap_rows is the last
			// step): delete the half-created timeline on both components,
			// restart the original endpoint if it was running. Loud on
			// compensation failure, never silent.
			if timelineCreated {
				if cerr := c.Pageserver.TimelineDelete(ctx, b.ProjectID, newTimelineID); cerr != nil {
					c.Log.Error("compensation failed — orphaned timeline on pageserver", "timeline", newTimelineID, "err", cerr)
				}
				if cerr := c.Safekeeper.TimelineDelete(ctx, b.ProjectID, newTimelineID); cerr != nil {
					c.Log.Error("compensation failed — orphaned timeline on safekeeper", "timeline", newTimelineID, "err", cerr)
				}
			}
			if wasRunning {
				if cerr := c.setSpecAndConvergeLocked(ctx, branchID, "running"); cerr != nil {
					c.Log.Error("compensation failed — endpoint not restarted after a failed restore", "branch", branchID, "err", cerr)
				}
			}
			return runErr
		}
		// Announce the swap the moment it is durable — the restart below is a
		// separate failure domain and must not gate the announcement.
		c.RegisterBranchOwner(swapped.ID)
		c.Bus.Publish("branch.updated", swapped.ProjectID, swapped.ID)
		return nil
	})
	if runErr != nil {
		return BranchDetail{}, runErr
	}
	// Restart under the NEW identity's own owner (a fresh lane — nothing else
	// can reference it yet). A restart failure surfaces to the caller; the
	// swap already stands and was announced.
	if wasRunning {
		if _, err := c.StartEndpoint(ctx, swapped.ID); err != nil {
			return BranchDetail{}, err
		}
	}
	return c.BranchDetail(ctx, swapped.ID)
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1 && golangci-lint run`
Expected: PASS, 0 issues.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service && git commit -m "feat(service): timetravel restore and reset as fingerprinted durable operations"
```

---

### Task 12: service — SQL console over pgx (the milestone's one new dependency)

`POST /api/sql` executes a query on a branch's endpoint as the postgres superuser (the product's localhost trust posture — no auth gates anywhere in front of the REST API). Auto-starts the endpoint via `EnsureRunning`, dials **through the daemon's own slot listener** (127.0.0.1:<slot> — every SQL call exercises the same splice external clients use), runs the query over the simple protocol (multi-statement capable), and maps results to the wire shape. Value mapping mirrors conventional client-driver defaults exactly where the wire is observable: `bool→true/false`, `int2/int4/oid→number`, `float4/float8→number`, **`int8→string`**, `numeric→string`, everything else text, NULL→null (this is why callers write `count(*)::int`).

Dependency decision (record in the commit body AND in AGENTS.md): `github.com/jackc/pgx/v5` — pre-approved by the master spec's pinned stack; only the `pgconn` subpackage is imported (lowest-level, no ORM surface); pinned via go.mod + sumdb.

**Files:**
- Modify: `~/git/worktreedb/go.mod`, `~/git/worktreedb/go.sum` (via `go get`)
- Modify: `~/git/worktreedb/AGENTS.md` (dependency allowlist line)
- Create: `~/git/worktreedb/internal/service/sql.go`
- Create: `~/git/worktreedb/internal/service/sql_test.go`

**Interfaces:**
- Consumes: Task 8's `EnsureRunning`/`BranchDetail`.
- Produces:
  - `type SQLResult struct { Rows []map[string]any `json:"rows"`; RowCount int64 `json:"rowCount"`; Fields []string `json:"fields"`; Truncated bool `json:"truncated"` }`
  - `func (c *Core) RunSQL(ctx, branchID, query string) (SQLResult, error)`
  - `func mapSQLValue(oid uint32, raw []byte) any` (package-private; unit-tested directly).

- [ ] **Step 1: Add the dependency**

```bash
cd ~/git/worktreedb && go get github.com/jackc/pgx/v5@latest && go mod verify
```

Expected: go.mod gains `github.com/jackc/pgx/v5 vX.Y.Z` (plus its two transitive deps `jackc/pgpassfile`, `jackc/pgservicefile` as indirect); `go mod verify` prints `all modules verified`. Record the resolved version in the task report. Do NOT run `go mod tidy`. Move the pgx line into the direct-require block alongside `modernc.org/sqlite` if `go get` placed it elsewhere.

In `AGENTS.md`, extend the dependency allowlist line to:

```markdown
- **Dependencies:** standard library first. Every new module is an explicit
  decision recorded in the PR/commit that introduces it; `go.sum` (sumdb)
  must verify. Current allowlist: `modernc.org/sqlite`,
  `github.com/jackc/pgx/v5` (pgconn only — the SQL console's PostgreSQL
  client), `github.com/testcontainers/testcontainers-go` (test-only).
```

- [ ] **Step 2: Write the failing tests** — `internal/service/sql_test.go` (complete file):

```go
package service

import (
	"context"
	"net"
	"strings"
	"testing"
)

// strings is used by TestRunSQLNotRunning502IsUnreachableViaEnsure's guard
// below; drop it if that changes.

func TestMapSQLValue(t *testing.T) {
	cases := []struct {
		oid  uint32
		raw  string
		want any
	}{
		{16, "t", true}, {16, "f", false}, // bool
		{21, "7", int64(7)}, {23, "42", int64(42)}, {26, "1", int64(1)}, // int2/int4/oid → number
		{700, "1.5", 1.5}, {701, "2.25", 2.25}, // float4/float8 → number
		{20, "9007199254740993", "9007199254740993"}, // int8 stays a STRING (precision)
		{1700, "3.14", "3.14"},                       // numeric stays a string
		{25, "hello", "hello"},                       // text
	}
	for _, cse := range cases {
		got := mapSQLValue(cse.oid, []byte(cse.raw))
		if got != cse.want {
			t.Fatalf("mapSQLValue(%d, %q) = %#v, want %#v", cse.oid, cse.raw, got, cse.want)
		}
	}
	if got := mapSQLValue(23, nil); got != nil {
		t.Fatalf("NULL must map to nil, got %#v", got)
	}
}

func TestRunSQLValidation(t *testing.T) {
	tc := newTestCore(t)
	// Hermetic slot: point the fake proxy's range at a loopback port THIS
	// test owns, with a listener that accepts and immediately closes — never
	// dial into the published 54300+ range, which docker-proxy may be
	// holding on a developer machine while the product container runs.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close() // slam the door: pgconn's startup fails deterministically
		}
	}()
	slot := ln.Addr().(*net.TCPAddr).Port
	tc.prox.min, tc.prox.max = slot, slot

	_, mainID := mustProject(t, tc, "acme")
	_, err = tc.core.RunSQL(context.Background(), mainID, "   ")
	if serr, ok := err.(*Error); !ok || serr.Status != 400 || serr.Message != "empty query" {
		t.Fatalf("empty query = %v", err)
	}
	_, err = tc.core.RunSQL(context.Background(), "nope", "SELECT 1")
	if serr, ok := err.(*Error); !ok || serr.Status != 404 {
		t.Fatalf("missing branch = %v", err)
	}
	// EnsureRunning succeeds against the fake compute, but the "postgres"
	// behind the slot slams the connection — the failure must surface as the
	// dial/startup error, never as a hang and never as the 502 message.
	_, err = tc.core.RunSQL(context.Background(), mainID, "SELECT 1")
	if err == nil {
		t.Fatal("no real backend: RunSQL must fail")
	}
	if serr, ok := err.(*Error); ok && serr.Status == 502 {
		t.Fatalf("with a (fake-)running endpoint the failure is a connect error, not the 502 not-running message: %v", err)
	}
}

func TestRunSQLNotRunning502Message(t *testing.T) {
	// The 502 exists for the defensive state where EnsureRunning returns
	// without a running port (e.g. a converge that lost to a concurrent
	// stop). Pin the exact wire message.
	if got := notRunningMsg("main"); got != `endpoint for "main" is not running` {
		t.Fatal(got)
	}
	if !strings.HasPrefix(notRunningMsg("x"), "endpoint for ") {
		t.Fatal("message shape drifted")
	}
}
```

(Real end-to-end SQL behavior — multi-statement, rowCount, truncation — is exercised in-container by Task 15's integration test and the reference suite; unit scope here is the pure mapping + guards.)

- [ ] **Step 3: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestMapSQL -run TestRunSQL 2>&1 | tail -5` (run once per -run pattern)
Expected: compile errors.

- [ ] **Step 4: Write `internal/service/sql.go`** (complete file):

```go
package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// SQLResult is the console's wire shape. Rows are objects keyed by column
// name (duplicate column names collapse — alias them if you need both);
// Fields preserves column order.
type SQLResult struct {
	Rows      []map[string]any `json:"rows"`
	RowCount  int64            `json:"rowCount"`
	Fields    []string         `json:"fields"`
	Truncated bool             `json:"truncated"`
}

const maxSQLRows = 1000

func notRunningMsg(name string) string { return fmt.Sprintf(`endpoint for "%s" is not running`, name) }

// RunSQL executes SQL as the postgres superuser on the branch's endpoint —
// the product's localhost trust posture, not an oversight: nothing in front
// of this REST API gates auth, and this route is no special case. The
// endpoint auto-starts (EnsureRunning is idempotent and lane-serialized);
// the connection dials the daemon's own slot listener, so every console
// query travels the same spliced path external clients use.
func (c *Core) RunSQL(ctx context.Context, branchID, query string) (SQLResult, error) {
	if strings.TrimSpace(query) == "" {
		return SQLResult{}, Errf(400, "empty query")
	}
	detail, err := c.EnsureRunning(ctx, branchID)
	if err != nil {
		return SQLResult{}, err
	}
	if detail.Row.StatusEndpoint != "running" || detail.Row.StatusPort == nil {
		return SQLResult{}, &Error{Status: 502, Message: notRunningMsg(detail.Row.Name)}
	}
	cfg, err := pgconn.ParseConfig(fmt.Sprintf("postgresql://postgres:%s@127.0.0.1:%d/postgres",
		detail.Row.Password, *detail.Row.StatusPort))
	if err != nil {
		return SQLResult{}, err
	}
	cfg.ConnectTimeout = 10 * time.Second
	// statement_timeout is a session setting the submitted SQL can override;
	// the query context below is the driver-side bound that cannot be.
	cfg.RuntimeParams["statement_timeout"] = "30000"
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		return SQLResult{}, err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	queryCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	// Exec = simple query protocol: multi-statement strings run as one batch,
	// one result per statement.
	results, err := conn.Exec(queryCtx, query).ReadAll()
	if err != nil {
		return SQLResult{}, err
	}
	if len(results) == 0 {
		return SQLResult{Rows: []map[string]any{}, Fields: []string{}}, nil
	}
	// Report the last result carrying rows, else the last result (psql
	// display convention for multi-statement input).
	last := results[len(results)-1]
	for i := len(results) - 1; i >= 0; i-- {
		if len(results[i].Rows) > 0 {
			last = results[i]
			break
		}
	}
	fields := make([]string, len(last.FieldDescriptions))
	for i, fd := range last.FieldDescriptions {
		fields[i] = string(fd.Name)
	}
	total := len(last.Rows)
	capped := total
	if capped > maxSQLRows {
		capped = maxSQLRows
	}
	rows := make([]map[string]any, 0, capped)
	for _, raw := range last.Rows[:capped] {
		row := make(map[string]any, len(fields))
		for i, name := range fields {
			var val []byte
			if i < len(raw) {
				val = raw[i]
			}
			row[name] = mapSQLValue(last.FieldDescriptions[i].DataTypeOID, val)
		}
		rows = append(rows, row)
	}
	rowCount := last.CommandTag.RowsAffected()
	if rowCount == 0 && total > 0 {
		rowCount = int64(total)
	}
	return SQLResult{Rows: rows, RowCount: rowCount, Fields: fields, Truncated: total > capped}, nil
}

// mapSQLValue converts a simple-protocol text-format value to its JSON-side
// type, mirroring conventional client-driver defaults: small ints and floats
// become numbers; int8 and numeric STAY STRINGS (they exceed float64's exact
// range); bool becomes true/false; everything else is text; NULL is null.
func mapSQLValue(oid uint32, raw []byte) any {
	if raw == nil {
		return nil
	}
	s := string(raw)
	switch oid {
	case 16: // bool
		return s == "t"
	case 21, 23, 26: // int2, int4, oid
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
		return s
	case 700, 701: // float4, float8
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
		return s
	default:
		return s
	}
}
```

- [ ] **Step 5: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1 && go build ./... && go mod verify && golangci-lint run`
Expected: PASS, `all modules verified`, 0 issues.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add go.mod go.sum AGENTS.md internal/service && git commit -m "feat(service): sql console over pgconn with driver-faithful type mapping

New dependency: github.com/jackc/pgx/v5 (pgconn subpackage only) — the
PostgreSQL client for the SQL path. Pinned in go.mod; sumdb-verified."
```

---

### Task 13: api — the full REST surface, DTOs, SSE

The wire layer: every route, the DTO mapping (redaction by construction — the DTO structs simply have no password/slot fields), the error envelope, request validation with the `{"error":"invalid request body","issues":[…]}` shape, the Fastify-shaped `/api/*` 404, and the SSE writer (replay-then-live for logs; no-replay for events; slow client ⇒ drop, the client reconnects and replays).

**Files:**
- Modify: `~/git/worktreedb/internal/api/server.go`
- Create: `~/git/worktreedb/internal/api/dto.go`
- Create: `~/git/worktreedb/internal/api/sse.go`
- Modify: `~/git/worktreedb/internal/api/server_test.go`
- Create: `~/git/worktreedb/internal/api/routes_test.go`

**Interfaces:**
- Consumes: Task 8–12 Core methods (via the `CoreAPI` interface below), Task 4 `events.Bus`/`LogHub`, M1 `engine.Component`/`ExpectedComponents`.
- Produces:
  - `type CoreAPI interface` — the exact method set handlers call (below); `*service.Core` satisfies it.
  - `type Deps struct { Version string; PortRange config.PortRange; Engine StatusSource; Core CoreAPI; Bus *events.Bus; Hub *events.LogHub; ShutdownCtx context.Context }`
  - `func NewServer(d Deps) http.Handler` (replaces the M1 3-arg signature; main updates in Task 14).

- [ ] **Step 1: Write the failing tests.** Keep the existing `/api/status` test compiling by adapting its construction to the new `Deps` (mechanical). Then create `internal/api/routes_test.go` (complete file):

```go
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// fakeCore satisfies CoreAPI with canned rows — routing/DTO/envelope tests
// never touch a real Core.
type fakeCore struct {
	project store.ProjectRow
	branch  service.BranchDetail
	err     error
	calls   []string
}

func port(v int) *int { return &v }
func str(v string) *string { return &v }

func sampleBranch() service.BranchDetail {
	cs := "postgresql://postgres:PW@127.0.0.1:54300/postgres"
	ju := "jdbc:postgresql://127.0.0.1:54300/postgres?user=postgres&password=PW&sslmode=disable"
	parent := "parent-id"
	return service.BranchDetail{
		Row: store.BranchRow{
			ID: "b1", ProjectID: "p1", Name: "dev", Slug: "acme-dev-abc123",
			ParentBranchID: &parent, TimelineID: "tl1", Password: "PW",
			CreatedBy: "api", CreatedAt: "2026-07-11T09:00:00Z", UpdatedAt: "2026-07-11T09:00:00Z",
			StatusEndpoint: "running", StatusPort: port(54300), PortSlot: port(54300),
		},
		ConnectionString: &cs, JdbcURL: &ju,
		LastRecordLsn: str("0/2000"),
	}
}

func (f *fakeCore) record(s string) { f.calls = append(f.calls, s) }

func (f *fakeCore) CreateProject(ctx context.Context, name string, pgVersion *int) (store.ProjectRow, service.BranchDetail, error) {
	f.record("CreateProject:" + name)
	return f.project, f.branch, f.err
}
func (f *fakeCore) Projects(ctx context.Context) ([]store.ProjectRow, error) {
	return []store.ProjectRow{f.project}, f.err
}
func (f *fakeCore) ProjectByIDOr404(ctx context.Context, id string) (store.ProjectRow, error) {
	return f.project, f.err
}
func (f *fakeCore) DeleteProject(ctx context.Context, id string) error { f.record("DeleteProject:" + id); return f.err }
func (f *fakeCore) CreateBranch(ctx context.Context, p service.CreateBranchParams) (service.BranchDetail, error) {
	f.record("CreateBranch:" + p.Name)
	if p.ParentSpecified && p.ParentBranchID == nil {
		return service.BranchDetail{}, service.Errf(400, "parentBranchId cannot be null — root branches only exist via project create")
	}
	return f.branch, f.err
}
func (f *fakeCore) BranchesByProject(ctx context.Context, projectID string) ([]service.BranchDetail, error) {
	return []service.BranchDetail{f.branch}, f.err
}
func (f *fakeCore) BranchDetail(ctx context.Context, branchID string) (service.BranchDetail, error) {
	if branchID != f.branch.Row.ID {
		return service.BranchDetail{}, service.Errf(404, "branch %s not found", branchID)
	}
	return f.branch, f.err
}
func (f *fakeCore) RenameBranch(ctx context.Context, branchID, name string) (service.BranchDetail, error) {
	f.record("Rename:" + name)
	return f.branch, f.err
}
func (f *fakeCore) DeleteBranch(ctx context.Context, branchID string) error { f.record("DeleteBranch:" + branchID); return f.err }
func (f *fakeCore) StartEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error) {
	f.record("Start:" + branchID)
	return f.branch, f.err
}
func (f *fakeCore) StopEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error) {
	f.record("Stop:" + branchID)
	return f.branch, f.err
}
func (f *fakeCore) EndpointStatus(ctx context.Context, branchID string) (string, *int, error) {
	if branchID != f.branch.Row.ID {
		return "", nil, service.Errf(404, "branch %s not found", branchID)
	}
	return "running", port(54300), f.err
}
func (f *fakeCore) LsnAtTimestamp(ctx context.Context, branchID, ts string) (string, error) {
	if ts == "" {
		return "", service.Errf(400, "timestamp query parameter required")
	}
	return "0/1000", f.err
}
func (f *fakeCore) RestoreInPlace(ctx context.Context, branchID, to string) (service.BranchDetail, error) {
	f.record("RestoreInPlace:" + to)
	return f.branch, f.err
}
func (f *fakeCore) BranchAtTimestamp(ctx context.Context, p service.BranchAtParams) (service.BranchDetail, error) {
	f.record("BranchAt:" + p.Name)
	return f.branch, f.err
}
func (f *fakeCore) ResetToParent(ctx context.Context, branchID string) (service.BranchDetail, error) {
	f.record("Reset:" + branchID)
	return f.branch, f.err
}
func (f *fakeCore) RunSQL(ctx context.Context, branchID, query string) (service.SQLResult, error) {
	f.record("SQL:" + query)
	return service.SQLResult{Rows: []map[string]any{{"n": int64(1)}}, RowCount: 1, Fields: []string{"n"}}, f.err
}

type fakeEngine struct{}

func (fakeEngine) Status() map[string]engine.Component {
	out := map[string]engine.Component{}
	for _, name := range engine.ExpectedComponents {
		pid := 42
		out[name] = engine.Component{State: engine.StateRunning, PID: &pid}
	}
	return out
}

func newTestServer(t *testing.T, core CoreAPI) (*httptest.Server, *events.Bus, *events.LogHub) {
	t.Helper()
	bus := events.NewBus()
	hub := events.NewLogHub()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := httptest.NewServer(NewServer(Deps{
		Version: "0.2.0", PortRange: config.PortRange{Min: 54300, Max: 54339},
		Engine: fakeEngine{}, Core: core, Bus: bus, Hub: hub, ShutdownCtx: ctx,
	}))
	t.Cleanup(srv.Close)
	return srv, bus, hub
}

func doJSON(t *testing.T, method, url string, body string) (*http.Response, map[string]any) {
	t.Helper()
	var rd io.Reader
	var headers http.Header = http.Header{}
	if body != "" {
		rd = strings.NewReader(body)
		headers.Set("Content-Type", "application/json")
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode == 204 {
		return res, nil
	}
	defer res.Body.Close()
	var m map[string]any
	raw, _ := io.ReadAll(res.Body)
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("non-JSON response %q: %v", raw, err)
		}
	}
	return res, m
}

func TestBranchDtoShapeAndRedaction(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), project: store.ProjectRow{ID: "p1", Name: "acme", PgMajor: 17, CreatedAt: "2026-07-11T09:00:00Z"}}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "GET", srv.URL+"/api/branches/b1", "")
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	for _, key := range []string{"id", "projectId", "parentBranchId", "name", "slug", "timelineId",
		"endpointStatus", "endpointError", "port", "connectionString", "jdbcUrl", "lastRecordLsn",
		"logicalSizeBytes", "createdBy", "context", "ancestorLsn", "createdAt", "updatedAt", "runningPgVersion"} {
		if _, present := m[key]; !present {
			t.Fatalf("BranchDto missing %q: %v", key, m)
		}
	}
	for _, forbidden := range []string{"password", "portSlot", "stickyPort", "importStatus", "importError", "forkLsn"} {
		if _, present := m[forbidden]; present {
			t.Fatalf("BranchDto must never carry %q", forbidden)
		}
	}
	if m["port"] != float64(54300) || m["endpointStatus"] != "running" {
		t.Fatalf("dto = %v", m)
	}
	if m["runningPgVersion"] != nil {
		t.Fatal("runningPgVersion is null in this milestone (no build registry)")
	}
	if m["logicalSizeBytes"] != nil || m["ancestorLsn"] != nil {
		t.Fatal("unset enrichment must be null")
	}
}

func TestProjectRoutes(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), project: store.ProjectRow{ID: "p1", Name: "acme", PgMajor: 17, CreatedAt: "2026-07-11T09:00:00Z"}}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "POST", srv.URL+"/api/projects", `{"name":"acme"}`)
	if res.StatusCode != 201 {
		t.Fatalf("create status = %d", res.StatusCode)
	}
	proj := m["project"].(map[string]any)
	if proj["pgVersion"] != float64(17) || proj["createdAt"] != "2026-07-11T09:00:00Z" || proj["updatedAt"] != "2026-07-11T09:00:00Z" {
		t.Fatalf("project dto = %v", proj)
	}
	if _, ok := m["mainBranch"].(map[string]any); !ok {
		t.Fatal("create response must carry mainBranch")
	}
	res, _ = doJSON(t, "DELETE", srv.URL+"/api/projects/p1", "")
	if res.StatusCode != 204 {
		t.Fatalf("delete = %d", res.StatusCode)
	}
	res, m = doJSON(t, "POST", srv.URL+"/api/projects", `{"name": 42}`)
	if res.StatusCode != 400 || m["error"] != "invalid request body" {
		t.Fatalf("validation envelope = %d %v", res.StatusCode, m)
	}
	if _, ok := m["issues"].([]any); !ok {
		t.Fatal("validation envelope must carry issues[]")
	}
}

func TestBranchAndEndpointRoutes(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), project: store.ProjectRow{ID: "p1", Name: "acme", PgMajor: 17}}
	srv, _, _ := newTestServer(t, core)
	res, _ := doJSON(t, "POST", srv.URL+"/api/projects/p1/branches", `{"name":"dev"}`)
	if res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	// explicit null parent → 400 (absent parent would default)
	res, m := doJSON(t, "POST", srv.URL+"/api/projects/p1/branches", `{"name":"dev","parentBranchId":null}`)
	if res.StatusCode != 400 || !strings.Contains(m["error"].(string), "parentBranchId cannot be null") {
		t.Fatalf("null parent = %d %v", res.StatusCode, m)
	}
	res, m = doJSON(t, "GET", srv.URL+"/api/branches/b1/endpoint", "")
	if res.StatusCode != 200 || m["status"] != "running" || m["port"] != float64(54300) {
		t.Fatalf("endpoint read = %v", m)
	}
	res, _ = doJSON(t, "POST", srv.URL+"/api/branches/b1/endpoint/start", "")
	if res.StatusCode != 200 {
		t.Fatal("endpoint start must accept an EMPTY body")
	}
	res, _ = doJSON(t, "PATCH", srv.URL+"/api/branches/b1", `{"name":"dev-renamed"}`)
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	res, _ = doJSON(t, "POST", srv.URL+"/api/branches/b1/reset", "")
	if res.StatusCode != 200 {
		t.Fatal("reset takes no body")
	}
	res, m = doJSON(t, "GET", srv.URL+"/api/branches/b1/lsn?timestamp=2026-07-11T09:00:00Z", "")
	if res.StatusCode != 200 || m["lsn"] != "0/1000" {
		t.Fatalf("lsn = %v", m)
	}
	res, m = doJSON(t, "GET", srv.URL+"/api/branches/b1/lsn", "")
	if res.StatusCode != 400 || m["error"] != "timestamp query parameter required" {
		t.Fatalf("missing ts = %d %v", res.StatusCode, m)
	}
	res, _ = doJSON(t, "POST", srv.URL+"/api/branches/b1/restore", `{"mode":"in_place","to":"2026-07-11T09:00:00Z"}`)
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	res, _ = doJSON(t, "POST", srv.URL+"/api/branches/b1/restore", `{"mode":"new_branch","to":"2026-07-11T09:00:00Z","name":"rescued"}`)
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	res, m = doJSON(t, "POST", srv.URL+"/api/branches/b1/restore", `{"mode":"sideways"}`)
	if res.StatusCode != 400 || m["error"] != "invalid request body" {
		t.Fatalf("bad mode = %d %v", res.StatusCode, m)
	}
	res, m = doJSON(t, "POST", srv.URL+"/api/sql", `{"branchId":"b1","query":"SELECT 1"}`)
	if res.StatusCode != 200 || m["rowCount"] != float64(1) || m["truncated"] != false {
		t.Fatalf("sql = %v", m)
	}
}

func TestServiceErrorMapsToEnvelope(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), err: service.Errf(409, `branch "dev" already exists in this project`)}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "PATCH", srv.URL+"/api/branches/b1", `{"name":"dev"}`)
	if res.StatusCode != 409 || m["error"] != `branch "dev" already exists in this project` {
		t.Fatalf("mapped = %d %v", res.StatusCode, m)
	}
}

func TestUnknownAPIRoute404Shape(t *testing.T) {
	core := &fakeCore{branch: sampleBranch()}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "GET", srv.URL+"/api/definitely-not-a-route", "")
	if res.StatusCode != 404 || !strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("404 = %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if m["error"] != "Not Found" || m["statusCode"] != float64(404) ||
		m["message"] != "Route GET:/api/definitely-not-a-route not found" {
		t.Fatalf("404 body = %v", m)
	}
}

func TestEventsSSEStreamsBusEvents(t *testing.T) {
	core := &fakeCore{branch: sampleBranch()}
	srv, bus, _ := newTestServer(t, core)
	res, err := http.Get(srv.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("sse connect = %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		bus.Publish("branch.created", "p1", "b1")
	}()
	reader := bufio.NewReader(res.Body)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "data: ") {
			var e map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(line), "data: ")), &e); err != nil {
				t.Fatalf("event payload must be a JSON object: %q", line)
			}
			if e["type"] != "branch.created" || e["projectId"] != "p1" || e["branchId"] != "b1" || e["at"] == "" {
				t.Fatalf("event = %v", e)
			}
			return
		}
	}
	t.Fatal("no event before deadline")
}

func TestLogsSSEReplaysThenTails(t *testing.T) {
	core := &fakeCore{branch: sampleBranch()}
	srv, _, hub := newTestServer(t, core)
	hub.Ingest("branch:b1:compute", "old line")
	res, err := http.Get(srv.URL + "/api/branches/b1/logs")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	// replayed frame: JSON-STRING-encoded line
	if strings.TrimSpace(line) != `data: "old line"` {
		t.Fatalf("replay frame = %q", line)
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		hub.Ingest("branch:b1:compute", "live line")
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		l, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(l) == `data: "live line"` {
			return
		}
	}
	t.Fatal("live tail never arrived")
}

func TestDaemonLogsComponentAllowlist(t *testing.T) {
	core := &fakeCore{branch: sampleBranch()}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "GET", srv.URL+"/api/daemon/logs/not-a-component", "")
	if res.StatusCode != 404 || m["error"] != `unknown daemon component: "not-a-component"` {
		t.Fatalf("allowlist = %d %v", res.StatusCode, m)
	}
	res2, err := http.Get(srv.URL + "/api/daemon/logs/pageserver")
	if err != nil || res2.StatusCode != 200 {
		t.Fatalf("known component = %v %d", err, res2.StatusCode)
	}
	_ = res2.Body.Close()
}

func TestUnknownBranchLogs404BeforeSSE(t *testing.T) {
	core := &fakeCore{branch: sampleBranch()}
	srv, _, _ := newTestServer(t, core)
	res, _ := doJSON(t, "GET", srv.URL+"/api/branches/nope/logs", "")
	if res.StatusCode != 404 {
		t.Fatalf("must 404 before hijacking into SSE: %d", res.StatusCode)
	}
}
```

- [ ] **Step 2: Run to verify RED**

Run: `cd ~/git/worktreedb && go test ./internal/api/ 2>&1 | tail -8`
Expected: compile errors (`undefined: Deps`, `undefined: CoreAPI`, …).

- [ ] **Step 3: Write `internal/api/dto.go`** (complete file):

```go
package api

import (
	"encoding/json"

	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Wire DTOs. Redaction is structural: these structs carry no password, no
// slot, nothing internal — a field that isn't here cannot leak.

type projectDTO struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PgVersion int    `json:"pgVersion"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func toProjectDTO(p store.ProjectRow) projectDTO {
	// Projects are immutable after create in this milestone's surface;
	// updatedAt mirrors createdAt by contract.
	return projectDTO{ID: p.ID, Name: p.Name, PgVersion: p.PgMajor, CreatedAt: p.CreatedAt, UpdatedAt: p.CreatedAt}
}

type branchDTO struct {
	ID               string          `json:"id"`
	ProjectID        string          `json:"projectId"`
	ParentBranchID   *string         `json:"parentBranchId"`
	Name             string          `json:"name"`
	Slug             string          `json:"slug"`
	TimelineID       string          `json:"timelineId"`
	EndpointStatus   string          `json:"endpointStatus"`
	EndpointError    *string         `json:"endpointError"`
	Port             *int            `json:"port"`
	ConnectionString *string         `json:"connectionString"`
	JdbcURL          *string         `json:"jdbcUrl"`
	LastRecordLsn    *string         `json:"lastRecordLsn"`
	LogicalSizeBytes *int64          `json:"logicalSizeBytes"`
	CreatedBy        string          `json:"createdBy"`
	Context          json.RawMessage `json:"context"`
	AncestorLsn      *string         `json:"ancestorLsn"`
	CreatedAt        string          `json:"createdAt"`
	UpdatedAt        string          `json:"updatedAt"`
	// RunningPgVersion is the version string of the build the running
	// compute was started from; null until the dynamic-build registry lands.
	RunningPgVersion *string `json:"runningPgVersion"`
}

func toBranchDTO(d service.BranchDetail) branchDTO {
	b := d.Row
	var ctx json.RawMessage
	if b.ContextJSON != nil {
		ctx = json.RawMessage(*b.ContextJSON)
	}
	var port *int
	if b.StatusEndpoint == "running" {
		port = b.StatusPort
	}
	return branchDTO{
		ID: b.ID, ProjectID: b.ProjectID, ParentBranchID: b.ParentBranchID,
		Name: b.Name, Slug: b.Slug, TimelineID: b.TimelineID,
		EndpointStatus: b.StatusEndpoint, EndpointError: b.StatusError,
		Port: port, ConnectionString: d.ConnectionString, JdbcURL: d.JdbcURL,
		LastRecordLsn: d.LastRecordLsn, LogicalSizeBytes: d.LogicalSizeBytes,
		CreatedBy: b.CreatedBy, Context: ctx, AncestorLsn: d.AncestorLsn,
		CreatedAt: b.CreatedAt, UpdatedAt: b.UpdatedAt,
		RunningPgVersion: nil,
	}
}
```

- [ ] **Step 4: Write `internal/api/sse.go`** (complete file):

```go
package api

import (
	"context"
	"fmt"
	"net/http"
)

// sseStream writes an SSE response: headers + immediate flush, the replay
// (already-serialized data payloads, oldest first), then the live tail.
// Backpressure policy is bounded and simple: a subscriber whose buffer
// overflows — a client reading slower than the source produces — is dropped;
// SSE clients reconnect on their own and replay from the top, so nothing is
// silently lost forever. The stream ends on client disconnect or daemon
// shutdown (shutdownCtx), so server shutdown never hangs on open streams.
func sseStream(w http.ResponseWriter, r *http.Request, shutdownCtx context.Context,
	replay []string, subscribe func(cb func(payload string)) (unsubscribe func())) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush() // headers must reach the client even with an empty replay

	write := func(payload string) bool {
		if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for _, payload := range replay {
		if !write(payload) {
			return
		}
	}
	// Buffered fan-in: the source's callback must never block (it can run
	// under tight locks upstream) — overflow drops the connection instead.
	ch := make(chan string, 64)
	overflow := make(chan struct{}, 1)
	unsub := subscribe(func(payload string) {
		select {
		case ch <- payload:
		default:
			select {
			case overflow <- struct{}{}:
			default:
			}
		}
	})
	defer unsub()
	for {
		select {
		case payload := <-ch:
			if !write(payload) {
				return
			}
		case <-overflow:
			return // slow client: drop; it reconnects and replays
		case <-r.Context().Done():
			return
		case <-shutdownCtx.Done():
			return
		}
	}
}
```

- [ ] **Step 5: Rewrite `internal/api/server.go`** (complete file):

```go
// Package api serves the REST surface. Handlers read observed state and
// write desired state through the service layer — they never write status
// (that is the owners' monopoly).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

type StatusSource interface {
	Status() map[string]engine.Component
}

// CoreAPI is the exact method set the routes consume — *service.Core
// satisfies it; route tests use a fake.
type CoreAPI interface {
	CreateProject(ctx context.Context, name string, pgVersion *int) (store.ProjectRow, service.BranchDetail, error)
	Projects(ctx context.Context) ([]store.ProjectRow, error)
	ProjectByIDOr404(ctx context.Context, id string) (store.ProjectRow, error)
	DeleteProject(ctx context.Context, id string) error
	CreateBranch(ctx context.Context, p service.CreateBranchParams) (service.BranchDetail, error)
	BranchesByProject(ctx context.Context, projectID string) ([]service.BranchDetail, error)
	BranchDetail(ctx context.Context, branchID string) (service.BranchDetail, error)
	RenameBranch(ctx context.Context, branchID, name string) (service.BranchDetail, error)
	DeleteBranch(ctx context.Context, branchID string) error
	StartEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error)
	StopEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error)
	EndpointStatus(ctx context.Context, branchID string) (string, *int, error)
	LsnAtTimestamp(ctx context.Context, branchID, isoTimestamp string) (string, error)
	RestoreInPlace(ctx context.Context, branchID, to string) (service.BranchDetail, error)
	BranchAtTimestamp(ctx context.Context, p service.BranchAtParams) (service.BranchDetail, error)
	ResetToParent(ctx context.Context, branchID string) (service.BranchDetail, error)
	RunSQL(ctx context.Context, branchID, query string) (service.SQLResult, error)
}

type Deps struct {
	Version     string
	PortRange   config.PortRange
	Engine      StatusSource
	Core        CoreAPI
	Bus         *events.Bus
	Hub         *events.LogHub
	ShutdownCtx context.Context
}

// daemonLogComponents allowlists the exact channels the daemon ever ingests
// under daemon:<component> — an arbitrary :component would otherwise open an
// SSE stream against a channel that never exists.
var daemonLogComponents = map[string]bool{
	"storcon_db": true, "storage_broker": true, "storage_controller": true,
	"safekeeper": true, "pageserver": true, "app": true,
}

func NewServer(d Deps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		st := d.Engine.Status()
		healthy := true
		for _, name := range engine.ExpectedComponents {
			c, ok := st[name]
			if !ok || c.State != engine.StateRunning {
				healthy = false
				break
			}
		}
		writeJSON(w, 200, map[string]any{
			"version":   d.Version,
			"healthy":   healthy,
			"engine":    st,
			"portRange": map[string]int{"min": d.PortRange.Min, "max": d.PortRange.Max},
			"storage":   "none",           // durability modes arrive with import/export
			"pgBuilds":  map[string]any{}, // populated when the dynamic-build subsystem lands
		})
	})

	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		// NO replay — by contract, not as an optimization: clients blanket-
		// invalidate on every (re)connect, which makes lost events harmless.
		sseStream(w, r, d.ShutdownCtx, nil, func(cb func(string)) func() {
			return d.Bus.Subscribe(func(e events.Event) {
				raw, err := json.Marshal(e)
				if err != nil {
					return
				}
				cb(string(raw))
			})
		})
	})

	mux.HandleFunc("GET /api/daemon/logs/{component}", func(w http.ResponseWriter, r *http.Request) {
		component := r.PathValue("component")
		if !daemonLogComponents[component] {
			writeError(w, 404, fmt.Sprintf("unknown daemon component: %q", component))
			return
		}
		logsSSE(w, r, d, events.DaemonLogChannel(component))
	})

	mux.HandleFunc("POST /api/projects", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name      *string `json:"name"`
			PgVersion *int    `json:"pgVersion"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var issues []string
		if body.Name == nil {
			issues = append(issues, "name: Required")
		}
		if body.PgVersion != nil && *body.PgVersion < 14 {
			issues = append(issues, "pgVersion: must be an integer >= 14")
		}
		if len(issues) > 0 {
			writeIssues(w, issues)
			return
		}
		project, main, err := d.Core.CreateProject(r.Context(), *body.Name, body.PgVersion)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{
			"project":    toProjectDTO(project),
			"mainBranch": toBranchDTO(main),
		})
	})

	mux.HandleFunc("GET /api/projects", func(w http.ResponseWriter, r *http.Request) {
		rows, err := d.Core.Projects(r.Context())
		if err != nil {
			writeServiceError(w, err)
			return
		}
		out := make([]projectDTO, 0, len(rows))
		for _, p := range rows {
			out = append(out, toProjectDTO(p))
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := d.Core.ProjectByIDOr404(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toProjectDTO(p))
	})

	mux.HandleFunc("DELETE /api/projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := d.Core.DeleteProject(r.Context(), r.PathValue("id")); err != nil {
			writeServiceError(w, err)
			return
		}
		w.WriteHeader(204)
	})

	mux.HandleFunc("POST /api/projects/{id}/branches", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name           *string          `json:"name"`
			ParentBranchID json.RawMessage  `json:"parentBranchId"`
			AtLsn          *string          `json:"atLsn"`
			Context        *json.RawMessage `json:"context"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		if body.Name == nil {
			writeIssues(w, []string{"name: Required"})
			return
		}
		params := service.CreateBranchParams{
			ProjectID: r.PathValue("id"), Name: *body.Name, AtLsn: body.AtLsn, CreatedBy: "api",
		}
		// Distinguish absent (default to main) from explicit null (400 in
		// the service): RawMessage nil = absent; "null" = explicit null.
		if body.ParentBranchID != nil {
			params.ParentSpecified = true
			if string(body.ParentBranchID) != "null" {
				var parent string
				if err := json.Unmarshal(body.ParentBranchID, &parent); err != nil {
					writeIssues(w, []string{"parentBranchId: Expected string"})
					return
				}
				params.ParentBranchID = &parent
			}
		}
		if body.Context != nil {
			normalized, ok := normalizeContext(*body.Context)
			if !ok {
				writeIssues(w, []string{"context: Expected object"})
				return
			}
			params.ContextJSON = &normalized
		}
		detail, err := d.Core.CreateBranch(r.Context(), params)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 201, toBranchDTO(detail))
	})

	mux.HandleFunc("GET /api/projects/{id}/branches", func(w http.ResponseWriter, r *http.Request) {
		list, err := d.Core.BranchesByProject(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		out := make([]branchDTO, 0, len(list))
		for _, b := range list {
			out = append(out, toBranchDTO(b))
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/branches/{id}", func(w http.ResponseWriter, r *http.Request) {
		detail, err := d.Core.BranchDetail(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("PATCH /api/branches/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name *string `json:"name"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		if body.Name == nil {
			writeIssues(w, []string{"name: Required"})
			return
		}
		detail, err := d.Core.RenameBranch(r.Context(), r.PathValue("id"), *body.Name)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("DELETE /api/branches/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := d.Core.DeleteBranch(r.Context(), r.PathValue("id")); err != nil {
			writeServiceError(w, err)
			return
		}
		w.WriteHeader(204)
	})

	mux.HandleFunc("POST /api/branches/{id}/endpoint/start", func(w http.ResponseWriter, r *http.Request) {
		detail, err := d.Core.StartEndpoint(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("POST /api/branches/{id}/endpoint/stop", func(w http.ResponseWriter, r *http.Request) {
		detail, err := d.Core.StopEndpoint(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("GET /api/branches/{id}/endpoint", func(w http.ResponseWriter, r *http.Request) {
		status, port, err := d.Core.EndpointStatus(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"status": status, "port": port})
	})

	mux.HandleFunc("GET /api/branches/{id}/logs", func(w http.ResponseWriter, r *http.Request) {
		branchID := r.PathValue("id")
		// Existence check via the light row read (EndpointStatus), not the
		// enriched detail — an SSE connect must not cost an engine call.
		if _, _, err := d.Core.EndpointStatus(r.Context(), branchID); err != nil {
			writeServiceError(w, err)
			return
		}
		logsSSE(w, r, d, "branch:"+branchID+":compute")
	})

	mux.HandleFunc("GET /api/branches/{id}/lsn", func(w http.ResponseWriter, r *http.Request) {
		ts := r.URL.Query().Get("timestamp")
		if ts == "" {
			writeError(w, 400, "timestamp query parameter required")
			return
		}
		lsn, err := d.Core.LsnAtTimestamp(r.Context(), r.PathValue("id"), ts)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"lsn": lsn})
	})

	mux.HandleFunc("POST /api/branches/{id}/restore", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode *string `json:"mode"`
			To   *string `json:"to"`
			Name *string `json:"name"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var issues []string
		if body.Mode == nil || (*body.Mode != "in_place" && *body.Mode != "new_branch") {
			issues = append(issues, "mode: Expected 'in_place' | 'new_branch'")
		}
		if body.To == nil {
			issues = append(issues, "to: Required")
		}
		if body.Mode != nil && *body.Mode == "new_branch" && body.Name == nil {
			issues = append(issues, "name: Required")
		}
		if len(issues) > 0 {
			writeIssues(w, issues)
			return
		}
		branchID := r.PathValue("id")
		if *body.Mode == "in_place" {
			detail, err := d.Core.RestoreInPlace(r.Context(), branchID, *body.To)
			if err != nil {
				writeServiceError(w, err)
				return
			}
			writeJSON(w, 200, toBranchDTO(detail))
			return
		}
		src, err := d.Core.BranchDetail(r.Context(), branchID)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		detail, err := d.Core.BranchAtTimestamp(r.Context(), service.BranchAtParams{
			ProjectID: src.Row.ProjectID, SourceBranchID: branchID,
			Name: *body.Name, To: *body.To, CreatedBy: "api",
		})
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("POST /api/branches/{id}/reset", func(w http.ResponseWriter, r *http.Request) {
		detail, err := d.Core.ResetToParent(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toBranchDTO(detail))
	})

	mux.HandleFunc("POST /api/sql", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BranchID *string `json:"branchId"`
			Query    *string `json:"query"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var issues []string
		if body.BranchID == nil {
			issues = append(issues, "branchId: Required")
		}
		if body.Query == nil {
			issues = append(issues, "query: Required")
		}
		if len(issues) > 0 {
			writeIssues(w, issues)
			return
		}
		out, err := d.Core.RunSQL(r.Context(), *body.BranchID, *body.Query)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, out)
	})

	// Unknown /api/* routes answer a JSON 404 with the conventional shape.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]any{
			"message":    fmt.Sprintf("Route %s:%s not found", r.Method, r.URL.Path),
			"error":      "Not Found",
			"statusCode": 404,
		})
	})

	return mux
}

// logsSSE replays the channel's recent lines (each JSON-string-encoded — the
// wire is `data: "<line>"`) then tails it live.
func logsSSE(w http.ResponseWriter, r *http.Request, d Deps, channel string) {
	recent := d.Hub.Recent(channel, 200)
	replay := make([]string, 0, len(recent))
	for _, line := range recent {
		raw, err := json.Marshal(line)
		if err != nil {
			continue
		}
		replay = append(replay, string(raw))
	}
	sseStream(w, r, d.ShutdownCtx, replay, func(cb func(string)) func() {
		return d.Hub.Subscribe(channel, func(line string) {
			raw, err := json.Marshal(line)
			if err != nil {
				return
			}
			cb(string(raw))
		})
	})
}

// normalizeContext re-marshals a fork-context object through its known
// fields, stripping anything else — stored (and echoed) normalized.
func normalizeContext(raw json.RawMessage) (string, bool) {
	var ctx struct {
		GitBranch *string `json:"git_branch,omitempty"`
		Workdir   *string `json:"workdir,omitempty"`
		Agent     *string `json:"agent,omitempty"`
		Purpose   *string `json:"purpose,omitempty"`
		Client    *struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"client,omitempty"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	if err := dec.Decode(&ctx); err != nil {
		return "", false
	}
	out, err := json.Marshal(ctx)
	if err != nil {
		return "", false
	}
	return string(out), true
}

// decodeBody parses a JSON body; a missing body decodes as an empty object
// (routes that require fields report them as issues), malformed JSON is the
// validation envelope.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, 400, "could not read request body")
		return false
	}
	if len(raw) == 0 {
		return true
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		writeIssues(w, []string{"body: " + err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func writeIssues(w http.ResponseWriter, issues []string) {
	writeJSON(w, 400, map[string]any{"error": "invalid request body", "issues": issues})
}

// writeServiceError maps a *service.Error to its status + envelope; anything
// else is a 500 with the error text.
func writeServiceError(w http.ResponseWriter, err error) {
	var serr *service.Error
	if errors.As(err, &serr) {
		writeError(w, serr.Status, serr.Message)
		return
	}
	writeError(w, 500, err.Error())
}
```

(`errors` joins the import block.) Update the M1 `/api/status` test's server construction to `NewServer(Deps{Version: "test", PortRange: …, Engine: fake, Core: &fakeCore{branch: sampleBranch()}, Bus: events.NewBus(), Hub: events.NewLogHub(), ShutdownCtx: context.Background()})` — the status route's assertions themselves stay byte-identical.

- [ ] **Step 6: Run to verify GREEN**

Run: `cd ~/git/worktreedb && go test ./internal/api/ -race -count=1 && go build ./... && golangci-lint run`
Expected: PASS (the M1 status tests included), 0 issues. `go build ./...` fails at `cmd/worktreedbd` if main still uses the old NewServer signature — if so, apply the minimal `main.go` construction fix now and leave the full boot rework to Task 14 (note it in the task report either way).

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/api cmd && git commit -m "feat(api): full branching rest surface, dtos with structural redaction, sse streams"
```

---

### Task 14: cmd/worktreedbd — boot order, reconciliation, shutdown (P4-3 + P4-4)

Wire everything and fix the two carried M1 findings: **P4-4** — install signal handling BEFORE boot and make boot cancellable (a `docker stop` during M2's longer boots must interrupt cleanly instead of being ignored until SIGKILL); **P4-3** — the serveErr path calls `httpSrv.Shutdown` too, so in-flight handlers (which read CatalogDB state) drain before `sup.Stop()` — closing the documented `proc`-contract race.

Boot order (exactly): config → data dir → lockfile → store.Open (migrates) → **signal.Notify + signal-cancelled boot ctx** → catalog password → supervisor (now wired: `onLine` → LogHub `daemon:<component>` channels, `onComponent` → `engine.health` publish — both non-blocking, honoring the under-Process-mutex contract) → engine owner Do → **boot reconciliation**: `ResumeIncomplete` (timetravel policies — fail-forward), `ResetEndpointsOnBoot`, sweep the computes dir → construct proxy/manager/bus/hub/Core → register owners for every existing branch → HTTP serve. Shutdown order (exactly): stop accepting (cancel SSE ctx + `httpSrv.Shutdown`) → owners `Shutdown()` (quiesce — nothing mutates computes anymore) → `computes.StopAll()` → `proxy.Shutdown()` → `sup.Stop()` → engine owner cancel+Wait → remove lock. This is the "shutdown reaches around the inbox" note resolved: due ordering (owners first) makes the direct StopAll safe, and the ordering is now written down here.

**Files:**
- Modify: `~/git/worktreedb/cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: everything above.
- Produces: the composed daemon. No new exported symbols.

- [ ] **Step 1: Rewrite `cmd/worktreedbd/main.go`'s `run()`** — keep `main()`, `version` (bump to `"0.2.0"`), and `catalogPassword` as-is; replace `run()` with:

```go
func run() error {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return err
	}

	// Single-instance guard: an exclusive-create marker under the data dir.
	lockPath := filepath.Join(cfg.DataDir, ".lock")
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("lockfile %s exists — another Worktree DB instance owns this data dir, or it crashed without cleaning up.\n"+
			"Remove it (ONLY if no other container uses this volume): docker run --rm -v <your-data-volume>:/data alpine rm -f /data/.lock", lockPath)
	}
	_ = f.Close()
	removeLock := func() { _ = os.Remove(lockPath) }

	st, err := store.Open(filepath.Join(cfg.DataDir, "state.db"))
	if err != nil {
		removeLock()
		return err
	}
	defer st.Close()

	// Signals are handled from BEFORE the engine boots: a stop request during
	// boot cancels the boot ctx (owners and process readiness waits observe
	// it) instead of being ignored until the runtime is up.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	bootAborted := make(chan os.Signal, 1)
	go func() {
		sig, ok := <-sigCh
		if !ok {
			return
		}
		select {
		case bootAborted <- sig:
		default:
		}
		cancel()
	}()

	pw, err := catalogPassword(ctx, st)
	if err != nil {
		removeLock()
		return err
	}

	hub := events.NewLogHub()
	bus := events.NewBus()
	sup := engine.NewSupervisor(cfg, pw,
		func(name, line string) { hub.Ingest(events.DaemonLogChannel(name), line) },
		// Under the child Process's mutex — Publish is quick, lock-scoped,
		// and calls back into nothing engine-side.
		func(name string, s engine.ProcState) { bus.Publish("engine.health", "", "") },
	)

	started := false
	eng := runtime.NewOwner("engine", func(ctx context.Context) error {
		if started {
			return nil
		}
		if err := sup.Start(ctx); err != nil {
			return err
		}
		started = true
		return nil
	}, log)
	eng.Start(ctx)
	if err := eng.Do(ctx); err != nil {
		// Partial boots are already unwound by the supervisor itself.
		removeLock()
		return err
	}

	// Boot reconciliation — before anything can be live to race against:
	// 1. interrupted operations fail forward by kind policy;
	if err := runtime.ResumeIncomplete(ctx, st, service.TimetravelBootPolicies(),
		func(op store.Operation) []runtime.Step { return nil }, log); err != nil {
		sup.Stop()
		removeLock()
		return err
	}
	// 2. every branch endpoint is stopped (computes died with the previous
	//    container; endpoints deliberately do not auto-restart on boot);
	if n, err := st.ResetEndpointsOnBoot(ctx); err != nil {
		sup.Stop()
		removeLock()
		return err
	} else if n > 0 {
		log.Info("boot: reset endpoints to stopped", "count", n)
	}
	// 3. crash-orphaned compute dirs are swept (nothing tracks them anymore).
	computesDir := engine.EngineDirs(cfg.DataDir).ComputesDir
	if entries, err := os.ReadDir(computesDir); err == nil {
		for _, e := range entries {
			_ = os.RemoveAll(filepath.Join(computesDir, e.Name()))
		}
		if len(entries) > 0 {
			log.Info("boot: swept crash-orphaned compute dirs", "count", len(entries))
		}
	}

	prox := proxy.New(cfg.PortRange, log)
	computes := compute.NewManager(compute.ManagerOpts{
		NeonBinDir: cfg.NeonBinDir, ComputesDir: computesDir, Log: log,
		PageserverPg: cfg.Engine.PageserverPg, SafekeeperPg: cfg.Engine.SafekeeperPg,
	})
	owners := service.NewRegistry(ctx, log)
	core := &service.Core{
		Cfg: cfg, Store: st,
		Storcon:    engine.NewStorconClient(cfg.Engine.Storcon),
		Pageserver: engine.NewPageserverClient(cfg.Engine.PageserverHTTP),
		Safekeeper: engine.NewSafekeeperClient(cfg.Engine.SafekeeperHTTP),
		Computes:   computes, Proxy: prox, Hub: hub, Bus: bus, Owners: owners, Log: log,
		PgbinFor: func(major int) (string, error) { return compute.BakedPgbin(cfg.PgInstallDir, major) },
		InstalledMajors: func() []int {
			majors, err := compute.InstalledMajors(cfg.PgInstallDir)
			if err != nil {
				log.Error("installed-major scan failed", "err", err)
				return nil
			}
			return majors
		},
	}
	// Owners for every persisted branch — the registry is the source of
	// serialization from the first request onward.
	projects, err := st.Projects(ctx)
	if err != nil {
		sup.Stop()
		removeLock()
		return err
	}
	for _, p := range projects {
		branches, err := st.BranchesByProject(ctx, p.ID)
		if err != nil {
			sup.Stop()
			removeLock()
			return err
		}
		for _, b := range branches {
			core.RegisterBranchOwner(b.ID)
		}
	}

	// SSE streams end when this context ends — cancelled FIRST at shutdown so
	// httpSrv.Shutdown can drain instead of hanging on never-ending streams.
	sseCtx, sseCancel := context.WithCancel(context.Background())
	defer sseCancel()
	handler := api.NewServer(api.Deps{
		Version: version, PortRange: cfg.PortRange, Engine: sup,
		Core: core, Bus: bus, Hub: hub, ShutdownCtx: sseCtx,
	})
	httpSrv := &http.Server{Handler: handler}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.HTTPPort))
	if err != nil {
		sup.Stop()
		removeLock()
		return err
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpSrv.Serve(ln) }()
	log.Info("worktreedbd up", "version", version, "port", cfg.HTTPPort)

	var shutdownErr error
	select {
	case sig := <-bootAborted:
		log.Info("shutting down", "signal", sig.String())
		go func() {
			<-sigCh
			fmt.Fprintln(os.Stderr, "second signal — forcing immediate exit")
			os.Exit(130)
		}()
		hardExit := time.AfterFunc(45*time.Second, func() {
			fmt.Fprintln(os.Stderr, "shutdown timed out — forcing exit")
			os.Exit(1)
		})
		defer hardExit.Stop()
		sseCancel()
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutCancel()
		if err := httpSrv.Shutdown(shutCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http shutdown", "err", err)
			shutdownErr = errors.New("shutdown finished with errors")
		}

	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server exited unexpectedly", "err", err)
			shutdownErr = fmt.Errorf("http server exited unexpectedly: %w", err)
		}
		// Drain in-flight handlers HERE TOO: they read supervisor/catalog
		// state, and stopping the engine under them is the documented race.
		sseCancel()
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutCancel()
		_ = httpSrv.Shutdown(shutCtx)
	}

	// Teardown order: owners quiesce first (no converge can touch computes
	// after this), then computes, proxy, engine.
	owners.Shutdown()
	computes.StopAll()
	prox.Shutdown()
	sup.Stop()
	cancel()
	eng.Wait()
	removeLock()
	return shutdownErr
}
```

Two subtleties to keep, both deliberate:
1. The boot-abort goroutine forwards the FIRST signal into `bootAborted` (buffered 1) AND cancels the root ctx. During boot that fails `eng.Do` (ctx cancelled) and boot unwinds via the existing error path; after boot the signal lands in the `select`. The `<-sigCh` second-signal escalation goroutine keeps its M1 semantics.
2. Because the root ctx is also the owners' registry root, the first signal begins quiescing owners immediately: in-flight owner work is cut short (`ErrOwnerStopped`/ctx errors surface as 5xx to any request still in flight, and an interrupted restore's operation row is failed forward at next boot — exactly the crash contract). `httpSrv.Shutdown` then drains those fast-failing handlers well inside its 10s budget instead of waiting out long compute starts. Shutting down IS a spec change for everything in flight; the state model absorbs it.

Update imports accordingly (`internal/api`, `internal/compute`, `internal/events`, `internal/proxy`, `internal/service` join the M1 set; `internal/store` is already present).

- [ ] **Step 2: Build + full unit suite**

Run: `cd ~/git/worktreedb && go build ./... && go test ./internal/... -race -count=1 && go vet ./... && golangci-lint run`
Expected: clean, all PASS, 0 issues.

- [ ] **Step 3: Manual container smoke** (needs Docker + GHCR login)

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
docker run -d --name wtdb-smoke -p 127.0.0.1:4400:4400 -p 127.0.0.1:54300-54339:54300-54339 worktreedb:dev
sleep 25 && curl -s http://127.0.0.1:4400/api/status | head -c 400; echo
curl -s -X POST http://127.0.0.1:4400/api/projects -H 'content-type: application/json' -d '{"name":"smoke"}' | head -c 600; echo
docker rm -f wtdb-smoke
```

Expected: status healthy true; project create returns 201-shaped JSON with `project` + `mainBranch`. Capture output in the task report.

- [ ] **Step 4: Commit**

```bash
cd ~/git/worktreedb && git add cmd && git commit -m "feat(daemon): full branching boot order, boot reconciliation, cancellable boot, drained shutdown"
```

---

### Task 15: worktreedb integration — container-level branching acceptance

The repo's own (self-contained) container suite grows the branching core: full cycle over REST + a real external PostgreSQL connection through the slot splice + restart reconciliation + stopped-endpoint refusal. This is the Go-native half of the verification story; the cross-run (Task 16) is the other half.

**Files:**
- Create: `~/git/worktreedb/integration/branching_test.go`

**Interfaces:**
- Consumes: the running image; `integration/boot_test.go`'s helpers (`image()`, `baseURL`) — extend, don't duplicate.
- Produces: nothing (tests only).

- [ ] **Step 1: Write the test** — `integration/branching_test.go` (complete file; `//go:build integration`):

```go
//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// startBranchingContainer publishes the endpoint range alongside :4400.
func startBranchingContainer(t *testing.T) (testcontainers.Container, string) {
	t.Helper()
	ctx := context.Background()
	exposed := []string{"4400/tcp"}
	for p := 54300; p <= 54309; p++ {
		exposed = append(exposed, fmt.Sprintf("%d/tcp", p))
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        image(),
			Env:          map[string]string{"WORKTREEDB_PORT_RANGE": "54300-54309"},
			ExposedPorts: exposed,
			WaitingFor:   wait.ForHTTP("/api/status").WithPort("4400/tcp").WithStartupTimeout(3 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Terminate(context.Background()) })
	base, err := baseURL(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return c, base
}

func apiJSON(t *testing.T, method, url string, body string) (int, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	if len(raw) > 0 && (strings.HasPrefix(strings.TrimSpace(string(raw)), "{")) {
		_ = json.Unmarshal(raw, &m)
	}
	return res.StatusCode, m
}

// hostDSN rewrites a daemon-emitted connection string onto the mapped host
// port for the slot it names.
func hostDSN(t *testing.T, c testcontainers.Container, connectionString string) string {
	t.Helper()
	cfg, err := pgconn.ParseConfig(connectionString)
	if err != nil {
		t.Fatal(err)
	}
	mapped, err := c.MappedPort(context.Background(), nat.Port(fmt.Sprintf("%d/tcp", cfg.Port)))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Replace(connectionString, fmt.Sprintf(":%d/", cfg.Port), fmt.Sprintf(":%s/", mapped.Port()), 1)
}

func TestBranchingCore(t *testing.T) {
	c, base := startBranchingContainer(t)
	ctx := context.Background()

	code, created := apiJSON(t, "POST", base+"/api/projects", `{"name":"demo"}`)
	if code != 201 {
		t.Fatalf("project create = %d %v", code, created)
	}
	main := created["mainBranch"].(map[string]any)
	mainID := main["id"].(string)
	if _, hasPw := main["password"]; hasPw {
		t.Fatal("wire dto must never carry the password")
	}

	sqlDo := func(branchID, q string) map[string]any {
		codeQ, out := apiJSON(t, "POST", base+"/api/sql",
			fmt.Sprintf(`{"branchId":%q,"query":%q}`, branchID, q))
		if codeQ != 200 {
			t.Fatalf("sql %q = %d %v", q, codeQ, out)
		}
		return out
	}
	sqlDo(mainID, "CREATE TABLE notes (body text)")
	sqlDo(mainID, "INSERT INTO notes VALUES ('hello')")

	// external client through the slot splice: dial the emitted string
	code, mainDetail := apiJSON(t, "GET", base+"/api/branches/"+mainID, "")
	if code != 200 || mainDetail["connectionString"] == nil {
		t.Fatalf("detail = %d %v", code, mainDetail)
	}
	dsn := hostDSN(t, c, mainDetail["connectionString"].(string))
	conn, err := pgconn.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("external SCRAM connect through the splice: %v", err)
	}
	res, err := conn.Exec(ctx, "SELECT count(*)::int AS n FROM notes").ReadAll()
	if err != nil || len(res) == 0 || len(res[0].Rows) != 1 || string(res[0].Rows[0][0]) != "1" {
		t.Fatalf("external read = %v %v", res, err)
	}
	_ = conn.Close(ctx)

	// branch isolation both ways
	code, br := apiJSON(t, "POST", base+"/api/projects/"+created["project"].(map[string]any)["id"].(string)+"/branches", `{"name":"agent/task"}`)
	if code != 201 {
		t.Fatalf("branch create = %d %v", code, br)
	}
	brID := br["id"].(string)
	if got := sqlDo(brID, "DELETE FROM notes"); got["rowCount"] != float64(1) {
		t.Fatalf("branch delete rowCount = %v", got["rowCount"])
	}
	if got := sqlDo(brID, "SELECT count(*)::int AS n FROM notes"); got["rows"].([]any)[0].(map[string]any)["n"] != float64(0) {
		t.Fatal("branch must see its own delete")
	}
	if got := sqlDo(mainID, "SELECT count(*)::int AS n FROM notes"); got["rows"].([]any)[0].(map[string]any)["n"] != float64(1) {
		t.Fatal("parent must be isolated from the branch's delete")
	}

	// stopped endpoint refuses connections (bind-on-running)
	code, stopped := apiJSON(t, "POST", base+"/api/branches/"+mainID+"/endpoint/stop", "")
	if code != 200 || stopped["endpointStatus"] != "stopped" {
		t.Fatalf("stop = %d %v", code, stopped)
	}
	cfg, _ := pgconn.ParseConfig(dsn)
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	if _, err := net.DialTimeout("tcp", addr, 2*time.Second); err == nil {
		t.Fatal("a stopped endpoint's published port must refuse connections")
	}
}

func TestRestartReconciliation(t *testing.T) {
	c, base := startBranchingContainer(t)
	ctx := context.Background()

	code, created := apiJSON(t, "POST", base+"/api/projects", `{"name":"acme"}`)
	if code != 201 {
		t.Fatal(code)
	}
	mainID := created["mainBranch"].(map[string]any)["id"].(string)
	if code, _ := apiJSON(t, "POST", base+"/api/branches/"+mainID+"/endpoint/start", ""); code != 200 {
		t.Fatal("start failed")
	}
	if err := c.Stop(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Start(ctx); err != nil {
		t.Fatal(err)
	}
	base2, err := baseURL(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	healthy := false
	for i := 0; i < 90; i++ {
		res, err := http.Get(base2 + "/api/status")
		if err == nil {
			var m map[string]any
			_ = json.NewDecoder(res.Body).Decode(&m)
			_ = res.Body.Close()
			if m["healthy"] == true {
				healthy = true
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
	if !healthy {
		t.Fatal("daemon never came back healthy")
	}
	code, detail := apiJSON(t, "GET", base2+"/api/branches/"+mainID, "")
	if code != 200 || detail["endpointStatus"] != "stopped" || detail["port"] != nil {
		t.Fatalf("boot reconciliation must reset the endpoint: %d %v", code, detail)
	}
	// the branch (and its data) survives: restart the endpoint and read
	if code, _ := apiJSON(t, "POST", base2+"/api/branches/"+mainID+"/endpoint/start", ""); code != 200 {
		t.Fatal("restart-start failed")
	}
}
```

`github.com/docker/go-connections/nat` is already a transitive dependency of testcontainers-go — importing it directly adds no module (it moves from indirect to direct in go.mod; hand-edit the marker per the repo's posture, no tidy). Note `c.Stop(ctx, nil)` uses the default (10s) grace: a CLEAN stop, so the lockfile is removed and the reboot exercises reconciliation, not the stale-lock refusal (that path is already covered by the M1 suite).

- [ ] **Step 2: Run RED against the pre-Task-14 image (optional) or straight to GREEN**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev . && go vet -tags integration ./integration/...
go test -tags integration ./integration/... -v -timeout 30m -count=1
```

Expected: ALL integration tests pass — the four M1 cases AND the two new ones. This is slow (~6–10 min); run it once, capture the summary.

- [ ] **Step 3: Commit**

```bash
cd ~/git/worktreedb && git add integration && git commit -m "test(integration): branching core acceptance — splice connectivity, isolation, restart reconciliation"
```

---

### Task 16: devdb repo — parameterize the reference suite + the M2 cross-run gate

**This task works in `~/git/devdb`** (the workshop repo; its usual commit conventions apply, including devdb's trailer policy). The TS integration suite becomes runnable against any image/env-prefix pair: `DEVDB_TEST_IMAGE` already exists; add `DEVDB_TEST_ENV_PREFIX` so the container env AND the one prefix-dependent assertion derive from it. **Assertions are never weakened** — the endpoints test still requires the exact env-var name in the 409 body; the name is now computed from the configured prefix instead of hardcoding `DEVDB_`. Then run the M2 gate.

**The M2 cross-run gate is exactly these 11 files** (core files; pg-builds + MCP + web-ui are later milestones' gates):
`acceptance` · `projects` · `branching` · `endpoints` · `timetravel` · `events` · `boot` · `restart` · `unclean-restart` · `retry-helper` · `storcon-major-guard`
(storcon-major-guard is included because the M1 daemon already pins its parity strings; web-ui.test.ts joins at M4 with the embedded UI; pg-builds.test.ts and the three mcp*.test.ts files join at M3.)

**Files:**
- Modify: `~/git/devdb/tests/integration/helpers/container.ts`
- Modify: `~/git/devdb/tests/integration/endpoints.test.ts`
- Create: `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`

- [ ] **Step 1: Parameterize `helpers/container.ts`.** Below the `IMAGE` constant add:

```typescript
// Env-var prefix parameterization: the suite's daemon-env keys (and the one
// assertion that names an env var) are written against the DEVDB_ prefix;
// DEVDB_TEST_ENV_PREFIX rewrites them so the same suite drives an
// image whose daemon reads a different prefix (paired with DEVDB_TEST_IMAGE).
export const ENV_PREFIX = process.env.DEVDB_TEST_ENV_PREFIX ?? "DEVDB_";

function reprefix(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key.startsWith("DEVDB_") ? `${ENV_PREFIX}${key.slice("DEVDB_".length)}` : key] = value;
  }
  return out;
}
```

and change the one `withEnvironment` line inside `buildUnstarted`:

```typescript
      .withEnvironment(reprefix({ DEVDB_PORT_RANGE: "54300-54309", ...env }))
```

(Callers keep passing `DEVDB_*` keys — `endpoints.test.ts`'s `{ DEVDB_PORT_RANGE: "54300-54301" }` and `pg-builds.test.ts`'s registry base are rewritten in one place.)

- [ ] **Step 2: Parameterize the one prefix-dependent assertion.** In `tests/integration/endpoints.test.ts`, add `ENV_PREFIX` to the existing import from `./helpers/container.js` and change line 31's assertion to:

```typescript
    expect(body.error).toContain(`${ENV_PREFIX}PORT_RANGE`);
```

Nothing else in any test file changes. Verify: `grep -rn "DEVDB_" tests/integration/*.test.ts` shows only helper-rewritten env keys (endpoints, pg-builds) and no remaining hardcoded prefix inside an assertion.

- [ ] **Step 3: Prove the default path is untouched** — run the two cheapest files against devdb:dev exactly as before:

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/devdb/tests/integration && pnpm vitest run retry-helper boot
```

Expected: PASS (devdb:dev builds + boots; retry-helper is containerless). This proves the parameterization is a no-op when the env vars are unset.

- [ ] **Step 4: Run the M2 cross-run gate against worktreedb:dev**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run acceptance projects branching endpoints timetravel events boot restart unclean-restart retry-helper storcon-major-guard
```

Expected: **11 files, all green.** This IS the milestone acceptance (spec §8-M2). Failures here are porting bugs in the worktreedb repo: fix THERE (new worktreedb commits through the normal review gates), rebuild the image, re-run — never touch an assertion. Known timing note: the suite runs files sequentially and single cases can flake under machine load (the 57P01 class is already handled test-side); re-run an isolated file before treating a red as real.

- [ ] **Step 5: Write the cross-run doc** — `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`:

```markdown
# Worktree DB M2 cross-run — the reference-suite gate

The TS integration suite doubles as the Go daemon's parity oracle
(master spec §7). Parameterization (2026-07-11):

- `DEVDB_TEST_IMAGE` — image under test (default `devdb:dev`, built from
  docker/Dockerfile; when set, no rebuild happens).
- `DEVDB_TEST_ENV_PREFIX` — daemon env-var prefix (default `DEVDB_`).
  helpers/container.ts rewrites all `DEVDB_*` env keys it passes to the
  container, and endpoints.test.ts derives its port-range-variable
  assertion from the same prefix. Assertions are never weakened — the
  409 body must still name the exact env var, whichever prefix is active.

## M2 gate (11 core files — all must pass, assertions unmodified)

acceptance, projects, branching, endpoints, timetravel, events, boot,
restart, unclean-restart, retry-helper, storcon-major-guard

Later gates: pg-builds + mcp/mcp-handshake/mcp-concurrency at M3;
web-ui at M4 (full suite = the parity gate).

## Invocation

    export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
    cd ~/git/worktreedb && docker build -t worktreedb:dev .
    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run acceptance projects branching endpoints timetravel \
        events boot restart unclean-restart retry-helper storcon-major-guard

Result 2026-07-XX: <record the green run's summary line here>
```

Fill the result line with the actual run summary from Step 4.

- [ ] **Step 6: Commit (devdb repo — devdb conventions)**

```bash
cd ~/git/devdb && git add tests/integration/helpers/container.ts tests/integration/endpoints.test.ts docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md
git commit -m "test(integration): parameterize suite env prefix + image for cross-daemon runs

Adds DEVDB_TEST_ENV_PREFIX (default DEVDB_): container env keys and the
endpoints test's port-range-variable assertion derive from it, so the
suite can drive worktreedb:dev unmodified. Documents the M2 cross-run
gate (11 core files) and its invocation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Milestone acceptance (spec §8-M2)

- `go test ./... -race -count=1` green; `golangci-lint run` 0 issues (worktreedb).
- `go test -tags integration ./integration/...` green — M1's four cases plus branching + restart-reconciliation.
- **The cross-run gate: the 11 reference-suite core files green against `worktreedb:dev` with unmodified assertions** (Task 16 Step 4 output recorded in the cross-run doc).
- Clean-history spot check before merging the worktree branch:
  `cd ~/git/worktreedb && git log --format=%B <base>..HEAD | grep -iE 'devdb|neond|matisiekpl|typescript|fastify|co-authored' ; grep -riE 'devdb|neond|matisiekpl|typescript|fastify' --include='*.go' --include='*.md' . | grep -v neondatabase` — both empty (the sanctioned `neondatabase/neon` oracle mentions excepted).

## Deferred out of M2 (recorded, deliberate)

- **pgBuilds surfaces** (`/api/pg-builds`, status pgBuilds block, `runningPgVersion` values, build registry/OCI) — M3; `PgbinFor`/`InstalledMajors`/`RunningPgbins()` are the seams it plugs into.
- **MCP server + tools + skills** — M3.
- **Web UI copy/embed + full-suite parity gate** — M4 (`web-ui.test.ts` joins there).
- **Suspend/wake** — M5 (`suspend_timeout_seconds` stays `-1`; conn counts and bind-on-running already in place).
- **Resume-on-boot for interrupted restores** — post-parity policy flip (cursor + fingerprint already support it).
- **Engine auto-restart / `starting` in the status DTO union / dual-stack listeners** — post-parity backlog (spec §11).
- P5-3 (tomlString DEL escaping) — M2-or-never per the M1 review; untouched (no new TOML surface this milestone).
