# Worktree DB M1 — Kernel Boots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the clean `worktreedb` repo and build the Go daemon kernel: config → store (schema v1) → owner runtime → engine supervisor (with the storcon-catalog major guard) → `GET /api/status` → Docker image — a container that boots the Neon engine healthy on a fresh volume and refuses a foreign-major one.

**Architecture:** Spec/status/operations state model in SQLite (single writer, generations); inbox-serialized owner goroutines converge desired→observed; an engine supervisor owns the five engine children (storcon_db catalog postgres + storage_broker + storage_controller + safekeeper + pageserver) with needle-based readiness, ordered spawn/stop, and process-group kill support. Master spec: `docs/superpowers/specs/2026-07-11-worktreedb-go-rewrite-design.md` (§4–§6, §8 M1).

**Tech Stack:** Go 1.25, stdlib `net/http` mux, `modernc.org/sqlite` (CGO off), `log/slog`, `testcontainers-go` (integration), `golangci-lint`. Docker runtime = `debian:bookworm-slim` + the published engine image's `/usr/local/share/neon`.

## Global Constraints

- **Repo:** all code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`), branch worktrees under `~/git/worktreedb/.worktrees/`. The plan/ledger stay HERE in the devdb repo (workshop) — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers** (spec D4). This overrides any harness default. devdb-repo commits (this plan, ledgers) keep the usual trailer.
- **Clean-history rule (spec §3):** worktreedb code, comments, commit messages, and docs NEVER mention: the TypeScript implementation, the devdb repo, or neond. `// oracle: neon <path-or-endpoint>` citations to official `neondatabase/neon` are REQUIRED for engine wire facts (reference clone `~/git/neon @ 8f60b04`; do not invent payloads).
- **Parity string contracts** (the devdb integration suite asserts these against `docker logs` at the M4 gate — bake them in EXACTLY):
  - guard refusal contains `storage_controller catalog was created by PostgreSQL <found>` AND `fresh volume` AND `previous image` AND `import/export (Phase 4)`;
  - stale-pid removal log contains `stale postmaster.pid`;
  - storcon_db creates NO unix socket (`/tmp/.s.PGSQL.5431*` must not exist — launch with `-c unix_socket_directories=`);
  - the storcon catalog data dir is exactly `<dataDir>/daemon_data/storage_controller_pg_data`;
  - `/api/status` engine map keys are exactly `storcon_db`, `storage_broker`, `storage_controller`, `safekeeper`, `pageserver`, each `{"state":"...","pid":<int|null>}`.
- **Env (spec D6):** `WORKTREEDB_HTTP_PORT` (default 4400), `WORKTREEDB_DATA_DIR` (required, absolute), `WORKTREEDB_PORT_RANGE` (default `54300-54339`), `WORKTREEDB_NEON_BIN_DIR` (required, absolute), `WORKTREEDB_PG_INSTALL_DIR` (required, absolute).
- **Engine ports (loopback-only, reserved):** broker 50051, storcon 1234, storcon_db 5431, pageserver http 9898, pageserver pg 64000, safekeeper pg 5454, safekeeper http 7676, tracer 4318.
- **Engine base image (only cross-repo contract):** `ghcr.io/vangoghsoftware/worktreedb-neon-engine@sha256:7c042751bb0fbe5c1593dd95c49418fc57abbead2b91565e5696fe6b8c8629f4` — private; local builds need Jordan's existing `docker login ghcr.io`.
- **Naming:** availability zone / region strings are `worktreedb-1`; the catalog superuser is `worktreedb` (fresh volumes only — spec D3 — so no compat concern). The engine component NAME stays `storcon_db` (status-key parity).
- **Deps:** exactly two new modules in M1 — `modernc.org/sqlite` and `github.com/testcontainers/testcontainers-go` (test-only). Anything else needs an explicit decision recorded in the task report.
- **Machine quirks:** docker + `docker-credential-desktop` live at `/Applications/Docker.app/Contents/Resources/bin` (put on PATH for builds AND testcontainers runs); node (if any tooling needs it) via `$HOME/.nvm/versions/node/v25.2.1/bin`; go is on the default PATH (`/usr/local/go/bin` or brew).
- **Tests:** TDD with captured RED evidence. Unit tests use fakes injected through option funcs/interfaces — no real processes or network in unit tests. Integration tests carry `//go:build integration` and run only locally (CI runs unit-only until the GHCR package-access grant exists — Jordan-gated, see Task 1's CI note).

## File map (M1 end state, worktreedb repo)

```
cmd/worktreedbd/main.go            lockfile, boot order, shutdown escalation
internal/config/config.go          env → validated Config (+ reserved-port checks)
internal/config/config_test.go
internal/store/store.go            Open (WAL, single-writer), WithTx, meta, generations
internal/store/schema.go           schema v1 DDL (all tables; M1 exercises meta+operations+generations)
internal/store/operations.go       durable operation log CRUD
internal/store/store_test.go
internal/runtime/owner.go          inbox-serialized owner: Start/Nudge/Do
internal/runtime/operation.go      step executor + boot resume policies
internal/runtime/runtime_test.go
internal/engine/process.go         managed child process (needle readiness, group kill, fences)
internal/engine/process_test.go
internal/engine/specs.go           dirs + the 5 process specs + pageserver files + registration body
internal/engine/specs_test.go
internal/engine/tracer.go          catch-all OTLP/upcall sink on 4318
internal/engine/tracer_test.go
internal/engine/catalogdb.go       storcon_db embedded postgres: initdb, major guard, stale-pid
internal/engine/catalogdb_test.go
internal/engine/supervisor.go      ordered boot/stop of the five children + status map
internal/engine/supervisor_test.go
internal/api/server.go             net/http mux, GET /api/status
internal/api/server_test.go
integration/boot_test.go           //go:build integration — testcontainers: healthy boot, guard, unclean restart
Dockerfile  .dockerignore  .gitignore  .golangci.yml  .github/workflows/ci.yml
go.mod  go.sum  README.md  AGENTS.md  CLAUDE.md  docs/codebase-review.md
```

---

### Task 1: Repo bootstrap (the clean history's first page)

> **AMENDED (A1, 2026-07-11, post-review):** the `.golangci.yml` below is v1 schema — WRONG for
> `golangci-lint-action@v7`, which only supports golangci-lint v2 (broker P2, CI-blocking). The
> fix wave migrated it to v2 (`version: "2"`, gofmt/goimports moved to `formatters`, goimports
> local prefix under `formatters.settings`) and pinned the action's `version:` to the locally
> verified golangci-lint release instead of `latest`. Also folded in: honest pre-M1 README
> status wording (broker P3), `.env*` ignore patterns (P4), and a `.gitattributes`
> (`* text=auto eol=lf`) for deterministic line endings (task-reviewer Minor — the CRLF class
> that has bitten this machine before). Read the repo's committed files as authoritative over
> the blocks below.

**Files:**
- Create: `~/git/worktreedb/` — clone of the EMPTY `github.com/VanGoghSoftware/worktreedb`
- Create: `README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.golangci.yml`, `.github/workflows/ci.yml`, `go.mod`, `cmd/worktreedbd/main.go` (skeleton), `docs/codebase-review.md`

**Interfaces:**
- Produces: a compiling module `github.com/VanGoghSoftware/worktreedb`; `main.go` skeleton that later tasks replace; the repo's standing rules (AGENTS.md) every later implementer works under.

- [ ] **Step 1: Clone the empty repo and set identity**

```bash
cd ~/git
git clone https://github.com/VanGoghSoftware/worktreedb.git
cd worktreedb
git status   # expect: "No commits yet" on branch main (GitHub default); if the default is master: git branch -m main
```

- [ ] **Step 2: Write `README.md`** (exactly this content)

```markdown
# Worktree DB

A local-development PostgreSQL server with instant copy-on-write branching,
packaged as one Docker container — built for AI coding agents:

> worktree : files :: branch : data

Every branch is a full PostgreSQL database that forks from its parent in
milliseconds without copying data, powered by the Neon storage engine
(pageserver / safekeeper / storage controller) supervised by a single Go
daemon. Agents (and humans) create disposable branches per task, run
migrations against them safely, and throw them away.

**Status: early development.** The daemon currently boots the storage engine
and serves `GET /api/status`; branching APIs are landing next.

## Run

The engine base image is private for now, so building needs a one-time
`docker login ghcr.io` with a `read:packages` token.

```bash
docker build -t worktreedb:dev .
docker volume create worktreedb-data
docker run -d --name worktreedb --init \
  -p 127.0.0.1:4400:4400 -p 127.0.0.1:54300-54339:54300-54339 \
  -v worktreedb-data:/data worktreedb:dev
curl -s http://127.0.0.1:4400/api/status
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `WORKTREEDB_HTTP_PORT` | `4400` | REST port |
| `WORKTREEDB_DATA_DIR` | `/data` (image) | persistent state root |
| `WORKTREEDB_PORT_RANGE` | `54300-54339` | published branch-endpoint ports |

Engine internals bind to loopback inside the container only.

## Troubleshooting

A crashed container can leave `/data/.lock` behind; the daemon then refuses
to start (single-instance guard). Remove it — only if no other Worktree DB
container uses the volume:

```bash
docker run --rm -v worktreedb-data:/data alpine rm -f /data/.lock
```
```

- [ ] **Step 3: Write `AGENTS.md`** (exactly this content — these are the standing rules every implementer in this repo works under)

```markdown
# Worktree DB — Agent Instructions

Worktree DB is a local-development PostgreSQL server with Neon-style instant
copy-on-write branching, packaged as one Docker container, built for AI
coding agents: worktree : files :: branch : data. A Go daemon supervises the
Neon storage engine and serves branches over REST on `:4400`.

## Hard rules

- **Oracle rule:** engine interactions (wire payloads, configs, protocol,
  CLI args) are grounded in official `neondatabase/neon` — cite
  `// oracle: neon <path-or-endpoint>` at the use site. Do not invent
  payloads. Product, orchestration, and storage-schema choices are Worktree
  DB's own — no external oracle.
- **Never file issues, PRs, or comments on external/upstream repos.**
  Document findings internally. Read-only upstream research is fine.
- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `docs:`,
  `build:`, `chore:`). No co-author trailers of any kind. Never commit
  secrets.
- **Dependencies:** standard library first. Every new module is an explicit
  decision recorded in the PR/commit that introduces it; `go.sum` (sumdb)
  must verify. Current allowlist: `modernc.org/sqlite`,
  `github.com/testcontainers/testcontainers-go` (test-only).
- **Tests:** TDD — write the failing test first and keep the RED evidence in
  the task report. Unit tests are hermetic (fakes over interfaces/option
  funcs; no network, no real child processes). Integration tests build the
  real image and carry `//go:build integration`.
- **State model:** desired state (`spec_*`, written by the API layer only) is
  separate from observed state (`status_*`, written by that resource's owner
  only, generation-stamped). Multi-step work goes through the `operations`
  log. Never write status from a request handler.

## Commands

```bash
go build ./... && go vet ./...      # compile + vet
go test ./...                        # unit suite (hermetic, ~seconds)
golangci-lint run                    # lint (config: .golangci.yml)
docker build -t worktreedb:dev .     # image (engine base is private GHCR — needs docker login)
go test -tags integration ./integration/...   # container-level suite (needs Docker)
```

## Architecture in one paragraph

`cmd/worktreedbd` boots: config (env → validated) → store (SQLite, WAL,
single writer; spec/status generations + a durable operations log) → owner
runtime (one goroutine per resource; an inbox serializes every mutation;
status commits are abandoned if the spec generation moved) → engine
supervisor (storcon_db catalog postgres + storage_broker +
storage_controller + safekeeper + pageserver as managed children: ordered
spawn, log-needle readiness, SIGTERM→SIGKILL escalation, process-group kill
support; a catalog-major guard refuses a volume initdb'd by a different
PostgreSQL major) → HTTP API. Engine ports are loopback-only inside the
container; published ports are owned by the daemon.
```

- [ ] **Step 4: Write `CLAUDE.md`**

```markdown
@AGENTS.md

## Claude-specific notes

- Never implement directly on `main` — create a worktree under
  `.worktrees/<branch>` first.
- Reviews follow the two-gate process (independent reviewer + review-broker
  scan); the broker's dedup doc for this repo is `docs/codebase-review.md`.
- Commit policy reminder: conventional commits, **no co-author trailers**.
```

- [ ] **Step 5: Write `.gitignore`, `.golangci.yml`, `docs/codebase-review.md`**

`.gitignore`:
```gitignore
/worktreedbd
/data/
.worktrees/
.claude/worktrees/
.superpowers/
coverage.out
*.test
```

`.golangci.yml` (lint floor — default linters plus a small, opinionated set):
```yaml
run:
  timeout: 5m
linters:
  enable:
    - errcheck
    - govet
    - staticcheck
    - unused
    - ineffassign
    - misspell
    - gofmt
    - goimports
linters-settings:
  goimports:
    local-prefixes: github.com/VanGoghSoftware/worktreedb
```

`docs/codebase-review.md`:
```markdown
# Codebase review findings

Durable, append-only log of model-backed review findings for this project.
```

- [ ] **Step 6: `go.mod` + compiling skeleton**

```bash
cd ~/git/worktreedb
go mod init github.com/VanGoghSoftware/worktreedb
```

`cmd/worktreedbd/main.go` (skeleton — Task 8 replaces it):
```go
// Command worktreedbd is the Worktree DB daemon: it supervises the Neon
// storage engine and serves branch operations over REST.
package main

import (
	"fmt"
	"os"
)

const version = "0.1.0"

func main() {
	fmt.Fprintf(os.Stderr, "worktreedbd %s: boot sequence not wired yet\n", version)
	os.Exit(1)
}
```

Run: `go build ./... && go vet ./...`
Expected: both succeed, `git status` shows only intended files.

- [ ] **Step 7: `.github/workflows/ci.yml`**

```yaml
# Unit CI: build + vet + test + lint. The docker image build is NOT here yet:
# the engine base image is private GHCR, and this repo's Actions token gets
# read access only once the package-access grant is configured (repo settings
# on the packages — an owner-gated, one-time UI step). Until then the image
# builds locally.
name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: go build ./...
      - run: go vet ./...
      - run: go test ./...
      - uses: golangci/golangci-lint-action@v7
        with:
          version: latest
```

- [ ] **Step 8: Commit (three commits, clean voice, NO trailers)**

```bash
git add README.md AGENTS.md CLAUDE.md docs/codebase-review.md .gitignore
git commit -m "docs: project readme + agent instructions"
git add go.mod cmd/worktreedbd/main.go
git commit -m "feat: module skeleton for the worktreedbd daemon"
git add .golangci.yml .github/workflows/ci.yml
git commit -m "build: lint config + unit CI"
git log --oneline   # 3 commits, no trailers — verify with: git log --format=%B | grep -ci co-authored  → 0
```

---

### Task 2: internal/config — env → validated Config

> **AMENDED (A2, 2026-07-11, post-review):** the shipped code REJECTS whitespace-padded path
> values (broker P3 — the plan's trim-then-validate silently redirected e.g. `" /data"`);
> `portEnv` reports non-integer vs out-of-range with distinct messages; locals renamed
> `rangeMin`/`rangeMax` (builtin shadowing); the test table grew to 39 cases (all 8 reserved
> ports × both mechanisms, whitespace ×3 vars, port boundary/syntax cases, full EnginePorts
> pin). Repo code is authoritative over the blocks below.

**Files:**
- Create: `internal/config/config.go`, Test: `internal/config/config_test.go`

**Interfaces:**
- Produces (later tasks consume these exact names):
  ```go
  type PortRange struct{ Min, Max int }
  type EnginePorts struct{ Broker, Storcon, StorconDB, PageserverHTTP, PageserverPg, SafekeeperPg, SafekeeperHTTP, Tracer int }
  type Config struct {
      HTTPPort     int
      DataDir      string
      PortRange    PortRange
      NeonBinDir   string
      PgInstallDir string
      Engine       EnginePorts
  }
  func Load(getenv func(string) string) (*Config, error)
  ```
  `Load(os.Getenv)` in main; tests inject a map-backed getenv.

- [ ] **Step 1: Write the failing tests** (`internal/config/config_test.go`)

```go
package config

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func valid() map[string]string {
	return map[string]string{
		"WORKTREEDB_DATA_DIR":       "/data",
		"WORKTREEDB_NEON_BIN_DIR":   "/usr/local/share/neon/bin",
		"WORKTREEDB_PG_INSTALL_DIR": "/usr/local/share/neon/pg_install",
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(valid()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPPort != 4400 {
		t.Fatalf("HTTPPort = %d, want 4400", cfg.HTTPPort)
	}
	if cfg.PortRange != (PortRange{54300, 54339}) {
		t.Fatalf("PortRange = %+v", cfg.PortRange)
	}
	if cfg.Engine.StorconDB != 5431 || cfg.Engine.Tracer != 4318 {
		t.Fatalf("engine ports = %+v", cfg.Engine)
	}
}

func TestLoadRejects(t *testing.T) {
	cases := []struct {
		name string
		mut  func(map[string]string)
		want string // substring of the error
	}{
		{"missing data dir", func(m map[string]string) { delete(m, "WORKTREEDB_DATA_DIR") }, "WORKTREEDB_DATA_DIR"},
		{"relative data dir", func(m map[string]string) { m["WORKTREEDB_DATA_DIR"] = "data" }, "absolute"},
		{"bad port", func(m map[string]string) { m["WORKTREEDB_HTTP_PORT"] = "99999" }, "WORKTREEDB_HTTP_PORT"},
		{"bad range syntax", func(m map[string]string) { m["WORKTREEDB_PORT_RANGE"] = "54300" }, "WORKTREEDB_PORT_RANGE"},
		{"inverted range", func(m map[string]string) { m["WORKTREEDB_PORT_RANGE"] = "54339-54300" }, "WORKTREEDB_PORT_RANGE"},
		{"range overlaps engine port", func(m map[string]string) { m["WORKTREEDB_PORT_RANGE"] = "5400-5500" }, "reserved engine port"},
		{"http port inside range", func(m map[string]string) { m["WORKTREEDB_HTTP_PORT"] = "54310" }, "falls inside"},
		{"http port is reserved", func(m map[string]string) { m["WORKTREEDB_HTTP_PORT"] = "1234" }, "reserved engine port"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := valid()
			tc.mut(m)
			_, err := Load(env(m))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify RED** — `go test ./internal/config/` → FAIL (package does not compile: `Load` undefined). Capture the output in the task report.

- [ ] **Step 3: Implement** (`internal/config/config.go`)

```go
// Package config turns environment variables into a validated daemon
// configuration. All engine ports are fixed loopback-only ports inside the
// container; the published branch-endpoint range and the HTTP port must not
// collide with them.
package config

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

type PortRange struct{ Min, Max int }

type EnginePorts struct {
	Broker, Storcon, StorconDB, PageserverHTTP, PageserverPg, SafekeeperPg, SafekeeperHTTP, Tracer int
}

type Config struct {
	HTTPPort     int
	DataDir      string
	PortRange    PortRange
	NeonBinDir   string
	PgInstallDir string
	Engine       EnginePorts
}

// oracle: neon pageserver_api DEFAULT_HTTP_LISTEN_PORT / DEFAULT_PG_LISTEN_PORT, safekeeper_api's
// equivalents, and storage_broker DEFAULT_LISTEN_ADDR (control_plane/src/bin/neon_local.rs imports
// these as its own port defaults) — this port set mirrors those defaults. 4318 is the standard
// OTLP/HTTP port, reserved for the daemon's catch-all trace/upcall sink. 5431 hosts the storage
// controller's catalog database.
func defaultEnginePorts() EnginePorts {
	return EnginePorts{
		Broker: 50051, Storcon: 1234, StorconDB: 5431,
		PageserverHTTP: 9898, PageserverPg: 64000,
		SafekeeperPg: 5454, SafekeeperHTTP: 7676, Tracer: 4318,
	}
}

func (e EnginePorts) all() []int {
	return []int{e.Broker, e.Storcon, e.StorconDB, e.PageserverHTTP, e.PageserverPg, e.SafekeeperPg, e.SafekeeperHTTP, e.Tracer}
}

func Load(getenv func(string) string) (*Config, error) {
	cfg := &Config{Engine: defaultEnginePorts()}

	for _, req := range []struct {
		key string
		dst *string
	}{
		{"WORKTREEDB_DATA_DIR", &cfg.DataDir},
		{"WORKTREEDB_NEON_BIN_DIR", &cfg.NeonBinDir},
		{"WORKTREEDB_PG_INSTALL_DIR", &cfg.PgInstallDir},
	} {
		v := strings.TrimSpace(getenv(req.key))
		if v == "" {
			return nil, fmt.Errorf("%s is required", req.key)
		}
		if !filepath.IsAbs(v) {
			return nil, fmt.Errorf("%s must be an absolute path, got: %s", req.key, v)
		}
		*req.dst = v
	}

	httpPort, err := portEnv(getenv, "WORKTREEDB_HTTP_PORT", 4400)
	if err != nil {
		return nil, err
	}
	cfg.HTTPPort = httpPort

	rangeRaw := strings.TrimSpace(getenv("WORKTREEDB_PORT_RANGE"))
	if rangeRaw == "" {
		rangeRaw = "54300-54339"
	}
	lo, hi, ok := strings.Cut(rangeRaw, "-")
	min, errMin := strconv.Atoi(strings.TrimSpace(lo))
	max, errMax := strconv.Atoi(strings.TrimSpace(hi))
	if !ok || errMin != nil || errMax != nil || min < 1 || max < min || max > 65535 {
		return nil, fmt.Errorf("WORKTREEDB_PORT_RANGE invalid: %s (want MIN-MAX, 1..65535, MIN<=MAX)", rangeRaw)
	}
	cfg.PortRange = PortRange{Min: min, Max: max}

	for _, p := range cfg.Engine.all() {
		if p >= min && p <= max {
			return nil, fmt.Errorf("WORKTREEDB_PORT_RANGE %s overlaps reserved engine port %d", rangeRaw, p)
		}
		if p == httpPort {
			return nil, fmt.Errorf("WORKTREEDB_HTTP_PORT %d is a reserved engine port", httpPort)
		}
	}
	if httpPort >= min && httpPort <= max {
		return nil, fmt.Errorf("WORKTREEDB_HTTP_PORT %d falls inside WORKTREEDB_PORT_RANGE %s", httpPort, rangeRaw)
	}
	return cfg, nil
}

func portEnv(getenv func(string) string, key string, def int) (int, error) {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return def, nil
	}
	p, err := strconv.Atoi(raw)
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("%s out of range: %s", key, raw)
	}
	return p, nil
}
```

- [ ] **Step 4: Run to verify GREEN** — `go test ./internal/config/ -v` → all pass. `go vet ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add internal/config
git commit -m "feat: validated env configuration with reserved-port checks"
```

---

### Task 3: internal/store — SQLite schema v1, generations, operations log

> **AMENDED (A4, 2026-07-11, post-review):** the shipped code hardens the reference below —
> repo authoritative. Operations transitions are guarded (FinishOperation validates done|failed;
> Advance/Finish require phase ∈ pending|running via conditional UPDATE + RowsAffected error;
> schema CHECKs on phase and step_cursor≥0); `OperationByID` added (a failed op's Error was
> unreachable); `WithTx` gained an immediate deferred Rollback (a panicking callback stranded
> the single pooled connection — RED-proven); `IncompleteOperations` orders by created_at, id;
> `NowISO()` exported. Suite 5 → 11 tests. Dependency note: sqlite v1.53.0 forces go.mod's
> `go 1.25.0` directive (sandboxes need Go ≥ 1.25); do NOT drive-by `go mod tidy` — it drags 14
> test-only transitives into go.sum (reviewer-proven); the `// indirect` marker fix is deferred.

**Files:**
- Create: `internal/store/store.go`, `internal/store/schema.go`, `internal/store/operations.go`, Test: `internal/store/store_test.go`

**Interfaces:**
- Consumes: nothing (first dep: `modernc.org/sqlite`).
- Produces (later tasks consume these exact names):
  ```go
  func Open(path string) (*Store, error)      // WAL, foreign_keys, single writer
  func (s *Store) Close() error
  func (s *Store) WithTx(ctx context.Context, fn func(tx *sql.Tx) error) error
  func (s *Store) GetMeta(ctx context.Context, key string) (val string, ok bool, err error)
  func (s *Store) SetMeta(ctx context.Context, key, value string) error
  func SpecGen(tx *sql.Tx, table, id string) (int64, error)
  func BumpSpecGen(tx *sql.Tx, table, id string) (int64, error)
  var ErrStaleGeneration error
  func (s *Store) CommitStatus(ctx context.Context, table, id string, gen int64, apply func(tx *sql.Tx) error) error
  type Operation struct{ ID, Kind, TargetID, Params string; StepCursor int; Phase, Error string }
  func (s *Store) CreateOperation(ctx context.Context, kind, targetID, paramsJSON string) (string, error)
  func (s *Store) IncompleteOperations(ctx context.Context) ([]Operation, error)
  func (s *Store) AdvanceOperation(ctx context.Context, id string, cursor int) error
  func (s *Store) FinishOperation(ctx context.Context, id, phase, errMsg string) error  // phase "done"|"failed"
  func NewID() string                          // 32-hex crypto/rand id
  ```

- [ ] **Step 1: Add the dependency (explicit decision)**

```bash
cd ~/git/worktreedb
go get modernc.org/sqlite@latest
go mod verify   # sumdb must verify
```
Record the resolved version in the task report (decision: pure-Go driver keeps CGO_ENABLED=0 → static binary; performance is irrelevant at this scale).

- [ ] **Step 2: Write the failing tests** (`internal/store/store_test.go`)

```go
package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestMetaRoundTrip(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	if _, ok, _ := s.GetMeta(ctx, "nope"); ok {
		t.Fatal("expected absent key")
	}
	if err := s.SetMeta(ctx, "k", "v1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta(ctx, "k", "v2"); err != nil { // upsert
		t.Fatal(err)
	}
	v, ok, err := s.GetMeta(ctx, "k")
	if err != nil || !ok || v != "v2" {
		t.Fatalf("got %q ok=%v err=%v", v, ok, err)
	}
}

func TestSchemaVersionStamped(t *testing.T) {
	s := open(t)
	v, ok, err := s.GetMeta(context.Background(), "schema_version")
	if err != nil || !ok || v != "1" {
		t.Fatalf("schema_version = %q ok=%v err=%v", v, ok, err)
	}
}

// The generation contract: an owner that converged for generation G may only
// commit status if the spec generation is STILL G — otherwise the commit is
// abandoned with ErrStaleGeneration and nothing is written.
func TestCommitStatusAbandonsStaleGeneration(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	// Seed one project row (spec_generation starts at 1).
	err := s.WithTx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`INSERT INTO projects (id, name, pg_major, tenant_id, created_at) VALUES ('p1','demo',17,'t1','2026-01-01T00:00:00Z')`)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	// Commit for gen 1 succeeds and stamps observed_generation.
	err = s.CommitStatus(ctx, "projects", "p1", 1, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE projects SET status_phase='ready' WHERE id='p1'`)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	// Spec moves to gen 2 (as an API write would).
	err = s.WithTx(ctx, func(tx *sql.Tx) error {
		_, e := BumpSpecGen(tx, "projects", "p1")
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	// A late commit still carrying gen 1 must be abandoned — atomically.
	err = s.CommitStatus(ctx, "projects", "p1", 1, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE projects SET status_phase='stale-write' WHERE id='p1'`)
		return e
	})
	if err != ErrStaleGeneration {
		t.Fatalf("err = %v, want ErrStaleGeneration", err)
	}
	var phase string
	var og int64
	row := s.db.QueryRow(`SELECT status_phase, observed_generation FROM projects WHERE id='p1'`)
	if err := row.Scan(&phase, &og); err != nil {
		t.Fatal(err)
	}
	if phase != "ready" || og != 1 {
		t.Fatalf("stale commit leaked: phase=%q observed_generation=%d", phase, og)
	}
}

func TestOperationsLifecycle(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	id, err := s.CreateOperation(ctx, "create_branch", "b1", `{"name":"x"}`)
	if err != nil {
		t.Fatal(err)
	}
	ops, err := s.IncompleteOperations(ctx)
	if err != nil || len(ops) != 1 || ops[0].ID != id || ops[0].Phase != "pending" || ops[0].StepCursor != 0 {
		t.Fatalf("ops = %+v err=%v", ops, err)
	}
	if err := s.AdvanceOperation(ctx, id, 2); err != nil {
		t.Fatal(err)
	}
	ops, _ = s.IncompleteOperations(ctx)
	if ops[0].StepCursor != 2 || ops[0].Phase != "running" {
		t.Fatalf("after advance: %+v", ops[0])
	}
	if err := s.FinishOperation(ctx, id, "done", ""); err != nil {
		t.Fatal(err)
	}
	if ops, _ = s.IncompleteOperations(ctx); len(ops) != 0 {
		t.Fatalf("done op still incomplete: %+v", ops)
	}
}

func TestNewIDShape(t *testing.T) {
	a, b := NewID(), NewID()
	if len(a) != 32 || a == b {
		t.Fatalf("ids: %q %q", a, b)
	}
}
```

- [ ] **Step 3: RED** — `go test ./internal/store/` → compile failure (`Open` undefined). Capture.

- [ ] **Step 4: Implement schema** (`internal/store/schema.go`)

```go
package store

// Schema v1. Desired state lives in spec_* columns (written only by the API
// layer, every write bumps spec_generation); observed state lives in status_*
// columns (written only by the resource's owner, stamped with
// observed_generation). Multi-step work is durably logged in `operations`.
// The full v1 schema ships now so later milestones add code, not migrations;
// this milestone exercises meta, operations, and the generation helpers.
const schemaV1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  pg_major            INTEGER NOT NULL,
  tenant_id           TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  spec_generation     INTEGER NOT NULL DEFAULT 1,
  status_phase        TEXT NOT NULL DEFAULT 'pending',
  status_message      TEXT,
  observed_generation INTEGER NOT NULL DEFAULT 0,
  status_updated_at   TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS branches (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  parent_branch_id    TEXT REFERENCES branches(id),
  timeline_id         TEXT NOT NULL,
  fork_lsn            TEXT,
  created_at          TEXT NOT NULL,
  -- endpoint desired/observed state, folded in: one endpoint per branch is a
  -- structural invariant of this schema.
  spec_endpoint       TEXT NOT NULL DEFAULT 'stopped',
  spec_generation     INTEGER NOT NULL DEFAULT 1,
  port_slot           INTEGER,
  status_endpoint     TEXT NOT NULL DEFAULT 'stopped',
  status_port         INTEGER,
  status_pgbin        TEXT,
  status_error        TEXT,
  observed_generation INTEGER NOT NULL DEFAULT 0,
  status_updated_at   TEXT,
  UNIQUE (project_id, slug)
) STRICT;

CREATE TABLE IF NOT EXISTS pg_builds (
  id           TEXT PRIMARY KEY,
  major        INTEGER NOT NULL,
  minor        INTEGER,
  source       TEXT NOT NULL,
  release_tag  TEXT,
  image_digest TEXT,
  path         TEXT,
  size_bytes   INTEGER,
  status       TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pg_actives (
  major           INTEGER PRIMARY KEY,
  active_build_id TEXT REFERENCES pg_builds(id),
  last_run_minor  INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target_id   TEXT,
  params      TEXT NOT NULL DEFAULT '{}',
  step_cursor INTEGER NOT NULL DEFAULT 0,
  phase       TEXT NOT NULL DEFAULT 'pending',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
`
```

- [ ] **Step 5: Implement store core** (`internal/store/store.go`)

```go
// Package store owns the daemon's persistent state: one SQLite database in
// WAL mode with a single writer. It provides the generation contract that
// keeps owner status-writes honest and the durable operations log that makes
// multi-step work resumable.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// Single writer by construction: one pooled connection means every
	// transaction is serialized at the driver, so owners can never interleave
	// partial writes.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaV1); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	s := &Store{db: db}
	if err := s.stampMetaDefaults(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) stampMetaDefaults() error {
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES ('schema_version','1') ON CONFLICT(key) DO NOTHING`); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES ('instance_id', ?) ON CONFLICT(key) DO NOTHING`, NewID())
	return err
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) WithTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (s *Store) GetMeta(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// ErrStaleGeneration is returned by CommitStatus when the row's spec
// generation moved while the owner was converging: the observation is for a
// world that no longer matches the request, so nothing is written and the
// owner re-converges against the new spec.
var ErrStaleGeneration = errors.New("stale generation: spec changed during convergence")

// allowedTables guards the identifier interpolation in the generation
// helpers: table names cannot be bound as SQL parameters, so restrict them to
// the owner-managed tables instead of trusting the caller.
var allowedTables = map[string]bool{"projects": true, "branches": true}

func mustTable(table string) error {
	if !allowedTables[table] {
		return fmt.Errorf("generation helpers do not manage table %q", table)
	}
	return nil
}

func SpecGen(tx *sql.Tx, table, id string) (int64, error) {
	if err := mustTable(table); err != nil {
		return 0, err
	}
	var g int64
	err := tx.QueryRow(`SELECT spec_generation FROM `+table+` WHERE id = ?`, id).Scan(&g)
	return g, err
}

func BumpSpecGen(tx *sql.Tx, table, id string) (int64, error) {
	if err := mustTable(table); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE `+table+` SET spec_generation = spec_generation + 1 WHERE id = ?`, id); err != nil {
		return 0, err
	}
	return SpecGen(tx, table, id)
}

// CommitStatus runs `apply` and stamps observed_generation = gen in ONE
// transaction, but only if the row's spec_generation still equals gen. The
// re-read happens inside the transaction, so a concurrent spec bump either
// lands before (commit abandoned) or after (bump wins later) — never
// interleaved.
func (s *Store) CommitStatus(ctx context.Context, table, id string, gen int64, apply func(tx *sql.Tx) error) error {
	if err := mustTable(table); err != nil {
		return err
	}
	return s.WithTx(ctx, func(tx *sql.Tx) error {
		current, err := SpecGen(tx, table, id)
		if err != nil {
			return err
		}
		if current != gen {
			return ErrStaleGeneration
		}
		if err := apply(tx); err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE `+table+` SET observed_generation = ?, status_updated_at = ? WHERE id = ?`,
			gen, nowISO(), id)
		return err
	})
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

// NewID returns a 32-hex crypto/rand identifier (no external uuid module —
// dependency discipline; collision odds are negligible at this scale).
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable for id generation
	}
	return hex.EncodeToString(b)
}
```

- [ ] **Step 6: Implement operations log** (`internal/store/operations.go`)

```go
package store

import "context"

// Operation is one durable multi-step intent. Owners execute steps in order,
// advancing step_cursor after each completed step; boot resumes or
// fail-forwards incomplete rows by per-kind policy (see internal/runtime).
type Operation struct {
	ID         string
	Kind       string
	TargetID   string
	Params     string
	StepCursor int
	Phase      string // pending | running | done | failed
	Error      string
}

func (s *Store) CreateOperation(ctx context.Context, kind, targetID, paramsJSON string) (string, error) {
	id := NewID()
	now := nowISO()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO operations (id, kind, target_id, params, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
		id, kind, targetID, paramsJSON, now, now)
	return id, err
}

func (s *Store) IncompleteOperations(ctx context.Context) ([]Operation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, kind, COALESCE(target_id,''), params, step_cursor, phase, COALESCE(error,'')
		   FROM operations WHERE phase IN ('pending','running') ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Operation
	for rows.Next() {
		var o Operation
		if err := rows.Scan(&o.ID, &o.Kind, &o.TargetID, &o.Params, &o.StepCursor, &o.Phase, &o.Error); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Store) AdvanceOperation(ctx context.Context, id string, cursor int) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE operations SET step_cursor = ?, phase = 'running', updated_at = ? WHERE id = ?`,
		cursor, nowISO(), id)
	return err
}

func (s *Store) FinishOperation(ctx context.Context, id, phase, errMsg string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE operations SET phase = ?, error = NULLIF(?, ''), updated_at = ? WHERE id = ?`,
		phase, errMsg, nowISO(), id)
	return err
}
```

- [ ] **Step 7: GREEN** — `go test ./internal/store/ -v` → all pass. `go build ./... && go vet ./...` clean.

- [ ] **Step 8: Commit**

```bash
git add go.mod go.sum internal/store
git commit -m "feat: sqlite store — schema v1, generation contract, operations log"
```

---

### Task 4: internal/runtime — the owner framework + operation executor

> **AMENDED (A5, 2026-07-11, post-review, Fable fix wave):** the reference code below needed a
> concurrency-model hardening pass — repo authoritative. Owner lifecycle is now enforced
> (Start idempotent via atomic CAS + warn, exactly one loop ever; Do fails fast with exported
> `ErrOwnerStopped` pre-Start and after termination, with a buffered-reply drain so a received
> request always returns its real result — happens-before proven in re-review; Wait hang-free).
> `ErrConvergePanicked` sentinel replaces the misleading context.Canceled. A FAILED nudge-driven
> converge re-arms itself via a delayed self-Nudge (package `retryBackoff`, coalescing-bounded);
> Do-path failures deliberately do not. `RunOperation` validates the persisted cursor
> (out-of-range → op failed + error, never silent done; a plan-fingerprint for cross-binary
> step-list skew is DEFERRED to the milestone that adds real operation kinds). Suite 5 → 12.

**Files:**
- Create: `internal/runtime/owner.go`, `internal/runtime/operation.go`, Test: `internal/runtime/runtime_test.go`

**Interfaces:**
- Consumes: `store.Store`, `store.Operation`, `store.ErrStaleGeneration` (Task 3).
- Produces (Task 8 + all later milestones consume):
  ```go
  func NewOwner(name string, converge func(ctx context.Context) error, log *slog.Logger) *Owner
  func (o *Owner) Start(ctx context.Context)  // spawns the loop goroutine
  func (o *Owner) Nudge()                     // async, coalescing
  func (o *Owner) Do(ctx context.Context) error // SYNCHRONOUS converge through the inbox
  func (o *Owner) Wait()                      // returns after the loop exits (ctx cancel)
  type Step struct{ Name string; Do func(ctx context.Context) error }
  type BootPolicy int; const ( ResumeOnBoot BootPolicy = iota; FailForwardOnBoot )
  func RunOperation(ctx context.Context, s *store.Store, opID string, startCursor int, steps []Step) error
  func ResumeIncomplete(ctx context.Context, s *store.Store, policy map[string]BootPolicy,
      steps func(op store.Operation) []Step, log *slog.Logger) error
  ```
- Contract notes for the implementer: the inbox is the ONLY path to convergence (the M5 wake-on-connect design depends on there being no side door); `Do` is how boot runs the first converge synchronously; converge errors don't kill the loop (they're returned to `Do` callers / logged for `Nudge`).

- [ ] **Step 1: Write the failing tests** (`internal/runtime/runtime_test.go`)

```go
package runtime

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(testWriter{}, nil)) }

type testWriter struct{}

func (testWriter) Write(p []byte) (int, error) { return len(p), nil }

// Every converge — from Do or Nudge — runs on the owner goroutine, strictly
// serialized: no two converges overlap even under concurrent senders.
func TestOwnerSerializesConverges(t *testing.T) {
	var active, maxActive int64
	conv := func(ctx context.Context) error {
		n := atomic.AddInt64(&active, 1)
		for {
			m := atomic.LoadInt64(&maxActive)
			if n <= m || atomic.CompareAndSwapInt64(&maxActive, m, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		atomic.AddInt64(&active, -1)
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := NewOwner("t", conv, testLog())
	o.Start(ctx)
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() { _ = o.Do(ctx); done <- struct{}{} }()
	}
	for i := 0; i < 8; i++ {
		<-done
	}
	if atomic.LoadInt64(&maxActive) != 1 {
		t.Fatalf("maxActive = %d, want 1 (serialized)", maxActive)
	}
}

func TestDoReturnsConvergeError(t *testing.T) {
	boom := errors.New("boom")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := NewOwner("t", func(context.Context) error { return boom }, testLog())
	o.Start(ctx)
	if err := o.Do(ctx); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	// The loop survives an error: a later Do still runs.
	if err := o.Do(ctx); !errors.Is(err, boom) {
		t.Fatalf("second Do err = %v, want boom (loop alive)", err)
	}
}

func TestNudgeCoalescesAndConverges(t *testing.T) {
	var runs atomic.Int64
	release := make(chan struct{})
	conv := func(ctx context.Context) error {
		runs.Add(1)
		if runs.Load() == 1 {
			<-release // hold the first converge so nudges pile up behind it
		}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := NewOwner("t", conv, testLog())
	o.Start(ctx)
	go func() { _ = o.Do(ctx) }() // occupy the loop (runs=1, held)
	time.Sleep(10 * time.Millisecond)
	for i := 0; i < 5; i++ {
		o.Nudge() // all five coalesce into ONE pending converge
	}
	close(release)
	deadline := time.After(2 * time.Second)
	for runs.Load() < 2 {
		select {
		case <-deadline:
			t.Fatalf("coalesced converge never ran; runs=%d", runs.Load())
		case <-time.After(5 * time.Millisecond):
		}
	}
	time.Sleep(20 * time.Millisecond)
	if got := runs.Load(); got != 2 {
		t.Fatalf("runs = %d, want exactly 2 (1 held + 1 coalesced)", got)
	}
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// RunOperation persists the cursor after each step, so a resume (same op id,
// startCursor from the row) executes only the remaining steps.
func TestRunOperationAdvancesAndResumes(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	id, _ := s.CreateOperation(ctx, "demo", "x", "{}")
	var ran []string
	step := func(name string) Step {
		return Step{Name: name, Do: func(context.Context) error { ran = append(ran, name); return nil }}
	}
	boom := Step{Name: "s2", Do: func(context.Context) error { return errors.New("crash") }}

	// First run: s1 succeeds (cursor→1), s2 fails → operation phase=failed.
	err := RunOperation(ctx, s, id, 0, []Step{step("s1"), boom, step("s3")})
	if err == nil {
		t.Fatal("want error from failing step")
	}
	ops, _ := s.IncompleteOperations(ctx)
	if len(ops) != 0 {
		t.Fatalf("failed op must be terminal, got %+v", ops)
	}

	// A fresh operation resumed from cursor 1 runs ONLY s2', s3.
	id2, _ := s.CreateOperation(ctx, "demo", "y", "{}")
	_ = s.AdvanceOperation(ctx, id2, 1)
	ran = nil
	if err := RunOperation(ctx, s, id2, 1, []Step{step("s1"), step("s2"), step("s3")}); err != nil {
		t.Fatal(err)
	}
	if len(ran) != 2 || ran[0] != "s2" || ran[1] != "s3" {
		t.Fatalf("resume ran %v, want [s2 s3]", ran)
	}
}

func TestResumeIncompletePolicies(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	resumeID, _ := s.CreateOperation(ctx, "resumable", "a", "{}")
	failID, _ := s.CreateOperation(ctx, "fragile", "b", "{}")
	var resumed atomic.Int64
	err := ResumeIncomplete(ctx, s,
		map[string]BootPolicy{"resumable": ResumeOnBoot, "fragile": FailForwardOnBoot},
		func(op store.Operation) []Step {
			return []Step{{Name: "only", Do: func(context.Context) error { resumed.Add(1); return nil }}}
		}, testLog())
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Load() != 1 {
		t.Fatalf("resumable ran %d times, want 1", resumed.Load())
	}
	if ops, _ := s.IncompleteOperations(ctx); len(ops) != 0 {
		t.Fatalf("both ops must be terminal, got %+v", ops)
	}
	_ = resumeID
	_ = failID
}
```

- [ ] **Step 2: RED** — `go test ./internal/runtime/` → compile failure. Capture.

- [ ] **Step 3: Implement the owner** (`internal/runtime/owner.go`)

```go
// Package runtime provides the owner framework: one goroutine per resource,
// an inbox that serializes every mutation for that resource, and a durable
// operation executor. The inbox is the ONLY path to convergence — anything
// that wants a resource reconciled (an API write, a boot, a future
// wake-on-connect) sends here; there are no side doors.
package runtime

import (
	"context"
	"log/slog"
)

type request struct {
	reply chan error // nil for coalesced nudges
}

type Owner struct {
	name  string
	conv  func(ctx context.Context) error
	log   *slog.Logger
	inbox chan request
	nudge chan struct{} // cap 1: pending-work flag, coalescing by construction
	done  chan struct{}
}

func NewOwner(name string, converge func(ctx context.Context) error, log *slog.Logger) *Owner {
	return &Owner{
		name:  name,
		conv:  converge,
		log:   log,
		inbox: make(chan request),
		nudge: make(chan struct{}, 1),
		done:  make(chan struct{}),
	}
}

func (o *Owner) Start(ctx context.Context) {
	go o.loop(ctx)
}

func (o *Owner) loop(ctx context.Context) {
	defer close(o.done)
	for {
		select {
		case <-ctx.Done():
			return
		case req := <-o.inbox:
			err := o.converge(ctx)
			req.reply <- err
		case <-o.nudge:
			if err := o.converge(ctx); err != nil {
				o.log.Error("converge failed", "owner", o.name, "err", err)
			}
		}
	}
}

func (o *Owner) converge(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			o.log.Error("converge panicked", "owner", o.name, "panic", r)
			err = context.Canceled // surfaced as an error; the loop survives
		}
	}()
	return o.conv(ctx)
}

// Do runs one converge synchronously through the inbox and returns its error.
func (o *Owner) Do(ctx context.Context) error {
	req := request{reply: make(chan error, 1)}
	select {
	case o.inbox <- req:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-req.reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Nudge requests a converge without waiting. Multiple nudges while the owner
// is busy coalesce into one pending converge.
func (o *Owner) Nudge() {
	select {
	case o.nudge <- struct{}{}:
	default: // already pending — coalesce
	}
}

// Wait blocks until the loop goroutine has exited (after ctx cancellation).
func (o *Owner) Wait() { <-o.done }
```

- [ ] **Step 4: Implement the operation executor** (`internal/runtime/operation.go`)

```go
package runtime

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Step is one resumable unit of a durable operation. Steps must be
// individually idempotent-enough to re-run after a crash that lost the
// cursor advance (the cursor is persisted AFTER the step succeeds, so the
// crash window re-executes at most one step).
type Step struct {
	Name string
	Do   func(ctx context.Context) error
}

type BootPolicy int

const (
	// ResumeOnBoot re-executes the operation from its persisted cursor.
	ResumeOnBoot BootPolicy = iota
	// FailForwardOnBoot marks the interrupted operation failed (terminal,
	// retryable by the caller) without running any step.
	FailForwardOnBoot
)

// RunOperation executes steps[startCursor:], persisting the cursor after each
// success. A step error finishes the operation as failed and returns the
// error; completion finishes it as done.
func RunOperation(ctx context.Context, s *store.Store, opID string, startCursor int, steps []Step) error {
	for i := startCursor; i < len(steps); i++ {
		if err := steps[i].Do(ctx); err != nil {
			ferr := fmt.Errorf("step %s: %w", steps[i].Name, err)
			_ = s.FinishOperation(ctx, opID, "failed", ferr.Error())
			return ferr
		}
		if err := s.AdvanceOperation(ctx, opID, i+1); err != nil {
			return err
		}
	}
	return s.FinishOperation(ctx, opID, "done", "")
}

// ResumeIncomplete applies each kind's boot policy to every non-terminal
// operation. Unknown kinds fail forward (safe default: never re-run work the
// current binary doesn't understand).
func ResumeIncomplete(ctx context.Context, s *store.Store, policy map[string]BootPolicy,
	steps func(op store.Operation) []Step, log *slog.Logger) error {
	ops, err := s.IncompleteOperations(ctx)
	if err != nil {
		return err
	}
	for _, op := range ops {
		switch p, ok := policy[op.Kind]; {
		case ok && p == ResumeOnBoot:
			log.Info("resuming interrupted operation", "kind", op.Kind, "id", op.ID, "cursor", op.StepCursor)
			if err := RunOperation(ctx, s, op.ID, op.StepCursor, steps(op)); err != nil {
				log.Error("resumed operation failed", "kind", op.Kind, "id", op.ID, "err", err)
			}
		default:
			log.Info("failing interrupted operation forward", "kind", op.Kind, "id", op.ID)
			if err := s.FinishOperation(ctx, op.ID, "failed", "interrupted by restart"); err != nil {
				return err
			}
		}
	}
	return nil
}
```

- [ ] **Step 5: GREEN** — `go test ./internal/runtime/ -v -race` → all pass (run this package with `-race` always: the serialization claim is the product). 

- [ ] **Step 6: Commit**

```bash
git add internal/runtime
git commit -m "feat: owner runtime — serialized converge inbox + durable operation executor"
```

---

### Task 5: internal/engine/process.go — the managed child process

> **AMENDED (A3, 2026-07-11, post-review):** the reference code below shipped with substantial,
> gate-verified corrections — read the repo as authoritative. (1) `-race` proved two races IN the
> reference (per-transition OnStateChange goroutines; killIfAlive's ProcessState read) — fixed to
> synchronous-under-lock dispatch (upheld by review: the ordered-transitions contract demands it;
> observers must offload, documented at the API) and unconditional signaling. (2) The reaper now
> joins scanners BEFORE cmd.Wait (StdoutPipe contract) with a bounded 300ms drain grace — the
> unbounded form deadlocks when a grandchild inherits the pipe (proven). (3) Signal-0 leader
> polling replaced by a reaper-owned `done` channel (PID-reuse + goroutine-leak class); group
> SIGKILL gated on leader-reaped. (4) A `terminating` handle prevents generation overlap — Start
> refuses while the previous child is still dying; failStart stashes survivors the same way.
> (5) Needle-check precedes the OnLine callback (a blocking observer can't stall readiness).
> (6) ErrTooLong stream survival, RecentLines clamp, observer API docs. Suite grew 8 → 14 tests
> incl. a companion fence test that genuinely pins the post-select fence on darwin (the
> reviewer-authored verbatim one demonstrably does not — kept anyway per adjudication).
> Deferred Minor: one OnLine doc clause (unbounded-blocking observer also stalls reaping/Stop).

This is the load-bearing supervision primitive. It carries three contracts that MUST survive review: (1) a late readiness needle after Stop() must NOT flip state back to running (the stop-during-start fence); (2) Stop escalates SIGTERM→SIGKILL on a deadline, with process-GROUP semantics when Detached; (3) observer callbacks (OnLine/OnStateChange) can never break the child lifecycle.

**Files:**
- Create: `internal/engine/process.go`, Test: `internal/engine/process_test.go`

**Interfaces:**
- Produces:
  ```go
  type ProcState string
  const ( StateStopped ProcState = "stopped"; StateStarting ProcState = "starting"
          StateRunning ProcState = "running"; StateFailed ProcState = "failed" )
  type ProcOpts struct {
      Name, Bin string; Args, Env []string
      ReadyNeedle string; ReadyTimeout time.Duration // default 60s
      Detached bool                                   // own process group + group kill
      OnLine func(line string); OnStateChange func(s ProcState)
  }
  func NewProcess(opts ProcOpts) *Process
  func (p *Process) Start(ctx context.Context) error
  func (p *Process) Stop(timeout time.Duration)     // total: never returns error
  func (p *Process) State() ProcState
  func (p *Process) PID() *int                       // nil when no live child
  func (p *Process) RecentLines(n int) []string      // last n of a 500-line ring
  ```

- [ ] **Step 1: Write the failing tests** (`internal/engine/process_test.go` — hermetic: children are `/bin/sh` scripts)

```go
package engine

import (
	"context"
	"strings"
	"syscall"
	"testing"
	"time"
)

func shProc(t *testing.T, script string, needle string, mut func(*ProcOpts)) *Process {
	t.Helper()
	opts := ProcOpts{
		Name: "t", Bin: "/bin/sh", Args: []string{"-c", script},
		ReadyNeedle: needle, ReadyTimeout: 5 * time.Second,
	}
	if mut != nil {
		mut(&opts)
	}
	return NewProcess(opts)
}

func TestStartBecomesRunningOnNeedle(t *testing.T) {
	p := shProc(t, `echo booting; echo READY; sleep 30`, "READY", nil)
	if err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer p.Stop(2 * time.Second)
	if p.State() != StateRunning || p.PID() == nil {
		t.Fatalf("state=%s pid=%v", p.State(), p.PID())
	}
	if got := p.RecentLines(10); !strings.Contains(strings.Join(got, "\n"), "booting") {
		t.Fatalf("ring missing output: %v", got)
	}
}

func TestStartFailsWhenChildExitsBeforeNeedle(t *testing.T) {
	p := shProc(t, `echo nope; exit 3`, "READY", nil)
	err := p.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("err = %v", err)
	}
	if p.State() != StateFailed {
		t.Fatalf("state = %s, want failed", p.State())
	}
}

func TestStartTimesOut(t *testing.T) {
	p := shProc(t, `sleep 30`, "NEVER", func(o *ProcOpts) { o.ReadyTimeout = 200 * time.Millisecond })
	err := p.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	if p.State() != StateFailed || p.PID() != nil {
		t.Fatalf("state=%s pid=%v (child must be killed + cleared)", p.State(), p.PID())
	}
}

// THE stop-during-start fence: Stop() lands while Start is awaiting the
// needle; the needle then appears. Start must return an error, state must
// stay "stopped", and no running-with-nil-child contradiction may exist.
func TestStopDuringStartDiscardsLateReadiness(t *testing.T) {
	p := shProc(t, `sleep 1; echo READY; sleep 30`, "READY", nil)
	errCh := make(chan error, 1)
	go func() { errCh <- p.Start(context.Background()) }()
	time.Sleep(100 * time.Millisecond) // Start is now awaiting the needle
	p.Stop(2 * time.Second)
	err := <-errCh
	if err == nil {
		t.Fatal("Start must not report success after an intervening Stop")
	}
	if p.State() != StateStopped {
		t.Fatalf("state = %s, want stopped (no clobber)", p.State())
	}
}

func TestCrashAfterRunningFlipsToFailed(t *testing.T) {
	var transitions []ProcState
	p := shProc(t, `echo READY; sleep 0.2; exit 7`, "READY", func(o *ProcOpts) {
		o.OnStateChange = func(s ProcState) { transitions = append(transitions, s) }
	})
	if err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for p.State() != StateFailed && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if p.State() != StateFailed {
		t.Fatalf("state = %s, want failed after crash", p.State())
	}
	want := []ProcState{StateStarting, StateRunning, StateFailed}
	if len(transitions) != 3 || transitions[0] != want[0] || transitions[1] != want[1] || transitions[2] != want[2] {
		t.Fatalf("transitions = %v, want %v", transitions, want)
	}
}

func TestStopEscalatesToSigkill(t *testing.T) {
	// The child traps+ignores SIGTERM; only SIGKILL can end it.
	p := shProc(t, `trap '' TERM; echo READY; while true; do sleep 0.1; done`, "READY", nil)
	if err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	pid := *p.PID()
	start := time.Now()
	p.Stop(300 * time.Millisecond)
	// After escalation the process must actually be gone.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if syscall.Kill(pid, 0) == nil {
		t.Fatalf("pid %d still alive after escalated stop", pid)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("stop took far longer than its deadline")
	}
}

// Detached: the child forks a grandchild into the same process group; a group
// stop must take BOTH down even though only the leader gets waited on.
func TestDetachedStopKillsProcessGroup(t *testing.T) {
	p := shProc(t, `sleep 60 & echo READY; wait`, "READY", func(o *ProcOpts) { o.Detached = true })
	if err := p.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	pgid := *p.PID() // leader's pid == pgid when Setpgid
	p.Stop(500 * time.Millisecond)
	deadline := time.Now().Add(3 * time.Second)
	gone := false
	for time.Now().Before(deadline) {
		if syscall.Kill(-pgid, 0) != nil {
			gone = true
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if !gone {
		t.Fatalf("process group %d still has live members after detached stop", pgid)
	}
}

func TestObserverPanicsAreSwallowed(t *testing.T) {
	p := shProc(t, `echo READY; sleep 30`, "READY", func(o *ProcOpts) {
		o.OnLine = func(string) { panic("observer bug") }
		o.OnStateChange = func(ProcState) { panic("observer bug") }
	})
	if err := p.Start(context.Background()); err != nil {
		t.Fatalf("observer panic broke the lifecycle: %v", err)
	}
	p.Stop(2 * time.Second)
}
```

- [ ] **Step 2: RED** — `go test ./internal/engine/ -run TestStart` → compile failure. Capture.

- [ ] **Step 3: Implement** (`internal/engine/process.go`)

```go
// Package engine supervises the storage-engine child processes.
package engine

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ProcState string

const (
	StateStopped  ProcState = "stopped"
	StateStarting ProcState = "starting"
	StateRunning  ProcState = "running"
	StateFailed   ProcState = "failed"
)

type ProcOpts struct {
	Name, Bin     string
	Args, Env     []string
	ReadyNeedle   string
	ReadyTimeout  time.Duration // default 60s
	Detached      bool          // own process group; Stop signals the whole group
	OnLine        func(line string)
	OnStateChange func(s ProcState)
}

const ringSize = 500

type Process struct {
	opts ProcOpts

	mu    sync.Mutex
	state ProcState
	pid   int
	cmd   *exec.Cmd // identity fence: callbacks compare against this pointer
	ring  []string
}

func NewProcess(opts ProcOpts) *Process {
	if opts.ReadyTimeout == 0 {
		opts.ReadyTimeout = 60 * time.Second
	}
	return &Process{opts: opts, state: StateStopped}
}

func (p *Process) State() ProcState { p.mu.Lock(); defer p.mu.Unlock(); return p.state }

func (p *Process) PID() *int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd == nil {
		return nil
	}
	pid := p.pid
	return &pid
}

func (p *Process) RecentLines(n int) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > len(p.ring) {
		n = len(p.ring)
	}
	return append([]string(nil), p.ring[len(p.ring)-n:]...)
}

// setStateLocked is the sole writer of p.state. Distinct transitions only;
// the observer runs outside the lock and its panics are swallowed — an
// observer must never break the child lifecycle.
func (p *Process) setStateLocked(s ProcState) {
	if p.state == s {
		return
	}
	p.state = s
	cb := p.opts.OnStateChange
	if cb != nil {
		go func() {
			defer func() { _ = recover() }()
			cb(s)
		}()
	}
}

func (p *Process) ingest(line string) {
	p.mu.Lock()
	p.ring = append(p.ring, line)
	if len(p.ring) > ringSize {
		p.ring = p.ring[1:]
	}
	cb := p.opts.OnLine
	p.mu.Unlock()
	if cb != nil {
		func() {
			defer func() { _ = recover() }()
			cb(line)
		}()
	}
}

func (p *Process) Start(ctx context.Context) error {
	p.mu.Lock()
	if p.state == StateRunning || p.state == StateStarting {
		st := p.state
		p.mu.Unlock()
		return fmt.Errorf("%s already %s", p.opts.Name, st)
	}
	p.setStateLocked(StateStarting)

	cmd := exec.Command(p.opts.Bin, p.opts.Args...)
	cmd.Env = p.opts.Env
	if p.opts.Detached {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
	stdout, err1 := cmd.StdoutPipe()
	stderr, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil {
		p.setStateLocked(StateFailed)
		p.mu.Unlock()
		return fmt.Errorf("%s: pipe: %v %v", p.opts.Name, err1, err2)
	}
	if err := cmd.Start(); err != nil {
		p.setStateLocked(StateFailed)
		p.mu.Unlock()
		return fmt.Errorf("%s: spawn failed: %w", p.opts.Name, err)
	}
	p.cmd = cmd
	p.pid = cmd.Process.Pid
	p.mu.Unlock()

	ready := make(chan struct{})
	failed := make(chan error, 2)
	var seenOnce sync.Once

	scan := func(r interface{ Read([]byte) (int, error) }) {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			p.ingest(line)
			if strings.Contains(line, p.opts.ReadyNeedle) {
				seenOnce.Do(func() { close(ready) })
			}
		}
	}
	go scan(stdout)
	go scan(stderr)

	// Reaper: exactly one Wait per child. On exit — whoever still owns the
	// identity — clear fields and flip running→failed (a crash after
	// readiness). If the needle never came, fail the awaiting Start.
	go func() {
		werr := cmd.Wait()
		select {
		case <-ready:
		default:
			failed <- fmt.Errorf("%s: exited before ready (%v). Last output:\n%s",
				p.opts.Name, werr, strings.Join(p.RecentLines(20), "\n"))
		}
		p.mu.Lock()
		if p.cmd == cmd {
			p.cmd = nil
			p.pid = 0
			if p.state == StateRunning {
				p.setStateLocked(StateFailed)
			}
		}
		p.mu.Unlock()
	}()

	timer := time.NewTimer(p.opts.ReadyTimeout)
	defer timer.Stop()

	select {
	case <-ready:
	case err := <-failed:
		p.failStart(cmd, err)
		return err
	case <-timer.C:
		err := fmt.Errorf("%s: timed out waiting for %q after %s", p.opts.Name, p.opts.ReadyNeedle, p.opts.ReadyTimeout)
		p.failStart(cmd, err)
		return err
	case <-ctx.Done():
		p.failStart(cmd, ctx.Err())
		return ctx.Err()
	}

	// The stop-during-start fence: Stop() may have claimed the transition
	// ("stopped") while we awaited the needle — the needle can appear strictly
	// after Stop when the child survives SIGTERM long enough to print it.
	// Claiming "running" here would leave state=running with cmd already
	// cleared by Stop. Fence on BOTH the state token and the child identity.
	p.mu.Lock()
	if p.state != StateStarting || p.cmd != cmd {
		p.mu.Unlock()
		p.killIfAlive(cmd, syscall.SIGKILL)
		return fmt.Errorf("%s: stop intervened during startup; discarding late readiness", p.opts.Name)
	}
	p.setStateLocked(StateRunning)
	p.mu.Unlock()
	return nil
}

// failStart is Start's unwind: preserve a Stop()-claimed state (no failed
// clobber), clear the identity if still ours, and kill a survivor NOW.
func (p *Process) failStart(cmd *exec.Cmd, _ error) {
	p.mu.Lock()
	if p.state == StateStarting {
		p.setStateLocked(StateFailed)
	}
	if p.cmd == cmd {
		p.cmd = nil
		p.pid = 0
	}
	p.mu.Unlock()
	p.killIfAlive(cmd, syscall.SIGKILL)
}

func (p *Process) killIfAlive(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	if cmd.ProcessState != nil { // already reaped
		return
	}
	pid := cmd.Process.Pid
	if p.opts.Detached {
		_ = syscall.Kill(-pid, sig)
	} else {
		_ = cmd.Process.Signal(sig)
	}
}

// Stop is total: it claims the state, SIGTERMs, escalates to SIGKILL at the
// deadline, and — when Detached — verifies the whole PROCESS GROUP is gone
// (the leader exiting is not sufficient: a leader can orphan group members
// that ignore SIGTERM; only a group SIGKILL reaches them).
func (p *Process) Stop(timeout time.Duration) {
	p.mu.Lock()
	cmd := p.cmd
	pid := p.pid
	p.setStateLocked(StateStopped)
	p.cmd = nil
	p.pid = 0
	p.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}

	term := func(sig syscall.Signal) {
		if p.opts.Detached && pid != 0 {
			_ = syscall.Kill(-pid, sig)
		} else {
			_ = cmd.Process.Signal(sig)
		}
	}
	exited := make(chan struct{})
	go func() { // observe the (already-reaped-by-reaper) child via signal 0 polling
		for {
			if syscall.Kill(pid, 0) != nil {
				close(exited)
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
	}()

	deadline := time.Now().Add(timeout)
	term(syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(timeout):
		term(syscall.SIGKILL)
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
		}
	}
	if !p.opts.Detached || pid == 0 {
		return
	}
	// Group phase: poll group emptiness to the same deadline, escalate once.
	groupGone := func() bool { return syscall.Kill(-pid, 0) != nil }
	for !groupGone() && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !groupGone() {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		confirm := time.Now().Add(time.Second)
		for !groupGone() && time.Now().Before(confirm) {
			time.Sleep(50 * time.Millisecond)
		}
	}
}
```

- [ ] **Step 4: GREEN** — `go test ./internal/engine/ -race -v` → all pass. Fix any race the detector finds BEFORE review (the mutex discipline above is the deliverable).

- [ ] **Step 5: Commit**

```bash
git add internal/engine/process.go internal/engine/process_test.go
git commit -m "feat: managed child process — needle readiness, stop fences, group kill"
```

---

### Task 6: internal/engine — specs, dirs, and the tracer sink

> **AMENDED (A6, 2026-07-11, post-review):** the tracer reference code below carries a CONFIRMED
> crash bug — `Start`'s goroutine re-reads the `t.server` FIELD while `Stop` nils it
> unsynchronized (reviewer repro: `-race` + nil-deref SIGSEGV in a tight Start/Stop loop; the
> boot fail-fast teardown is the live trigger window). Fixed: locals captured, mutex-guarded
> lifecycle mirroring `Process`'s idiom, idempotent Stop, lifecycle tests. Also: the sink's body
> drain is bounded (MaxBytesReader 10 MiB), and `tomlString` escapes the full TOML control-char
> set (\n, \r, \t, <0x20 as \uXXXX) with table-driven tests. Repo authoritative over the blocks
> below.

**Files:**
- Create: `internal/engine/specs.go`, `internal/engine/tracer.go`, Tests: `internal/engine/specs_test.go`, `internal/engine/tracer_test.go`

**Interfaces:**
- Consumes: `config.Config` (Task 2).
- Produces:
  ```go
  type Dirs struct{ PageserverDir, PageserverLayers, SafekeeperDir, CatalogDBDir, LogsDir, ComputesDir string }
  func EngineDirs(dataDir string) Dirs
  type Spec struct{ Name, Bin string; Args []string; ReadyNeedle string }
  func BrokerSpec(cfg *config.Config) Spec
  func StorconSpec(cfg *config.Config, dbURI string) Spec
  func SafekeeperSpec(cfg *config.Config) Spec
  func PageserverSpec(cfg *config.Config) Spec
  func PageserverToml(cfg *config.Config) string
  func PageserverIdentityToml() string
  func PageserverMetadataJSON(cfg *config.Config) (string, error)
  func SafekeeperRegistrationBody(cfg *config.Config, nowISO string) map[string]any
  func NewTracer(port int, onLine func(string)) *Tracer
  func (t *Tracer) Start() error / Stop() / BoundPort() int
  ```
- **Parity constraint:** `CatalogDBDir` MUST be `<dataDir>/daemon_data/storage_controller_pg_data` (the integration suite reads that exact path).

- [ ] **Step 1: Write the failing tests** (`internal/engine/specs_test.go`)

```go
package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

func testCfg(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load(func(k string) string {
		return map[string]string{
			"WORKTREEDB_DATA_DIR":       "/data",
			"WORKTREEDB_NEON_BIN_DIR":   "/usr/local/share/neon/bin",
			"WORKTREEDB_PG_INSTALL_DIR": "/usr/local/share/neon/pg_install",
		}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestEngineDirsLayout(t *testing.T) {
	d := EngineDirs("/data")
	if d.CatalogDBDir != "/data/daemon_data/storage_controller_pg_data" {
		t.Fatalf("CatalogDBDir = %s (parity path)", d.CatalogDBDir)
	}
	if d.PageserverDir != "/data/pageserver" || d.PageserverLayers != "/data/pageserver_1" ||
		d.SafekeeperDir != "/data/safekeeper" || d.LogsDir != "/data/logs" || d.ComputesDir != "/data/computes" {
		t.Fatalf("dirs = %+v", d)
	}
}

func TestSpecsCarryOracleValues(t *testing.T) {
	cfg := testCfg(t)
	b := BrokerSpec(cfg)
	if b.Bin != "/usr/local/share/neon/bin/storage_broker" || b.Args[0] != "-l" || b.Args[1] != "127.0.0.1:50051" || b.ReadyNeedle != "listening" {
		t.Fatalf("broker = %+v", b)
	}
	s := StorconSpec(cfg, "postgresql://u:p@127.0.0.1:5431/postgres")
	joined := strings.Join(s.Args, " ")
	for _, want := range []string{"-l 127.0.0.1:1234", "--database-url postgresql://", "--dev",
		"--timeline-safekeeper-count 1", "--timelines-onto-safekeepers", "--control-plane-url http://127.0.0.1:4318"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("storcon args missing %q: %s", want, joined)
		}
	}
	if s.ReadyNeedle != "Serving HTTP on 127.0.0.1:1234" {
		t.Fatalf("storcon needle = %q", s.ReadyNeedle)
	}
	sk := SafekeeperSpec(cfg)
	if !strings.Contains(strings.Join(sk.Args, " "), "--availability-zone worktreedb-1") ||
		sk.ReadyNeedle != "starting safekeeper WAL service on" {
		t.Fatalf("safekeeper = %+v", sk)
	}
	ps := PageserverSpec(cfg)
	if ps.ReadyNeedle != "Starting pageserver http handler on 127.0.0.1:9898" {
		t.Fatalf("pageserver needle = %q", ps.ReadyNeedle)
	}
}

func TestPageserverToml(t *testing.T) {
	toml := PageserverToml(testCfg(t))
	for _, want := range []string{
		`availability_zone = "worktreedb-1"`,
		`pg_distrib_dir = "/usr/local/share/neon/pg_install"`,
		`broker_endpoint = "http://127.0.0.1:50051/"`,
		`listen_pg_addr = "127.0.0.1:64000"`,
		`listen_http_addr = "127.0.0.1:9898"`,
		`control_plane_api = "http://127.0.0.1:1234/upcall/v1/"`,
		`local_path = "/data/pageserver_1"`,
		`[disk_usage_based_eviction]`,
	} {
		if !strings.Contains(toml, want) {
			t.Fatalf("toml missing %q:\n%s", want, toml)
		}
	}
}

func TestPageserverMetadataAndIdentity(t *testing.T) {
	if PageserverIdentityToml() != "id = 1\n" {
		t.Fatal("identity toml drifted")
	}
	raw, err := PageserverMetadataJSON(testCfg(t))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if m["host"] != "127.0.0.1" || m["http_port"] != float64(9898) || m["port"] != float64(64000) {
		t.Fatalf("metadata = %v", m)
	}
}

func TestSafekeeperRegistrationBody(t *testing.T) {
	body := SafekeeperRegistrationBody(testCfg(t), "2026-01-01T00:00:00Z")
	if body["id"] != 1 || body["host"] != "127.0.0.1" || body["port"] != 5454 ||
		body["http_port"] != 7676 || body["availability_zone_id"] != "worktreedb-1" {
		t.Fatalf("body = %v", body)
	}
}
```

And `internal/engine/tracer_test.go`:

```go
package engine

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// The sink answers ANY method + path with 200 "{}" so the engine's OTLP
// exports and the storage controller's control-plane upcalls never see a
// dead port (they retry-loop loudly otherwise).
func TestTracerAbsorbsAnything(t *testing.T) {
	tr := NewTracer(0, nil) // port 0: OS-assigned, tests never contend for 4318
	if err := tr.Start(); err != nil {
		t.Fatal(err)
	}
	defer tr.Stop()
	base := "http://127.0.0.1"
	for _, req := range []struct{ method, path string }{
		{"POST", "/v1/traces"}, {"PUT", "/notify-attach"}, {"GET", "/anything/at/all"},
	} {
		r, _ := http.NewRequest(req.method, base+portSuffix(tr.BoundPort())+req.path, strings.NewReader(`{"x":1}`))
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || string(body) != "{}" {
			t.Fatalf("%s %s → %d %q", req.method, req.path, res.StatusCode, body)
		}
	}
}

func portSuffix(p int) string { return ":" + itoa(p) }

func itoa(p int) string { // tiny helper avoids strconv import noise in the test
	return string(appendInt(nil, p))
}

func appendInt(b []byte, p int) []byte {
	if p >= 10 {
		b = appendInt(b, p/10)
	}
	return append(b, byte('0'+p%10))
}
```

- [ ] **Step 2: RED** — `go test ./internal/engine/ -run 'TestEngineDirs|TestSpecs|TestTracer'` → compile failure. Capture.

- [ ] **Step 3: Implement specs** (`internal/engine/specs.go`)

```go
package engine

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

// Dirs are the engine's on-volume directories. CatalogDBDir hosts the storage
// controller's own catalog database.
type Dirs struct {
	PageserverDir, PageserverLayers, SafekeeperDir, CatalogDBDir, LogsDir, ComputesDir string
}

func EngineDirs(dataDir string) Dirs {
	return Dirs{
		PageserverDir:    filepath.Join(dataDir, "pageserver"),
		PageserverLayers: filepath.Join(dataDir, "pageserver_1"),
		SafekeeperDir:    filepath.Join(dataDir, "safekeeper"),
		CatalogDBDir:     filepath.Join(dataDir, "daemon_data", "storage_controller_pg_data"),
		LogsDir:          filepath.Join(dataDir, "logs"),
		ComputesDir:      filepath.Join(dataDir, "computes"),
	}
}

// Spec describes one supervised engine child.
type Spec struct {
	Name, Bin   string
	Args        []string
	ReadyNeedle string
}

const availabilityZone = "worktreedb-1"

func tomlString(v string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
}

// oracle: neon control_plane/src/pageserver.rs pageserver_init_make_toml (auth keys omitted —
// every engine port binds to 127.0.0.1 inside the container; upstream neon_local runs this exact
// stack in trust mode by default).
func PageserverToml(cfg *config.Config) string {
	d := EngineDirs(cfg.DataDir)
	return strings.Join([]string{
		fmt.Sprintf("availability_zone = %s", tomlString(availabilityZone)),
		fmt.Sprintf("pg_distrib_dir = %s", tomlString(cfg.PgInstallDir)),
		fmt.Sprintf(`broker_endpoint = "http://127.0.0.1:%d/"`, cfg.Engine.Broker),
		fmt.Sprintf(`listen_pg_addr = "127.0.0.1:%d"`, cfg.Engine.PageserverPg),
		fmt.Sprintf(`listen_http_addr = "127.0.0.1:%d"`, cfg.Engine.PageserverHTTP),
		fmt.Sprintf(`control_plane_api = "http://127.0.0.1:%d/upcall/v1/"`, cfg.Engine.Storcon),
		"",
		"[remote_storage]",
		fmt.Sprintf("local_path = %s", tomlString(d.PageserverLayers)),
		"",
		"[disk_usage_based_eviction]",
		"enabled = true",
		"max_usage_pct = 100",
		"min_avail_bytes = 2000000000",
		"",
	}, "\n")
}

// oracle: identity.toml content — "id = 1"
func PageserverIdentityToml() string { return "id = 1\n" }

// oracle: neon control_plane/src/pageserver.rs start() metadata.json write →
// pageserver_api::config::NodeMetadata
func PageserverMetadataJSON(cfg *config.Config) (string, error) {
	b, err := json.Marshal(map[string]any{
		"host": "127.0.0.1", "http_host": "127.0.0.1",
		"http_port": cfg.Engine.PageserverHTTP, "port": cfg.Engine.PageserverPg,
	})
	return string(b), err
}

// oracle: neon control_plane/src/broker.rs start()
func BrokerSpec(cfg *config.Config) Spec {
	return Spec{
		Name: "storage_broker",
		Bin:  filepath.Join(cfg.NeonBinDir, "storage_broker"),
		Args: []string{"-l", fmt.Sprintf("127.0.0.1:%d", cfg.Engine.Broker)},
		ReadyNeedle: "listening",
	}
}

// oracle: neon control_plane/src/storage_controller.rs start() (JWT args omitted — trust mode).
// --control-plane-url targets the daemon's catch-all sink (Tracer) so compute-notify upcalls
// never hit a dead port.
func StorconSpec(cfg *config.Config, dbURI string) Spec {
	return Spec{
		Name: "storage_controller",
		Bin:  filepath.Join(cfg.NeonBinDir, "storage_controller"),
		Args: []string{
			"-l", fmt.Sprintf("127.0.0.1:%d", cfg.Engine.Storcon),
			"--database-url", dbURI,
			"--dev",
			"--timeline-safekeeper-count", "1",
			"--timelines-onto-safekeepers",
			"--control-plane-url", fmt.Sprintf("http://127.0.0.1:%d", cfg.Engine.Tracer),
		},
		ReadyNeedle: fmt.Sprintf("Serving HTTP on 127.0.0.1:%d", cfg.Engine.Storcon),
	}
}

// oracle: neon control_plane/src/safekeeper.rs start() (auth key paths omitted — trust mode)
func SafekeeperSpec(cfg *config.Config) Spec {
	return Spec{
		Name: "safekeeper",
		Bin:  filepath.Join(cfg.NeonBinDir, "safekeeper"),
		Args: []string{
			"-D", EngineDirs(cfg.DataDir).SafekeeperDir,
			"--id", "1",
			"--broker-endpoint", fmt.Sprintf("http://127.0.0.1:%d", cfg.Engine.Broker),
			"--listen-pg", fmt.Sprintf("127.0.0.1:%d", cfg.Engine.SafekeeperPg),
			"--listen-http", fmt.Sprintf("127.0.0.1:%d", cfg.Engine.SafekeeperHTTP),
			"--availability-zone", availabilityZone,
		},
		ReadyNeedle: "starting safekeeper WAL service on",
	}
}

// oracle: neon control_plane/src/pageserver.rs start() (NEON_AUTH_TOKEN omitted — trust mode)
func PageserverSpec(cfg *config.Config) Spec {
	return Spec{
		Name:        "pageserver",
		Bin:         filepath.Join(cfg.NeonBinDir, "pageserver"),
		Args:        []string{"-D", EngineDirs(cfg.DataDir).PageserverDir},
		ReadyNeedle: fmt.Sprintf("Starting pageserver http handler on 127.0.0.1:%d", cfg.Engine.PageserverHTTP),
	}
}

// oracle: neon control_plane/src/storage_controller.rs register_safekeepers body shape
func SafekeeperRegistrationBody(cfg *config.Config, nowISO string) map[string]any {
	return map[string]any{
		"id": 1, "region_id": availabilityZone, "host": "127.0.0.1",
		"port": cfg.Engine.SafekeeperPg, "http_port": cfg.Engine.SafekeeperHTTP,
		"version": 1, "availability_zone_id": availabilityZone,
		"created_at": nowISO, "updated_at": nowISO,
	}
}
```

- [ ] **Step 4: Implement the tracer** (`internal/engine/tracer.go`)

```go
package engine

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Tracer is the daemon's catch-all sink on the OTLP port: it absorbs the
// engine binaries' OTLP trace exports AND the storage controller's
// control-plane upcalls (both target the same port), answering ANY method +
// path with 200 "{}" so neither client retry-loops against a dead port.
// Loopback-only, like every engine port.
type Tracer struct {
	port     int
	onLine   func(string)
	listener net.Listener
	server   *http.Server
}

func NewTracer(port int, onLine func(string)) *Tracer {
	return &Tracer{port: port, onLine: onLine}
}

func (t *Tracer) Start() error {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", t.port))
	if err != nil {
		return err
	}
	t.listener = ln
	t.server = &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body) // drain so the socket recycles
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{}"))
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = t.server.Serve(ln) }()
	if t.onLine != nil {
		t.onLine(fmt.Sprintf("listening on 127.0.0.1:%d", t.BoundPort()))
	}
	return nil
}

func (t *Tracer) BoundPort() int {
	if t.listener == nil {
		return t.port
	}
	return t.listener.Addr().(*net.TCPAddr).Port
}

func (t *Tracer) Stop() {
	if t.server != nil {
		_ = t.server.Close() // Close (not Shutdown): engine holds keep-alives; don't hang teardown
	}
	t.server = nil
	t.listener = nil
}
```

- [ ] **Step 5: GREEN** — `go test ./internal/engine/ -race` → all pass (including Task 5's).

- [ ] **Step 6: Commit**

```bash
git add internal/engine/specs.go internal/engine/specs_test.go internal/engine/tracer.go internal/engine/tracer_test.go
git commit -m "feat: engine process specs, on-volume layout, and the trace/upcall sink"
```

---

### Task 7: internal/engine/catalogdb.go — the storage controller's catalog postgres

> **AMENDED (A7, 2026-07-11, post-review):** repo authoritative over the blocks below. The
> reference `Init` had a CRITICAL destructive fallthrough — ANY `os.Stat(PG_VERSION)` failure
> (not just absence) proceeded to clear the whole data dir; now only `os.IsNotExist` clears,
> anything else errors (`checking for existing catalog data: …`, ENOTDIR-tested). Stale-pid
> removal logs honestly (success vs distinct failure line; parity substring kept) and carries
> the full ownership argument (exclusive data-dir `.lock` = the cross-container authority;
> boot-only; running-guard). `ConnectionURI` is net/url-built (url.UserPassword — hex case
> byte-identical to the old format). The refusal message drops the trailing period (ST1005;
> parity substrings unaffected). +5 tests (ENOTDIR, pid-removal failure, fresh-dir silence,
> vanilla-fallback WARN, URI table).

The storage controller keeps its metadata in its own PostgreSQL instance, hosted from the true-upstream `pg_install/vanilla_v17` tree in the engine image. This task carries three battle-tested contracts: the **catalog-major guard** (refuse a volume initdb'd by a different PostgreSQL major — with the exact parity strings), the **stale postmaster.pid removal** (unclean container stops orphan it; PID reuse then blocks the next boot), and **no unix socket** (`/tmp` persists across container restarts, so the socket lock file would be a second stale-lock class — disable the socket entirely).

**Files:**
- Create: `internal/engine/catalogdb.go`, Test: `internal/engine/catalogdb_test.go`

**Interfaces:**
- Consumes: `Process` (Task 5), `EngineDirs` (Task 6).
- Produces:
  ```go
  func ResolveCatalogPgDir(pgInstallDir string) (string, error)  // vanilla_v17, else highest vN (warned)
  func ParsePgVersionFileMajor(content string) (int, bool)
  func ParsePostgresVersionMajor(output string) (int, bool)
  type CatalogDB struct{ ... }
  type CatalogOpts struct {
      Name, DataDir, PgInstallDir string; Port int; Password string
      OnLine func(string)
      ProbeBinaryMajor func(ctx context.Context) (int, bool) // test seam; nil = real probe
      RunCmd func(ctx context.Context, bin string, args []string, env []string) (string, error) // test seam; nil = exec
  }
  func NewCatalogDB(opts CatalogOpts) (*CatalogDB, error)
  func (c *CatalogDB) ConnectionURI() string   // postgresql://worktreedb:<pw>@127.0.0.1:<port>/postgres
  func (c *CatalogDB) Init(ctx context.Context) error
  func (c *CatalogDB) Start(ctx context.Context) error
  func (c *CatalogDB) Stop(timeout time.Duration)
  func (c *CatalogDB) State() ProcState
  func (c *CatalogDB) PID() *int
  ```

- [ ] **Step 1: Write the failing tests** (`internal/engine/catalogdb_test.go`)

```go
package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePgVersionFileMajor(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{{"17\n", 17, true}, {"19devel\n", 19, true}, {" 14 ", 14, true}, {"", 0, false}, {"junk", 0, false}} {
		got, ok := ParsePgVersionFileMajor(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("%q → (%d,%v), want (%d,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParsePostgresVersionMajor(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"postgres (PostgreSQL) 17.5", 17, true},
		{"postgres (PostgreSQL) 19devel", 19, true},
		{"postgres (PostgreSQL) 17.5 (deadbeef)", 17, true},
		{"nonsense 42", 42, true},
		{"nonsense", 0, false},
	} {
		got, ok := ParsePostgresVersionMajor(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("%q → (%d,%v), want (%d,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestResolveCatalogPgDirPrefersVanilla(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"v14", "v17", "vanilla_v17"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ResolveCatalogPgDir(root)
	if err != nil || got != filepath.Join(root, "vanilla_v17") {
		t.Fatalf("got %q err=%v", got, err)
	}
	// Without vanilla: highest vN wins (fallback keeps a broken image bootable;
	// the caller warns loudly).
	_ = os.RemoveAll(filepath.Join(root, "vanilla_v17"))
	got, err = ResolveCatalogPgDir(root)
	if err != nil || got != filepath.Join(root, "v17") {
		t.Fatalf("fallback got %q err=%v", got, err)
	}
}

func guardCatalog(t *testing.T, dataDir string, binaryMajor int, lines *[]string) *CatalogDB {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "vanilla_v17", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	c, err := NewCatalogDB(CatalogOpts{
		Name: "storcon_db", DataDir: dataDir, PgInstallDir: root, Port: 5431, Password: "pw",
		OnLine:           func(l string) { *lines = append(*lines, l) },
		ProbeBinaryMajor: func(context.Context) (int, bool) { return binaryMajor, true },
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// The guard: PG_VERSION exists and parses to a DIFFERENT major than the
// shipped binary → Start refuses BEFORE spawning, with the actionable
// message (parity strings asserted here character-for-character).
func TestGuardRefusesForeignMajor(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "PG_VERSION"), []byte("99\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var lines []string
	c := guardCatalog(t, dataDir, 17, &lines)
	err := c.Start(context.Background())
	if err == nil {
		t.Fatal("want refusal")
	}
	msg := err.Error()
	for _, want := range []string{
		"storage_controller catalog was created by PostgreSQL 99",
		"this image ships PostgreSQL 17",
		"fresh volume",
		"previous image",
		"import/export (Phase 4)",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("refusal missing %q:\n%s", want, msg)
		}
	}
}

// Fail-open cases: unreadable/unparsable PG_VERSION, or an unknown binary
// major, SKIP the guard (postgres's own catalog check is the backstop). The
// spawn will then fail in these unit tests (no real postgres) — assert the
// failure is NOT the guard's.
func TestGuardFailsOpen(t *testing.T) {
	t.Run("unparsable PG_VERSION", func(t *testing.T) {
		dataDir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dataDir, "PG_VERSION"), []byte("garbage"), 0o644)
		var lines []string
		c := guardCatalog(t, dataDir, 17, &lines)
		err := c.Start(context.Background())
		if err != nil && strings.Contains(err.Error(), "catalog was created") {
			t.Fatalf("guard fired on unparsable file: %v", err)
		}
		joined := strings.Join(lines, "\n")
		if !strings.Contains(joined, "skipping catalog-major guard") {
			t.Fatalf("expected a skip log, got: %s", joined)
		}
	})
	t.Run("unknown binary major", func(t *testing.T) {
		dataDir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dataDir, "PG_VERSION"), []byte("99\n"), 0o644)
		root := t.TempDir()
		_ = os.MkdirAll(filepath.Join(root, "vanilla_v17", "bin"), 0o755)
		var lines []string
		c, _ := NewCatalogDB(CatalogOpts{
			Name: "storcon_db", DataDir: dataDir, PgInstallDir: root, Port: 5431, Password: "pw",
			OnLine:           func(l string) { lines = append(lines, l) },
			ProbeBinaryMajor: func(context.Context) (int, bool) { return 0, false },
		})
		err := c.Start(context.Background())
		if err != nil && strings.Contains(err.Error(), "catalog was created") {
			t.Fatalf("guard fired without a known binary major: %v", err)
		}
	})
}

// A matching major proceeds past the guard AND removes a stale
// postmaster.pid first, logging a line that contains the parity substring
// "stale postmaster.pid".
func TestStalePidFileRemovedBeforeStart(t *testing.T) {
	dataDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dataDir, "PG_VERSION"), []byte("17\n"), 0o644)
	pidPath := filepath.Join(dataDir, "postmaster.pid")
	_ = os.WriteFile(pidPath, []byte("12345\n"), 0o644)
	var lines []string
	c := guardCatalog(t, dataDir, 17, &lines)
	_ = c.Start(context.Background()) // spawn fails (no real postgres) — irrelevant here
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatal("stale postmaster.pid not removed")
	}
	if !strings.Contains(strings.Join(lines, "\n"), "stale postmaster.pid") {
		t.Fatalf("missing removal log: %v", lines)
	}
}

// Init on a dir with no PG_VERSION but leftover content clears it first
// (initdb refuses non-empty dirs), then runs initdb via the RunCmd seam with
// the scram flags and the worktreedb superuser.
func TestInitClearsInterruptedDirAndRunsInitdb(t *testing.T) {
	dataDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dataDir, "leftover"), []byte("x"), 0o644)
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "vanilla_v17", "bin"), 0o755)
	var gotBin string
	var gotArgs []string
	c, _ := NewCatalogDB(CatalogOpts{
		Name: "storcon_db", DataDir: dataDir, PgInstallDir: root, Port: 5431, Password: "secret",
		RunCmd: func(_ context.Context, bin string, args []string, _ []string) (string, error) {
			gotBin, gotArgs = bin, args
			return "", nil
		},
	})
	if err := c.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "leftover")); !os.IsNotExist(err) {
		t.Fatal("interrupted-init leftovers not cleared")
	}
	if !strings.HasSuffix(gotBin, "vanilla_v17/bin/initdb") {
		t.Fatalf("bin = %s", gotBin)
	}
	joined := strings.Join(gotArgs, " ")
	for _, want := range []string{"-U worktreedb", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "-D " + dataDir, "--pwfile"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("initdb args missing %q: %s", want, joined)
		}
	}
}
```

- [ ] **Step 2: RED** — `go test ./internal/engine/ -run 'TestParse|TestResolve|TestGuard|TestStalePid|TestInit'` → compile failure. Capture.

- [ ] **Step 3: Implement** (`internal/engine/catalogdb.go`)

```go
package engine

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ResolveCatalogPgDir picks the PostgreSQL tree that hosts the storage
// controller's catalog database: `vanilla_v17` (true-upstream PostgreSQL) by
// preference. The fallback to the highest vN keeps a mis-assembled image
// bootable, but callers must WARN when it engages — the vN trees carry
// storage-engine WAL customizations that make crash recovery of a plain
// catalog database unsafe, so the fallback is a degraded mode, not a peer.
func ResolveCatalogPgDir(pgInstallDir string) (string, error) {
	vanilla := filepath.Join(pgInstallDir, "vanilla_v17")
	if _, err := os.Stat(vanilla); err == nil {
		return vanilla, nil
	}
	entries, err := os.ReadDir(pgInstallDir)
	if err != nil {
		return "", err
	}
	var majors []int
	re := regexp.MustCompile(`^v(\d+)$`)
	for _, e := range entries {
		if m := re.FindStringSubmatch(e.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			majors = append(majors, n)
		}
	}
	if len(majors) == 0 {
		return "", fmt.Errorf("no postgres install found in %s", pgInstallDir)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(majors)))
	return filepath.Join(pgInstallDir, fmt.Sprintf("v%d", majors[0])), nil
}

// ParsePgVersionFileMajor reads a data dir's PG_VERSION content: a plain-text
// file whose first token is the catalog major initdb stamped ("17", or a dev
// build's "19devel"). Returns the leading integer of that first token.
func ParsePgVersionFileMajor(content string) (int, bool) {
	fields := strings.Fields(strings.TrimSpace(content))
	if len(fields) == 0 {
		return 0, false
	}
	m := regexp.MustCompile(`^(\d+)`).FindStringSubmatch(fields[0])
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	return n, err == nil
}

// ParsePostgresVersionMajor parses `postgres --version` output: "postgres
// (PostgreSQL) 17.5" (upstream), "... 19devel" (a dev build), or "... 17.5
// (<hash>)" (a patched build). Take the major after "(PostgreSQL)"; fall back
// to the first integer anywhere.
func ParsePostgresVersionMajor(output string) (int, bool) {
	if m := regexp.MustCompile(`(?i)PostgreSQL\)\s+(\d+)`).FindStringSubmatch(output); m != nil {
		n, err := strconv.Atoi(m[1])
		return n, err == nil
	}
	if m := regexp.MustCompile(`(\d+)`).FindStringSubmatch(output); m != nil {
		n, err := strconv.Atoi(m[1])
		return n, err == nil
	}
	return 0, false
}

type CatalogOpts struct {
	Name, DataDir, PgInstallDir string
	Port                        int
	Password                    string
	OnLine                      func(string)
	// ProbeBinaryMajor overrides how the shipped binary's catalog major is
	// determined (tests). nil = probe `<pgdir>/bin/postgres --version` once.
	ProbeBinaryMajor func(ctx context.Context) (int, bool)
	// RunCmd overrides subprocess execution for Init (tests). nil = os/exec.
	RunCmd func(ctx context.Context, bin string, args []string, env []string) (string, error)
}

type CatalogDB struct {
	opts  CatalogOpts
	pgDir string
	proc  *Process

	probedOnce  bool
	probedMajor int
	probedOK    bool
}

func NewCatalogDB(opts CatalogOpts) (*CatalogDB, error) {
	pgDir, err := ResolveCatalogPgDir(opts.PgInstallDir)
	if err != nil {
		return nil, err
	}
	c := &CatalogDB{opts: opts, pgDir: pgDir}
	if filepath.Base(pgDir) != "vanilla_v17" && opts.OnLine != nil {
		opts.OnLine(fmt.Sprintf("WARNING: vanilla_v17 missing from %s — hosting the catalog on %s (degraded: not a true-upstream PostgreSQL)", opts.PgInstallDir, pgDir))
	}
	return c, nil
}

func (c *CatalogDB) ConnectionURI() string {
	return fmt.Sprintf("postgresql://worktreedb:%s@127.0.0.1:%d/postgres", c.opts.Password, c.opts.Port)
}

func (c *CatalogDB) State() ProcState {
	if c.proc == nil {
		return StateStopped
	}
	return c.proc.State()
}

func (c *CatalogDB) PID() *int {
	if c.proc == nil {
		return nil
	}
	return c.proc.PID()
}

func (c *CatalogDB) run(ctx context.Context, bin string, args, env []string) (string, error) {
	if c.opts.RunCmd != nil {
		return c.opts.RunCmd(ctx, bin, args, env)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Init runs initdb once for a fresh data dir. A dir with no PG_VERSION but
// leftover content is an interrupted init — initdb refuses non-empty dirs, so
// clear it first.
func (c *CatalogDB) Init(ctx context.Context) error {
	if _, err := os.Stat(filepath.Join(c.opts.DataDir, "PG_VERSION")); err == nil {
		return nil
	}
	if err := os.MkdirAll(c.opts.DataDir, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(c.opts.DataDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(c.opts.DataDir, e.Name())); err != nil {
			return err
		}
	}
	pwDir, err := os.MkdirTemp("", "worktreedb-pw-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(pwDir)
	pwFile := filepath.Join(pwDir, "pw")
	if err := os.WriteFile(pwFile, []byte(c.opts.Password), 0o600); err != nil {
		return err
	}
	// oracle: initdb -U <user> --pwfile <f> --auth-local=scram-sha-256 --auth-host=scram-sha-256 -D <dir>
	out, err := c.run(ctx, filepath.Join(c.pgDir, "bin", "initdb"), []string{
		"-U", "worktreedb", "--pwfile", pwFile,
		"--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
		"-D", c.opts.DataDir,
	}, []string{"LD_LIBRARY_PATH=" + filepath.Join(c.pgDir, "lib")})
	if err != nil {
		return fmt.Errorf("initdb: %w\n%s", err, out)
	}
	return nil
}

func (c *CatalogDB) binaryMajor(ctx context.Context) (int, bool) {
	if c.probedOnce {
		return c.probedMajor, c.probedOK
	}
	c.probedOnce = true
	if c.opts.ProbeBinaryMajor != nil {
		c.probedMajor, c.probedOK = c.opts.ProbeBinaryMajor(ctx)
		return c.probedMajor, c.probedOK
	}
	out, err := c.run(ctx, filepath.Join(c.pgDir, "bin", "postgres"), []string{"--version"},
		[]string{"LD_LIBRARY_PATH=" + filepath.Join(c.pgDir, "lib")})
	if err != nil {
		// Fail OPEN: the guard's own inability to read the shipped binary's
		// version must never block a boot that would otherwise succeed.
		c.log(fmt.Sprintf("could not determine catalog postgres major (%v); skipping catalog-major guard", err))
		return 0, false
	}
	c.probedMajor, c.probedOK = ParsePostgresVersionMajor(out)
	return c.probedMajor, c.probedOK
}

func (c *CatalogDB) log(line string) {
	if c.opts.OnLine != nil {
		c.opts.OnLine(line)
	}
}

func (c *CatalogDB) Start(ctx context.Context) error {
	// Catalog-major guard: a pre-existing volume whose catalog was initdb'd by
	// a DIFFERENT postgres major cannot be opened — postgres FATAL-loops on a
	// cryptic catalog/parameter error. Detect and refuse with an actionable
	// message BEFORE spawning. Only a CONFIRMED mismatch (both majors known
	// and unequal) refuses; unreadable/unparsable inputs fail open and
	// postgres's own catalog check remains the backstop.
	pgVersionPath := filepath.Join(c.opts.DataDir, "PG_VERSION")
	if raw, err := os.ReadFile(pgVersionPath); err == nil {
		if found, ok := ParsePgVersionFileMajor(string(raw)); ok {
			if expected, ok2 := c.binaryMajor(ctx); ok2 && found != expected {
				return fmt.Errorf(
					"%s: this volume's storage_controller catalog was created by PostgreSQL %d, "+
						"but this image ships PostgreSQL %d. PostgreSQL cannot open a data directory created by a "+
						"different major version. Start Worktree DB with a fresh volume, or keep running the previous "+
						"image; automated migration arrives with import/export (Phase 4).",
					c.opts.Name, found, expected)
			}
		} else {
			c.log("could not parse PG_VERSION; skipping catalog-major guard")
		}
	} else if !os.IsNotExist(err) {
		c.log(fmt.Sprintf("could not read PG_VERSION (%v); skipping catalog-major guard", err))
	}

	if c.proc != nil {
		if st := c.proc.State(); st == StateRunning || st == StateStarting {
			return fmt.Errorf("%s already %s", c.opts.Name, st)
		}
	}
	c.removeStalePidFile()

	c.proc = NewProcess(ProcOpts{
		Name: c.opts.Name,
		Bin:  filepath.Join(c.pgDir, "bin", "postgres"),
		// The unix socket is disabled deliberately: the catalog is reached only
		// over TCP loopback, and the socket's /tmp lock file — recording the
		// same postmaster PID as postmaster.pid — persists across container
		// restarts (/tmp is the writable layer), where it would be a second
		// stale-lock boot blocker. Disabling the socket removes the file class.
		Args: []string{"-D", c.opts.DataDir, "-p", strconv.Itoa(c.opts.Port), "-c", "unix_socket_directories="},
		Env:  []string{"LD_LIBRARY_PATH=" + filepath.Join(c.pgDir, "lib")},
		// oracle: postgres readiness banner "ready to accept connections"
		ReadyNeedle: "connections",
		OnLine:      c.opts.OnLine,
	})
	return c.proc.Start(ctx)
}

// removeStalePidFile clears a postmaster.pid orphaned by an unclean container
// stop. PID reuse can make the dead postmaster's recorded PID look alive to
// postgres's stale-lock heuristic, which then refuses to start. Safe here: the
// daemon holds the exclusive data-dir lockfile, and Start's running-guard
// rules out a live child of this instance. Synchronous on purpose — no await
// may separate the running-guard from the process claim.
func (c *CatalogDB) removeStalePidFile() {
	pidFile := filepath.Join(c.opts.DataDir, "postmaster.pid")
	if _, err := os.Stat(pidFile); err != nil {
		return
	}
	_ = os.Remove(pidFile)
	c.log("removed a stale postmaster.pid from an unclean prior shutdown before start")
}

func (c *CatalogDB) Stop(timeout time.Duration) {
	if c.proc != nil {
		c.proc.Stop(timeout)
		c.proc = nil
	}
}
```

- [ ] **Step 4: GREEN** — `go test ./internal/engine/ -race` → all pass.

- [ ] **Step 5: Commit**

```bash
git add internal/engine/catalogdb.go internal/engine/catalogdb_test.go
git commit -m "feat: catalog postgres host — initdb, catalog-major guard, stale-pid recovery"
```

---

### Task 8: Supervisor + engine owner + GET /api/status + main

> **AMENDED (A8, 2026-07-11, post-review):** repo authoritative. Deltas vs the blocks below:
> safekeeper registration uses a dedicated redirect-REFUSING client (DefaultClient's transparent
> 301-follow could report false success), ctx-aware backoff, no trailing sleep; main surfaces
> post-startup `Serve` failures through a channel select (headless-daemon hole closed) with one
> linear teardown (engine → owner wait → lock LAST, no double-Stop); `healthy` requires the full
> canonical topology (`engine.ExpectedComponents` — new exported single source) present AND
> running, not merely "map non-empty and running". Supervisor test asserts Status() keys ==
> ExpectedComponents. Suite +6 tests.

**Files:**
- Create: `internal/engine/supervisor.go`, Test: `internal/engine/supervisor_test.go`
- Create: `internal/api/server.go`, Test: `internal/api/server_test.go`
- Modify: `cmd/worktreedbd/main.go` (replace the Task-1 skeleton)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```go
  type Component struct{ State ProcState; PID *int }
  type Supervisor struct{ ... }
  func NewSupervisor(cfg *config.Config, catalogPassword string, onLine func(name, line string),
      onComponent func(name string, s ProcState)) *Supervisor
  func (s *Supervisor) Start(ctx context.Context) error   // ordered boot; partial-boot unwinds
  func (s *Supervisor) Stop()                              // reverse order; total
  func (s *Supervisor) Status() map[string]Component       // keys: storcon_db, storage_broker, storage_controller, safekeeper, pageserver
  // api:
  type StatusSource interface{ Status() map[string]engine.Component }
  func NewServer(version string, portRange config.PortRange, engine StatusSource) http.Handler
  ```
- Boot order (each step gated on the previous's readiness): tracer (non-fatal) → mkdir all engine dirs → catalog Init+Start → storage_broker → storage_controller → safekeeper → safekeeper REGISTRATION (POST, 3 attempts, 500ms×attempt backoff, 10s timeout each, 4xx breaks early) → write pageserver `identity.toml` + `pageserver.toml` + `metadata.json` → pageserver. Engine children get `ReadyTimeout: 120s`. Stop order: pageserver → safekeeper → storage_controller → storage_broker → catalog → tracer. Any Start error → best-effort `Stop()` → return the original error.
- Restart policy ships **OFF** (spec §6): a component dying after boot flips its state (the reaper does this) and `healthy` goes false — nothing relaunches it.
- oracle: neon control_plane/src/bin/neon_local.rs (handle_start_all_impl) + background_process.rs — upstream starts services concurrently; the fixed sequential order here is this daemon's own choice. Registration: oracle: neon control_plane/src/storage_controller.rs register_safekeepers / node_register (no bearer — trust mode).

- [ ] **Step 1: Write the failing supervisor test** (`internal/engine/supervisor_test.go`) — hermetic: a Supervisor test seam replaces every Spec's `Bin` with `/bin/sh` scripts that print the real needles.

```go
package engine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

// fakeSpecs rewrites each engine Spec to a shell script that prints its real
// readiness needle and sleeps — the supervisor's ordering/teardown logic runs
// against the true needles without any engine binary.
func fakeSpec(real Spec, script string) Spec {
	return Spec{Name: real.Name, Bin: "/bin/sh", Args: []string{"-c", script}, ReadyNeedle: real.ReadyNeedle}
}

func TestSupervisorBootsInOrderAndReportsStatus(t *testing.T) {
	cfg := testCfg(t) // from specs_test.go
	cfg.DataDir = t.TempDir()

	// Registration endpoint the supervisor must POST to (storcon's control API).
	var registered bool
	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && strings.Contains(r.URL.Path, "/control/v1/safekeeper/1") {
			registered = true
		}
		w.WriteHeader(200)
	}))
	defer reg.Close()

	var order []string
	sup := NewSupervisor(cfg, "pw", nil, nil)
	sup.testHooks = &supervisorTestHooks{
		catalog: func() error { order = append(order, "catalog"); return nil },
		spec: func(s Spec) Spec {
			order = append(order, s.Name)
			needle := s.ReadyNeedle
			return fakeSpec(s, `echo `+shellQuote(needle)+`; sleep 30`)
		},
		registrationURL: reg.URL + "/control/v1/safekeeper/1",
	}
	if err := sup.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer sup.Stop()
	want := []string{"catalog", "storage_broker", "storage_controller", "safekeeper", "pageserver"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("boot order = %v, want %v", order, want)
	}
	if !registered {
		t.Fatal("safekeeper registration never POSTed")
	}
	st := sup.Status()
	for _, name := range []string{"storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver"} {
		c, ok := st[name]
		if !ok {
			t.Fatalf("status missing %q: %v", name, st)
		}
		if name != "storcon_db" && (c.State != StateRunning || c.PID == nil) {
			t.Fatalf("%s = %+v, want running with pid", name, c)
		}
	}
}

func TestSupervisorPartialBootUnwinds(t *testing.T) {
	cfg := testCfg(t)
	cfg.DataDir = t.TempDir()
	sup := NewSupervisor(cfg, "pw", nil, nil)
	launched := map[string]bool{}
	sup.testHooks = &supervisorTestHooks{
		catalog: func() error { return nil },
		spec: func(s Spec) Spec {
			launched[s.Name] = true
			if s.Name == "safekeeper" { // third child fails before ready
				return fakeSpec(s, `echo dying; exit 3`)
			}
			return fakeSpec(s, `echo `+shellQuote(s.ReadyNeedle)+`; sleep 30`)
		},
	}
	err := sup.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "safekeeper") {
		t.Fatalf("err = %v", err)
	}
	// The two children that DID start must be stopped by the unwind.
	time.Sleep(100 * time.Millisecond)
	st := sup.Status()
	for _, name := range []string{"storage_broker", "storage_controller"} {
		if st[name].State == StateRunning {
			t.Fatalf("%s still running after failed boot", name)
		}
	}
}
```

`shellQuote` (include in the test file):

```go
// shellQuote wraps s in single quotes for /bin/sh -c, escaping embedded ones.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
```

Implementation note for the seam: give `Supervisor` an unexported `testHooks *supervisorTestHooks` field — `catalog func() error` replaces CatalogDB Init+Start+guard; `spec func(Spec) Spec` intercepts each launch; `registrationURL string` overrides the storcon control URL. Production paths (nil hooks) use the real CatalogDB and `http://127.0.0.1:<storcon>/control/v1/safekeeper/1`.

- [ ] **Step 2: Write the failing API test** (`internal/api/server_test.go`)

```go
package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

type fakeEngine map[string]engine.Component

func (f fakeEngine) Status() map[string]engine.Component { return f }

func TestStatusShape(t *testing.T) {
	pid := 42
	h := NewServer("0.1.0", config.PortRange{Min: 54300, Max: 54339}, fakeEngine{
		"storcon_db": {State: engine.StateRunning, PID: &pid},
		"pageserver": {State: engine.StateRunning, PID: &pid},
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/api/status")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("res=%v err=%v", res, err)
	}
	var body struct {
		Version   string `json:"version"`
		Healthy   bool   `json:"healthy"`
		Engine    map[string]struct {
			State string `json:"state"`
			PID   *int   `json:"pid"`
		} `json:"engine"`
		PortRange struct{ Min, Max int } `json:"portRange"`
		Storage   string                 `json:"storage"`
		PgBuilds  map[string]any         `json:"pgBuilds"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Version != "0.1.0" || !body.Healthy || body.Storage != "none" ||
		body.PortRange.Min != 54300 || body.PortRange.Max != 54339 {
		t.Fatalf("body = %+v", body)
	}
	if body.PgBuilds == nil || len(body.PgBuilds) != 0 {
		t.Fatalf("pgBuilds must be an empty OBJECT (not null): %v", body.PgBuilds)
	}
	if body.Engine["storcon_db"].State != "running" || *body.Engine["storcon_db"].PID != 42 {
		t.Fatalf("engine = %+v", body.Engine)
	}
}

func TestStatusUnhealthyOnFailedComponent(t *testing.T) {
	h := NewServer("0.1.0", config.PortRange{Min: 1, Max: 2}, fakeEngine{
		"pageserver": {State: engine.StateFailed, PID: nil},
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	res, _ := srv.Client().Get(srv.URL + "/api/status")
	var body struct {
		Healthy bool `json:"healthy"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	if body.Healthy {
		t.Fatal("healthy must be false with a failed component")
	}
}
```

- [ ] **Step 3: RED** — both packages fail to compile. Capture.

- [ ] **Step 4: Implement supervisor** (`internal/engine/supervisor.go`)

```go
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
)

type Component struct {
	State ProcState `json:"state"`
	PID   *int      `json:"pid"`
}

type supervisorTestHooks struct {
	catalog         func() error
	spec            func(Spec) Spec
	registrationURL string
}

// Supervisor owns the five engine children. Boot is strictly ordered — each
// child must reach its readiness needle before the next spawns — and a failed
// boot unwinds whatever already started. Restart policy is deliberately OFF:
// a child dying after boot flips its state (and healthy → false); recovery is
// a container restart.
type Supervisor struct {
	cfg         *config.Config
	catalogPw   string
	onLine      func(name, line string)
	onComponent func(name string, s ProcState)
	catalog     *CatalogDB
	tracer      *Tracer
	procs       map[string]*Process
	order       []string // spawn order of procs (stop reverses it)
	testHooks   *supervisorTestHooks
}

func NewSupervisor(cfg *config.Config, catalogPassword string,
	onLine func(name, line string), onComponent func(name string, s ProcState)) *Supervisor {
	return &Supervisor{
		cfg: cfg, catalogPw: catalogPassword,
		onLine: onLine, onComponent: onComponent,
		procs: map[string]*Process{},
	}
}

func (s *Supervisor) line(name, l string) {
	fmt.Printf("[%s] %s\n", name, l) // docker logs carries every supervised line
	if s.onLine != nil {
		s.onLine(name, l)
	}
}

func (s *Supervisor) launch(ctx context.Context, spec Spec) error {
	if s.testHooks != nil && s.testHooks.spec != nil {
		spec = s.testHooks.spec(spec)
	}
	name := spec.Name
	p := NewProcess(ProcOpts{
		Name: name, Bin: spec.Bin, Args: spec.Args,
		ReadyNeedle: spec.ReadyNeedle, ReadyTimeout: 120 * time.Second,
		OnLine:        func(l string) { s.line(name, l) },
		OnStateChange: func(st ProcState) { if s.onComponent != nil { s.onComponent(name, st) } },
	})
	s.procs[name] = p
	s.order = append(s.order, name)
	return p.Start(ctx)
}

// oracle: neon control_plane/src/bin/neon_local.rs (handle_start_all_impl) +
// background_process.rs (per-process spawn + wait-ready). Upstream starts
// services concurrently; the fixed sequential order here is this daemon's own
// choice — each dependency is provably up before its dependent spawns.
func (s *Supervisor) Start(ctx context.Context) (err error) {
	defer func() {
		if err != nil {
			s.Stop()
		}
	}()

	s.tracer = NewTracer(s.cfg.Engine.Tracer, func(l string) { s.line("tracer", l) })
	if terr := s.tracer.Start(); terr != nil {
		// Non-fatal: degrade to "no sink" (the engine's exports retry loudly)
		// rather than brick the daemon over a telemetry port.
		s.line("tracer", fmt.Sprintf("sink failed to bind 127.0.0.1:%d — engine trace/upcall noise will resume: %v", s.cfg.Engine.Tracer, terr))
	}

	dirs := EngineDirs(s.cfg.DataDir)
	for _, d := range []string{dirs.PageserverDir, dirs.PageserverLayers, dirs.SafekeeperDir, dirs.CatalogDBDir, dirs.LogsDir, dirs.ComputesDir} {
		if err = os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}

	if s.testHooks != nil && s.testHooks.catalog != nil {
		if err = s.testHooks.catalog(); err != nil {
			return err
		}
	} else {
		cat, cerr := NewCatalogDB(CatalogOpts{
			Name: "storcon_db", DataDir: dirs.CatalogDBDir,
			PgInstallDir: s.cfg.PgInstallDir, Port: s.cfg.Engine.StorconDB,
			Password: s.catalogPw, OnLine: func(l string) { s.line("storcon_db", l) },
		})
		if cerr != nil {
			return cerr // no postgres install in the image at all — unbootable
		}
		s.catalog = cat
		if err = s.catalog.Init(ctx); err != nil {
			return err
		}
		if err = s.catalog.Start(ctx); err != nil {
			return err
		}
	}

	if err = s.launch(ctx, BrokerSpec(s.cfg)); err != nil {
		return err
	}
	dbURI := "postgresql://worktreedb@127.0.0.1/postgres"
	if s.catalog != nil {
		dbURI = s.catalog.ConnectionURI()
	}
	if err = s.launch(ctx, StorconSpec(s.cfg, dbURI)); err != nil {
		return err
	}
	if err = s.launch(ctx, SafekeeperSpec(s.cfg)); err != nil {
		return err
	}
	if err = s.registerSafekeeper(ctx); err != nil {
		return err
	}

	if err = os.WriteFile(filepath.Join(dirs.PageserverDir, "identity.toml"), []byte(PageserverIdentityToml()), 0o644); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dirs.PageserverDir, "pageserver.toml"), []byte(PageserverToml(s.cfg)), 0o644); err != nil {
		return err
	}
	meta, merr := PageserverMetadataJSON(s.cfg)
	if merr != nil {
		return merr
	}
	if err = os.WriteFile(filepath.Join(dirs.PageserverDir, "metadata.json"), []byte(meta), 0o644); err != nil {
		return err
	}
	return s.launch(ctx, PageserverSpec(s.cfg))
}

// oracle: neon control_plane/src/storage_controller.rs register_safekeepers /
// node_register (no bearer — trust mode)
func (s *Supervisor) registerSafekeeper(ctx context.Context) error {
	url := fmt.Sprintf("http://127.0.0.1:%d/control/v1/safekeeper/1", s.cfg.Engine.Storcon)
	if s.testHooks != nil && s.testHooks.registrationURL != "" {
		url = s.testHooks.registrationURL
	}
	body, err := json.Marshal(SafekeeperRegistrationBody(s.cfg, time.Now().UTC().Format(time.RFC3339)))
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		req, _ := http.NewRequestWithContext(reqCtx, "POST", url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, rerr := http.DefaultClient.Do(req)
		if rerr == nil {
			ok := res.StatusCode >= 200 && res.StatusCode < 300
			nonTransient := res.StatusCode >= 400 && res.StatusCode < 500
			res.Body.Close()
			cancel()
			if ok {
				return nil
			}
			lastErr = fmt.Errorf("safekeeper registration failed: %d", res.StatusCode)
			if nonTransient {
				break
			}
		} else {
			cancel()
			lastErr = rerr
		}
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
	}
	return fmt.Errorf("safekeeper registration at %s failed after retries: %w", url, lastErr)
}

// Stop tears down in reverse spawn order; it is total (never errors).
func (s *Supervisor) Stop() {
	for i := len(s.order) - 1; i >= 0; i-- {
		s.procs[s.order[i]].Stop(10 * time.Second)
	}
	if s.catalog != nil {
		s.catalog.Stop(10 * time.Second)
	}
	if s.tracer != nil {
		s.tracer.Stop()
	}
}

func (s *Supervisor) Status() map[string]Component {
	out := map[string]Component{}
	if s.catalog != nil {
		out["storcon_db"] = Component{State: s.catalog.State(), PID: s.catalog.PID()}
	} else {
		out["storcon_db"] = Component{State: StateStopped}
	}
	for name, p := range s.procs {
		out[name] = Component{State: p.State(), PID: p.PID()}
	}
	return out
}
```

- [ ] **Step 5: Implement the API server** (`internal/api/server.go`)

```go
// Package api serves the REST surface. Handlers read observed state and write
// desired state — they never write status (that is the owners' monopoly).
package api

import (
	"encoding/json"
	"net/http"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
)

type StatusSource interface {
	Status() map[string]engine.Component
}

func NewServer(version string, portRange config.PortRange, eng StatusSource) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		st := eng.Status()
		healthy := len(st) > 0
		for _, c := range st {
			if c.State != engine.StateRunning {
				healthy = false
				break
			}
		}
		writeJSON(w, 200, map[string]any{
			"version": version,
			"healthy": healthy,
			"engine":  st,
			"portRange": map[string]int{"min": portRange.Min, "max": portRange.Max},
			"storage":  "none",              // durability modes arrive with import/export
			"pgBuilds": map[string]any{},    // populated when the dynamic-build subsystem lands
		})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 6: Replace `cmd/worktreedbd/main.go`**

```go
// Command worktreedbd is the Worktree DB daemon: it supervises the storage
// engine and serves branch operations over REST.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/api"
	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

const version = "0.1.0"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "boot failed:", err)
		os.Exit(1)
	}
}

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
	// Held as a file, not an fd — an unclean stop leaves it behind, and the
	// error names the exact recovery command.
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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pw, err := catalogPassword(ctx, st)
	if err != nil {
		removeLock()
		return err
	}
	sup := engine.NewSupervisor(cfg, pw, nil, nil)

	// The engine owner: convergence = "the engine is started". Boot runs one
	// synchronous converge through the inbox; the same inbox is where every
	// future engine mutation (and nothing else) enters.
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

	handler := api.NewServer(version, cfg.PortRange, sup)
	httpSrv := &http.Server{Handler: handler}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.HTTPPort))
	if err != nil {
		sup.Stop()
		removeLock()
		return err
	}
	go func() { _ = httpSrv.Serve(ln) }()
	log.Info("worktreedbd up", "version", version, "port", cfg.HTTPPort)

	// Shutdown: first signal → orderly teardown under a hard 45s budget;
	// second signal → immediate exit 130.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigCh
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

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	ok := true
	if err := httpSrv.Shutdown(shutCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		ok = false
		log.Error("http shutdown", "err", err)
	}
	sup.Stop()
	cancel()
	eng.Wait()
	removeLock()
	if !ok {
		return errors.New("shutdown finished with errors")
	}
	return nil
}

// catalogPassword returns the catalog superuser password, generating and
// persisting one on first boot.
func catalogPassword(ctx context.Context, st *store.Store) (string, error) {
	if v, ok, err := st.GetMeta(ctx, "catalogdb_password"); err != nil {
		return "", err
	} else if ok {
		return v, nil
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	pw := hex.EncodeToString(b)
	return pw, st.SetMeta(ctx, "catalogdb_password", pw)
}
```

- [ ] **Step 7: GREEN** — `go test ./... -race` → all packages pass; `go build ./... && go vet ./...` clean.

- [ ] **Step 8: Commit**

```bash
git add internal/engine/supervisor.go internal/engine/supervisor_test.go internal/api cmd/worktreedbd/main.go
git commit -m "feat: engine supervisor, engine owner, status endpoint, daemon boot"
```

---

### Task 9: Dockerfile + boot integration tests

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `integration/boot_test.go`
- Modify: `README.md` (only if a command drifted from Task 1's text)

**Interfaces:**
- Consumes: the built binary + the engine base image (Global Constraints digest).
- Produces: `worktreedb:dev`; the M1 acceptance evidence.

- [ ] **Step 1: Write `Dockerfile` + `.dockerignore`**

```dockerfile
# syntax=docker/dockerfile:1
FROM ghcr.io/vangoghsoftware/worktreedb-neon-engine@sha256:7c042751bb0fbe5c1593dd95c49418fc57abbead2b91565e5696fe6b8c8629f4 AS neon-binaries

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/worktreedbd ./cmd/worktreedbd

FROM debian:bookworm-slim
# Runtime libs the engine binaries + postgres need (oracle: neondatabase/neon
# root Dockerfile installs a comparable set in its assembled-image stage).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 libpq5 libreadline8 libseccomp2 libcurl4 \
    libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=neon-binaries /usr/local/share/neon /usr/local/share/neon
COPY --from=build /out/worktreedbd /usr/local/bin/worktreedbd
ENV WORKTREEDB_NEON_BIN_DIR=/usr/local/share/neon/bin \
    WORKTREEDB_PG_INSTALL_DIR=/usr/local/share/neon/pg_install \
    WORKTREEDB_DATA_DIR=/data \
    WORKTREEDB_HTTP_PORT=4400 \
    WORKTREEDB_PORT_RANGE=54300-54339
RUN useradd -m -u 1000 worktreedb && mkdir -p /data && chown worktreedb:worktreedb /data
USER worktreedb
EXPOSE 4400 54300-54339
CMD ["worktreedbd"]
```

`.dockerignore`:
```
.git
.worktrees
.claude
*.test
worktreedbd
```

- [ ] **Step 2: Build it (RED for the suite — the tests don't exist yet)**

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"   # docker + credential helper
docker build -t worktreedb:dev .   # engine base is private — needs the existing ghcr login
```
Expected: image builds; `docker run --rm worktreedb:dev worktreedbd 2>&1 | head -2` fails fast with a config/lock error only if run without a volume — that's fine.

- [ ] **Step 3: Add the dependency + write the integration tests** (`integration/boot_test.go`)

```bash
go get github.com/testcontainers/testcontainers-go@latest && go mod verify
```

```go
//go:build integration

// Container-level acceptance for the M1 kernel. Requires Docker and the
// locally built worktreedb:dev image (override with WORKTREEDB_TEST_IMAGE).
// Run: go test -tags integration ./integration/... -v -timeout 15m
package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

func image() string {
	if img := os.Getenv("WORKTREEDB_TEST_IMAGE"); img != "" {
		return img
	}
	return "worktreedb:dev"
}

func startContainer(t *testing.T) (testcontainers.Container, string) {
	t.Helper()
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        image(),
			ExposedPorts: []string{"4400/tcp"},
			WaitingFor:   wait.ForHTTP("/api/status").WithPort("4400/tcp").WithStartupTimeout(3 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Terminate(context.Background()) })
	host, _ := c.Host(ctx)
	port, _ := c.MappedPort(ctx, "4400")
	return c, fmt.Sprintf("http://%s:%s", host, port.Port())
}

type statusBody struct {
	Version string `json:"version"`
	Healthy bool   `json:"healthy"`
	Engine  map[string]struct {
		State string `json:"state"`
		PID   *int   `json:"pid"`
	} `json:"engine"`
	Storage  string         `json:"storage"`
	PgBuilds map[string]any `json:"pgBuilds"`
}

func getStatus(t *testing.T, base string) statusBody {
	t.Helper()
	res, err := http.Get(base + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var b statusBody
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	return b
}

func dockerCLI(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil && !strings.Contains(strings.Join(args, " "), "logs") {
		t.Fatalf("docker %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// Acceptance 1: a fresh volume boots the whole engine healthy.
func TestFreshVolumeBootsHealthy(t *testing.T) {
	_, base := startContainer(t)
	st := getStatus(t, base)
	if !st.Healthy || st.Storage != "none" || st.PgBuilds == nil {
		t.Fatalf("status = %+v", st)
	}
	for _, name := range []string{"storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver"} {
		c, ok := st.Engine[name]
		if !ok || c.State != "running" || c.PID == nil {
			t.Fatalf("engine[%s] = %+v (ok=%v)", name, c, ok)
		}
	}
}

// Acceptance 2: the catalog-major guard refuses a foreign-major volume with
// the actionable message, and the container actually stops.
func TestCatalogMajorGuardRefusesForeignVolume(t *testing.T) {
	c, _ := startContainer(t)
	id := c.GetContainerID()
	const pgv = "/data/daemon_data/storage_controller_pg_data/PG_VERSION"
	dockerCLI(t, "exec", id, "sh", "-c", "printf '99\\n' > "+pgv)
	dockerCLI(t, "exec", id, "rm", "-f", "/data/.lock") // isolate the guard from the instance lock
	dockerCLI(t, "restart", "-t", "25", id)

	var logs string
	running := true
	for i := 0; i < 60; i++ {
		logs = dockerCLI(t, "logs", id)
		state := strings.TrimSpace(dockerCLI(t, "inspect", "-f", "{{.State.Running}}", id))
		running = state != "false"
		if !running && strings.Contains(logs, "storage_controller catalog was created") {
			break
		}
		time.Sleep(time.Second)
	}
	for _, want := range []string{
		"storage_controller catalog was created by PostgreSQL 99",
		"fresh volume", "previous image", "import/export (Phase 4)",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("logs missing %q", want)
		}
	}
	if running {
		t.Fatal("container still running — the guard must stop the boot")
	}
}

// Acceptance 3: an unclean stop (SIGKILL) orphans storcon_db's
// postmaster.pid; the next boot removes it, logs the removal, and comes up
// healthy. Also proves the catalog runs TCP-only (no /tmp socket lock class).
func TestUncleanRestartRecovers(t *testing.T) {
	c, base := startContainer(t)
	id := c.GetContainerID()
	const pidPath = "/data/daemon_data/storage_controller_pg_data/postmaster.pid"
	if out := dockerCLI(t, "exec", id, "sh", "-c", "test -f "+pidPath+" && echo yes || echo no"); !strings.Contains(out, "yes") {
		t.Fatalf("postmaster.pid missing on a healthy boot: %q", out)
	}
	if out := dockerCLI(t, "exec", id, "sh", "-c", "ls -d /tmp/.s.PGSQL.5431 /tmp/.s.PGSQL.5431.lock 2>/dev/null | wc -l"); strings.TrimSpace(out) != "0" {
		t.Fatalf("unix socket artifacts exist: %q", out)
	}
	dockerCLI(t, "exec", id, "rm", "-f", "/data/.lock") // the unclean stop would also orphan this
	dockerCLI(t, "kill", id)                            // SIGKILL: skips the SIGTERM path entirely
	dockerCLI(t, "start", id)

	healthy := false
	for i := 0; i < 90; i++ {
		res, err := http.Get(base + "/api/status")
		if err == nil {
			var b statusBody
			_ = json.NewDecoder(res.Body).Decode(&b)
			res.Body.Close()
			if b.Healthy {
				healthy = true
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
	if !healthy {
		t.Fatalf("container never healthy after unclean restart; logs:\n%s", dockerCLI(t, "logs", id))
	}
	if logs := dockerCLI(t, "logs", id); !strings.Contains(logs, "stale postmaster.pid") {
		t.Fatal("missing the stale-pid removal log")
	}
}
```

**Port caveat for the implementer:** after `docker kill` + `docker start`, testcontainers' cached mapped port stays valid only because the container is reused (not recreated). If the status polls all fail with connection errors, re-resolve `MappedPort` after the start — ports can be re-published. Handle it in the poll loop rather than assuming.

- [ ] **Step 4: Run the integration suite**

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
go test -tags integration ./integration/... -v -timeout 20m
```
Expected: 3/3 pass. This is the M1 acceptance run — attach the full output to the task report.

- [ ] **Step 5: Full local gate + commit**

```bash
go build ./... && go vet ./... && go test ./... -race && golangci-lint run
git add Dockerfile .dockerignore integration go.mod go.sum
git commit -m "build: docker image on the engine base; boot acceptance tests"
```

---

## Milestone acceptance (M1 definition of done)

1. `go test ./... -race` green; `golangci-lint run` clean.
2. `docker build -t worktreedb:dev .` succeeds from the private engine base.
3. `go test -tags integration ./integration/...` green: fresh-volume healthy boot, guard refusal (with all four parity strings), unclean-restart recovery (with the stale-pid log + zero socket artifacts).
4. Zero forbidden mentions: `git grep -iE 'devdb|neond|typescript' -- ':!go.sum'` in the worktreedb repo returns NOTHING.
5. Every commit message: conventional, trailer-free (`git log --format=%B | grep -ci co-authored` → 0).

## Deferred (recorded, not lost)

- CI docker-build job — needs the GHCR package-access grant on the 5 packages for this repo's Actions token (owner-gated UI step). Until then the image builds locally only.
- `verify-binaries`-style in-build gate for the runtime image — the engine image is already gate-verified at publish; a worktreedb-side re-check is M4 packaging polish.
- Engine auto-restart, `starting` in the status union, pull-resume policies — post-parity backlog (spec §11).
