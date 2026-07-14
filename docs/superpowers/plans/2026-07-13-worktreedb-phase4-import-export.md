# Worktree DB Phase 4 — Import / Export (local) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring an existing Postgres database *into* Worktree DB (from a running server's connection string **or** an uploaded `pg_dump -Fc` file) and take a branch's data back *out* to a local `.dump` artifact — the dogfooding unlock, entirely on the local `/data` volume.

**Architecture:** Import and export are **durable `operations` rows** (kinds `import_database` / `export_branch`) driven the same way the M3 dynamic-build pull is: a synchronous, fast preflight in the HTTP/MCP handler, then the long child-process work on a **detached, per-operation cancelable goroutine** (running-server import + export), with `pg_dump`/`pg_restore` shelled out through one shared streaming exec core (`internal/pgtool`). File-upload import is the one synchronous variant — the request body *is* the byte source, streamed through `io.Pipe` into `pg_restore` stdin, so it lands within its request. Import creates a **new project** on the source's detected major (M3 pulls the build on demand or the request refuses before anything is created), bootstraps an empty `main` timeline (`// oracle: neon TimelineCreateRequestMode::Bootstrap`), starts its endpoint, and restores into the single `postgres` database. Progress fans line-by-line onto the existing SSE log hub on a per-operation channel; a failed operation retains a capped stderr tail. Everything is fail-forward on restart (no mid-`pg_restore` resume); deleting an in-flight import cancels its operation context (killing the child) then tears down as a normal project delete.

**Tech Stack:** Go 1.25 stdlib only — `os/exec`, `io`, `bufio`, `mime/multipart`, `net/http`, `context`, `os`, `path/filepath`, `syscall`, `log/slog` (**no new module**; `go.mod` untouched; no `go mod tidy`). `github.com/jackc/pgx/v5/pgconn` (already present) for source-major detection. `modernc.org/sqlite` (already present) via the store. The bundled `pg_dump`/`pg_restore`/`psql` client binaries ship in the engine image under `/usr/local/share/neon/pg_install/v{14..17}/bin/`. Web (copied app, already present): React 19 / Mantine 9 / zod 3 / vitest 4. `testcontainers-go` (integration only, already present).

## Global Constraints

- **Repo split:** all product code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`, `go 1.25.0`); implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — **never on its `main`** (base = current `main@053fa2d` or later). Commands below say `cd ~/git/worktreedb`; substitute the worktree path. **The devdb-repo work (T11's spec/acceptance record) is `~/git/devdb` (workshop).** This plan and any ledger stay in devdb — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers of any kind** (spec D4) — this overrides any harness default. The devdb-repo commits (T11 record) keep devdb's usual `Co-Authored-By` trailer.
- **Clean-history rule:** worktreedb code, comments, tests, commit messages, and docs NEVER mention the TypeScript implementation, the devdb repo, `matisiekpl/neond`, Fastify, or "parity with the old daemon". The **one sanctioned oracle citation** in this milestone is the empty-`main`-timeline creation import reuses — `// oracle: neon TimelineCreateRequestMode::Bootstrap` (the bootstrap variant of the pageserver timeline-create; it is already grounded in `internal/engine/clients.go` and `internal/service/projects.go`). The `pg_dump`/`pg_restore` SQL-level approach is **Worktree DB's own product choice** — NOT an oracle-grounded engine interaction — so its comments cite Postgres' own `pg_dump`/`pg_restore` where useful, never `// oracle: neon`.
- **`go.mod` is FROZEN:** stdlib + already-present modules only. Multipart = stdlib `mime/multipart` + `net/http`; piping = `os/exec` + `io.Pipe`. **If any task appears to need a new module dependency, STOP and flag it — do not add one silently.** `go get` is not run; **no `go mod tidy`**.
- **Web dependency discipline:** `@mantine/dropzone` is **NOT** installed (only `@mantine/core`, `@mantine/hooks`, `@mantine/notifications`). Drag-drop is **hand-rolled** with a native `<input type="file">` + `onDragOver`/`onDrop` handlers — **no new npm dependency.** New zod enum values and a new event-type value are clean content.
- **Credential discipline (spec P4-10) is binding and threaded through every layer:** the source connection string / password is a transient input, **never** persisted in cleartext and **never** logged or streamed. It is redacted (`postgresql://user:***@host…`) in `operations.params`, in every DTO, in every log line, and on the SSE job channel. The password reaches `pg_dump` only via the `PGPASSWORD` environment variable (never on argv, which `ps` and logs can see). The redaction helper (`redactDSN`) is defined in T4 and reused in T4/T5/T7/T8.
- **Streaming, never buffer to disk (spec P4-6):** running-server import pipes `pg_dump | pg_restore`; file-upload streams the HTTP body through `io.Pipe` into `pg_restore` stdin (only a small header prefix is peeked in memory for major detection). Export streams `pg_dump` straight to the artifact file. No dump is ever spooled whole to `/data`.
- **`-race` is load-bearing:** the `internal/pgtool` streaming + context-kill tests (T3) and the import cancel/abort tests (T4) MUST be covered by `go test -race`; a green `-race` run is part of acceptance, not optional polish.
- **Acceptance (spec §8):** `go build ./... && go vet ./...` clean; `go test ./... -race -count=1` green (incl. the pgtool + import/export tests); `golangci-lint run` 0 issues; `go test -tags integration ./integration/...` green including a sidecar-Postgres import and an export→import round-trip; **the full 16-file reference parity suite stays green** — import/export are user-triggered and never fire during the suite, so (unlike M5) **NO D8-style env injection is needed**; just confirm no regression. Clean-history spot check empty; `go.mod`/`go.sum` unchanged.
- **Execution:** SDD, two gates per task (independent reviewer + review-broker scan; severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` pointing into the worktree).

## File map (Phase 4 end state — new/modified only)

```
worktreedb repo:
internal/config/config.go               MODIFY (T1): + ExportsDir derived field (<DataDir>/exports)
internal/config/config_test.go          MODIFY (T1): ExportsDir == <DataDir>/exports
Dockerfile                              MODIFY (T1): RUN tripwire — pg_dump/pg_restore/psql/pg_dumpall per baked major
internal/store/operations.go            MODIFY (T2): UpdateOperationParams, OperationsByKind
internal/store/operations_test.go       CREATE (T2): params-update + by-kind
internal/store/rows.go                  MODIFY (T2): ProjectRow.StatusPhase/StatusMessage scan; SetProjectStatus; FailStaleImports; project-create sets status_phase='ready'
internal/store/rows_test.go             MODIFY (T2): project status + FailStaleImports
internal/store/schema.go                (unchanged — projects.status_phase/status_message already exist; operations reused)
internal/pgtool/pgtool.go               CREATE (T3): Tools{Dir}; Restore/DumpTo/Pipe; process-group kill; stderr tail; ArchiveMajor
internal/pgtool/pgtool_test.go          CREATE (T3): streaming/-race, context-kill, stderr-tail, ArchiveMajor header parse
internal/service/importexport.go        CREATE (T4,T5,T6): op kinds + boot policies; redactDSN; import (server+file); export; Job read; PgToolAPI seam; import-cancel registry
internal/service/importexport_test.go   CREATE (T4,T5,T6): fakes, ensure-major, compensation, delete-during-import, export size/LSN
internal/service/core.go                MODIFY (T4): + PgTool PgToolAPI, DetectSourceMajor func field
internal/service/projects.go            MODIFY (T4): DeleteProject cancels an in-flight import first; seedProjectRows status_phase='ready'
internal/service/fakes_test.go          MODIFY (T4): fakePgTool
cmd/worktreedbd/main.go                 MODIFY (T4): register ImportExportBootPolicies; FailStaleImports on boot; wire PgTool + DetectSourceMajor
internal/api/server.go                  MODIFY (T7): import(server+file)/export/operation routes; multipart streaming; operation SSE
internal/api/dto.go                     MODIFY (T7): jobDTO (+redacted params); projectDTO gains status/statusMessage
internal/api/routes_test.go             MODIFY (T7): import/export/get-operation route tests + multipart
internal/mcp/tools_mutate.go            MODIFY (T8): import_database, export_branch tools
internal/mcp/tools_read.go              MODIFY (T8): get_job tool; CoreAPI += ImportFromServer/ExportBranch/Job/ProjectByNameOr404 reuse
internal/mcp/tools_test.go              MODIFY (T8): tool tests
web/src/shared.ts                       MODIFY (T9): JobKind/JobPhase/ProjectStatus enums; JobDto; ProjectDto.status; +operation.updated event
web/src/api/client.ts                   MODIFY (T9): api.imports/api.exports/api.jobs; FormData upload method
web/src/api/hooks.ts                    MODIFY (T9): useImportFromServer/useImportFile/useExportBranch/useJob
web/src/api/keys.ts                     MODIFY (T9): jobs key
web/src/api/events.ts                   MODIFY (T9): mapEventToKeys += operation.updated
web/src/settings/ImportExportCard.tsx   CREATE (T9): import form (connstring + drag-drop) + job progress
web/src/pages/SettingsPage.tsx          MODIFY (T9): replace the "Export targets" stub with ImportExportCard
web/src/tree/BranchActionsMenu.tsx      MODIFY (T9): "Export database…" item
web/src/drawer/JobProgress.tsx          CREATE (T9): SSE job-log panel (LogsTab-shaped)
integration/importexport_test.go        CREATE (T10): sidecar import, round-trip, out-of-range refuse, failure honesty, delete-during-import
README.md                               MODIFY (T11): import/export section + docs
AGENTS.md                               MODIFY (T11): import/export note in the architecture paragraph

devdb repo (workshop):
docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md  MODIFY (T11): acceptance-record note
docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md                       MODIFY (T11): Phase-4 no-regression record
```

**Task dependency order:** T1 → T2 → T3 → T4 → {T5, T6} → T7 → {T8, T9} → T10 → T11. T3 (the exec core) and T2 (store helpers) underpin T4 (import service). T5 (file-upload) needs T3+T4; T6 (export) needs T2+T3. T7 (REST) needs T4+T5+T6. T8 (MCP) and T9 (web) are independent once T7's service/DTO shapes exist. T10 needs the full image; T11 is docs.

**Decisions made in this plan beyond the spec (all flagged in-line where they land):**
- **Async model = M3 pull-shaped, not lane-held.** The spec §2 says operations run "inside the target branch's owner lane exactly as timetravel". That framing does not fit import (which *creates* the branch) and cannot support delete-abort (a lane-held multi-minute restore blocks a lane-queued delete). Resolution: the long child-process step runs on a **detached, per-operation cancelable context** (exactly like `builds.Service.Pull`); state writes stay generation-checked/serialized; delete cancels the operation context out-of-lane. This is the plan's answer to the spec's §10 open questions on step ordering and delete-during-import.
- **File-upload import is synchronous** (an uploaded body cannot outlive its request); running-server import + export are async (202 + poll/SSE). Both create the same durable operation.
- **Export size+LSN persist in `operations.params` JSON via a new `UpdateOperationParams` — no migration** (the spec's stated preference).
- **Import status surfaces on the PROJECT** (`status_phase` importing→ready|failed + `status_message` stderr tail), matching the spec's "project visible in failed state". **No new endpoint-status enum value** — the endpoint state machine is parity-critical and is left untouched.
- **Job progress channel** = `job:<operationID>` on the existing log hub; a new `operation.updated` bus event drives UI invalidation.
- **No artificial upload/export size cap** (streaming has natural backpressure; a cap would truncate a legitimate large dump). Export artifacts are listable via the operations surface but **not** auto-GC'd or API-deletable this milestone (user manages `/data/exports`).

---

### Task 1: Config — exports dir + the client-binary build tripwire

Add the derived `/data/exports` directory to config, and a Dockerfile `RUN` that fails the build if any baked major is missing `pg_dump`/`pg_restore`/`psql`/`pg_dumpall` (they are currently unguarded — the daemon shells them at runtime, so a missing one must fail the build, not a user's first export).

**Files:**
- Modify: `internal/config/config.go`, `internal/config/config_test.go`, `Dockerfile`

**Interfaces:**
- Consumes: the `Load(getenv)` pattern; `cfg.DataDir`; the `PgBuildsDir`/`PgDistribDir` derived-field precedent.
- Produces: `config.Config.ExportsDir string` — `<DataDir>/exports`, where export artifacts are written (T6 creates the dir lazily).

- [ ] **Step 1: Write the failing test**

In `internal/config/config_test.go`, add (the `valid()` / `env()` helpers already exist at the top of the file):

```go
func TestExportsDirDerived(t *testing.T) {
	cfg, err := Load(env(valid()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	want := filepath.Join(cfg.DataDir, "exports")
	if cfg.ExportsDir != want {
		t.Fatalf("ExportsDir = %q, want %q", cfg.ExportsDir, want)
	}
}
```

`path/filepath` is already imported in `config_test.go` if the existing tests reference derived dirs; if not, add it to that file's import block.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -run TestExportsDirDerived -count=1`
Expected: **FAIL to compile** — `cfg.ExportsDir` undefined.

- [ ] **Step 3: Add the field + derivation**

In `internal/config/config.go`, add to the `Config` struct (next to `PgBuildsDir`/`PgDistribDir`):

```go
	ExportsDir string // <DataDir>/exports — local pg_dump -Fc artifacts (import/export)
```

In `Load`, next to the existing `cfg.PgBuildsDir = filepath.Join(...)` lines:

```go
	cfg.ExportsDir = filepath.Join(cfg.DataDir, "exports")
```

- [ ] **Step 4: Run the config tests (GREEN)**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -count=1`
Expected: **PASS** (all config tests, including the new one).

- [ ] **Step 5: Add the Dockerfile client-binary tripwire**

In `Dockerfile`, in the final runtime stage, immediately AFTER `COPY --from=neon-binaries /usr/local/share/neon /usr/local/share/neon` (before the `ENV` block), add:

```dockerfile
# Client-binary tripwire: import/export shell these out at runtime, so a baked
# major that is missing any of them must fail the BUILD, not a user's first
# export. Asserts each installed vNN/bin has the four tools. If a future image
# bakes a different major set, this loop covers whatever v*/ dirs exist.
RUN set -eu; \
    for d in /usr/local/share/neon/pg_install/v*/bin; do \
      for tool in pg_dump pg_restore psql pg_dumpall; do \
        test -x "$d/$tool" || { echo "MISSING client binary: $d/$tool" >&2; exit 1; }; \
      done; \
      echo "client binaries present: $d"; \
    done
```

- [ ] **Step 6: Build the image to exercise the tripwire**

Run: `export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin" && cd ~/git/worktreedb && docker build -t worktreedb:dev .`
Expected: the build **succeeds** and the build log shows `client binaries present: /usr/local/share/neon/pg_install/v14/bin` … through `v17` (proving all four tools exist per baked major). A failure here means the engine image lacks a client binary — a real prerequisite gap to surface, not to paper over.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/config/config.go internal/config/config_test.go Dockerfile
git commit -m "feat(config): exports dir + build-time client-binary tripwire"
```

---

### Task 2: Store — operation-params update, by-kind read, project import status

Give the store what durable import/export need: a way to record export outputs (size/LSN/path) into `operations.params` after creation (**no migration** — the params column is reused), a by-kind operations read (job history + the boot import sweep), and project-level import status (`importing → ready | failed` + stderr tail) using the **already-present** `projects.status_phase`/`status_message` columns.

**Files:**
- Modify: `internal/store/operations.go`, `internal/store/rows.go`
- Create: `internal/store/operations_test.go`
- Modify: `internal/store/rows_test.go`

**Interfaces:**
- Consumes: `CreateOperation`/`OperationByID` (operations.go); `WithTx`; `NowISO`; the `projects` table (`status_phase`, `status_message` columns already in `schema.go`).
- Produces (consumed by T4/T6/T7):
  - `func (s *Store) UpdateOperationParams(ctx, id, paramsJSON string) error` — overwrites `operations.params` (export writes size/LSN/artifact-path in at finalize; RunOperation never reads params, so this is safe mid/post-operation).
  - `func (s *Store) OperationsByKind(ctx, kind string) ([]Operation, error)` — newest last, for job history + the boot import sweep.
  - `ProjectRow.StatusPhase string`, `ProjectRow.StatusMessage *string` — scanned into every project read.
  - `func (s *Store) SetProjectStatus(ctx, id, phase string, message *string) error`.
  - `func (s *Store) FailStaleImports(ctx) (int64, error)` — boot reconcile: every project still `importing` becomes `failed` (message "interrupted by restart"). Returns the count.

- [ ] **Step 1: Write the failing store tests**

Create `internal/store/operations_test.go`:

```go
package store

import (
	"context"
	"encoding/json"
	"testing"
)

func TestUpdateOperationParams(t *testing.T) {
	st := open(t) // existing store-test helper (store_test.go): a temp-dir *Store
	ctx := context.Background()
	id, err := st.CreateOperation(ctx, "export_branch", "b1", `{"branch_id":"b1"}`, "fp")
	if err != nil {
		t.Fatal(err)
	}
	upd, _ := json.Marshal(map[string]any{"branch_id": "b1", "size_bytes": 4096, "lsn": "0/16B3760"})
	if err := st.UpdateOperationParams(ctx, id, string(upd)); err != nil {
		t.Fatal(err)
	}
	op, ok, err := st.OperationByID(ctx, id)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(op.Params), &got); err != nil {
		t.Fatal(err)
	}
	if got["size_bytes"] != float64(4096) || got["lsn"] != "0/16B3760" {
		t.Fatalf("params not updated: %v", got)
	}
}

func TestOperationsByKind(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	if _, err := st.CreateOperation(ctx, "export_branch", "b1", "{}", "fp"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateOperation(ctx, "import_database", "b2", "{}", "fp"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateOperation(ctx, "export_branch", "b3", "{}", "fp"); err != nil {
		t.Fatal(err)
	}
	exports, err := st.OperationsByKind(ctx, "export_branch")
	if err != nil {
		t.Fatal(err)
	}
	if len(exports) != 2 || exports[0].TargetID != "b1" || exports[1].TargetID != "b3" {
		t.Fatalf("export_branch ops = %+v", exports)
	}
}
```

Add to `internal/store/rows_test.go`:

```go
func TestProjectStatusAndStaleImports(t *testing.T) {
	st := open(t)
	ctx := context.Background()
	p, err := st.CreateProject(ctx, ProjectParams{ID: NewID(), Name: "p", PgMajor: 17})
	if err != nil {
		t.Fatal(err)
	}
	// Fresh projects rest 'ready'.
	if got, _, _ := st.ProjectByID(ctx, p.ID); got.StatusPhase != "ready" {
		t.Fatalf("new project status = %q, want ready", got.StatusPhase)
	}
	msg := "restoring"
	if err := st.SetProjectStatus(ctx, p.ID, "importing", &msg); err != nil {
		t.Fatal(err)
	}
	got, _, _ := st.ProjectByID(ctx, p.ID)
	if got.StatusPhase != "importing" || got.StatusMessage == nil || *got.StatusMessage != "restoring" {
		t.Fatalf("after SetProjectStatus: %+v", got)
	}
	// Boot sweep flips a lingering import to failed.
	n, err := st.FailStaleImports(ctx)
	if err != nil || n != 1 {
		t.Fatalf("FailStaleImports = %d err=%v", n, err)
	}
	got, _, _ = st.ProjectByID(ctx, p.ID)
	if got.StatusPhase != "failed" || got.StatusMessage == nil || *got.StatusMessage != "interrupted by restart" {
		t.Fatalf("stale import not failed: %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -run 'TestUpdateOperationParams|TestOperationsByKind|TestProjectStatusAndStaleImports' -count=1`
Expected: **FAIL to compile** — the new methods + `ProjectRow.StatusPhase`/`StatusMessage` are undefined.

- [ ] **Step 3: Add the operation helpers**

In `internal/store/operations.go`, add after `OperationByID`:

```go
// UpdateOperationParams overwrites an operation's params JSON. Export records
// its artifact size/LSN/path here at finalize — the params column is reused
// for the operation's OUTPUTS as well as its inputs. Safe at any phase:
// runtime.RunOperation never reads params, and the boot resume of these kinds
// is fail-forward (no step rebuild), so nothing races this write.
func (s *Store) UpdateOperationParams(ctx context.Context, id, paramsJSON string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE operations SET params = ?, updated_at = ? WHERE id = ?`, paramsJSON, NowISO(), id)
	return err
}

// OperationsByKind returns every operation of a kind, oldest first — the job
// history read (export artifacts) and the boot import sweep both consult it.
func (s *Store) OperationsByKind(ctx context.Context, kind string) ([]Operation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, kind, COALESCE(target_id,''), params, step_cursor, phase, COALESCE(error,''), COALESCE(plan_fingerprint,'')
		   FROM operations WHERE kind = ? ORDER BY created_at, id`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Operation
	for rows.Next() {
		var o Operation
		if err := rows.Scan(&o.ID, &o.Kind, &o.TargetID, &o.Params, &o.StepCursor, &o.Phase, &o.Error, &o.PlanFingerprint); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Add project status columns to the read + the setters**

In `internal/store/rows.go`, extend `ProjectRow`:

```go
type ProjectRow struct {
	ID            string
	Name          string
	PgMajor       int
	TenantID      string
	CreatedAt     string
	StatusPhase   string  // ready | importing | failed
	StatusMessage *string // e.g. an import's stderr tail on failure
}
```

Update `projectCols` and `scanProject` to carry the two columns:

```go
const projectCols = `id, name, pg_major, tenant_id, created_at, status_phase, status_message`

func scanProject(r interface{ Scan(...any) error }) (ProjectRow, error) {
	var p ProjectRow
	err := r.Scan(&p.ID, &p.Name, &p.PgMajor, &p.TenantID, &p.CreatedAt, &p.StatusPhase, &p.StatusMessage)
	return p, err
}
```

Make the standalone `CreateProject` insert rest `'ready'` (the schema default is `'pending'`; a non-imported project is by definition ready). Change its INSERT:

```go
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO projects (id, name, pg_major, tenant_id, created_at, status_phase) VALUES (?,?,?,?,?, 'ready')`,
		p.ID, p.Name, p.PgMajor, p.ID, NowISO())
```

Add the setters after `DeleteProject`:

```go
// SetProjectStatus writes a project's coarse lifecycle phase + optional
// message (importing → ready | failed). message nil clears the column.
func (s *Store) SetProjectStatus(ctx context.Context, id, phase string, message *string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE projects SET status_phase = ?, status_message = ? WHERE id = ?`, phase, message, id)
	return err
}

// FailStaleImports flips every project still marked 'importing' at boot to
// 'failed' ("interrupted by restart") — the project-level counterpart to the
// fail-forward boot policy for interrupted import operations. Runs pre-owner,
// single-threaded, like ResetEndpointsOnBoot.
func (s *Store) FailStaleImports(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE projects SET status_phase = 'failed', status_message = 'interrupted by restart'
		  WHERE status_phase = 'importing'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
```

Note: `seedProjectRows` in `internal/service/projects.go` builds its own projects INSERT — T4 updates it to set `status_phase='ready'` there too (kept with the service change that also touches that file).

- [ ] **Step 5: Run the store tests (GREEN)**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -count=1`
Expected: **PASS** (existing project reads gain the two columns transparently — the schema already has them; the new tests pass).

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/store/operations.go internal/store/operations_test.go internal/store/rows.go internal/store/rows_test.go
git commit -m "feat(store): operation params update + by-kind read + project import status"
```

---

### Task 3: `internal/pgtool` — the streaming pg_dump/pg_restore exec core

One package that shells `pg_dump`/`pg_restore`, streaming stdout/stderr line-by-line to a sink, capturing a bounded stderr tail, killable by context (process-group), passing the password only via `PGPASSWORD`. This is the shared restore/dump engine both import fronts and export use, and the `-race`-tested crux of the milestone. It has **no** dependency on `service` (it takes a `Sink func(string)` callback), so it is unit-testable in isolation.

**Files:**
- Create: `internal/pgtool/pgtool.go`, `internal/pgtool/pgtool_test.go`

**Interfaces:**
- Consumes: stdlib `os/exec`, `io`, `bufio`, `syscall`.
- Produces (consumed by T4/T5/T6):
  - `type Tools struct { Dir string }` — `Dir` is a `pg_install/vNN/bin` directory holding the client binaries.
  - `type DumpSpec struct { DSN string; Password string; Sink func(string) }` — dump a source; `DSN` is password-FREE (host/port/user/db only), password via env.
  - `type RestoreSpec struct { DSN string; Password string; In io.Reader; Sink func(string) }` — restore into `DSN` from the `-Fc` archive bytes on `In`.
  - `func (t Tools) DumpTo(ctx context.Context, spec DumpSpec, out io.Writer) (stderrTail string, err error)` — `pg_dump -Fc … > out` (export).
  - `func (t Tools) Restore(ctx context.Context, spec RestoreSpec) (stderrTail string, err error)` — `pg_restore … < In` (file-upload import).
  - `func (t Tools) Pipe(ctx context.Context, dump DumpSpec, restore RestoreSpec) (stderrTail string, err error)` — `pg_dump src | pg_restore dst` (running-server import); `restore.In` is ignored.
  - `func ArchiveMajor(header []byte) (int, error)` — parse a `pg_dump -Fc` custom-format header prefix for the dumping server's major.

- [ ] **Step 1: Write the failing tests**

Create `internal/pgtool/pgtool_test.go`. The streaming/kill tests use a fake "tool dir" containing tiny shell scripts named `pg_dump`/`pg_restore`, so no real Postgres is needed and `-race` exercises the pipe/goroutine machinery:

```go
package pgtool

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// toolDir writes an executable script named `name` into a temp dir and returns
// the dir. The script body receives args; tests script stdout/stderr/exit.
func toolDir(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRestoreStreamsStderrAndTail(t *testing.T) {
	// pg_restore that emits 3 stderr lines then fails: the sink sees all three,
	// the returned tail carries them, and the error is non-nil.
	dir := toolDir(t, "pg_restore", `
echo "pg_restore: connecting" >&2
echo "pg_restore: creating TABLE notes" >&2
echo "pg_restore: error: could not execute query" >&2
exit 1`)
	var lines []string
	tail, err := Tools{Dir: dir}.Restore(context.Background(), RestoreSpec{
		DSN: "postgresql://postgres@127.0.0.1:5432/postgres", In: strings.NewReader("dump-bytes"),
		Sink: func(l string) { lines = append(lines, l) },
	})
	if err == nil {
		t.Fatal("a failing pg_restore must return an error")
	}
	if len(lines) != 3 || !strings.Contains(lines[2], "could not execute query") {
		t.Fatalf("sink lines = %v", lines)
	}
	if !strings.Contains(tail, "could not execute query") {
		t.Fatalf("stderr tail = %q", tail)
	}
}

func TestRestoreReadsStdin(t *testing.T) {
	// pg_restore that copies stdin to a file proves In is wired to the child.
	out := filepath.Join(t.TempDir(), "seen")
	dir := toolDir(t, "pg_restore", `cat > `+out+`
exit 0`)
	if _, err := (Tools{Dir: dir}).Restore(context.Background(), RestoreSpec{
		DSN: "postgresql://postgres@127.0.0.1:5432/postgres",
		In:  strings.NewReader("PGDMP-payload"),
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if string(got) != "PGDMP-payload" {
		t.Fatalf("stdin not streamed to child: %q", got)
	}
}

func TestDumpToWritesOutput(t *testing.T) {
	dir := toolDir(t, "pg_dump", `printf 'ARCHIVE'; exit 0`)
	var buf bytes.Buffer
	if _, err := (Tools{Dir: dir}).DumpTo(context.Background(), DumpSpec{
		DSN: "postgresql://postgres@127.0.0.1:5432/postgres",
	}, &buf); err != nil {
		t.Fatal(err)
	}
	if buf.String() != "ARCHIVE" {
		t.Fatalf("dump output = %q", buf.String())
	}
}

func TestPipeConnectsDumpToRestore(t *testing.T) {
	// pg_dump emits bytes; pg_restore copies stdin to a file. Pipe wires them.
	seen := filepath.Join(t.TempDir(), "seen")
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "pg_dump"), []byte("#!/bin/sh\nprintf 'PIPED'\nexit 0"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "pg_restore"), []byte("#!/bin/sh\ncat > "+seen+"\nexit 0"), 0o755)
	if _, err := (Tools{Dir: dir}).Pipe(context.Background(),
		DumpSpec{DSN: "postgresql://postgres@127.0.0.1:5432/db"},
		RestoreSpec{DSN: "postgresql://postgres@127.0.0.1:5432/postgres"}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(seen)
	if string(got) != "PIPED" {
		t.Fatalf("pipe did not connect dump->restore: %q", got)
	}
}

func TestContextKillTerminatesChild(t *testing.T) {
	// A pg_restore that would sleep 60s must be killed promptly when ctx cancels.
	dir := toolDir(t, "pg_restore", `sleep 60`)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := Tools{Dir: dir}.Restore(ctx, RestoreSpec{
			DSN: "postgresql://postgres@127.0.0.1:5432/postgres", In: strings.NewReader(""),
		})
		done <- err
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a cancelled restore must return an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("context cancel did not kill the child within 5s")
	}
}

func TestArchiveMajorParsesHeader(t *testing.T) {
	// Build a minimal custom-format header prefix (magic + version + sizes +
	// the fields up to the server-version string) and assert the major.
	got, err := ArchiveMajor(fakeCustomHeader(t, "16.4"))
	if err != nil {
		t.Fatal(err)
	}
	if got != 16 {
		t.Fatalf("ArchiveMajor = %d, want 16", got)
	}
}

// fakeCustomHeader synthesizes just enough of a pg_dump -Fc header for
// ArchiveMajor: "PGDMP", vmaj/vmin/vrev, intSize, offSize, format, then ReadInt
// compression + a 7-field ReadInt timestamp, then ReadStr dbname + ReadStr
// serverVersion. ReadInt = 1 sign byte + intSize LE magnitude bytes; ReadStr =
// ReadInt length + that many bytes. Mirrors src/bin/pg_dump/pg_backup_archiver.c.
func fakeCustomHeader(t *testing.T, serverVersion string) []byte {
	t.Helper()
	const intSize = 4
	var b bytes.Buffer
	b.WriteString("PGDMP")
	b.Write([]byte{1, 15, 0}) // vmaj=1 vmin=15 vrev=0 (>=1.15: ReadInt compression)
	b.WriteByte(intSize)      // intSize
	b.WriteByte(8)            // offSize
	b.WriteByte(1)            // format = custom
	writeInt := func(v int) {
		b.WriteByte(0) // sign: non-negative
		var tmp [intSize]byte
		binary.LittleEndian.PutUint32(tmp[:], uint32(v))
		b.Write(tmp[:])
	}
	writeStr := func(s string) {
		writeInt(len(s))
		b.WriteString(s)
	}
	writeInt(0)              // compression spec (>=1.15 ReadInt)
	for i := 0; i < 7; i++ { // sec,min,hour,mday,mon,year,isdst
		writeInt(0)
	}
	writeStr("sourcedb")     // dbname
	writeStr(serverVersion)  // remote server version string — what we parse
	return b.Bytes()
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/pgtool/ -count=1`
Expected: **FAIL to compile** — the package/types/functions do not exist yet.

- [ ] **Step 3: Implement the streaming exec core**

Create `internal/pgtool/pgtool.go`:

```go
// Package pgtool shells the bundled pg_dump/pg_restore client binaries for
// import/export. It streams child stdout/stderr line-by-line to a sink, keeps a
// bounded stderr tail for failure messages, and kills the child's whole process
// group when the context is cancelled (a delete-during-import or shutdown). The
// SQL-level dump/restore approach is Worktree DB's own product choice — these
// are Postgres tools, not the storage engine, so nothing here is oracle-grounded.
package pgtool

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// tailLines is how many trailing stderr lines a failure preserves. pg_restore's
// real error is on the last few lines; a cap keeps a runaway log out of the row.
const tailLines = 40

type Tools struct{ Dir string } // a pg_install/vNN/bin directory

type DumpSpec struct {
	DSN      string // password-FREE connection string (password via env)
	Password string
	Sink     func(string)
}

type RestoreSpec struct {
	DSN      string
	Password string
	In       io.Reader // the -Fc archive bytes (nil for Pipe, which wires pg_dump)
	Sink     func(string)
}

func (t Tools) bin(name string) string { return filepath.Join(t.Dir, name) }

// command builds an exec.Cmd in its own process group (Setpgid) so a context
// cancel can group-kill the whole child tree, and with PGPASSWORD in the env so
// the credential never appears on argv. env entries beyond PGPASSWORD are the
// process env (PATH etc.) inherited by default.
func (t Tools) command(ctx context.Context, name, password string, args ...string) *exec.Cmd {
	cmd := exec.Command(t.bin(name), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if password != "" {
		cmd.Env = append(cmd.Environ(), "PGPASSWORD="+password)
	}
	// Group-kill on cancel: negative pid signals the whole process group.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	_ = ctx // ctx is applied by the caller via a watcher goroutine (see run)
	return cmd
}

// tailWriter is an io.Writer that scans lines to the sink and keeps the last
// tailLines in a ring for the failure message.
type tailWriter struct {
	mu   sync.Mutex
	sink func(string)
	ring []string
}

func (w *tailWriter) add(line string) {
	if w.sink != nil {
		func() { defer func() { _ = recover() }(); w.sink(line) }()
	}
	w.mu.Lock()
	w.ring = append(w.ring, line)
	if len(w.ring) > tailLines {
		w.ring = w.ring[1:]
	}
	w.mu.Unlock()
}

func (w *tailWriter) tail() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return strings.Join(w.ring, "\n")
}

// pumpStderr scans r line by line into the tail writer until EOF.
func pumpStderr(r io.Reader, w *tailWriter) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		w.add(sc.Text())
	}
}

// dumpArgs / restoreArgs centralize the flags. The password is stripped from
// the DSN by the caller and supplied via PGPASSWORD; --no-owner/--no-privileges
// make a restore land cleanly under the postgres superuser regardless of the
// source's roles; --exit-on-error surfaces the first real failure honestly.
func dumpArgs(dsn string) []string {
	return []string{"-Fc", "--no-owner", "--no-privileges", dsn}
}
func restoreArgs(dsn string) []string {
	return []string{"--no-owner", "--no-privileges", "--exit-on-error", "--dbname=" + dsn}
}

// run starts cmd with ctx-bound group kill, pumps stderr to the tail, waits, and
// returns the stderr tail plus any error. A ctx that is already cancelled kills
// promptly; the watcher goroutine bridges ctx to cmd.Cancel because exec.Command
// (not CommandContext) is used so the SysProcAttr group is set first.
func run(ctx context.Context, cmd *exec.Cmd, sink func(string)) (string, error) {
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	tw := &tailWriter{sink: sink}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start %s: %w", filepath.Base(cmd.Path), err)
	}
	// Bridge ctx cancellation to a group kill.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			if cmd.Cancel != nil {
				_ = cmd.Cancel()
			}
		case <-stop:
		}
	}()
	pumpStderr(stderr, tw)
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return tw.tail(), fmt.Errorf("%s cancelled: %w", filepath.Base(cmd.Path), ctx.Err())
	}
	if waitErr != nil {
		return tw.tail(), fmt.Errorf("%s failed: %w", filepath.Base(cmd.Path), waitErr)
	}
	return tw.tail(), nil
}

// DumpTo runs pg_dump -Fc, writing the archive to out (export → artifact file).
func (t Tools) DumpTo(ctx context.Context, spec DumpSpec, out io.Writer) (string, error) {
	cmd := t.command(ctx, "pg_dump", spec.Password, dumpArgs(spec.DSN)...)
	cmd.Stdout = out
	return run(ctx, cmd, spec.Sink)
}

// Restore runs pg_restore reading the -Fc archive from spec.In (file-upload).
func (t Tools) Restore(ctx context.Context, spec RestoreSpec) (string, error) {
	cmd := t.command(ctx, "pg_restore", spec.Password, restoreArgs(spec.DSN)...)
	cmd.Stdin = spec.In
	return run(ctx, cmd, spec.Sink)
}

// Pipe runs pg_dump | pg_restore with no temp file (running-server import). Both
// children are group-killed on cancel; stderr of BOTH is fanned to the restore
// sink and folded into one tail. pg_dump's stderr is prefixed so a failure is
// attributable.
func (t Tools) Pipe(ctx context.Context, dump DumpSpec, restore RestoreSpec) (string, error) {
	pr, pw := io.Pipe()
	dumpCmd := t.command(ctx, "pg_dump", dump.Password, dumpArgs(dump.DSN)...)
	dumpCmd.Stdout = pw
	restoreCmd := t.command(ctx, "pg_restore", restore.Password, restoreArgs(restore.DSN)...)
	restoreCmd.Stdin = pr

	sink := restore.Sink
	dumpSink := func(l string) {
		if sink != nil {
			sink("pg_dump: " + l)
		}
	}

	var wg sync.WaitGroup
	var dumpTail string
	var dumpErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		dumpTail, dumpErr = run(ctx, dumpCmd, dumpSink)
		_ = pw.CloseWithError(dumpErr) // EOF (or error) reaches pg_restore's stdin
	}()

	restoreTail, restoreErr := run(ctx, restoreCmd, sink)
	_ = pr.Close()
	wg.Wait()

	if restoreErr != nil {
		return restoreTail, restoreErr
	}
	if dumpErr != nil {
		return strings.TrimSpace(dumpTail + "\n" + restoreTail), dumpErr
	}
	return restoreTail, nil
}

// ArchiveMajor parses a pg_dump -Fc custom-format header prefix for the dumping
// server's major version. Only the header (well under 1 KB) is needed, so the
// caller peeks a small prefix and streams the rest into pg_restore untouched.
// Mirrors ReadHead/ReadInt/ReadStr in src/bin/pg_dump/pg_backup_archiver.c.
func ArchiveMajor(header []byte) (int, error) {
	r := bytes.NewReader(header)
	magic := make([]byte, 5)
	if _, err := io.ReadFull(r, magic); err != nil || string(magic) != "PGDMP" {
		return 0, fmt.Errorf("not a pg_dump custom-format archive (bad magic)")
	}
	readByte := func() (int, error) { b, err := r.ReadByte(); return int(b), err }
	vmaj, err := readByte()
	if err != nil {
		return 0, err
	}
	vmin, err := readByte()
	if err != nil {
		return 0, err
	}
	if _, err := readByte(); err != nil { // vrev
		return 0, err
	}
	intSize, err := readByte()
	if err != nil || intSize < 1 || intSize > 8 {
		return 0, fmt.Errorf("unsupported archive int size")
	}
	if _, err := readByte(); err != nil { // offSize
		return 0, err
	}
	if _, err := readByte(); err != nil { // format
		return 0, err
	}
	version := vmaj*100 + vmin
	readInt := func() (int, error) {
		sign, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		buf := make([]byte, intSize)
		if _, err := io.ReadFull(r, buf); err != nil {
			return 0, err
		}
		var v uint64
		for i := 0; i < intSize; i++ {
			v |= uint64(buf[i]) << (8 * i)
		}
		n := int(v)
		if sign != 0 {
			n = -n
		}
		return n, nil
	}
	readStr := func() (string, error) {
		n, err := readInt()
		if err != nil {
			return "", err
		}
		if n < 0 {
			return "", nil // NULL string
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		return string(buf), nil
	}
	// compression: >=1.15 is a ReadInt spec; older is a single byte.
	if version >= 115 {
		if _, err := readInt(); err != nil {
			return 0, err
		}
	} else if _, err := readByte(); err != nil {
		return 0, err
	}
	// timestamp: 7 ReadInts (>=1.4). All our supported dumps are >=1.12.
	for i := 0; i < 7; i++ {
		if _, err := readInt(); err != nil {
			return 0, err
		}
	}
	if _, err := readStr(); err != nil { // dbname
		return 0, err
	}
	serverVersion, err := readStr() // remote server version string, e.g. "16.4"
	if err != nil {
		return 0, err
	}
	return majorFromVersion(serverVersion)
}
```

> **AMENDED (2026-07-14, post T10 container acceptance):** the compression-field
> comment in the block above (`// compression: >=1.15 is a ReadInt spec; older is
> a single byte.`) was **inverted** relative to postgres's own `ReadHead`
> (`src/bin/pg_dump/pg_backup_archiver.c`): dump version **≥1.15 writes a single
> compression-ALGORITHM byte**, not a `ReadInt`; **1.4–1.14** writes the 5-byte
> `ReadInt` compression **level** (1 sign byte + 4-byte magnitude); 1.2–1.3 a
> single level byte; below 1.2 nothing. `ArchiveMajor` was implemented faithfully
> to the comment above — and its unit tests (`fakeCustomHeader`) were built to
> the SAME wrong assumption, so the inversion was invisible to the unit suite;
> every synthetic fixture shared the bad premise. It surfaced only when the T10
> container acceptance fed it a real `pg_dump -Fc` archive: the over-read
> desynced the parser four bytes past the compression field, so the later
> server-version string length decoded as garbage and `POST /api/imports/file`
> rejected every real archive with a spurious 400 ("archive header string length
> out of range"). Fixed in worktreedb `fix(pgtool): read the -Fc header
> compression field per ReadHead's version ladder` (commit `808643d`), which also
> captures a real PG17 archive header as a regression fixture
> (`testdata/real_pg17_header.dump`) — a real-archive test class no synthetic
> fixture could have provided. Full acceptance record:
> `docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md`
> `## AMENDED (2026-07-14)` + `## Delivered`.

```go
// majorFromVersion extracts the integer major from a server_version string:
// "16.4" -> 16, "14.11" -> 14. Postgres has used a single-number major since 10.
func majorFromVersion(v string) (int, error) {
	v = strings.TrimSpace(v)
	if i := strings.IndexAny(v, ". "); i > 0 {
		v = v[:i]
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("could not parse server version %q", v)
	}
	return n, nil
}
```

- [ ] **Step 4: Run the pgtool tests, then the package with `-race`**

Run: `cd ~/git/worktreedb && go test ./internal/pgtool/ -count=1`
Expected: **PASS** (streaming, stdin wiring, pipe, context-kill, header parse).

Run: `cd ~/git/worktreedb && go test ./internal/pgtool/ -race -count=1`
Expected: **PASS with no data races** (the tail writer + stderr pump + pipe goroutines are the crux).

Run: `cd ~/git/worktreedb && go vet ./internal/pgtool/ && golangci-lint run ./internal/pgtool/...`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/pgtool/pgtool.go internal/pgtool/pgtool_test.go
git commit -m "feat(pgtool): streaming pg_dump/pg_restore exec core with context group-kill"
```

---

### Task 4: Import service — running-server import, the operation, and delete-during-import abort

The import heart: op kinds + boot policies, DSN redaction/splitting, the `PgToolAPI` seam + `DetectSourceMajor` on `Core`, the per-project import-cancel registry, `ImportFromServer` (sync detect+refuse, then a detached fail-forward operation: ensure-build → create project → start main → `pg_dump | pg_restore` → finalize), and `DeleteProject`'s abort hook. This task also refactors `createProject` to accept a caller-supplied id + status phase (so import owns the project id it returned at 202) and wires everything in `main`.

**Files:**
- Create: `internal/service/importexport.go`
- Create: `internal/service/importexport_test.go`
- Modify: `internal/service/core.go`, `internal/service/projects.go`, `internal/service/fakes_test.go`, `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: `pgtool` (T3); `store.CreateOperation`/`UpdateOperationParams`/`SetProjectStatus`/`OperationsByKind`/`FailStaleImports` (T2); `runtime.RunOperation`/`PlanFingerprint`/`FailForwardOnBoot`; `Core.StartEndpoint`/`ConnectionString`/`PgbinFor`/`InstalledMajors`; the `builds.Service.Pull` seam (via a func field).
- Produces (consumed by T5/T6/T7/T8):
  - `const OpImportDatabase = "import_database"`, `const OpExportBranch = "export_branch"`.
  - `func ImportExportBootPolicies() map[string]runtime.BootPolicy` — both fail-forward.
  - `type PgToolAPI interface { Pipe(ctx, binDir string, dump pgtool.DumpSpec, restore pgtool.RestoreSpec) (string, error); Restore(ctx, binDir string, spec pgtool.RestoreSpec) (string, error); DumpTo(ctx, binDir string, spec pgtool.DumpSpec, out io.Writer) (string, error) }`.
  - `Core.PgTool PgToolAPI`, `Core.DetectSourceMajor func(ctx, dsn string) (int, error)`, `Core.EnsureMajorReady func(ctx, major int) error` (all nil-safe seams).
  - `type ImportServerParams struct { Name string; ConnectionString string }`.
  - `type JobRef struct { JobID, ProjectID, BranchID string }`.
  - `func (c *Core) ImportFromServer(ctx, p ImportServerParams) (JobRef, error)`.
  - `type JobView struct { ID, Kind, TargetID, Phase, Error string; Params map[string]any }` and `func (c *Core) Job(ctx, id string) (JobView, error)`.
  - `func redactDSN(dsn string) string`, `func splitDSN(dsn string) (redacted, noPassword, password string, err error)`.
  - `func JobChannel(kind, targetID string) string` — the single SSE log-channel source (import: `job:import:<projectID>`; export: `job:<branchID>:export`), used by the service to `Ingest` and (T7) by the API to `Subscribe`.

- [ ] **Step 1: Add the `PgToolAPI` seam + `Core` fields**

In `internal/service/core.go`, add the import to the block (`io` and the pgtool package):

```go
	"io"

	"github.com/VanGoghSoftware/worktreedb/internal/pgtool"
```

Add the interface after `ProxyAPI`:

```go
// PgToolAPI is the pg_dump/pg_restore exec surface import/export consume —
// *pgtool.Tools-per-binDir satisfies it via the production adapter (main); unit
// tests pass a fake that records specs and returns canned output. binDir is the
// pg_install/vNN/bin directory whose client binaries to run.
type PgToolAPI interface {
	Pipe(ctx context.Context, binDir string, dump pgtool.DumpSpec, restore pgtool.RestoreSpec) (stderrTail string, err error)
	Restore(ctx context.Context, binDir string, spec pgtool.RestoreSpec) (stderrTail string, err error)
	DumpTo(ctx context.Context, binDir string, spec pgtool.DumpSpec, out io.Writer) (stderrTail string, err error)
}
```

Add fields to `Core` (after `VersionForPgbin`):

```go
	// Import/export seams (all nil-safe). PgTool shells pg_dump/pg_restore;
	// DetectSourceMajor reads a running server's major (pgconn); EnsureMajorReady
	// pulls a supported-but-uninstalled major on demand (nil → only already-
	// installed majors are importable).
	PgTool           PgToolAPI
	DetectSourceMajor func(ctx context.Context, dsn string) (int, error)
	EnsureMajorReady func(ctx context.Context, major int) error

	// in-flight import cancels, keyed by project id — DeleteProject cancels a
	// running import's operation context (killing pg_restore) before draining.
	importMu      sync.Mutex
	importCancels map[string]context.CancelFunc
```

Add `"sync"` to the `core.go` import block.

- [ ] **Step 2: Write the import service (op kinds, redaction, registry, ImportFromServer)**

Create `internal/service/importexport.go`:

```go
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/pgtool"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Operation kinds for local import/export. Fail-forward on boot (P4-4): an
// interrupted import/export boots to failed; there is no mid-pg_restore resume.
const (
	OpImportDatabase = "import_database"
	OpExportBranch   = "export_branch"
)

// Supported source-major window. A source outside it is refused before any
// project is created (P4-9).
const (
	supportedMajorMin = 14
	supportedMajorMax = 17
)

// detectMajorTimeout bounds the synchronous source probe so an unreachable
// server refuses fast instead of hanging the request.
const detectMajorTimeout = 10 * time.Second

// ImportExportBootPolicies: both kinds fail forward at boot (P4-4).
func ImportExportBootPolicies() map[string]runtime.BootPolicy {
	return map[string]runtime.BootPolicy{
		OpImportDatabase: runtime.FailForwardOnBoot,
		OpExportBranch:   runtime.FailForwardOnBoot,
	}
}

type ImportServerParams struct {
	Name             string
	ConnectionString string
}

// JobRef is the 202 response body for an async import/export: the operation to
// poll plus the project/branch it targets.
type JobRef struct {
	JobID     string `json:"jobId"`
	ProjectID string `json:"projectId,omitempty"`
	BranchID  string `json:"branchId,omitempty"`
}

// JobView is the read model of an operation (the user-facing "job"). Params is
// the operation's params JSON decoded — always already redacted (P4-10).
type JobView struct {
	ID       string
	Kind     string
	TargetID string
	Phase    string
	Error    string
	Params   map[string]any
}

// JobChannel is the single SSE log-channel source for an operation, keyed by its
// STABLE target (project id for import, branch id for export) so the UI can
// subscribe before it learns the op id. Both the service (Ingest) and the API
// (Subscribe, T7) use this — one source of truth.
func JobChannel(kind, targetID string) string {
	switch kind {
	case OpExportBranch:
		return "job:" + targetID + ":export"
	default: // OpImportDatabase
		return "job:import:" + targetID
	}
}

// splitDSN separates a postgresql:// URL into a display-redacted form, a
// password-FREE form (for pg_dump/pg_restore argv), and the password (for
// PGPASSWORD). Non-URL keyword DSNs are rejected — the UI and this daemon's own
// connection strings are always URL-form (P4-10 keeps the password off argv).
func splitDSN(dsn string) (redacted, noPassword, password string, err error) {
	u, perr := url.Parse(dsn)
	if perr != nil || (u.Scheme != "postgresql" && u.Scheme != "postgres") {
		return "", "", "", Errf(400, "connection string must be a postgresql:// URL")
	}
	if u.Host == "" {
		return "", "", "", Errf(400, "connection string must include a host")
	}
	if pw, ok := u.User.Password(); ok {
		password = pw
	}
	user := u.User.Username()
	np := *u
	if user != "" {
		np.User = url.User(user)
	} else {
		np.User = nil
	}
	noPassword = np.String()
	rd := *u
	if password != "" {
		rd.User = url.UserPassword(user, "***")
	}
	redacted = rd.String()
	return redacted, noPassword, password, nil
}

// redactDSN is the display/log form — never persist or log a raw source DSN.
func redactDSN(dsn string) string {
	r, _, _, err := splitDSN(dsn)
	if err != nil {
		return "postgresql://***" // unparseable: never echo raw
	}
	return r
}

func (c *Core) setImportCancel(projectID string, cancel context.CancelFunc) {
	c.importMu.Lock()
	defer c.importMu.Unlock()
	if c.importCancels == nil {
		c.importCancels = map[string]context.CancelFunc{}
	}
	c.importCancels[projectID] = cancel
}

func (c *Core) clearImportCancel(projectID string) {
	c.importMu.Lock()
	defer c.importMu.Unlock()
	delete(c.importCancels, projectID)
}

// cancelImport aborts an in-flight import for a project (kills its pg_restore),
// if any. Called by DeleteProject BEFORE draining so the child is gone before
// teardown touches the branch's compute/slot.
func (c *Core) cancelImport(projectID string) {
	c.importMu.Lock()
	cancel := c.importCancels[projectID]
	c.importMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// ensureMajorReady refuses an out-of-range major (P4-9) and, for an in-range
// but uninstalled one, pulls it on demand (M3). Returns nil once the major is
// installed. Called both synchronously (range refusal, no side effects) and as
// the operation's first step (the pull).
func (c *Core) ensureMajorReady(ctx context.Context, major int) error {
	if major < supportedMajorMin || major > supportedMajorMax {
		return Errf(400,
			"source is PostgreSQL %d; Worktree DB supports %d–%d — import a source on a supported major",
			major, supportedMajorMin, supportedMajorMax)
	}
	for _, m := range c.InstalledMajors() {
		if m == major {
			return nil
		}
	}
	if c.EnsureMajorReady == nil {
		return Errf(400, "PostgreSQL %d is not installed — pull it via POST /api/pg-builds/pull, then re-import", major)
	}
	return c.EnsureMajorReady(ctx, major)
}

// ImportFromServer imports a running server into a NEW project on the source's
// major. It detects the major and refuses an out-of-range one SYNCHRONOUSLY (no
// project created — P4-9/§8.3), then runs the long pull/create/start/restore on
// a detached, cancelable operation (P4-4 fail-forward), returning 202 material.
func (c *Core) ImportFromServer(ctx context.Context, p ImportServerParams) (JobRef, error) {
	if err := ValidateProjectName(p.Name); err != nil {
		return JobRef{}, err
	}
	if _, exists, err := c.Store.ProjectByName(ctx, p.Name); err != nil {
		return JobRef{}, err
	} else if exists {
		return JobRef{}, Errf(409, `project "%s" already exists — choose a different name`, p.Name)
	}
	redacted, noPassword, password, err := splitDSN(p.ConnectionString)
	if err != nil {
		return JobRef{}, err
	}
	// Detect the source major synchronously (bounded) so an out-of-range or
	// unreachable source refuses before anything is created.
	major, err := c.detectSourceMajor(ctx, p.ConnectionString)
	if err != nil {
		return JobRef{}, err
	}
	if major < supportedMajorMin || major > supportedMajorMax {
		return JobRef{}, Errf(400,
			"source is PostgreSQL %d; Worktree DB supports %d–%d", major, supportedMajorMin, supportedMajorMax)
	}

	projectID := store.NewID()
	params, _ := json.Marshal(map[string]any{
		"kind": "import_database", "source": "server", "project_id": projectID,
		"name": p.Name, "major": major, "source_dsn": redacted,
	})
	steps := c.importSteps(projectID, p.Name, major, noPassword, password, "" /* no file */, nil)
	opID, err := c.Store.CreateOperation(ctx, OpImportDatabase, projectID, string(params), runtime.PlanFingerprint(steps))
	if err != nil {
		return JobRef{}, err
	}
	c.runImport(projectID, opID, steps)
	return JobRef{JobID: opID, ProjectID: projectID}, nil
}

// detectSourceMajor bounds the probe and delegates to the injected detector
// (pgconn in production; a fake in tests). A nil detector is a wiring bug.
func (c *Core) detectSourceMajor(ctx context.Context, dsn string) (int, error) {
	if c.DetectSourceMajor == nil {
		return 0, Errf(500, "source-major detection is not wired")
	}
	dctx, cancel := context.WithTimeout(ctx, detectMajorTimeout)
	defer cancel()
	major, err := c.DetectSourceMajor(dctx, dsn)
	if err != nil {
		return 0, Errf(502, "could not connect to the source server: %s", firstImportLine(err))
	}
	return major, nil
}

// runImport spawns the detached, cancelable operation goroutine and registers
// its cancel so DeleteProject can abort it. Mirrors builds.Pull's fire-and-
// forget-on-daemon-lifetime shape.
func (c *Core) runImport(projectID, opID string, steps []runtime.Step) {
	opCtx, cancel := context.WithCancel(context.Background())
	c.setImportCancel(projectID, cancel)
	go func() {
		defer c.clearImportCancel(projectID)
		defer cancel()
		if runErr := runtime.RunOperation(opCtx, c.Store, opID, 0, steps); runErr != nil {
			c.Log.Error("import failed", "op", opID, "project", projectID, "err", runErr)
		}
		c.Bus.Publish("operation.updated", projectID, "")
	}()
}
```

- [ ] **Step 3: Add the import step list (shared by server + file sources)**

Append to `internal/service/importexport.go`. The step list is shared: `filePath`/`fileReader` distinguish file-upload (T5) from running-server (this task passes them empty/nil). Each step fans progress onto the job channel and updates project status; a step error is surfaced by `RunOperation` and folded into the project's failed status by the goroutine's compensation.

```go
// importSteps is the durable plan for both import fronts. For running-server,
// noPassword/password are the SOURCE dsn parts and fileReader is nil (the
// restore pipes pg_dump). For file-upload, header+fileReader carry the archive
// bytes and noPassword/password are empty (the restore reads the file).
func (c *Core) importSteps(projectID, name string, major int, srcNoPassword, srcPassword string, _ string, fileReader *importFile) []runtime.Step {
	var mainID string
	// Progress fans onto the project-stable job channel so the UI can attach
	// before it learns the op id (JobChannel is the one source of truth).
	log := func(line string) { c.Hub.Ingest(JobChannel(OpImportDatabase, projectID), line) }
	return []runtime.Step{
		{Name: "ensure_build", Do: func(ctx context.Context) error {
			log(fmt.Sprintf("ensuring PostgreSQL %d is installed", major))
			if err := c.ensureMajorReady(ctx, major); err != nil {
				return err
			}
			return nil
		}},
		{Name: "create_project", Do: func(ctx context.Context) error {
			log(fmt.Sprintf("creating project %q on PostgreSQL %d", name, major))
			_, main, err := c.createProjectWithID(ctx, projectID, name, major, "importing")
			if err != nil {
				return err
			}
			mainID = main.Row.ID
			return nil
		}},
		{Name: "start_endpoint", Do: func(ctx context.Context) error {
			log("starting the target endpoint")
			_, err := c.StartEndpoint(ctx, mainID)
			return err
		}},
		{Name: "restore", Do: func(ctx context.Context) error {
			return c.runRestore(ctx, projectID, mainID, major, srcNoPassword, srcPassword, fileReader, log)
		}},
		{Name: "finalize", Do: func(ctx context.Context) error {
			if err := c.Store.SetProjectStatus(ctx, projectID, "ready", nil); err != nil {
				return err
			}
			log("import complete")
			c.Bus.Publish("operation.updated", projectID, mainID)
			return nil
		}},
	}
}

// importFile carries the peeked header prefix plus the remaining body reader for
// a file-upload restore (T5). nil for running-server import.
type importFile struct {
	header []byte
	body   interface{ Read([]byte) (int, error) } // io.Reader; interface avoids an import here
}

// runRestore performs the streaming restore into the branch's postgres DB. For
// running-server it pipes pg_dump|pg_restore; for file-upload it feeds the
// MultiReader(header, body) into pg_restore. On failure it records the stderr
// tail on the project (P4-4: the project is left failed + informative).
func (c *Core) runRestore(ctx context.Context, projectID, mainID string, major int, srcNoPassword, srcPassword string, file *importFile, log func(string)) error {
	binDir, err := c.PgbinFor(major)
	if err != nil {
		return err
	}
	detail, err := c.BranchDetail(ctx, mainID)
	if err != nil {
		return err
	}
	if detail.Row.StatusPort == nil {
		return Errf(500, "import target endpoint has no port")
	}
	_, tgtNoPassword, tgtPassword, err := splitDSN(ConnectionString(detail.Row.Password, *detail.Row.StatusPort))
	if err != nil {
		return err
	}
	restore := pgtool.RestoreSpec{DSN: tgtNoPassword, Password: tgtPassword, Sink: log}
	var tail string
	if file != nil {
		restore.In = multiReader(file.header, file.body)
		tail, err = c.PgTool.Restore(ctx, binDir, restore)
	} else {
		dump := pgtool.DumpSpec{DSN: srcNoPassword, Password: srcPassword}
		tail, err = c.PgTool.Pipe(ctx, binDir, dump, restore)
	}
	if err != nil {
		if serr := c.Store.SetProjectStatus(ctx, projectID, "failed", ptrOrNil(tail)); serr != nil {
			c.Log.Error("recording import failure status", "project", projectID, "err", serr)
		}
		c.Bus.Publish("operation.updated", projectID, mainID)
		return fmt.Errorf("restore failed: %w", err)
	}
	return nil
}

func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func firstImportLine(err error) string {
	msg := err.Error()
	for i := 0; i < len(msg); i++ {
		if msg[i] == '\n' {
			return msg[:i]
		}
	}
	return msg
}
```

Add one helper referenced above to `importexport.go`: `func multiReader(header []byte, body io.Reader) io.Reader { return io.MultiReader(bytes.NewReader(header), body) }` (add `bytes` + `io` to the file's imports; `importFile.body` is an `io.Reader`). Channel model: the service ingests to `JobChannel(kind, targetID)` and the T7 SSE route resolves the operation then subscribes to the SAME `JobChannel(op.Kind, op.TargetID)` — one helper, no second lookup table. (Imports grow across steps as the code references them — `net/url`/`time` land with `splitDSN`/timeouts, `bytes`/`io` with `multiReader`, `github.com/jackc/pgx/v5/pgconn` with `DetectServerMajor` in Step 7; run `gofmt`/goimports after each step.)

- [ ] **Step 4: Refactor `createProject` to accept an id + status, and add the abort hook**

In `internal/service/projects.go`, change `createProject` to delegate, and add `createProjectWithID` + `ValidateProjectName` (exported so the import path can pre-validate the name). Replace the existing `createProject` body:

```go
// createProject is the public-create shortcut: fresh id, ready status.
func (c *Core) createProject(ctx context.Context, name string, major int) (store.ProjectRow, BranchDetail, error) {
	return c.createProjectWithID(ctx, store.NewID(), name, major, "ready")
}

// createProjectWithID is the shared create body with a caller-supplied project
// id and initial status phase. Import supplies the id it returned at 202 and
// "importing"; public create supplies a fresh id and "ready".
func (c *Core) createProjectWithID(ctx context.Context, projectID, name string, major int, statusPhase string) (store.ProjectRow, BranchDetail, error) {
	if _, exists, err := c.Store.ProjectByName(ctx, name); err != nil {
		return store.ProjectRow{}, BranchDetail{}, err
	} else if exists {
		return store.ProjectRow{}, BranchDetail{}, Errf(409,
			`project "%s" already exists — choose a different name, or use the existing project (call list_projects to see it)`, name)
	}
	if err := c.Storcon.TenantCreate(ctx, projectID, engine.DefaultTenantConfig); err != nil {
		return store.ProjectRow{}, BranchDetail{}, err
	}
	row, main, err := c.seedProjectRows(ctx, projectID, name, major, statusPhase)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), compensationTimeout)
		defer cancel()
		if cerr := c.Pageserver.TenantDelete(cleanupCtx, projectID); cerr != nil {
			c.Log.Error("compensation failed — orphaned tenant on pageserver", "tenant", projectID, "err", cerr)
		}
		if cerr := c.Safekeeper.TenantDelete(cleanupCtx, projectID); cerr != nil {
			c.Log.Error("compensation failed — orphaned tenant on safekeeper", "tenant", projectID, "err", cerr)
		}
		return store.ProjectRow{}, BranchDetail{}, err
	}
	c.RegisterBranchOwner(main.ID)
	detail, derr := c.detailOf(ctx, main)
	if derr != nil {
		c.Log.Error("project create: detail enrichment failed after commit — returning the unenriched row",
			"project", projectID, "branch", main.ID, "err", derr)
		detail = BranchDetail{Row: main}
	}
	c.Bus.Publish("project.created", projectID, "")
	return row, detail, nil
}

// ValidateProjectName applies the public name rule (reused by import).
func ValidateProjectName(name string) error {
	if !projectNameRe.MatchString(strings.TrimSpace(name)) {
		return Errf(400,
			"invalid project name: %q — names must start with a letter or digit and contain only letters, digits, spaces, underscores, or hyphens (max 63 characters)", name)
	}
	return nil
}
```

Update `seedProjectRows`'s signature + the projects INSERT to carry the status phase:

```go
func (c *Core) seedProjectRows(ctx context.Context, projectID, name string, major int, statusPhase string) (store.ProjectRow, store.BranchRow, error) {
```
and inside its transaction, change the projects INSERT to:
```go
			if _, err := tx.Exec(
				`INSERT INTO projects (id, name, pg_major, tenant_id, created_at, status_phase) VALUES (?,?,?,?,?,?)`,
				projectID, name, major, projectID, now, statusPhase); err != nil {
				return err
			}
```
and set `project := store.ProjectRow{ID: projectID, Name: name, PgMajor: major, TenantID: projectID, CreatedAt: now, StatusPhase: statusPhase}`.

Add the abort hook at the very top of `DeleteProject` (before `projectOr404`):

```go
func (c *Core) DeleteProject(ctx context.Context, id string) error {
	// Abort an in-flight import first: cancel its operation context so the
	// pg_restore child is gone before the drain touches the branch's compute
	// and slot (delete-the-project IS the import abort — no separate cancel).
	c.cancelImport(id)
	project, err := c.projectOr404(ctx, id)
	// ... unchanged body ...
```

- [ ] **Step 5: Add the `Job` read model**

Append to `internal/service/importexport.go`:

```go
// Job reads an operation as the user-facing job (get_job / GET operation). The
// params are decoded as-is — they were stored already-redacted.
func (c *Core) Job(ctx context.Context, id string) (JobView, error) {
	op, ok, err := c.Store.OperationByID(ctx, id)
	if err != nil {
		return JobView{}, err
	}
	if !ok {
		return JobView{}, Errf(404, "job %s not found", id)
	}
	var params map[string]any
	if op.Params != "" {
		_ = json.Unmarshal([]byte(op.Params), &params)
	}
	return JobView{ID: op.ID, Kind: op.Kind, TargetID: op.TargetID, Phase: op.Phase, Error: op.Error, Params: params}, nil
}
```

- [ ] **Step 6: Wire `main` (boot policies, stale-import sweep, PgTool + detectors)**

In `cmd/worktreedbd/main.go`:

(a) Merge the import/export boot policies into the resume map (next to the timetravel + builds merge):

```go
	policies := service.TimetravelBootPolicies()
	for kind, p := range builds.BootPolicies() {
		policies[kind] = p
	}
	for kind, p := range service.ImportExportBootPolicies() {
		policies[kind] = p
	}
```

(b) Right after `ResetEndpointsOnBoot` (boot reconciliation step 2), add the stale-import sweep:

```go
	if n, err := st.FailStaleImports(ctx); err != nil {
		sup.Stop()
		removeLock()
		return err
	} else if n > 0 {
		log.Info("boot: failed interrupted imports", "count", n)
	}
```

(c) In the `core := &service.Core{...}` literal, wire the three seams (after `VersionForPgbin`):

```go
		PgTool:            pgToolAdapter{},
		DetectSourceMajor: service.DetectServerMajor,
		EnsureMajorReady: func(ctx context.Context, major int) error {
			return buildsSvc.EnsureMajorReady(ctx, major)
		},
```

Add the tiny production adapter near the bottom of `main.go` (it constructs a `pgtool.Tools` per binDir call):

```go
// pgToolAdapter adapts the per-binDir PgToolAPI to pgtool.Tools instances.
type pgToolAdapter struct{}

func (pgToolAdapter) Pipe(ctx context.Context, binDir string, dump pgtool.DumpSpec, restore pgtool.RestoreSpec) (string, error) {
	return pgtool.Tools{Dir: binDir}.Pipe(ctx, dump, restore)
}
func (pgToolAdapter) Restore(ctx context.Context, binDir string, spec pgtool.RestoreSpec) (string, error) {
	return pgtool.Tools{Dir: binDir}.Restore(ctx, spec)
}
func (pgToolAdapter) DumpTo(ctx context.Context, binDir string, spec pgtool.DumpSpec, out io.Writer) (string, error) {
	return pgtool.Tools{Dir: binDir}.DumpTo(ctx, spec, out)
}
```

Add `"io"` and the `pgtool` import to `main.go`. Two new seams referenced above must exist: `service.DetectServerMajor(ctx, dsn) (int, error)` (add to `importexport.go` — a pgconn query, code in Step 7) and `builds.Service.EnsureMajorReady(ctx, major) error` (add to `internal/builds/service.go` — Step 8).

- [ ] **Step 7: Add `DetectServerMajor` (pgconn) to the service**

Append to `internal/service/importexport.go` (imports `github.com/jackc/pgx/v5/pgconn`):

```go
// DetectServerMajor connects to a source server and reads its major version via
// server_version_num (e.g. 160004 -> 16). Used as the production DetectSourceMajor.
func DetectServerMajor(ctx context.Context, dsn string) (int, error) {
	cfg, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return 0, err
	}
	cfg.ConnectTimeout = 8 * time.Second
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		return 0, err
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = conn.Close(cctx)
	}()
	res, err := conn.Exec(ctx, "SHOW server_version_num").ReadAll()
	if err != nil || len(res) == 0 || len(res[0].Rows) == 0 {
		return 0, fmt.Errorf("could not read server_version_num")
	}
	num := string(res[0].Rows[0][0])
	var n int
	if _, err := fmt.Sscanf(num, "%d", &n); err != nil {
		return 0, fmt.Errorf("unexpected server_version_num %q", num)
	}
	return n / 10000, nil // 160004 -> 16 (single-number major since PG 10)
}
```

- [ ] **Step 8: Add `builds.Service.EnsureMajorReady` (pull-on-demand + wait)**

In `internal/builds/service.go`, add a method that triggers a pull (single-flight; if one is already running for this major it waits on it) and polls until the major has a ready build or a terminal failure. It reuses `Pull` and `InstalledMajors`:

```go
// EnsureMajorReady pulls a major on demand and blocks until it is installed
// (a ready row) or the pull fails. If the major is already installed it returns
// immediately. Bounded by ctx — import runs this as a durable operation step,
// so a daemon shutdown mid-pull fails the import forward on the next boot.
func (s *Service) EnsureMajorReady(ctx context.Context, major int) error {
	for _, m := range s.InstalledMajors(ctx) {
		if m == major {
			return nil
		}
	}
	if _, err := s.Pull(ctx, major, "latest"); err != nil {
		// A concurrent pull already in progress is not fatal — fall through to
		// the poll, which observes that pull's outcome.
		var serr *service.Error
		if !(errorsAs(err, &serr) && serr.Status == 409) {
			return err
		}
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		for _, m := range s.InstalledMajors(ctx) {
			if m == major {
				return nil
			}
		}
		// A downloaded row for this major that ended failed means the pull we
		// are waiting on gave up — surface it rather than spin forever.
		rows, err := s.o.Store.PgBuildsByMajor(ctx, major)
		if err != nil {
			return err
		}
		anyActive := false
		for _, r := range rows {
			switch r.Status {
			case "downloading", "validating":
				anyActive = true
			}
		}
		if !anyActive {
			return service.Errf(502, "could not install PostgreSQL %d — pull did not produce a ready build", major)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
```

Add `"errors"` to the file if not present and a tiny local `errorsAs` alias, OR just use `errors.As` inline (the file already imports several stdlib packages — prefer `errors.As` directly and drop the `errorsAs` alias). Confirm `time` is imported (it is).

- [ ] **Step 9: Add the `fakePgTool` + import tests**

In `internal/service/fakes_test.go`, add a controllable fake:

```go
type fakePgTool struct {
	mu          sync.Mutex
	restoreErr  error
	restoreTail string
	pipeErr     error
	pipeTail    string
	dumpErr     error
	dumpBytes   []byte
	calls       []string
}

func (f *fakePgTool) Pipe(ctx context.Context, binDir string, dump pgtool.DumpSpec, restore pgtool.RestoreSpec) (string, error) {
	f.mu.Lock()
	f.calls = append(f.calls, "pipe:"+binDir)
	f.mu.Unlock()
	if restore.Sink != nil {
		restore.Sink("pg_restore: restoring")
	}
	return f.pipeTail, f.pipeErr
}
func (f *fakePgTool) Restore(ctx context.Context, binDir string, spec pgtool.RestoreSpec) (string, error) {
	// Drain In so the multipart pipe (T5) is consumed like the real child would.
	if spec.In != nil {
		_, _ = io.Copy(io.Discard, spec.In)
	}
	f.mu.Lock()
	f.calls = append(f.calls, "restore:"+binDir)
	f.mu.Unlock()
	return f.restoreTail, f.restoreErr
}
func (f *fakePgTool) DumpTo(ctx context.Context, binDir string, spec pgtool.DumpSpec, out io.Writer) (string, error) {
	_, _ = out.Write(f.dumpBytes)
	f.mu.Lock()
	f.calls = append(f.calls, "dump:"+binDir)
	f.mu.Unlock()
	return "", f.dumpErr
}
```

(Add `io` + the `pgtool` import to `fakes_test.go`.) In `internal/service/importexport_test.go`, use the existing `newTestCore(t)` harness (it wires fake storcon/pageserver/proxy/compute + owners) and set the new seams on `tc.core`. A representative happy-path + a failure-honesty test:

```go
package service

import (
	"context"
	"testing"
	"time"
)

func TestImportFromServerHappyPath(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	pt := &fakePgTool{}
	tc.core.PgTool = pt
	tc.core.DetectSourceMajor = func(context.Context, string) (int, error) { return 17, nil }
	// major 17 is "installed" in the fake InstalledMajors the harness wires.

	ref, err := tc.core.ImportFromServer(ctx, ImportServerParams{
		Name: "imported", ConnectionString: "postgresql://u:secret@host:5432/db",
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if ref.JobID == "" || ref.ProjectID == "" {
		t.Fatalf("job ref = %+v", ref)
	}
	// Poll the durable op to done (the goroutine runs detached).
	waitOpPhase(t, tc, ref.JobID, "done")
	// Project exists and is ready; the pipe was called once.
	p, err := tc.core.ProjectByIDOr404(ctx, ref.ProjectID)
	if err != nil || p.StatusPhase != "ready" {
		t.Fatalf("project after import = %+v err=%v", p, err)
	}
	if len(pt.calls) == 0 || pt.calls[len(pt.calls)-1][:4] != "pipe" {
		t.Fatalf("expected a pipe restore, calls = %v", pt.calls)
	}
	// The source password must NOT appear in the operation params.
	job, _ := tc.core.Job(ctx, ref.JobID)
	if dsn, _ := job.Params["source_dsn"].(string); dsn == "" || contains(dsn, "secret") {
		t.Fatalf("source_dsn not redacted: %q", dsn)
	}
}

func TestImportRefusesOutOfRangeMajorNoProject(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.core.PgTool = &fakePgTool{}
	tc.core.DetectSourceMajor = func(context.Context, string) (int, error) { return 13, nil }
	_, err := tc.core.ImportFromServer(ctx, ImportServerParams{
		Name: "old", ConnectionString: "postgresql://u:p@host:5432/db",
	})
	if err == nil {
		t.Fatal("PG 13 source must be refused")
	}
	// No project was created.
	if _, ok, _ := tc.core.Store.ProjectByName(ctx, "old"); ok {
		t.Fatal("an out-of-range refusal must not leave a project")
	}
}

func TestImportRestoreFailureLandsProjectFailed(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.core.PgTool = &fakePgTool{pipeErr: errString("pg_restore: error: relation exists"), pipeTail: "pg_restore: error: relation exists"}
	tc.core.DetectSourceMajor = func(context.Context, string) (int, error) { return 17, nil }
	ref, err := tc.core.ImportFromServer(ctx, ImportServerParams{
		Name: "boom", ConnectionString: "postgresql://u:p@host:5432/db",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitOpPhase(t, tc, ref.JobID, "failed")
	p, _ := tc.core.ProjectByIDOr404(ctx, ref.ProjectID)
	if p.StatusPhase != "failed" || p.StatusMessage == nil || !contains(*p.StatusMessage, "relation exists") {
		t.Fatalf("failed import must record the stderr tail on the project: %+v", p)
	}
}

// waitOpPhase polls an operation until it reaches phase (or the deadline).
func waitOpPhase(t *testing.T, tc *testCore, opID, phase string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if op, ok, _ := tc.core.Store.OperationByID(context.Background(), opID); ok && op.Phase == phase {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("operation %s never reached phase %q", opID, phase)
}
```

(Reuse or add the tiny `contains` / `errString` test helpers if the package lacks them — `strings.Contains` and a `type errString string` implementing `error` are fine; if the harness already exposes equivalents, use those. `newTestCore` must wire `InstalledMajors` to include 17 — it already does via the fakes; if not, set `tc.core.InstalledMajors = func() []int { return []int{14,15,16,17} }` at the top of each test.)

- [ ] **Step 10: Run the service tests + `-race`**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestImport' -count=1`
Expected: **PASS**.

Run: `cd ~/git/worktreedb && go test ./internal/service/ ./internal/builds/ -race -count=1 && go build ./... && go vet ./... && golangci-lint run`
Expected: green build/vet/lint and no races.

- [ ] **Step 11: Commit**

```bash
cd ~/git/worktreedb && git add internal/service/importexport.go internal/service/importexport_test.go internal/service/core.go internal/service/projects.go internal/service/fakes_test.go internal/builds/service.go cmd/worktreedbd/main.go
git commit -m "feat(service): running-server import as a durable operation with delete-abort"
```

---

### Task 5: Import from an uploaded file — multipart streamed into pg_restore

The second import front, sharing the T4 core: a synchronous path that reads the uploaded `-Fc` file, peeks its header to detect the major, then restores from `MultiReader(header, body)` — the body never buffered whole to disk (P4-6). This task adds `ImportFromFile` to the service; the multipart REST handler that calls it is T7.

**Files:**
- Modify: `internal/service/importexport.go`, `internal/service/importexport_test.go`

**Interfaces:**
- Consumes: the T4 `importSteps`/`createProjectWithID`/`ensureMajorReady`/`runRestore`; `pgtool.ArchiveMajor` (T3).
- Produces (consumed by T7):
  - `const importHeaderPeek = 8192` — bytes peeked for archive-header major detection.
  - `type ImportFileParams struct { Name string; Header []byte; Body io.Reader }`.
  - `func (c *Core) ImportFromFile(ctx, p ImportFileParams) (JobRef, error)` — SYNCHRONOUS (returns after the restore completes/fails); still records a durable operation. The caller (the multipart handler) has already read `importHeaderPeek` bytes into `p.Header` and passes the rest as `p.Body`.

- [ ] **Step 1: Write the failing test**

Add to `internal/service/importexport_test.go`:

```go
func TestImportFromFileHappyPath(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.core.PgTool = &fakePgTool{}
	// A synthetic -Fc header for major 16 (helper mirrors the pgtool test's).
	header := fakeCustomHeaderSvc(t, "16.4")
	ref, err := tc.core.ImportFromFile(ctx, ImportFileParams{
		Name: "fromfile", Header: header, Body: strings.NewReader("rest-of-archive"),
	})
	if err != nil {
		t.Fatalf("import file: %v", err)
	}
	// Synchronous: the op is already terminal.
	op, ok, _ := tc.core.Store.OperationByID(ctx, ref.JobID)
	if !ok || op.Phase != "done" {
		t.Fatalf("file import op = %+v ok=%v", op, ok)
	}
	p, _ := tc.core.ProjectByIDOr404(ctx, ref.ProjectID)
	if p.StatusPhase != "ready" {
		t.Fatalf("project status = %q", p.StatusPhase)
	}
}

func TestImportFromFileRejectsNonArchive(t *testing.T) {
	tc := newTestCore(t)
	_, err := tc.core.ImportFromFile(context.Background(), ImportFileParams{
		Name: "junk", Header: []byte("not a dump at all"), Body: strings.NewReader(""),
	})
	if err == nil {
		t.Fatal("a non-archive upload must be refused")
	}
}
```

(`fakeCustomHeaderSvc` is the same synthesizer as the pgtool test's `fakeCustomHeader`; copy it into the service test file — the two packages don't share test helpers. Keep major 16 installed via the harness's InstalledMajors.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestImportFromFile -count=1`
Expected: **FAIL to compile** — `ImportFromFile`/`ImportFileParams` undefined.

- [ ] **Step 3: Implement `ImportFromFile`**

Append to `internal/service/importexport.go`:

```go
const importHeaderPeek = 8192

type ImportFileParams struct {
	Name   string
	Header []byte    // the peeked archive-header prefix (up to importHeaderPeek)
	Body   io.Reader // the REST of the archive after Header
}

// ImportFromFile imports an uploaded pg_dump -Fc archive into a new project. It
// is SYNCHRONOUS: the request body is the byte source, so the restore must land
// within the request. Still records a durable operation (fail-forward on a
// mid-restore crash). The major is detected from the peeked header (P4-6: only
// the header is buffered; the body streams into pg_restore).
func (c *Core) ImportFromFile(ctx context.Context, p ImportFileParams) (JobRef, error) {
	if err := ValidateProjectName(p.Name); err != nil {
		return JobRef{}, err
	}
	if _, exists, err := c.Store.ProjectByName(ctx, p.Name); err != nil {
		return JobRef{}, err
	} else if exists {
		return JobRef{}, Errf(409, `project "%s" already exists — choose a different name`, p.Name)
	}
	major, err := pgtool.ArchiveMajor(p.Header)
	if err != nil {
		return JobRef{}, Errf(400, "not a valid pg_dump -Fc archive: %s", firstImportLine(err))
	}
	if major < supportedMajorMin || major > supportedMajorMax {
		return JobRef{}, Errf(400,
			"the dump was made by PostgreSQL %d; Worktree DB supports %d–%d", major, supportedMajorMin, supportedMajorMax)
	}

	projectID := store.NewID()
	params, _ := json.Marshal(map[string]any{
		"kind": "import_database", "source": "file", "project_id": projectID,
		"name": p.Name, "major": major,
	})
	file := &importFile{header: p.Header, body: p.Body}
	steps := c.importSteps(projectID, p.Name, major, "", "", "file", file)
	opID, err := c.Store.CreateOperation(ctx, OpImportDatabase, projectID, string(params), runtime.PlanFingerprint(steps))
	if err != nil {
		return JobRef{}, err
	}
	// Synchronous run + cancelable so a concurrent DeleteProject aborts it.
	opCtx, cancel := context.WithCancel(ctx)
	c.setImportCancel(projectID, cancel)
	defer c.clearImportCancel(projectID)
	defer cancel()
	if runErr := runtime.RunOperation(opCtx, c.Store, opID, 0, steps); runErr != nil {
		c.Log.Error("file import failed", "op", opID, "project", projectID, "err", runErr)
	}
	c.Bus.Publish("operation.updated", projectID, "")
	// Return the ref regardless of outcome; the caller reads the op's terminal
	// phase (done/failed) to shape the HTTP response.
	return JobRef{JobID: opID, ProjectID: projectID}, nil
}
```

Note: `importSteps` already branches on `fileReader != nil` in `runRestore` (T4) — a file import calls `PgTool.Restore` with `MultiReader(header, body)`, a server import calls `PgTool.Pipe`. No new step logic here.

- [ ] **Step 4: Run the tests (GREEN)**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestImportFromFile -count=1`
Expected: **PASS**.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service/importexport.go internal/service/importexport_test.go
git commit -m "feat(service): file-upload import streams the archive into pg_restore"
```

---

### Task 6: Export service — pg_dump a branch to a local artifact

Export a branch's data to `<DataDir>/exports/<project>-<branch>-<timestamp>.dump`, auto-starting/waking the endpoint, recording the artifact's byte size + the branch's LSN in the operation params, removing a partial artifact on failure. Async (202 + job), fail-forward.

**Files:**
- Modify: `internal/service/importexport.go`, `internal/service/importexport_test.go`, `internal/service/core.go` (Cfg already present — no change if `ExportsDir` read via `c.Cfg.ExportsDir`).

**Interfaces:**
- Consumes: `Core.EnsureRunning` (auto-start/wake); `Core.Pageserver.TimelineInfo` (LSN); `c.Cfg.ExportsDir` (T1); `PgTool.DumpTo` (T3); `store.UpdateOperationParams` (T2).
- Produces (consumed by T7/T8):
  - `func (c *Core) ExportBranch(ctx, branchID string) (JobRef, error)` — 202 material; the artifact + size + LSN land in the operation params at finalize.

- [ ] **Step 1: Write the failing test**

Add to `internal/service/importexport_test.go`:

```go
func TestExportBranchWritesArtifactAndRecordsSizeLSN(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.core.PgTool = &fakePgTool{dumpBytes: []byte("PGDMP-fake-archive-bytes")}
	tc.seedBranch(t, "p1", "b1") // harness: project+branch+owner; TimelineInfo returns an LSN

	ref, err := tc.core.ExportBranch(ctx, "b1")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	waitOpPhase(t, tc, ref.JobID, "done")
	job, _ := tc.core.Job(ctx, ref.JobID)
	path, _ := job.Params["artifact_path"].(string)
	if path == "" {
		t.Fatal("export must record artifact_path")
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Size() == 0 {
		t.Fatalf("artifact not written: %v", err)
	}
	if sz, _ := job.Params["size_bytes"].(float64); int64(sz) != fi.Size() {
		t.Fatalf("size_bytes %v != file size %d", job.Params["size_bytes"], fi.Size())
	}
	if _, ok := job.Params["lsn"]; !ok {
		t.Fatal("export must record the branch LSN")
	}
}
```

(The harness's fake pageserver `TimelineInfo` must return a non-nil `LastRecordLSN` — if `newTestCore`'s fake returns nil, set it in the test via the harness knob, or assert `lsn` is present-and-possibly-empty. Prefer wiring a concrete LSN in the fake for a meaningful assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestExportBranch -count=1`
Expected: **FAIL to compile** — `ExportBranch` undefined.

- [ ] **Step 3: Implement `ExportBranch`**

Append to `internal/service/importexport.go` (imports `os`, `path/filepath`, `strings`):

```go
// ExportBranch dumps a branch to a local .dump artifact. Async + fail-forward:
// it validates the branch synchronously, then runs EnsureRunning → pg_dump →
// record size/LSN on a detached operation. The dump connects through the
// branch's proxy slot, so it counts as a live connection and the idle sweeper
// will not suspend the endpoint mid-dump.
func (c *Core) ExportBranch(ctx context.Context, branchID string) (JobRef, error) {
	b, err := c.branchOr404(ctx, branchID)
	if err != nil {
		return JobRef{}, err
	}
	project, err := c.projectOr404(ctx, b.ProjectID)
	if err != nil {
		return JobRef{}, err
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	artifact := filepath.Join(c.Cfg.ExportsDir, fmt.Sprintf("%s-%s-%s.dump", Slugify(project.Name), Slugify(b.Slug), stamp))
	params, _ := json.Marshal(map[string]any{"kind": "export_branch", "branch_id": branchID, "artifact_path": artifact})
	steps := c.exportSteps(branchID, artifact)
	opID, err := c.Store.CreateOperation(ctx, OpExportBranch, branchID, string(params), runtime.PlanFingerprint(steps))
	if err != nil {
		return JobRef{}, err
	}
	go func() {
		opCtx := context.Background()
		if runErr := runtime.RunOperation(opCtx, c.Store, opID, 0, steps); runErr != nil {
			c.Log.Error("export failed", "op", opID, "branch", branchID, "err", runErr)
		}
		c.Bus.Publish("operation.updated", b.ProjectID, branchID)
	}()
	return JobRef{JobID: opID, BranchID: branchID}, nil
}

func (c *Core) exportSteps(branchID, artifact string) []runtime.Step {
	log := func(line string) { c.Hub.Ingest(JobChannel(OpExportBranch, branchID), line) }
	return []runtime.Step{
		{Name: "start_endpoint", Do: func(ctx context.Context) error {
			log("starting/waking the endpoint")
			_, err := c.EnsureRunning(ctx, branchID)
			return err
		}},
		{Name: "dump", Do: func(ctx context.Context) error {
			return c.runDump(ctx, branchID, artifact, log)
		}},
	}
}

// runDump resolves the branch's running install (so the dump tool matches the
// server version), streams pg_dump -Fc to the artifact, records size + the
// branch LSN, and cleans up a partial file on failure.
func (c *Core) runDump(ctx context.Context, branchID, artifact string, log func(string)) error {
	detail, err := c.BranchDetail(ctx, branchID)
	if err != nil {
		return err
	}
	if detail.Row.StatusPort == nil || detail.Row.StatusPgbin == nil {
		return Errf(500, "export target endpoint is not running")
	}
	if err := os.MkdirAll(c.Cfg.ExportsDir, 0o755); err != nil {
		return err
	}
	f, err := os.Create(artifact)
	if err != nil {
		return err
	}
	_, tgtNoPassword, tgtPassword, err := splitDSN(ConnectionString(detail.Row.Password, *detail.Row.StatusPort))
	if err != nil {
		_ = f.Close()
		_ = os.Remove(artifact)
		return err
	}
	binDir := *detail.Row.StatusPgbin // the exact install the running compute uses
	tail, dumpErr := c.PgTool.DumpTo(ctx, binDir, pgtool.DumpSpec{DSN: tgtNoPassword, Password: tgtPassword, Sink: log}, f)
	closeErr := f.Close()
	if dumpErr != nil || closeErr != nil {
		_ = os.Remove(artifact) // best-effort partial cleanup
		if dumpErr != nil {
			return fmt.Errorf("pg_dump failed: %s", strings.TrimSpace(tail))
		}
		return closeErr
	}
	fi, err := os.Stat(artifact)
	if err != nil {
		return err
	}
	lsn := ""
	if detail.LastRecordLsn != nil {
		lsn = *detail.LastRecordLsn
	}
	params, _ := json.Marshal(map[string]any{
		"kind": "export_branch", "branch_id": branchID,
		"artifact_path": artifact, "size_bytes": fi.Size(), "lsn": lsn,
	})
	op, err := c.currentExportOp(ctx, branchID, artifact)
	if err == nil && op != "" {
		if uerr := c.Store.UpdateOperationParams(ctx, op, string(params)); uerr != nil {
			c.Log.Error("recording export result params", "branch", branchID, "err", uerr)
		}
	}
	log(fmt.Sprintf("export complete — %d bytes at %s", fi.Size(), artifact))
	return nil
}

// currentExportOp finds the running export operation for this branch+artifact
// so runDump can write size/LSN back into its params. (The step closures do not
// carry the op id; this resolves it by kind+target+artifact.)
func (c *Core) currentExportOp(ctx context.Context, branchID, artifact string) (string, error) {
	ops, err := c.Store.OperationsByKind(ctx, OpExportBranch)
	if err != nil {
		return "", err
	}
	for i := len(ops) - 1; i >= 0; i-- {
		if ops[i].TargetID != branchID {
			continue
		}
		var p map[string]any
		_ = json.Unmarshal([]byte(ops[i].Params), &p)
		if ap, _ := p["artifact_path"].(string); ap == artifact {
			return ops[i].ID, nil
		}
	}
	return "", nil
}
```

Note the `job:<branchID>:export` channel keeps export progress separate from a branch's compute logs. T7's operation-SSE route maps an export operation to this channel.

- [ ] **Step 4: Run the tests + `-race`**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestExportBranch' -count=1 && go test ./internal/service/ -race -count=1`
Expected: **PASS**, no races.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service/importexport.go internal/service/importexport_test.go
git commit -m "feat(service): export a branch to a local .dump artifact with size + LSN"
```

---

### Task 7: REST surface — import (server + multipart), export, and operation reads

Expose the service over REST: running-server import (JSON → 202), file-upload import (multipart streamed → synchronous terminal result), export (→ 202), an operation read (`GET /api/operations/{id}`) and its SSE log tail, and the project DTO's new import status. One consistency cleanup lands here: a single `service.JobChannel` helper the service ingests to and the SSE route subscribes to.

**Files:**
- Modify: `internal/api/server.go`, `internal/api/dto.go`, `internal/api/routes_test.go`, `internal/service/importexport.go`

**Interfaces:**
- Consumes: the T4/T5/T6 service methods; `decodeBody`/`writeJSON`/`writeIssues`/`writeServiceError`/`logsSSE`/`sseStream` (existing).
- Produces (consumed by T8/T9):
  - `func JobChannel(kind, targetID string) string` (service) — the single SSE channel source: `"job:import:"+targetID` for import, `"job:"+targetID+":export"` for export.
  - REST: `POST /api/imports`, `POST /api/imports/file`, `POST /api/branches/{id}/export`, `GET /api/operations/{id}`, `GET /api/operations/{id}/logs`, `GET /api/operations?kind=…`.
  - DTOs: `jobDTO` (+ `toJobDTO`), `projectDTO.Status`/`.StatusMessage`.
  - `CoreAPI` widened with `ImportFromServer`, `ImportFromFile`, `ExportBranch`, `Job`, `JobsByKind`.

- [ ] **Step 1: Add `JobsByKind` to the service**

`JobChannel` already exists (T4). Add the history read to `internal/service/importexport.go`:

```go
// JobsByKind lists operations of a kind as JobViews (newest last) — the export
// history read.
func (c *Core) JobsByKind(ctx context.Context, kind string) ([]JobView, error) {
	ops, err := c.Store.OperationsByKind(ctx, kind)
	if err != nil {
		return nil, err
	}
	out := make([]JobView, 0, len(ops))
	for _, op := range ops {
		var params map[string]any
		if op.Params != "" {
			_ = json.Unmarshal([]byte(op.Params), &params)
		}
		out = append(out, JobView{ID: op.ID, Kind: op.Kind, TargetID: op.TargetID, Phase: op.Phase, Error: op.Error, Params: params})
	}
	return out, nil
}
```

- [ ] **Step 2: Write the failing route tests**

In `internal/api/routes_test.go`, extend `fakeCore` with the four new methods (canned) and add tests. The `fakeCore` gains fields `importRef service.JobRef`, `job service.JobView`, `importErr error` and methods:

```go
func (f *fakeCore) ImportFromServer(ctx context.Context, p service.ImportServerParams) (service.JobRef, error) {
	f.calls = append(f.calls, "import_server:"+p.Name)
	return f.importRef, f.importErr
}
func (f *fakeCore) ImportFromFile(ctx context.Context, p service.ImportFileParams) (service.JobRef, error) {
	// Drain the body like the real restore would, so the multipart pipe closes.
	if p.Body != nil {
		_, _ = io.Copy(io.Discard, p.Body)
	}
	f.calls = append(f.calls, fmt.Sprintf("import_file:%s:hdr=%d", p.Name, len(p.Header)))
	return f.importRef, f.importErr
}
func (f *fakeCore) ExportBranch(ctx context.Context, branchID string) (service.JobRef, error) {
	f.calls = append(f.calls, "export:"+branchID)
	return f.importRef, f.importErr
}
func (f *fakeCore) Job(ctx context.Context, id string) (service.JobView, error) {
	return f.job, f.err
}
func (f *fakeCore) JobsByKind(ctx context.Context, kind string) ([]service.JobView, error) {
	return []service.JobView{f.job}, nil
}
```

```go
func TestImportServerRoute(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), importRef: service.JobRef{JobID: "op1", ProjectID: "p9"}}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "POST", srv.URL+"/api/imports",
		`{"name":"imported","connectionString":"postgresql://u:p@host:5432/db"}`)
	if res.StatusCode != 202 || m["jobId"] != "op1" || m["projectId"] != "p9" {
		t.Fatalf("import = %d %v", res.StatusCode, m)
	}
	// Missing fields are the validation envelope.
	res, m = doJSON(t, "POST", srv.URL+"/api/imports", `{"name":"x"}`)
	if res.StatusCode != 400 || m["error"] != "invalid request body" {
		t.Fatalf("validation = %d %v", res.StatusCode, m)
	}
}

func TestImportFileRouteStreamsMultipart(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), importRef: service.JobRef{JobID: "op2", ProjectID: "p2"},
		job: service.JobView{ID: "op2", Kind: "import_database", Phase: "done"}}
	srv, _, _ := newTestServer(t, core)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("name", "fromfile")
	fw, _ := mw.CreateFormFile("file", "dump.dump")
	_, _ = fw.Write([]byte("PGDMP-archive-bytes"))
	_ = mw.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/api/imports/file", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 201 && res.StatusCode != 200 {
		t.Fatalf("file import status = %d", res.StatusCode)
	}
	// The handler must have fed the name + header bytes to the service.
	joined := strings.Join(core.calls, ",")
	if !strings.Contains(joined, "import_file:fromfile:hdr=") {
		t.Fatalf("file not streamed to service: %v", core.calls)
	}
}

func TestExportRoute(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), importRef: service.JobRef{JobID: "op3", BranchID: "b1"}}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "POST", srv.URL+"/api/branches/b1/export", "")
	if res.StatusCode != 202 || m["jobId"] != "op3" {
		t.Fatalf("export = %d %v", res.StatusCode, m)
	}
}

func TestGetOperationRedactsAndReports(t *testing.T) {
	core := &fakeCore{branch: sampleBranch(), job: service.JobView{
		ID: "op4", Kind: "import_database", TargetID: "p4", Phase: "failed",
		Error: "pg_restore: error: boom",
		Params: map[string]any{"source_dsn": "postgresql://u:***@host:5432/db"},
	}}
	srv, _, _ := newTestServer(t, core)
	res, m := doJSON(t, "GET", srv.URL+"/api/operations/op4", "")
	if res.StatusCode != 200 || m["phase"] != "failed" || m["error"] != "pg_restore: error: boom" {
		t.Fatalf("operation = %d %v", res.StatusCode, m)
	}
	params := m["params"].(map[string]any)
	if dsn := params["source_dsn"].(string); strings.Contains(dsn, "***") == false {
		t.Fatalf("params must stay redacted: %v", params)
	}
}
```

(Add `bytes`, `mime/multipart`, `io`, `strings` to the test file's imports if missing.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/api/ -run 'TestImport|TestExportRoute|TestGetOperation' -count=1`
Expected: **FAIL to compile** — routes + DTO + `CoreAPI` methods missing.

- [ ] **Step 4: Widen `CoreAPI` + add the DTOs**

In `internal/api/server.go`, add to the `CoreAPI` interface:

```go
	ImportFromServer(ctx context.Context, p service.ImportServerParams) (service.JobRef, error)
	ImportFromFile(ctx context.Context, p service.ImportFileParams) (service.JobRef, error)
	ExportBranch(ctx context.Context, branchID string) (service.JobRef, error)
	Job(ctx context.Context, id string) (service.JobView, error)
	JobsByKind(ctx context.Context, kind string) ([]service.JobView, error)
```

In `internal/api/dto.go`, add the job DTO + extend the project DTO:

```go
type jobDTO struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	TargetID string         `json:"targetId"`
	Phase    string         `json:"phase"`
	Error    *string        `json:"error"`
	Params   map[string]any `json:"params"`
}

func toJobDTO(j service.JobView) jobDTO {
	var errp *string
	if j.Error != "" {
		e := j.Error
		errp = &e
	}
	return jobDTO{ID: j.ID, Kind: j.Kind, TargetID: j.TargetID, Phase: j.Phase, Error: errp, Params: j.Params}
}
```

Extend `projectDTO` with `Status string \`json:"status"\`` and `StatusMessage *string \`json:"statusMessage"\``, and set them in `toProjectDTO`:

```go
	return projectDTO{ID: p.ID, Name: p.Name, PgVersion: p.PgMajor, CreatedAt: p.CreatedAt, UpdatedAt: p.CreatedAt,
		Status: p.StatusPhase, StatusMessage: p.StatusMessage}
```

- [ ] **Step 5: Add the routes**

In `internal/api/server.go` `NewServer`, register the routes (alongside the others; precedence is not order-dependent). Add `"io"` and `"mime/multipart"` to the file's imports if missing (`io` is already imported).

Running-server import (JSON → 202):

```go
	mux.HandleFunc("POST /api/imports", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name             *string `json:"name"`
			ConnectionString *string `json:"connectionString"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var issues []string
		if body.Name == nil {
			issues = append(issues, "name: Required")
		}
		if body.ConnectionString == nil {
			issues = append(issues, "connectionString: Required")
		}
		if len(issues) > 0 {
			writeIssues(w, issues)
			return
		}
		ref, err := d.Core.ImportFromServer(r.Context(), service.ImportServerParams{
			Name: *body.Name, ConnectionString: *body.ConnectionString,
		})
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 202, ref)
	})
```

File-upload import (multipart, streamed — NOT `decodeBody`; uses `r.MultipartReader` so the body is never buffered whole):

```go
	mux.HandleFunc("POST /api/imports/file", func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			writeError(w, 400, "expected a multipart/form-data body")
			return
		}
		name := ""
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				writeError(w, 400, "malformed multipart body")
				return
			}
			switch part.FormName() {
			case "name":
				buf, _ := io.ReadAll(io.LimitReader(part, 256))
				name = strings.TrimSpace(string(buf))
			case "file":
				if name == "" {
					writeError(w, 400, "the 'name' field must precede the 'file' field")
					return
				}
				// Peek the header for major detection; stream the rest into pg_restore.
				header := make([]byte, service.ImportHeaderPeek())
				n, _ := io.ReadFull(part, header)
				header = header[:n]
				ref, err := d.Core.ImportFromFile(r.Context(), service.ImportFileParams{
					Name: name, Header: header, Body: part,
				})
				if err != nil {
					writeServiceError(w, err)
					return
				}
				// Synchronous import: report the operation's terminal outcome.
				job, jerr := d.Core.Job(r.Context(), ref.JobID)
				if jerr != nil {
					writeJSON(w, 202, ref)
					return
				}
				code := 201
				if job.Phase == "failed" {
					code = 200 // the project is left failed + informative (P4-4)
				}
				writeJSON(w, code, map[string]any{"jobId": ref.JobID, "projectId": ref.ProjectID, "job": toJobDTO(job)})
				return
			}
		}
		writeIssues(w, []string{"file: Required"})
	})
```

Export (→ 202):

```go
	mux.HandleFunc("POST /api/branches/{id}/export", func(w http.ResponseWriter, r *http.Request) {
		ref, err := d.Core.ExportBranch(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 202, ref)
	})
```

Operation read + list + SSE:

```go
	mux.HandleFunc("GET /api/operations/{id}", func(w http.ResponseWriter, r *http.Request) {
		job, err := d.Core.Job(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toJobDTO(job))
	})

	mux.HandleFunc("GET /api/operations", func(w http.ResponseWriter, r *http.Request) {
		kind := r.URL.Query().Get("kind")
		if kind != service.OpImportDatabase && kind != service.OpExportBranch {
			writeError(w, 400, "kind must be import_database or export_branch")
			return
		}
		jobs, err := d.Core.JobsByKind(r.Context(), kind)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		out := make([]jobDTO, 0, len(jobs))
		for _, j := range jobs {
			out = append(out, toJobDTO(j))
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/operations/{id}/logs", func(w http.ResponseWriter, r *http.Request) {
		job, err := d.Core.Job(r.Context(), r.PathValue("id"))
		if err != nil {
			writeServiceError(w, err)
			return
		}
		logsSSE(w, r, d, service.JobChannel(job.Kind, job.TargetID))
	})
```

Add `service.ImportHeaderPeek()` to `importexport.go` (exposing the peek size to the API without exporting the const): `func ImportHeaderPeek() int { return importHeaderPeek }`.

- [ ] **Step 6: Run the API tests + full build**

Run: `cd ~/git/worktreedb && go test ./internal/api/ ./internal/service/ -count=1 && go build ./... && go vet ./... && golangci-lint run`
Expected: **PASS**, clean.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/api/server.go internal/api/dto.go internal/api/routes_test.go internal/service/importexport.go
git commit -m "feat(api): import (server + multipart) / export / operation REST surface"
```

---

### Task 8: MCP tools — import_database, export_branch, get_job

Add three agent-facing tools with the existing `sdk.AddTool` + `guardTool` pattern (file-upload is deliberately NOT an MCP tool — it is a browser affordance). Redaction holds: `Job.Params` is already redacted before it reaches the tool.

**Files:**
- Modify: `internal/mcp/tools_mutate.go`, `internal/mcp/tools_read.go`, `internal/mcp/tools_test.go`

**Interfaces:**
- Consumes: `d.Core` (the MCP `CoreAPI`); `textResult`/`errorResult`/`guardTool`/`contextLine`.
- Produces: tools `import_database`, `export_branch`, `get_job`; `CoreAPI` (mcp) widened with `ImportFromServer`, `ExportBranch`, `Job`.

- [ ] **Step 1: Write the failing tool tests**

In `internal/mcp/tools_test.go`, extend the fake core with the three methods (canned) and add:

```go
func TestImportDatabaseTool(t *testing.T) {
	fc := &fakeCore{ /* existing canned fields */ }
	fc.importRef = service.JobRef{JobID: "op1", ProjectID: "p1"}
	res := callTool(t, fc, "import_database", map[string]any{
		"name": "imported", "connection_string": "postgresql://u:p@host:5432/db",
	})
	if res.IsError {
		t.Fatalf("import tool errored: %s", textOf(res))
	}
	if !strings.Contains(textOf(res), "op1") {
		t.Fatalf("import result should name the job: %s", textOf(res))
	}
}

func TestExportBranchTool(t *testing.T) {
	fc := &fakeCore{project: sampleProject(), branchRow: sampleBranchRow()}
	fc.importRef = service.JobRef{JobID: "op2", BranchID: "b1"}
	res := callTool(t, fc, "export_branch", map[string]any{"project": "acme", "branch": "main"})
	if res.IsError || !strings.Contains(textOf(res), "op2") {
		t.Fatalf("export tool: %v %s", res.IsError, textOf(res))
	}
}

func TestGetJobTool(t *testing.T) {
	fc := &fakeCore{}
	fc.job = service.JobView{ID: "op3", Kind: "export_branch", Phase: "done",
		Params: map[string]any{"artifact_path": "/data/exports/x.dump", "size_bytes": float64(2048)}}
	res := callTool(t, fc, "get_job", map[string]any{"job_id": "op3"})
	if res.IsError || !strings.Contains(textOf(res), "done") || !strings.Contains(textOf(res), "x.dump") {
		t.Fatalf("get_job: %v %s", res.IsError, textOf(res))
	}
}
```

(Use the test file's existing `callTool`/`textOf` helpers and canned `sampleProject`/`sampleBranchRow`; add `importRef service.JobRef` / `job service.JobView` fields + the three methods to the fake core in this file.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -run 'TestImportDatabaseTool|TestExportBranchTool|TestGetJobTool' -count=1`
Expected: **FAIL to compile** — the tools + fake methods do not exist.

- [ ] **Step 3: Widen the MCP `CoreAPI`**

In `internal/mcp/tools_read.go`, add to the `CoreAPI` interface:

```go
	ImportFromServer(ctx context.Context, p service.ImportServerParams) (service.JobRef, error)
	ExportBranch(ctx context.Context, branchID string) (service.JobRef, error)
	Job(ctx context.Context, id string) (service.JobView, error)
```

- [ ] **Step 4: Add `get_job` (read tool)**

In `internal/mcp/tools_read.go`, inside `registerTools`, add:

```go
	type getJobIn struct {
		JobID string `json:"job_id"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "get_job",
		Description: "Check an import/export job's status. Returns the phase (pending/running/done/failed), any error, and result details (an export's artifact path + size).",
	}, guardTool("get_job", d, func(ctx context.Context, _ *sdk.CallToolRequest, in getJobIn) (*sdk.CallToolResult, error) {
		job, err := d.Core.Job(ctx, in.JobID)
		if err != nil {
			return nil, err
		}
		return textResult(renderJob(job)), nil
	}))
```

Add `renderJob` to `internal/mcp/format.go`:

```go
// renderJob formats an import/export job for an agent: phase, error, and the
// key result fields. Params are already redacted (no source credentials).
func renderJob(j service.JobView) string {
	s := fmt.Sprintf("[worktreedb] job %s (%s) — %s", j.ID, j.Kind, j.Phase)
	if j.Error != "" {
		s += "\nerror: " + j.Error
	}
	if path, ok := j.Params["artifact_path"].(string); ok && j.Kind == service.OpExportBranch {
		s += "\nartifact: " + path
		if sz, ok := j.Params["size_bytes"].(float64); ok {
			s += fmt.Sprintf(" (%d bytes)", int64(sz))
		}
	}
	if src, ok := j.Params["source_dsn"].(string); ok {
		s += "\nsource: " + src // already redacted
	}
	return s
}
```

- [ ] **Step 5: Add `import_database` + `export_branch` (mutate tools)**

In `internal/mcp/tools_mutate.go`, inside `registerMutateTools`, add:

```go
	type importDatabaseIn struct {
		Name             string `json:"name"`
		ConnectionString string `json:"connection_string"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "import_database",
		Description: "Import a running PostgreSQL server into a NEW Worktree DB project (point it at your dev DB). Returns a job id — poll get_job for progress. The new project's main branch becomes the imported data; branch it afterwards.",
	}, guardTool("import_database", d, func(ctx context.Context, _ *sdk.CallToolRequest, in importDatabaseIn) (*sdk.CallToolResult, error) {
		ref, err := d.Core.ImportFromServer(ctx, service.ImportServerParams{Name: in.Name, ConnectionString: in.ConnectionString})
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("[worktreedb] import started — job %s, project %s.\nNext: poll get_job(job_id=%q) until phase is done, then get_branch(project=%q, branch=\"main\").",
			ref.JobID, ref.ProjectID, ref.JobID, in.Name)), nil
	}))

	type exportBranchIn struct {
		Project string `json:"project"`
		Branch  string `json:"branch"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "export_branch",
		Description: "Export a branch's data to a local .dump file under /data/exports (auto-starts the endpoint). Returns a job id — poll get_job for the artifact path + size. The file is a standard pg_dump -Fc archive, restorable anywhere.",
	}, guardTool("export_branch", d, func(ctx context.Context, _ *sdk.CallToolRequest, in exportBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		ref, err := d.Core.ExportBranch(ctx, b.ID)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("%s\n[worktreedb] export started — job %s.\nNext: poll get_job(job_id=%q) for the artifact path.",
			contextLine(p.Name, b.Name, ""), ref.JobID, ref.JobID)), nil
	}))
```

- [ ] **Step 6: Run the MCP tests + full build**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -count=1 && go build ./... && go vet ./... && golangci-lint run`
Expected: **PASS**, clean.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add internal/mcp/tools_mutate.go internal/mcp/tools_read.go internal/mcp/format.go internal/mcp/tools_test.go
git commit -m "feat(mcp): import_database, export_branch, and get_job tools"
```

---

### Task 9: Web UI — import form (connstring + drag-drop), export action, job progress

Add the import entry point (a connection-string form AND a hand-rolled drag-drop for `.dump` files — no new dependency), an Export action on a branch, and live job progress via SSE. Replaces the Settings "Export targets" stub with a real card.

**Files:**
- Modify: `web/src/shared.ts`, `web/src/api/client.ts`, `web/src/api/hooks.ts`, `web/src/api/keys.ts`, `web/src/api/events.ts`, `web/src/pages/SettingsPage.tsx`, `web/src/tree/BranchActionsMenu.tsx`
- Create: `web/src/settings/ImportExportCard.tsx`, `web/src/drawer/JobProgress.tsx`

**Interfaces:**
- Consumes: the T7 REST surface; the existing `req` wrapper, `useApiMutation`, `startEvents`/`mapEventToKeys`, the `LogsTab` SSE idiom, `CreateProjectModal`'s form idiom.
- Produces: `api.imports`/`api.exports`/`api.jobs`; `useImportFromServer`/`useImportFile`/`useExportBranch`; `JobDto`/`JobKind`/`JobPhase`/`ProjectStatus` types; the `operation.updated` event.

- [ ] **Step 1: Extend `shared.ts` (enums, DTOs, event type)**

In `web/src/shared.ts`, add:

```ts
export const JobKindSchema = z.enum(["import_database", "export_branch"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobPhaseSchema = z.enum(["pending", "running", "done", "failed"]);
export type JobPhase = z.infer<typeof JobPhaseSchema>;

export const ProjectStatusSchema = z.enum(["ready", "importing", "failed"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export interface JobDto {
  id: string;
  kind: JobKind;
  targetId: string;
  phase: JobPhase;
  error: string | null;
  // Redacted params: import carries source_dsn (password masked); export carries
  // artifact_path/size_bytes/lsn.
  params: Record<string, unknown>;
}
```

Add `status: ProjectStatus` and `statusMessage: string | null` to `ProjectDto`. Add `"operation.updated"` to `WorktreedbEventTypeSchema`:

```ts
export const WorktreedbEventTypeSchema = z.enum([
  "project.created", "project.deleted",
  "branch.created", "branch.updated", "branch.deleted",
  "endpoint.status", "engine.health",
  "pg_builds",
  "operation.updated",
]);
```

- [ ] **Step 2: Add the API client methods (incl. the FormData upload)**

In `web/src/api/client.ts`, add groups. The FormData upload cannot use `req` (which forces JSON) — a dedicated `fetch` that lets the browser set the multipart boundary and replicates `req`'s ok/`ApiError` handling:

```ts
  imports: {
    fromServer: (b: { name: string; connectionString: string }) =>
      req<{ jobId: string; projectId: string }>("/api/imports", { method: "POST", body: JSON.stringify(b) }),
    fromFile: async (name: string, file: File): Promise<{ jobId: string; projectId: string; job: JobDto }> => {
      const fd = new FormData();
      fd.append("name", name);   // MUST precede the file (the server reads name first)
      fd.append("file", file);
      const res = await fetch("/api/imports/file", { method: "POST", body: fd }); // no content-type: browser sets boundary
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
      return body as { jobId: string; projectId: string; job: JobDto };
    },
  },
  exports: {
    start: (branchId: string) => req<{ jobId: string; branchId: string }>(`/api/branches/${branchId}/export`, { method: "POST" }),
    list: () => req<JobDto[]>("/api/operations?kind=export_branch"),
  },
  jobs: {
    get: (id: string) => req<JobDto>(`/api/operations/${id}`),
  },
```

(Import `JobDto` from `../shared` in client.ts.)

- [ ] **Step 3: Keys, hooks, and the event map**

In `web/src/api/keys.ts`, add `job: (id: string) => ["job", id] as const,` and `exports: ["exports"] as const,`.

In `web/src/api/hooks.ts`, add:

```ts
export function useImportFromServer() { return useApiMutation(api.imports.fromServer); }
export function useImportFile() { return useApiMutation((a: { name: string; file: File }) => api.imports.fromFile(a.name, a.file)); }
export function useExportBranch() { return useApiMutation(api.exports.start); }
export function useJob(id: string | null) {
  return useQuery({ queryKey: keys.job(id ?? ""), queryFn: () => api.jobs.get(id!), enabled: id !== null });
}
```

In `web/src/api/events.ts`, add a case to `mapEventToKeys`:

```ts
    case "operation.updated": {
      const out: QueryKey[] = [[...keys.projects], [...keys.allBranches], [...keys.exports]];
      if (e.branchId) out.push([...keys.branch(e.branchId)]);
      return out;
    }
```

- [ ] **Step 4: The import/export card (connstring form + hand-rolled drag-drop + progress)**

Create `web/src/settings/ImportExportCard.tsx`. The drag-drop is a native `<input type="file">` plus `onDragOver`/`onDrop` on a bordered `Box` — no `@mantine/dropzone` dependency:

```tsx
import { useRef, useState } from "react";
import { Alert, Box, Button, Card, Divider, Group, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { useImportFromServer, useImportFile, useJob } from "../api/hooks.js";
import { JobProgress } from "../drawer/JobProgress.js";
import { ApiError } from "../api/client.js";

export function ImportExportCard() {
  const importServer = useImportFromServer();
  const importFile = useImportFile();
  const [name, setName] = useState("");
  const [conn, setConn] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const job = useJob(activeJob);

  const doServer = () =>
    importServer.mutate({ name: name.trim(), connectionString: conn.trim() },
      { onSuccess: (r) => setActiveJob(r.jobId) });

  const doFile = (file: File) =>
    importFile.mutate({ name: name.trim(), file },
      { onSuccess: (r) => setActiveJob(r.jobId) });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) doFile(f);
  };

  return (
    <Card withBorder>
      <Title order={4}>Import a database</Title>
      <Divider my="xs" />
      <Stack gap="sm">
        <TextInput label="New project name" value={name} onChange={(e) => setName(e.currentTarget.value)}
          placeholder="my-imported-db" />

        <Text size="sm" fw={500}>From a running server</Text>
        <Group align="flex-end">
          <TextInput style={{ flex: 1 }} label="Connection string"
            placeholder="postgresql://user:password@host:5432/db"
            value={conn} onChange={(e) => setConn(e.currentTarget.value)} />
          <Button loading={importServer.isPending}
            disabled={name.trim() === "" || conn.trim() === ""} onClick={doServer}>Import</Button>
        </Group>

        <Text size="sm" fw={500}>From a .dump file</Text>
        <Box
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          style={{ border: `2px dashed var(--mantine-color-${dragging ? "blue" : "gray"}-5)`,
            borderRadius: 8, padding: 20, textAlign: "center", cursor: "pointer",
            opacity: name.trim() === "" ? 0.5 : 1 }}
        >
          <input ref={fileInput} type="file" accept=".dump" hidden
            disabled={name.trim() === ""}
            onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) doFile(f); }} />
          <Text size="sm" c="dimmed">
            {name.trim() === "" ? "Enter a project name first" : "Drop a pg_dump -Fc .dump file here, or click to choose"}
          </Text>
        </Box>
        {importFile.isPending && <Group gap="xs"><Loader size="xs" /><Text size="sm">restoring…</Text></Group>}

        {activeJob && job.data && (
          <Alert color={job.data.phase === "failed" ? "red" : job.data.phase === "done" ? "green" : "blue"}>
            Import {job.data.phase}{job.data.error ? `: ${job.data.error}` : ""}
          </Alert>
        )}
        {activeJob && <JobProgress jobId={activeJob} />}
      </Stack>
    </Card>
  );
}
```

Create `web/src/drawer/JobProgress.tsx` — the SSE progress log, cloned from `LogsTab`'s raw-EventSource idiom (JSON-per-line frames, capped buffer, teardown, injectable `makeSource`):

```tsx
import { useEffect, useState } from "react";
import { ScrollArea, Text } from "@mantine/core";

const MAX_LINES = 300;

export function JobProgress(a: { jobId: string; makeSource?: (url: string) => EventSource }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const make = a.makeSource ?? ((u: string) => new EventSource(u));
    const es = make(`/api/operations/${a.jobId}/logs`);
    es.onmessage = (m) => {
      try {
        const line: unknown = JSON.parse(m.data as string);
        if (typeof line === "string") setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), line]);
      } catch { /* non-JSON frame — ignore */ }
    };
    return () => es.close();
  }, [a.jobId, a.makeSource]);
  if (lines.length === 0) return null;
  return (
    <ScrollArea h={180} bg="dark.8" style={{ borderRadius: 6 }}>
      <div style={{ padding: 8 }}>
        {lines.map((l, i) => (
          <Text key={i} ff="monospace" size="xs" c="green.3" style={{ whiteSpace: "pre-wrap" }}>{l}</Text>
        ))}
      </div>
    </ScrollArea>
  );
}
```

- [ ] **Step 5: Mount the card + add the Export action**

In `web/src/pages/SettingsPage.tsx`, replace the disabled "Export targets" stub card with `<ImportExportCard />` (import it; keep the "Remote storage" stub as-is — that is the still-deferred cloud milestone).

In `web/src/tree/BranchActionsMenu.tsx`, add an Export item (uses `useExportBranch`) after "Copy connection string":

```tsx
        <Menu.Item onClick={() => exportBranch.mutate(b.id)}>Export database…</Menu.Item>
```

Declare the mutation at the top of the component: `const exportBranch = useExportBranch();` (import `useExportBranch` from `../api/hooks.js`). The export runs async; the user watches progress via the Settings card's job panel or a toast (the `useApiMutation` factory already toasts failures).

- [ ] **Step 6: Build + test the web app + clean-content check**

Run: `cd ~/git/worktreedb/web && pnpm build && pnpm test`
Expected: `tsc --noEmit` typechecks (new enums exhaustive; `ProjectDto.status` consumed) and `vite build` + `vitest run` pass.

Run: `grep -riE 'devdb|neond|fastify' ~/git/worktreedb/web/src/settings/ImportExportCard.tsx ~/git/worktreedb/web/src/drawer/JobProgress.tsx ~/git/worktreedb/web/src/shared.ts`
Expected: empty.

- [ ] **Step 7: Remove any generated dist, commit source only**

```bash
rm -rf ~/git/worktreedb/web/dist
git -C ~/git/worktreedb checkout web/dist/index.html 2>/dev/null || true
cd ~/git/worktreedb && git add web/src
git commit -m "feat(web): import form (connstring + drag-drop), export action, job progress"
```

---

### Task 10: Integration + delete-abort — prove it end-to-end

Container-level proof against `worktreedb:dev`: import a seeded sidecar Postgres, an export→import round-trip, an out-of-range refusal, and failure honesty; plus the deterministic delete-during-import cancel unit test. The image bakes all supported majors, so the real pull-on-demand path (§8.3 happy half) is unit-covered (T4's `ensureMajorReady`) — the integration suite covers the refusal half.

**Files:**
- Create: `integration/importexport_test.go`
- Modify: `internal/service/importexport_test.go` (the deterministic delete-abort unit test)

**Interfaces:**
- Consumes: `worktreedb:dev` (all prior tasks); the existing `image()`/`baseURL()`/`apiJSON()`/`sqlOn()`/`testHTTP` helpers (`//go:build integration`, `package integration`); `testcontainers-go` networks.

- [ ] **Step 1: Deterministic delete-during-import cancel (unit)**

In `internal/service/importexport_test.go`, add a test whose fake `Pipe` blocks until the operation context is cancelled, then call `DeleteProject` concurrently and assert the import operation lands failed and the cancel fired:

```go
func TestDeleteDuringImportCancels(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	started := make(chan string, 1) // receives the projectID once restore begins
	block := &blockingPgTool{started: started}
	tc.core.PgTool = block
	tc.core.DetectSourceMajor = func(context.Context, string) (int, error) { return 17, nil }

	ref, err := tc.core.ImportFromServer(ctx, ImportServerParams{
		Name: "abort", ConnectionString: "postgresql://u:p@host:5432/db",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Wait until the restore is in flight (Pipe is blocking on ctx), then delete.
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("restore never started")
	}
	if err := tc.core.DeleteProject(ctx, ref.ProjectID); err != nil {
		// A 404 is acceptable if the drain raced ahead; the import must still abort.
		t.Logf("delete returned: %v", err)
	}
	waitOpPhase(t, tc, ref.JobID, "failed") // the cancelled restore fails the op
}

// blockingPgTool.Pipe signals it started, then blocks until ctx is cancelled —
// modeling a long pg_restore that a delete aborts.
type blockingPgTool struct {
	started   chan string
	projectID string
}

func (b *blockingPgTool) Pipe(ctx context.Context, binDir string, _ pgtool.DumpSpec, _ pgtool.RestoreSpec) (string, error) {
	select { case b.started <- binDir: default: }
	<-ctx.Done()
	return "cancelled", ctx.Err()
}
func (b *blockingPgTool) Restore(ctx context.Context, _ string, _ pgtool.RestoreSpec) (string, error) { return "", nil }
func (b *blockingPgTool) DumpTo(ctx context.Context, _ string, _ pgtool.DumpSpec, _ io.Writer) (string, error) { return "", nil }
```

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestDeleteDuringImportCancels -race -count=1`
Expected: **PASS**, no races (the cancel registry + detached goroutine are the crux).

- [ ] **Step 2: Write the integration harness (shared network + seeded sidecar)**

Create `integration/importexport_test.go`:

```go
//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/network"
	"github.com/testcontainers/testcontainers-go/wait"
)

// importStack brings up a shared network, a seeded source Postgres reachable at
// alias "source-db", and a worktreedb container on the same network.
type importStack struct {
	wt      testcontainers.Container
	base    string
	srcTag  string // e.g. "postgres:16"
	srcConn string // in-network connstring the daemon dials: postgresql://postgres:pw@source-db:5432/appdb
}

func startImportStack(t *testing.T, srcImage, srcAlias string) importStack {
	t.Helper()
	ctx := context.Background()
	net, err := network.New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = net.Remove(ctx) })

	src, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:          srcImage,
			Env:            map[string]string{"POSTGRES_PASSWORD": "srcpw", "POSTGRES_DB": "appdb"},
			ExposedPorts:   []string{"5432/tcp"},
			Networks:       []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {srcAlias}},
			WaitingFor:     wait.ForListeningPort("5432/tcp").WithStartupTimeout(2 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = src.Terminate(context.Background()) })

	ports := []string{"4400/tcp"}
	for p := 54300; p <= 54309; p++ {
		ports = append(ports, fmt.Sprintf("%d/tcp", p))
	}
	wt, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        image(),
			Env:          map[string]string{"WORKTREEDB_PORT_RANGE": "54300-54309"},
			ExposedPorts: ports,
			Networks:     []string{net.Name},
			WaitingFor:   wait.ForHTTP("/api/status").WithPort("4400/tcp").WithStartupTimeout(3 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = wt.Terminate(context.Background()) })
	base, err := baseURL(ctx, wt)
	if err != nil {
		t.Fatal(err)
	}
	return importStack{
		wt: wt, base: base, srcTag: srcImage,
		srcConn: fmt.Sprintf("postgresql://postgres:srcpw@%s:5432/appdb", srcAlias),
	}
}

// seedSource connects to the source via its MAPPED host port and seeds a table.
func (s importStack) seedSource(t *testing.T, src testcontainers.Container, rows int) {
	t.Helper()
	ctx := context.Background()
	mapped, err := src.MappedPort(ctx, "5432/tcp")
	if err != nil {
		t.Fatal(err)
	}
	dsn := fmt.Sprintf("postgresql://postgres:srcpw@127.0.0.1:%s/appdb", mapped.Port())
	conn, err := pgconn.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "CREATE TABLE widgets (id int, label text)").ReadAll(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < rows; i++ {
		if _, err := conn.Exec(ctx, fmt.Sprintf("INSERT INTO widgets VALUES (%d, 'w%d')", i, i)).ReadAll(); err != nil {
			t.Fatal(err)
		}
	}
}

// pollJob polls GET /api/operations/{id} until phase is terminal, returning the job.
func pollJob(t *testing.T, base, jobID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		code, body := apiJSON(t, "GET", base+"/api/operations/"+jobID, "")
		if code == 200 {
			switch body["phase"] {
			case "done", "failed":
				return body
			}
		}
		time.Sleep(2 * time.Second)
	}
	t.Fatalf("job %s never terminated", jobID)
	return nil
}
```

- [ ] **Step 3: The running-server import test (§8.1)**

Add to `integration/importexport_test.go`. NOTE: use a **baked** source major so no pull is needed — the sidecar image is `postgres:16` (its `server_version_num` detects as 16, which the image bakes):

```go
func TestImportRunningServer(t *testing.T) {
	stack := startImportStack(t, "postgres:16", "source-db")
	// The seedSource needs the source container handle; re-fetch it from the
	// stack helper by starting it there — restructure startImportStack to also
	// return the source container if seeding is needed (return src alongside).
	// (Implementation note: return the *source* container from startImportStack.)
	// ... seed 5 rows ...

	code, created := apiJSON(t, "POST", stack.base+"/api/imports",
		fmt.Sprintf(`{"name":"imported","connectionString":%q}`, stack.srcConn))
	if code != 202 {
		t.Fatalf("import start = %d %v", code, created)
	}
	jobID := created["jobId"].(string)
	projectID := created["projectId"].(string)
	job := pollJob(t, stack.base, jobID)
	if job["phase"] != "done" {
		t.Fatalf("import did not succeed: %v", job)
	}
	// The new project's main endpoint serves the imported rows.
	code, branches := apiJSON(t, "GET", stack.base+"/api/projects/"+projectID+"/branches", "")
	if code != 200 {
		t.Fatalf("branches = %d", code)
	}
	var mainID string
	for _, b := range decodeArray(t, branches) {
		if b["name"] == "main" {
			mainID = b["id"].(string)
		}
	}
	got := sqlOn(t, stack.base, mainID, "SELECT count(*)::int AS n FROM widgets")
	if got["rows"].([]any)[0].(map[string]any)["n"] != float64(5) {
		t.Fatalf("imported row count wrong: %v", got)
	}
	// CoW holds: a child branch isolates writes on the imported data.
	code, br := apiJSON(t, "POST", stack.base+"/api/projects/"+projectID+"/branches", `{"name":"child"}`)
	if code != 201 {
		t.Fatalf("child branch = %d %v", code, br)
	}
	sqlOn(t, stack.base, br["id"].(string), "DELETE FROM widgets")
	if got := sqlOn(t, stack.base, mainID, "SELECT count(*)::int AS n FROM widgets"); got["rows"].([]any)[0].(map[string]any)["n"] != float64(5) {
		t.Fatal("parent must be isolated from the child's delete on imported data")
	}
}
```

(Add a small `decodeArray(t, m)` helper — the existing `apiJSON` returns a map; for an array response body use a variant that decodes `[]any`, or reuse the branching test's approach. If the helper set only has the map form, add an `apiArray` helper mirroring `apiJSON`. Restructure `startImportStack` to also return the source container so `seedSource` can run — the note above.)

- [ ] **Step 4: The export→import round-trip (§8.2)**

```go
func TestExportImportRoundTrip(t *testing.T) {
	// Import a seeded source to get a branch with data (reuses Step 3's flow),
	// OR create a project + seed via SQL. Here: create + seed directly.
	c, base := startBranchingContainer(t)
	code, created := apiJSON(t, "POST", base+"/api/projects", `{"name":"rt"}`)
	if code != 201 {
		t.Fatal(code)
	}
	mainID := created["mainBranch"].(map[string]any)["id"].(string)
	sqlOn(t, base, mainID, "CREATE TABLE t (n int)")
	for i := 0; i < 50; i++ {
		sqlOn(t, base, mainID, fmt.Sprintf("INSERT INTO t VALUES (%d)", i))
	}
	// Export.
	code, ex := apiJSON(t, "POST", base+"/api/branches/"+mainID+"/export", "")
	if code != 202 {
		t.Fatalf("export = %d %v", code, ex)
	}
	job := pollJob(t, base, ex["jobId"].(string))
	if job["phase"] != "done" {
		t.Fatalf("export failed: %v", job)
	}
	params := job["params"].(map[string]any)
	artifact := params["artifact_path"].(string)
	if params["sizeBytes"] == nil && params["size_bytes"] == nil {
		t.Fatalf("export must record a size: %v", params)
	}
	// Copy the artifact bytes out of the container.
	rc, err := c.CopyFileFromContainer(context.Background(), artifact)
	if err != nil {
		t.Fatal(err)
	}
	dump, _ := io.ReadAll(rc)
	_ = rc.Close()
	// Import the artifact as a file into a fresh project.
	status, resp := postMultipart(t, base+"/api/imports/file", "roundtrip", dump)
	if status != 201 && status != 200 {
		t.Fatalf("file import = %d %v", status, resp)
	}
	newProject := resp["projectId"].(string)
	code, branches := apiJSON(t, "GET", base+"/api/projects/"+newProject+"/branches", "")
	if code != 200 {
		t.Fatal(code)
	}
	var mid string
	for _, b := range decodeArray(t, branches) {
		if b["name"] == "main" {
			mid = b["id"].(string)
		}
	}
	got := sqlOn(t, base, mid, "SELECT count(*)::int AS n FROM t")
	if got["rows"].([]any)[0].(map[string]any)["n"] != float64(50) {
		t.Fatalf("round-tripped data mismatch: %v", got)
	}
}

// postMultipart POSTs a name field + a .dump file to url.
func postMultipart(t *testing.T, url, name string, file []byte) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("name", name)
	fw, _ := mw.CreateFormFile("file", "artifact.dump")
	_, _ = fw.Write(file)
	_ = mw.Close()
	req, _ := http.NewRequest("POST", url, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := testHTTP.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return res.StatusCode, m
}
```

- [ ] **Step 5: Out-of-range refusal (§8.3) + failure honesty (§8.4)**

```go
func TestImportOutOfRangeMajorRefused(t *testing.T) {
	stack := startImportStack(t, "postgres:13", "old-db")
	code, body := apiJSON(t, "POST", stack.base+"/api/imports",
		fmt.Sprintf(`{"name":"legacy","connectionString":%q}`, stack.srcConn))
	if code != 400 {
		t.Fatalf("PG 13 import must refuse with 400, got %d %v", code, body)
	}
	// No partial project.
	code, projects := apiJSON(t, "GET", stack.base+"/api/projects", "")
	if code == 200 {
		for _, p := range decodeArray(t, projects) {
			if p["name"] == "legacy" {
				t.Fatal("a refused import must leave no project")
			}
		}
	}
}

func TestImportFailureHonesty(t *testing.T) {
	// Produce a real artifact, truncate it past the header, file-import it: the
	// restore fails and the project lands 'failed' with a non-empty error.
	c, base := startBranchingContainer(t)
	code, created := apiJSON(t, "POST", base+"/api/projects", `{"name":"src"}`)
	if code != 201 {
		t.Fatal(code)
	}
	mainID := created["mainBranch"].(map[string]any)["id"].(string)
	sqlOn(t, base, mainID, "CREATE TABLE big (n int, pad text)")
	for i := 0; i < 200; i++ {
		sqlOn(t, base, mainID, fmt.Sprintf("INSERT INTO big VALUES (%d, repeat('x',200))", i))
	}
	code, ex := apiJSON(t, "POST", base+"/api/branches/"+mainID+"/export", "")
	if code != 202 {
		t.Fatal(code)
	}
	job := pollJob(t, base, ex["jobId"].(string))
	artifact := job["params"].(map[string]any)["artifact_path"].(string)
	rc, err := c.CopyFileFromContainer(context.Background(), artifact)
	if err != nil {
		t.Fatal(err)
	}
	full, _ := io.ReadAll(rc)
	_ = rc.Close()
	if len(full) < 5000 {
		t.Fatalf("dump too small to truncate meaningfully (%d bytes)", len(full))
	}
	truncated := full[:4096] // valid header, corrupt body -> restore fails

	status, resp := postMultipart(t, base+"/api/imports/file", "broken", truncated)
	// Synchronous file import reports the terminal (failed) job.
	if status != 200 && status != 201 {
		t.Fatalf("file import status = %d %v", status, resp)
	}
	projectID := resp["projectId"].(string)
	code, proj := apiJSON(t, "GET", base+"/api/projects/"+projectID, "")
	if code != 200 || proj["status"] != "failed" || proj["statusMessage"] == nil || proj["statusMessage"].(string) == "" {
		t.Fatalf("a broken restore must leave the project failed with a stderr tail: %d %v", code, proj)
	}
	// Re-import the FULL artifact into a fresh project succeeds.
	status, ok := postMultipart(t, base+"/api/imports/file", "fixed", full)
	if status != 201 && status != 200 {
		t.Fatalf("re-import = %d %v", status, ok)
	}
}
```

- [ ] **Step 6: Build the image and run the integration suite**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
go test -tags integration ./integration/ -run 'TestImport|TestExport' -count=1 -timeout 30m -v
```
Expected: **PASS** — running-server import serves the data with CoW isolation; the round-trip matches; PG 13 refuses with no project; the truncated restore lands the project failed with a stderr tail and the full re-import succeeds.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add integration/importexport_test.go internal/service/importexport_test.go
git commit -m "test(integration): sidecar import, round-trip, refusal, failure honesty + delete-abort"
```

---

### Task 11: Docs + acceptance record

Document import/export in the worktreedb repo (README/AGENTS, no trailer) and record the Phase-4 acceptance + no-regression result in the devdb workshop (with trailer).

**Files:**
- Modify (worktreedb): `README.md`, `AGENTS.md`
- Modify (devdb): `~/git/devdb/docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md`, `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`

- [ ] **Step 1: README — import/export section + config row**

In `~/git/worktreedb/README.md`, add a section after the branching/endpoints description:

```markdown
### Import & export (local)

Bring an existing database in, or take a branch's data out — all on the local
`/data` volume.

- **Import from a running server:** `POST /api/imports` with `{ "name", "connectionString" }`
  (or MCP `import_database`) creates a new project on the source's PostgreSQL
  major, bootstraps an empty `main`, and restores the source into it via
  `pg_dump | pg_restore`. A source major outside 14–17 is refused before anything
  is created. Returns a job id — poll `GET /api/operations/{id}` (or MCP `get_job`).
- **Import from a `.dump` file:** `POST /api/imports/file` (multipart) or the web
  drag-drop — the uploaded `pg_dump -Fc` archive streams straight into
  `pg_restore` (never buffered to disk).
- **Export a branch:** `POST /api/branches/{id}/export` (or MCP `export_branch`)
  writes a `pg_dump -Fc` artifact to `/data/exports/<project>-<branch>-<ts>.dump`,
  auto-starting the endpoint, and records the artifact size + branch LSN on the job.

Import/export are durable operations with a live SSE progress log
(`GET /api/operations/{id}/logs`); a failure keeps the pg_restore/pg_dump stderr
tail so you can see why. Deleting an importing project aborts the import.
Source credentials are never logged or persisted (redacted everywhere).
Cloud/bucket destinations are a separate later milestone.
```

Add a Configuration-table row:

```markdown
| exports dir | `<data>/exports` | where `.dump` export artifacts are written (derived from the data dir) |
```

- [ ] **Step 2: AGENTS — a note in the architecture paragraph**

In `~/git/worktreedb/AGENTS.md`, extend the architecture paragraph:

```markdown
Local import/export ride the durable operations log: import creates a new project
on the source's major (pulling the build on demand) and restores via a streaming
`pg_dump`/`pg_restore` core (`internal/pgtool`); export dumps a branch to a
`/data/exports` artifact. Both stream (no whole-dump disk buffering), redact
source credentials, and fail forward on restart; deleting an importing project
cancels the in-flight restore.
```

- [ ] **Step 3: Clean-history check (worktreedb docs)**

Run: `grep -riE 'devdb|neond|matisiekpl|typescript|fastify' ~/git/worktreedb/README.md ~/git/worktreedb/AGENTS.md | grep -v neondatabase`
Expected: empty.

- [ ] **Step 4: Commit the worktreedb docs (no trailer)**

```bash
cd ~/git/worktreedb && git add README.md AGENTS.md
git commit -m "docs: describe local import and export"
```

- [ ] **Step 5: Record acceptance + no-regression (devdb, with trailer)**

In `~/git/devdb/docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md`, append an acceptance-record note at the end recording the delivered result (fill the summary once the gates run):

```markdown
---

## Delivered (acceptance record)

Implemented per `docs/superpowers/plans/2026-07-13-worktreedb-phase4-import-export.md`
(worktreedb, local/unpushed). Acceptance 2026-07-XX:
- `go build`/`vet`/`test ./... -race` + golangci 0; Go integration green
  (sidecar-Postgres import, export→import round-trip, out-of-range refusal,
  failure honesty, delete-abort).
- The full 16-file reference parity suite stayed green vs `worktreedb:dev`
  (import/export are user-triggered and never enter the parity gate — no D8-style
  injection needed, unlike M5). <record the run summary>.
- Deferred (recorded): cloud/bucket durability (the whole back half — S3/Azure,
  continuous backup, recover-from-bucket, bucket-artifact import); export-artifact
  GC/retention + API delete; import into an existing branch; multi-database
  computes; mid-pg_restore resume; non-URL (keyword) source DSNs.
```

In `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`, append a short Phase-4 no-regression line (import/export do not enter the parity gate; the same 16 files stay green, assertions unmodified).

- [ ] **Step 6: Commit the devdb record (with trailer)**

```bash
cd ~/git/devdb && git add docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md
git commit -m "docs(phase4): record import/export acceptance + no-regression

Records the delivered local import/export milestone (worktreedb, unpushed) and
the full reference parity suite staying green (import/export never enter the gate).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Milestone acceptance (spec §8)

1. **Import a running server → new project.** A seeded sidecar Postgres imported via connstring appears as a new project whose `main` endpoint serves the imported table + rows; a child branch isolates writes (CoW on imported data). — `integration/importexport_test.go::TestImportRunningServer`.
2. **Round-trip.** Export a branch → a local `.dump` (size + LSN recorded) → file-import it into a fresh project → data matches. — `TestExportImportRoundTrip`.
3. **Major handling.** A supported-but-uninstalled major pulls then succeeds (unit: `ensureMajorReady` → `EnsureMajorReady`; all majors are baked in the image, so the real network pull is unit-covered); an out-of-range major refuses cleanly with **no partial project**. — `TestImportOutOfRangeMajorRefused` + `TestImportRefusesOutOfRangeMajorNoProject`.
4. **Failure honesty.** A broken restore lands the project `failed` with a non-empty stderr tail surfaced via the API; re-import after fixing succeeds. — `TestImportFailureHonesty` + `TestImportRestoreFailureLandsProjectFailed`.
5. **Surfaces.** MCP `import_database`/`export_branch`/`get_job` work; the web import form + drag-drop + export action drive the same operations with live SSE progress. — `internal/mcp/tools_test.go`, `web` build/test.
6. **No regression.** `go build`/`vet`/`test ./... -race` + golangci clean; Go integration green; **the full 16-file reference parity suite stays green** — import/export are additive and user-triggered, never entering the parity gate (no D8-style injection needed).
7. **Credential discipline (P4-10).** The source connstring/password is redacted in `operations.params`, every DTO, all logs, and SSE; the password reaches `pg_dump` only via `PGPASSWORD`. — asserted in `TestImportFromServerHappyPath` (no `secret` in params) and `TestGetOperationRedactsAndReports`.
8. **Clean history + frozen deps.** `git log --format=%B <base>..HEAD | grep -iE 'devdb|neond|typescript|fastify|co-authored'` empty; `grep -riE 'devdb|neond|typescript|fastify' --include='*.go' --include='*.md' .` empty except the sanctioned `// oracle: neon TimelineCreateRequestMode::Bootstrap` citation; `go.mod`/`go.sum` unchanged vs `<base>`; `web/package.json` gained no dependency.

## Deferred out of Phase 4 (recorded, deliberate — spec §6/§9)

- **All cloud/bucket durability** — S3/Azure export destinations, continuous pageserver `remote_storage`-to-bucket + safekeeper WAL backup, `state.db` upload loop + boot-restore, destroy-volume/recover-from-bucket, bucket-artifact import (source kind 3), the `none|s3|azure` mode + all-in-sync badge, the S3 lease/two-host-safety question. This is the whole back half of durability and its own later milestone.
- **Export-artifact GC/retention + API delete** — artifacts persist under `/data/exports`; the operator manages the directory (listable via `GET /api/operations?kind=export_branch`).
- **No mid-`pg_restore` resume** (P4-4), **no import into an existing branch** (P4-3), **no multi-database computes** (P4-5), **no schema transformation / anonymization** (a downstream consumer, later).
- **Non-URL (keyword) source DSNs** — the source connection string must be a `postgresql://` URL (the UI and this daemon's own strings are URL-form); keyword `host=… password=…` DSNs are out of scope this milestone (P4-10 keeps the password off argv via a parsed URL).
- **No new dependency** — multipart, piping, and the header parse are all stdlib; `go.mod` and `web/package.json` are untouched.

## Self-review (spec coverage)

Every P4 decision + acceptance item maps to a task: **P4-1** (local only, cloud deferred) — Deferred section + T11; **P4-2** (both sources, one core) — T3 `Pipe`/`Restore` + T4/T5; **P4-3** (new project) — T4 `createProjectWithID`; **P4-4** (fail-forward, no resume) — T4 `ImportExportBootPolicies`, T2 `FailStaleImports`; **P4-5** (restore into `postgres`) — T4 `runRestore` targets the branch's `postgres` DSN; **P4-6** (streaming) — T3 `io.Pipe`/`DumpTo`, T5 header-peek; **P4-7** (REST+MCP+UI) — T7/T8/T9; **P4-8** (durable operations, SSE, stderr tail) — T2/T3/T4/T6/T7; **P4-9** (major detect/ensure/refuse) — T4 `ensureMajorReady` + `DetectServerMajor` + T3 `ArchiveMajor`; **P4-10** (credentials) — T4 `redactDSN`/`splitDSN` + `PGPASSWORD` threaded through T3/T4/T6/T7/T8. Acceptance §8.1–§8.6 map to T10 (+ unit tests in T4/T5/T6). The §10 open questions are answered: export dir/naming (T1/T6), multipart streaming shape (T5/T7), archive-header detection (T3 `ArchiveMajor`), step list + compensation (T4/T5/T6), export-honors-suspend (T6 `EnsureRunning` wakes), redaction points (P4-10 thread), delete-during-import (T4 cancel registry + T10), and terminology (operation/`get_job`).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-worktreedb-phase4-import-export.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two gates per task (independent reviewer + review-broker scan; severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` into the worktree). Implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — never on main. Every worktreedb implementer/fix dispatch carries the **no-AI-trailer + clean-history + frozen-go.mod** rules verbatim (the one sanctioned exception is the `// oracle: neon TimelineCreateRequestMode::Bootstrap` citation import reuses). T11's devdb-repo steps run in `~/git/devdb` with devdb conventions (trailer kept). T3 (the exec core) and T4 (import + delete-abort) are the concurrency crux — their `-race` tests are part of the gate, not optional.

**2. Inline Execution** — superpowers:executing-plans, batch execution with checkpoints.

**Which approach?**
