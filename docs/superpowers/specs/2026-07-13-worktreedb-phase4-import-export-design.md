# Worktree DB Phase 4 — Import / Export (local) — Design

> Approved design for the first half of the Go rewrite's phase-4 work. Executed
> via SDD in the `worktreedb` repo (two gates per task); this spec + its plan +
> the progress ledger live workshop-side in `devdb`.

**Goal:** Bring an existing Postgres database *into* Worktree DB and take a
branch's data back *out*, entirely on the local `/data` volume — the dogfooding
unlock (`worktree : files :: branch : data` only lands once your real data is in
it). Cloud durability (S3/Azure) is deliberately **not** in this milestone.

**Foundation it rides:** the durable **operations log** (master spec §5 — step
cursor, plan fingerprint, per-branch owner lane, compensation), the **M3 dynamic
PG builds** (pull the source's major on demand), and the clean **bootstrap-vs-CoW
timeline seam** the engine already exposes. Shells out to the bundled
`pg_dump`/`pg_restore` client binaries — **no new module dependency expected.**

---

## 1. Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| P4-1 | Milestone scope | **Import + export to/from LOCAL disk only.** Cloud durability (S3/Azure continuous backup + recover-from-bucket + bucket-artifact import) is a **separate later milestone.** | Local import/export is the entire dogfooding need; the `/data` volume already persists. Cloud is disaster-recovery, separable and heavier. |
| P4-2 | Import sources | **Both** a **running server** (connection string) and an **uploaded `pg_dump -Fc` file** (multipart), over one shared `pg_restore` core. | Running-server is "point it at my dev DB"; file-import closes the symmetry with export (export emits the files import consumes). |
| P4-3 | Import target | Import creates a **new project** whose `main` branch *is* the imported data. | Matches "bring my DB in, then branch it." No overwrite-an-existing-branch path this milestone. |
| P4-4 | Interruption policy | **Fail-forward + re-import** (no mid-`pg_restore` resume). An interrupted import lands `failed`; the user deletes + re-imports. | `pg_restore` is not cleanly step-resumable; re-import is cheap and honest. Keeps the resume-steps-rebuilder stub stubbed for these kinds. |
| P4-5 | Restore target DB | Restore into the branch's single **`postgres`** database. | Computes are single-database today; a source DB's name doesn't create a second DB. |
| P4-6 | Streaming | Never buffer a whole dump to disk. Running-server = piped `pg_dump \| pg_restore`; file-upload = the multipart body streamed into `pg_restore` stdin. | Dumps are large; disk-buffering doubles I/O + space. |
| P4-7 | Surface | **REST + MCP + web UI**, all this milestone. | A dogfooding import wants a form/drag-drop, not only curl/MCP; agents want the MCP tools. |
| P4-8 | Job model | Import/export are **durable `operations` rows** (`kind: import_database` / `export_branch`) with an SSE job-log channel + terminal status + **stderr tail preserved on failure**. No resurrected TS `jobs` table. | The master spec's "on the operations-log foundation" is literal; the Go rewrite never carried the TS `jobs`/`export_targets` tables. |
| P4-9 | Major handling | Detect the source's PG **major**; create the project on **that major** (M3 pulls the build if it isn't live). A source major outside the supported v14–v17 range, or an unpullable one, **refuses with guidance** before any data moves. | Same-major restore is the faithful, safe path and reuses the existing build machinery + the storcon foreign-major guard posture. |
| P4-10 | Credential handling | The source connection string / password is a **transient operation parameter** — never logged, never persisted in cleartext (redacted in `operations.params` and every DTO/log, reusing the phase-2 redaction). | It's a live credential to another system. |

---

## 2. Model — import and export as durable operations

Both are `operations` rows (master spec §5), created and driven inside the target
branch's **owner lane** exactly as timetravel restore/reset are:

- `kind`: `import_database` | `export_branch`; `target_id`: the branch id;
  `params`: the operation's inputs (**redacted** — no cleartext credentials);
  `plan_fingerprint`: sha256 of the ordered step names.
- Progress streams on the existing **SSE log/event bus**, on a per-operation
  channel (mirrors the compute/pull log channels): the child process's
  stdout/stderr is fanned in line-by-line.
- **Status surfacing (additive):** an import target's branch shows
  `importing → ready | failed`; an export shows `exporting → ready | failed` on
  the operation, not the branch (export doesn't change branch state). On failure
  the **stderr tail is retained** (in the operation row's `error`, capped) so the
  UI/MCP can show *why* a restore/dump failed.
- **Boot policy = fail-forward** (`FailForwardOnBoot`) for both kinds: an import
  or export interrupted by a restart boots to `failed` ("interrupted by
  restart"). The currently-stubbed resume steps-rebuilder in `main.go` stays a
  no-op for these kinds — P4-4 is a deliberate non-use of resume.

**Compensation on failure/interrupt.** A failed *import* leaves its project
visible in `failed` state **with the stderr tail** (informative — the user reads
the error, then deletes + re-imports); no silent auto-drop. A failed *export*
removes its partial artifact file (best-effort) and marks the operation `failed`.

---

## 3. Import

One `pg_restore` core, two front doors, one flow.

### 3.1 The flow (both sources)
1. **Detect the source major.** Running server: `SELECT server_version_num` (or
   the `version()` string). Uploaded file: read the `-Fc` archive header
   (`pg_restore -l`/the custom-format header carries the dumping server version).
2. **Guard the major (P4-9).** If the major is outside v14–v17, refuse with
   guidance ("source is PG N; Worktree DB supports 14–17") **before** creating
   anything. Otherwise ensure that major's build is live — reuse M3's builds
   (pull-on-demand); if it can't be made available, refuse.
3. **Create the project + `main`** on that major (projects service), status
   `importing`. `main`'s timeline is **bootstrap** (empty, initdb-fresh) —
   `// oracle: neon TimelineCreateRequestMode::Bootstrap` — *not* an ancestor
   branch.
4. **Start `main`'s endpoint** (the compute + proxy slot, via the existing start
   lane), so there's a live target to restore into.
5. **Restore** into the endpoint's `postgres` DB (§3.2/§3.3), streaming.
6. **Finalize:** `importing → ready` on success; on failure `importing → failed`
   + stderr tail.

The restore step is the long, non-idempotent one (P4-4 fail-forward).

### 3.2 Source A — running server
`pg_dump -Fc "<source-connstring>" | pg_restore --dbname="<branch-postgres-dsn>"`,
wired as a Go pipe (one process's stdout → the other's stdin, no temp file).
`host.docker.internal` reaches a Postgres on the operator's machine. The source
credential is passed to `pg_dump` out-of-band (env/`.pgpass`-style), never on a
logged argv and never persisted (P4-10).

### 3.3 Source B — uploaded file
A **multipart** REST endpoint streams the request body (a `pg_dump -Fc` file)
directly into `pg_restore --dbname="<branch-postgres-dsn>"` stdin via an
`io.Pipe` — the dump is **never** written to `/data` in full (P4-6). Same restore
core as §3.2; only the byte source differs (an HTTP body reader vs a `pg_dump`
child).

### 3.4 What import does *not* do
No import into a pre-existing branch (P4-3 — new project only); no multi-database
mapping (P4-5); no schema/owner rewriting; no anonymization (that's the
downstream anonymizer riding this pipeline later).

---

## 4. Export

`pg_dump -Fc "<branch-postgres-dsn>"` from the target branch's endpoint —
**auto-starting it if stopped or suspended** (the start lane exists; suspended
endpoints already wake) — streamed to a **local artifact** under
`/data/exports/<project>-<branch>-<timestamp>.dump` (path/retention finalized in
the plan). The operation records the artifact's **byte size** and the branch's
**LSN** at dump time. The artifact is a standard custom-format dump — exactly
what §3.3 file-import consumes, and restorable by any stock `pg_restore`.

**Destinations this milestone: local file only.** S3 multipart / Azure block
blob are deferred with the cloud-durability milestone (they need the same net-new
cloud wiring).

---

## 5. Surface

- **REST:** `POST` import-from-server (connstring in a JSON body → 202 + a job/
  operation id); `POST` import-from-file (**multipart**, streamed); `POST`
  export (branch id + options → 202 + operation id); the operation/job status is
  read via the existing operation surface + the SSE log channel.
- **MCP:** `import_database` (server connstring), `export_branch`, and a
  job-status read tool, added to the existing tool surface with the same
  fail-closed guard. (File-upload import is **not** an MCP tool — it's a browser/
  multipart affordance, matching the product spec.)
- **Web UI:** an **import** entry point (a connection-string form **and** a
  drag-drop for `.dump` files), an **export** button on a branch, and live job
  progress via the SSE channel. Additive to the existing tree/drawer UI.

---

## 6. Scope boundaries

**In:** import (running server + uploaded file), export (local file), the
durable-operation + SSE-job plumbing for them, major-detect + build-ensure,
REST + MCP + UI, docs.

**Out (→ the later cloud-durability milestone):** S3/Azure export destinations;
continuous pageserver `remote_storage`-to-bucket + safekeeper WAL backup;
`state.db` upload loop + boot-restore; destroy-volume/recover-from-bucket;
bucket-artifact import (source kind 3); the `none|s3|azure` mode + the
"all-in-sync" checkpoint badge; the S3 lease/two-host-safety question.

**Out (this milestone, by choice):** mid-`pg_restore` resume (P4-4); import into
an existing branch (P4-3); multi-database computes (P4-5); anonymization
(downstream consumer, later).

---

## 7. Prerequisites & grounding

- **Client binaries confirmed present** in the pinned engine image:
  `pg_dump`, `pg_restore`, `psql`, `pg_dumpall` exist under
  `/usr/local/share/neon/pg_install/v{14..17}/bin/` (verified 2026-07-13 against
  `worktreedb:dev`). A build-time tripwire asserting their presence per major is
  a cheap task in the plan (they're currently unguarded).
- **Timeline seam:** bootstrap-empty vs ancestor-CoW is the exact fork import
  needs and is already exposed by `TimelineCreateRequest`
  (`internal/engine/clients.go`) — import bootstraps, branching keeps ancestors.
- **Operations mechanics:** step cursor + `plan_fingerprint` + phase-guarded
  `Create/Advance/Finish` are built and tested; import/export supply new step
  lists on the same rails.
- **The SQL-level `pg_dump`/`pg_restore` approach is Worktree DB's own product
  choice** — distinct from neon's binary-level `import_datadir`. Only the
  empty-timeline creation is oracle-grounded.

---

## 8. Acceptance

1. **Import a running server → new project.** A sidecar Postgres (seeded with a
   table + rows) is imported via connstring → a new project appears, its `main`
   endpoint serves the imported table + rows. Branch `main` → the child isolates
   writes (CoW holds on imported data).
2. **Round-trip.** Export a branch → a local `.dump` artifact (size + LSN
   recorded) → import that artifact (file source) into a fresh project → the data
   matches the source. (Export's output is import's input.)
3. **Major handling.** Importing a source on a supported major that isn't yet
   live pulls the build then succeeds; an out-of-range major refuses cleanly
   with no partial project.
4. **Failure honesty.** A deliberately broken restore (corrupt/incompatible
   dump) lands the project `failed` with a non-empty stderr tail surfaced via the
   API; re-import after deleting it succeeds.
5. **Surfaces.** MCP `import_database`/`export_branch`/job-status work end-to-end;
   the web import form + drag-drop + export button drive the same operations with
   live SSE progress.
6. **No regression.** `go build`/`vet`/`test ./... -race` + golangci clean; the
   Go integration suite green; **the full reference parity suite stays green** —
   import/export are additive and never enter the parity gate.

---

## 9. Non-goals (this milestone)

No cloud/bucket anything (the whole durability back half — §6). No mid-restore
resume. No import into existing branches. No multi-database computes. No source
credential persistence. No schema transformation / anonymization. No public
release (still gated on Jordan's license review, per the master spec).

---

## 10. Open questions for the plan

- Export artifact directory + retention/naming under `/data/exports` (and whether
  it is user-listable / deletable via API).
- Exact multipart streaming shape (HTTP body → `io.Pipe` → `pg_restore` stdin;
  size limits; back-pressure on a slow restore).
- Major-detection for the uploaded file: parsing the `-Fc` header vs shelling
  `pg_restore -l` — pick the robust one.
- Operation step list + compensation ordering for import (project/timeline/
  endpoint creation before the long restore; what a failed restore leaves).
- Whether export auto-start should honor suspend (wake) vs require the endpoint
  already dial-able — align with the M5 suspend model.
- Redaction points for the connstring across REST bodies, `operations.params`,
  logs, and SSE.
- **Delete-during-import:** deleting an `importing` project must abort the
  in-flight operation and clean up (kill the `pg_restore` child, tear down the
  timeline/endpoint) rather than race the restore — the compensation ordering for
  this is a plan concern. (No separate "cancel" affordance this milestone;
  delete-the-project *is* the abort.)
- Terminology: standardize on **operation** for the durable row; keep the
  product spec's `get_job` / "import job" as the user-facing label for that
  operation's progress (they are 1:1).
