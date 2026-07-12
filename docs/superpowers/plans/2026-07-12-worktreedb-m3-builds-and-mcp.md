# Worktree DB M3 — Builds + MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Go daemon dynamic PostgreSQL builds (hand-rolled OCI client with hardened extraction, a builds owner running check → pull → validation gate → activate-policy → boot adoption, byte-parity pg-builds REST + status block + `runningPgVersion`) and the full MCP surface (streamable-HTTP server with stateful sessions, Host/Origin DNS-rebinding guard, all 14 tools with fork-context capture, renamed skills) — so the reference integration suite's remaining pre-UI files (`pg-builds`, `mcp`, `mcp-handshake`, `mcp-concurrency`) run green against `worktreedb:dev` via the cross-run, assertions unmodified.

**Architecture:** A `builds.Service` owns the `pg_builds`/`pg_actives` tables (already in schema v2) through a `runtime.Owner` lane — activate/remove/prune serialize through the lane exactly like branch mutations serialize through branch owners; the long download/extract/gate stretch of a pull deliberately runs OUTSIDE the lane (a multi-minute pull must never block an unrelated activate). Each pull is a durable `operations` row (kind `pg_build_pull`, fail-forward at boot: crash-mid-pull boots to `failed` + retry-allowed). Build identity is the image DIGEST (dir `pg_builds/v{major}/{first-16-hex}`); a `build.json` marker makes volumes self-describing across restarts; boot adoption re-probes baked installs, adopts marker'd volume dirs (shape+location+binary re-verified), sweeps `.tmp-*`, fails interrupted rows, resolves per-major active pointers (newest minor wins, never silently below the `last_run_minor` high-water), GCs to keep-2, and composes the `pg_distrib` symlink farm the pageserver's `pg_distrib_dir` now points at — all BEFORE the engine starts. MCP is the official go-sdk's `StreamableHTTPHandler` (stateful sessions, 10-min idle timeout) mounted at `/mcp` behind a hand-rolled Host/Origin guard that wraps the handler itself — the guard runs iff the route dispatched, so the percent-encoded-path bypass class is structurally impossible. Master spec: `docs/superpowers/specs/2026-07-11-worktreedb-go-rewrite-design.md` (§4–§8-M3). M2 deferral fold-ins: the engine-client T3 trio + two P5 doc nits (Task 11).

**Tech Stack:** Go 1.25 stdlib (`net/http` mux, `archive/tar`, `compress/gzip`, `crypto/sha256`, `os.Root` for containment-enforced extraction, `syscall.Statfs`), `modernc.org/sqlite`, `log/slog`, **`github.com/modelcontextprotocol/go-sdk` v1.6.1** (the ONE new module this milestone — see the SDK verification note below), `testcontainers-go` (integration only), `golangci-lint`.

## SDK verification (spec §7 planning duty — performed 2026-07-12, probe module under scratchpad)

`github.com/modelcontextprotocol/go-sdk@v1.6.1` fetched and `go doc`'d. Feature coverage **confirmed on every required axis — no fallback taken**:

- **Streamable HTTP server + stateful sessions:** `mcp.NewStreamableHTTPHandler(getServer func(*http.Request) *mcp.Server, opts *mcp.StreamableHTTPOptions) *mcp.StreamableHTTPHandler` is an `http.Handler`; sessions are stateful by default (`Stateless: false` validates `Mcp-Session-Id`), and `StreamableHTTPOptions.SessionTimeout` gives the 10-minute idle sweep for free.
- **Typed tool registration:** generic `mcp.AddTool[In, Out](s *Server, t *Tool, h ToolHandlerFor[In, Out])` infers + validates the input schema from struct tags (google/jsonschema-go, 2020-12 draft).
- **Client-info for fork-context:** tool handlers receive `req *mcp.CallToolRequest` with `req.Session.InitializeParams().ClientInfo` (`*mcp.Implementation{Name, Version}`) — per-session, captured server-side at `initialize`, spoof-safe by construction.
- **Mountable under our mux:** `ServeHTTP` — the Host/Origin guard wraps it as ordinary middleware.
- **Instructions:** `mcp.ServerOptions.Instructions` lands in the initialize result (the reference client's `getInstructions()`).
- **Capabilities:** the `tools` capability is auto-inferred as `{"listChanged":true}` once any tool is added (documented on `ServerOptions.Capabilities`) — exactly what `mcp-handshake.test.ts` asserts.
- **SDK's own DNS-rebinding option:** `StreamableHTTPOptions.DisableLocalhostProtection` exists; we set it `true` and rely on OUR guard, which is a strict superset (fail-closed on missing Host, duplicate Origin, malformed authorities; allows `host.docker.internal`, which the SDK's built-in check would 403 on a loopback arrival).
- **Empirical mux fact (probe test):** Go's `net/http.ServeMux` routes percent-encoded paths (`/%6dcp`, `/m%63p`) to the `/mcp` pattern — the encoded-path bypass class is live in Go if a guard compares raw URL strings. Mounting the guard AS the `/mcp` handler closes it by construction (Task 12 pins a regression test).

## Global Constraints

- **Repo split:** all product code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`); implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` (never directly on its `main`; base = `main@da22ff7` or later). Task 17 is the ONE devdb-repo task (`~/git/devdb`). This plan and the ledger stay in devdb (workshop) — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers of any kind** (spec D4) — this overrides any harness default. The devdb-repo commit in Task 17 keeps devdb's usual trailer policy.
- **Clean-history rule (spec §3):** worktreedb code, comments, tests, commit messages, and docs NEVER mention the TypeScript implementation, the devdb repo, `matisiekpl/neond`, Fastify, Node, or "parity with the old daemon". The system is presented on its own terms. `// oracle: neon <path-or-endpoint>` citations to official `neondatabase/neon` are REQUIRED at engine wire facts; **OCI protocol facts cite the OCI distribution/image specs instead** (e.g. `// OCI distribution spec: …`) — the neon oracle rule applies only to engine wire interactions. The oracle citations embedded in this plan's code blocks are pre-verified — transcribe them verbatim.
- **Dependency policy:** stdlib first. Exactly ONE new module in M3: `github.com/modelcontextprotocol/go-sdk@v1.6.1` (Task 12; proxy-verified ≥ 24h old on 2026-05-22). The OCI client is hand-rolled (pinned decision — no registry/containerd libraries). `go get` only, **no `go mod tidy`** (markers are hand-maintained). `golang.org/x/*` stays indirect — `syscall.Statfs` covers free-space probing on linux+darwin without promoting `x/sys`.
- **State-model rules (binding):** builds status/actives writes go through the builds service, serialized by the builds owner lane for every mutation that touches the active pointer or deletes rows/dirs (activate, remove, skip-prune, pull compensation). Pulls are durable `operations` rows (kind `pg_build_pull`), boot policy **fail-forward** (`FailForwardOnBoot`). Never write branch `status_*` from anywhere but the branch's owner (M2 rule, unchanged).
- **Concurrency rules:** one pull in flight process-wide (a second `pull` 409s, it never queues); the download/extract/gate stretch runs outside the builds lane, the activate/prune/compensation steps inside it. The in-use protocol: `remove` reads `RunningPgbins()` INSIDE the lane immediately before the removability check (a pre-lane snapshot goes stale while the removal waits its turn).

### Parity contracts owned by this milestone (byte-exact; the reference suite asserts these)

**Filesystem layout (asserted by `pg-builds.test.ts` via `docker exec` paths):**
- Downloaded build dir: `/data/pg_builds/v{major}/{shortDigest}` where `shortDigest` = first **16** hex chars of the sha256 digest (no `sha256:` prefix).
- In-progress staging: `/data/pg_builds/v{major}/.tmp-{shortDigest}` (plus `.tmp-oci-*` scratch) — everything `.tmp-*` is swept at boot and never adopted.
- Marker file `build.json` INSIDE the build dir, compact JSON with this EXACT key order (the test's forge does `sed 's/"minor":N/"minor":99/'` then `grep -q '"minor":99,'` — `minor` must be immediately followed by `,"extractedAt"`):
  `{"digest":"sha256:…","tag":"…","major":17,"minor":4,"extractedAt":"…"}`
- State DB: `/data/state.db`; the high-water lives at `pg_actives.last_run_minor` (Task 17's injection helper writes it directly).

**Wire DTOs (JSON field names exactly; the suite decodes these shapes):**
- PgBuild: `id, major, minor, version, source, releaseTag, imageDigest, status, active, inUse, sizeBytes, error, createdAt` — `version` = `"17.4"` or `null` while minor unknown; `imageDigest` = `"sha256:…"`, `""` for baked rows; `source` ∈ `baked|downloaded`; `status` ∈ `downloading|validating|ready|failed|skipped`.
- `/api/status` `pgBuilds` block: keyed by major AS STRING (`"17"`), each value `{activeVersion, source, degradedDowngrade, updateAvailable}` (`activeVersion` `"17.5"|null`, `source` `"baked"|"downloaded"|null`, `updateAvailable` `"latest@<12hex>"|null`).
- `POST /api/pg-builds/pull` → **202** `{"buildId":"…"}` (row exists before the response); concurrent pull → **409**; a FAILED pull must not latch the mutex (the next pull 202s).
- `POST /api/pg-builds/check` → `{"<major>": {"tag":"latest","digest":"sha256:…","state":"current|incompatible|unverified","isNew":bool,"at":"<iso>"}}`.
- `POST /api/pg-builds/{id}/activate` → 200 PgBuild DTO; `DELETE /api/pg-builds/{id}` → 204 empty.
- Branch DTO `runningPgVersion`: the version string (`"17.4"`) of the build the RUNNING compute was started from; `null` when stopped/unresolvable. M2 shipped it hard-`null`; this milestone populates it (`pg-builds.test.ts` asserts it equals the pulled build's forged version).

**Observable pipeline/boot behavior the suite asserts:**
- pull → download → extract (real Neon PG tree with relative in-tree symlinks MUST extract cleanly) → version fixup (detect must equal requested major) → validation gate against LIVE storage → `ready` + auto-activate (row `active:true`, status block flips `source:"downloaded"`).
- `resolveDigest` computes the sha256 over the RAW manifest bytes — the suite asserts row `imageDigest` equals the digest IT computed over the bytes it seeded.
- A gate-failed build: row `failed` with non-empty `error`, `active:false`, previously-active build untouched, retry 202s with a NEW buildId.
- Restart: volume builds re-adopted `ready`; active election is newest-minor-wins (baked 17.5 beats downloaded 17.4 — "source stays downloaded" is NOT the post-restart contract); `degradedDowngrade:false` while active ≥ high-water.
- Forged marker (dir renamed to a non-content-address + `minor` sed'd to 99): NOT adopted; the orphaned row is failed by the presence sweep; major falls back to baked; a `"17.99"` ready row must never exist.
- Injected `last_run_minor=99` + only baked resolvable → `degradedDowngrade:true` with `activeVersion` = baked, `source:"baked"`.
- The daemon must boot healthy with `WORKTREEDB_PG_REGISTRY_BASE` set but the registry unreachable — check/pull are the ONLY egress; nothing dials the registry at boot (the suite starts the daemon BEFORE the fixture registry exists).

**Daemon-authored strings (exact copies; `%s`/`%d` shown where dynamic):**
- 409 `a build pull is already in progress`
- 400 `invalid tag: %s`
- 404 `no such build: %s`
- 409 `pg_build %s is not ready to activate`
- 409 `activating %s would downgrade below the last-run %d.%d — pass consented:true (see docs on extension-catalog downgrades)` (first `%s` = `"major.minor"`)
- 409 `pg_build %s is the active build for major %d` · 409 `pg_build %s is a baked build and cannot be removed` · 409 `pg_build %s has a pull in flight — wait for it to finish or fail` · 409 `pg_build %s is in use by a running endpoint`
- 409 `no usable Postgres %d build — pull one via POST /api/pg-builds/pull or pick an installed major`
- failed-row errors: `insufficient disk space on /data (< 1.5 GB free)` · `interrupted by restart` · `image contained postgres %d.%d, expected major %d` · `build binary missing at boot` · `build binary version drift at boot: detected %d.%d, recorded %d.%d` · `baked build failed version re-probe at boot` · `baked build dir missing at boot` · `gate timed out after %ds`
- skipped-row message: `already installed as %s (%s) — up to date` (version-or-`17.x`, then source)
- incompatibility marker (write and read-back MUST share it): `is incompatible with this runtime image`
- MCP guard 403 bodies: `{"error":"Host %q is not allowed — set WORKTREEDB_MCP_ALLOWED_HOSTS to permit it"}` · `{"error":"Origin %q is not allowed — set WORKTREEDB_MCP_ALLOWED_ORIGINS to permit it"}` · `{"error":"duplicate Origin header is not allowed"}` (Go's own HTTP server already 400s duplicate Host lines before any handler).

**MCP contracts (the three mcp*.test.ts files assert these):**
- Exactly **14** tools, these names: `activate_pg_build, check_pg_updates, create_branch, create_project, delete_branch, get_branch, get_status, list_branches, list_pg_builds, list_projects, pull_pg_build, reset_branch, restore_branch, stop_endpoint`.
- Initialize result: instructions contain the phrase `branch per task`; capabilities `tools` == `{"listChanged":true}`.
- Server identity: name `worktreedb`, version = daemon version.
- Tool responses are TEXT (`content[0].text`); every branch-returning success embeds the connection string (`postgresql://…` — the suite regexes `postgresql:\/\/\S+`); `list_branches` renders the branch TREE with each branch's name AND its fork-context JSON (the suite asserts the context `purpose` string and the captured session client name appear).
- `create_branch` captures the session's `initialize` clientInfo into the stored context as `client` (never caller-supplied — input schema has no `client` key); `get_branch` starts the endpoint by default (`ensure_running` defaults true — load-bearing: the suite connects to the returned string).
- N concurrent sessions (own initialize → own `mcp-session-id`) work independently; a third older session survives the others' churn.
- MCP `activate_pg_build` REFUSES downgrades (never calls activate; text names the web-UI/REST consent path) and requires an explicit `id` when two ready builds share a major.minor. NO MCP delete tool.

**Machine quirks / tribal facts:**
- docker + `docker-credential-desktop` live at `/Applications/Docker.app/Contents/Resources/bin` — put on PATH for image builds AND testcontainers runs. Engine binaries in-image at `/usr/local/share/neon` (bin + pg_install).
- The reference suite runs sequentially; single cases can flake under machine load — re-run an isolated file before treating a red as real. `pg-builds.test.ts` alone takes ~15–20 min (three tests, real pulls + restarts).
- The daemon runs in-container as user `worktreedb` (uid 1000) owning `/data` — extraction, markers, and sqlite access all run as that user.
- Docker Hub's `registry-1.docker.io` challenges anonymous pulls with a Bearer token flow; a plain `registry:2` (the fixture) never challenges. GHCR mints scoped bearers for a PAT presented as HTTP Basic password with any username (`x-access-token` conventional).
- The Accept header on manifest GETs is LOAD-BEARING: without the schema2/OCI media types, `registry:2` transcodes manifests to schema1 and the content digest changes out from under the suite's assertion.

## File map (M3 end state, worktreedb repo — new/modified only)

```
internal/config/config.go        MODIFY: registry/template/token + MCP allowlists + PgBuildsDir/PgDistribDir
internal/config/config_test.go   MODIFY
internal/store/builds.go         CREATE: pg_builds/pg_actives row accessors (schema already has the tables)
internal/store/builds_test.go    CREATE
internal/oci/client.go           CREATE: registry-v2 client (anon + Basic-token arms, manifest walk, digest pinning)
internal/oci/extract.go          CREATE: hardened layer extraction (os.Root, whiteouts, post-extract walk)
internal/oci/client_test.go      CREATE (httptest fake registry)
internal/oci/extract_test.go     CREATE (crafted hostile layers)
internal/builds/version.go       CREATE: postgres --version detect + incompatibility classification
internal/builds/distrib.go       CREATE: pg_distrib symlink-farm composition
internal/builds/service.go       CREATE: Service struct, rows+actives read model, seams
internal/builds/boot.go          CREATE: seedBaked/adoptVolumeBuilds/sweeps/resolve/GC (BootAdopt)
internal/builds/activate.go      CREATE: activate/remove/pgbinFor/noteRun/overrides (lane mutations)
internal/builds/check.go         CREATE: check-honesty states + skip records
internal/builds/pull.go          CREATE: the pull pipeline as a durable operation + gate invocation
internal/builds/gate.go          CREATE: validation-gate runner + validation-project boot sweep
internal/builds/*_test.go        CREATE
internal/service/core.go         MODIFY: PgbinOverride/NoteRun/VersionForPgbin seams + byName lookups
internal/service/endpoints.go    MODIFY: override-aware pgbin resolve, NoteRun, RunningPgVersion in detail
internal/service/projects.go     MODIFY: CreateProjectInternal (gate-reserved names)
internal/api/server.go           MODIFY: pg-builds routes + real status pgBuilds block + /mcp mount
internal/api/dto.go              MODIFY: pgBuildDTO + branchDTO.runningPgVersion
internal/api/*_test.go           MODIFY
internal/engine/specs.go         MODIFY: pageserver pg_distrib_dir → cfg.PgDistribDir
internal/engine/clients.go       MODIFY: T3 trio (decode checks, APIError display cap, body-read error)
internal/engine/clients_test.go  MODIFY
internal/store/operations.go     MODIFY: P5 doc nit (ErrOperationNotActive producers)
internal/events/loghub.go        MODIFY: P5 doc nit (attach-order wording)
internal/mcp/guard.go            CREATE: Host/Origin DNS-rebinding guard (wraps the handler)
internal/mcp/server.go           CREATE: SDK server + handler construction, instructions
internal/mcp/format.go           CREATE: text/error results, context line, renderers
internal/mcp/tools_read.go       CREATE: get_status/list_projects/create_project/list_branches/get_branch
internal/mcp/tools_mutate.go     CREATE: create/stop/delete/reset/restore + 4 pg-build tools
internal/mcp/*_test.go           CREATE
cmd/worktreedbd/main.go          MODIFY: builds bootstrap before engine, wiring, MCP, shutdown, v0.3.0
Dockerfile                       MODIFY: + sqlite3 (operator state inspection)
skills/using-worktreedb/SKILL.md CREATE
skills/safe-db-migrations/SKILL.md CREATE
AGENTS.md                        MODIFY: dependency allowlist + go-sdk entry, builds/MCP notes
go.mod / go.sum                  MODIFY: + modelcontextprotocol/go-sdk (Task 12)
integration/builds_mcp_test.go   CREATE: //go:build integration — builds surface + MCP handshake smoke

devdb repo (Task 17 only):
tests/integration/helpers/fixture-registry.ts  MODIFY: image-agnostic state injection helper
tests/integration/pg-builds.test.ts            MODIFY: machinery only — injection via the helper
docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md  MODIFY: + M3 gate section + result line
```

**Task dependency order:** 1 → 2 → {3 → 4} → 5 → 6 → 7 → 8 → 9 → 10 → 11 (independent after 3) → 12 → 13 → 14 → 15 → 16 → 17. Task 11 can land any time after Task 3; Tasks 5–8 build strictly on each other.

---

### Task 1: config — dynamic-build + MCP environment

Add the five new env vars (defaults match the documented posture: Docker-Hub-anonymous default, GHCR opt-in, token = secret) plus the two derived data-dir paths. The token is a SECRET: it lives only on the Config struct, is never logged, and never appears in any DTO or error.

**Files:**
- Modify: `~/git/worktreedb/internal/config/config.go`
- Modify: `~/git/worktreedb/internal/config/config_test.go`

**Interfaces:**
- Consumes: M1 `config.Load(getenv func(string) string) (*Config, error)`.
- Produces (later tasks rely on these exact fields):
  - `Config.PgRegistryBase string` (default `https://registry-1.docker.io`, trailing slashes stripped, must be http(s))
  - `Config.PgImageTemplate string` (default `neondatabase/compute-node-v{major}`, must contain `{major}`)
  - `Config.PgRegistryToken string` (`""` = anonymous; whitespace-only normalizes to `""`)
  - `Config.MCPAllowedHosts []string`, `Config.MCPAllowedOrigins []string` (comma-separated, trimmed, empties dropped; default empty)
  - `Config.PgBuildsDir string` = `<DataDir>/pg_builds`, `Config.PgDistribDir string` = `<DataDir>/pg_distrib`

- [ ] **Step 1: Write the failing tests** — append to `internal/config/config_test.go`:

```go
func TestBuildAndMCPEnvDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"WORKTREEDB_DATA_DIR":       "/data",
		"WORKTREEDB_NEON_BIN_DIR":   "/usr/local/share/neon/bin",
		"WORKTREEDB_PG_INSTALL_DIR": "/usr/local/share/neon/pg_install",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PgRegistryBase != "https://registry-1.docker.io" {
		t.Errorf("PgRegistryBase = %q", cfg.PgRegistryBase)
	}
	if cfg.PgImageTemplate != "neondatabase/compute-node-v{major}" {
		t.Errorf("PgImageTemplate = %q", cfg.PgImageTemplate)
	}
	if cfg.PgRegistryToken != "" {
		t.Errorf("PgRegistryToken = %q, want empty (anonymous)", cfg.PgRegistryToken)
	}
	if len(cfg.MCPAllowedHosts) != 0 || len(cfg.MCPAllowedOrigins) != 0 {
		t.Errorf("MCP allowlists should default empty: %v %v", cfg.MCPAllowedHosts, cfg.MCPAllowedOrigins)
	}
	if cfg.PgBuildsDir != "/data/pg_builds" || cfg.PgDistribDir != "/data/pg_distrib" {
		t.Errorf("derived dirs: %q %q", cfg.PgBuildsDir, cfg.PgDistribDir)
	}
}

func TestBuildEnvOverridesAndValidation(t *testing.T) {
	base := map[string]string{
		"WORKTREEDB_DATA_DIR":       "/data",
		"WORKTREEDB_NEON_BIN_DIR":   "/usr/local/share/neon/bin",
		"WORKTREEDB_PG_INSTALL_DIR": "/usr/local/share/neon/pg_install",
	}
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for kk, vv := range base {
			m[kk] = vv
		}
		m[k] = v
		return m
	}

	cfg, err := Load(env(with("WORKTREEDB_PG_REGISTRY_BASE", "http://pgregistry:5000/")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PgRegistryBase != "http://pgregistry:5000" {
		t.Errorf("trailing slash not stripped: %q", cfg.PgRegistryBase)
	}

	if _, err := Load(env(with("WORKTREEDB_PG_REGISTRY_BASE", "ftp://nope"))); err == nil {
		t.Error("non-http(s) registry base must be rejected")
	}
	if _, err := Load(env(with("WORKTREEDB_PG_IMAGE_TEMPLATE", "no-placeholder"))); err == nil {
		t.Error("template without {major} must be rejected")
	}

	cfg, err = Load(env(with("WORKTREEDB_PG_REGISTRY_TOKEN", "   ")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PgRegistryToken != "" {
		t.Error("whitespace-only token must normalize to unset (never a broken Basic auth attempt)")
	}

	cfg, err = Load(env(with("WORKTREEDB_MCP_ALLOWED_HOSTS", " db.internal , ,other:4400 ")))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPAllowedHosts) != 2 || cfg.MCPAllowedHosts[0] != "db.internal" || cfg.MCPAllowedHosts[1] != "other:4400" {
		t.Errorf("MCPAllowedHosts = %v", cfg.MCPAllowedHosts)
	}
}
```

If `config_test.go` has no `env` helper yet, add it once at the top of the file (skip this if an equivalent already exists — check first):

```go
func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -run 'TestBuild' -count=1`
Expected: FAIL — `cfg.PgRegistryBase undefined (type *Config has no field or method PgRegistryBase)` (compile error).

- [ ] **Step 3: Implement** — in `internal/config/config.go`, extend the struct:

```go
type Config struct {
	HTTPPort     int
	DataDir      string
	PortRange    PortRange
	NeonBinDir   string
	PgInstallDir string
	Engine       EnginePorts

	// Dynamic PostgreSQL builds. The default posture is anonymous Docker Hub
	// (neondatabase compute images); mirrors/private registries opt in via
	// the three overrides. PgRegistryToken is a SECRET: presented only to the
	// registry token endpoint via HTTP Basic — never logged, never in a DTO,
	// never in an error message.
	PgRegistryBase  string
	PgImageTemplate string
	PgRegistryToken string
	PgBuildsDir     string // <DataDir>/pg_builds — downloaded installs
	PgDistribDir    string // <DataDir>/pg_distrib — composed pg_distrib_dir farm

	// MCP DNS-rebinding allowlists (hostnames/origins beyond the built-in
	// loopback set). Operator-supplied; compared as canonical hostnames.
	MCPAllowedHosts   []string
	MCPAllowedOrigins []string
}
```

and at the end of `Load`, before `return cfg, nil`:

```go
	registryBase := strings.TrimSpace(getenv("WORKTREEDB_PG_REGISTRY_BASE"))
	if registryBase == "" {
		registryBase = "https://registry-1.docker.io"
	}
	registryBase = strings.TrimRight(registryBase, "/")
	if !strings.HasPrefix(registryBase, "http://") && !strings.HasPrefix(registryBase, "https://") {
		return nil, fmt.Errorf("WORKTREEDB_PG_REGISTRY_BASE must be an http(s) URL, got: %s", registryBase)
	}
	cfg.PgRegistryBase = registryBase

	template := strings.TrimSpace(getenv("WORKTREEDB_PG_IMAGE_TEMPLATE"))
	if template == "" {
		template = "neondatabase/compute-node-v{major}"
	}
	if !strings.Contains(template, "{major}") {
		return nil, fmt.Errorf("WORKTREEDB_PG_IMAGE_TEMPLATE must contain the literal {major} placeholder, got: %s", template)
	}
	cfg.PgImageTemplate = template

	// Whitespace-only normalizes to unset so a stray space can never produce
	// a broken empty-password Basic auth attempt — unset means anonymous.
	cfg.PgRegistryToken = strings.TrimSpace(getenv("WORKTREEDB_PG_REGISTRY_TOKEN"))

	cfg.PgBuildsDir = filepath.Join(cfg.DataDir, "pg_builds")
	cfg.PgDistribDir = filepath.Join(cfg.DataDir, "pg_distrib")

	cfg.MCPAllowedHosts = splitList(getenv("WORKTREEDB_MCP_ALLOWED_HOSTS"))
	cfg.MCPAllowedOrigins = splitList(getenv("WORKTREEDB_MCP_ALLOWED_ORIGINS"))
```

and the helper at package level:

```go
// splitList parses a comma-separated env list: entries trimmed, empties dropped.
func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -count=1`
Expected: PASS (all config tests, old and new).

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/config/ && git commit -m "feat(config): registry/build and MCP allowlist environment"
```

---

### Task 2: store — pg_builds/pg_actives accessors

The tables already exist in schema v2 (`internal/store/schema.go:66-84`) — **verified against what this milestone needs: no migration required.** `pg_builds` carries `id, major, minor, source, release_tag, image_digest, path, size_bytes, status, error, created_at`; the per-row `active` flag is DELIBERATELY absent — the active pointer is `pg_actives.active_build_id`, exclusive-per-major by primary key (the "setActiveExclusive" bug class is structural here). `release_tag`/`image_digest`/`path` are nullable in DDL; the accessors always write them (empty string, never NULL) so reads need no NULL handling — `''` is the baked/unknown digest sentinel.

**Files:**
- Create: `~/git/worktreedb/internal/store/builds.go`
- Create: `~/git/worktreedb/internal/store/builds_test.go`

**Interfaces:**
- Consumes: M1 `store.Store` (`db`, `NowISO`, `NewID`).
- Produces (later tasks rely on these exact names):
  - `type PgBuildRow struct { ID string; Major int; Minor *int; Source, ReleaseTag, ImageDigest, Path string; SizeBytes *int64; Status string; Error *string; CreatedAt string }`
  - `type PgBuildParams struct { ID string; Major int; Minor *int; Source, ReleaseTag, ImageDigest, Path, Status string }`
  - `func (s *Store) CreatePgBuild(ctx, p PgBuildParams) error`
  - `func (s *Store) PgBuildByID(ctx, id) (PgBuildRow, bool, error)` · `PgBuilds(ctx) ([]PgBuildRow, error)` (ordered `created_at, id`) · `PgBuildsByMajor(ctx, major) ([]PgBuildRow, error)`
  - `func (s *Store) PgBuildByDigest(ctx, digest string) (PgBuildRow, bool, error)` — excludes `''`, prefers `ready`, then newest
  - `func (s *Store) SetPgBuildStatus(ctx, id, status, errMsg string) error` (`errMsg == ""` stores NULL)
  - `func (s *Store) SetPgBuildDigestPath(ctx, id, digest, path string) error` · `SetPgBuildPath(ctx, id, path string) error` · `SetPgBuildMinor(ctx, id, minor int) error` · `SetPgBuildDetected(ctx, id, minor int, sizeBytes *int64) error`
  - `func (s *Store) DeletePgBuild(ctx, id) error`
  - `func (s *Store) ActiveBuildID(ctx, major int) (string, bool, error)` · `SetActiveBuild(ctx, major int, buildID string) error` (upsert, preserves `last_run_minor`) · `ClearActiveBuild(ctx, major int) error`
  - `func (s *Store) LastRunMinor(ctx, major int) (*int, error)` · `RecordRun(ctx, major, minor int) error` (raise-only) · `SetLastRunMinor(ctx, major, minor int) error` (explicit set — consented rollback)

- [ ] **Step 1: Write the failing tests** — `internal/store/builds_test.go`:

```go
package store

import (
	"context"
	"testing"
)

func intp(v int) *int { return &v }

func TestPgBuildRowsRoundTrip(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.CreatePgBuild(ctx, PgBuildParams{
		ID: "baked-v17", Major: 17, Minor: intp(5), Source: "baked",
		ReleaseTag: "baked", ImageDigest: "", Path: "/usr/local/share/neon/pg_install/v17",
		Status: "ready",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreatePgBuild(ctx, PgBuildParams{
		ID: "dl-1", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: "", Path: "", Status: "downloading",
	}); err != nil {
		t.Fatal(err)
	}

	row, ok, err := s.PgBuildByID(ctx, "baked-v17")
	if err != nil || !ok {
		t.Fatalf("PgBuildByID: %v %v", ok, err)
	}
	if row.Major != 17 || row.Minor == nil || *row.Minor != 5 || row.Source != "baked" || row.Status != "ready" || row.CreatedAt == "" {
		t.Fatalf("row = %+v", row)
	}
	if row.Error != nil || row.SizeBytes != nil {
		t.Fatalf("fresh row must have nil error/size: %+v", row)
	}

	all, err := s.PgBuilds(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("PgBuilds: %d %v", len(all), err)
	}
	byMajor, err := s.PgBuildsByMajor(ctx, 17)
	if err != nil || len(byMajor) != 2 {
		t.Fatalf("PgBuildsByMajor: %d %v", len(byMajor), err)
	}

	// Status transitions: error set on failed, cleared on non-failed.
	if err := s.SetPgBuildStatus(ctx, "dl-1", "failed", "interrupted by restart"); err != nil {
		t.Fatal(err)
	}
	row, _, _ = s.PgBuildByID(ctx, "dl-1")
	if row.Status != "failed" || row.Error == nil || *row.Error != "interrupted by restart" {
		t.Fatalf("failed row = %+v", row)
	}
	if err := s.SetPgBuildStatus(ctx, "dl-1", "ready", ""); err != nil {
		t.Fatal(err)
	}
	row, _, _ = s.PgBuildByID(ctx, "dl-1")
	if row.Status != "ready" || row.Error != nil {
		t.Fatalf("ready row must clear error: %+v", row)
	}

	if err := s.SetPgBuildDigestPath(ctx, "dl-1", "sha256:abcd", "/data/pg_builds/v17/abcd"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPgBuildDetected(ctx, "dl-1", 4, func() *int64 { v := int64(1024); return &v }()); err != nil {
		t.Fatal(err)
	}
	row, _, _ = s.PgBuildByID(ctx, "dl-1")
	if row.ImageDigest != "sha256:abcd" || row.Path != "/data/pg_builds/v17/abcd" ||
		row.Minor == nil || *row.Minor != 4 || row.SizeBytes == nil || *row.SizeBytes != 1024 {
		t.Fatalf("digest/path/detected: %+v", row)
	}
	if err := s.SetPgBuildPath(ctx, "dl-1", ""); err != nil {
		t.Fatal(err)
	}
	row, _, _ = s.PgBuildByID(ctx, "dl-1")
	if row.Path != "" {
		t.Fatalf("path clear: %+v", row)
	}

	if err := s.DeletePgBuild(ctx, "dl-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.PgBuildByID(ctx, "dl-1"); ok {
		t.Fatal("dl-1 should be gone")
	}
}

func TestPgBuildByDigestPrefersReadyThenNewest(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	mk := func(id, status string) {
		if err := s.CreatePgBuild(ctx, PgBuildParams{
			ID: id, Major: 17, Source: "downloaded", ReleaseTag: "latest",
			ImageDigest: "sha256:d1", Path: "/p/" + id, Status: status,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mk("older-failed", "failed")
	mk("winner-ready", "ready")
	row, ok, err := s.PgBuildByDigest(ctx, "sha256:d1")
	if err != nil || !ok || row.ID != "winner-ready" {
		t.Fatalf("want ready-preferred winner, got %+v ok=%v err=%v", row, ok, err)
	}
	// The '' sentinel (baked/unknown) must never match a dedup lookup.
	if _, ok, _ := s.PgBuildByDigest(ctx, ""); ok {
		t.Fatal("empty digest must not resolve")
	}
}

func TestPgActivesPointerAndHighWater(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if _, ok, _ := s.ActiveBuildID(ctx, 17); ok {
		t.Fatal("no active yet")
	}
	if err := s.SetActiveBuild(ctx, 17, "b1"); err != nil {
		t.Fatal(err)
	}
	id, ok, err := s.ActiveBuildID(ctx, 17)
	if err != nil || !ok || id != "b1" {
		t.Fatalf("active = %q %v %v", id, ok, err)
	}

	// High-water is raise-only via RecordRun…
	if err := s.RecordRun(ctx, 17, 5); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRun(ctx, 17, 3); err != nil {
		t.Fatal(err)
	}
	lr, err := s.LastRunMinor(ctx, 17)
	if err != nil || lr == nil || *lr != 5 {
		t.Fatalf("LastRunMinor = %v %v (want 5: raise-only)", lr, err)
	}
	// …and RecordRun must PRESERVE the active pointer (same row).
	id, ok, _ = s.ActiveBuildID(ctx, 17)
	if !ok || id != "b1" {
		t.Fatalf("RecordRun clobbered active pointer: %q %v", id, ok)
	}
	// SetActiveBuild must PRESERVE the high-water.
	if err := s.SetActiveBuild(ctx, 17, "b2"); err != nil {
		t.Fatal(err)
	}
	if lr, _ = s.LastRunMinor(ctx, 17); lr == nil || *lr != 5 {
		t.Fatalf("SetActiveBuild clobbered high-water: %v", lr)
	}
	// SetLastRunMinor lowers explicitly (consented rollback).
	if err := s.SetLastRunMinor(ctx, 17, 2); err != nil {
		t.Fatal(err)
	}
	if lr, _ = s.LastRunMinor(ctx, 17); lr == nil || *lr != 2 {
		t.Fatalf("SetLastRunMinor = %v", lr)
	}
	if err := s.ClearActiveBuild(ctx, 17); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ = s.ActiveBuildID(ctx, 17); ok {
		t.Fatal("ClearActiveBuild left a pointer")
	}
	// Clearing must also preserve the high-water (it lives on the same row).
	if lr, _ = s.LastRunMinor(ctx, 17); lr == nil || *lr != 2 {
		t.Fatalf("ClearActiveBuild clobbered high-water: %v", lr)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -run 'TestPg' -count=1`
Expected: FAIL — `undefined: PgBuildParams` (compile error).

- [ ] **Step 3: Implement** — `internal/store/builds.go`:

```go
package store

import (
	"context"
	"database/sql"
	"errors"
)

// PgBuildRow is one PostgreSQL install the daemon tracks: baked (ships with
// the image, digest sentinel "") or downloaded (content-addressed by image
// digest). The per-major ACTIVE pointer deliberately does not live on this
// row — it is pg_actives.active_build_id, exclusive by primary key, so two
// rows of one major can never both read active.
type PgBuildRow struct {
	ID          string
	Major       int
	Minor       *int
	Source      string // baked | downloaded
	ReleaseTag  string
	ImageDigest string // "sha256:…" — "" for baked rows (not content-addressed)
	Path        string // install dir; "" when the row owns no directory
	SizeBytes   *int64
	Status      string // downloading | validating | ready | failed | skipped
	Error       *string
	CreatedAt   string
}

type PgBuildParams struct {
	ID          string
	Major       int
	Minor       *int
	Source      string
	ReleaseTag  string
	ImageDigest string
	Path        string
	Status      string
}

const pgBuildCols = `id, major, minor, source, COALESCE(release_tag,''), COALESCE(image_digest,''),
	COALESCE(path,''), size_bytes, status, error, created_at`

func scanPgBuild(r interface{ Scan(...any) error }) (PgBuildRow, error) {
	var row PgBuildRow
	err := r.Scan(&row.ID, &row.Major, &row.Minor, &row.Source, &row.ReleaseTag,
		&row.ImageDigest, &row.Path, &row.SizeBytes, &row.Status, &row.Error, &row.CreatedAt)
	return row, err
}

func (s *Store) CreatePgBuild(ctx context.Context, p PgBuildParams) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pg_builds (id, major, minor, source, release_tag, image_digest, path, status, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		p.ID, p.Major, p.Minor, p.Source, p.ReleaseTag, p.ImageDigest, p.Path, p.Status, NowISO())
	return err
}

func (s *Store) PgBuildByID(ctx context.Context, id string) (PgBuildRow, bool, error) {
	row, err := scanPgBuild(s.db.QueryRowContext(ctx,
		`SELECT `+pgBuildCols+` FROM pg_builds WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return PgBuildRow{}, false, nil
	}
	if err != nil {
		return PgBuildRow{}, false, err
	}
	return row, true, nil
}

func (s *Store) pgBuildQuery(ctx context.Context, q string, args ...any) ([]PgBuildRow, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PgBuildRow
	for rows.Next() {
		row, err := scanPgBuild(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Store) PgBuilds(ctx context.Context) ([]PgBuildRow, error) {
	return s.pgBuildQuery(ctx, `SELECT `+pgBuildCols+` FROM pg_builds ORDER BY created_at, id`)
}

func (s *Store) PgBuildsByMajor(ctx context.Context, major int) ([]PgBuildRow, error) {
	return s.pgBuildQuery(ctx,
		`SELECT `+pgBuildCols+` FROM pg_builds WHERE major = ? ORDER BY created_at, id`, major)
}

// PgBuildByDigest is the dedup lookup: rows at this exact digest, ready rows
// first, newest first within a status. The "" sentinel (baked rows, pulls
// whose digest is not yet resolved) is never matched — a dedup against
// "unknown" would be meaningless.
func (s *Store) PgBuildByDigest(ctx context.Context, digest string) (PgBuildRow, bool, error) {
	if digest == "" {
		return PgBuildRow{}, false, nil
	}
	row, err := scanPgBuild(s.db.QueryRowContext(ctx,
		`SELECT `+pgBuildCols+` FROM pg_builds WHERE image_digest = ?
		 ORDER BY CASE WHEN status = 'ready' THEN 0 ELSE 1 END, created_at DESC, id LIMIT 1`, digest))
	if errors.Is(err, sql.ErrNoRows) {
		return PgBuildRow{}, false, nil
	}
	if err != nil {
		return PgBuildRow{}, false, err
	}
	return row, true, nil
}

// SetPgBuildStatus flips a row's status; errMsg "" stores NULL (only failed/
// skipped rows carry text).
func (s *Store) SetPgBuildStatus(ctx context.Context, id, status, errMsg string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pg_builds SET status = ?, error = NULLIF(?, '') WHERE id = ?`, status, errMsg, id)
	return err
}

func (s *Store) SetPgBuildDigestPath(ctx context.Context, id, digest, path string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pg_builds SET image_digest = ?, path = ? WHERE id = ?`, digest, path, id)
	return err
}

func (s *Store) SetPgBuildPath(ctx context.Context, id, path string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE pg_builds SET path = ? WHERE id = ?`, path, id)
	return err
}

func (s *Store) SetPgBuildMinor(ctx context.Context, id string, minor int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE pg_builds SET minor = ? WHERE id = ?`, minor, id)
	return err
}

func (s *Store) SetPgBuildDetected(ctx context.Context, id string, minor int, sizeBytes *int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pg_builds SET minor = ?, size_bytes = ? WHERE id = ?`, minor, sizeBytes, id)
	return err
}

func (s *Store) DeletePgBuild(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pg_builds WHERE id = ?`, id)
	return err
}

// --- pg_actives: the per-major active pointer + last_run_minor high-water.

func (s *Store) ActiveBuildID(ctx context.Context, major int) (string, bool, error) {
	var id *string
	err := s.db.QueryRowContext(ctx,
		`SELECT active_build_id FROM pg_actives WHERE major = ?`, major).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && id == nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return *id, true, nil
}

// SetActiveBuild points the major at buildID, preserving last_run_minor.
// Exclusivity is structural: major is the primary key, so one pointer per
// major exists by construction.
func (s *Store) SetActiveBuild(ctx context.Context, major int, buildID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pg_actives (major, active_build_id) VALUES (?, ?)
		 ON CONFLICT(major) DO UPDATE SET active_build_id = excluded.active_build_id`, major, buildID)
	return err
}

func (s *Store) ClearActiveBuild(ctx context.Context, major int) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pg_actives SET active_build_id = NULL WHERE major = ?`, major)
	return err
}

func (s *Store) LastRunMinor(ctx context.Context, major int) (*int, error) {
	var minor *int
	err := s.db.QueryRowContext(ctx,
		`SELECT last_run_minor FROM pg_actives WHERE major = ?`, major).Scan(&minor)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return minor, err
}

// RecordRun is the raise-only high-water mark: an endpoint START of
// major.minor. It never lowers (the downgrade guard compares against this;
// only SetLastRunMinor — consented rollback — lowers) and never touches the
// active pointer.
func (s *Store) RecordRun(ctx context.Context, major, minor int) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pg_actives (major, last_run_minor) VALUES (?, ?)
		 ON CONFLICT(major) DO UPDATE SET last_run_minor = MAX(COALESCE(last_run_minor, 0), excluded.last_run_minor)`,
		major, minor)
	return err
}

func (s *Store) SetLastRunMinor(ctx context.Context, major, minor int) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pg_actives (major, last_run_minor) VALUES (?, ?)
		 ON CONFLICT(major) DO UPDATE SET last_run_minor = excluded.last_run_minor`, major, minor)
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/store/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/store/builds.go internal/store/builds_test.go && git commit -m "feat(store): pg_builds and pg_actives accessors"
```

---

### Task 3: oci — registry-v2 client (auth arms, manifest walk, digest pinning)

A zero-dependency Docker-registry-v2 / OCI-distribution client over `net/http`. Anonymous-first: only on a 401 Bearer challenge does it fetch a token from the advertised realm (echoing `service`+`scope`), caching it per repo; when a token is configured (private GHCR) it is presented to the TOKEN ENDPOINT via HTTP Basic (`x-access-token:<token>`) — the token never appears in URLs, logs, or errors. Digest discipline is fail-closed: a content-address is EXACTLY `sha256:` + 64 lowercase hex; any manifest fetched by content-address must hash to that ref over its RAW bytes; a direct (single-arch) manifest's digest is COMPUTED by us, never trusted from the `docker-content-digest` header (which must, if present, agree).

**Files:**
- Create: `~/git/worktreedb/internal/oci/client.go`
- Create: `~/git/worktreedb/internal/oci/client_test.go`

**Interfaces:**
- Consumes: nothing project-internal (stdlib only).
- Produces (Tasks 4/8 rely on these exact names):
  - `type Client struct { … }` and `func NewClient(o ClientOpts) *Client` with `ClientOpts{RegistryBase string; Arch string; AuthToken string; Log *slog.Logger}` (`Arch` "" defaults to the runtime arch mapped to `amd64`/`arm64`; `AuthToken` "" = anonymous)
  - `func (c *Client) ResolveDigest(ctx context.Context, repository, tag string) (string, error)` — returns `sha256:…`
  - `type LayerDescriptor struct { MediaType, Digest string; Size int64 }`
  - `func (c *Client) imageManifest(ctx context.Context, repository, digest string) ([]LayerDescriptor, error)` (unexported; PullPrefix in Task 4 uses it)
  - `var SHA256DigestRe = regexp.MustCompile("^sha256:[0-9a-f]{64}$")`
  - `func ShortDigest(digest string) string` — first 16 hex chars, `sha256:` prefix stripped (names build dirs and adopted-row ids)

- [ ] **Step 1: Write the failing tests** — `internal/oci/client_test.go`:

```go
package oci

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func sha(b []byte) string { h := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(h[:]) }

// fakeRegistry is an in-memory registry-v2: manifests by "<repo>/<ref>", blobs
// by digest. When challenge is set, unauthenticated requests get a 401 Bearer
// challenge pointing at its own /token endpoint.
type fakeRegistry struct {
	manifests map[string][]byte // key repo+"/"+ref
	manifestT map[string]string // content-type per key
	blobs     map[string][]byte
	challenge bool
	wantBasic string // require this Authorization header on /token when set
	tokenHits int
}

func (f *fakeRegistry) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		f.tokenHits++
		if f.wantBasic != "" && r.Header.Get("Authorization") != f.wantBasic {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "tok123"})
	})
	mux.HandleFunc("/v2/", func(w http.ResponseWriter, r *http.Request) {
		if f.challenge && r.Header.Get("Authorization") != "Bearer tok123" {
			w.Header().Set("WWW-Authenticate",
				fmt.Sprintf(`Bearer realm="http://%s/token",service="reg",scope="repository:x:pull"`, r.Host))
			w.WriteHeader(401)
			return
		}
		var repo, kind, ref string
		if n, _ := fmt.Sscanf(r.URL.Path, "/v2/%s", &repo); n == 1 {
			// path shape: /v2/<repo…>/manifests/<ref> or /v2/<repo…>/blobs/<digest>
		}
		path := r.URL.Path[len("/v2/"):]
		for _, k := range []string{"/manifests/", "/blobs/"} {
			if i := indexOf(path, k); i >= 0 {
				repo, kind, ref = path[:i], k, path[i+len(k):]
			}
		}
		switch kind {
		case "/manifests/":
			body, ok := f.manifests[repo+"/"+ref]
			if !ok {
				w.WriteHeader(404)
				return
			}
			if ct := f.manifestT[repo+"/"+ref]; ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			_, _ = w.Write(body)
		case "/blobs/":
			body, ok := f.blobs[ref]
			if !ok {
				w.WriteHeader(404)
				return
			}
			_, _ = w.Write(body)
		default:
			w.WriteHeader(404)
		}
	})
	return mux
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func singleManifest(layers []LayerDescriptor) []byte {
	type layerJSON struct {
		MediaType string `json:"mediaType"`
		Size      int64  `json:"size"`
		Digest    string `json:"digest"`
	}
	ls := make([]layerJSON, len(layers))
	for i, l := range layers {
		ls[i] = layerJSON{MediaType: l.MediaType, Size: l.Size, Digest: l.Digest}
	}
	b, _ := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.docker.distribution.manifest.v2+json",
		"layers":        ls,
	})
	return b
}

func TestResolveDigestComputesOverRawBytes(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	m := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: sha([]byte("l1")), Size: 2}})
	reg.manifests["acme/pg/latest"] = m
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL})
	got, err := c.ResolveDigest(context.Background(), "acme/pg", "latest")
	if err != nil {
		t.Fatal(err)
	}
	if got != sha(m) {
		t.Fatalf("digest = %s, want sha over raw bytes %s", got, sha(m))
	}
}

func TestResolveDigestSelectsArchFromIndex(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	arm := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.oci.image.layer.v1.tar+gzip", Digest: sha([]byte("a")), Size: 1}})
	armDigest := sha(arm)
	index, _ := json.Marshal(map[string]any{
		"schemaVersion": 2,
		"manifests": []map[string]any{
			{"digest": "sha256:" + hexOfLen(64, 'b'), "platform": map[string]string{"os": "linux", "architecture": "amd64"}},
			{"digest": armDigest, "platform": map[string]string{"os": "linux", "architecture": "arm64"}},
		},
	})
	reg.manifests["acme/pg/latest"] = index
	reg.manifests["acme/pg/"+armDigest] = arm
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL, Arch: "arm64"})
	got, err := c.ResolveDigest(context.Background(), "acme/pg", "latest")
	if err != nil {
		t.Fatal(err)
	}
	if got != armDigest {
		t.Fatalf("digest = %s, want the linux/arm64 entry %s", got, armDigest)
	}
}

func hexOfLen(n int, ch byte) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = ch
	}
	return string(b)
}

func TestIndexEntryWithMutableRefIsRejected(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	index, _ := json.Marshal(map[string]any{
		"manifests": []map[string]any{
			{"digest": "latest", "platform": map[string]string{"os": "linux", "architecture": "arm64"}},
		},
	})
	reg.manifests["acme/pg/latest"] = index
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL, Arch: "arm64"})
	if _, err := c.ResolveDigest(context.Background(), "acme/pg", "latest"); err == nil {
		t.Fatal("a non-content-address arch descriptor must fail closed")
	}
}

func TestManifestDigestMismatchRejected(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	m := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: sha([]byte("x")), Size: 1}})
	lie := "sha256:" + hexOfLen(64, 'c')
	reg.manifests["acme/pg/"+lie] = m // served under a digest it does not hash to
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL})
	if _, err := c.imageManifest(context.Background(), "acme/pg", lie); err == nil {
		t.Fatal("manifest whose bytes do not hash to the requested content-address must be rejected")
	}
}

func TestAnonymousBearerChallengeFlow(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}, challenge: true}
	m := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: sha([]byte("x")), Size: 1}})
	reg.manifests["acme/pg/latest"] = m
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL})
	if _, err := c.ResolveDigest(context.Background(), "acme/pg", "latest"); err != nil {
		t.Fatal(err)
	}
	if reg.tokenHits != 1 {
		t.Fatalf("token endpoint hits = %d, want 1", reg.tokenHits)
	}
	// Second call reuses the cached repo token — no second challenge round-trip.
	if _, err := c.ResolveDigest(context.Background(), "acme/pg", "latest"); err != nil {
		t.Fatal(err)
	}
	if reg.tokenHits != 1 {
		t.Fatalf("token endpoint hits after cache = %d, want still 1", reg.tokenHits)
	}
}

func TestConfiguredTokenGoesToTokenEndpointAsBasic(t *testing.T) {
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}, challenge: true}
	m := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: sha([]byte("x")), Size: 1}})
	reg.manifests["acme/pg/latest"] = m
	reg.wantBasic = "Basic " + basicOf("x-access-token", "PAT")
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()

	c := NewClient(ClientOpts{RegistryBase: srv.URL, AuthToken: "PAT"})
	if _, err := c.ResolveDigest(context.Background(), "acme/pg", "latest"); err != nil {
		t.Fatal(err)
	}
}

func basicOf(user, pass string) string {
	return base64std(user + ":" + pass)
}
```

Add at the bottom of the test file (kept out of the client to prove the encoding independently):

```go
func base64std(s string) string {
	const tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out []byte
	b := []byte(s)
	for i := 0; i < len(b); i += 3 {
		var n, pad int
		n = int(b[i]) << 16
		if i+1 < len(b) {
			n |= int(b[i+1]) << 8
		} else {
			pad++
		}
		if i+2 < len(b) {
			n |= int(b[i+2])
		} else {
			pad++
		}
		out = append(out, tbl[(n>>18)&63], tbl[(n>>12)&63])
		if pad < 2 {
			out = append(out, tbl[(n>>6)&63])
		} else {
			out = append(out, '=')
		}
		if pad < 1 {
			out = append(out, tbl[n&63])
		} else {
			out = append(out, '=')
		}
	}
	return string(out)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/oci/ -count=1`
Expected: FAIL — `undefined: NewClient` (compile error; the package does not exist yet, `go test` reports "no Go files" or build failure — either counts as RED).

- [ ] **Step 3: Implement** — `internal/oci/client.go`:

```go
// Package oci is a zero-dependency Docker-registry-v2 / OCI-distribution
// client: it resolves a tag to a content-address, walks the manifest, and
// (extract.go) pulls an image's gzipped tar layers, verifying every blob's
// content-address, extracting ONLY the usr/local/ prefix overlay-style.
// Protocol grounding: the OCI distribution spec (registry HTTP API) and OCI
// image spec (manifest/index media types, layer changesets, whiteouts).
package oci

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// A content-address is exactly `sha256:` + 64 lowercase hex. Anything else (a
// tag like `latest`, truncated/wrong-cased hex, another algo) is NOT
// content-addressed and must never be fetched-and-trusted.
var SHA256DigestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ShortDigest is the first 16 hex chars of a sha256 image digest — the
// content-address component used for a downloaded build's directory name
// (v{major}/{shortDigest}, .tmp-{shortDigest} while extracting) and its
// adopted-row id (dl-{major}-{shortDigest}). Tags are NOT identity: a mutable
// tag re-pulled at a newer digest lands in a new dir beside the old one.
func ShortDigest(digest string) string {
	return strings.TrimPrefix(digest, "sha256:")[:16]
}

// Accept both Docker (list/manifest v2) and OCI (index/manifest v1) media
// types — Docker Hub serves the former for compute images, OCI-first mirrors
// the latter. LOAD-BEARING: without these, registry:2 transcodes a schema2
// manifest to schema1 and the content digest changes.
const manifestAccept = "application/vnd.docker.distribution.manifest.list.v2+json, " +
	"application/vnd.oci.image.index.v1+json, " +
	"application/vnd.docker.distribution.manifest.v2+json, " +
	"application/vnd.oci.image.manifest.v1+json"

type LayerDescriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
}

type imageIndexDoc struct {
	Manifests []struct {
		Digest   string `json:"digest"`
		Platform *struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
		} `json:"platform"`
	} `json:"manifests"`
}

type ClientOpts struct {
	// RegistryBase is scheme+host, e.g. "https://registry-1.docker.io" or a
	// plain-HTTP in-network mirror. No trailing slash.
	RegistryBase string
	// Arch overrides the platform architecture selected from an image index;
	// "" maps the runtime arch (arm64 stays arm64, everything else amd64).
	Arch string
	// AuthToken, when set, is a registry credential presented to the TOKEN
	// endpoint via HTTP Basic when the registry challenges (private
	// registries mint scoped bearers for a PAT supplied as the password with
	// any username — "x-access-token" is the conventional placeholder). It is
	// a SECRET: held only here, never logged, never in an error.
	AuthToken string
	Log       *slog.Logger
}

type Client struct {
	opts   ClientOpts
	client *http.Client

	mu     sync.Mutex
	tokens map[string]string // repo → bearer token (client-lifetime cache)
}

func NewClient(o ClientOpts) *Client {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	return &Client{opts: o, client: &http.Client{}, tokens: map[string]string{}}
}

func (c *Client) arch() string {
	if c.opts.Arch != "" {
		return c.opts.Arch
	}
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}

// authedGet is anonymous-first: only on a 401 Bearer challenge does it fetch
// a token from the advertised realm (echoing service+scope back), cache it
// per repo, and retry once. Docker Hub challenges anonymous pulls; a plain
// in-network registry never does.
func (c *Client) authedGet(ctx context.Context, repo, rawURL, accept string, timeout time.Duration) (*http.Response, error) {
	attempt := func() (*http.Response, error) {
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		c.mu.Lock()
		if tok := c.tokens[repo]; tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		c.mu.Unlock()
		res, err := c.client.Do(req)
		if err != nil {
			cancel()
			return nil, err
		}
		// The cancel travels with the body: callers close res.Body, which is
		// wrapped so the request context is released with it.
		res.Body = &cancelBody{ReadCloser: res.Body, cancel: cancel}
		return res, nil
	}

	res, err := attempt()
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusUnauthorized {
		challenge := parseBearerChallenge(res.Header.Get("Www-Authenticate"))
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if challenge == nil {
			return nil, fmt.Errorf("GET %s failed: 401 with no usable Bearer challenge", rawURL)
		}
		if err := c.fetchToken(ctx, repo, challenge); err != nil {
			return nil, err
		}
		res, err = attempt()
		if err != nil {
			return nil, err
		}
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		_ = res.Body.Close()
		return nil, fmt.Errorf("GET %s failed: %d %s", rawURL, res.StatusCode, string(body))
	}
	return res, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

type bearerChallenge struct{ realm, service, scope string }

// `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` (params in any order).
func parseBearerChallenge(header string) *bearerChallenge {
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return nil
	}
	params := map[string]string{}
	for _, m := range regexp.MustCompile(`(\w+)="([^"]*)"`).FindAllStringSubmatch(header, -1) {
		params[strings.ToLower(m[1])] = m[2]
	}
	if params["realm"] == "" {
		return nil
	}
	return &bearerChallenge{realm: params["realm"], service: params["service"], scope: params["scope"]}
}

func (c *Client) fetchToken(ctx context.Context, repo string, ch *bearerChallenge) error {
	tokenURL, err := url.Parse(ch.realm)
	if err != nil {
		return fmt.Errorf("bearer realm is not a URL: %w", err)
	}
	q := tokenURL.Query()
	if ch.service != "" {
		q.Set("service", ch.service)
	}
	if ch.scope != "" {
		q.Set("scope", ch.scope)
	}
	tokenURL.RawQuery = q.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, tokenURL.String(), nil)
	if err != nil {
		return err
	}
	// Private-registry auth: the configured token goes ONLY into this request
	// header — never into tokenURL, a log line, or the errors below.
	if c.opts.AuthToken != "" {
		req.Header.Set("Authorization",
			"Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+c.opts.AuthToken)))
	}
	res, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 200))
		return fmt.Errorf("token request %s failed: %d %s", tokenURL.Redacted(), res.StatusCode, string(body))
	}
	var tok struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&tok); err != nil || tok.Token == "" {
		return fmt.Errorf("token endpoint %s returned no token", tokenURL.Redacted())
	}
	c.mu.Lock()
	c.tokens[repo] = tok.Token
	c.mu.Unlock()
	return nil
}

func (c *Client) fetchManifest(ctx context.Context, repo, ref string) ([]byte, *http.Response, error) {
	res, err := c.authedGet(ctx, repo, c.opts.RegistryBase+"/v2/"+repo+"/manifests/"+ref, manifestAccept, 120*time.Second)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, nil, fmt.Errorf("reading manifest %s@%s: %w", repo, ref, err)
	}
	return body, res, nil
}

// verifyManifestDigest: a manifest fetched by content-address MUST hash to
// that ref over its RAW response bytes — without this the digest pin is
// meaningless (a registry or MITM could serve different bytes under the
// requested digest). Tag refs aren't content-addressed, so they aren't checked.
func verifyManifestDigest(body []byte, ref string) error {
	if !strings.HasPrefix(ref, "sha256:") {
		return nil
	}
	got := digestOf(body)
	if got != ref {
		return fmt.Errorf("manifest digest mismatch for %s: got %s", ref, got)
	}
	return nil
}

func digestOf(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// parseManifestDoc discriminates an image index (manifests[]) from an image
// manifest (layers[]) with a real shape check and rejects a body that is
// neither.
func parseManifestDoc(body []byte, repo, ref string) (*imageIndexDoc, []LayerDescriptor, error) {
	var probe struct {
		Manifests json.RawMessage   `json:"manifests"`
		Layers    []LayerDescriptor `json:"layers"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, nil, fmt.Errorf("malformed manifest for %s@%s: not JSON", repo, ref)
	}
	if probe.Manifests != nil {
		var idx imageIndexDoc
		if err := json.Unmarshal(body, &idx); err != nil {
			return nil, nil, fmt.Errorf("malformed manifest for %s@%s: manifests is not an array", repo, ref)
		}
		return &idx, nil, nil
	}
	if probe.Layers == nil {
		return nil, nil, fmt.Errorf("malformed manifest for %s@%s: no layers array", repo, ref)
	}
	return nil, probe.Layers, nil
}

// selectArch pins the selected descriptor to a real content-address BEFORE it
// is fetched: if an index pointed the arch descriptor at a mutable ref, the
// digest verification on the fetched arch-manifest would be a silent no-op —
// fetch-and-trust. Fail closed on anything that isn't sha256:<64hex>.
func (c *Client) selectArch(idx *imageIndexDoc, repo, ref string) (string, error) {
	arch := c.arch()
	for _, m := range idx.Manifests {
		if m.Platform != nil && m.Platform.OS == "linux" && m.Platform.Architecture == arch {
			if !SHA256DigestRe.MatchString(m.Digest) {
				return "", fmt.Errorf("index %s@%s linux/%s descriptor digest is not a sha256 content-address: %s", repo, ref, arch, m.Digest)
			}
			return m.Digest, nil
		}
	}
	return "", fmt.Errorf("no linux/%s manifest in index %s@%s", arch, repo, ref)
}

// ResolveDigest resolves a tag (or digest ref) to the image's content-address
// for this architecture. For a direct (single-arch) manifest the address is
// the sha256 of THIS body, computed by us — never the docker-content-digest
// header verbatim (a hostile registry can set that header to anything); if
// the header is present it MUST agree.
func (c *Client) ResolveDigest(ctx context.Context, repository, tag string) (string, error) {
	body, res, err := c.fetchManifest(ctx, repository, tag)
	if err != nil {
		return "", err
	}
	idx, _, err := parseManifestDoc(body, repository, tag)
	if err != nil {
		return "", err
	}
	if idx != nil {
		return c.selectArch(idx, repository, tag)
	}
	computed := digestOf(body)
	if header := res.Header.Get("Docker-Content-Digest"); header != "" && header != computed {
		return "", fmt.Errorf("docker-content-digest %s does not match computed %s for %s@%s", header, computed, repository, tag)
	}
	return computed, nil
}

// imageManifest fetches the (arch-specific) image manifest for a
// content-address and returns its verified layer list. The caller's digest
// must be a real content-address; an index digest is walked one level to this
// arch's manifest. Every layer descriptor is gated: digest must be a sha256
// content-address BEFORE it is interpolated into a blob URL, and the media
// type must be gzipped tar (zstd etc. cannot be decompressed here).
func (c *Client) imageManifest(ctx context.Context, repository, digest string) ([]LayerDescriptor, error) {
	if !SHA256DigestRe.MatchString(digest) {
		return nil, fmt.Errorf("pull requires a sha256 content-address digest, got: %s", digest)
	}
	body, _, err := c.fetchManifest(ctx, repository, digest)
	if err != nil {
		return nil, err
	}
	if err := verifyManifestDigest(body, digest); err != nil {
		return nil, err
	}
	idx, layers, err := parseManifestDoc(body, repository, digest)
	if err != nil {
		return nil, err
	}
	if idx != nil {
		archDigest, err := c.selectArch(idx, repository, digest)
		if err != nil {
			return nil, err
		}
		archBody, _, err := c.fetchManifest(ctx, repository, archDigest)
		if err != nil {
			return nil, err
		}
		if err := verifyManifestDigest(archBody, archDigest); err != nil {
			return nil, err
		}
		idx2, archLayers, err := parseManifestDoc(archBody, repository, archDigest)
		if err != nil {
			return nil, err
		}
		if idx2 != nil {
			return nil, fmt.Errorf("unexpected nested index for %s@%s", repository, archDigest)
		}
		layers = archLayers
	}
	var gzTar = regexp.MustCompile(`tar(\.|\+)gzip$`)
	for _, l := range layers {
		if !SHA256DigestRe.MatchString(l.Digest) {
			return nil, fmt.Errorf("layer descriptor digest is not a sha256 content-address: %s", l.Digest)
		}
		if !gzTar.MatchString(l.MediaType) {
			return nil, fmt.Errorf("unsupported layer mediaType %s for %s", l.MediaType, l.Digest)
		}
	}
	return layers, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/oci/ -count=1`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/oci/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add internal/oci/ && git commit -m "feat(oci): registry-v2 client with anonymous and token auth arms"
```

---

### Task 4: oci — hardened layer extraction (the contract gets its own gate)

Extraction treats every layer as UNTRUSTED: the per-blob sha check only proves the blob matches the manifest, and a hostile author controls both. The hardened contract, each clause pinned by a test:

1. **Blob content-address**: the sha256 of the COMPRESSED bytes must equal the descriptor digest, streamed while gunzipping to a spool file (peak disk = one layer's tar).
2. **Member-name fail-closed pass**: no member ANYWHERE in the archive may be absolute or carry a `..` path component — any hostile name rejects the WHOLE layer before any disk mutation.
3. **Containment-enforced writes**: extraction happens through `os.Root(extractRoot)` — the kernel-backed traversal guard. Whiteout deletion through a symlinked parent planted by an earlier layer fails structurally (os.Root refuses to traverse a link that leaves the root, and refuses absolute link hops); member writes cannot escape either. Empirically verified during planning (Go 1.26 probe): `root.Symlink("/etc/passwd", …)` and `root.Symlink("../outside", …)` SUCCEED — creation writes data, which is why clause 6's post-extract walk exists — while `root.Remove("evil/keep")` through an escaping link fails with `path escapes from parent`, the exact property the whiteout pass leans on.
4. **Member-type allowlist**: only directories, regular files, symlinks, and hardlinks are materialized. A device/fifo/socket member rejects the layer. A hardlink whose target is not an already-extracted in-tree member fails (`Root.Link` errors) and rejects the layer. Symlinks are WRITTEN verbatim (they are data at this stage).
5. **Whiteouts overlay-correct**: `.wh.<name>` removes the lower-layer entry; `.wh..wh..opq` clears the directory's lower contents; whiteouts apply BEFORE the layer's own adds; the `.wh.*` markers themselves are never materialized.
6. **Post-extract validation in FINAL coordinates**: after the assembled `usr/local` subtree is renamed onto destDir, walk the REAL filesystem (`Lstat`, never following links): every symlink target must resolve inside destDir (absolute targets rejected outright; each link validated independently so no chain composes an escape); any special file rejects; on any unsafe entry the just-created tree is rolled back before the error surfaces.
7. **The install root itself**: before the rename, the assembled `usr/local` must `Lstat` as a REAL directory — a layer that replaced it with a symlink must not become destDir.

**Files:**
- Create: `~/git/worktreedb/internal/oci/extract.go`
- Create: `~/git/worktreedb/internal/oci/extract_test.go`

**Interfaces:**
- Consumes: Task 3 `Client.imageManifest`, `Client.authedGet`, `SHA256DigestRe`.
- Produces (Task 8 relies on this exact name):
  - `func (c *Client) PullPrefix(ctx context.Context, a PullPrefixArgs) error` with `PullPrefixArgs{Repository, Digest, DestDir string; OnProgress func(string)}` — prefix is fixed `usr/local/`; DestDir must not exist; scratch dirs (`.tmp-oci-spool-*`, `.tmp-oci-extract-*`) live NEXT TO DestDir (same filesystem for the final rename; `.tmp-` prefix means boot sweeps reclaim crash leftovers).

- [ ] **Step 1: Write the failing tests** — `internal/oci/extract_test.go`:

```go
package oci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type member struct {
	name     string
	typ      byte // tar.TypeReg etc; 0 = TypeReg
	linkname string
	body     string
	mode     int64
}

func layerTgz(t *testing.T, members []member) []byte {
	t.Helper()
	var tarBuf bytes.Buffer
	tw := tar.NewWriter(&tarBuf)
	for _, m := range members {
		typ := m.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		mode := m.mode
		if mode == 0 {
			mode = 0o755
		}
		hdr := &tar.Header{Name: m.name, Typeflag: typ, Linkname: m.linkname, Mode: mode}
		if typ == tar.TypeReg {
			hdr.Size = int64(len(m.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(m.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	if _, err := zw.Write(tarBuf.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return gz.Bytes()
}

// pullFixture seeds a single-manifest image whose layers are the given tgz
// blobs and returns (client, digest, destDir-under-tempdir).
func pullFixture(t *testing.T, layers ...[]byte) (*Client, string, string) {
	t.Helper()
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	descs := make([]LayerDescriptor, len(layers))
	for i, l := range layers {
		d := sha(l)
		reg.blobs[d] = l
		descs[i] = LayerDescriptor{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: d, Size: int64(len(l))}
	}
	m := singleManifest(descs)
	digest := sha(m)
	reg.manifests["acme/pg/"+digest] = m
	srv := httptest.NewServer(reg.handler(t))
	t.Cleanup(srv.Close)
	dest := filepath.Join(t.TempDir(), "v17", "deadbeef00000000")
	return NewClient(ClientOpts{RegistryBase: srv.URL}), digest, dest
}

func pull(t *testing.T, c *Client, digest, dest string) error {
	t.Helper()
	return c.PullPrefix(context.Background(), PullPrefixArgs{Repository: "acme/pg", Digest: digest, DestDir: dest})
}

func TestPullPrefixHappyPathWithSymlinksAndHardlinks(t *testing.T) {
	c, digest, dest := pullFixture(t, layerTgz(t, []member{
		{name: "usr/", typ: tar.TypeDir},
		{name: "usr/local/", typ: tar.TypeDir},
		{name: "usr/local/bin/", typ: tar.TypeDir},
		{name: "usr/local/bin/postgres", body: "#!/bin/sh\necho pg\n"},
		{name: "usr/local/bin/pg_alias", typ: tar.TypeLink, linkname: "usr/local/bin/postgres"},
		{name: "usr/local/lib/", typ: tar.TypeDir},
		{name: "usr/local/lib/libpq.so", typ: tar.TypeSymlink, linkname: "libpq.so.5"},
		{name: "usr/local/lib/libpq.so.5", body: "elf"},
		{name: "etc/outside-prefix", body: "ignored"},
	}))
	if err := pull(t, c, digest, dest); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "bin", "postgres")); err != nil || len(b) == 0 {
		t.Fatalf("bin/postgres: %v", err)
	}
	if _, err := os.ReadFile(filepath.Join(dest, "bin", "pg_alias")); err != nil {
		t.Fatalf("hardlink alias: %v", err)
	}
	if target, err := os.Readlink(filepath.Join(dest, "lib", "libpq.so")); err != nil || target != "libpq.so.5" {
		t.Fatalf("in-tree symlink: %q %v", target, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "etc")); !os.IsNotExist(err) {
		t.Fatal("out-of-prefix member must not be extracted")
	}
	// Scratch dirs are cleaned up beside dest.
	entries, _ := os.ReadDir(filepath.Dir(dest))
	for _, e := range entries {
		if e.Name() != filepath.Base(dest) {
			t.Fatalf("leftover scratch: %s", e.Name())
		}
	}
}

func TestBlobDigestMismatchRejectsLayer(t *testing.T) {
	good := layerTgz(t, []member{{name: "usr/local/x", body: "a"}})
	c, digest, dest := pullFixture(t, good)
	// Corrupt the stored blob AFTER the manifest committed to its digest.
	// Rebuild the fixture by hand: swap the blob bytes under the same digest key.
	reg := &fakeRegistry{manifests: map[string][]byte{}, manifestT: map[string]string{}, blobs: map[string][]byte{}}
	d := sha(good)
	reg.blobs[d] = layerTgz(t, []member{{name: "usr/local/y", body: "b"}}) // different bytes, same key
	m := singleManifest([]LayerDescriptor{{MediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", Digest: d, Size: 1}})
	digest = sha(m)
	reg.manifests["acme/pg/"+digest] = m
	srv := httptest.NewServer(reg.handler(t))
	defer srv.Close()
	c = NewClient(ClientOpts{RegistryBase: srv.URL})
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("blob whose compressed bytes do not hash to the descriptor digest must be rejected")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("destDir must not exist after a rejected pull")
	}
}

func TestHostileMemberNamesRejectWholeLayer(t *testing.T) {
	for _, name := range []string{"../evil", "/abs/evil", "usr/local/../../etc/evil", "usr/local/a/../../../evil"} {
		c, digest, dest := pullFixture(t, layerTgz(t, []member{
			{name: "usr/local/ok", body: "x"},
			{name: name, body: "evil"},
		}))
		if err := pull(t, c, digest, dest); err == nil {
			t.Fatalf("member %q must reject the layer", name)
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Fatalf("member %q: destDir must not be created", name)
		}
	}
}

func TestSpecialFileMemberRejects(t *testing.T) {
	c, digest, dest := pullFixture(t, layerTgz(t, []member{
		{name: "usr/local/dev", typ: tar.TypeFifo},
	}))
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("fifo/device/socket members must reject the layer")
	}
}

func TestEscapingSymlinkTargetsRejectAndRollBack(t *testing.T) {
	for _, link := range []member{
		{name: "usr/local/evil", typ: tar.TypeSymlink, linkname: "/etc/passwd"},
		{name: "usr/local/evil", typ: tar.TypeSymlink, linkname: "../../../../outside"},
	} {
		c, digest, dest := pullFixture(t, layerTgz(t, []member{
			{name: "usr/local/bin/", typ: tar.TypeDir},
			{name: "usr/local/bin/postgres", body: "x"},
			link,
		}))
		if err := pull(t, c, digest, dest); err == nil {
			t.Fatalf("symlink %q must fail the pull", link.linkname)
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Fatalf("symlink %q: destDir must be rolled back", link.linkname)
		}
	}
}

func TestOutOfTreeHardlinkRejects(t *testing.T) {
	c, digest, dest := pullFixture(t, layerTgz(t, []member{
		{name: "usr/local/steal", typ: tar.TypeLink, linkname: "etc/passwd"},
	}))
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("hardlink to a non-extracted/out-of-subtree target must reject the layer")
	}
}

func TestWhiteoutsApplyOverlayStyle(t *testing.T) {
	lower := layerTgz(t, []member{
		{name: "usr/local/etc/", typ: tar.TypeDir},
		{name: "usr/local/etc/drop.conf", body: "old"},
		{name: "usr/local/opq/", typ: tar.TypeDir},
		{name: "usr/local/opq/stale", body: "old"},
	})
	upper := layerTgz(t, []member{
		{name: "usr/local/etc/.wh.drop.conf"},
		{name: "usr/local/opq/.wh..wh..opq"},
		{name: "usr/local/opq/fresh", body: "new"},
	})
	c, digest, dest := pullFixture(t, lower, upper)
	if err := pull(t, c, digest, dest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "etc", "drop.conf")); !os.IsNotExist(err) {
		t.Fatal("whiteout must remove the lower-layer file")
	}
	if _, err := os.Stat(filepath.Join(dest, "opq", "stale")); !os.IsNotExist(err) {
		t.Fatal("opaque whiteout must clear lower contents")
	}
	if b, err := os.ReadFile(filepath.Join(dest, "opq", "fresh")); err != nil || string(b) != "new" {
		t.Fatalf("opaque dir keeps this layer's adds: %v", err)
	}
	// The .wh.* markers themselves are never materialized.
	if _, err := os.Stat(filepath.Join(dest, "etc", ".wh.drop.conf")); !os.IsNotExist(err) {
		t.Fatal("whiteout marker leaked into the tree")
	}
}

func TestWhiteoutThroughPlantedSymlinkParentRejects(t *testing.T) {
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "keep")
	if err := os.WriteFile(sentinel, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	lower := layerTgz(t, []member{
		{name: "usr/local/evil", typ: tar.TypeSymlink, linkname: outside}, // absolute → also caught later; the point is the whiteout must not traverse it
	})
	upper := layerTgz(t, []member{
		{name: "usr/local/evil/.wh.keep"},
	})
	c, digest, dest := pullFixture(t, lower, upper)
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("whiteout under a symlinked parent must reject, not traverse")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("the out-of-root sentinel must be untouched: %v", err)
	}
}

func TestInstallRootReplacedBySymlinkRejects(t *testing.T) {
	elsewhere := t.TempDir()
	c, digest, dest := pullFixture(t, layerTgz(t, []member{
		{name: "usr/", typ: tar.TypeDir},
		{name: "usr/local", typ: tar.TypeSymlink, linkname: elsewhere},
	}))
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("usr/local as a symlink must never become destDir")
	}
}

func TestDestDirAlreadyExistsRefuses(t *testing.T) {
	c, digest, dest := pullFixture(t, layerTgz(t, []member{{name: "usr/local/x", body: "a"}}))
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := pull(t, c, digest, dest); err == nil {
		t.Fatal("existing destDir must refuse the pull")
	}
}

func TestNonContentAddressDigestRefusedBeforeAnyIO(t *testing.T) {
	c, _, dest := pullFixture(t, layerTgz(t, []member{{name: "usr/local/x", body: "a"}}))
	if err := pull(t, c, "latest", dest); err == nil {
		t.Fatal("PullPrefix must fail closed on a non-sha256 digest")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/oci/ -run 'TestPull|TestBlob|TestHostile|TestSpecial|TestEscaping|TestOutOf|TestWhiteout|TestInstall|TestDest|TestNonContent' -count=1`
Expected: FAIL — `undefined: PullPrefixArgs` (compile error).

- [ ] **Step 3: Implement** — `~/git/worktreedb/internal/oci/extract.go`:

```go
package oci

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// PullPrefixArgs: pull the image at Digest and install its usr/local/ subtree
// at DestDir. DestDir must not exist. OnProgress (optional) receives
// human-readable download progress lines.
type PullPrefixArgs struct {
	Repository string
	Digest     string
	DestDir    string
	OnProgress func(string)
}

const installPrefix = "usr/local/"

// PullPrefix downloads each layer (verifying its compressed content-address),
// applies it overlay-style — whiteouts against lower layers first, then this
// layer's usr/local/ members — into a containment-enforced extract root, and
// finally renames the assembled usr/local onto DestDir, validating the REAL
// tree in DestDir coordinates. Layers are UNTRUSTED: the per-blob sha check
// only proves the blob matches the manifest, and a hostile author controls
// both, so extraction is safe against hostile member names/types/targets on
// its own (see the per-clause guards below; each is pinned by a test).
func (c *Client) PullPrefix(ctx context.Context, a PullPrefixArgs) error {
	// Public boundary: the digest we pull by MUST be a real content-address —
	// a mutable ref would make the manifest digest pin a silent no-op. Fail
	// closed before any network/fs touch.
	if !SHA256DigestRe.MatchString(a.Digest) {
		return fmt.Errorf("PullPrefix requires a sha256 content-address digest, got: %s", a.Digest)
	}
	if _, err := os.Lstat(a.DestDir); err == nil {
		return fmt.Errorf("destDir already exists: %s", a.DestDir)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	layers, err := c.imageManifest(ctx, a.Repository, a.Digest)
	if err != nil {
		return err
	}
	parent := filepath.Dir(a.DestDir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	// Both scratch dirs live NEXT TO destDir, not in the OS temp dir: the
	// final rename must not cross filesystems (destDir sits on the data
	// volume in-container), and the .tmp- prefix means a crash's leftovers
	// are swept at next boot and never adopted.
	spoolDir, err := os.MkdirTemp(parent, ".tmp-oci-spool-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(spoolDir)
	extractRoot, err := os.MkdirTemp(parent, ".tmp-oci-extract-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(extractRoot)

	root, err := os.OpenRoot(extractRoot)
	if err != nil {
		return err
	}
	defer root.Close()

	for i, layer := range layers {
		label := fmt.Sprintf("layer %d/%d", i+1, len(layers))
		spool := filepath.Join(spoolDir, fmt.Sprintf("layer-%d.tar", i+1))
		if err := c.downloadLayer(ctx, a.Repository, layer, spool, label, a.OnProgress); err != nil {
			return err
		}
		if err := applyLayer(root, spool); err != nil {
			return err
		}
		_ = os.Remove(spool) // keep peak spool usage to a single layer's tar
	}

	assembled := filepath.Join(extractRoot, "usr/local")
	st, err := os.Lstat(assembled)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("image %s@%s has no content under %s", a.Repository, a.Digest, installPrefix)
	}
	if err != nil {
		return err
	}
	// The assembled install root must be a REAL directory before it becomes
	// destDir — a layer can replace the still-empty dir with a symlink, and
	// renaming a symlink to destDir would make the validation walk inspect
	// whatever tree the link points AT, never the link.
	if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return fmt.Errorf("extracted %s in %s@%s is not a real directory — refusing to install", installPrefix, a.Repository, a.Digest)
	}
	if err := os.Rename(assembled, a.DestDir); err != nil {
		return err
	}
	// Validate the REAL extracted tree in destDir coordinates (symlink
	// containment + special-file rejection). Coordinate-correct by
	// construction: link targets are resolved in the frame the OS will
	// actually dereference them in. On any unsafe entry, roll back the
	// just-created tree before surfacing the error.
	if err := assertSafeExtractedTree(a.DestDir); err != nil {
		_ = os.RemoveAll(a.DestDir)
		return err
	}
	return nil
}

// downloadLayer streams the blob through BOTH a sha256 hash (compressed bytes
// — the content-address) and gunzip into the spool tar. The computed digest
// MUST match or the layer is rejected.
func (c *Client) downloadLayer(ctx context.Context, repo string, layer LayerDescriptor, spool, label string, onProgress func(string)) error {
	res, err := c.authedGet(ctx, repo, c.opts.RegistryBase+"/v2/"+repo+"/blobs/"+layer.Digest, "", 600*time.Second)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	out, err := os.Create(spool)
	if err != nil {
		return err
	}
	defer out.Close()

	hash := sha256.New()
	var received, lastReported int64
	counting := io.TeeReader(res.Body, hash)
	counting = io.TeeReader(counting, writerFunc(func(p []byte) (int, error) {
		received += int64(len(p))
		if onProgress != nil && received-lastReported >= 5*1024*1024 {
			lastReported = received
			onProgress(fmt.Sprintf("%s: %s / %s", label, mb(received), mb(layer.Size)))
		}
		return len(p), nil
	}))
	gz, err := gzip.NewReader(counting)
	if err != nil {
		return fmt.Errorf("blob %s is not gzip: %w", layer.Digest, err)
	}
	if _, err := io.Copy(out, gz); err != nil { //nolint:gosec // spool is a local temp file; size bounded by the image
		return fmt.Errorf("decompressing blob %s: %w", layer.Digest, err)
	}
	if err := gz.Close(); err != nil {
		return err
	}
	got := "sha256:" + hex.EncodeToString(hash.Sum(nil))
	if got != layer.Digest {
		return fmt.Errorf("sha256 mismatch for layer %s: got %s", layer.Digest, got)
	}
	if onProgress != nil {
		onProgress(fmt.Sprintf("%s: verified sha256", label))
	}
	return out.Close()
}

type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

func mb(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/1e6) }

// applyLayer applies one spooled layer tar into the containment root,
// overlay-style. Two passes over the spool: (1) validate EVERY member name
// fail-closed and collect whiteouts, (2) apply whiteouts, then extract the
// in-prefix members. All disk mutation goes through *os.Root — the kernel
// refuses traversal through any symlink that leaves the root and refuses
// absolute symlink hops, so a whiteout or write under a parent an earlier
// layer replaced with an escaping symlink fails structurally instead of
// following the link out (OCI image spec: layer changeset paths are always
// relative and ..-free; whiteouts are .wh.<name> / .wh..wh..opq applied
// against lower layers).
func applyLayer(root *os.Root, spool string) error {
	// Pass 1: names + whiteout inventory.
	type wh struct{ dir, name string }
	var whiteouts []wh
	var hasPrefixContent bool
	err := walkSpool(spool, func(hdr *tar.Header, _ *tar.Reader) error {
		name := hdr.Name
		norm := path.Clean(name)
		// (1) No member ANYWHERE may be absolute or carry a `..` component —
		// checked over every member (not just in-prefix ones) so a hostile
		// name is caught even when it never matches the prefix.
		if strings.HasPrefix(name, "/") || strings.HasPrefix(norm, "/") ||
			containsDotDot(name) || containsDotDot(norm) {
			return fmt.Errorf("unsafe layer entry: %s", name)
		}
		if !strings.HasPrefix(name, installPrefix) {
			return nil
		}
		hasPrefixContent = true
		if base := path.Base(norm); strings.HasPrefix(base, ".wh.") {
			whiteouts = append(whiteouts, wh{dir: path.Dir(norm), name: base})
			return nil
		}
		// (4) Member-type allowlist: only dir/regular/symlink/hardlink have a
		// place in a postgres install; a device/fifo/socket member rejects
		// the layer before anything is written.
		switch hdr.Typeflag {
		case tar.TypeDir, tar.TypeReg, tar.TypeSymlink, tar.TypeLink:
		default:
			return fmt.Errorf("unsafe layer entry: %s (member type %q)", name, hdr.Typeflag)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !hasPrefixContent && len(whiteouts) == 0 {
		return nil // layer touches nothing under the prefix
	}

	// Pass 2a: whiteouts against lower layers' state. os.Root refuses
	// traversal through escaping symlinks, so these removals cannot be lured
	// out of the extract root; a missing parent means nothing to whiteout.
	for _, w := range whiteouts {
		if w.name == ".wh..wh..opq" {
			// Opaque whiteout: hide ALL lower contents of the dir (dir stays).
			entries, err := fs.ReadDir(root.FS(), w.dir)
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return fmt.Errorf("unsafe whiteout in %s: %w", w.dir, err)
			}
			for _, e := range entries {
				if err := root.RemoveAll(path.Join(w.dir, e.Name())); err != nil {
					return fmt.Errorf("unsafe whiteout in %s: %w", w.dir, err)
				}
			}
			continue
		}
		target := path.Join(w.dir, strings.TrimPrefix(w.name, ".wh."))
		if err := root.RemoveAll(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("unsafe whiteout target %s: %w", target, err)
		}
	}

	// Pass 2b: extract this layer's in-prefix members.
	return walkSpool(spool, func(hdr *tar.Header, tr *tar.Reader) error {
		name := path.Clean(hdr.Name)
		if !strings.HasPrefix(hdr.Name, installPrefix) || strings.HasPrefix(path.Base(name), ".wh.") {
			return nil
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o755); err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
		case tar.TypeReg:
			if err := root.MkdirAll(path.Dir(name), 0o755); err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
			// Overlay semantics: a later layer's file replaces a lower one.
			_ = root.Remove(name)
			mode := os.FileMode(hdr.Mode) & 0o777 //nolint:gosec // tar mode bits, masked
			f, err := root.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
			if _, err := io.Copy(f, tr); err != nil { //nolint:gosec // bounded by the spooled tar
				_ = f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := root.MkdirAll(path.Dir(name), 0o755); err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
			_ = root.Remove(name)
			// The link is WRITTEN verbatim — it is data at this stage; its
			// TARGET is validated post-rename in destDir coordinates.
			if err := root.Symlink(hdr.Linkname, name); err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
		case tar.TypeLink:
			linkTarget := path.Clean(hdr.Linkname)
			if strings.HasPrefix(hdr.Linkname, "/") || containsDotDot(linkTarget) || !strings.HasPrefix(linkTarget, installPrefix) {
				return fmt.Errorf("unsafe layer entry: %s -> %s (hardlink target outside the install subtree)", name, hdr.Linkname)
			}
			if err := root.MkdirAll(path.Dir(name), 0o755); err != nil {
				return fmt.Errorf("unsafe layer entry: %s: %w", name, err)
			}
			_ = root.Remove(name)
			// Root.Link fails unless the target is an already-extracted
			// in-root member — an absent target rejects the layer.
			if err := root.Link(linkTarget, name); err != nil {
				return fmt.Errorf("unsafe layer entry: %s -> %s: %w", name, hdr.Linkname, err)
			}
		}
		return nil
	})
}

func containsDotDot(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func walkSpool(spool string, fn func(*tar.Header, *tar.Reader) error) error {
	f, err := os.Open(spool)
	if err != nil {
		return err
	}
	defer f.Close()
	tr := tar.NewReader(f)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading layer tar: %w", err)
		}
		if err := fn(hdr, tr); err != nil {
			return err
		}
	}
}

// assertSafeExtractedTree walks the REAL filesystem under destDir (Lstat,
// NEVER following a symlink) and rejects anything that has no place in a
// postgres install:
//   - every symlink target must resolve inside destDir, in destDir's OWN
//     coordinate frame — the frame the OS will actually dereference it in.
//     Absolute targets escape by definition. Containment is per-link and
//     independent, so no chain of symlinks can compose an escape.
//   - a symlink is a validated LEAF — the walk never descends THROUGH it, so
//     recursion can't be lured out of the tree by a symlinked subdir.
//   - special files (device/fifo/socket) reject.
func assertSafeExtractedTree(destDir string) error {
	destResolved, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			abs := filepath.Join(dir, e.Name())
			st, err := os.Lstat(abs)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(destDir, abs)
			switch {
			case st.Mode()&os.ModeSymlink != 0:
				target, err := os.Readlink(abs)
				if err != nil {
					return err
				}
				if filepath.IsAbs(target) {
					return fmt.Errorf("unsafe extracted entry: %s -> %s (absolute symlink target)", rel, target)
				}
				resolved := filepath.Clean(filepath.Join(filepath.Dir(abs), target))
				if resolved != destResolved && !strings.HasPrefix(resolved, destResolved+string(filepath.Separator)) {
					return fmt.Errorf("unsafe extracted entry: %s -> %s (symlink escapes install tree)", rel, target)
				}
				continue // leaf — never recurse through a link
			case st.Mode()&(os.ModeDevice|os.ModeCharDevice|os.ModeNamedPipe|os.ModeSocket) != 0:
				return fmt.Errorf("unsafe extracted entry: %s -> special file (device/fifo/socket)", rel)
			case st.IsDir():
				if err := walk(abs); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(destDir)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/oci/ -race -count=1`
Expected: PASS (all client + extraction tests).

- [ ] **Step 5: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/oci/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add internal/oci/ && git commit -m "feat(oci): containment-enforced layer extraction with whiteout and link hardening"
```

---

### Task 5: builds — version detection, incompatibility classification, pg_distrib farm

Two small foundations the registry and pipeline both consume. `DetectVersion` shells `postgres --version` (10 s timeout, direct exec, never a shell); a loader-stage failure (missing soname, GLIBC/OPENSSL symbol) is rewritten into an actionable message carrying the marker phrase that `IsIncompatibilityError` reads back — write and read-back share one constant so they cannot drift. `ComposePgDistrib` assembles the symlink farm the pageserver's `pg_distrib_dir` points at: baked majors ALWAYS win a slot; only majors absent from the baked install get a downloaded target; per-entry atomicity via symlink-to-temp-then-rename.

**Files:**
- Create: `~/git/worktreedb/internal/builds/version.go`
- Create: `~/git/worktreedb/internal/builds/distrib.go`
- Create: `~/git/worktreedb/internal/builds/version_test.go`
- Create: `~/git/worktreedb/internal/builds/distrib_test.go`

**Interfaces:**
- Consumes: stdlib only.
- Produces:
  - `func DetectVersion(ctx context.Context, pgbinPath string) (major, minor int, err error)`
  - `func ClassifyPgVersionError(pgbinPath, raw string) string` and `func IsIncompatibilityError(stored *string) bool`
  - `func MajorMismatchMessage(detectedMajor, minor, requestedMajor int) string` and `func IsMajorMismatchError(stored *string) bool`
  - `func ComposePgDistrib(distribDir, pgInstallDir string, downloadedOnly []DistribEntry) error` with `type DistribEntry struct { Major int; Path string }`

- [ ] **Step 1: Write the failing tests** — `internal/builds/version_test.go`:

```go
package builds

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakePostgres(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "postgres")
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDetectVersionParsesBanner(t *testing.T) {
	p := fakePostgres(t, "#!/bin/sh\necho 'postgres (PostgreSQL) 16.9 (Debian 16.9-1.pgdg120+1)'\n")
	major, minor, err := DetectVersion(context.Background(), p)
	if err != nil || major != 16 || minor != 9 {
		t.Fatalf("got %d.%d %v", major, minor, err)
	}
}

func TestDetectVersionUnparseableOutput(t *testing.T) {
	p := fakePostgres(t, "#!/bin/sh\necho 'not a banner'\n")
	_, _, err := DetectVersion(context.Background(), p)
	if err == nil || !strings.Contains(err.Error(), "unparseable postgres version output") {
		t.Fatalf("err = %v", err)
	}
}

func TestClassifyLoaderFailuresAsIncompatibility(t *testing.T) {
	for _, raw := range []string{
		"error while loading shared libraries: libssl.so.1.1: cannot open shared object file",
		"/x/postgres: symbol lookup error: undefined symbol",
		"version `GLIBC_2.34' not found",
	} {
		msg := ClassifyPgVersionError("/x/postgres", raw)
		if !IsIncompatibilityError(&msg) {
			t.Fatalf("loader failure %q must classify as incompatibility, got %q", raw, msg)
		}
	}
	if got := ClassifyPgVersionError("/x/postgres",
		"error while loading shared libraries: libssl.so.1.1: cannot open shared object file"); !strings.Contains(got, "libssl.so.1.1") {
		t.Fatalf("the missing soname must be named: %q", got)
	}
	// A non-loader failure is a raw passthrough, NOT an incompatibility.
	other := ClassifyPgVersionError("/x/postgres", "exit status 2")
	if IsIncompatibilityError(&other) {
		t.Fatalf("non-loader failure misclassified: %q", other)
	}
	if IsIncompatibilityError(nil) {
		t.Fatal("nil stored error is not an incompatibility")
	}
}

func TestMajorMismatchMessageRoundTrips(t *testing.T) {
	msg := MajorMismatchMessage(16, 9, 17)
	if msg != "image contained postgres 16.9, expected major 17" {
		t.Fatalf("msg = %q", msg)
	}
	if !IsMajorMismatchError(&msg) {
		t.Fatal("write and read-back drifted")
	}
	other := "gate timed out after 90s"
	if IsMajorMismatchError(&other) {
		t.Fatal("unrelated error misread as major mismatch")
	}
}
```

and `internal/builds/distrib_test.go`:

```go
package builds

import (
	"os"
	"path/filepath"
	"testing"
)

func TestComposePgDistribBakedWinsAndDownloadedFillsGaps(t *testing.T) {
	install := t.TempDir()
	for _, d := range []string{"v16", "v17", "vanilla_v17"} {
		if err := os.MkdirAll(filepath.Join(install, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	dl17 := t.TempDir() // a downloaded v17 that must LOSE to baked
	dl18 := t.TempDir() // a downloaded v18 that fills the gap
	distrib := filepath.Join(t.TempDir(), "pg_distrib")

	if err := ComposePgDistrib(distrib, install, []DistribEntry{
		{Major: 17, Path: dl17}, {Major: 18, Path: dl18},
	}); err != nil {
		t.Fatal(err)
	}

	for slot, want := range map[string]string{
		"v16": filepath.Join(install, "v16"),
		"v17": filepath.Join(install, "v17"), // baked always wins its slot
		"v18": dl18,
	} {
		got, err := os.Readlink(filepath.Join(distrib, slot))
		if err != nil || got != want {
			t.Fatalf("slot %s -> %q (%v), want %q", slot, got, err, want)
		}
	}
	if _, err := os.Lstat(filepath.Join(distrib, "vanilla_v17")); !os.IsNotExist(err) {
		t.Fatal("vanilla_* must never get a slot")
	}

	// Recompose without v18: the stale slot is removed; existing slots are
	// atomically replaced (no error on re-run).
	if err := ComposePgDistrib(distrib, install, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(distrib, "v18")); !os.IsNotExist(err) {
		t.Fatal("stale downloaded slot must be removed on recompose")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -count=1`
Expected: FAIL — build error, `undefined: DetectVersion`.

- [ ] **Step 3: Implement** — `internal/builds/version.go`:

```go
// Package builds owns dynamic PostgreSQL installs: detection, the on-disk
// registry (baked + downloaded rows, per-major active pointers), the OCI pull
// pipeline with its validation gate, and the pg_distrib composition the
// pageserver reads WAL-redo binaries from.
package builds

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The load-bearing phrase in a ClassifyPgVersionError incompatibility
// message. Referenced by BOTH the generator and IsIncompatibilityError so
// the write and the read-back can't drift.
const incompatibleRuntimeMarker = "is incompatible with this runtime image"

var (
	loaderFailureRe = regexp.MustCompile(`(?i)error while loading shared libraries|cannot open shared object|symbol lookup error|\b(?:GLIBC|GLIBCXX|CXXABI|OPENSSL|LIBSSL|LIBCRYPTO)_[0-9.]+'?\s+not found`)
	missingLibRe    = regexp.MustCompile(`(?i)([\w.+-]+\.so(?:\.\d+)*): cannot open shared object`)
	versionBannerRe = regexp.MustCompile(`PostgreSQL\)\s+(\d+)\.(\d+)`)
)

// ClassifyPgVersionError rewrites a failed `postgres --version` whose output
// shows the dynamic linker could not resolve the binary's shared libraries —
// a build linked against a DIFFERENT OS base than this runtime image — into
// an actionable message naming the missing soname. Every other failure is a
// raw passthrough.
func ClassifyPgVersionError(pgbinPath, raw string) string {
	if loaderFailureRe.MatchString(raw) {
		lib := ""
		if m := missingLibRe.FindStringSubmatch(raw); m != nil {
			lib = fmt.Sprintf(" (missing shared library %s)", m[1])
		}
		return pgbinPath + " " + incompatibleRuntimeMarker + lib + " — the build targets a different OS base than this container"
	}
	return fmt.Sprintf("%s --version failed: %s", pgbinPath, raw)
}

// IsIncompatibilityError is the read-back predicate over a failed row's
// STORED error column: was the failure an image/runtime-base incompatibility
// (permanent for THIS runtime — re-pulling re-fails identically), as opposed
// to a transient one (gate timeout, disk, a registry 404)?
func IsIncompatibilityError(stored *string) bool {
	return stored != nil && strings.Contains(*stored, incompatibleRuntimeMarker)
}

// MajorMismatchMessage/IsMajorMismatchError: the message the pipeline records
// when an extracted image's real PG major ≠ the requested major, and its
// read-back predicate — co-located so the write and read can't drift. A
// wrong-major tag is PERMANENT per (major, digest): re-pulling re-extracts
// the same wrong-major image, so the check must not advertise it as an
// update.
func MajorMismatchMessage(detectedMajor, minor, requestedMajor int) string {
	return fmt.Sprintf("image contained postgres %d.%d, expected major %d", detectedMajor, minor, requestedMajor)
}

var majorMismatchRe = regexp.MustCompile(`^image contained postgres \d+\.\d+, expected major \d+$`)

func IsMajorMismatchError(stored *string) bool {
	return stored != nil && majorMismatchRe.MatchString(*stored)
}

// DetectVersion runs `postgres --version` (direct exec, never a shell; the
// path came from our own registry rows, but paths are never interpolated
// into shell strings anyway) and parses `postgres (PostgreSQL) 16.9` and
// Debian-suffixed variants.
func DetectVersion(ctx context.Context, pgbinPath string) (int, int, error) {
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(runCtx, pgbinPath, "--version").CombinedOutput()
	if err != nil {
		raw := strings.TrimSpace(string(out))
		if raw == "" {
			raw = err.Error()
		} else {
			raw = raw + ": " + err.Error()
		}
		return 0, 0, fmt.Errorf("%s", ClassifyPgVersionError(pgbinPath, raw))
	}
	m := versionBannerRe.FindStringSubmatch(string(out))
	if m == nil {
		banner := strings.TrimSpace(string(out))
		if len(banner) > 200 {
			banner = banner[:200]
		}
		return 0, 0, fmt.Errorf("unparseable postgres version output: %s", banner)
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major, minor, nil
}
```

and `internal/builds/distrib.go`:

```go
package builds

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

type DistribEntry struct {
	Major int
	Path  string
}

var majorSlotRe = regexp.MustCompile(`^v\d+$`)

// ComposePgDistrib assembles the composed pg_distrib_dir the pageserver
// resolves per-major WAL-redo binaries from: baked majors ALWAYS win a slot
// (minors must never perturb the storage engine's binaries at runtime); only
// majors absent from the baked install get a downloaded target — that is
// what gives a pulled new major its WAL-redo bits. Per-entry atomicity:
// symlink to a temp name then rename over the slot — a pageserver spawning a
// walredo mid-recompose reads either the old or the new target, never a
// missing one. Called at boot (BEFORE the supervisor writes/reads
// pageserver.toml) and after every activate/remove/pull.
// oracle: neon control_plane/src/pageserver.rs (pg_distrib_dir per-major
// resolution is the pageserver's own expectation for locating each major's
// WAL-redo postgres).
func ComposePgDistrib(distribDir, pgInstallDir string, downloadedOnly []DistribEntry) error {
	if err := os.MkdirAll(distribDir, 0o755); err != nil {
		return err
	}
	targets := map[string]string{}
	entries, err := os.ReadDir(pgInstallDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if majorSlotRe.MatchString(e.Name()) { // vanilla_* excluded
			targets[e.Name()] = filepath.Join(pgInstallDir, e.Name())
		}
	}
	for _, d := range downloadedOnly {
		slot := fmt.Sprintf("v%d", d.Major)
		if _, taken := targets[slot]; !taken { // baked always wins its slot
			targets[slot] = d.Path
		}
	}
	for slot, target := range targets {
		tmp := filepath.Join(distribDir, "."+slot+".tmp")
		_ = os.Remove(tmp)
		if err := os.Symlink(target, tmp); err != nil {
			return err
		}
		if err := os.Rename(tmp, filepath.Join(distribDir, slot)); err != nil {
			return err
		}
	}
	existing, err := os.ReadDir(distribDir)
	if err != nil {
		return err
	}
	for _, e := range existing {
		if majorSlotRe.MatchString(e.Name()) {
			if _, keep := targets[e.Name()]; !keep {
				if err := os.Remove(filepath.Join(distribDir, e.Name())); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/builds/ && git commit -m "feat(builds): version detection, incompatibility classification, pg_distrib farm"
```

---

### Task 6: builds — the service, its read model, and boot adoption

The `builds.Service` struct plus everything that makes a volume self-describing across restarts: `SeedBaked` (re-probes baked installs EVERY boot — a new image on a persisted volume is the supported upgrade path), `AdoptVolumeBuilds` (marker shape + location consistency + binary re-detection; a dir already claimed by a row is skipped; ready rows whose binary vanished or drifted are failed), `SweepTmp`, `FailInterrupted` (in-flight rows at boot are crash orphans: fail + reclaim their dirs unless a SURVIVING row claims the same path), `ResolveActives`/`ResolveActiveFor` (newest minor wins, tie → baked; degraded flag when the winner sits below the high-water; majors with no ready candidate get their pointer CLEARED), boot GC (keep active + one newest non-active downloaded per major), and `BootAdopt` composing them in the exact order boot needs.

**Files:**
- Create: `~/git/worktreedb/internal/builds/service.go`
- Create: `~/git/worktreedb/internal/builds/boot.go`
- Create: `~/git/worktreedb/internal/builds/boot_test.go`

**Interfaces:**
- Consumes: Task 2 store accessors; Task 5 `DetectVersion` (injected as a func for tests), `ComposePgDistrib`, `IsIncompatibilityError`/`IsMajorMismatchError`; Task 3 `oci.ShortDigest`; M1 `runtime.NewOwner` (`Owner.Run` is the mutation lane); M2 `events.Bus` (`Publish`), `events.LogHub` (`Ingest`).
- Produces (later tasks rely on these exact names):
  - `type Row struct { store.PgBuildRow; Active bool; InUse bool }`
  - `type CheckResult struct { Tag string `json:"tag"`; Digest string `json:"digest"`; State string `json:"state"`; IsNew bool `json:"isNew"`; At string `json:"at"` }`
  - `type MajorStatus struct { ActiveVersion *string `json:"activeVersion"`; Source *string `json:"source"`; DegradedDowngrade bool `json:"degradedDowngrade"`; UpdateAvailable *string `json:"updateAvailable"` }`
  - `type Puller interface { ResolveDigest(ctx context.Context, repository, tag string) (string, error); PullPrefix(ctx context.Context, a oci.PullPrefixArgs) error }`
  - `type Options struct { Store *store.Store; PgInstallDir, PgBuildsDir, PgDistribDir string; RegistryBase, ImageTemplate string; Puller Puller; Detect func(ctx context.Context, pgbin string) (int, int, error); FreeBytes func(dir string) (uint64, error); RunningPgbins func() []string; Hub *events.LogHub; Bus *events.Bus; Log *slog.Logger; GateTimeout time.Duration; Gate GateFunc }` (`GateFunc` defined in Task 8; until then the field exists with type `func(ctx context.Context, major int, buildPath string) error`)
  - `func New(o Options) *Service` and `func (s *Service) Start(ctx context.Context)` (starts the owner lane)
  - `func (s *Service) List(ctx) ([]Row, error)` — rows with `Active` joined from `pg_actives` and `InUse` derived from `RunningPgbins()` (prefix rule `strings.HasPrefix(p, row.Path+"/")`, skipped for `Path == ""`)
  - `func (s *Service) InstalledMajors(ctx) []int` (majors with ≥1 ready row, ascending) · `DegradedMajors() []int` · `UpdateAvailableFor(major int) *string` (reads the check cache — the cache's WRITER lands in Task 7) · `VersionForPgbin(ctx, pgbinDir string) *string` · `PgbinFor(ctx, major int) (string, error)` (the ACTIVE ready row's `<path>/bin`; else the 409 `*service.Error`)
  - `func (s *Service) BootAdopt(ctx) error` · `RecomposeDistrib(ctx) error`
  - `func (s *Service) versionString(row store.PgBuildRow) string` — `"17.5"` or `"17.x"` when minor unknown (unexported helper; the exact fallback matters for the skip message and MCP text)

- [ ] **Step 1: Write the failing tests** — `internal/builds/boot_test.go`:

```go
package builds

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// fixture builds a Service over a temp store + temp install/builds dirs with
// an injectable version detector keyed by pgbin path.
type fixture struct {
	svc      *Service
	st       *store.Store
	install  string
	buildsD  string
	distrib  string
	versions map[string][2]int // pgbin path → {major, minor}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{
		st:       st,
		install:  filepath.Join(dir, "pg_install"),
		buildsD:  filepath.Join(dir, "pg_builds"),
		distrib:  filepath.Join(dir, "pg_distrib"),
		versions: map[string][2]int{},
	}
	if err := os.MkdirAll(f.install, 0o755); err != nil {
		t.Fatal(err)
	}
	f.svc = New(Options{
		Store: st, PgInstallDir: f.install, PgBuildsDir: f.buildsD, PgDistribDir: f.distrib,
		RegistryBase: "http://unused", ImageTemplate: "acme/pg-v{major}",
		Detect: func(_ context.Context, pgbin string) (int, int, error) {
			v, ok := f.versions[pgbin]
			if !ok {
				return 0, 0, os.ErrNotExist
			}
			return v[0], v[1], nil
		},
		FreeBytes:     func(string) (uint64, error) { return 10 << 30, nil },
		RunningPgbins: func() []string { return nil },
		Hub:           events.NewLogHub(), Bus: events.NewBus(),
		Log: slog.New(slog.DiscardHandler), GateTimeout: time.Second,
		Gate: func(context.Context, int, string) error { return nil },
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	f.svc.Start(ctx)
	return f
}

func (f *fixture) bakedDir(t *testing.T, major, minor int) string {
	t.Helper()
	dir := filepath.Join(f.install, "v"+strconv.Itoa(major))
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.versions[filepath.Join(dir, "bin", "postgres")] = [2]int{major, minor}
	return dir
}

func (f *fixture) downloadedDir(t *testing.T, major, minor int, digest, tag string) string {
	t.Helper()
	short := digest[len("sha256:"):][:16]
	dir := filepath.Join(f.buildsD, "v"+strconv.Itoa(major), short)
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw := `{"digest":"` + digest + `","tag":"` + tag + `","major":` + strconv.Itoa(major) +
		`,"minor":` + strconv.Itoa(minor) + `,"extractedAt":"2026-07-12T00:00:00.000Z"}`
	if err := os.WriteFile(filepath.Join(dir, "build.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	f.versions[filepath.Join(dir, "bin", "postgres")] = [2]int{major, minor}
	return dir
}

const digA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const digB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestBootAdoptSeedsBakedAndAdoptsVolume(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	f.downloadedDir(t, 17, 4, digA, "9999")

	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Row{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	baked, ok := byID["baked-v17"]
	if !ok || baked.Status != "ready" || baked.Minor == nil || *baked.Minor != 5 {
		t.Fatalf("baked row: %+v", baked)
	}
	dl, ok := byID["dl-17-"+digA[len("sha256:"):][:16]]
	if !ok || dl.Status != "ready" || dl.ReleaseTag != "9999" || dl.ImageDigest != digA {
		t.Fatalf("adopted row: %+v", dl)
	}
	// Newest minor wins: baked 17.5 beats downloaded 17.4.
	if !baked.Active || dl.Active {
		t.Fatalf("active election: baked=%v dl=%v", baked.Active, dl.Active)
	}
	// pg_distrib slot for v17 points at BAKED (baked wins its slot).
	target, err := os.Readlink(filepath.Join(f.distrib, "v17"))
	if err != nil || target != filepath.Join(f.install, "v17") {
		t.Fatalf("distrib v17 -> %q %v", target, err)
	}
	if majors := f.svc.InstalledMajors(ctx); len(majors) != 1 || majors[0] != 17 {
		t.Fatalf("InstalledMajors = %v", majors)
	}
	// PgbinFor resolves the ACTIVE row's bin dir.
	pgbin, err := f.svc.PgbinFor(ctx, 17)
	if err != nil || pgbin != filepath.Join(f.install, "v17", "bin") {
		t.Fatalf("PgbinFor = %q %v", pgbin, err)
	}
	if v := f.svc.VersionForPgbin(ctx, pgbin); v == nil || *v != "17.5" {
		t.Fatalf("VersionForPgbin = %v", v)
	}
}

func TestAdoptRejectsForgedMarkerAndFailsVanishedRows(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	dl := f.downloadedDir(t, 17, 4, digA, "9999")
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}

	// Forge: rename the dir to a non-content-address and bump the marker minor.
	forged := filepath.Join(filepath.Dir(dl), "fake99-"+digA[len("sha256:"):][:16])
	if err := os.Rename(dl, forged); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(forged, "build.json"))
	forgedRaw := replaceOnce(string(raw), `"minor":4`, `"minor":99`)
	if !containsStr(forgedRaw, `"minor":99,`) {
		t.Fatal("forge failed to land — marker format drifted")
	}
	if err := os.WriteFile(filepath.Join(forged, "build.json"), []byte(forgedRaw), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := f.svc.List(ctx)
	for _, r := range rows {
		if r.Status == "ready" && r.Minor != nil && *r.Minor == 99 {
			t.Fatalf("forged 17.99 surfaced ready: %+v", r)
		}
		if r.ID == "dl-17-"+digA[len("sha256:"):][:16] && r.Status != "failed" {
			t.Fatalf("orphaned row must fail the presence sweep: %+v", r)
		}
		if r.ID == "baked-v17" && !r.Active {
			t.Fatalf("major must fall back to baked: %+v", r)
		}
	}
}

func replaceOnce(s, old, new string) string {
	i := indexOfStr(s, old)
	if i < 0 {
		return s
	}
	return s[:i] + new + s[i+len(old):]
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func containsStr(s, sub string) bool { return indexOfStr(s, sub) >= 0 }

func TestFailInterruptedAndSweepTmp(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	// A crash-orphaned in-flight row with a claimed dir, plus a .tmp- leftover.
	orphanDir := filepath.Join(f.buildsD, "v17", digB[len("sha256:"):][:16])
	if err := os.MkdirAll(orphanDir, 0o755); err != nil {
		t.Fatal(err)
	}
	tmpDir := filepath.Join(f.buildsD, "v17", ".tmp-deadbeef")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "pull-1", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: digB, Path: orphanDir, Status: "validating",
	}); err != nil {
		t.Fatal(err)
	}

	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	row, _, _ := f.st.PgBuildByID(ctx, "pull-1")
	if row.Status != "failed" || row.Error == nil || *row.Error != "interrupted by restart" {
		t.Fatalf("interrupted row: %+v", row)
	}
	if row.Path != "" {
		t.Fatalf("reclaimed row must drop its path claim: %+v", row)
	}
	if _, err := os.Stat(orphanDir); !os.IsNotExist(err) {
		t.Fatal("orphan dir must be reclaimed")
	}
	if _, err := os.Stat(tmpDir); !os.IsNotExist(err) {
		t.Fatal(".tmp-* must be swept")
	}
}

func TestResolveActivesDegradedBelowHighWater(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.st.SetLastRunMinor(ctx, 17, 99); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	if d := f.svc.DegradedMajors(); len(d) != 1 || d[0] != 17 {
		t.Fatalf("DegradedMajors = %v (baked 17.5 sits below high-water 99)", d)
	}
	ms, err := f.svc.MajorStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m := ms["17"]
	if m.ActiveVersion == nil || *m.ActiveVersion != "17.5" || m.Source == nil || *m.Source != "baked" || !m.DegradedDowngrade {
		t.Fatalf("MajorStatus[17] = %+v", m)
	}
}

func TestPgbinForWithNoUsableBuild409s(t *testing.T) {
	f := newFixture(t)
	if _, err := f.svc.PgbinFor(context.Background(), 18); err == nil ||
		err.Error() != "no usable Postgres 18 build — pull one via POST /api/pg-builds/pull or pick an installed major" {
		t.Fatalf("err = %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -count=1`
Expected: FAIL — `undefined: New` / `undefined: Options` (compile error).

- [ ] **Step 3: Implement the service core** — `internal/builds/service.go`:

```go
package builds

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/events"
	"github.com/VanGoghSoftware/worktreedb/internal/oci"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Row is a pg_builds row with its derived read-model: Active joined from the
// pg_actives pointer, InUse derived from the live running-pgbin set.
type Row struct {
	store.PgBuildRow
	Active bool
	InUse  bool
}

type CheckResult struct {
	Tag    string `json:"tag"`
	Digest string `json:"digest"`
	State  string `json:"state"` // current | incompatible | unverified
	IsNew  bool   `json:"isNew"`
	At     string `json:"at"`
}

type MajorStatus struct {
	ActiveVersion     *string `json:"activeVersion"`
	Source            *string `json:"source"`
	DegradedDowngrade bool    `json:"degradedDowngrade"`
	UpdateAvailable   *string `json:"updateAvailable"`
}

// Puller is the OCI seam (typed fake in tests, *oci.Client in production).
type Puller interface {
	ResolveDigest(ctx context.Context, repository, tag string) (string, error)
	PullPrefix(ctx context.Context, a oci.PullPrefixArgs) error
}

// GateFunc drives a REAL compute from the candidate install against live
// storage; a non-nil error fails the build (Task 8 provides the production
// runner).
type GateFunc func(ctx context.Context, major int, buildPath string) error

type Options struct {
	Store        *store.Store
	PgInstallDir string
	PgBuildsDir  string
	PgDistribDir string
	// RegistryBase + ImageTemplate resolve a major to its repository.
	RegistryBase  string
	ImageTemplate string
	Puller        Puller
	Detect        func(ctx context.Context, pgbin string) (int, int, error)
	FreeBytes     func(dir string) (uint64, error)
	// RunningPgbins reports the install bin dirs live computes hold open —
	// the in-use protocol remove() and the DTO both consult.
	RunningPgbins func() []string
	Hub           *events.LogHub
	Bus           *events.Bus
	Log           *slog.Logger
	GateTimeout   time.Duration // 0 → 90s
	Gate          GateFunc
}

type Service struct {
	o     Options
	owner *runtime.Owner // the mutation lane: activate/remove/prune/compensation

	mu        sync.Mutex
	pulling   bool
	degraded  map[int]bool
	lastCheck map[int]CheckResult
	overrides map[string]string // branchID → pgbin dir (validation-gate starts)
}

func New(o Options) *Service {
	if o.GateTimeout == 0 {
		o.GateTimeout = 90 * time.Second
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	s := &Service{o: o, degraded: map[int]bool{}, lastCheck: map[int]CheckResult{}, overrides: map[string]string{}}
	s.owner = runtime.NewOwner("builds", func(context.Context) error { return nil }, o.Log)
	return s
}

// Start spins up the mutation lane. The builds owner has no spec to converge
// toward — the lane (Owner.Run) is what serializes activate/remove/prune.
func (s *Service) Start(ctx context.Context) { s.owner.Start(ctx) }

func (s *Service) Wait() { s.owner.Wait() }

// RepoFor resolves the OCI repository for a major from the image template.
func (s *Service) RepoFor(major int) string {
	return strings.ReplaceAll(s.o.ImageTemplate, "{major}", fmt.Sprintf("%d", major))
}

func (s *Service) versionString(row store.PgBuildRow) string {
	if row.Minor == nil {
		return fmt.Sprintf("%d.x", row.Major)
	}
	return fmt.Sprintf("%d.%d", row.Major, *row.Minor)
}

func (s *Service) publish() {
	if s.o.Bus != nil {
		s.o.Bus.Publish("pg_builds", "", "")
	}
}

func (s *Service) log(buildID, line string) {
	if s.o.Hub != nil {
		s.o.Hub.Ingest("pgbuild:"+buildID, line)
	}
}

// activeIDs snapshots major → active_build_id for the read model.
func (s *Service) activeIDs(ctx context.Context, rows []store.PgBuildRow) (map[int]string, error) {
	out := map[int]string{}
	seen := map[int]bool{}
	for _, r := range rows {
		if seen[r.Major] {
			continue
		}
		seen[r.Major] = true
		id, ok, err := s.o.Store.ActiveBuildID(ctx, r.Major)
		if err != nil {
			return nil, err
		}
		if ok {
			out[r.Major] = id
		}
	}
	return out, nil
}

// List returns every row with Active + InUse derived. InUse is a prefix match
// against row.Path+"/" — the SAME rule the removability guard uses, so the
// two can never disagree; empty-path rows (early-failed, failure-reclaimed)
// own no directory and are never in use.
func (s *Service) List(ctx context.Context) ([]Row, error) {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return nil, err
	}
	actives, err := s.activeIDs(ctx, rows)
	if err != nil {
		return nil, err
	}
	running := s.o.RunningPgbins()
	out := make([]Row, 0, len(rows))
	for _, r := range rows {
		out = append(out, Row{
			PgBuildRow: r,
			Active:     actives[r.Major] == r.ID,
			InUse:      r.Path != "" && anyHasPrefix(running, r.Path+"/"),
		})
	}
	return out, nil
}

func anyHasPrefix(paths []string, prefix string) bool {
	for _, p := range paths {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

// InstalledMajors: majors with at least one READY row, ascending. The
// project-create whitelist and the check default derive from this.
func (s *Service) InstalledMajors(ctx context.Context) []int {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		s.o.Log.Error("installed-major scan failed", "err", err)
		return nil
	}
	set := map[int]bool{}
	for _, r := range rows {
		if r.Status == "ready" {
			set[r.Major] = true
		}
	}
	majors := make([]int, 0, len(set))
	for m := range set {
		majors = append(majors, m)
	}
	sort.Ints(majors)
	return majors
}

func (s *Service) DegradedMajors() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int, 0, len(s.degraded))
	for m, d := range s.degraded {
		if d {
			out = append(out, m)
		}
	}
	sort.Ints(out)
	return out
}

// UpdateAvailableFor is the status-block badge for a major's LAST check:
// "latest@<12-char digest>" only when that check left the major unverified
// (an unconfirmed latest worth a pull); nil for current/incompatible and
// when never checked. Honest by construction — it never asserts a CONFIRMED
// newer minor. (The check itself lives in check.go; this reads its cache.)
func (s *Service) UpdateAvailableFor(major int) *string {
	s.mu.Lock()
	c, ok := s.lastCheck[major]
	s.mu.Unlock()
	if !ok || !c.IsNew {
		return nil
	}
	badge := "latest@" + strings.TrimPrefix(c.Digest, "sha256:")[:12]
	return &badge
}

// PgbinFor resolves the major's ACTIVE ready install to its bin directory —
// endpoint starts resolve --pgbin through this.
func (s *Service) PgbinFor(ctx context.Context, major int) (string, error) {
	rows, err := s.o.Store.PgBuildsByMajor(ctx, major)
	if err != nil {
		return "", err
	}
	id, ok, err := s.o.Store.ActiveBuildID(ctx, major)
	if err != nil {
		return "", err
	}
	if ok {
		for _, r := range rows {
			if r.ID == id && r.Status == "ready" {
				return r.Path + "/bin", nil
			}
		}
	}
	return "", service.Errf(409,
		"no usable Postgres %d build — pull one via POST /api/pg-builds/pull or pick an installed major", major)
}

// VersionForPgbin is the reverse lookup: which row (by version string) backs
// a given pgbin bin-directory. nil when no row matches.
func (s *Service) VersionForPgbin(ctx context.Context, pgbinDir string) *string {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return nil
	}
	for _, r := range rows {
		if r.Path != "" && pgbinDir == r.Path+"/bin" {
			v := s.versionString(r)
			return &v
		}
	}
	return nil
}

// MajorStatus renders the per-major status block: active version/source,
// the degraded flag, and the last check's unverified-update badge.
func (s *Service) MajorStatus(ctx context.Context) (map[string]MajorStatus, error) {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return nil, err
	}
	actives, err := s.activeIDs(ctx, rows)
	if err != nil {
		return nil, err
	}
	byID := map[string]store.PgBuildRow{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	degraded := map[int]bool{}
	for _, m := range s.DegradedMajors() {
		degraded[m] = true
	}
	out := map[string]MajorStatus{}
	for _, major := range s.InstalledMajors(ctx) {
		ms := MajorStatus{DegradedDowngrade: degraded[major], UpdateAvailable: s.UpdateAvailableFor(major)}
		if id, ok := actives[major]; ok {
			if row, found := byID[id]; found && row.Status == "ready" {
				v := s.versionString(row)
				src := row.Source
				if row.Minor != nil {
					ms.ActiveVersion = &v
				}
				ms.Source = &src
			}
		}
		out[fmt.Sprintf("%d", major)] = ms
	}
	return out, nil
}
```

- [ ] **Step 4: Implement boot adoption** — `internal/builds/boot.go`:

```go
package builds

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/VanGoghSoftware/worktreedb/internal/oci"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// buildMarker is the self-describing marker each downloaded install carries.
// FIELD ORDER IS A CONTRACT: the marker is compact JSON with digest, tag,
// major, minor, extractedAt in exactly this order (encoding/json marshals in
// declaration order) — volume tooling greps it positionally.
type buildMarker struct {
	Digest      string `json:"digest"`
	Tag         string `json:"tag"`
	Major       int    `json:"major"`
	Minor       int    `json:"minor"`
	ExtractedAt string `json:"extractedAt"`
}

var markerDigestRe = regexp.MustCompile(`^sha256:[0-9a-f]+$`)

// parseMarker validates a marker's SHAPE before trusting any field — a
// malformed-but-parseable marker must never insert garbage rows. Callers
// additionally check the marker against its on-disk location and re-detect
// the binary version.
func parseMarker(raw []byte) (buildMarker, error) {
	var probe struct {
		Digest      *string `json:"digest"`
		Tag         *string `json:"tag"`
		Major       *int    `json:"major"`
		Minor       *int    `json:"minor"`
		ExtractedAt *string `json:"extractedAt"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return buildMarker{}, fmt.Errorf("marker is not JSON: %w", err)
	}
	if probe.Digest == nil || !markerDigestRe.MatchString(*probe.Digest) {
		return buildMarker{}, fmt.Errorf("marker.digest is not a sha256 hex digest")
	}
	if probe.Tag == nil {
		return buildMarker{}, fmt.Errorf("marker.tag is not a string")
	}
	if probe.Major == nil {
		return buildMarker{}, fmt.Errorf("marker.major is not an integer")
	}
	if probe.Minor == nil {
		return buildMarker{}, fmt.Errorf("marker.minor is not an integer")
	}
	if probe.ExtractedAt == nil {
		return buildMarker{}, fmt.Errorf("marker.extractedAt is not a string")
	}
	return buildMarker{Digest: *probe.Digest, Tag: *probe.Tag, Major: *probe.Major,
		Minor: *probe.Minor, ExtractedAt: *probe.ExtractedAt}, nil
}

var bakedDirRe = regexp.MustCompile(`^v(\d+)$`)

// BootAdopt is the boot pass, in dependency order: sweep .tmp-*, fail
// interrupted rows (reclaiming their dirs), re-probe baked installs, adopt
// marker'd volume dirs, fail vanished/drifted ready rows, resolve actives,
// GC to keep-2, and compose the pg_distrib farm. Runs BEFORE the engine
// starts (pageserver.toml's pg_distrib_dir points at the farm).
func (s *Service) BootAdopt(ctx context.Context) error {
	if err := os.MkdirAll(s.o.PgBuildsDir, 0o755); err != nil {
		return err
	}
	if n, err := s.SweepTmp(); err != nil {
		return err
	} else if n > 0 {
		s.o.Log.Info("boot: swept interrupted extractions", "count", n)
	}
	if n, err := s.failInterrupted(ctx); err != nil {
		return err
	} else if n > 0 {
		s.o.Log.Info("boot: failed pulls interrupted by restart", "count", n)
	}
	if err := s.seedBaked(ctx); err != nil {
		return err
	}
	if err := s.adoptVolumeBuilds(ctx); err != nil {
		return err
	}
	if err := s.resolveActives(ctx); err != nil {
		return err
	}
	if err := s.gcKeepTwo(ctx); err != nil {
		return err
	}
	return s.RecomposeDistrib(ctx)
}

// SweepTmp removes every pgBuildsDir/v*/.tmp-* (interrupted-install
// leftovers, including the extraction scratch dirs).
func (s *Service) SweepTmp() (int, error) {
	majors, err := os.ReadDir(s.o.PgBuildsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	count := 0
	for _, vdir := range majors {
		if !bakedDirRe.MatchString(vdir.Name()) {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(s.o.PgBuildsDir, vdir.Name()))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".tmp-") {
				if err := os.RemoveAll(filepath.Join(s.o.PgBuildsDir, vdir.Name(), e.Name())); err != nil {
					return count, err
				}
				count++
			}
		}
	}
	return count, nil
}

// failInterrupted: no pull survives a restart (the pipeline is in-process),
// so any row still downloading/validating at boot was orphaned by a crash
// mid-pull. Fail it (terminal + deletable) and reclaim its dir — an
// interrupted install was never validated, so it is worthless, and leaving
// it would make a same-digest retry's rename fail on a non-empty target.
// The dir is kept only when a SURVIVING row (one not itself being failed
// here) claims the same path — a ready same-digest sibling legitimately
// shares the digest-named dir. Path claims are cleared ONLY on a successful
// remove, so a failed rm leaves the dir deletable through the row.
func (s *Service) failInterrupted(ctx context.Context) (int, error) {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return 0, err
	}
	interrupted := map[string]bool{}
	for _, r := range rows {
		if r.Status == "downloading" || r.Status == "validating" {
			interrupted[r.ID] = true
		}
	}
	count := 0
	for _, r := range rows {
		if !interrupted[r.ID] {
			continue
		}
		if err := s.o.Store.SetPgBuildStatus(ctx, r.ID, "failed", "interrupted by restart"); err != nil {
			return count, err
		}
		count++
		surviving := false
		for _, other := range rows {
			if !interrupted[other.ID] && other.Path == r.Path && other.Path != "" {
				surviving = true
			}
		}
		if r.Path != "" && !surviving {
			if err := os.RemoveAll(r.Path); err != nil {
				s.o.Log.Error("boot: could not reclaim interrupted build dir", "path", r.Path, "err", err)
			} else if err := s.o.Store.SetPgBuildPath(ctx, r.ID, ""); err != nil {
				return count, err
			}
		}
	}
	return count, nil
}

// seedBaked scans pgInstallDir for v<digits> dirs (vanilla_* — the storage-
// controller catalog's own tree — never counts) and upserts a stable
// baked-v{major} row, RE-PROBING existing rows every boot: a new image on a
// persisted volume is the supported upgrade path, so minor drift is written
// back, a failed row whose dir returned is resurrected, a row whose probe
// fails is marked failed, and a baked row whose install dir vanished is
// failed rather than left a zombie.
func (s *Service) seedBaked(ctx context.Context) error {
	entries, err := os.ReadDir(s.o.PgInstallDir)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, e := range entries {
		m := bakedDirRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		dirMajor, _ := strconv.Atoi(m[1])
		path := filepath.Join(s.o.PgInstallDir, e.Name())
		id := "baked-" + e.Name()
		seen[id] = true
		existing, ok, err := s.o.Store.PgBuildByID(ctx, id)
		if err != nil {
			return err
		}
		major, minor, derr := s.o.Detect(ctx, filepath.Join(path, "bin", "postgres"))
		if ok {
			if derr != nil || major != dirMajor {
				if err := s.o.Store.SetPgBuildStatus(ctx, id, "failed", "baked build failed version re-probe at boot"); err != nil {
					return err
				}
				s.o.Log.Error("baked build failed version re-probe", "path", path, "err", derr)
				continue
			}
			if existing.Minor == nil || *existing.Minor != minor {
				if err := s.o.Store.SetPgBuildMinor(ctx, id, minor); err != nil {
					return err
				}
			}
			if existing.Status != "ready" {
				if err := s.o.Store.SetPgBuildStatus(ctx, id, "ready", ""); err != nil {
					return err
				}
			}
			continue
		}
		if derr != nil {
			s.o.Log.Error("baked build failed version probe — not seeding", "path", path, "err", derr)
			continue
		}
		if major != dirMajor {
			s.o.Log.Error("baked build reports a different major than its directory — not seeding",
				"path", path, "detected", major, "dir", dirMajor)
			continue
		}
		if err := s.o.Store.CreatePgBuild(ctx, store.PgBuildParams{
			ID: id, Major: major, Minor: &minor, Source: "baked",
			ReleaseTag: "baked", ImageDigest: "", Path: path, Status: "ready",
		}); err != nil {
			return err
		}
	}
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.Source != "baked" || seen[r.ID] || r.Status == "failed" {
			continue
		}
		if err := s.o.Store.SetPgBuildStatus(ctx, r.ID, "failed", "baked build dir missing at boot"); err != nil {
			return err
		}
	}
	return nil
}

// adoptVolumeBuilds re-inserts rows from build.json markers under
// pgBuildsDir/v*/<shortDigest>/ (skipping .tmp-*). A marker is never trusted
// to name the version: its SHAPE is validated, its CONSISTENCY against the
// on-disk location is checked (dir basename == shortDigest(digest), marker
// major == the vN dir), and the binary version is RE-DETECTED and adopted.
// Any disagreement skips the dir with a logged reason. A dir already claimed
// by an existing row keeps its row (a pull-created row keeps its UUID id,
// not the dl- form). Then the presence sweep: ready downloaded rows whose
// binary vanished or re-detects at a DIFFERENT version are failed.
func (s *Service) adoptVolumeBuilds(ctx context.Context) error {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	claimed := map[string]bool{}
	for _, r := range rows {
		if r.Path != "" {
			claimed[r.Path] = true
		}
	}
	majors, err := os.ReadDir(s.o.PgBuildsDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, vdir := range majors {
		if !bakedDirRe.MatchString(vdir.Name()) {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(s.o.PgBuildsDir, vdir.Name()))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".tmp-") {
				continue
			}
			path := filepath.Join(s.o.PgBuildsDir, vdir.Name(), e.Name())
			if claimed[path] {
				continue
			}
			if err := s.adoptOne(ctx, vdir.Name(), e.Name(), path); err != nil {
				s.o.Log.Error("skipping unadoptable volume build", "path", path, "err", err)
			}
		}
	}
	// Presence/drift sweep over ready downloaded rows.
	rows, err = s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.Source != "downloaded" || r.Status != "ready" {
			continue
		}
		major, minor, derr := s.o.Detect(ctx, filepath.Join(r.Path, "bin", "postgres"))
		if derr != nil {
			if err := s.o.Store.SetPgBuildStatus(ctx, r.ID, "failed", "build binary missing at boot"); err != nil {
				return err
			}
			continue
		}
		if r.Minor == nil || major != r.Major || minor != *r.Minor {
			recMinor := 0
			if r.Minor != nil {
				recMinor = *r.Minor
			}
			msg := fmt.Sprintf("build binary version drift at boot: detected %d.%d, recorded %d.%d", major, minor, r.Major, recMinor)
			if err := s.o.Store.SetPgBuildStatus(ctx, r.ID, "failed", msg); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) adoptOne(ctx context.Context, vdir, entry, path string) error {
	raw, err := os.ReadFile(filepath.Join(path, "build.json"))
	if err != nil {
		return err
	}
	marker, err := parseMarker(raw)
	if err != nil {
		return err
	}
	if oci.ShortDigest(marker.Digest) != entry {
		return fmt.Errorf("marker digest %s != dir %s", oci.ShortDigest(marker.Digest), entry)
	}
	dirMajor, _ := strconv.Atoi(strings.TrimPrefix(vdir, "v"))
	if marker.Major != dirMajor {
		return fmt.Errorf("marker major %d != dir %s", marker.Major, vdir)
	}
	id := fmt.Sprintf("dl-%d-%s", marker.Major, oci.ShortDigest(marker.Digest))
	if _, ok, err := s.o.Store.PgBuildByID(ctx, id); err != nil || ok {
		return err
	}
	major, minor, err := s.o.Detect(ctx, filepath.Join(path, "bin", "postgres"))
	if err != nil {
		return err
	}
	if major != marker.Major {
		return fmt.Errorf("binary major %d != marker major %d", major, marker.Major)
	}
	return s.o.Store.CreatePgBuild(ctx, store.PgBuildParams{
		ID: id, Major: major, Minor: &minor, Source: "downloaded",
		ReleaseTag: marker.Tag, ImageDigest: marker.Digest, Path: path, Status: "ready",
	})
}

// byActivePreference: newest minor wins; a tie goes to the baked build (its
// minor came from a real --version probe at seed time — the trusted default).
func byActivePreference(rows []store.PgBuildRow) {
	sort.SliceStable(rows, func(i, j int) bool {
		mi, mj := 0, 0
		if rows[i].Minor != nil {
			mi = *rows[i].Minor
		}
		if rows[j].Minor != nil {
			mj = *rows[j].Minor
		}
		if mi != mj {
			return mi > mj
		}
		return rows[i].Source == "baked" && rows[j].Source != "baked"
	})
}

// resolveActives elects, per major, the newest valid minor (tie → baked) as
// the exclusive active pointer, and flags — never silently accepts — a
// winner below the recorded last-run high-water. Majors with rows but no
// ready candidate get their pointer CLEARED (a stale pointer would wrongly
// block removal and give PgbinFor nothing to explain).
func (s *Service) resolveActives(ctx context.Context) error {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	byMajor := map[int][]store.PgBuildRow{}
	allMajors := map[int]bool{}
	for _, r := range rows {
		allMajors[r.Major] = true
		if r.Status == "ready" && r.Minor != nil {
			byMajor[r.Major] = append(byMajor[r.Major], r)
		}
	}
	s.mu.Lock()
	s.degraded = map[int]bool{}
	s.mu.Unlock()
	for major := range allMajors {
		candidates := byMajor[major]
		if len(candidates) == 0 {
			if err := s.o.Store.ClearActiveBuild(ctx, major); err != nil {
				return err
			}
			continue
		}
		byActivePreference(candidates)
		winner := candidates[0]
		if err := s.o.Store.SetActiveBuild(ctx, major, winner.ID); err != nil {
			return err
		}
		lastRun, err := s.o.Store.LastRunMinor(ctx, major)
		if err != nil {
			return err
		}
		if lastRun != nil && winner.Minor != nil && *winner.Minor < *lastRun {
			s.mu.Lock()
			s.degraded[major] = true
			s.mu.Unlock()
			s.o.Log.Error("boot: major resolved BELOW its last-run minor — re-pull to clear",
				"major", major, "active", s.versionString(winner), "lastRun", *lastRun)
		}
	}
	return nil
}

// resolveActiveFor is the scoped single-major recovery variant: re-pick (or
// clear) ONE major's pointer with the same winner rule AND re-derive that
// major's degraded flag — used by the pull pipeline's failure compensation.
func (s *Service) resolveActiveFor(ctx context.Context, major int) error {
	rows, err := s.o.Store.PgBuildsByMajor(ctx, major)
	if err != nil {
		return err
	}
	var ready []store.PgBuildRow
	for _, r := range rows {
		if r.Status == "ready" && r.Minor != nil {
			ready = append(ready, r)
		}
	}
	if len(ready) == 0 {
		s.mu.Lock()
		delete(s.degraded, major)
		s.mu.Unlock()
		return s.o.Store.ClearActiveBuild(ctx, major)
	}
	byActivePreference(ready)
	if err := s.o.Store.SetActiveBuild(ctx, major, ready[0].ID); err != nil {
		return err
	}
	lastRun, err := s.o.Store.LastRunMinor(ctx, major)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if lastRun != nil && ready[0].Minor != nil && *ready[0].Minor < *lastRun {
		s.degraded[major] = true
	} else {
		delete(s.degraded, major)
	}
	s.mu.Unlock()
	return nil
}

// gcKeepTwo: per major, ready downloaded rows other than the active one and
// the single newest non-active one are reclaimed at boot (keep active + one
// rollback target). Nothing runs yet at boot, so no in-use check is needed
// here; runtime deletes still go through the removability guard.
func (s *Service) gcKeepTwo(ctx context.Context) error {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	actives, err := s.activeIDs(ctx, rows)
	if err != nil {
		return err
	}
	byMajor := map[int][]store.PgBuildRow{}
	for _, r := range rows {
		if r.Status == "ready" && r.Source == "downloaded" && actives[r.Major] != r.ID {
			byMajor[r.Major] = append(byMajor[r.Major], r)
		}
	}
	for _, group := range byMajor {
		sort.SliceStable(group, func(i, j int) bool {
			mi, mj := -1, -1
			if group[i].Minor != nil {
				mi = *group[i].Minor
			}
			if group[j].Minor != nil {
				mj = *group[j].Minor
			}
			return mi > mj
		})
		for _, stale := range group[1:] {
			if stale.Path != "" {
				if err := os.RemoveAll(stale.Path); err != nil {
					return err
				}
			}
			if err := s.o.Store.DeletePgBuild(ctx, stale.ID); err != nil {
				return err
			}
			s.o.Log.Info("boot: GC'd stale build (keep-2 policy)", "version", s.versionString(stale), "tag", stale.ReleaseTag)
		}
	}
	return nil
}

// RecomposeDistrib re-derives the pg_distrib farm from the registry: active
// ready DOWNLOADED rows fill only the slots the baked install leaves empty.
func (s *Service) RecomposeDistrib(ctx context.Context) error {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return err
	}
	actives, err := s.activeIDs(ctx, rows)
	if err != nil {
		return err
	}
	var downloaded []DistribEntry
	for _, r := range rows {
		if r.Source == "downloaded" && r.Status == "ready" && actives[r.Major] == r.ID {
			downloaded = append(downloaded, DistribEntry{Major: r.Major, Path: r.Path})
		}
	}
	return ComposePgDistrib(s.o.PgDistribDir, s.o.PgInstallDir, downloaded)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -race -count=1`
Expected: PASS (all builds tests so far).

- [ ] **Step 6: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/builds/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add internal/builds/ && git commit -m "feat(builds): service read model and boot adoption (seed, adopt, sweeps, actives, GC, distrib)"
```

---

### Task 7: builds — update-check honesty + benign skip records

`Check` resolves each major's `latest` digest and classifies it HONESTLY — never "confirmed newer" (the digest alone can't confirm a minor without a pull), never hiding a reachable update:
- `current` — the digest is installed ready, or a row at this digest records a minor that IS installed ready (that minor arm is what stops a baked-current major reading as new: `latest` never digest-matches a baked build's `""` sentinel, so a prior no-op's recorded digest→minor is the only link).
- `incompatible` — a failed row at this digest whose stored error is PERMANENT for this runtime (OS-base incompatibility, or a wrong-major registry mislabel): re-pulling re-fails, so it is NOT an update.
- `unverified` — otherwise: might be a newer minor; kept offerable.

`recordSkip` records a benign no-op pull (digest/minor already installed) as the distinct `skipped` terminal state, NOT `failed` — the row PERSISTS on purpose (its digest→minor is how check reads the major as current), its path is cleared (a no-op owns no dir), and older `skipped` siblings at the same (major, digest) are pruned through the lane so repeated no-ops don't accumulate.

**Files:**
- Create: `~/git/worktreedb/internal/builds/check.go`
- Create: `~/git/worktreedb/internal/builds/check_test.go`

**Interfaces:**
- Consumes: Task 6 `Service` internals, Task 5 `IsIncompatibilityError`/`IsMajorMismatchError`, Task 3 `Puller.ResolveDigest`.
- Produces:
  - `func (s *Service) Check(ctx, majors []int) (map[string]CheckResult, error)` — the writer of the `lastCheck` cache Task 6's `UpdateAvailableFor` reads
  - `func (s *Service) classifyDigest(ctx, major int, digest string) (string, error)` (unexported; the pipeline's exit refresh reuses it)
  - `func (s *Service) refreshLastCheck(ctx, major int, tag, digest string)` (unexported; pipeline exit hook)
  - `func (s *Service) recordSkip(ctx, id, msg string) error` (unexported; pipeline)

- [ ] **Step 1: Write the failing tests** — `internal/builds/check_test.go`:

```go
package builds

import (
	"context"
	"strings"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/oci"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

type fakePuller struct {
	digests map[string]string // repo → digest for "latest"
	err     error
}

func (f *fakePuller) ResolveDigest(_ context.Context, repo, tag string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.digests[repo+"/"+tag], nil
}

func (f *fakePuller) PullPrefix(context.Context, oci.PullPrefixArgs) error { return nil }

func TestCheckClassifiesHonestly(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	puller := &fakePuller{digests: map[string]string{"acme/pg-v17/latest": digA}}
	f.svc.o.Puller = puller

	// Unknown digest → unverified (might be newer; offerable).
	res, err := f.svc.Check(ctx, []int{17})
	if err != nil {
		t.Fatal(err)
	}
	r := res["17"]
	if r.State != "unverified" || !r.IsNew || r.Digest != digA || r.Tag != "latest" || r.At == "" {
		t.Fatalf("unverified check = %+v", r)
	}
	if badge := f.svc.UpdateAvailableFor(17); badge == nil || *badge != "latest@"+digA[len("sha256:"):][:12] {
		t.Fatalf("badge = %v", badge)
	}

	// A ready row AT this digest → current.
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "dl-x", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: digA, Path: "/data/pg_builds/v17/x", Status: "ready",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.st.SetPgBuildMinor(ctx, "dl-x", 6); err != nil {
		t.Fatal(err)
	}
	res, _ = f.svc.Check(ctx, []int{17})
	if res["17"].State != "current" || res["17"].IsNew {
		t.Fatalf("current check = %+v", res["17"])
	}
	if f.svc.UpdateAvailableFor(17) != nil {
		t.Fatal("current must clear the badge")
	}

	// A skipped row recording digest→minor where that minor IS installed
	// ready (the baked-current case) → current.
	if err := f.st.DeletePgBuild(ctx, "dl-x"); err != nil {
		t.Fatal(err)
	}
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "skip-x", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: digA, Path: "", Status: "skipped",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.st.SetPgBuildMinor(ctx, "skip-x", 5); err != nil { // 5 == baked ready minor
		t.Fatal(err)
	}
	res, _ = f.svc.Check(ctx, []int{17})
	if res["17"].State != "current" {
		t.Fatalf("baked-current via skip record = %+v", res["17"])
	}

	// A PERMANENT failure at the digest → incompatible, even offered rows exist.
	if err := f.st.DeletePgBuild(ctx, "skip-x"); err != nil {
		t.Fatal(err)
	}
	incompat := "/x/postgres " + incompatibleRuntimeMarker + " — the build targets a different OS base than this container"
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "fail-x", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: digA, Path: "", Status: "failed",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.st.SetPgBuildStatus(ctx, "fail-x", "failed", incompat); err != nil {
		t.Fatal(err)
	}
	res, _ = f.svc.Check(ctx, []int{17})
	if res["17"].State != "incompatible" || res["17"].IsNew {
		t.Fatalf("incompatible check = %+v", res["17"])
	}
	if f.svc.UpdateAvailableFor(17) != nil {
		t.Fatal("incompatible must not advertise an update")
	}
}

func TestRecordSkipClearsPathAndPrunesOlderSkips(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	mk := func(id string) {
		if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
			ID: id, Major: 17, Source: "downloaded", ReleaseTag: "latest",
			ImageDigest: digA, Path: "/should/clear", Status: "downloading",
		}); err != nil {
			t.Fatal(err)
		}
	}
	mk("skip-old")
	if err := f.svc.recordSkip(ctx, "skip-old", "already installed as 17.5 (baked) — up to date"); err != nil {
		t.Fatal(err)
	}
	mk("skip-new")
	if err := f.svc.recordSkip(ctx, "skip-new", "already installed as 17.5 (baked) — up to date"); err != nil {
		t.Fatal(err)
	}

	rows, _ := f.svc.List(ctx)
	var skips []Row
	for _, r := range rows {
		if r.Status == "skipped" {
			skips = append(skips, r)
		}
	}
	if len(skips) != 1 || skips[0].ID != "skip-new" {
		t.Fatalf("exactly the newest skip must survive: %+v", skips)
	}
	if skips[0].Path != "" {
		t.Fatalf("a no-op owns no dir: %+v", skips[0])
	}
	if skips[0].Error == nil || !strings.Contains(*skips[0].Error, "up to date") {
		t.Fatalf("skip message must land on the row: %+v", skips[0])
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -run 'TestCheck|TestRecordSkip' -count=1`
Expected: FAIL — `f.svc.Check undefined` (compile error).

- [ ] **Step 3: Implement** — `internal/builds/check.go`:

```go
package builds

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// classifyDigest classifies a resolved `latest` digest against what's
// installed, honestly. Pure and local (no network). Considers ALL rows at
// the digest:
//   - current: any ready row at this digest, or any row here records a minor
//     that IS installed ready. `latest` never digest-matches a BAKED build
//     (the "" sentinel), so the minor arm is what stops a baked-current
//     major reading as new — a prior no-op recorded this digest→minor.
//   - incompatible: an incompatibility (or wrong-major mislabel) is
//     PERMANENT for this runtime, so ONE such failed row here is definitive
//     even if a newer transient-failed row also exists — re-pulling re-fails.
//   - unverified: otherwise — might be a newer minor we can't confirm
//     without a pull; kept offerable so a genuine newer minor stays
//     reachable. There is deliberately NO "confirmed newer" state: the
//     check only has the digest, never its minor.
func (s *Service) classifyDigest(ctx context.Context, major int, digest string) (string, error) {
	rows, err := s.o.Store.PgBuildsByMajor(ctx, major)
	if err != nil {
		return "", err
	}
	readyMinors := map[int]bool{}
	for _, r := range rows {
		if r.Status == "ready" && r.Minor != nil {
			readyMinors[*r.Minor] = true
		}
	}
	for _, r := range rows {
		if r.ImageDigest != digest {
			continue
		}
		if r.Status == "ready" || (r.Minor != nil && readyMinors[*r.Minor]) {
			return "current", nil
		}
	}
	for _, r := range rows {
		if r.ImageDigest == digest && r.Status == "failed" &&
			(IsIncompatibilityError(r.Error) || IsMajorMismatchError(r.Error)) {
			return "incompatible", nil
		}
	}
	return "unverified", nil
}

func (s *Service) toCheckResult(digest, state string) CheckResult {
	return CheckResult{
		Tag: "latest", Digest: digest, State: state, IsNew: state == "unverified",
		At: time.Now().UTC().Format(time.RFC3339),
	}
}

// Check resolves each major's `latest` against the registry and classifies
// it. This and the pull itself are the daemon's ONLY registry egress.
func (s *Service) Check(ctx context.Context, majors []int) (map[string]CheckResult, error) {
	out := map[string]CheckResult{}
	for _, major := range majors {
		digest, err := s.o.Puller.ResolveDigest(ctx, s.RepoFor(major), "latest")
		if err != nil {
			return nil, err
		}
		state, err := s.classifyDigest(ctx, major, digest)
		if err != nil {
			return nil, err
		}
		result := s.toCheckResult(digest, state)
		s.mu.Lock()
		s.lastCheck[major] = result
		s.mu.Unlock()
		out[fmt.Sprintf("%d", major)] = result
	}
	return out, nil
}

// refreshLastCheck re-derives the cached verdict once a pull has changed the
// installed state, so the status block doesn't keep prompting a pull that
// already settled. Called from the pipeline's exit for a `latest` pull (it
// re-resolved latest's CURRENT digest — refresh even if the tag moved since
// the check) or for a pinned pull that resolved the exact digest a prior
// check cached; a pinned pull of a DIFFERENT digest must not clobber
// latest's cached verdict.
func (s *Service) refreshLastCheck(ctx context.Context, major int, tag, digest string) {
	s.mu.Lock()
	cached, ok := s.lastCheck[major]
	s.mu.Unlock()
	if tag != "latest" && (!ok || cached.Digest != digest) {
		return
	}
	state, err := s.classifyDigest(ctx, major, digest)
	if err != nil {
		return // cache refresh is best-effort, never load-bearing
	}
	s.mu.Lock()
	s.lastCheck[major] = s.toCheckResult(digest, state)
	s.mu.Unlock()
}

// recordSkip records a benign no-op pull (digest/minor already installed) as
// the distinct `skipped` terminal state. The row PERSISTS on purpose: its
// recorded digest→minor is how the check reads the major as up to date. Its
// path is cleared (a no-op owns no dir) and older skipped siblings at the
// same (major, digest) are pruned — keeping exactly one — through the
// mutation lane, since a concurrent activate/remove could be touching a
// sibling row.
func (s *Service) recordSkip(ctx context.Context, id, msg string) error {
	if err := s.o.Store.SetPgBuildPath(ctx, id, ""); err != nil {
		return err
	}
	if err := s.o.Store.SetPgBuildStatus(ctx, id, "skipped", msg); err != nil {
		return err
	}
	s.log(id, msg)
	row, ok, err := s.o.Store.PgBuildByID(ctx, id)
	if err != nil || !ok {
		return err
	}
	if row.ImageDigest != "" {
		if err := s.owner.Run(ctx, func(laneCtx context.Context) error {
			siblings, err := s.o.Store.PgBuildsByMajor(laneCtx, row.Major)
			if err != nil {
				return err
			}
			actives, err := s.activeIDs(laneCtx, siblings)
			if err != nil {
				return err
			}
			for _, sib := range siblings {
				if sib.ID != id && sib.Status == "skipped" && sib.ImageDigest == row.ImageDigest &&
					actives[sib.Major] != sib.ID {
					if err := s.o.Store.DeletePgBuild(laneCtx, sib.ID); err != nil {
						return err
					}
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	s.publish()
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -race -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/builds/check.go internal/builds/check_test.go && git commit -m "feat(builds): honest update-check classification and benign skip records"
```

---

### Task 8: builds — the pull pipeline as a durable operation, plus activate/remove

The heart of the milestone. `Pull` inserts the `downloading` row AND the durable operation SYNCHRONOUSLY (an immediate poll always finds the row; a crash leaves a resumable intent that boot fails forward), latches the single-flight flag, and runs the pipeline on its own goroutine via `runtime.RunOperation` with four steps — `resolve`, `extract`, `gate`, `activate`. Long work stays OUTSIDE the mutation lane; only the auto-activate/compensation enters it. Failure discipline (each clause tested): any failure lands on the row (never an unhandled panic/silent loss); a pre-rename failure reclaims the staging dir; a post-rename failure rm's the final dir, clears the row's path claim (a failed row must never keep claiming a digest dir a successful retry will re-create), and — if auto-activate had already flipped the pointer — re-resolves that ONE major inside the lane (guarded: an existing active ready build is left alone). A failed pull never latches the mutex. Explicit `Activate` and `Remove` are lane-serialized; `Remove` reads the running-pgbin supplier INSIDE the lane.

**Files:**
- Create: `~/git/worktreedb/internal/builds/pull.go`
- Create: `~/git/worktreedb/internal/builds/activate.go`
- Create: `~/git/worktreedb/internal/builds/pull_test.go`
- Create: `~/git/worktreedb/internal/builds/activate_test.go`
- Create: `~/git/worktreedb/internal/builds/gate.go` (the production gate runner — unit-tested via fakes here, proven live by the cross-run)

**Interfaces:**
- Consumes: Tasks 2–7; M2 `runtime.RunOperation`, `runtime.PlanFingerprint`, `store.CreateOperation`; `service.Errf`.
- Produces:
  - `func (s *Service) Pull(ctx, major int, tag string) (string, error)` — buildID; `tag == ""` → `latest`; `*service.Error` 400 `invalid tag: %s` / 409 `a build pull is already in progress`
  - `func (s *Service) Activate(ctx, id string, consented bool) (Row, error)` — 404/409s per the Global Constraints
  - `func (s *Service) Remove(ctx, id string) error` — the supplier is `Options.RunningPgbins`, read in-lane
  - `func (s *Service) LastRunMinor(ctx, major int) (*int, error)` · `NoteRun(ctx, pgbinDir string)` (records the high-water for a start on a READY row; validating candidates never record) · `SetPgbinOverride(branchID, pgbinDir string)` / `ClearPgbinOverride(branchID)` / `PgbinOverride(branchID) (string, bool)`
  - `func BootPolicies() map[string]runtime.BootPolicy` — `{"pg_build_pull": runtime.FailForwardOnBoot}`
  - `func GateRunner(deps GateDeps) GateFunc` with `type GateDeps struct { CreateProjectInternal func(ctx context.Context, name string, major int) (projectID, mainBranchID string, err error); DeleteProject func(ctx context.Context, projectID string) error; StartEndpoint func(ctx context.Context, branchID string) error; StopEndpoint func(ctx context.Context, branchID string) error; RunSQL func(ctx context.Context, branchID, query string) (firstValue string, err error); SetPgbinOverride func(branchID, pgbinDir string); ClearPgbinOverride func(branchID string); Log *slog.Logger }`
  - `func SweepValidationProjects(ctx context.Context, list func(ctx context.Context) ([]ProjectRef, error), del func(ctx context.Context, id string) error) (int, error)` with `type ProjectRef struct{ ID, Name string }`
  - `const validationProjectPrefix = "_worktreedb_validate_"` (exported as `ValidationProjectPrefix`)

- [ ] **Step 1: Write the failing pipeline tests** — `internal/builds/pull_test.go`:

```go
package builds

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/oci"
)

// pipePuller fabricates an install dir instead of hitting a registry.
type pipePuller struct {
	mu        sync.Mutex
	digest    string
	resolveErr error
	pullErr   error
	// binVersion is what the fabricated bin/postgres detects as (via the
	// fixture's versions map — set by the test after Pull resolves paths).
	fabricate func(destDir string) error
	pulls     int
}

func (p *pipePuller) ResolveDigest(context.Context, string, string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.resolveErr != nil {
		return "", p.resolveErr
	}
	return p.digest, nil
}

func (p *pipePuller) PullPrefix(_ context.Context, a oci.PullPrefixArgs) error {
	p.mu.Lock()
	p.pulls++
	fab, err := p.fabricate, p.pullErr
	p.mu.Unlock()
	if err != nil {
		return err
	}
	return fab(a.DestDir)
}

// preparePull wires a fixture whose puller fabricates a real-looking install
// reporting major.minor via the injectable detector.
func preparePull(t *testing.T, f *fixture, digest string, major, minor int) *pipePuller {
	t.Helper()
	p := &pipePuller{digest: digest}
	p.fabricate = func(destDir string) error {
		if err := os.MkdirAll(filepath.Join(destDir, "bin"), 0o755); err != nil {
			return err
		}
		bin := filepath.Join(destDir, "bin", "postgres")
		if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
			return err
		}
		f.versions[bin] = [2]int{major, minor}
		return nil
	}
	f.svc.o.Puller = p
	return p
}

func waitStatus(t *testing.T, f *fixture, id string, want string) Row {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows, err := f.svc.List(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			if r.ID == id {
				if r.Status == want {
					return r
				}
				if r.Status == "ready" || r.Status == "failed" || r.Status == "skipped" {
					t.Fatalf("row %s reached terminal %q (wanted %q), error=%v", id, r.Status, want, r.Error)
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("row %s never reached %q", id, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPullHappyPathReadyAndAutoActive(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	preparePull(t, f, digA, 17, 6) // newer than baked → activates
	gateCalls := 0
	f.svc.o.Gate = func(_ context.Context, major int, buildPath string) error {
		gateCalls++
		if major != 17 || !strings.HasPrefix(buildPath, f.buildsD) {
			t.Errorf("gate args: %d %s", major, buildPath)
		}
		return nil
	}

	id, err := f.svc.Pull(ctx, 17, "")
	if err != nil {
		t.Fatal(err)
	}
	// The downloading row exists BEFORE Pull returns.
	row, ok, _ := f.st.PgBuildByID(ctx, id)
	if !ok || row.Status == "" {
		t.Fatalf("row must exist synchronously: %v %+v", ok, row)
	}

	final := waitStatus(t, f, id, "ready")
	if !final.Active || final.ImageDigest != digA || final.Minor == nil || *final.Minor != 6 {
		t.Fatalf("final row: %+v", final)
	}
	if gateCalls != 1 {
		t.Fatalf("gate must run exactly once, ran %d", gateCalls)
	}
	// Final home is the content-addressed dir; marker written; staging gone.
	wantDir := filepath.Join(f.buildsD, "v17", digA[len("sha256:"):][:16])
	if final.Path != wantDir {
		t.Fatalf("path = %q, want %q", final.Path, wantDir)
	}
	marker, err := os.ReadFile(filepath.Join(wantDir, "build.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(marker), `"minor":6,"extractedAt"`) {
		t.Fatalf("marker key order/compactness violated: %s", marker)
	}
	// The durable operation finished done.
	// (Terminal ops are not listed by IncompleteOperations.)
	if ops, err := f.st.IncompleteOperations(ctx); err != nil || len(ops) != 0 {
		t.Fatalf("incomplete ops after success: %v %v", ops, err)
	}
}

func TestPullMutex409AndFailedPullReleasesIt(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	p := preparePull(t, f, digA, 17, 6)
	release := make(chan struct{})
	inner := p.fabricate
	p.fabricate = func(destDir string) error {
		<-release
		return inner(destDir)
	}
	f.svc.o.Gate = func(context.Context, int, string) error { return errors.New("gate: compute never came up") }

	id1, err := f.svc.Pull(ctx, 17, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Pull(ctx, 17, ""); err == nil || err.Error() != "a build pull is already in progress" {
		t.Fatalf("concurrent pull must 409: %v", err)
	}
	close(release)
	failed := waitStatus(t, f, id1, "failed")
	if failed.Error == nil || *failed.Error == "" {
		t.Fatalf("gate failure must land on the row: %+v", failed)
	}
	if failed.Active {
		t.Fatal("a gate-failed build must not be active")
	}
	// The failure released the mutex — a retry 202s (new id).
	id2, err := f.svc.Pull(ctx, 17, "")
	if err != nil || id2 == id1 {
		t.Fatalf("retry after failure: %q %v", id2, err)
	}
	waitStatus(t, f, id2, "failed")
	// The previously-active baked build is untouched by the failures.
	rows, _ := f.svc.List(ctx)
	for _, r := range rows {
		if r.ID == "baked-v17" && (!r.Active || r.Status != "ready") {
			t.Fatalf("baked active must be untouched: %+v", r)
		}
	}
	// Gate-failed final dirs are reclaimed and the rows' path claims cleared.
	if _, err := os.Stat(filepath.Join(f.buildsD, "v17", digA[len("sha256:"):][:16])); !os.IsNotExist(err) {
		t.Fatal("gate-failed final dir must be reclaimed")
	}
}

func TestPullInvalidTagAndPreflight(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.svc.Pull(ctx, 17, "../evil"); err == nil || err.Error() != "invalid tag: ../evil" {
		t.Fatalf("tag validation: %v", err)
	}
	// Preflight disk check fails the row without any network.
	f.svc.o.FreeBytes = func(string) (uint64, error) { return 1 << 20, nil }
	preparePull(t, f, digA, 17, 6)
	id, err := f.svc.Pull(ctx, 17, "")
	if err != nil {
		t.Fatal(err)
	}
	failed := waitStatus(t, f, id, "failed")
	if failed.Error == nil || *failed.Error != "insufficient disk space on /data (< 1.5 GB free)" {
		t.Fatalf("preflight error: %+v", failed)
	}
}

func TestPullDedupsIdenticalDigestAsSkipped(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	f.downloadedDir(t, 17, 4, digA, "9999")
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	p := preparePull(t, f, digA, 17, 4)
	id, err := f.svc.Pull(ctx, 17, "9999")
	if err != nil {
		t.Fatal(err)
	}
	row := waitStatus(t, f, id, "skipped")
	if row.Error == nil || *row.Error != "already installed as 17.4 (downloaded) — up to date" {
		t.Fatalf("skip message: %+v", row)
	}
	if p.pulls != 0 {
		t.Fatal("an identical-digest re-pull must not download anything")
	}
}

func TestPullSameMinorDedupsAfterExtract(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	preparePull(t, f, digB, 17, 5) // same minor as baked, different digest
	id, err := f.svc.Pull(ctx, 17, "")
	if err != nil {
		t.Fatal(err)
	}
	row := waitStatus(t, f, id, "skipped")
	if row.Error == nil || *row.Error != "already installed as 17.5 (baked) — up to date" {
		t.Fatalf("same-minor skip: %+v", row)
	}
	// The extracted staging tree is reclaimed.
	entries, _ := os.ReadDir(filepath.Join(f.buildsD, "v17"))
	for _, e := range entries {
		t.Fatalf("no dirs may remain after a same-minor no-op, found %s", e.Name())
	}
}

func TestPullWrongMajorFailsWithMismatchMessage(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	preparePull(t, f, digB, 16, 9) // image detects as 16.9, requested major 17
	id, err := f.svc.Pull(ctx, 17, "")
	if err != nil {
		t.Fatal(err)
	}
	row := waitStatus(t, f, id, "failed")
	if row.Error == nil || *row.Error != "image contained postgres 16.9, expected major 17" {
		t.Fatalf("mismatch message: %+v", row)
	}
}
```

- [ ] **Step 2: Write the failing activate/remove tests** — `internal/builds/activate_test.go`:

```go
package builds

import (
	"context"
	"os"
	"testing"

	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

func seedReady(t *testing.T, f *fixture, id string, major, minor int, source, digest, path string) {
	t.Helper()
	ctx := context.Background()
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: id, Major: major, Minor: &minor, Source: source,
		ReleaseTag: "latest", ImageDigest: digest, Path: path, Status: "ready",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestActivateGuards(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := f.svc.Activate(ctx, "nope", false); err == nil || err.Error() != "no such build: nope" {
		t.Fatalf("404: %v", err)
	}
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "mid", Major: 17, Source: "downloaded", ReleaseTag: "latest", Status: "downloading",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Activate(ctx, "mid", false); err == nil || err.Error() != "pg_build mid is not ready to activate" {
		t.Fatalf("not-ready 409: %v", err)
	}

	// Downgrade below the high-water needs consent; consenting LOWERS the
	// high-water and clears the degraded flag.
	seedReady(t, f, "old", 17, 3, "downloaded", digB, "/data/pg_builds/v17/old")
	if err := f.st.RecordRun(ctx, 17, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Activate(ctx, "old", false); err == nil ||
		err.Error() != "activating 17.3 would downgrade below the last-run 17.5 — pass consented:true (see docs on extension-catalog downgrades)" {
		t.Fatalf("downgrade 409: %v", err)
	}
	row, err := f.svc.Activate(ctx, "old", true)
	if err != nil || !row.Active {
		t.Fatalf("consented activate: %+v %v", row, err)
	}
	if lr, _ := f.st.LastRunMinor(ctx, 17); lr == nil || *lr != 3 {
		t.Fatalf("consent must lower the high-water: %v", lr)
	}
	if d := f.svc.DegradedMajors(); len(d) != 0 {
		t.Fatalf("consent must clear degraded: %v", d)
	}
	// Activating at/above the high-water clears a pre-existing degraded flag
	// without a reboot.
	f.mu(func() { f.svc.degraded[17] = true })
	if _, err := f.svc.Activate(ctx, "baked-v17", false); err != nil {
		t.Fatal(err)
	}
	if d := f.svc.DegradedMajors(); len(d) != 0 {
		t.Fatalf("re-activate must un-degrade: %v", d)
	}
}

func TestRemoveGuardsAndSharedPathSafety(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}

	if err := f.svc.Remove(ctx, "nope"); err == nil || err.Error() != "no such build: nope" {
		t.Fatalf("404: %v", err)
	}
	if err := f.svc.Remove(ctx, "baked-v17"); err == nil ||
		err.Error() != "pg_build baked-v17 is the active build for major 17" {
		t.Fatalf("active 409: %v", err)
	}

	// Baked guard: a non-active baked row still refuses removal.
	f.bakedDir(t, 16, 9)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.st.ClearActiveBuild(ctx, 16); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Remove(ctx, "baked-v16"); err == nil ||
		err.Error() != "pg_build baked-v16 is a baked build and cannot be removed" {
		t.Fatalf("baked 409: %v", err)
	}

	// In-flight guard.
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "mid", Major: 17, Source: "downloaded", ReleaseTag: "latest", Status: "validating",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Remove(ctx, "mid"); err == nil ||
		err.Error() != "pg_build mid has a pull in flight — wait for it to finish or fail" {
		t.Fatalf("in-flight 409: %v", err)
	}

	// In-use guard, read live via the supplier.
	dir := f.downloadedDir(t, 17, 4, digA, "9999")
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	f.svc.o.RunningPgbins = func() []string { return []string{dir + "/bin"} }
	dlID := "dl-17-" + digA[len("sha256:"):][:16]
	if err := f.svc.Remove(ctx, dlID); err == nil ||
		err.Error() != "pg_build "+dlID+" is in use by a running endpoint" {
		t.Fatalf("in-use 409: %v", err)
	}

	// Empty-path rows own no directory: never in use, removable while things run.
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "early-failed", Major: 17, Source: "downloaded", ReleaseTag: "latest", Status: "failed",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Remove(ctx, "early-failed"); err != nil {
		t.Fatalf("empty-path removal: %v", err)
	}

	// Shared-path safety: a failed sibling sharing the ready row's dir must
	// not rm it on removal; the ready build's files survive.
	f.svc.o.RunningPgbins = func() []string { return nil }
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "failed-sib", Major: 17, Source: "downloaded", ReleaseTag: "latest",
		ImageDigest: digA, Path: dir, Status: "failed",
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Remove(ctx, "failed-sib"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("shared dir must survive the sibling's removal: %v", err)
	}
}

func TestNoteRunAndOverrides(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	baked := f.bakedDir(t, 17, 5)
	if err := f.svc.BootAdopt(ctx); err != nil {
		t.Fatal(err)
	}
	// NoteRun on a READY row's pgbin records the high-water.
	f.svc.NoteRun(ctx, baked+"/bin")
	if lr, _ := f.st.LastRunMinor(ctx, 17); lr == nil || *lr != 5 {
		t.Fatalf("NoteRun: %v", lr)
	}
	// A validating candidate's pgbin must NOT record (the gate would poison
	// the high-water with an unvalidated minor).
	dir := f.downloadedDir(t, 17, 9, digA, "cand")
	if err := f.st.CreatePgBuild(ctx, store.PgBuildParams{
		ID: "cand", Major: 17, Source: "downloaded", ReleaseTag: "cand",
		ImageDigest: digA, Path: dir, Status: "validating",
	}); err != nil {
		t.Fatal(err)
	}
	f.svc.NoteRun(ctx, dir+"/bin")
	if lr, _ := f.st.LastRunMinor(ctx, 17); lr == nil || *lr != 5 {
		t.Fatalf("a validating candidate must not raise the high-water: %v", lr)
	}

	// Overrides round-trip.
	if _, ok := f.svc.PgbinOverride("b1"); ok {
		t.Fatal("no override yet")
	}
	f.svc.SetPgbinOverride("b1", "/cand/bin")
	if p, ok := f.svc.PgbinOverride("b1"); !ok || p != "/cand/bin" {
		t.Fatalf("override: %q %v", p, ok)
	}
	f.svc.ClearPgbinOverride("b1")
	if _, ok := f.svc.PgbinOverride("b1"); ok {
		t.Fatal("override must clear")
	}
}
```

Add the tiny lock helper to the fixture in `boot_test.go` (the degraded-flag test above pokes internal state):

```go
func (f *fixture) mu(fn func()) {
	f.svc.mu.Lock()
	defer f.svc.mu.Unlock()
	fn()
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -count=1`
Expected: FAIL — `f.svc.Pull undefined` (compile error).

- [ ] **Step 4: Implement the pipeline** — `internal/builds/pull.go`:

```go
package builds

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/VanGoghSoftware/worktreedb/internal/oci"
	"github.com/VanGoghSoftware/worktreedb/internal/runtime"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

const minFreeBytes = uint64(1.5 * (1 << 30))

// OCI distribution-spec tag grammar. Belt-and-suspenders: build paths are
// digest-derived (a tag never becomes a filesystem name), but the tag still
// flows into resolve URLs and row metadata, so reject anything malformed
// before any row/path/network work happens.
var ociTagRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

// pullSteps is the durable plan every pull persists a fingerprint of. Boot
// policy is fail-forward (a crash mid-pull boots the operation AND the row to
// failed + retry-allowed); the step granularity exists for diagnosis and for
// a future resume-instead policy flip.
var pullStepNames = []string{"resolve", "extract", "gate", "activate"}

// BootPolicies: how interrupted build operations are treated at boot.
func BootPolicies() map[string]runtime.BootPolicy {
	return map[string]runtime.BootPolicy{"pg_build_pull": runtime.FailForwardOnBoot}
}

// StatfsFree is the production FreeBytes: bytes available to unprivileged
// users on the filesystem backing dir.
func StatfsFree(dir string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil //nolint:gosec,unconvert // field widths differ per OS
}

// Pull kicks off an async pull job and returns its buildID immediately (the
// 202 contract: the downloading row AND its durable operation exist before
// this returns, so an immediate poll always finds the row and a crash leaves
// a fail-forwardable intent). Only one pull may run at a time process-wide;
// a concurrent call rejects rather than queuing.
func (s *Service) Pull(ctx context.Context, major int, tag string) (string, error) {
	if tag == "" {
		tag = "latest"
	}
	if !ociTagRe.MatchString(tag) {
		return "", service.Errf(400, "invalid tag: %s", tag)
	}
	s.mu.Lock()
	if s.pulling {
		s.mu.Unlock()
		return "", service.Errf(409, "a build pull is already in progress")
	}
	s.pulling = true
	s.mu.Unlock()

	release := func() {
		s.mu.Lock()
		s.pulling = false
		s.mu.Unlock()
	}

	id := store.NewID()
	if err := s.o.Store.CreatePgBuild(ctx, store.PgBuildParams{
		ID: id, Major: major, Source: "downloaded", ReleaseTag: tag,
		ImageDigest: "", Path: "", Status: "downloading",
	}); err != nil {
		release()
		return "", err
	}
	params, _ := json.Marshal(map[string]any{"major": major, "tag": tag})
	opID, err := s.o.Store.CreateOperation(ctx, "pg_build_pull", id, string(params),
		runtime.PlanFingerprint(s.pullSteps(id, major, tag, nil)))
	if err != nil {
		release()
		return "", err
	}
	s.publish()

	// Fire-and-forget on the daemon's lifetime, not the request's: errors are
	// always recorded on the row, never surfaced as a panic or lost.
	go func() {
		defer release()
		st := &pullState{}
		if err := runtime.RunOperation(context.Background(), s.o.Store, opID, 0, s.pullSteps(id, major, tag, st)); err != nil {
			s.recordPullFailure(context.Background(), id, major, st, err)
		}
		if st.resolvedDigest != "" {
			s.refreshLastCheck(context.Background(), major, tag, st.resolvedDigest)
		}
	}()
	return id, nil
}

// pullState threads the pipeline's compensation-relevant facts between steps
// and into the failure handler.
type pullState struct {
	resolvedDigest string
	stagingDir     string // set while the pre-rename staging dir exists
	finalDir       string // set the instant the rename lands
	activated      bool   // set the instant the pointer flipped
	settled        bool   // a benign terminal (skip) already recorded — failure handler stands down
}

// errSkipped signals a benign no-op terminal: the row is already recorded
// `skipped`; RunOperation must finish the OPERATION as failed-or-done? No —
// the operation finishes DONE: a no-op is a success. The step returns nil
// after recordSkip and sets st.settled, and later steps short-circuit.
func (s *Service) pullSteps(id string, major int, tag string, st *pullState) []runtime.Step {
	if st == nil {
		st = &pullState{}
	}
	return []runtime.Step{
		{Name: "resolve", Do: func(ctx context.Context) error { return s.stepResolve(ctx, id, major, tag, st) }},
		{Name: "extract", Do: func(ctx context.Context) error { return s.stepExtract(ctx, id, major, tag, st) }},
		{Name: "gate", Do: func(ctx context.Context) error { return s.stepGate(ctx, id, major, st) }},
		{Name: "activate", Do: func(ctx context.Context) error { return s.stepActivate(ctx, id, major, st) }},
	}
}

func (s *Service) stepResolve(ctx context.Context, id string, major int, tag string, st *pullState) error {
	// Preflight: disk headroom BEFORE any network.
	free, err := s.o.FreeBytes(s.o.PgBuildsDir)
	if err == nil && free < minFreeBytes {
		return fmt.Errorf("insufficient disk space on /data (< 1.5 GB free)")
	}
	digest, err := s.o.Puller.ResolveDigest(ctx, s.RepoFor(major), tag)
	if err != nil {
		return err
	}
	st.resolvedDigest = digest
	// Dedup on identity — the DIGEST, never the tag. Scoped to the SAME
	// major: a ready row for a DIFFERENT major sharing this digest (a
	// mislabeled image) must NOT short-circuit — let the extract's
	// expected-major guard fail it explicitly.
	existing, ok, err := s.o.Store.PgBuildByDigest(ctx, digest)
	if err != nil {
		return err
	}
	if ok && existing.Status == "ready" && existing.Major == major {
		if err := s.o.Store.SetPgBuildDigestPath(ctx, id, digest, ""); err != nil {
			return err
		}
		if existing.Minor != nil {
			if err := s.o.Store.SetPgBuildMinor(ctx, id, *existing.Minor); err != nil {
				return err
			}
		}
		st.settled = true
		return s.recordSkip(ctx, id,
			fmt.Sprintf("already installed as %s (%s) — up to date", s.versionString(existing), existing.Source))
	}
	tmpDir := filepath.Join(s.o.PgBuildsDir, fmt.Sprintf("v%d", major), ".tmp-"+oci.ShortDigest(digest))
	st.stagingDir = tmpDir
	if err := s.o.Store.SetPgBuildDigestPath(ctx, id, digest, tmpDir); err != nil {
		return err
	}
	s.publish()
	return nil
}

func (s *Service) stepExtract(ctx context.Context, id string, major int, tag string, st *pullState) error {
	if st.settled {
		return nil
	}
	if err := s.o.Puller.PullPrefix(ctx, oci.PullPrefixArgs{
		Repository: s.RepoFor(major), Digest: st.resolvedDigest, DestDir: st.stagingDir,
		OnProgress: func(line string) { s.log(id, line) },
	}); err != nil {
		return err
	}
	detMajor, detMinor, err := s.o.Detect(ctx, filepath.Join(st.stagingDir, "bin", "postgres"))
	if err != nil {
		return err
	}
	if detMajor != major {
		// The wrong-major message is a read-back contract (classifyDigest
		// treats it as permanent) — record it verbatim via the step error.
		return fmt.Errorf("%s", MajorMismatchMessage(detMajor, detMinor, major))
	}
	// Same-version dedup: an already-installed MINOR under a new digest is a
	// pointless second build (activate would toggle between identical
	// versions). Record the minor FIRST so the digest→minor link persists
	// for the check.
	rows, err := s.o.Store.PgBuildsByMajor(ctx, major)
	if err != nil {
		return err
	}
	for _, sib := range rows {
		if sib.ID != id && sib.Status == "ready" && sib.Minor != nil && *sib.Minor == detMinor {
			if err := os.RemoveAll(st.stagingDir); err != nil {
				return err
			}
			st.stagingDir = ""
			if err := s.o.Store.SetPgBuildMinor(ctx, id, detMinor); err != nil {
				return err
			}
			st.settled = true
			return s.recordSkip(ctx, id,
				fmt.Sprintf("already installed as %d.%d (%s) — up to date", major, detMinor, sib.Source))
		}
	}

	marker, err := json.Marshal(buildMarker{
		Digest: st.resolvedDigest, Tag: tag, Major: major, Minor: detMinor,
		ExtractedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(st.stagingDir, "build.json"), marker, 0o644); err != nil {
		return err
	}
	sizeBytes := duBytes(st.stagingDir)

	finalDir := filepath.Join(s.o.PgBuildsDir, fmt.Sprintf("v%d", major), oci.ShortDigest(st.resolvedDigest))
	if err := os.Rename(st.stagingDir, finalDir); err != nil {
		return err
	}
	st.stagingDir = ""
	st.finalDir = finalDir // from here on, a failure must reclaim it
	if err := s.o.Store.SetPgBuildPath(ctx, id, finalDir); err != nil {
		return err
	}
	if err := s.o.Store.SetPgBuildDetected(ctx, id, detMinor, sizeBytes); err != nil {
		return err
	}
	if err := s.o.Store.SetPgBuildStatus(ctx, id, "validating", ""); err != nil {
		return err
	}
	s.log(id, fmt.Sprintf("extracted postgres %d.%d — validating", major, detMinor))
	s.publish()
	return nil
}

func (s *Service) stepGate(ctx context.Context, id string, major int, st *pullState) error {
	if st.settled {
		return nil
	}
	gateCtx, cancel := context.WithTimeout(ctx, s.o.GateTimeout)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.o.Gate(gateCtx, major, st.finalDir) }()
	var gateErr error
	select {
	case gateErr = <-done:
	case <-gateCtx.Done():
		gateErr = fmt.Errorf("gate timed out after %ds", int(s.o.GateTimeout/time.Second))
	}
	if gateErr != nil {
		return gateErr
	}
	if err := s.o.Store.SetPgBuildStatus(ctx, id, "ready", ""); err != nil {
		return err
	}
	row, _, err := s.o.Store.PgBuildByID(ctx, id)
	if err != nil {
		return err
	}
	s.log(id, fmt.Sprintf("validation gate passed — %s ready", s.versionString(row)))
	s.publish()
	return nil
}

// stepActivate: a validated pull auto-activates — inside the mutation lane,
// the same lane an explicit activate or remove serializes through. A
// downgrade 409 (re-pulling an old tag deliberately) is EXPECTED and leaves
// a ready-but-inactive build; anything else propagates as a pipeline failure.
func (s *Service) stepActivate(ctx context.Context, id string, major int, st *pullState) error {
	if st.settled {
		return nil
	}
	err := s.owner.Run(ctx, func(laneCtx context.Context) error {
		row, aerr := s.activateLocked(laneCtx, id, false)
		if aerr != nil {
			var serr *service.Error
			if asServiceError(aerr, &serr) && serr.Status == 409 {
				s.log(id, fmt.Sprintf("%s — call activate to make this build the running one", serr.Message))
				return nil
			}
			return aerr
		}
		st.activated = true
		s.log(id, fmt.Sprintf("activated %s", s.versionString(row.PgBuildRow)))
		// Recompose strictly AFTER the build is final: a farm failure is
		// recoverable-by-design (the farm re-derives on every recompose and
		// at boot) — never destroy a valid build over it.
		if rerr := s.RecomposeDistrib(laneCtx); rerr != nil {
			s.log(id, fmt.Sprintf("pg_distrib recompose failed — build stays ready: %s", firstLine(rerr)))
			s.o.Log.Error("pg_distrib recompose failed after gate pass — build left ready; the farm self-heals", "err", rerr)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.publish()
	return nil
}

// recordPullFailure lands ANY pipeline failure on the row and compensates:
//   - the status flip + log are immediate (non-destructive; failing the row
//     early makes a concurrent activate 409 "not ready" instead of racing);
//   - a pre-rename failure reclaims the staging dir (clearing the path claim
//     only on a successful remove — a kept claim keeps the dir deletable);
//   - a post-rename failure rm's finalDir INSIDE the lane (so it cannot
//     interleave with an in-flight activate committing to that dir), clears
//     the path claim, and — if auto-activate already flipped the pointer —
//     re-resolves that ONE major, guarded: an existing active ready build
//     left by a concurrent lane winner is a sane state and is kept.
func (s *Service) recordPullFailure(ctx context.Context, id string, major int, st *pullState, cause error) {
	msg := firstLine(cause)
	if err := s.o.Store.SetPgBuildStatus(ctx, id, "failed", msg); err != nil {
		s.o.Log.Error("recording pull failure failed", "build", id, "err", err)
	}
	s.log(id, "pull failed: "+msg)
	s.o.Log.Error("pg_build pull failed", "build", id, "err", cause)
	s.publish()

	if st.stagingDir != "" && st.finalDir == "" {
		if err := os.RemoveAll(st.stagingDir); err != nil {
			// Keep the row's path claim: a later DELETE can still reclaim the
			// dir, and the boot sweep is the backstop.
			s.o.Log.Error("could not reclaim staging dir", "dir", st.stagingDir, "err", err)
		} else {
			row, ok, _ := s.o.Store.PgBuildByID(ctx, id)
			if ok && row.Path == st.stagingDir {
				_ = s.o.Store.SetPgBuildPath(ctx, id, "")
			}
		}
	}
	if st.finalDir != "" || st.activated {
		if err := s.owner.Run(ctx, func(laneCtx context.Context) error {
			if st.finalDir != "" {
				if err := os.RemoveAll(st.finalDir); err != nil && !isNotExist(err) {
					s.o.Log.Error("could not reclaim final dir", "dir", st.finalDir, "err", err)
				}
				if err := s.o.Store.SetPgBuildPath(laneCtx, id, ""); err != nil {
					return err
				}
			}
			if st.activated {
				activeID, ok, err := s.o.Store.ActiveBuildID(laneCtx, major)
				if err != nil {
					return err
				}
				hasActiveReady := false
				if ok {
					if row, found, _ := s.o.Store.PgBuildByID(laneCtx, activeID); found && row.Status == "ready" {
						hasActiveReady = true
					}
				}
				if !hasActiveReady {
					if err := s.resolveActiveFor(laneCtx, major); err != nil {
						return err
					}
				}
			}
			return nil
		}); err != nil {
			s.o.Log.Error("post-failure compensation failed", "build", id, "err", err)
		}
		s.publish()
	}
}

func firstLine(err error) string {
	msg := err.Error()
	if i := strings.IndexByte(msg, '\n'); i >= 0 {
		msg = msg[:i]
	}
	// Durable operations prefix step errors with "step <name>: " — strip it
	// so the row carries the clean cause (the operation row keeps the full
	// prefixed form).
	for _, name := range pullStepNames {
		msg = strings.TrimPrefix(msg, "step "+name+": ")
	}
	if len(msg) > 500 {
		msg = msg[:500]
	}
	return msg
}

func isNotExist(err error) bool { return err != nil && os.IsNotExist(err) }

func asServiceError(err error, target **service.Error) bool {
	for err != nil {
		if se, ok := err.(*service.Error); ok { //nolint:errorlint // one-level walk below
			*target = se
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// duBytes sums the tree's file sizes — informational, never load-bearing:
// nil on any failure.
func duBytes(dir string) *int64 {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if info, ierr := d.Info(); ierr == nil && d.Type().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return nil
	}
	return &total
}
```

(`asServiceError` exists because `errors.As` needs the `errors` import and a target double-pointer anyway — if the implementer prefers `errors.As(err, &serr)` directly, that is equivalent and preferred; keep whichever passes lint.)

- [ ] **Step 5: Implement activate/remove/overrides** — `internal/builds/activate.go`:

```go
package builds

import (
	"context"
	"os"

	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// Activate makes a ready build the major's active one, through the mutation
// lane (an explicit activate must never interleave with a remove or an
// auto-activate for the same major).
func (s *Service) Activate(ctx context.Context, id string, consented bool) (Row, error) {
	var out Row
	err := s.owner.Run(ctx, func(laneCtx context.Context) error {
		row, err := s.activateLocked(laneCtx, id, consented)
		if err != nil {
			return err
		}
		out = row
		if rerr := s.RecomposeDistrib(laneCtx); rerr != nil {
			// Deliberately accepted as recoverable: the pointer is committed,
			// the farm re-derives on every recompose and at boot. Rolling the
			// pointer back would be wrong for the common minor-refresh case.
			s.o.Log.Error("pg_distrib recompose failed after activate — self-heals on next recompose/boot", "err", rerr)
		}
		return nil
	})
	if err != nil {
		return Row{}, err
	}
	s.publish()
	return out, nil
}

// activateLocked is the lane-held body (the pipeline's auto-activate calls it
// from inside its own lane job). Guards, in order: 404 unknown, 409
// not-ready, 409 downgrade-without-consent. Consenting to a downgrade LOWERS
// the high-water (the operator just declared the lower version the intended
// baseline) and clears the degraded flag; activating at/above the high-water
// clears a pre-existing degraded flag immediately — re-pulling must
// un-degrade a major without a reboot.
func (s *Service) activateLocked(ctx context.Context, id string, consented bool) (Row, error) {
	row, ok, err := s.o.Store.PgBuildByID(ctx, id)
	if err != nil {
		return Row{}, err
	}
	if !ok {
		return Row{}, service.Errf(404, "no such build: %s", id)
	}
	if row.Status != "ready" {
		return Row{}, service.Errf(409, "pg_build %s is not ready to activate", id)
	}
	lastRun, err := s.o.Store.LastRunMinor(ctx, row.Major)
	if err != nil {
		return Row{}, err
	}
	isDowngrade := row.Minor != nil && lastRun != nil && *row.Minor < *lastRun
	if isDowngrade {
		if !consented {
			return Row{}, service.Errf(409,
				"activating %s would downgrade below the last-run %d.%d — pass consented:true (see docs on extension-catalog downgrades)",
				s.versionString(row), row.Major, *lastRun)
		}
		if err := s.o.Store.SetLastRunMinor(ctx, row.Major, *row.Minor); err != nil {
			return Row{}, err
		}
		s.mu.Lock()
		delete(s.degraded, row.Major)
		s.mu.Unlock()
	} else if row.Minor != nil {
		s.mu.Lock()
		delete(s.degraded, row.Major)
		s.mu.Unlock()
	}
	if err := s.o.Store.SetActiveBuild(ctx, row.Major, id); err != nil {
		return Row{}, err
	}
	return Row{PgBuildRow: row, Active: true,
		InUse: row.Path != "" && anyHasPrefix(s.o.RunningPgbins(), row.Path+"/")}, nil
}

// Remove deletes a build through the lane. The removability check and the
// rm run in ONE lane job, and the running-pgbin supplier is read INSIDE it,
// immediately before the check — a pre-lane snapshot goes stale while the
// removal waits behind an in-flight activate. The rm itself runs only when
// this row is the SOLE claimant of a non-empty path: rows legitimately share
// a path (a gate-failed attempt and its successful same-digest retry), and
// the guard checks the ROW, never whether a sibling still claims the dir.
func (s *Service) Remove(ctx context.Context, id string) error {
	err := s.owner.Run(ctx, func(laneCtx context.Context) error {
		row, err := s.assertRemovable(laneCtx, id, s.o.RunningPgbins())
		if err != nil {
			return err
		}
		all, err := s.o.Store.PgBuilds(laneCtx)
		if err != nil {
			return err
		}
		siblingClaims := false
		for _, r := range all {
			if r.ID != id && r.Path == row.Path && r.Path != "" {
				siblingClaims = true
			}
		}
		if row.Path != "" && !siblingClaims {
			if err := os.RemoveAll(row.Path); err != nil {
				return err
			}
		}
		if err := s.o.Store.DeletePgBuild(laneCtx, id); err != nil {
			return err
		}
		return s.RecomposeDistrib(laneCtx)
	})
	if err != nil {
		return err
	}
	s.publish()
	return nil
}

// assertRemovable 409s a removal of: the active row (would strand the major
// mid-use), any baked row (ships with the image), a row whose pull is in
// flight, or a row whose path is a prefix of a pgbin some running compute
// holds open. Unknown id → 404. Empty-path rows own no directory: never in
// use (the prefix test would otherwise degenerate to matching everything).
func (s *Service) assertRemovable(ctx context.Context, id string, running []string) (store.PgBuildRow, error) {
	row, ok, err := s.o.Store.PgBuildByID(ctx, id)
	if err != nil {
		return store.PgBuildRow{}, err
	}
	if !ok {
		return store.PgBuildRow{}, service.Errf(404, "no such build: %s", id)
	}
	activeID, hasActive, err := s.o.Store.ActiveBuildID(ctx, row.Major)
	if err != nil {
		return store.PgBuildRow{}, err
	}
	if hasActive && activeID == id {
		return store.PgBuildRow{}, service.Errf(409, "pg_build %s is the active build for major %d", id, row.Major)
	}
	if row.Source == "baked" {
		return store.PgBuildRow{}, service.Errf(409, "pg_build %s is a baked build and cannot be removed", id)
	}
	if row.Status == "downloading" || row.Status == "validating" {
		return store.PgBuildRow{}, service.Errf(409, "pg_build %s has a pull in flight — wait for it to finish or fail", id)
	}
	if row.Path != "" && anyHasPrefix(running, row.Path+"/") {
		return store.PgBuildRow{}, service.Errf(409, "pg_build %s is in use by a running endpoint", id)
	}
	return row, nil
}

// LastRunMinor exposes the high-water read (the MCP downgrade refusal
// determines downgrade-ness WITHOUT calling activate).
func (s *Service) LastRunMinor(ctx context.Context, major int) (*int, error) {
	return s.o.Store.LastRunMinor(ctx, major)
}

// NoteRun records the high-water for an endpoint start — keyed by the
// STARTED pgbin, resolved to its row. Only a READY row records: a
// validation-gate candidate is `validating`, and recording its unvalidated
// minor would poison the never-silent-downgrade baseline.
func (s *Service) NoteRun(ctx context.Context, pgbinDir string) {
	rows, err := s.o.Store.PgBuilds(ctx)
	if err != nil {
		return
	}
	for _, r := range rows {
		if r.Path != "" && pgbinDir == r.Path+"/bin" && r.Status == "ready" && r.Minor != nil {
			if err := s.o.Store.RecordRun(ctx, r.Major, *r.Minor); err != nil {
				s.o.Log.Error("recording run high-water failed", "major", r.Major, "err", err)
			}
			return
		}
	}
}

// Pgbin overrides: the validation gate pins a branch to the CANDIDATE
// install for the duration of its gate run. Consulted by the endpoint
// converge before the active-build resolution.
func (s *Service) SetPgbinOverride(branchID, pgbinDir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.overrides[branchID] = pgbinDir
}

func (s *Service) ClearPgbinOverride(branchID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.overrides, branchID)
}

func (s *Service) PgbinOverride(branchID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.overrides[branchID]
	return p, ok
}
```

- [ ] **Step 6: Implement the gate runner** — `internal/builds/gate.go`:

```go
package builds

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
)

// ValidationProjectPrefix names the gate's throwaway projects. The prefix
// deliberately fails the public project-name rule (leading underscore), so
// users can never collide with gate names and the internal-create path is
// the only way they exist.
const ValidationProjectPrefix = "_worktreedb_validate_"

type ProjectRef struct{ ID, Name string }

// GateDeps is the narrow service surface the gate drives — the REAL daemon
// paths (project create, endpoint start, SQL), each carved as a func so the
// builds package never imports the service package's concrete type.
type GateDeps struct {
	CreateProjectInternal func(ctx context.Context, name string, major int) (projectID, mainBranchID string, err error)
	DeleteProject         func(ctx context.Context, projectID string) error
	StartEndpoint         func(ctx context.Context, branchID string) error
	StopEndpoint          func(ctx context.Context, branchID string) error
	// RunSQL returns the first column of the first row rendered as a string
	// ("" when the query returned no rows).
	RunSQL func(ctx context.Context, branchID, query string) (string, error)
	// SetPgbinOverride/ClearPgbinOverride pin the gate branch's compute to
	// the CANDIDATE install (Service.SetPgbinOverride/ClearPgbinOverride in
	// production).
	SetPgbinOverride   func(branchID, pgbinDir string)
	ClearPgbinOverride func(branchID string)
	Log                *slog.Logger
}

// GateRunner builds the validation gate: a downloaded build must drive a
// REAL compute against the LIVE storage — basebackup from the pageserver,
// WAL to the safekeeper, neon extension load — before it may activate.
//   - the throwaway project is created through the internal path (reserved
//     name, candidate major not yet installed);
//   - the branch's compute is pinned to the candidate via the pgbin
//     override; the override also suppresses the run high-water record;
//   - SQL never auto-starts anything: a crashed candidate FAILS the gate
//     (the SQL path 502s on a non-running endpoint) instead of validating
//     whatever build a recovery would resolve.
func GateRunner(d GateDeps) GateFunc {
	return func(ctx context.Context, major int, buildPath string) error {
		suffix := make([]byte, 4)
		_, _ = rand.Read(suffix)
		name := ValidationProjectPrefix + hex.EncodeToString(suffix)
		projectID, mainBranchID, err := d.CreateProjectInternal(ctx, name, major)
		if err != nil {
			return err
		}
		d.SetPgbinOverride(mainBranchID, filepath.Join(buildPath, "bin"))
		defer func() {
			d.ClearPgbinOverride(mainBranchID)
			// Teardown is prompt and deterministic: stop the candidate's
			// compute, then delete the gate project. Best-effort — a cleanup
			// failure must never mask the gate verdict; the boot sweep
			// retries orphans.
			cleanupCtx := context.WithoutCancel(ctx)
			if err := d.StopEndpoint(cleanupCtx, mainBranchID); err != nil {
				d.Log.Error("gate cleanup: failed to stop endpoint", "project", name, "err", err)
			}
			if err := d.DeleteProject(cleanupCtx, projectID); err != nil {
				d.Log.Error("gate cleanup: failed to delete gate project — boot sweep will retry", "project", name, "err", err)
			}
		}()

		if err := d.StartEndpoint(ctx, mainBranchID); err != nil {
			return err
		}
		banner, err := d.RunSQL(ctx, mainBranchID, "SELECT version()")
		if err != nil {
			return err
		}
		if !strings.Contains(banner, fmt.Sprintf(" %d.", major)) {
			return fmt.Errorf("gate: expected PostgreSQL %d.x, got %.120s", major, banner)
		}
		// Real writes through the full path (pageserver-backed relation +
		// WAL), then a neon-extension probe.
		if _, err := d.RunSQL(ctx, mainBranchID,
			"CREATE TABLE _validate_gate(x int); INSERT INTO _validate_gate SELECT generate_series(1, 100); SELECT count(*) FROM _validate_gate"); err != nil {
			return err
		}
		if _, err := d.RunSQL(ctx, mainBranchID, "SHOW neon.timeline_id"); err != nil {
			return err
		}
		return nil
	}
}

// SweepValidationProjects deletes every project whose name carries the gate
// prefix — orphans left behind when a gate's own cleanup failed (engine
// unreachable, daemon crashed mid-gate). Called once at boot AFTER the
// engine and services are up.
func SweepValidationProjects(ctx context.Context,
	list func(ctx context.Context) ([]ProjectRef, error),
	del func(ctx context.Context, id string) error) (int, error) {
	projects, err := list(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, p := range projects {
		if strings.HasPrefix(p.Name, ValidationProjectPrefix) {
			if err := del(ctx, p.ID); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}
```

- [ ] **Step 7: Run all builds tests**

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -race -count=1`
Expected: PASS (boot + check + pull + activate suites).

- [ ] **Step 8: Add a gate-runner unit test** — append to `internal/builds/activate_test.go`:

```go
func TestGateRunnerDrivesRealPathAndAlwaysCleansUp(t *testing.T) {
	var calls []string
	var overrideSet, overrideCleared string
	deps := GateDeps{
		CreateProjectInternal: func(_ context.Context, name string, major int) (string, string, error) {
			if !strings.HasPrefix(name, ValidationProjectPrefix) || major != 17 {
				t.Errorf("internal create args: %s %d", name, major)
			}
			calls = append(calls, "create")
			return "p1", "b1", nil
		},
		DeleteProject: func(_ context.Context, id string) error { calls = append(calls, "delete:"+id); return nil },
		StartEndpoint: func(_ context.Context, id string) error { calls = append(calls, "start:"+id); return nil },
		StopEndpoint:  func(_ context.Context, id string) error { calls = append(calls, "stop:"+id); return nil },
		RunSQL: func(_ context.Context, _, query string) (string, error) {
			calls = append(calls, "sql")
			if strings.HasPrefix(query, "SELECT version()") {
				return "PostgreSQL 17.6 on aarch64", nil
			}
			return "", nil
		},
		SetPgbinOverride:   func(b, p string) { overrideSet = b + "=" + p },
		ClearPgbinOverride: func(b string) { overrideCleared = b },
		Log:                slog.New(slog.DiscardHandler),
	}
	gate := GateRunner(deps)
	if err := gate(context.Background(), 17, "/data/pg_builds/v17/abc"); err != nil {
		t.Fatal(err)
	}
	if overrideSet != "b1=/data/pg_builds/v17/abc/bin" || overrideCleared != "b1" {
		t.Fatalf("override lifecycle: set=%q cleared=%q", overrideSet, overrideCleared)
	}
	last := calls[len(calls)-1]
	if last != "delete:p1" {
		t.Fatalf("cleanup must run last: %v", calls)
	}

	// A wrong-major banner fails the gate AND still cleans up.
	calls = nil
	deps.RunSQL = func(_ context.Context, _, query string) (string, error) {
		return "PostgreSQL 16.4", nil
	}
	gate = GateRunner(deps)
	if err := gate(context.Background(), 17, "/x"); err == nil || !strings.Contains(err.Error(), "expected PostgreSQL 17.x") {
		t.Fatalf("banner check: %v", err)
	}
	if calls[len(calls)-1] != "delete:p1" {
		t.Fatalf("cleanup must run on failure too: %v", calls)
	}
}
```

Add `"log/slog"` and `"strings"` to that test file's imports if not present.

Run: `cd ~/git/worktreedb && go test ./internal/builds/ -race -count=1`
Expected: PASS.

- [ ] **Step 9: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/builds/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add internal/builds/ && git commit -m "feat(builds): durable pull pipeline with validation gate, activate/remove lane"
```

---

### Task 9: service + api — override-aware starts, runningPgVersion, pg-builds REST, status block

Wire the builds seams into the branch world and expose the REST surface. Service side: `Core` gains three nil-safe func fields (`PgbinOverride`, `NoteRun`, `VersionForPgbin`) plus by-name lookups and the internal project create the gate needs; the endpoint converge resolves the override FIRST (and suppresses the run record for overridden starts), records the high-water after a successful real start, and `BranchDetail` resolves `RunningPgVersion` from the persisted `status_pgbin`. API side: the five pg-builds routes, the REAL status `pgBuilds` block (replacing the `{}` placeholder at `internal/api/server.go:96`), and the `runningPgVersion` DTO field.

**Files:**
- Modify: `~/git/worktreedb/internal/service/core.go`
- Modify: `~/git/worktreedb/internal/service/endpoints.go`
- Modify: `~/git/worktreedb/internal/service/projects.go`
- Modify: `~/git/worktreedb/internal/service/endpoints_test.go` (fakes + new cases)
- Modify: `~/git/worktreedb/internal/api/server.go`
- Modify: `~/git/worktreedb/internal/api/dto.go`
- Modify: `~/git/worktreedb/internal/api/routes_test.go`

**Interfaces:**
- Consumes: Task 8 `builds.Service` methods (`List`, `Check`, `Pull`, `Activate`, `Remove`, `MajorStatus`, `PgbinFor`, `VersionForPgbin`, `NoteRun`, `PgbinOverride`, `InstalledMajors`); M2 `service.Core`, `api.Deps`, `writeServiceError`/`writeJSON`/`writeIssues`/`decodeBody`.
- Produces:
  - `service.Core` fields: `PgbinOverride func(branchID string) (string, bool)`, `NoteRun func(ctx context.Context, pgbinDir string)`, `VersionForPgbin func(ctx context.Context, pgbinDir string) *string` (all nil-safe: nil behaves as no-override / no-op / nil-version)
  - `func (c *Core) ProjectByNameOr404(ctx, name string) (store.ProjectRow, error)` — 404 `project %s not found`
  - `func (c *Core) BranchByProjectAndNameOr404(ctx, projectID, name string) (store.BranchRow, error)` — 404 `branch %s not found`
  - `func (c *Core) CreateProjectInternal(ctx, name string, major int) (store.ProjectRow, BranchDetail, error)` — skips the public name rule AND the installed-major whitelist; everything else identical to the public create
  - `service.BranchDetail` gains `RunningPgVersion *string`
  - `api.Deps` gains `Builds BuildsAPI` and `MCP http.Handler` (MCP mounted in Task 12; nil-safe now) where:
    `type BuildsAPI interface { List(ctx context.Context) ([]builds.Row, error); Check(ctx context.Context, majors []int) (map[string]builds.CheckResult, error); Pull(ctx context.Context, major int, tag string) (string, error); Activate(ctx context.Context, id string, consented bool) (builds.Row, error); Remove(ctx context.Context, id string) error; MajorStatus(ctx context.Context) (map[string]builds.MajorStatus, error); InstalledMajors(ctx context.Context) []int }`

- [ ] **Step 1: Write the failing service tests** — append to `internal/service/endpoints_test.go` (the file's existing fixture is `newTestCore(t) *testCore` from `fakes_test.go`, with `tc.core *Core`, `tc.comps.starts []compute.StartParams` capturing every launch, and `tc.seedBranch(t, "p1", "b1")`; the default `PgbinFor` returns `/pg/v17/bin`):

```go
func TestStartUsesPgbinOverrideAndSkipsNoteRun(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	var noted []string
	tc.core.NoteRun = func(_ context.Context, pgbin string) { noted = append(noted, pgbin) }
	tc.core.PgbinOverride = func(branchID string) (string, bool) {
		if branchID == "b1" {
			return "/candidate/bin", true
		}
		return "", false
	}
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	if len(tc.comps.starts) != 1 || tc.comps.starts[0].PgbinPath != "/candidate/bin" {
		t.Fatalf("compute starts = %+v, want the override pgbin", tc.comps.starts)
	}
	if len(noted) != 0 {
		t.Fatalf("an overridden start must not record the run high-water: %v", noted)
	}
}

func TestStartRecordsRunHighWater(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	var noted []string
	tc.core.NoteRun = func(_ context.Context, pgbin string) { noted = append(noted, pgbin) }
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	if len(noted) != 1 || noted[0] != "/pg/v17/bin" {
		t.Fatalf("NoteRun calls = %v, want the started pgbin once", noted)
	}
}

func TestBranchDetailResolvesRunningPgVersion(t *testing.T) {
	tc := newTestCore(t)
	tc.seedBranch(t, "p1", "b1")
	v := "17.4"
	tc.core.VersionForPgbin = func(_ context.Context, pgbin string) *string {
		if pgbin == "/pg/v17/bin" {
			return &v
		}
		return nil
	}
	if _, err := tc.core.StartEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	detail, err := tc.core.BranchDetail(context.Background(), "b1")
	if err != nil {
		t.Fatal(err)
	}
	if detail.RunningPgVersion == nil || *detail.RunningPgVersion != "17.4" {
		t.Fatalf("RunningPgVersion = %v", detail.RunningPgVersion)
	}
	// Stopped ⇒ nil, even with the resolver wired.
	if _, err := tc.core.StopEndpoint(context.Background(), "b1"); err != nil {
		t.Fatal(err)
	}
	detail, _ = tc.core.BranchDetail(context.Background(), "b1")
	if detail.RunningPgVersion != nil {
		t.Fatalf("stopped branch must report nil RunningPgVersion: %v", detail.RunningPgVersion)
	}
}
```

and to `internal/service/projects_test.go`:

```go
func TestCreateProjectInternalBypassesNameRuleAndWhitelist(t *testing.T) {
	tc := newTestCore(t)
	tc.core.InstalledMajors = func() []int { return nil } // nothing installed
	p, main, err := tc.core.CreateProjectInternal(context.Background(), "_worktreedb_validate_ab12cd34", 17)
	if err != nil {
		t.Fatal(err)
	}
	if p.PgMajor != 17 || main.Row.Name != "main" {
		t.Fatalf("internal create: %+v %+v", p, main.Row)
	}
	// The PUBLIC create still rejects both the reserved-prefix name and the
	// uninstalled major.
	if _, _, err := tc.core.CreateProject(context.Background(), "_worktreedb_validate_x", nil); err == nil {
		t.Fatal("public create must reject the reserved prefix (name rule)")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run 'TestStartUses|TestStartRecords|TestBranchDetailResolves|TestCreateProjectInternal' -count=1`
Expected: FAIL — `f.core.NoteRun undefined` (compile error).

- [ ] **Step 3: Implement the service side.**

In `internal/service/core.go`, extend `Core` (after the existing `InstalledMajors` field):

```go
	// Dynamic-build seams (all nil-safe; nil = the M1 baked-only behavior):
	// PgbinOverride pins a branch's compute to a specific install (the build
	// validation gate); NoteRun records the run high-water after a real
	// (non-overridden) start; VersionForPgbin resolves a running compute's
	// install back to its build version for the read model.
	PgbinOverride   func(branchID string) (string, bool)
	NoteRun         func(ctx context.Context, pgbinDir string)
	VersionForPgbin func(ctx context.Context, pgbinDir string) *string
```

In `internal/service/endpoints.go`:

1. Add the resolve helper (near `branchOr404`):

```go
// resolvePgbin resolves the install a start launches with: a gate override
// first (overridden starts never record the run high-water), else the
// major's active build.
func (c *Core) resolvePgbin(branchID string, major int) (pgbin string, overridden bool, err error) {
	if c.PgbinOverride != nil {
		if p, ok := c.PgbinOverride(branchID); ok {
			return p, true, nil
		}
	}
	p, err := c.PgbinFor(major)
	return p, false, err
}
```

2. In `convergeToRunning`, replace BOTH `pgbin, err := c.PgbinFor(project.PgMajor)` call sites with:

```go
		pgbin, overridden, err := c.resolvePgbin(b.ID, project.PgMajor)
```

(the surrounding error handling stays exactly as it is; the mgr=="running" restamp arm ignores `overridden` — add `_ = overridden` there).

3. In the full start path, immediately after the `c.Proxy.Bind(b.ID, computePort)` error block succeeds (before the final `commitEndpoint`), insert:

```go
	// The start physically happened: record the run high-water now, even if
	// the final status write below loses to a concurrent stop. Overridden
	// (gate) starts never record — a validating candidate must not raise the
	// never-silent-downgrade baseline.
	if !overridden && c.NoteRun != nil {
		c.NoteRun(ctx, pgbin)
	}
```

4. In `internal/service/endpoints.go`, extend `BranchDetail` and its builder:

```go
type BranchDetail struct {
	Row              store.BranchRow
	ConnectionString *string
	JdbcURL          *string
	LastRecordLsn    *string
	LogicalSizeBytes *int64
	AncestorLsn      *string
	// RunningPgVersion is the version string of the build the RUNNING
	// compute was started from; nil when stopped or unresolvable.
	RunningPgVersion *string
}
```

and in `detailOf` (after the existing enrichment), add:

```go
	if b.StatusEndpoint == "running" && b.StatusPgbin != nil && c.VersionForPgbin != nil {
		d.RunningPgVersion = c.VersionForPgbin(ctx, *b.StatusPgbin)
	}
```

(adapt the receiver variable names to `detailOf`'s actual body; the committedDetail path in `branches.go` flows through the same struct and needs no change).

5. In `internal/service/projects.go`, split the public create so the internal variant shares its body. The public `CreateProject` keeps its exact current behavior; factor its post-validation body into `createProject(ctx, name, major)` and add:

```go
// CreateProjectInternal creates a project bypassing the public name rule and
// the installed-major whitelist — the build validation gate's reserved
// "_worktreedb_validate_*" names deliberately fail the public rule (users
// can never collide with gate names), and the candidate major is still
// validating, not yet installed. Public callers never reach this.
func (c *Core) CreateProjectInternal(ctx context.Context, name string, major int) (store.ProjectRow, BranchDetail, error) {
	return c.createProject(ctx, name, major)
}
```

(the refactor is mechanical: `CreateProject` = validate name + resolve/validate major → `createProject`; `CreateProjectInternal` = straight to `createProject`).

- [ ] **Step 4: Run service tests**

Run: `cd ~/git/worktreedb && go test ./internal/service/ -race -count=1`
Expected: PASS (new + all M2 cases).

- [ ] **Step 5: Write the failing API tests** — append to `internal/api/routes_test.go`. The file's builder is `newTestServer(t, core CoreAPI) (*httptest.Server, *events.Bus, *events.LogHub)`: add a builds-aware variant and make the old one delegate so every existing test is untouched:

```go
func newTestServerWithBuilds(t *testing.T, core CoreAPI, fb BuildsAPI) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	srv := httptest.NewServer(NewServer(Deps{
		Version: "0.3.0", PortRange: config.PortRange{Min: 54300, Max: 54339},
		Engine: fakeEngine{}, Core: core, Builds: fb,
		Bus: events.NewBus(), Hub: events.NewLogHub(), ShutdownCtx: ctx,
	}))
	t.Cleanup(srv.Close)
	return srv
}
```

(and change `newTestServer`'s body to build its Deps the same way with `Builds: &fakeBuilds{}` — a zero-value fake keeps every pre-existing route test passing, including `/api/status` whose pgBuilds block is now real.) Then add the raw-call helper + fake + tests:

```go
// rawJSON issues a request and returns (status, raw body) — the pg-builds
// routes answer arrays and empty 204s, which doJSON's map decode can't carry.
func rawJSON(t *testing.T, method, url, body string) (int, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
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
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(raw)
}

type fakeBuilds struct {
	rows    []builds.Row
	checks  map[string]builds.CheckResult
	pullID  string
	pullErr error
	status  map[string]builds.MajorStatus
	calls   []string
}

func (f *fakeBuilds) List(context.Context) ([]builds.Row, error) { return f.rows, nil }
func (f *fakeBuilds) Check(_ context.Context, majors []int) (map[string]builds.CheckResult, error) {
	f.calls = append(f.calls, fmt.Sprintf("check:%v", majors))
	return f.checks, nil
}
func (f *fakeBuilds) Pull(_ context.Context, major int, tag string) (string, error) {
	f.calls = append(f.calls, fmt.Sprintf("pull:%d:%s", major, tag))
	if f.pullErr != nil {
		return "", f.pullErr
	}
	return f.pullID, nil
}
func (f *fakeBuilds) Activate(_ context.Context, id string, consented bool) (builds.Row, error) {
	f.calls = append(f.calls, fmt.Sprintf("activate:%s:%v", id, consented))
	if len(f.rows) == 0 {
		return builds.Row{}, service.Errf(404, "no such build: %s", id)
	}
	return f.rows[0], nil
}
func (f *fakeBuilds) Remove(_ context.Context, id string) error {
	f.calls = append(f.calls, "remove:"+id)
	return nil
}
func (f *fakeBuilds) MajorStatus(context.Context) (map[string]builds.MajorStatus, error) {
	return f.status, nil
}
func (f *fakeBuilds) InstalledMajors(context.Context) []int { return []int{17} }

func sampleBuildRow() builds.Row {
	minor := 4
	size := int64(1024)
	return builds.Row{
		PgBuildRow: store.PgBuildRow{
			ID: "b-1", Major: 17, Minor: &minor, Source: "downloaded", ReleaseTag: "9999",
			ImageDigest: "sha256:abc", Path: "/data/pg_builds/v17/abc", SizeBytes: &size,
			Status: "ready", CreatedAt: "2026-07-12T00:00:00Z",
		},
		Active: true, InUse: true,
	}
}

func TestPgBuildsRoutes(t *testing.T) {
	fb := &fakeBuilds{
		rows:   []builds.Row{sampleBuildRow()},
		checks: map[string]builds.CheckResult{"17": {Tag: "latest", Digest: "sha256:abc", State: "current", IsNew: false, At: "2026-07-12T00:00:00Z"}},
		pullID: "new-build-id",
		status: map[string]builds.MajorStatus{},
	}
	srv := newTestServerWithBuilds(t, &fakeCore{branch: sampleBranch()}, fb)

	// GET /api/pg-builds → the DTO with exactly the wire fields.
	code, body := rawJSON(t, http.MethodGet, srv.URL+"/api/pg-builds", "")
	if code != 200 {
		t.Fatalf("list: %d %s", code, body)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(body), &list); err != nil || len(list) != 1 {
		t.Fatalf("list decode: %v %s", err, body)
	}
	row := list[0]
	for _, key := range []string{"id", "major", "minor", "version", "source", "releaseTag", "imageDigest", "status", "active", "inUse", "sizeBytes", "error", "createdAt"} {
		if _, ok := row[key]; !ok {
			t.Fatalf("DTO missing %q: %v", key, row)
		}
	}
	if row["version"] != "17.4" || row["active"] != true || row["inUse"] != true || row["error"] != nil {
		t.Fatalf("DTO values: %v", row)
	}

	// POST /api/pg-builds/check: absent majors default to installed.
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/check", "")
	if code != 200 || !strings.Contains(body, `"state":"current"`) {
		t.Fatalf("check: %d %s", code, body)
	}
	if fb.calls[len(fb.calls)-1] != "check:[17]" {
		t.Fatalf("check default majors: %v", fb.calls)
	}
	// Explicit majors pass through; a sub-14 major is a validation issue.
	code, _ = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/check", `{"majors":[18]}`)
	if code != 200 || fb.calls[len(fb.calls)-1] != "check:[18]" {
		t.Fatalf("check explicit: %d %v", code, fb.calls)
	}
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/check", `{"majors":[9]}`)
	if code != 400 || !strings.Contains(body, "invalid request body") {
		t.Fatalf("check validation: %d %s", code, body)
	}

	// POST /api/pg-builds/pull → 202 {"buildId": …}; body validation.
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/pull", `{"major":17,"tag":"9999"}`)
	if code != 202 || !strings.Contains(body, `"buildId":"new-build-id"`) {
		t.Fatalf("pull: %d %s", code, body)
	}
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/pull", `{}`)
	if code != 400 || !strings.Contains(body, "major: Required") {
		t.Fatalf("pull validation: %d %s", code, body)
	}
	// A service 409 (mutex) flows through the standard envelope.
	fb.pullErr = service.Errf(409, "a build pull is already in progress")
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/pull", `{"major":17}`)
	if code != 409 || !strings.Contains(body, "a build pull is already in progress") {
		t.Fatalf("pull mutex: %d %s", code, body)
	}
	fb.pullErr = nil

	// POST /api/pg-builds/{id}/activate → 200 DTO; DELETE → 204 empty.
	code, body = rawJSON(t, http.MethodPost, srv.URL+"/api/pg-builds/b-1/activate", `{"consented":true}`)
	if code != 200 || !strings.Contains(body, `"id":"b-1"`) {
		t.Fatalf("activate: %d %s", code, body)
	}
	if fb.calls[len(fb.calls)-1] != "activate:b-1:true" {
		t.Fatalf("activate args: %v", fb.calls)
	}
	code, body = rawJSON(t, http.MethodDelete, srv.URL+"/api/pg-builds/b-1", "")
	if code != 204 || body != "" {
		t.Fatalf("delete: %d %q", code, body)
	}
}

func TestStatusPgBuildsBlock(t *testing.T) {
	av := "17.5"
	src := "baked"
	fb := &fakeBuilds{status: map[string]builds.MajorStatus{
		"17": {ActiveVersion: &av, Source: &src, DegradedDowngrade: true, UpdateAvailable: nil},
	}}
	srv := newTestServerWithBuilds(t, &fakeCore{branch: sampleBranch()}, fb)
	code, body := rawJSON(t, http.MethodGet, srv.URL+"/api/status", "")
	if code != 200 {
		t.Fatalf("status: %d", code)
	}
	var status struct {
		PgBuilds map[string]map[string]any `json:"pgBuilds"`
	}
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	m := status.PgBuilds["17"]
	if m["activeVersion"] != "17.5" || m["source"] != "baked" || m["degradedDowngrade"] != true || m["updateAvailable"] != nil {
		t.Fatalf("pgBuilds block: %v", m)
	}
}

func TestBranchDTORunningPgVersion(t *testing.T) {
	fc := &fakeCore{branch: sampleBranch()}
	v := "17.4"
	fc.branch.RunningPgVersion = &v
	srv := newTestServerWithBuilds(t, fc, &fakeBuilds{})
	code, body := rawJSON(t, http.MethodGet, srv.URL+"/api/branches/b1", "")
	if code != 200 || !strings.Contains(body, `"runningPgVersion":"17.4"`) {
		t.Fatalf("branch DTO: %d %s", code, body)
	}
}
```

(add `"encoding/json"` and the `builds`/`service` imports to routes_test.go if absent; `sampleBranch()` already exists in the file — `fc.branch.RunningPgVersion` works because `service.BranchDetail` gains that field in this task's service half.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/api/ -run 'TestPgBuilds|TestStatusPgBuilds|TestBranchDTO' -count=1`
Expected: FAIL — `undefined: BuildsAPI` (compile error).

- [ ] **Step 7: Implement the API side.**

In `internal/api/server.go`, add to the imports `"github.com/VanGoghSoftware/worktreedb/internal/builds"`, extend `Deps`:

```go
type Deps struct {
	Version     string
	PortRange   config.PortRange
	Engine      StatusSource
	Core        CoreAPI
	Builds      BuildsAPI
	Bus         *events.Bus
	Hub         *events.LogHub
	MCP         http.Handler // mounted at /mcp when non-nil
	ShutdownCtx context.Context
}

// BuildsAPI is the exact builds surface the routes consume — *builds.Service
// satisfies it; route tests use a fake.
type BuildsAPI interface {
	List(ctx context.Context) ([]builds.Row, error)
	Check(ctx context.Context, majors []int) (map[string]builds.CheckResult, error)
	Pull(ctx context.Context, major int, tag string) (string, error)
	Activate(ctx context.Context, id string, consented bool) (builds.Row, error)
	Remove(ctx context.Context, id string) error
	MajorStatus(ctx context.Context) (map[string]builds.MajorStatus, error)
	InstalledMajors(ctx context.Context) []int
}

var _ BuildsAPI = (*builds.Service)(nil)
```

Replace the status route's `"pgBuilds": map[string]any{}` placeholder line (and its comment) with:

```go
		pgBuilds, err := d.Builds.MajorStatus(r.Context())
		if err != nil {
			writeServiceError(w, err)
			return
		}
		if pgBuilds == nil {
			pgBuilds = map[string]builds.MajorStatus{} // wire contract: an empty OBJECT, never null
		}
```

and use `"pgBuilds": pgBuilds` in the payload map. (The M2 status tests that asserted the `{}` stopgap keep passing: an empty map renders as `{}`.)

Add the five routes (after the `/api/sql` route, before the unknown-route handler):

```go
	// Dynamic PostgreSQL builds. GET is a pure read; check/pull are the only
	// routes with registry egress; activate/remove serialize through the
	// builds mutation lane inside the service.
	mux.HandleFunc("GET /api/pg-builds", func(w http.ResponseWriter, r *http.Request) {
		rows, err := d.Builds.List(r.Context())
		if err != nil {
			writeServiceError(w, err)
			return
		}
		out := make([]pgBuildDTO, 0, len(rows))
		for _, row := range rows {
			out = append(out, toPgBuildDTO(row))
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("POST /api/pg-builds/check", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Majors *[]int `json:"majors"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var majors []int
		if body.Majors != nil {
			for _, m := range *body.Majors {
				if m < 14 {
					writeIssues(w, []string{"majors: must be an integer >= 14"})
					return
				}
			}
			majors = *body.Majors
		} else {
			majors = d.Builds.InstalledMajors(r.Context())
		}
		out, err := d.Builds.Check(r.Context(), majors)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, out)
	})

	// 202, not 200: Pull returns as soon as the downloading row exists — the
	// real work runs after this response. Callers poll GET /api/pg-builds
	// (or the pg_builds event) for the row's status.
	mux.HandleFunc("POST /api/pg-builds/pull", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Major *int    `json:"major"`
			Tag   *string `json:"tag"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		var issues []string
		if body.Major == nil {
			issues = append(issues, "major: Required")
		} else if *body.Major < 14 {
			issues = append(issues, "major: must be an integer >= 14")
		}
		if body.Tag != nil && *body.Tag == "" {
			issues = append(issues, "tag: must be a non-empty string")
		}
		if len(issues) > 0 {
			writeIssues(w, issues)
			return
		}
		tag := ""
		if body.Tag != nil {
			tag = *body.Tag
		}
		buildID, err := d.Builds.Pull(r.Context(), *body.Major, tag)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 202, map[string]string{"buildId": buildID})
	})

	mux.HandleFunc("POST /api/pg-builds/{id}/activate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Consented *bool `json:"consented"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		consented := body.Consented != nil && *body.Consented
		row, err := d.Builds.Activate(r.Context(), r.PathValue("id"), consented)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		writeJSON(w, 200, toPgBuildDTO(row))
	})

	mux.HandleFunc("DELETE /api/pg-builds/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := d.Builds.Remove(r.Context(), r.PathValue("id")); err != nil {
			writeServiceError(w, err)
			return
		}
		w.WriteHeader(204)
	})

	if d.MCP != nil {
		// Mounted AS the handler (not a raw-path middleware): the Host/Origin
		// guard wrapped inside d.MCP runs iff the router dispatched here,
		// however the wire path was percent-encoded.
		mux.Handle("/mcp", d.MCP)
	}
```

In `internal/api/dto.go`, add the build DTO + the branch field:

```go
type pgBuildDTO struct {
	ID          string  `json:"id"`
	Major       int     `json:"major"`
	Minor       *int    `json:"minor"`
	Version     *string `json:"version"`
	Source      string  `json:"source"`
	ReleaseTag  string  `json:"releaseTag"`
	ImageDigest string  `json:"imageDigest"`
	Status      string  `json:"status"`
	Active      bool    `json:"active"`
	InUse       bool    `json:"inUse"`
	SizeBytes   *int64  `json:"sizeBytes"`
	Error       *string `json:"error"`
	CreatedAt   string  `json:"createdAt"`
}

func toPgBuildDTO(row builds.Row) pgBuildDTO {
	var version *string
	if row.Minor != nil {
		v := fmt.Sprintf("%d.%d", row.Major, *row.Minor)
		version = &v
	}
	return pgBuildDTO{
		ID: row.ID, Major: row.Major, Minor: row.Minor, Version: version,
		Source: row.Source, ReleaseTag: row.ReleaseTag, ImageDigest: row.ImageDigest,
		Status: row.Status, Active: row.Active, InUse: row.InUse,
		SizeBytes: row.SizeBytes, Error: row.Error, CreatedAt: row.CreatedAt,
	}
}
```

(add `"fmt"` and the builds import to dto.go) and change `toBranchDTO`'s last line from `RunningPgVersion: nil` to `RunningPgVersion: d.RunningPgVersion` (drop the now-stale placeholder comment on the struct field: reword it to `// Version string of the build the running compute was started from; null when stopped or unresolvable.`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/api/ ./internal/service/ -race -count=1`
Expected: PASS.

- [ ] **Step 9: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/api/ ./internal/service/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add internal/service/ internal/api/ && git commit -m "feat(api,service): pg-builds routes, status block, runningPgVersion, gate seams"
```

---

### Task 10: cmd + engine — boot rewiring, pg_distrib_dir, Dockerfile

The boot order gains the builds bootstrap BEFORE the engine (the pageserver's `pg_distrib_dir` now points at the composed farm, which only `BootAdopt` creates), swaps `PgbinFor`/`InstalledMajors` to the registry-backed resolvers, wires the gate + overrides + NoteRun + VersionForPgbin seams, registers the pull boot policy, sweeps orphaned validation projects once services are up, and bumps the version. The Dockerfile adds the `sqlite3` CLI (operator state inspection — also what volume tooling uses to poke `state.db` offline).

**Files:**
- Modify: `~/git/worktreedb/internal/engine/specs.go`
- Modify: `~/git/worktreedb/internal/engine/specs_test.go`
- Modify: `~/git/worktreedb/cmd/worktreedbd/main.go`
- Modify: `~/git/worktreedb/Dockerfile`

**Interfaces:**
- Consumes: everything Tasks 1–9 produced.
- Produces: a bootable daemon whose `/api/status` shows the real pgBuilds block; the `version` const `0.3.0`.

- [ ] **Step 1: Write the failing specs test** — in `internal/engine/specs_test.go`, find the assertion `` `pg_distrib_dir = "/usr/local/share/neon/pg_install"` `` and change that expectation to the distrib farm:

```go
		`pg_distrib_dir = "/data/pg_distrib"`,
```

(the test's fixture config comes from `config.Load` with `WORKTREEDB_DATA_DIR=/data` — if the fixture builds a `Config` literal instead, set `PgDistribDir: "/data/pg_distrib"` on it).

Run: `cd ~/git/worktreedb && go test ./internal/engine/ -run TestPageserver -count=1`
Expected: FAIL — the toml still renders the install dir.

- [ ] **Step 2: Implement** — in `internal/engine/specs.go`, `PageserverToml`, change:

```go
		fmt.Sprintf("pg_distrib_dir = %s", tomlString(cfg.PgInstallDir)),
```

to:

```go
		// The COMPOSED farm, not the baked install dir: baked majors win
		// their slots; a downloaded new major fills the gap so the pageserver
		// finds its WAL-redo postgres. Composed by the builds bootstrap
		// BEFORE the supervisor starts (main.go boot order).
		fmt.Sprintf("pg_distrib_dir = %s", tomlString(cfg.PgDistribDir)),
```

Run: `cd ~/git/worktreedb && go test ./internal/engine/ -count=1`
Expected: PASS.

- [ ] **Step 3: Rewire boot** — in `cmd/worktreedbd/main.go`:

1. Bump `const version = "0.2.0"` → `const version = "0.3.0"`.
2. Add imports: `"github.com/VanGoghSoftware/worktreedb/internal/builds"`, `"github.com/VanGoghSoftware/worktreedb/internal/oci"`.
3. AFTER the `catalogPassword` block and BEFORE `sup := engine.NewSupervisor(...)`, insert the builds bootstrap (the supervisor's pageserver.toml reads the farm, so this MUST precede `sup.Start`):

```go
	hub := events.NewLogHub()
	bus := events.NewBus()

	// Builds bootstrap BEFORE the engine: pageserver.toml's pg_distrib_dir
	// points at the composed farm, which only BootAdopt creates. Nothing
	// here dials the registry — check/pull are the only egress.
	buildsSvc := builds.New(builds.Options{
		Store: st, PgInstallDir: cfg.PgInstallDir, PgBuildsDir: cfg.PgBuildsDir,
		PgDistribDir: cfg.PgDistribDir, RegistryBase: cfg.PgRegistryBase,
		ImageTemplate: cfg.PgImageTemplate,
		Puller: oci.NewClient(oci.ClientOpts{
			RegistryBase: cfg.PgRegistryBase, AuthToken: cfg.PgRegistryToken, Log: log,
		}),
		Detect:    builds.DetectVersion,
		FreeBytes: builds.StatfsFree,
		// RunningPgbins and Gate are wired below once computes/core exist —
		// BootAdopt needs neither.
		RunningPgbins: func() []string { return nil },
		Hub:           hub, Bus: bus, Log: log,
	})
	buildsSvc.Start(ctx)
	if err := buildsSvc.BootAdopt(ctx); err != nil {
		removeLock()
		return fmt.Errorf("boot: build adoption: %w", err)
	}
```

(delete the pre-existing `hub := events.NewLogHub()` / `bus := events.NewBus()` lines further down — they moved up with this block).

4. In the boot-reconciliation step 1, merge the pull policy into the policy map:

```go
	policies := service.TimetravelBootPolicies()
	for kind, p := range builds.BootPolicies() {
		policies[kind] = p
	}
	if err := runtime.ResumeIncomplete(ctx, st, policies,
		func(op store.Operation) []runtime.Step { return nil }, log); err != nil {
```

5. In the `core := &service.Core{...}` literal, replace the two baked-only funcs and add the three seams:

```go
		PgbinFor:        func(major int) (string, error) { return buildsSvc.PgbinFor(context.Background(), major) },
		InstalledMajors: func() []int { return buildsSvc.InstalledMajors(context.Background()) },
		PgbinOverride:   buildsSvc.PgbinOverride,
		NoteRun:         buildsSvc.NoteRun,
		VersionForPgbin: buildsSvc.VersionForPgbin,
```

(the `compute` import stays — `compute.NewManager` still uses it).

6. AFTER `computes := compute.NewManager(...)` is constructed, close the two loops:

```go
	buildsSvc.SetRunningPgbins(computes.RunningPgbins)
```

Add that setter to `internal/builds/service.go` (it did not exist yet — boot is its only caller):

```go
// SetRunningPgbins late-binds the in-use supplier (the compute manager is
// constructed after the boot adoption that needs everything else).
func (s *Service) SetRunningPgbins(fn func() []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.o.RunningPgbins = fn
}
```

and — so the read path uses it safely — change every direct `s.o.RunningPgbins()` call in `service.go`/`activate.go` to go through:

```go
func (s *Service) runningPgbins() []string {
	s.mu.Lock()
	fn := s.o.RunningPgbins
	s.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn()
}
```

7. AFTER `core` exists (and owners are registered), wire the gate + the validation sweep:

```go
	buildsSvc.SetGate(builds.GateRunner(builds.GateDeps{
		CreateProjectInternal: func(gctx context.Context, name string, major int) (string, string, error) {
			p, main, err := core.CreateProjectInternal(gctx, name, major)
			if err != nil {
				return "", "", err
			}
			return p.ID, main.Row.ID, nil
		},
		DeleteProject: core.DeleteProject,
		StartEndpoint: func(gctx context.Context, branchID string) error {
			_, err := core.StartEndpoint(gctx, branchID)
			return err
		},
		StopEndpoint: func(gctx context.Context, branchID string) error {
			_, err := core.StopEndpoint(gctx, branchID)
			return err
		},
		RunSQL: func(gctx context.Context, branchID, query string) (string, error) {
			out, err := core.RunSQL(gctx, branchID, query)
			if err != nil {
				return "", err
			}
			if len(out.Rows) == 0 || len(out.Rows[0]) == 0 {
				return "", nil
			}
			return fmt.Sprintf("%v", out.Rows[0][0]), nil
		},
		SetPgbinOverride:   buildsSvc.SetPgbinOverride,
		ClearPgbinOverride: buildsSvc.ClearPgbinOverride,
		Log:                log,
	}))

	// Reclaim gate projects orphaned by a crash mid-gate — needs live
	// services, so it runs here rather than in the pre-engine bootstrap.
	if n, err := builds.SweepValidationProjects(ctx,
		func(sctx context.Context) ([]builds.ProjectRef, error) {
			rows, err := st.Projects(sctx)
			if err != nil {
				return nil, err
			}
			refs := make([]builds.ProjectRef, 0, len(rows))
			for _, p := range rows {
				refs = append(refs, builds.ProjectRef{ID: p.ID, Name: p.Name})
			}
			return refs, nil
		},
		core.DeleteProject); err != nil {
		log.Error("boot: validation-project sweep failed", "err", err)
	} else if n > 0 {
		log.Info("boot: swept orphaned validation projects", "count", n)
	}
```

Add the matching setter to `internal/builds/service.go`:

```go
// SetGate late-binds the validation gate (it drives the service layer, which
// is constructed after this service).
func (s *Service) SetGate(gate GateFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.o.Gate = gate
}
```

and in `stepGate`, read it under the lock into a local before use (`s.mu.Lock(); gate := s.o.Gate; s.mu.Unlock()`; a nil gate fails the step with `fmt.Errorf("no validation gate wired")`).

8. Pass `Builds: buildsSvc` in the `api.Deps` literal.
9. RunSQL's result shape: adapt the `RunSQL` closure above to the REAL `service.SQLResult` field names from M2 (`out.Rows` is `[][]any` in the M2 SQL console; if the field is named differently — check `internal/service/sql.go` — use its actual first-row-first-column accessor).

- [ ] **Step 4: Dockerfile** — in `~/git/worktreedb/Dockerfile`, extend the runtime apt line:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 libpq5 libreadline8 libseccomp2 libcurl4 \
    libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1 tini sqlite3 \
    && rm -rf /var/lib/apt/lists/*
```

with the comment above it extended by one line:

```dockerfile
# sqlite3: operator tooling for inspecting /data/state.db (troubleshooting +
# offline volume edits) — the daemon itself never shells out to it.
```

- [ ] **Step 5: Build + unit-verify**

Run: `cd ~/git/worktreedb && go build ./... && go test ./... -race -count=1`
Expected: builds clean; ALL unit tests pass.

Run: `export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin" && cd ~/git/worktreedb && docker build -t worktreedb:dev .`
Expected: image builds.

Run: `cd ~/git/worktreedb && go test -tags integration ./integration/... -count=1 -timeout 30m`
Expected: PASS — M1 boot cases + M2 branching still green on the rewired boot (this catches a broken pg_distrib boot order immediately: the pageserver fails to start if the farm is missing).

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/engine/ internal/builds/ cmd/worktreedbd/main.go Dockerfile && git commit -m "feat(boot): builds bootstrap before engine, composed pg_distrib_dir, gate wiring"
```

---

### Task 11: engine clients — decode checks, error display, body-read (+ two doc nits)

The M2 deferral trio in `internal/engine/clients.go`, plus two P5 doc corrections. All behavior-preserving except where noted.

**Files:**
- Modify: `~/git/worktreedb/internal/engine/clients.go`
- Modify: `~/git/worktreedb/internal/engine/clients_test.go`
- Modify: `~/git/worktreedb/internal/store/operations.go` (doc only)
- Modify: `~/git/worktreedb/internal/events/loghub.go` (doc only)

**Interfaces:**
- Consumes: M2 `engine.APIError`, `doEngine`, `GetLsnByTimestamp`, `TimelineDetachAncestor`.
- Produces: no signature changes — stricter decode failures surface as `*engine.APIError`.

- [ ] **Step 1: Write the failing tests** — append to `internal/engine/clients_test.go` (reuse its httptest fake-engine conventions):

```go
func TestGetLsnByTimestampRejectsMissingFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`)) // 200 with neither lsn nor kind
	}))
	defer srv.Close()
	c := &StorconClient{Base: srv.URL, Sleep: func(context.Context, int) error { return nil }}
	_, err := c.GetLsnByTimestamp(context.Background(),
		"11111111111111111111111111111111", "22222222222222222222222222222222", "2026-07-12T00:00:00Z")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Body, "missing lsn/kind") {
		t.Fatalf("err = %v", err)
	}
}

func TestDetachAncestorRejectsMissingField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`)) // 200 without reparented_timelines
	}))
	defer srv.Close()
	c := &PageserverClient{Base: srv.URL}
	_, err := c.TimelineDetachAncestor(context.Background(),
		"11111111111111111111111111111111", "22222222222222222222222222222222")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Body, "missing reparented_timelines") {
		t.Fatalf("err = %v", err)
	}
}

func TestAPIErrorDisplayTruncatesBody(t *testing.T) {
	e := &APIError{Op: "x", Status: 500, Body: strings.Repeat("z", 2000)}
	if got := e.Error(); len(got) > 400 || !strings.HasSuffix(got, "…") {
		t.Fatalf("display must cap the body: len=%d", len(got))
	}
	// The struct keeps the FULL body for classification.
	if len(e.Body) != 2000 {
		t.Fatal("Body must stay complete")
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/engine/ -run 'TestGetLsn|TestDetach|TestAPIError' -count=1`
Expected: FAIL (missing-field cases decode to zero values today; display is uncapped).

- [ ] **Step 2: Implement** — in `internal/engine/clients.go`:

1. `APIError.Error()` — cap the DISPLAYED body (the `Body` field stays complete for callers that classify on it):

```go
func (e *APIError) Error() string {
	body := e.Body
	if len(body) > 300 {
		body = body[:300] + "…"
	}
	return fmt.Sprintf("%s: engine returned %d: %s", e.Op, e.Status, body)
}
```

2. `doEngine` — stop swallowing the body-read error:

```go
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if readErr != nil {
		return nil, &APIError{Op: op, Status: res.StatusCode, Body: "reading engine response body: " + readErr.Error()}
	}
```

3. `GetLsnByTimestamp` — after the successful unmarshal, add:

```go
	// A 200 whose body lacks either field is not a usable answer — an empty
	// LSN would flow into a timeline-create payload downstream.
	if out.LSN == "" || out.Kind == "" {
		return out, &APIError{Op: "get_lsn_by_timestamp", Status: 200, Body: "missing lsn/kind in engine response: " + string(raw)}
	}
```

4. `TimelineDetachAncestor` — decode through a pointer shadow so an ABSENT field is distinguishable from an empty list:

```go
	var shadow struct {
		ReparentedTimelines *[]string `json:"reparented_timelines"`
	}
	if err := json.Unmarshal(raw, &shadow); err != nil {
		return out, &APIError{Op: "timeline_detach_ancestor", Status: 200, Body: "invalid JSON from engine: " + string(raw)}
	}
	if shadow.ReparentedTimelines == nil {
		return out, &APIError{Op: "timeline_detach_ancestor", Status: 200, Body: "missing reparented_timelines in engine response: " + string(raw)}
	}
	out.ReparentedTimelines = *shadow.ReparentedTimelines
	return out, nil
```

(replacing the existing `json.Unmarshal(raw, &out)` block.)

5. Doc nits:
   - `internal/store/operations.go` — extend the `ErrOperationNotActive` doc to name all producers: `// ErrOperationNotActive is returned by AdvanceOperation/FinishOperation when the operation is already terminal (done/failed) or does not exist, and by runtime.RunOperation when asked to execute an already-terminal row — the cross-owner backstop made matchable.`
   - `internal/events/loghub.go` — the LogHub type doc asserts "SSE attach order is Subscribe first, THEN Recent" as if that were the live wiring; the API layer deliberately attaches Recent-then-Subscribe (see `api.logsSSE`'s own rationale). Reword the paragraph to: `// A gap-free SSE attach order is available by construction: Subscribe first, THEN Recent — because Ingest appends to the ring and snapshots subscribers under one mutex, that order can duplicate a line (once live, once replayed) but never drops one. The API layer's logsSSE deliberately attaches Recent-then-Subscribe instead, accepting a reconnect-healed gap window for a dedup-free wire — see its doc for that tradeoff.`

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/engine/ ./internal/store/ ./internal/events/ -race -count=1`
Expected: PASS (new cases + all M2 cases — in particular the timetravel-facing tests still pass: the LSN happy path always carried both fields).

- [ ] **Step 4: Commit**

```bash
cd ~/git/worktreedb && git add internal/engine/ internal/store/operations.go internal/events/loghub.go && git commit -m "fix(engine): strict LSN/detach decode, capped error display, body-read errors"
```

---

### Task 12: mcp — Host/Origin guard, SDK server, transport mount

The milestone's ONE new dependency lands here: `github.com/modelcontextprotocol/go-sdk@v1.6.1`. The guard is hand-rolled and wraps the SDK handler — mounted AS the `/mcp` route handler, so it runs iff the router dispatched there (the percent-encoded-path bypass class is structurally dead; a regression test pins it anyway). Fail-closed on every ambiguous case: missing/malformed Host, duplicate Origin lines, malformed Origin, authority carrying userinfo. Matching is HOSTNAME-ONLY (port-agnostic — the container's internal 4400 is never the port a client dials through) with lowercase + trailing-dot canonicalization; operator entries accept either bare hostnames or `host:port` forms.

**Files:**
- Modify: `~/git/worktreedb/go.mod` / `go.sum` (via `go get`)
- Modify: `~/git/worktreedb/AGENTS.md` (dependency allowlist entry)
- Create: `~/git/worktreedb/internal/mcp/guard.go`
- Create: `~/git/worktreedb/internal/mcp/server.go`
- Create: `~/git/worktreedb/internal/mcp/guard_test.go`
- Create: `~/git/worktreedb/internal/mcp/server_test.go`

**Interfaces:**
- Consumes: Task 1 `Config.MCPAllowedHosts/MCPAllowedOrigins`; the go-sdk (`mcp.NewServer`, `mcp.NewStreamableHTTPHandler`, `mcp.ServerOptions`, `mcp.StreamableHTTPOptions`).
- Produces:
  - `type Deps struct { Version string; Engine StatusSource; Core CoreAPI; Builds BuildsAPI; AllowedHosts, AllowedOrigins []string; Log *slog.Logger }` (`StatusSource`/`CoreAPI`/`BuildsAPI` defined in Tasks 13–14; for THIS task declare `Deps` with only `Version`, `AllowedHosts`, `AllowedOrigins`, `Log` — Tasks 13/14 extend it)
  - `func NewHandler(d Deps) (http.Handler, func())` — the GUARDED streamable handler plus a `closeSessions` func for shutdown
  - `func guard(allowedHosts, allowedOrigins []string, next http.Handler) http.Handler` (unexported; unit-tested directly)
  - `const Instructions` — the initialize instructions (MUST contain the phrase `branch per task`)

- [ ] **Step 1: Add the dependency**

```bash
cd ~/git/worktreedb && go get github.com/modelcontextprotocol/go-sdk@v1.6.1
```

Expected: `go: added github.com/modelcontextprotocol/go-sdk v1.6.1` (plus `github.com/google/jsonschema-go` and `github.com/yosida95/uritemplate/v3` as indirects). NO `go mod tidy`. Then add to AGENTS.md's dependency allowlist section, matching its existing entry format:

```markdown
- `github.com/modelcontextprotocol/go-sdk` v1.6.1 — the official MCP SDK: streamable-HTTP transport with stateful sessions, typed tool registration, per-session client info. Hand-rolling a protocol client here would be inventing wire payloads.
```

- [ ] **Step 2: Write the failing guard tests** — `internal/mcp/guard_test.go`:

```go
package mcp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func guardedMux(hosts, origins []string) (*http.ServeMux, *bool) {
	hit := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(200)
	})
	mux := http.NewServeMux()
	mux.Handle("/mcp", guard(hosts, origins, inner))
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	return mux, &hit
}

func doReq(t *testing.T, mux *http.ServeMux, path, host, origin string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
	if host != "" {
		req.Host = host
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestGuardAllowsLoopbackFamilyAnyPort(t *testing.T) {
	mux, hit := guardedMux(nil, nil)
	for _, host := range []string{"localhost:4400", "localhost:59999", "127.0.0.1:8080", "[::1]:4400", "host.docker.internal:4400", "LOCALHOST.", "localhost"} {
		*hit = false
		rec := doReq(t, mux, "/mcp", host, "")
		if rec.Code != 200 || !*hit {
			t.Fatalf("host %q: code=%d hit=%v", host, rec.Code, *hit)
		}
	}
}

func TestGuardRejectsUntrustedAndMalformedHosts(t *testing.T) {
	mux, hit := guardedMux(nil, nil)
	for _, host := range []string{"evil.example.com", "evil.example.com:4400", "localhost:bad", "evil.com@localhost", "localhost, evil.com"} {
		*hit = false
		rec := doReq(t, mux, "/mcp", host, "")
		if rec.Code != 403 || *hit {
			t.Fatalf("host %q must 403 without reaching the handler: code=%d hit=%v", host, rec.Code, *hit)
		}
		if !strings.Contains(rec.Body.String(), "WORKTREEDB_MCP_ALLOWED_HOSTS") {
			t.Fatalf("remediation must name the env var: %s", rec.Body.String())
		}
	}
	// Empty Host (Go only leaves r.Host empty for pathological requests) fails closed.
	*hit = false
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Host = ""
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 403 || *hit {
		t.Fatalf("empty host: code=%d hit=%v", rec.Code, *hit)
	}
}

func TestGuardOperatorAllowlists(t *testing.T) {
	mux, hit := guardedMux([]string{"db.internal:4400"}, []string{"http://app.internal:3000"})
	// Hostname-canonical comparison: the port in the entry is ignored, and
	// either bare or ported request forms match.
	for _, host := range []string{"db.internal", "db.internal:9999", "DB.INTERNAL.:4400"} {
		*hit = false
		if rec := doReq(t, mux, "/mcp", host, ""); rec.Code != 200 || !*hit {
			t.Fatalf("allowlisted host %q: %d", host, rec.Code)
		}
	}
	if rec := doReq(t, mux, "/mcp", "other.internal", ""); rec.Code != 403 {
		t.Fatalf("non-allowlisted host: %d", rec.Code)
	}
	// Origin: present must resolve to an allowed hostname; absent is fine.
	if rec := doReq(t, mux, "/mcp", "localhost:4400", "http://app.internal:9999"); rec.Code != 200 {
		t.Fatalf("allowlisted origin any port: %d", rec.Code)
	}
	rec := doReq(t, mux, "/mcp", "localhost:4400", "http://evil.example.com")
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "WORKTREEDB_MCP_ALLOWED_ORIGINS") {
		t.Fatalf("untrusted origin: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, mux, "/mcp", "localhost:4400", "not a url"); rec.Code != 403 {
		t.Fatalf("malformed origin must fail closed: %d", rec.Code)
	}
}

func TestGuardRejectsDuplicateOriginLines(t *testing.T) {
	mux, hit := guardedMux(nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Host = "localhost:4400"
	req.Header["Origin"] = []string{"http://localhost:4400", "http://localhost:4400"}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 403 || *hit || !strings.Contains(rec.Body.String(), "duplicate Origin header is not allowed") {
		t.Fatalf("duplicate origin: %d %v %s", rec.Code, *hit, rec.Body.String())
	}
}

// The bypass regression: Go's ServeMux routes percent-encoded paths to the
// /mcp pattern (empirically verified during planning). Because the guard IS
// the route handler, an encoded path either reaches the guard (403 on an
// evil Host) or misses the route entirely — it can never reach the SDK
// handler unguarded.
func TestGuardCoversPercentEncodedPaths(t *testing.T) {
	mux, hit := guardedMux(nil, nil)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	for _, path := range []string{"/%6dcp", "/m%63p", "/mc%70"} {
		*hit = false
		req, err := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		req.Host = "evil.example.com"
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if *hit {
			t.Fatalf("path %s reached the handler unguarded", path)
		}
		if res.StatusCode != 403 && res.StatusCode != 404 {
			t.Fatalf("path %s: %d (want guarded 403 or unrouted 404)", path, res.StatusCode)
		}
	}
	// And the loopback family still gets through those same encodings.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/%6dcp", strings.NewReader("{}"))
	res, err := http.DefaultClient.Do(req) // Host defaults to the test server's 127.0.0.1
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == 403 {
		t.Fatal("loopback caller must not be rejected on an encoded path")
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -count=1`
Expected: FAIL — `undefined: guard` (package doesn't compile yet).

- [ ] **Step 4: Implement the guard** — `internal/mcp/guard.go`:

```go
// Package mcp serves the Model Context Protocol surface: a streamable-HTTP
// server with stateful sessions behind a DNS-rebinding guard, and the tool
// set agents drive branches and builds with.
package mcp

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

// Well-known loopback/container-gateway hostnames this daemon is
// legitimately reachable under, matched on HOSTNAME ALONE (port-agnostic —
// the container's internal HTTP port is never the port a real client dials
// through; port numbers carry no bearing on whether a request originated
// same-machine vs from a rebound DNS name). url.URL.Hostname() strips IPv6
// brackets, so "::1" is stored unbracketed.
var trustedLoopbackHostnames = map[string]bool{
	"localhost": true, "127.0.0.1": true, "::1": true, "host.docker.internal": true,
}

// canonicalHostname extracts and canonicalizes a hostname from a raw HTTP
// authority ("host[:port]"): parse via a scheme-prefixed URL (the standard
// robust way — IPv6 brackets and port validation come for free), reject any
// authority carrying userinfo (a Host of "evil.com@localhost" would
// otherwise canonicalize to the innocuous "localhost" with the "evil.com"
// silently dropped), lowercase, strip one trailing root-zone dot. Returns ""
// on ANY parse failure — callers treat "" as reject (fail CLOSED).
func canonicalHostname(authority string) string {
	u, err := url.Parse("http://" + authority)
	if err != nil || u.User != nil {
		return ""
	}
	hostname := strings.ToLower(u.Hostname())
	if len(hostname) > 1 && strings.HasSuffix(hostname, ".") {
		hostname = hostname[:len(hostname)-1]
	}
	return hostname
}

// canonicalOriginHostname: Origin values are FULL origins ("http://host:port"),
// so parse directly (no scheme prefixing), then the same canonicalization.
func canonicalOriginHostname(origin string) string {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	hostname := strings.ToLower(u.Hostname())
	if len(hostname) > 1 && strings.HasSuffix(hostname, ".") {
		hostname = hostname[:len(hostname)-1]
	}
	return hostname
}

func hostAllowed(hostname string, allowed []string) bool {
	if trustedLoopbackHostnames[hostname] {
		return true
	}
	for _, entry := range allowed {
		if canonicalHostname(entry) == hostname {
			return true
		}
	}
	return false
}

func originAllowed(origin string, allowed []string) bool {
	hostname := canonicalOriginHostname(origin)
	if hostname == "" {
		return false // malformed Origin is never legitimate — fail closed
	}
	if trustedLoopbackHostnames[hostname] {
		return true
	}
	for _, entry := range allowed {
		if canonicalOriginHostname(entry) == hostname {
			return true
		}
	}
	return false
}

func reject(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// guard is the DNS-rebinding protection for the MCP endpoint — the one
// route on this daemon a browser tab can be lured into driving
// (streamable-HTTP is page-navigable; the REST routes are plain fetch/curl
// targets). It wraps the handler and is MOUNTED AS the /mcp route, so it
// runs exactly when the router dispatched here — however the wire path was
// percent-encoded — and fails CLOSED on every ambiguous case:
//   - missing or unparseable Host → 403 (a same-origin browser request
//     always carries one; Go's HTTP server itself already rejects requests
//     with duplicate Host lines before any handler runs);
//   - duplicate Origin lines → 403 (never legitimate; classic
//     header-smuggling shape — reject rather than pick a value);
//   - a PRESENT Origin must resolve to an allowed hostname; absent Origin
//     is fine (curl and non-browser MCP clients send none).
func guard(allowedHosts, allowedOrigins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostname := ""
		if r.Host != "" {
			hostname = canonicalHostname(r.Host)
		}
		if hostname == "" || !hostAllowed(hostname, allowedHosts) {
			reject(w, "Host "+quote(r.Host)+" is not allowed — set WORKTREEDB_MCP_ALLOWED_HOSTS to permit it")
			return
		}
		origins := r.Header.Values("Origin")
		if len(origins) > 1 {
			reject(w, "duplicate Origin header is not allowed")
			return
		}
		if len(origins) == 1 && !originAllowed(origins[0], allowedOrigins) {
			reject(w, "Origin "+quote(origins[0])+" is not allowed — set WORKTREEDB_MCP_ALLOWED_ORIGINS to permit it")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// quote renders %q (JSON string quoting matches Go's %q for these values —
// the message embeds the rejected header verbatim, safely escaped).
func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
```

- [ ] **Step 5: Implement the server + handler** — `internal/mcp/server.go`:

```go
package mcp

import (
	"log/slog"
	"net/http"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Instructions surfaces the branch-per-task discipline in the initialize
// response, so agents get it even with zero skills installed.
const Instructions = `Worktree DB gives each agent an isolated, writable copy of a database — worktree : files :: branch : data.

Workflow:
- Create one branch per task off ` + "`main`" + `: create_branch with name "agent/<task-slug>" and a fork context
  (git_branch, workdir, purpose). It auto-starts an endpoint and returns a connection string.
- Wire that connection string into your worktree's environment. Work destructively — main is untouched.
- Never share one branch between concurrent agents. Use get_branch to re-fetch a connection string.
- reset_branch to scrap changes and match the parent again; restore_branch to recover a past point.
- delete_branch when the task is done.

Always pass fork context on create_branch so a human can tell parallel agents' branches apart.`

// sessionIdleTimeout evicts sessions with no HTTP activity — the SDK closes
// them server-side (StreamableHTTPOptions.SessionTimeout).
const sessionIdleTimeout = 10 * time.Minute

type Deps struct {
	Version        string
	AllowedHosts   []string
	AllowedOrigins []string
	Log            *slog.Logger
	// Engine/Core/Builds join in the tool tasks.
}

// NewHandler builds the guarded MCP endpoint: ONE sdk.Server shared across
// sessions (per-session state — including each session's initialize
// clientInfo — lives on the SDK's ServerSession, reached through every tool
// request), served by the stateful streamable-HTTP handler, wrapped in the
// DNS-rebinding guard. The returned close func drains every live session
// (shutdown wiring).
func NewHandler(d Deps) (http.Handler, func()) {
	server := sdk.NewServer(
		&sdk.Implementation{Name: "worktreedb", Version: d.Version},
		&sdk.ServerOptions{Instructions: Instructions, Logger: d.Log},
	)
	registerTools(server, d)
	handler := sdk.NewStreamableHTTPHandler(
		func(*http.Request) *sdk.Server { return server },
		&sdk.StreamableHTTPOptions{
			SessionTimeout: sessionIdleTimeout,
			// Our guard is a strict superset of the SDK's built-in localhost
			// protection (fail-closed on missing Host and duplicate Origin,
			// operator allowlists, host.docker.internal trusted) — running
			// both would 403 legitimate loopback requests carrying the
			// docker-gateway Host name.
			DisableLocalhostProtection: true,
			Logger:                     d.Log,
		},
	)
	closeSessions := func() {
		for ss := range server.Sessions() {
			_ = ss.Close()
		}
	}
	return guard(d.AllowedHosts, d.AllowedOrigins, handler), closeSessions
}
```

and a placeholder `registerTools` so this task compiles standalone — in `internal/mcp/server.go` (Task 13 REPLACES this with the real registration in tools_read.go; the placeholder must not survive past Task 13):

```go
// registerTools attaches the tool surface (tools_read.go / tools_mutate.go).
func registerTools(server *sdk.Server, d Deps) {}
```

- [ ] **Step 6: Write the failing handshake test** — `internal/mcp/server_test.go`:

```go
package mcp

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestInitializeCarriesInstructionsAndIdentity(t *testing.T) {
	handler, closeSessions := NewHandler(Deps{Version: "0.3.0", Log: slog.New(slog.DiscardHandler)})
	defer closeSessions()
	srv := httptest.NewServer(handler)
	defer srv.Close()

	client := sdk.NewClient(&sdk.Implementation{Name: "probe", Version: "1.0.0"}, nil)
	session, err := client.Connect(context.Background(),
		&sdk.StreamableClientTransport{Endpoint: srv.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	res := session.InitializeResult()
	if res == nil || !strings.Contains(res.Instructions, "branch per task") {
		t.Fatalf("instructions must carry the discipline phrase: %+v", res)
	}
	if res.ServerInfo == nil || res.ServerInfo.Name != "worktreedb" || res.ServerInfo.Version != "0.3.0" {
		t.Fatalf("server identity: %+v", res.ServerInfo)
	}
}
```

(SDK spellings pre-verified against v1.6.1 during planning: `StreamableClientTransport{Endpoint: string}`, `Client.Connect(ctx, transport, nil) (*ClientSession, error)`, `ClientSession.InitializeResult() *InitializeResult` with `Instructions string` + `ServerInfo *Implementation`, `ClientSession.ListTools(ctx, *ListToolsParams)`, `ClientSession.CallTool(ctx, *CallToolParams) (*CallToolResult, error)`, `TextContent{Text string}` — transcribe as written.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -race -count=1`
Expected: PASS (guard suite + handshake).

- [ ] **Step 8: Lint and commit**

Run: `cd ~/git/worktreedb && golangci-lint run ./internal/mcp/`
Expected: 0 issues.

```bash
cd ~/git/worktreedb && git add go.mod go.sum AGENTS.md internal/mcp/ && git commit -m "feat(mcp): streamable-HTTP server behind a fail-closed Host/Origin guard"
```

---

### Task 13: mcp — format helpers + the five read tools

`format.go` (text/error results, the context line, ISO timestamps), the renderers (branch line with fork label + context JSON + connection string; the branch TREE walk; the per-major build block), and the read tools: `get_status`, `list_projects`, `create_project`, `list_branches`, `get_branch`. Every handler goes through `guardTool`: a `*service.Error` surfaces verbatim as an `IsError` result (service messages are already caller-actionable); anything else is a BUG — logged with the real error, the caller gets the constant `internal error — check the daemon logs`.

**Files:**
- Create: `~/git/worktreedb/internal/mcp/format.go`
- Create: `~/git/worktreedb/internal/mcp/tools_read.go`
- Create: `~/git/worktreedb/internal/mcp/tools_test.go`
- Modify: `~/git/worktreedb/internal/mcp/server.go` (drop the placeholder `registerTools`; it moves to tools_read.go)

**Interfaces:**
- Consumes: Task 12 `Deps`/`NewHandler`; Task 9 `service.Core` methods (`ProjectByNameOr404`, `BranchByProjectAndNameOr404`, `Projects`, `CreateProject`, `BranchesByProject`, `BranchDetail`, `EnsureRunning`); `api`-equivalent DTO fields via `service.BranchDetail`.
- Produces (Task 14 relies on these):
  - `Deps` extended: `Engine StatusSource; Core CoreAPI; Builds BuildsAPI` where
    - `type StatusSource interface{ Status() map[string]engine.Component }`
    - `type CoreAPI interface { Projects(ctx context.Context) ([]store.ProjectRow, error); CreateProject(ctx context.Context, name string, pgVersion *int) (store.ProjectRow, service.BranchDetail, error); ProjectByNameOr404(ctx context.Context, name string) (store.ProjectRow, error); BranchByProjectAndNameOr404(ctx context.Context, projectID, name string) (store.BranchRow, error); BranchesByProject(ctx context.Context, projectID string) ([]service.BranchDetail, error); BranchDetail(ctx context.Context, branchID string) (service.BranchDetail, error); EnsureRunning(ctx context.Context, branchID string) (service.BranchDetail, error); StopEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error); DeleteBranch(ctx context.Context, branchID string) error; CreateBranch(ctx context.Context, p service.CreateBranchParams) (service.BranchDetail, error); LsnAtTimestamp(ctx context.Context, branchID, isoTimestamp string) (string, error); ResetToParent(ctx context.Context, branchID string) (service.BranchDetail, error); RestoreInPlace(ctx context.Context, branchID, to string) (service.BranchDetail, error); BranchAtTimestamp(ctx context.Context, p service.BranchAtParams) (service.BranchDetail, error) }`
    - `type BuildsAPI interface { List(ctx context.Context) ([]builds.Row, error); Check(ctx context.Context, majors []int) (map[string]builds.CheckResult, error); Pull(ctx context.Context, major int, tag string) (string, error); Activate(ctx context.Context, id string, consented bool) (builds.Row, error); InstalledMajors(ctx context.Context) []int; DegradedMajors() []int; UpdateAvailableFor(major int) *string; LastRunMinor(ctx context.Context, major int) (*int, error) }` (NO Remove — deletion stays REST/UI-only by decision)
  - `func textResult(s string) *sdk.CallToolResult` · `func errorResult(remediation string) *sdk.CallToolResult` · `func contextLine(project, branch, parent string) string` (`[worktreedb] project "%s"` + optional ` · branch "%s"` + optional ` (forked from "%s")`) · `func nowISO() string`
  - `func renderBranch(d service.BranchDetail, depth int, parentName string) string` · `func renderBranchTree(list []service.BranchDetail) string`
  - `func clientInfoOf(req *sdk.CallToolRequest) *clientInfo` with `type clientInfo struct { Name string `json:"name"`; Version string `json:"version"` }` (nil when the session skipped a proper initialize)
  - `func guardTool[In any](name string, d Deps, fn func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, error)) sdk.ToolHandlerFor[In, any]`
  - `registerTools(server *sdk.Server, d Deps)` registering (this task) `get_status, list_projects, create_project, list_branches, get_branch` and calling `registerMutateTools(server, d)` (Task 14; declare it as an empty func in tools_read.go for now — Task 14 moves it to tools_mutate.go)

- [ ] **Step 1: Write the failing tests** — `internal/mcp/tools_test.go`. These drive the REAL SDK end-to-end over httptest (fake Core/Builds), so tool names, schemas, session capture, and text contracts are all pinned at the protocol level:

```go
package mcp

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/VanGoghSoftware/worktreedb/internal/builds"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// --- fakes ---------------------------------------------------------------

type fakeEngine struct{}

func (fakeEngine) Status() map[string]engine.Component {
	return map[string]engine.Component{
		"pageserver": {State: engine.StateRunning, PID: intp(41)},
	}
}

func intp(v int) *int { return &v }

func strp(v string) *string { return &v }

type fakeCore struct {
	projects map[string]store.ProjectRow            // by name
	branches map[string]map[string]service.BranchDetail // project id → branch name → detail
	calls    []string
	createBranchParams *service.CreateBranchParams
	failStart error
}

func newFakeCore() *fakeCore {
	cs := "postgresql://postgres:PW@127.0.0.1:54301/postgres"
	main := service.BranchDetail{
		Row: store.BranchRow{ID: "b-main", ProjectID: "p1", Name: "main", Slug: "shop-main-abc123",
			TimelineID: "tl1", CreatedBy: "api", StatusEndpoint: "running", CreatedAt: "2026-07-12T00:00:00Z", UpdatedAt: "2026-07-12T00:00:00Z"},
		ConnectionString: &cs,
	}
	return &fakeCore{
		projects: map[string]store.ProjectRow{"shop": {ID: "p1", Name: "shop", PgMajor: 17, CreatedAt: "2026-07-12T00:00:00Z"}},
		branches: map[string]map[string]service.BranchDetail{"p1": {"main": main}},
	}
}

func (f *fakeCore) Projects(context.Context) ([]store.ProjectRow, error) {
	var out []store.ProjectRow
	for _, p := range f.projects {
		out = append(out, p)
	}
	return out, nil
}

func (f *fakeCore) CreateProject(_ context.Context, name string, _ *int) (store.ProjectRow, service.BranchDetail, error) {
	p := store.ProjectRow{ID: "p-" + name, Name: name, PgMajor: 17}
	f.projects[name] = p
	main := service.BranchDetail{Row: store.BranchRow{ID: "b-" + name, ProjectID: p.ID, Name: "main"}}
	f.branches[p.ID] = map[string]service.BranchDetail{"main": main}
	return p, main, nil
}

func (f *fakeCore) ProjectByNameOr404(_ context.Context, name string) (store.ProjectRow, error) {
	p, ok := f.projects[name]
	if !ok {
		return store.ProjectRow{}, service.Errf(404, "project %s not found", name)
	}
	return p, nil
}

func (f *fakeCore) BranchByProjectAndNameOr404(_ context.Context, projectID, name string) (store.BranchRow, error) {
	d, ok := f.branches[projectID][name]
	if !ok {
		return store.BranchRow{}, service.Errf(404, "branch %s not found", name)
	}
	return d.Row, nil
}

func (f *fakeCore) BranchesByProject(_ context.Context, projectID string) ([]service.BranchDetail, error) {
	var out []service.BranchDetail
	for _, d := range f.branches[projectID] {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Row.Name < out[j].Row.Name })
	return out, nil
}

func (f *fakeCore) BranchDetail(_ context.Context, branchID string) (service.BranchDetail, error) {
	for _, byName := range f.branches {
		for _, d := range byName {
			if d.Row.ID == branchID {
				return d, nil
			}
		}
	}
	return service.BranchDetail{}, service.Errf(404, "branch %s not found", branchID)
}

func (f *fakeCore) EnsureRunning(ctx context.Context, branchID string) (service.BranchDetail, error) {
	f.calls = append(f.calls, "ensure:"+branchID)
	if f.failStart != nil {
		return service.BranchDetail{}, f.failStart
	}
	d, err := f.BranchDetail(ctx, branchID)
	if err != nil {
		return d, err
	}
	if d.ConnectionString == nil {
		cs := "postgresql://postgres:PW@127.0.0.1:54302/postgres"
		d.ConnectionString = &cs
		d.Row.StatusEndpoint = "running"
		f.branches[d.Row.ProjectID][d.Row.Name] = d
	}
	return d, nil
}

func (f *fakeCore) StopEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error) {
	d, err := f.BranchDetail(ctx, branchID)
	if err == nil {
		d.Row.StatusEndpoint = "stopped"
		d.ConnectionString = nil
	}
	return d, err
}

func (f *fakeCore) DeleteBranch(_ context.Context, branchID string) error {
	for pid, byName := range f.branches {
		for name, d := range byName {
			if d.Row.ID == branchID {
				delete(f.branches[pid], name)
				return nil
			}
		}
	}
	return service.Errf(404, "branch %s not found", branchID)
}

func (f *fakeCore) CreateBranch(_ context.Context, p service.CreateBranchParams) (service.BranchDetail, error) {
	f.createBranchParams = &p
	d := service.BranchDetail{Row: store.BranchRow{ID: "b-new", ProjectID: p.ProjectID, Name: p.Name,
		ParentBranchID: strp("b-main"), CreatedBy: p.CreatedBy, ContextJSON: p.ContextJSON}}
	f.branches[p.ProjectID][p.Name] = d
	return d, nil
}

func (f *fakeCore) LsnAtTimestamp(context.Context, string, string) (string, error) { return "0/1234", nil }

func (f *fakeCore) ResetToParent(ctx context.Context, branchID string) (service.BranchDetail, error) {
	return f.EnsureRunning(ctx, branchID)
}

func (f *fakeCore) RestoreInPlace(ctx context.Context, branchID, _ string) (service.BranchDetail, error) {
	return f.BranchDetail(ctx, branchID)
}

func (f *fakeCore) BranchAtTimestamp(_ context.Context, p service.BranchAtParams) (service.BranchDetail, error) {
	d := service.BranchDetail{Row: store.BranchRow{ID: "b-restored", ProjectID: p.ProjectID, Name: p.Name,
		CreatedBy: p.CreatedBy, ContextJSON: p.ContextJSON}}
	f.branches[p.ProjectID][p.Name] = d
	return d, nil
}

type fakeBuilds struct {
	rows     []builds.Row
	lastRun  map[int]int
	pulled   []string
	activated []string
}

func (f *fakeBuilds) List(context.Context) ([]builds.Row, error) { return f.rows, nil }
func (f *fakeBuilds) Check(_ context.Context, majors []int) (map[string]builds.CheckResult, error) {
	out := map[string]builds.CheckResult{}
	for _, m := range majors {
		out[itoa(m)] = builds.CheckResult{Tag: "latest", Digest: "sha256:" + strings.Repeat("a", 64), State: "unverified", IsNew: true, At: "2026-07-12T00:00:00Z"}
	}
	return out, nil
}
func (f *fakeBuilds) Pull(_ context.Context, major int, tag string) (string, error) {
	f.pulled = append(f.pulled, itoa(major)+":"+tag)
	return "build-123", nil
}
func (f *fakeBuilds) Activate(_ context.Context, id string, consented bool) (builds.Row, error) {
	f.activated = append(f.activated, id)
	for _, r := range f.rows {
		if r.ID == id {
			r.Active = true
			return r, nil
		}
	}
	return builds.Row{}, service.Errf(404, "no such build: %s", id)
}
func (f *fakeBuilds) InstalledMajors(context.Context) []int { return []int{17} }
func (f *fakeBuilds) DegradedMajors() []int                 { return nil }
func (f *fakeBuilds) UpdateAvailableFor(int) *string        { return nil }
func (f *fakeBuilds) LastRunMinor(_ context.Context, major int) (*int, error) {
	if f.lastRun == nil {
		return nil, nil
	}
	if v, ok := f.lastRun[major]; ok {
		return &v, nil
	}
	return nil, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// --- harness ---------------------------------------------------------------

type harness struct {
	core    *fakeCore
	builds  *fakeBuilds
	session *sdk.ClientSession
}

func newHarness(t *testing.T, clientName string) *harness {
	t.Helper()
	core := newFakeCore()
	fb := &fakeBuilds{}
	handler, closeSessions := NewHandler(Deps{
		Version: "0.3.0", Engine: fakeEngine{}, Core: core, Builds: fb,
		Log: slog.New(slog.DiscardHandler),
	})
	t.Cleanup(closeSessions)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	client := sdk.NewClient(&sdk.Implementation{Name: clientName, Version: "1.0.0"}, nil)
	session, err := client.Connect(context.Background(), &sdk.StreamableClientTransport{Endpoint: srv.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return &harness{core: core, builds: fb, session: session}
}

func (h *harness) call(t *testing.T, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := h.session.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%s): %v", name, err)
	}
	if len(res.Content) == 0 {
		t.Fatalf("CallTool(%s): empty content", name)
	}
	text, ok := res.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("CallTool(%s): non-text content %T", name, res.Content[0])
	}
	return text.Text, res.IsError
}

// --- read tools ---------------------------------------------------------------
// (The 14-tool-name contract test lands in Task 14, once the full surface is
// registered — a plan task never commits a deliberately red test.)

func TestGetStatusAndListProjects(t *testing.T) {
	h := newHarness(t, "probe")
	text, isErr := h.call(t, "get_status", nil)
	if isErr || !strings.Contains(text, "[worktreedb] status as of") ||
		!strings.Contains(text, "healthy: true") || !strings.Contains(text, "pageserver: running (pid 41)") {
		t.Fatalf("get_status: %q (err=%v)", text, isErr)
	}
	text, isErr = h.call(t, "list_projects", nil)
	if isErr || !strings.Contains(text, "1 project(s)") || !strings.Contains(text, "shop (pg17)") {
		t.Fatalf("list_projects: %q", text)
	}
}

func TestGetBranchStartsByDefaultAndEmbedsConnString(t *testing.T) {
	h := newHarness(t, "probe")
	text, isErr := h.call(t, "get_branch", map[string]any{"project": "shop", "branch": "main"})
	if isErr {
		t.Fatalf("get_branch errored: %q", text)
	}
	if !strings.Contains(text, "postgresql://") {
		t.Fatalf("connection string must be embedded: %q", text)
	}
	if len(h.core.calls) == 0 || h.core.calls[0] != "ensure:b-main" {
		t.Fatalf("ensure_running must default TRUE: %v", h.core.calls)
	}
	// ensure_running=false must not start.
	h.core.calls = nil
	if _, isErr := h.call(t, "get_branch", map[string]any{"project": "shop", "branch": "main", "ensure_running": false}); isErr {
		t.Fatal("get_branch ensure_running=false errored")
	}
	if len(h.core.calls) != 0 {
		t.Fatalf("ensure_running=false must not start: %v", h.core.calls)
	}
	// Unknown branch surfaces the service 404 verbatim as an error result.
	text, isErr = h.call(t, "get_branch", map[string]any{"project": "shop", "branch": "nope"})
	if !isErr || !strings.Contains(text, "branch nope not found") {
		t.Fatalf("service error passthrough: %q (err=%v)", text, isErr)
	}
}

func TestListBranchesRendersTreeWithContext(t *testing.T) {
	h := newHarness(t, "acceptance")
	ctxJSON := `{"purpose":"destructive test","client":{"name":"acceptance","version":"1.0.0"}}`
	h.core.branches["p1"]["agent/mutate"] = service.BranchDetail{
		Row: store.BranchRow{ID: "b-agent", ProjectID: "p1", Name: "agent/mutate",
			ParentBranchID: strp("b-main"), CreatedBy: "mcp", ContextJSON: &ctxJSON,
			StatusEndpoint: "stopped"},
	}
	text, isErr := h.call(t, "list_branches", map[string]any{"project": "shop"})
	if isErr {
		t.Fatalf("list_branches: %q", text)
	}
	for _, needle := range []string{
		`[worktreedb] project "shop"`, "2 branch(es):",
		`agent/mutate (from "main")`, "destructive test", "acceptance", "(endpoint stopped)",
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("list_branches missing %q:\n%s", needle, text)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -count=1`
Expected: FAIL — `Deps` has no `Engine`/`Core`/`Builds` fields (compile error).

- [ ] **Step 3: Implement format helpers** — `internal/mcp/format.go`:

```go
package mcp

import (
	"context"
	"fmt"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/VanGoghSoftware/worktreedb/internal/service"
)

// The response contract: every success is actionable text opening with a
// context line naming the project/branch acted on (plus parent for forks),
// includes the connection string when relevant and a next-step hint; every
// error names its remediation.

func textResult(s string) *sdk.CallToolResult {
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: s}}}
}

func errorResult(remediation string) *sdk.CallToolResult {
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: remediation}}, IsError: true}
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func contextLine(project, branch, parent string) string {
	s := fmt.Sprintf("[worktreedb] project %q", project)
	if branch != "" {
		s += fmt.Sprintf(" · branch %q", branch)
	}
	if parent != "" {
		s += fmt.Sprintf(" (forked from %q)", parent)
	}
	return s
}

// renderBranch: one branch line — indentation nests generations, the fork
// label names the parent outright (an agent must never count whitespace to
// know whose fork a branch is), the context JSON and connection string ride
// on their own sublines.
func renderBranch(d service.BranchDetail, depth int, parentName string) string {
	indent := ""
	for i := 0; i < depth+1; i++ {
		indent += "  "
	}
	fork := ""
	if parentName != "" {
		fork = fmt.Sprintf(" (from %q)", parentName)
	}
	conn := "\n" + indent + "  (endpoint stopped)"
	if d.ConnectionString != nil {
		conn = "\n" + indent + "  connection: " + *d.ConnectionString
	}
	ctx := ""
	if d.Row.ContextJSON != nil {
		ctx = "\n" + indent + "  fork: " + *d.Row.ContextJSON
	}
	return fmt.Sprintf("%s%s%s [%s] created_by=%s%s%s",
		indent, d.Row.Name, fork, d.Row.StatusEndpoint, d.Row.CreatedBy, ctx, conn)
}

// renderBranchTree renders the branch TREE (roots first, each followed by
// its whole lineage) — a flat list loses ancestry the moment more than one
// non-main branch exists. A parent id that doesn't resolve within this list
// falls back to rendering that branch as a root: never drop a branch over a
// data inconsistency.
func renderBranchTree(list []service.BranchDetail) string {
	byID := map[string]service.BranchDetail{}
	for _, d := range list {
		byID[d.Row.ID] = d
	}
	children := map[string][]service.BranchDetail{}
	var roots []service.BranchDetail
	for _, d := range list {
		if d.Row.ParentBranchID != nil {
			if _, ok := byID[*d.Row.ParentBranchID]; ok {
				children[*d.Row.ParentBranchID] = append(children[*d.Row.ParentBranchID], d)
				continue
			}
		}
		roots = append(roots, d)
	}
	var lines []string
	var walk func(d service.BranchDetail, depth int, parentName string)
	walk = func(d service.BranchDetail, depth int, parentName string) {
		lines = append(lines, renderBranch(d, depth, parentName))
		for _, child := range children[d.Row.ID] {
			walk(child, depth+1, d.Row.Name)
		}
	}
	for _, root := range roots {
		walk(root, 0, "")
	}
	out := ""
	for i, l := range lines {
		if i > 0 {
			out += "\n"
		}
		out += l
	}
	return out
}

// clientInfo is the session-captured client identity merged into fork
// contexts as `client` — never caller-supplied.
type clientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// clientInfoOf reads the CONNECTED session's initialize clientInfo. nil when
// the session skipped a proper initialize — callers omit `client` then
// rather than fail.
func clientInfoOf(req *sdk.CallToolRequest) *clientInfo {
	if req == nil || req.Session == nil {
		return nil
	}
	params := req.Session.InitializeParams()
	if params == nil || params.ClientInfo == nil {
		return nil
	}
	return &clientInfo{Name: params.ClientInfo.Name, Version: params.ClientInfo.Version}
}

// guardTool wraps every handler: a *service.Error is a DELIBERATE,
// caller-actionable failure — surfaced verbatim as an IsError result;
// anything else is a BUG whose raw message must not reach the caller — it is
// logged (with the real error) and the caller gets a constant remediation.
// Handlers therefore never return protocol-level errors.
func guardTool[In any](name string, d Deps, fn func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, error)) func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, any, error) {
	return func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, any, error) {
		res, err := fn(ctx, req, in)
		if err == nil {
			return res, nil, nil
		}
		var serr *service.Error
		if asService(err, &serr) {
			return errorResult(serr.Message), nil, nil
		}
		d.Log.Error("mcp tool failed", "tool", name, "err", err)
		return errorResult("internal error — check the daemon logs"), nil, nil
	}
}

func asService(err error, target **service.Error) bool {
	for err != nil {
		if se, ok := err.(*service.Error); ok { //nolint:errorlint // manual unwrap walk
			*target = se
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
```

(`asService` may be `errors.As` — same note as Task 8; keep one shared helper if the linter prefers.)

- [ ] **Step 4: Implement the read tools** — `internal/mcp/tools_read.go` (this file now owns `registerTools`; delete the placeholder from server.go):

```go
package mcp

import (
	"context"
	"fmt"
	"sort"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/VanGoghSoftware/worktreedb/internal/builds"
	"github.com/VanGoghSoftware/worktreedb/internal/engine"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

type StatusSource interface {
	Status() map[string]engine.Component
}

// CoreAPI is the exact service surface the tools consume — *service.Core
// satisfies it; tool tests use a fake.
type CoreAPI interface {
	Projects(ctx context.Context) ([]store.ProjectRow, error)
	CreateProject(ctx context.Context, name string, pgVersion *int) (store.ProjectRow, service.BranchDetail, error)
	ProjectByNameOr404(ctx context.Context, name string) (store.ProjectRow, error)
	BranchByProjectAndNameOr404(ctx context.Context, projectID, name string) (store.BranchRow, error)
	BranchesByProject(ctx context.Context, projectID string) ([]service.BranchDetail, error)
	BranchDetail(ctx context.Context, branchID string) (service.BranchDetail, error)
	EnsureRunning(ctx context.Context, branchID string) (service.BranchDetail, error)
	StopEndpoint(ctx context.Context, branchID string) (service.BranchDetail, error)
	DeleteBranch(ctx context.Context, branchID string) error
	CreateBranch(ctx context.Context, p service.CreateBranchParams) (service.BranchDetail, error)
	LsnAtTimestamp(ctx context.Context, branchID, isoTimestamp string) (string, error)
	ResetToParent(ctx context.Context, branchID string) (service.BranchDetail, error)
	RestoreInPlace(ctx context.Context, branchID, to string) (service.BranchDetail, error)
	BranchAtTimestamp(ctx context.Context, p service.BranchAtParams) (service.BranchDetail, error)
}

// BuildsAPI: the builds surface agents may drive. Deliberately NO Remove —
// removing a build from disk is human-only (REST/UI); an agent has no MCP
// path to force it.
type BuildsAPI interface {
	List(ctx context.Context) ([]builds.Row, error)
	Check(ctx context.Context, majors []int) (map[string]builds.CheckResult, error)
	Pull(ctx context.Context, major int, tag string) (string, error)
	Activate(ctx context.Context, id string, consented bool) (builds.Row, error)
	InstalledMajors(ctx context.Context) []int
	DegradedMajors() []int
	UpdateAvailableFor(major int) *string
	LastRunMinor(ctx context.Context, major int) (*int, error)
}

func registerTools(server *sdk.Server, d Deps) {
	type empty struct{}

	sdk.AddTool(server, &sdk.Tool{
		Name:        "get_status",
		Description: "Report daemon health, version, and engine process states. Call first to confirm the daemon is reachable.",
	}, guardTool("get_status", d, func(_ context.Context, _ *sdk.CallToolRequest, _ empty) (*sdk.CallToolResult, error) {
		st := d.Engine.Status()
		healthy := true
		var names []string
		for name := range st {
			names = append(names, name)
		}
		sort.Strings(names)
		var lines []string
		for _, name := range names {
			c := st[name]
			if c.State != engine.StateRunning {
				healthy = false
			}
			pid := ""
			if c.PID != nil {
				pid = fmt.Sprintf(" (pid %d)", *c.PID)
			}
			lines = append(lines, fmt.Sprintf("  %s: %s%s", name, c.State, pid))
		}
		return textResult(fmt.Sprintf("[worktreedb] status as of %s (worktreedb v%s)\n  healthy: %v\n%s\nNext: list_projects to see what's available, or create_project to start one.",
			nowISO(), d.Version, healthy, strings.Join(lines, "\n"))), nil
	}))

	sdk.AddTool(server, &sdk.Tool{
		Name:        "list_projects",
		Description: "List every project (each with an isolated main branch). Call before create_project to avoid duplicates.",
	}, guardTool("list_projects", d, func(ctx context.Context, _ *sdk.CallToolRequest, _ empty) (*sdk.CallToolResult, error) {
		projects, err := d.Core.Projects(ctx)
		if err != nil {
			return nil, err
		}
		if len(projects) == 0 {
			return textResult("[worktreedb] no projects yet\nNext: create_project to make one."), nil
		}
		sort.Slice(projects, func(i, j int) bool { return projects[i].Name < projects[j].Name })
		var lines []string
		for _, p := range projects {
			lines = append(lines, fmt.Sprintf("  %s (pg%d)", p.Name, p.PgMajor))
		}
		return textResult(fmt.Sprintf("[worktreedb] %d project(s)\n%s\nNext: list_branches on a project, or create_project for a new one.",
			len(projects), strings.Join(lines, "\n"))), nil
	}))

	type createProjectIn struct {
		Name      string `json:"name"`
		PgVersion *int   `json:"pgVersion,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "create_project",
		Description: "Create a project — an isolated tenant with its own auto-created \"main\" branch. Each project is a separate database universe.",
	}, guardTool("create_project", d, func(ctx context.Context, _ *sdk.CallToolRequest, in createProjectIn) (*sdk.CallToolResult, error) {
		project, main, err := d.Core.CreateProject(ctx, in.Name, in.PgVersion)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("%s\n  created pg%d, main branch:\n%s\nNext: create_branch to get an isolated working copy off \"main\".",
			contextLine(project.Name, "", ""), project.PgMajor, renderBranch(main, 0, ""))), nil
	}))

	type listBranchesIn struct {
		Project string `json:"project"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "list_branches",
		Description: "List every branch in a project as a tree (name, endpoint status, who created it, fork context, and parent ancestry). Resolves the project by name.",
	}, guardTool("list_branches", d, func(ctx context.Context, _ *sdk.CallToolRequest, in listBranchesIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		list, err := d.Core.BranchesByProject(ctx, p.ID)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("%s\n  %d branch(es):\n%s\nNext: get_branch to fetch a connection string, or create_branch to fork one.",
			contextLine(p.Name, "", ""), len(list), renderBranchTree(list))), nil
	}))

	type getBranchIn struct {
		Project       string `json:"project"`
		Branch        string `json:"branch"`
		EnsureRunning *bool  `json:"ensure_running,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "get_branch",
		Description: "Fetch a branch's status + connection string (the 'switch' move). Starts the endpoint by default.",
	}, guardTool("get_branch", d, func(ctx context.Context, _ *sdk.CallToolRequest, in getBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		ensure := in.EnsureRunning == nil || *in.EnsureRunning // defaults TRUE — load-bearing
		var detail service.BranchDetail
		if ensure {
			detail, err = d.Core.EnsureRunning(ctx, b.ID)
		} else {
			detail, err = d.Core.BranchDetail(ctx, b.ID)
		}
		if err != nil {
			return nil, err
		}
		next := "Next: pass ensure_running=true (default) to start it."
		if detail.ConnectionString != nil {
			next = "Next: wire the connection string into your worktree env."
		}
		return textResult(fmt.Sprintf("%s\n%s\n%s",
			contextLine(p.Name, b.Name, ""), renderBranch(detail, 0, ""), next)), nil
	}))

	registerMutateTools(server, d)
}
```

and extend `Deps` in `server.go`:

```go
type Deps struct {
	Version        string
	Engine         StatusSource
	Core           CoreAPI
	Builds         BuildsAPI
	AllowedHosts   []string
	AllowedOrigins []string
	Log            *slog.Logger
}
```

plus a temporary `registerMutateTools` stub at the bottom of `tools_read.go` (Task 14 replaces it):

```go
// registerMutateTools attaches the mutating + build tools (tools_mutate.go).
func registerMutateTools(server *sdk.Server, d Deps) {}
```

- [ ] **Step 5: Run the read-tool tests**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -race -count=1`
Expected: PASS (guard + handshake + the four read-tool tests).

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/mcp/ && git commit -m "feat(mcp): format contract and read tools (status, projects, branches)"
```

---

### Task 14: mcp — mutating tools + build tools (the full 14-tool surface)

The nine remaining tools. Load-bearing behaviors, each pinned: `create_branch` merges the CALLER's fork context with the session-captured clientInfo (`client` is never caller-input — the input schema simply has no such field) and on endpoint-start failure reports PARTIAL SUCCESS (branch created, endpoint failed, recovery = `get_branch`/`delete_branch` — never a bare error an agent would retry into a duplicate-name 409); `restore_branch` branches on the PRESENCE of `as_new_branch` and rejects an empty/whitespace-only value BEFORE either path runs (an empty string silently falling through to the DESTRUCTIVE in-place restore is the classic footgun); `activate_pg_build` determines downgrade-ness itself (via `LastRunMinor`) and REFUSES without ever calling activate, and demands an explicit `id` when two ready builds share a major.minor; there is NO delete tool.

**Files:**
- Create: `~/git/worktreedb/internal/mcp/tools_mutate.go`
- Modify: `~/git/worktreedb/internal/mcp/tools_read.go` (delete the `registerMutateTools` stub)
- Modify: `~/git/worktreedb/internal/mcp/tools_test.go`

**Interfaces:**
- Consumes: Task 13's `Deps`, `CoreAPI`, `BuildsAPI`, format helpers, `clientInfoOf`, `guardTool`.
- Produces: the complete `registerMutateTools(server *sdk.Server, d Deps)`; tool names exactly `create_branch, stop_endpoint, delete_branch, reset_branch, restore_branch, list_pg_builds, check_pg_updates, pull_pg_build, activate_pg_build`.

- [ ] **Step 1: Write the failing tests** — append to `internal/mcp/tools_test.go`:

```go
func TestListsExactlyTheFourteenTools(t *testing.T) {
	h := newHarness(t, "probe")
	res, err := h.session.ListTools(context.Background(), &sdk.ListToolsParams{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	want := []string{
		"activate_pg_build", "check_pg_updates", "create_branch", "create_project",
		"delete_branch", "get_branch", "get_status", "list_branches", "list_pg_builds",
		"list_projects", "pull_pg_build", "reset_branch", "restore_branch", "stop_endpoint",
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v\nwant  %v", names, want)
	}
}

func TestCreateBranchCapturesSessionClient(t *testing.T) {
	h := newHarness(t, "acceptance")
	text, isErr := h.call(t, "create_branch", map[string]any{
		"project": "shop", "name": "agent/mutate",
		"context": map[string]any{"purpose": "destructive test"},
	})
	if isErr {
		t.Fatalf("create_branch: %q", text)
	}
	p := h.core.createBranchParams
	if p == nil || p.CreatedBy != "mcp" || p.ContextJSON == nil {
		t.Fatalf("params: %+v", p)
	}
	if !strings.Contains(*p.ContextJSON, `"purpose":"destructive test"`) {
		t.Fatalf("caller context lost: %s", *p.ContextJSON)
	}
	if !strings.Contains(*p.ContextJSON, `"client":{"name":"acceptance","version":"1.0.0"}`) {
		t.Fatalf("session clientInfo must be captured: %s", *p.ContextJSON)
	}
	// Success text: context line with fork parentage + connection string + next step.
	for _, needle := range []string{`[worktreedb] project "shop" · branch "agent/mutate" (forked from "main")`, "postgresql://", "Next:"} {
		if !strings.Contains(text, needle) {
			t.Fatalf("create_branch text missing %q:\n%s", needle, text)
		}
	}
}

// The spoof invariant holds regardless of how the SDK's schema validation
// treats an unknown `context.client` property (strip vs reject — both are
// spoof-safe): a spoofed client must NEVER be stored. If the call succeeds,
// the stored context carries the SESSION's client; if the schema rejected
// it, no branch was created at all.
func TestCreateBranchClientIsSpoofSafe(t *testing.T) {
	h := newHarness(t, "acceptance")
	_, isErr := h.call(t, "create_branch", map[string]any{
		"project": "shop", "name": "agent/spoof",
		"context": map[string]any{"purpose": "x", "client": map[string]any{"name": "spoofed", "version": "6.6.6"}},
	})
	p := h.core.createBranchParams
	if isErr {
		if p != nil {
			t.Fatalf("a schema-rejected call must have no side effects: %+v", p)
		}
		return // rejected outright — spoof-safe
	}
	if p == nil || p.ContextJSON == nil || strings.Contains(*p.ContextJSON, "spoofed") {
		t.Fatalf("spoofed client leaked into the stored context: %+v", p)
	}
	if !strings.Contains(*p.ContextJSON, `"client":{"name":"acceptance","version":"1.0.0"}`) {
		t.Fatalf("session clientInfo must win: %s", *p.ContextJSON)
	}
}

// The merge itself, as a pure function: the session client ALWAYS occupies
// the client slot; a nil session yields no client key at all.
func TestMergedContextJSON(t *testing.T) {
	purpose := "p"
	got := mergedContextJSON(&branchContextIn{Purpose: &purpose}, &clientInfo{Name: "a", Version: "1"})
	if got == nil || *got != `{"purpose":"p","client":{"name":"a","version":"1"}}` {
		t.Fatalf("merged = %v", got)
	}
	got = mergedContextJSON(nil, nil)
	if got == nil || *got != `{}` {
		t.Fatalf("empty merge = %v", got)
	}
}

func TestCreateBranchPartialSuccessNamesRecovery(t *testing.T) {
	h := newHarness(t, "probe")
	h.core.failStart = service.Errf(409, "no free endpoint port in range")
	text, isErr := h.call(t, "create_branch", map[string]any{"project": "shop", "name": "agent/x"})
	if !isErr {
		t.Fatalf("partial success must be an error result: %q", text)
	}
	for _, needle := range []string{"branch CREATED, but its endpoint failed to start", `get_branch "agent/x"`, `delete_branch "agent/x"`} {
		if !strings.Contains(text, needle) {
			t.Fatalf("partial-success text missing %q:\n%s", needle, text)
		}
	}
	// The branch must NOT have been deleted (the fork is the valuable part).
	if _, ok := h.core.branches["p1"]["agent/x"]; !ok {
		t.Fatal("partial success must keep the created branch")
	}
}

func TestDeleteStopAndReset(t *testing.T) {
	h := newHarness(t, "probe")
	if text, isErr := h.call(t, "stop_endpoint", map[string]any{"project": "shop", "branch": "main"}); isErr ||
		!strings.Contains(text, "endpoint stopped.") || !strings.Contains(text, "Next: get_branch to restart it.") {
		t.Fatalf("stop_endpoint: %q", text)
	}
	if text, isErr := h.call(t, "reset_branch", map[string]any{"project": "shop", "branch": "main"}); isErr ||
		!strings.Contains(text, "reset to parent.") || !strings.Contains(text, "connection: postgresql://") {
		t.Fatalf("reset_branch: %q", text)
	}
	if text, isErr := h.call(t, "delete_branch", map[string]any{"project": "shop", "branch": "main"}); isErr ||
		!strings.Contains(text, "deleted.") || !strings.Contains(text, "Next: list_branches to confirm") {
		t.Fatalf("delete_branch: %q", text)
	}
}

func TestRestoreBranchPathSelection(t *testing.T) {
	h := newHarness(t, "probe")
	// as_new_branch present → the NEW-BRANCH path, session client captured.
	text, isErr := h.call(t, "restore_branch", map[string]any{
		"project": "shop", "branch": "main", "to_timestamp": "2026-07-12T00:00:00Z",
		"as_new_branch": "recovered",
	})
	if isErr || !strings.Contains(text, `branch "recovered" (forked from "main")`) || !strings.Contains(text, "postgresql://") {
		t.Fatalf("restore as new branch: %q (err=%v)", text, isErr)
	}
	// Empty/whitespace-only as_new_branch is REJECTED before any side effect
	// — never silently diverted to the destructive in-place path.
	before := len(h.core.calls)
	text, isErr = h.call(t, "restore_branch", map[string]any{
		"project": "shop", "branch": "main", "to_timestamp": "2026-07-12T00:00:00Z",
		"as_new_branch": "   ",
	})
	if !isErr || !strings.Contains(text, "as_new_branch must not be empty") {
		t.Fatalf("empty as_new_branch: %q (err=%v)", text, isErr)
	}
	if len(h.core.calls) != before {
		t.Fatal("the rejected call must have no side effects")
	}
	// Absent as_new_branch → in-place; a stopped result says so.
	text, isErr = h.call(t, "restore_branch", map[string]any{
		"project": "shop", "branch": "main", "to_timestamp": "2026-07-12T00:00:00Z",
	})
	if isErr || !strings.Contains(text, "restored in place to 2026-07-12T00:00:00Z") {
		t.Fatalf("in-place restore: %q", text)
	}
}

func TestPgBuildTools(t *testing.T) {
	h := newHarness(t, "probe")
	minor4, minor5 := 4, 5
	h.builds.rows = []builds.Row{
		{PgBuildRow: store.PgBuildRow{ID: "baked-v17", Major: 17, Minor: &minor5, Source: "baked", ReleaseTag: "baked", Status: "ready"}, Active: true},
		{PgBuildRow: store.PgBuildRow{ID: "dl-old", Major: 17, Minor: &minor4, Source: "downloaded", ReleaseTag: "9998", ImageDigest: "sha256:" + strings.Repeat("b", 64), Status: "ready"}},
	}

	text, isErr := h.call(t, "list_pg_builds", nil)
	if isErr {
		t.Fatalf("list_pg_builds: %q", text)
	}
	for _, needle := range []string{"[worktreedb] 1 Postgres major(s) tracked as of", "PG 17 — active 17.5 (baked, release baked)", "[ready] 17.4 release 9998"} {
		if !strings.Contains(text, needle) {
			t.Fatalf("list_pg_builds missing %q:\n%s", needle, text)
		}
	}

	text, isErr = h.call(t, "check_pg_updates", nil)
	if isErr || !strings.Contains(text, "PG 17: latest unverified — pull to verify") {
		t.Fatalf("check_pg_updates: %q", text)
	}

	text, isErr = h.call(t, "pull_pg_build", map[string]any{"major": 17})
	if isErr || !strings.Contains(text, "pull started (build build-123)") ||
		!strings.Contains(text, "Poll list_pg_builds") ||
		!strings.Contains(text, "pgbuild:build-123") ||
		!strings.Contains(text, `GET /api/events`) {
		t.Fatalf("pull_pg_build: %q", text)
	}

	// Downgrade REFUSAL: 17.4 sits below the 17.5 high-water — activate is
	// never even called, and the text names the human consent paths.
	h.builds.lastRun = map[int]int{17: 5}
	text, isErr = h.call(t, "activate_pg_build", map[string]any{"major": 17, "version": "17.4"})
	if !isErr {
		t.Fatalf("downgrade must refuse: %q", text)
	}
	for _, needle := range []string{"refused: 17.4 is a downgrade below the last-run PG 17.5", "MCP cannot consent to downgrades", "web UI", `{"consented":true}`} {
		if !strings.Contains(text, needle) {
			t.Fatalf("refusal text missing %q:\n%s", needle, text)
		}
	}
	if len(h.builds.activated) != 0 {
		t.Fatalf("refusal must never reach Activate: %v", h.builds.activated)
	}

	// Ambiguity: two ready builds at one version demand an explicit id.
	h.builds.lastRun = nil
	dup := builds.Row{PgBuildRow: store.PgBuildRow{ID: "dl-old-rebuild", Major: 17, Minor: &minor4, Source: "downloaded", ReleaseTag: "9998b", ImageDigest: "sha256:" + strings.Repeat("c", 64), Status: "ready"}}
	h.builds.rows = append(h.builds.rows, dup)
	text, isErr = h.call(t, "activate_pg_build", map[string]any{"major": 17, "version": "17.4"})
	if !isErr || !strings.Contains(text, "ambiguous: 2 ready builds at 17.4 for PG 17") || !strings.Contains(text, "dl-old") {
		t.Fatalf("ambiguity: %q", text)
	}
	// With the id, it activates.
	text, isErr = h.call(t, "activate_pg_build", map[string]any{"major": 17, "version": "17.4", "id": "dl-old"})
	if isErr || !strings.Contains(text, "activated 17.4 for PG 17") {
		t.Fatalf("explicit-id activate: %q", text)
	}
	if len(h.builds.activated) != 1 || h.builds.activated[0] != "dl-old" {
		t.Fatalf("activate calls: %v", h.builds.activated)
	}
	// A version with no ready build names what IS available.
	text, isErr = h.call(t, "activate_pg_build", map[string]any{"major": 17, "version": "17.9"})
	if !isErr || !strings.Contains(text, "no ready build 17.9 for PG 17") || !strings.Contains(text, "available: ") {
		t.Fatalf("no-ready: %q", text)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -run 'TestLists|TestCreateBranch|TestDelete|TestRestore|TestPgBuild' -count=1`
Expected: FAIL — `TestListsExactlyTheFourteenTools` reports 5 names; the tool-call tests fail with unknown-tool errors.

- [ ] **Step 3: Implement** — `internal/mcp/tools_mutate.go` (and DELETE the `registerMutateTools` stub from tools_read.go):

```go
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/VanGoghSoftware/worktreedb/internal/builds"
	"github.com/VanGoghSoftware/worktreedb/internal/service"
	"github.com/VanGoghSoftware/worktreedb/internal/store"
)

// branchContextIn is the CALLER-suppliable fork context. It deliberately has
// NO client field: the SDK's schema validation strips/rejects unknown
// properties before the handler runs, and the merge below overwrites client
// unconditionally — belt AND suspenders against spoofing which agent made a
// fork.
type branchContextIn struct {
	GitBranch *string `json:"git_branch,omitempty"`
	Workdir   *string `json:"workdir,omitempty"`
	Agent     *string `json:"agent,omitempty"`
	Purpose   *string `json:"purpose,omitempty"`
}

// mergedContextJSON serializes the caller context + the session-captured
// client. Key order is fixed by struct declaration; absent fields are
// omitted.
func mergedContextJSON(in *branchContextIn, client *clientInfo) *string {
	merged := struct {
		GitBranch *string     `json:"git_branch,omitempty"`
		Workdir   *string     `json:"workdir,omitempty"`
		Agent     *string     `json:"agent,omitempty"`
		Purpose   *string     `json:"purpose,omitempty"`
		Client    *clientInfo `json:"client,omitempty"`
	}{Client: client}
	if in != nil {
		merged.GitBranch, merged.Workdir, merged.Agent, merged.Purpose = in.GitBranch, in.Workdir, in.Agent, in.Purpose
	}
	raw, err := json.Marshal(merged)
	if err != nil {
		return nil
	}
	s := string(raw)
	return &s
}

// startNewBranchOrPartialSuccess: create_branch and restore_branch's
// as-new-branch path both durably create a NEW branch, then auto-start its
// endpoint — and both need IDENTICAL partial-success handling when that
// start fails. The branch (the valuable data fork) already exists; a bare
// error would send the agent into a create-retry → duplicate-name 409 →
// orphaned branch it doesn't know exists. The branch is NOT deleted (the
// endpoint is restartable); the response surfaces the persisted endpoint
// error and names the recovery.
func startNewBranchOrPartialSuccess(ctx context.Context, d Deps, branchID, branchName, ctxLine string) (service.BranchDetail, *sdk.CallToolResult, error) {
	detail, err := d.Core.EnsureRunning(ctx, branchID)
	if err == nil {
		return detail, nil, nil
	}
	failed, derr := d.Core.BranchDetail(ctx, branchID)
	reason := "unknown error"
	if derr == nil && failed.Row.StatusError != nil {
		reason = *failed.Row.StatusError
	} else if derr != nil {
		reason = err.Error()
	} else if serr := errText(err); serr != "" {
		reason = serr
	}
	return service.BranchDetail{}, errorResult(fmt.Sprintf(
		"%s\n  branch CREATED, but its endpoint failed to start: %s\nNext: fix the cause and call get_branch %q to retry the endpoint, or delete_branch %q to discard.",
		ctxLine, reason, branchName, branchName)), nil
}

func errText(err error) string {
	var serr *service.Error
	if asService(err, &serr) {
		return serr.Message
	}
	return ""
}

func buildVersionString(r store.PgBuildRow) string {
	if r.Minor == nil {
		return fmt.Sprintf("%d.x", r.Major)
	}
	return fmt.Sprintf("%d.%d", r.Major, *r.Minor)
}

// renderBuildSubline: one line per non-active row — failures carry their
// reason, benign skips are labeled distinctly so an agent doesn't retry a
// no-op.
func renderBuildSubline(r builds.Row) string {
	origin := "baked"
	if r.Source != "baked" {
		origin = "release " + r.ReleaseTag
	}
	switch r.Status {
	case "failed":
		reason := "unknown error"
		if r.Error != nil {
			reason = *r.Error
		}
		return fmt.Sprintf("  [failed] %s: %s", origin, reason)
	case "skipped":
		msg := "already installed (up to date)"
		if r.Error != nil {
			msg = *r.Error
		}
		return fmt.Sprintf("  [skipped] %s", msg)
	default:
		return fmt.Sprintf("  [%s] %s %s", r.Status, buildVersionString(r.PgBuildRow), origin)
	}
}

// noActiveSuffix: a major can be tracked on the strength of in-flight/failed
// rows alone — say so instead of a bare "no active build".
func noActiveSuffix(others []builds.Row) string {
	for _, r := range others {
		if r.Status == "downloading" || r.Status == "validating" {
			return " yet (pulling)"
		}
	}
	nonSkipped := 0
	failed := 0
	for _, r := range others {
		if r.Status != "skipped" {
			nonSkipped++
			if r.Status == "failed" {
				failed++
			}
		}
	}
	if nonSkipped > 0 && nonSkipped == failed {
		return " (last pull failed)"
	}
	return ""
}

func renderMajorBlock(major int, rows []builds.Row, degraded bool, updateAvailable *string) string {
	var active *builds.Row
	var others []builds.Row
	for i := range rows {
		if rows[i].Active && rows[i].Status == "ready" && active == nil {
			active = &rows[i]
		} else {
			others = append(others, rows[i])
		}
	}
	var lines []string
	if degraded {
		lines = append(lines, fmt.Sprintf("⚠ PG %d is running BELOW its last-run minor — re-pull to clear", major))
	}
	if active != nil {
		lines = append(lines, fmt.Sprintf("PG %d — active %s (%s, release %s)",
			major, buildVersionString(active.PgBuildRow), active.Source, active.ReleaseTag))
	} else {
		lines = append(lines, fmt.Sprintf("PG %d — no active build%s", major, noActiveSuffix(others)))
	}
	for _, r := range others {
		lines = append(lines, renderBuildSubline(r))
	}
	if updateAvailable != nil {
		// Worded honestly: the badge is an UNVERIFIED latest, never a
		// confirmed update.
		lines = append(lines, fmt.Sprintf("unverified: PG %d → %s (pull to verify)", major, *updateAvailable))
	}
	return strings.Join(lines, "\n")
}

func registerMutateTools(server *sdk.Server, d Deps) {
	type empty struct{}

	type createBranchIn struct {
		Project     string           `json:"project"`
		Name        string           `json:"name"`
		Parent      *string          `json:"parent,omitempty"`
		AtTimestamp *string          `json:"at_timestamp,omitempty"`
		Context     *branchContextIn `json:"context,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "create_branch",
		Description: "Create an isolated branch (the 'new worktree' move), optionally at a past timestamp. Auto-starts an endpoint and returns a connection string. Pass fork context (git_branch/workdir/agent/purpose) so other agents can see why this branch exists.",
	}, guardTool("create_branch", d, func(ctx context.Context, req *sdk.CallToolRequest, in createBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		parentName := "main"
		var parentID *string
		if in.Parent != nil {
			parentRow, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, *in.Parent)
			if err != nil {
				return nil, err
			}
			parentName = parentRow.Name
			parentID = &parentRow.ID
		}
		var atLsn *string
		if in.AtTimestamp != nil {
			src, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, parentName)
			if err != nil {
				return nil, err
			}
			lsn, err := d.Core.LsnAtTimestamp(ctx, src.ID, *in.AtTimestamp)
			if err != nil {
				return nil, err
			}
			atLsn = &lsn
		}
		branch, err := d.Core.CreateBranch(ctx, service.CreateBranchParams{
			ProjectID: p.ID, Name: in.Name, ParentBranchID: parentID, ParentSpecified: parentID != nil,
			AtLsn: atLsn, CreatedBy: "mcp",
			ContextJSON: mergedContextJSON(in.Context, clientInfoOf(req)),
		})
		if err != nil {
			return nil, err
		}
		line := contextLine(p.Name, branch.Row.Name, parentName)
		detail, partial, err := startNewBranchOrPartialSuccess(ctx, d, branch.Row.ID, branch.Row.Name, line)
		if err != nil {
			return nil, err
		}
		if partial != nil {
			return partial, nil
		}
		return textResult(fmt.Sprintf("%s\n%s\nNext: wire the connection string into your worktree env; delete_branch when the task is done.",
			line, renderBranch(detail, 0, ""))), nil
	}))

	type projectBranchIn struct {
		Project string `json:"project"`
		Branch  string `json:"branch"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "stop_endpoint",
		Description: "Stop a branch's endpoint (frees its port).",
	}, guardTool("stop_endpoint", d, func(ctx context.Context, _ *sdk.CallToolRequest, in projectBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		detail, err := d.Core.StopEndpoint(ctx, b.ID)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("%s\n  endpoint %s.\nNext: get_branch to restart it.",
			contextLine(p.Name, b.Name, ""), detail.Row.StatusEndpoint)), nil
	}))

	sdk.AddTool(server, &sdk.Tool{
		Name:        "delete_branch",
		Description: "Delete a branch. Fails if it has children (they are listed).",
	}, guardTool("delete_branch", d, func(ctx context.Context, _ *sdk.CallToolRequest, in projectBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		// A children-exist failure is a *service.Error naming the children —
		// guardTool surfaces it verbatim.
		if err := d.Core.DeleteBranch(ctx, b.ID); err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("%s\n  deleted.\nNext: list_branches to confirm, or create_branch to start a new working copy.",
			contextLine(p.Name, b.Name, ""))), nil
	}))

	sdk.AddTool(server, &sdk.Tool{
		Name:        "reset_branch",
		Description: "Discard a branch's changes; back to the parent's current state (the 'scrap and retry' move).",
	}, guardTool("reset_branch", d, func(ctx context.Context, _ *sdk.CallToolRequest, in projectBranchIn) (*sdk.CallToolResult, error) {
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		detail, err := d.Core.ResetToParent(ctx, b.ID)
		if err != nil {
			return nil, err
		}
		conn := ""
		if detail.ConnectionString != nil {
			conn = "\n  connection: " + *detail.ConnectionString
		}
		return textResult(fmt.Sprintf("%s\n  reset to parent.%s\nNext: get_branch to confirm the connection string, or reset_branch again after further edits.",
			contextLine(p.Name, detail.Row.Name, ""), conn)), nil
	}))

	type restoreBranchIn struct {
		Project     string           `json:"project"`
		Branch      string           `json:"branch"`
		ToTimestamp string           `json:"to_timestamp"`
		AsNewBranch *string          `json:"as_new_branch,omitempty"`
		Context     *branchContextIn `json:"context,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "restore_branch",
		Description: "Restore a branch to a past ISO-8601 timestamp. Provide as_new_branch (a name) to recover non-destructively into a new branch (recommended); omit for in-place restore (the endpoint is auto-stopped and restarted around it).",
	}, guardTool("restore_branch", d, func(ctx context.Context, req *sdk.CallToolRequest, in restoreBranchIn) (*sdk.CallToolResult, error) {
		// The destructive-footgun guard: an empty/whitespace-only
		// as_new_branch means the caller INTENDED the non-destructive path —
		// reject before ANY side effect rather than silently falling through
		// to the destructive in-place restore of the source branch.
		if in.AsNewBranch != nil && strings.TrimSpace(*in.AsNewBranch) == "" {
			return errorResult("as_new_branch must not be empty — pass a real branch name for a non-destructive restore, or omit it entirely for an in-place restore"), nil
		}
		p, err := d.Core.ProjectByNameOr404(ctx, in.Project)
		if err != nil {
			return nil, err
		}
		b, err := d.Core.BranchByProjectAndNameOr404(ctx, p.ID, in.Branch)
		if err != nil {
			return nil, err
		}
		// Branch on PRESENCE, never truthiness — the discipline for an
		// optional-string "which path" selector.
		if in.AsNewBranch != nil {
			nb, err := d.Core.BranchAtTimestamp(ctx, service.BranchAtParams{
				ProjectID: p.ID, SourceBranchID: b.ID, Name: *in.AsNewBranch, To: in.ToTimestamp,
				CreatedBy: "mcp", ContextJSON: mergedContextJSON(in.Context, clientInfoOf(req)),
			})
			if err != nil {
				return nil, err
			}
			line := contextLine(p.Name, nb.Row.Name, b.Name)
			detail, partial, err := startNewBranchOrPartialSuccess(ctx, d, nb.Row.ID, nb.Row.Name, line)
			if err != nil {
				return nil, err
			}
			if partial != nil {
				return partial, nil
			}
			return textResult(fmt.Sprintf("%s\n%s\nNext: verify the recovered data, then keep it or delete_branch %q once you're done.",
				line, renderBranch(detail, 0, ""), nb.Row.Name)), nil
		}
		detail, err := d.Core.RestoreInPlace(ctx, b.ID, in.ToTimestamp)
		if err != nil {
			return nil, err
		}
		// The restart claim renders conditionally: a branch with no running
		// endpoint at restore time comes back stopped — say so instead of
		// claiming a restart that never happened.
		body := fmt.Sprintf("  restored in place to %s (endpoint is stopped — get_branch to start it).", in.ToTimestamp)
		if detail.ConnectionString != nil {
			body = fmt.Sprintf("  restored in place to %s; endpoint restarted, connection: %s", in.ToTimestamp, *detail.ConnectionString)
		}
		return textResult(fmt.Sprintf("%s\n%s\nNext: verify the restored data.",
			contextLine(p.Name, detail.Row.Name, ""), body)), nil
	}))

	// --- the four build tools. None has a project/branch scope, so they open
	// with the "[worktreedb] …" header rather than contextLine.

	sdk.AddTool(server, &sdk.Tool{
		Name:        "list_pg_builds",
		Description: "List every Postgres build, grouped by major version: which one is active, every other ready/downloading/validating/failed build, degraded-downgrade warnings, and any update news from a prior check_pg_updates call.",
	}, guardTool("list_pg_builds", d, func(ctx context.Context, _ *sdk.CallToolRequest, _ empty) (*sdk.CallToolResult, error) {
		rows, err := d.Builds.List(ctx)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return textResult("[worktreedb] no Postgres builds installed\nNext: pull_pg_build to install one."), nil
		}
		// EVERY row's major counts — a pull of a brand-new major must be
		// visible while downloading and stay visible if it fails; "tracked",
		// not "installed", for exactly those majors.
		majorSet := map[int]bool{}
		for _, r := range rows {
			majorSet[r.Major] = true
		}
		var majors []int
		for m := range majorSet {
			majors = append(majors, m)
		}
		sort.Ints(majors)
		degraded := map[int]bool{}
		for _, m := range d.Builds.DegradedMajors() {
			degraded[m] = true
		}
		var blocks []string
		for _, major := range majors {
			var group []builds.Row
			for _, r := range rows {
				if r.Major == major {
					group = append(group, r)
				}
			}
			blocks = append(blocks, renderMajorBlock(major, group, degraded[major], d.Builds.UpdateAvailableFor(major)))
		}
		return textResult(fmt.Sprintf("[worktreedb] %d Postgres major(s) tracked as of %s\n%s\nNext: check_pg_updates to look for news, or activate_pg_build to switch a major's active build.",
			len(majors), nowISO(), strings.Join(blocks, "\n"))), nil
	}))

	type checkIn struct {
		Majors *[]int `json:"majors,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "check_pg_updates",
		Description: "Check the OCI registry's 'latest' per major and classify it honestly — current / unverified (worth a pull to verify) / incompatible (won't load on this runtime) — egress: hits the network. Populates list_pg_builds' trailing 'unverified:' lines.",
	}, guardTool("check_pg_updates", d, func(ctx context.Context, _ *sdk.CallToolRequest, in checkIn) (*sdk.CallToolResult, error) {
		majors := d.Builds.InstalledMajors(ctx)
		if in.Majors != nil {
			majors = *in.Majors
		}
		result, err := d.Builds.Check(ctx, majors)
		if err != nil {
			return nil, err
		}
		stateLabel := map[string]string{
			"current":      "up to date",
			"unverified":   "latest unverified — pull to verify",
			"incompatible": "latest incompatible with this runtime — not installable",
		}
		var keys []string
		for k := range result {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var lines []string
		for _, major := range keys {
			r := result[major]
			label, ok := stateLabel[r.State]
			if !ok {
				label = r.State
			}
			lines = append(lines, fmt.Sprintf("  PG %s: %s (%s@%s)", major, label, r.Tag,
				strings.TrimPrefix(r.Digest, "sha256:")[:12]))
		}
		return textResult(fmt.Sprintf("[worktreedb] checked %d major(s) as of %s\n%s\nNext: pull_pg_build for any major with an unverified latest.",
			len(majors), nowISO(), strings.Join(lines, "\n"))), nil
	}))

	type pullIn struct {
		Major int     `json:"major"`
		Tag   *string `json:"tag,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "pull_pg_build",
		Description: "Start pulling a Postgres build for a major (defaults to the 'latest' OCI tag). Async: returns immediately with the buildId — poll list_pg_builds for status.",
	}, guardTool("pull_pg_build", d, func(ctx context.Context, _ *sdk.CallToolRequest, in pullIn) (*sdk.CallToolResult, error) {
		tag := ""
		if in.Tag != nil {
			tag = *in.Tag
		}
		buildID, err := d.Builds.Pull(ctx, in.Major, tag)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("pull started (build %s). Poll list_pg_builds — status downloading → validating → ready (auto-activates).\nProgress: daemon logs channel pgbuild:%s. Or watch GET /api/events for a \"pg_builds\" event instead of polling.",
			buildID, buildID)), nil
	}))

	type activateIn struct {
		Major   int    `json:"major"`
		Version string `json:"version"`
		ID      *string `json:"id,omitempty"`
	}
	sdk.AddTool(server, &sdk.Tool{
		Name:        "activate_pg_build",
		Description: "Make a specific ready build the active one for its major. Refuses downgrades below the last-run minor — an agent cannot silently roll a branch back; downgrading requires human consent via the web UI or REST. Pass the build id to disambiguate when two ready builds share a major.minor (a same-minor rebuild at a new digest).",
	}, guardTool("activate_pg_build", d, func(ctx context.Context, _ *sdk.CallToolRequest, in activateIn) (*sdk.CallToolResult, error) {
		rows, err := d.Builds.List(ctx)
		if err != nil {
			return nil, err
		}
		var candidates, ready []builds.Row
		for _, r := range rows {
			if r.Major != in.Major {
				continue
			}
			candidates = append(candidates, r)
			if r.Status == "ready" && buildVersionString(r.PgBuildRow) == in.Version {
				ready = append(ready, r)
			}
		}
		// Content-addressed storage means two ready rows can legitimately
		// share one major.minor — require an explicit id rather than guess
		// which rebuild the agent meant.
		var target *builds.Row
		switch {
		case in.ID != nil:
			for i := range ready {
				if ready[i].ID == *in.ID {
					target = &ready[i]
				}
			}
			if target == nil {
				suffix := " — none ready at " + in.Version
				if len(ready) > 0 {
					var ids []string
					for _, r := range ready {
						ids = append(ids, r.ID)
					}
					suffix = " — ready ids at " + in.Version + ": " + strings.Join(ids, ", ")
				}
				return errorResult(fmt.Sprintf("no ready build %s for PG %d with id %s%s", in.Version, in.Major, *in.ID, suffix)), nil
			}
		case len(ready) > 1:
			var opts []string
			for _, r := range ready {
				opts = append(opts, fmt.Sprintf("%s (digest %s)", r.ID, strings.TrimPrefix(r.ImageDigest, "sha256:")[:12]))
			}
			return errorResult(fmt.Sprintf("ambiguous: %d ready builds at %s for PG %d — re-call with id to pick one: %s",
				len(ready), in.Version, in.Major, strings.Join(opts, ", "))), nil
		case len(ready) == 1:
			target = &ready[0]
		}
		if target == nil {
			var available []string
			for _, r := range candidates {
				if r.Status == "ready" {
					available = append(available, buildVersionString(r.PgBuildRow))
				}
			}
			suffix := " — none ready; pull_pg_build first"
			if len(available) > 0 {
				suffix = " — available: " + strings.Join(available, ", ")
			}
			return errorResult(fmt.Sprintf("no ready build %s for PG %d%s", in.Version, in.Major, suffix)), nil
		}

		// Downgrade refusal, determined HERE — the target is refused without
		// ever calling Activate, so no consent can be exercised on an
		// agent's behalf, and no future change to the activate guard can
		// silently reintroduce an attempt.
		lastRun, err := d.Builds.LastRunMinor(ctx, in.Major)
		if err != nil {
			return nil, err
		}
		if target.Minor != nil && lastRun != nil && *target.Minor < *lastRun {
			return errorResult(fmt.Sprintf(
				"refused: %s is a downgrade below the last-run PG %d.%d — MCP cannot consent to downgrades on an agent's behalf.\nDowngrades require human consent: use the web UI Settings card (confirm dialog) or POST /api/pg-builds/%s/activate with {\"consented\":true}.",
				in.Version, in.Major, *lastRun, target.ID)), nil
		}
		row, err := d.Builds.Activate(ctx, target.ID, false)
		if err != nil {
			return nil, err
		}
		return textResult(fmt.Sprintf("[worktreedb] activated %s for PG %d\nNext: list_pg_builds to confirm, or restart any running endpoint on this major to pick it up.",
			buildVersionString(row.PgBuildRow), in.Major)), nil
	}))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/mcp/ -race -count=1`
Expected: PASS — including the 14-name contract.

- [ ] **Step 5: Wire MCP into boot** — in `cmd/worktreedbd/main.go`, after `core` and the gate wiring (Task 10), before `api.NewServer`:

```go
	mcpHandler, mcpClose := mcp.NewHandler(mcp.Deps{
		Version: version, Engine: sup, Core: core, Builds: buildsSvc,
		AllowedHosts: cfg.MCPAllowedHosts, AllowedOrigins: cfg.MCPAllowedOrigins,
		Log: log,
	})
```

pass `MCP: mcpHandler` in the `api.Deps` literal, and on BOTH shutdown arms call `mcpClose()` immediately after `sseCancel()` (MCP GET streams are held-open requests exactly like SSE — closing sessions first lets `httpSrv.Shutdown` drain instead of timing out). Add the import `"github.com/VanGoghSoftware/worktreedb/internal/mcp"`.

Compile-time seams (add to `internal/mcp/tools_read.go` under the interface definitions):

```go
var (
	_ CoreAPI   = (*service.Core)(nil)
	_ BuildsAPI = (*builds.Service)(nil)
)
```

(`builds.Service` needs the exact `UpdateAvailableFor(major int) *string` and `LastRunMinor(ctx, major) (*int, error)` shapes from Tasks 7/8 — the assertion catches drift at compile time.)

Run: `cd ~/git/worktreedb && go build ./... && go test ./... -race -count=1`
Expected: builds + full unit suite green.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/mcp/ cmd/worktreedbd/main.go && git commit -m "feat(mcp): mutating and build tools — full 14-tool surface with fork-context capture"
```

---

### Task 15: skills + repo docs

The two agent skills, written for Worktree DB on its own terms (same discipline, same tool names — the tool surface is identical). Plus the AGENTS.md notes that make the new subsystems discoverable.

**Files:**
- Create: `~/git/worktreedb/skills/using-worktreedb/SKILL.md`
- Create: `~/git/worktreedb/skills/safe-db-migrations/SKILL.md`
- Modify: `~/git/worktreedb/AGENTS.md`

**Interfaces:** none (docs only) — but the tool names referenced MUST match Task 13/14's registrations exactly.

- [ ] **Step 1: Write `skills/using-worktreedb/SKILL.md`:**

```markdown
---
name: using-worktreedb
description: Use when starting a task that will touch a database - gives each agent an isolated writable branch (worktree : files :: branch : data) via the worktreedb MCP server, mirroring git-worktree discipline.
---

# Using Worktree DB

## Overview

Worktree DB branches are to data what git worktrees are to code: an instant, isolated, writable copy you
work in destructively and throw away. One branch per task. Never share a branch between concurrent agents.

All tools below are exposed by the connected `worktreedb` MCP server. `get_status` confirms it's reachable;
`list_projects` shows what's available.

## Workflow

1. **Branch off `main`** with `create_branch`, passing `project` (the project name), `name`
   (`agent/<task-slug>`), and ALWAYS fork context under `context`:
   - `git_branch`: `git branch --show-current`
   - `workdir`: your worktree path (`$PWD`)
   - `purpose`: one line describing the task
   The tool auto-starts an endpoint and returns a connection string in the response text.
2. **Wire the connection string** into your worktree's environment (e.g. `DATABASE_URL`).
3. **Work destructively.** `main` is untouched. Re-fetch a connection string any time with
   `get_branch` (`project` + `branch`) — it restarts the endpoint by default if it's stopped.
4. **Scrap and retry** with `reset_branch` (`project` + `branch`) to discard changes and return to
   the parent's current state, if you need a clean slate.
5. **Clean up** with `delete_branch` (`project` + `branch`) when the task completes. Fails if the
   branch has children — delete those first.

## Other tools

- `list_branches` (`project`) — the branch tree for a project: status, creator, fork context, and
  parent ancestry. Use before `create_branch` to avoid name collisions or pick a non-`main` parent.
- `stop_endpoint` (`project` + `branch`) — stop a branch's endpoint to free its port; `get_branch`
  restarts it.
- `restore_branch` (`project` + `branch` + `to_timestamp`) — time-travel to a past ISO-8601
  timestamp. Pass `as_new_branch` (a name) to recover non-destructively into a new branch
  (recommended); omit it for a destructive in-place restore of the source branch.
- `create_project` (`name`, optional `pgVersion`) — only if the project you need doesn't exist yet;
  each project is a separate database universe with its own auto-created `main` branch.
- `list_pg_builds` / `check_pg_updates` / `pull_pg_build` / `activate_pg_build` — self-serve a
  missing Postgres major or a newer minor. Pulls validate against live storage before activating;
  downgrades are refused over MCP (human consent via the web UI or REST only).

## Rules

- One branch per task; never point two concurrent agents at the same branch.
- Always pass fork context (`git_branch`/`workdir`/`purpose`) on `create_branch` — it's how a human
  tells parallel agents' branches apart in the dashboard, and how you can too via `list_branches`.
- Stop endpoints you no longer need (`stop_endpoint`) to free ports; `get_branch` restarts them.
- If `create_branch` reports the branch was created but its endpoint failed to start, don't retry
  with another `create_branch` call (you'll hit a duplicate-name error) — call `get_branch` to retry
  the endpoint, or `delete_branch` to discard.
```

- [ ] **Step 2: Write `skills/safe-db-migrations/SKILL.md`:**

```markdown
---
name: safe-db-migrations
description: Use before running a schema migration or destructive SQL against a database - rehearse it on a throwaway worktreedb branch, verify, then apply to main, with restore_branch as the undo.
---

# Safe DB Migrations

## Overview

Never rehearse a migration on `main`. Worktree DB branches make a full-fidelity dry run free: fork `main`,
run the migration for real, verify, then apply the same migration to `main` only once the rehearsal
is clean.

All tools below are exposed by the connected `worktreedb` MCP server, take `project` (the project name)
plus a `branch` name, and are documented in full in the `using-worktreedb` skill.

## Workflow

1. **Rehearse** on a fresh branch off `main`, taken immediately before you rehearse (so it matches
   `main`'s current state). Use `create_branch` with `project`, `name` (`migration/<slug>`), and fork
   context under `context` (`git_branch`/`workdir`/`purpose`). The response includes a connection
   string — run the migration against it, not against `main`.
2. **Verify** schema + data on the rehearsal branch. If it broke something:
   - `reset_branch` (`project` + `branch`) to discard the changes and return to `main`'s current
     state, then retry the migration; or
   - `delete_branch` (`project` + `branch`) to discard the branch entirely and start over with a new
     `create_branch`.
3. **Apply to `main`** once the rehearsal is clean: run the same migration against `main`'s own
   connection string (`get_branch` with `project` + `branch: "main"` if you need to re-fetch it).
4. **Undo** if a migration on `main` goes wrong: `restore_branch` with `project`, `branch: "main"`,
   `to_timestamp` (ISO-8601, e.g. from before you applied the migration), and `as_new_branch` (a new
   name) to recover `main`'s pre-migration state into a new branch — non-destructive, `main` is
   untouched. Verify the recovered branch, then cut over (e.g. point traffic at its connection
   string, or replay the recovered state onto `main`).

## Other tools

- `get_branch` (`project` + `branch`) — re-fetch a connection string for the rehearsal branch or for
  `main`; restarts the endpoint by default if it's stopped.
- `list_branches` (`project`) — see prior rehearsal branches and their fork context before naming a
  new one.

## Rules

- The rehearsal branch must match `main`'s starting state — branch immediately before rehearsing, not
  hours earlier, or the dry run tests stale schema/data.
- Never run the migration directly against `main`'s connection string until the rehearsal branch has
  verified clean.
- `restore_branch` without `as_new_branch` restores in place, destructively, on the branch you name —
  for undoing a bad migration on `main`, always pass `as_new_branch` so the recovery lands in a new
  branch and `main` itself is untouched until you deliberately cut over.
- Keep `to_timestamp` ISO-8601 with an explicit timezone.
- Clean up rehearsal branches (`delete_branch`) once the migration has landed on `main`.
```

- [ ] **Step 3: Extend AGENTS.md** — add (matching the file's existing section style) a short "Dynamic builds + MCP" paragraph to the architecture notes:

```markdown
- `internal/builds` owns dynamic PostgreSQL installs: OCI pull (hand-rolled client in
  `internal/oci`, containment-enforced extraction), a validation gate that drives a real compute
  against live storage before any build activates, newest-minor-wins activation with a
  never-silent-downgrade high-water (`pg_actives.last_run_minor`), and boot adoption of volume
  builds via `build.json` markers. The pageserver reads WAL-redo binaries from the composed
  `/data/pg_distrib` farm — composed by the builds bootstrap BEFORE the engine starts.
- `internal/mcp` serves `/mcp` (streamable HTTP, stateful sessions, official go-sdk) behind a
  fail-closed Host/Origin guard (`WORKTREEDB_MCP_ALLOWED_HOSTS/_ORIGINS` extend the loopback
  allowlist). 14 tools; fork contexts capture the session's initialize clientInfo server-side.
  Registry env: `WORKTREEDB_PG_REGISTRY_BASE/_IMAGE_TEMPLATE/_TOKEN` (token is a secret — never
  logged, never in a DTO). Agent skills live in `skills/`.
```

- [ ] **Step 4: Verify + commit**

Run: `cd ~/git/worktreedb && grep -riE 'devdb|neond|matisiekpl|typescript|fastify' skills/ AGENTS.md | grep -v neondatabase`
Expected: no output (clean-content check).

```bash
cd ~/git/worktreedb && git add skills/ AGENTS.md && git commit -m "docs: agent skills (using-worktreedb, safe-db-migrations) and builds/mcp notes"
```

---

### Task 16: worktreedb integration — builds surface + MCP handshake smoke

Container-level proof of the new seams the reference suite can't isolate: baked builds seeded + status block populated on a fresh boot, the MCP endpoint alive behind its guard (raw JSON-RPC — no client SDK needed for a handshake), and the guard's 403s — including the percent-encoded-path variant — against the REAL router.

**Files:**
- Create: `~/git/worktreedb/integration/builds_mcp_test.go`

**Interfaces:**
- Consumes: the `integration` package's existing helpers (`image()`, `baseURL`, `apiJSON` — reuse, never duplicate; check `integration/boot_test.go`/`branching_test.go` for the exact names).

- [ ] **Step 1: Write the test** — `integration/builds_mcp_test.go`:

```go
//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

func startBuildsContainer(t *testing.T) (testcontainers.Container, string) {
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
	base, err := baseURL(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return c, base
}

func TestBuildsSurfaceAndMCPHandshake(t *testing.T) {
	_, base := startBuildsContainer(t)

	// --- Baked builds seeded; DTO shape; status block keyed by major.
	res, err := http.Get(base + "/api/pg-builds")
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if len(rows) == 0 {
		t.Fatal("no baked build rows at boot")
	}
	var sawActive17 bool
	for _, row := range rows {
		if row["source"] == "baked" && row["status"] != "ready" {
			t.Fatalf("baked row not ready: %v", row)
		}
		if row["major"] == float64(17) && row["active"] == true {
			sawActive17 = true
			if v, _ := row["version"].(string); !strings.HasPrefix(v, "17.") {
				t.Fatalf("active v17 version: %v", row)
			}
		}
	}
	if !sawActive17 {
		t.Fatal("major 17 has no active baked build")
	}

	res, err = http.Get(base + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		PgBuilds map[string]struct {
			ActiveVersion     *string `json:"activeVersion"`
			Source            *string `json:"source"`
			DegradedDowngrade bool    `json:"degradedDowngrade"`
			UpdateAvailable   *string `json:"updateAvailable"`
		} `json:"pgBuilds"`
	}
	if err := json.NewDecoder(res.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	m, ok := status.PgBuilds["17"]
	if !ok || m.ActiveVersion == nil || m.Source == nil || *m.Source != "baked" || m.DegradedDowngrade {
		t.Fatalf("status pgBuilds[17]: %+v (present=%v)", m, ok)
	}

	// --- MCP handshake over raw JSON-RPC: initialize → session id →
	// tools/list must name exactly the 14 tools.
	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}`
	req, _ := http.NewRequest(http.MethodPost, base+"/mcp", bytes.NewReader([]byte(initBody)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	sessionID := res.Header.Get("Mcp-Session-Id")
	initRaw := readJSONRPCResult(t, res)
	var initResult struct {
		Instructions string `json:"instructions"`
		ServerInfo   struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
		Capabilities struct {
			Tools *struct {
				ListChanged bool `json:"listChanged"`
			} `json:"tools"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(initRaw, &initResult); err != nil {
		t.Fatalf("initialize decode: %v (%s)", err, initRaw)
	}
	if sessionID == "" {
		t.Fatal("initialize must mint an Mcp-Session-Id")
	}
	if !strings.Contains(initResult.Instructions, "branch per task") {
		t.Fatalf("instructions: %q", initResult.Instructions)
	}
	if initResult.ServerInfo.Name != "worktreedb" {
		t.Fatalf("serverInfo: %+v", initResult.ServerInfo)
	}
	if initResult.Capabilities.Tools == nil || !initResult.Capabilities.Tools.ListChanged {
		t.Fatalf("tools capability: %+v", initResult.Capabilities)
	}

	// The initialized notification completes the handshake.
	notif, _ := http.NewRequest(http.MethodPost, base+"/mcp",
		bytes.NewReader([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)))
	notif.Header.Set("Content-Type", "application/json")
	notif.Header.Set("Accept", "application/json, text/event-stream")
	notif.Header.Set("Mcp-Session-Id", sessionID)
	nres, err := http.DefaultClient.Do(notif)
	if err != nil {
		t.Fatal(err)
	}
	_ = nres.Body.Close()

	listReq, _ := http.NewRequest(http.MethodPost, base+"/mcp",
		bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)))
	listReq.Header.Set("Content-Type", "application/json")
	listReq.Header.Set("Accept", "application/json, text/event-stream")
	listReq.Header.Set("Mcp-Session-Id", sessionID)
	res, err = http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatal(err)
	}
	var toolsResult struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(readJSONRPCResult(t, res), &toolsResult); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range toolsResult.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	want := []string{
		"activate_pg_build", "check_pg_updates", "create_branch", "create_project",
		"delete_branch", "get_branch", "get_status", "list_branches", "list_pg_builds",
		"list_projects", "pull_pg_build", "reset_branch", "restore_branch", "stop_endpoint",
	}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v", names)
	}

	// --- The guard, against the real router: an untrusted Host 403s, on the
	// plain path AND the percent-encoded one; the REST surface is unguarded.
	for _, path := range []string{"/mcp", "/%6dcp"} {
		evil, _ := http.NewRequest(http.MethodPost, base+path, bytes.NewReader([]byte(initBody)))
		evil.Header.Set("Content-Type", "application/json")
		evil.Host = "evil.example.com"
		eres, err := http.DefaultClient.Do(evil)
		if err != nil {
			t.Fatal(err)
		}
		body := make([]byte, 512)
		n, _ := eres.Body.Read(body)
		_ = eres.Body.Close()
		if eres.StatusCode != 403 || !strings.Contains(string(body[:n]), "WORKTREEDB_MCP_ALLOWED_HOSTS") {
			t.Fatalf("evil Host on %s: %d %s", path, eres.StatusCode, body[:n])
		}
	}
	statusReq, _ := http.NewRequest(http.MethodGet, base+"/api/status", nil)
	statusReq.Host = "evil.example.com"
	sres, err := http.DefaultClient.Do(statusReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = sres.Body.Close()
	if sres.StatusCode != 200 {
		t.Fatalf("the guard must scope to /mcp only; /api/status returned %d", sres.StatusCode)
	}
}

// readJSONRPCResult extracts the `result` object from a streamable-HTTP
// response: application/json bodies decode directly; text/event-stream
// bodies carry the JSON-RPC response as `data:` lines.
func readJSONRPCResult(t *testing.T, res *http.Response) json.RawMessage {
	t.Helper()
	defer res.Body.Close()
	var payload []byte
	ct := res.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "text/event-stream") {
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(res.Body); err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(buf.String(), "\n") {
			if strings.HasPrefix(line, "data:") {
				payload = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				break
			}
		}
	} else {
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(res.Body); err != nil {
			t.Fatal(err)
		}
		payload = buf.Bytes()
	}
	if len(payload) == 0 {
		t.Fatalf("no JSON-RPC payload (content-type %s)", ct)
	}
	var rpc struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(payload, &rpc); err != nil {
		t.Fatalf("JSON-RPC decode: %v (%s)", err, payload)
	}
	if rpc.Error != nil {
		t.Fatalf("JSON-RPC error: %s", rpc.Error)
	}
	return rpc.Result
}
```

(`fmt` is not used above — drop it from the import block when transcribing.)

- [ ] **Step 2: Build the image + run**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev . && go test -tags integration ./integration/ -run TestBuildsSurfaceAndMCPHandshake -count=1 -timeout 15m -v
```

Expected: PASS. (First run this test RED before Task 14 lands if executing out of order — in the normal sequence the daemon already serves everything, so this task's RED evidence is the run against the PRE-Task-12 image if available, or skip RED: this is a container-level acceptance test over already-unit-tested behavior, and its value is the wiring proof.)

- [ ] **Step 3: Run the full Go-native suites**

```bash
cd ~/git/worktreedb && go test ./... -race -count=1 && golangci-lint run && go test -tags integration ./integration/... -count=1 -timeout 45m
```

Expected: unit suite green, lint 0 issues, integration green (M1 boot + M2 branching + this file).

- [ ] **Step 4: Commit**

```bash
cd ~/git/worktreedb && git add integration/builds_mcp_test.go && git commit -m "test(integration): builds surface and MCP handshake smoke"
```

---

### Task 17: devdb repo — image-agnostic state injection + the M3 cross-run gate

**This task works in `~/git/devdb`** (the workshop repo; its usual commit conventions apply, including devdb's trailer policy). The pg-builds test injects the `last_run_minor` high-water by `docker exec node -e` with better-sqlite3 — impossible against the Go image (no Node runtime). Replace that machinery with a flavor-dispatched helper: the default arm keeps the existing node one-liner byte-for-byte; the `WORKTREEDB_` arm uses the `sqlite3` CLI the worktreedb image ships (Task 10) against its own schema (`pg_actives`). **Assertions never change** — the `expect(...)` lines in pg-builds.test.ts are untouched; only the injection call site becomes a helper call. Then run the M3 gate and the full regression.

**The M3 cross-run gate is exactly these 4 files:** `pg-builds` · `mcp` · `mcp-handshake` · `mcp-concurrency`.

**Files:**
- Modify: `~/git/devdb/tests/integration/helpers/fixture-registry.ts`
- Modify: `~/git/devdb/tests/integration/pg-builds.test.ts`
- Modify: `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`

- [ ] **Step 1: Add the injection helper** — append to `~/git/devdb/tests/integration/helpers/fixture-registry.ts`:

```typescript
import { ENV_PREFIX } from "./container.js";

// Injects a pg high-water mark (last-run minor) straight into the daemon's
// SQLite while it runs — the downgrade-guard tests need a high-water no
// legitimate flow can produce. Image-agnostic by flavor dispatch on the
// suite's env prefix:
//   - DEVDB_ (default): the image ships a Node runtime with better-sqlite3
//     in the daemon's node_modules — the original exec one-liner, verbatim.
//     Schema: pg_majors(major, last_run_minor).
//   - anything else (the Go image): the image ships the sqlite3 CLI as
//     operator tooling; the daemon's schema keeps the high-water on
//     pg_actives(major, active_build_id, last_run_minor) — the upsert
//     deliberately leaves active_build_id alone.
// Both arms set a busy timeout to coexist with the daemon's WAL writer; the
// caller restarts the container afterwards, which re-reads it at boot.
export async function injectLastRunMinor(dev: Devdb, major: number, minor: number): Promise<void> {
  if (ENV_PREFIX === "DEVDB_") {
    await execa("docker", ["exec", "-w", "/app/packages/daemon", dev.container.getId(), "node", "-e",
      "const D=require('better-sqlite3');const db=new D('/data/state.db');db.pragma('busy_timeout=5000');" +
      `db.prepare("INSERT INTO pg_majors (major,last_run_minor) VALUES (${major},${minor}) ON CONFLICT(major) DO UPDATE SET last_run_minor=${minor}").run();db.close();`]);
    return;
  }
  await execa("docker", ["exec", dev.container.getId(), "sqlite3", "/data/state.db",
    `PRAGMA busy_timeout=5000; INSERT INTO pg_actives (major, last_run_minor) VALUES (${major},${minor}) ` +
    `ON CONFLICT(major) DO UPDATE SET last_run_minor=${minor};`]);
}
```

- [ ] **Step 2: Swap the call site** — in `~/git/devdb/tests/integration/pg-builds.test.ts`, replace the injection block (the `execa("docker", ["exec", "-w", "/app/packages/daemon", … "node", "-e", …])` statement under the "Downgrade guard via a LEGIT high-water injection" comment) with:

```typescript
    await injectLastRunMinor(dev, 17, 99);
```

and add `injectLastRunMinor` to the existing `./helpers/fixture-registry.js` import. Update the comment above it to describe the helper dispatch instead of the node one-liner (keep its first sentence — the WHY — intact). Verify: `git diff tests/integration/pg-builds.test.ts` shows NO `expect(` line changed.

- [ ] **Step 3: Prove the default path is untouched** — the devdb arm must still pass:

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/devdb/tests/integration && pnpm vitest run pg-builds
```

Expected: PASS (~15–20 min; devdb:dev is rebuilt by the suite if stale). If machine load makes it flaky, re-run isolated before digging.

- [ ] **Step 4: Run the M3 cross-run gate**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run pg-builds mcp mcp-handshake mcp-concurrency
```

Expected: **4 files, all green.** This IS the milestone acceptance (spec §8-M3). Failures are porting bugs in the worktreedb repo: fix THERE (new worktreedb commits through the normal review gates), rebuild the image, re-run — never touch an assertion. `mcp.test.ts` matches on `mcp-handshake`/`mcp-concurrency` filename filters too — vitest's filter is a substring match, so the single `mcp` token already covers all three; passing all four names is harmless and explicit.

- [ ] **Step 5: Run the full 15-file regression** (the M2 11 + the M3 4 — M3 boot-order changes touch every file's daemon):

```bash
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run acceptance projects branching endpoints timetravel events boot \
    restart unclean-restart retry-helper storcon-major-guard pg-builds mcp mcp-handshake mcp-concurrency
```

Expected: **15 files green.** (Sequential; budget 60–90 min. A single red under load: re-run that file isolated before treating it as real.)

- [ ] **Step 6: Update the cross-run doc** — in `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`, replace the line `Later gates: pg-builds + mcp/mcp-handshake/mcp-concurrency at M3;` and what follows it with:

```markdown
## M3 gate (4 build/MCP files — all must pass, assertions unmodified)

pg-builds, mcp, mcp-handshake, mcp-concurrency

State injection is image-agnostic since M3: helpers/fixture-registry.ts's
injectLastRunMinor dispatches on DEVDB_TEST_ENV_PREFIX (node+better-sqlite3
into pg_majors for the default image; the in-image sqlite3 CLI into
pg_actives for WORKTREEDB_). Assertions unchanged.

    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run pg-builds mcp mcp-handshake mcp-concurrency

Result 2026-07-XX: <record the green run's summary line here>
Full 15-file regression (M2's 11 + these 4) 2026-07-XX: <summary line>

Later gates: web-ui at M4 (full suite = the parity gate).
```

Fill both result lines with the actual run summaries from Steps 4–5.

- [ ] **Step 7: Commit (devdb repo — devdb conventions)**

```bash
cd ~/git/devdb && git add tests/integration/helpers/fixture-registry.ts tests/integration/pg-builds.test.ts docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md
git commit -m "test(integration): image-agnostic pg high-water injection + M3 cross-run gate

injectLastRunMinor dispatches on DEVDB_TEST_ENV_PREFIX: the default image
keeps the node/better-sqlite3 one-liner into pg_majors; the Go image uses
its in-image sqlite3 CLI into pg_actives. Assertions unchanged. Records the
M3 gate (pg-builds + 3 MCP files) and the 15-file regression result.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## M3 gate (4 files — all must pass, assertions unmodified)

`pg-builds` · `mcp` · `mcp-handshake` · `mcp-concurrency`

## Invocation

    export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
    cd ~/git/worktreedb && docker build -t worktreedb:dev .
    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run pg-builds mcp mcp-handshake mcp-concurrency

## Milestone acceptance (spec §8-M3)

- `go test ./... -race -count=1` green; `golangci-lint run` 0 issues (worktreedb).
- `go test -tags integration ./integration/...` green — M1/M2 cases plus the builds+MCP smoke.
- **The cross-run gate: pg-builds + the three MCP files green against `worktreedb:dev` with unmodified assertions** (Task 17 Step 4, recorded in the cross-run doc), plus the 15-file regression (Step 5).
- Clean-history spot check before merging the worktree branch:
  `cd ~/git/worktreedb && git log --format=%B <base>..HEAD | grep -iE 'devdb|neond|matisiekpl|typescript|fastify|node\b|co-authored' ; grep -riE 'devdb|neond|matisiekpl|typescript|fastify' --include='*.go' --include='*.md' . | grep -v neondatabase` — both empty (the sanctioned `neondatabase/neon` oracle mentions excepted).

## Deferred out of M3 (recorded, deliberate)

- **Web UI copy/embed + full-suite parity gate** — M4 (`web-ui.test.ts` joins there; the `pg_builds` bus event this milestone emits is its invalidation hint).
- **Suspend/wake** — M5.
- **Resume-on-boot for interrupted pulls** — post-parity policy flip (the pull already persists a 4-step cursor + fingerprint; flip `pg_build_pull` to `ResumeOnBoot` and make `extract` staging-idempotent then).
- **A jobs/operations REST surface** — the durable operation rows are written but not served; a read API is the import/export milestone's contract.
- **Runtime (non-boot) build GC** — boot applies keep-2; a background GC loop was deliberately not added (removal has a human path via DELETE).
- **Config-label minor detection in check** (confirming a newer minor WITHOUT a pull would need the image config's labels; the default registry's label conventions are not ours to invent) — the honest `unverified` state stands in.
- **Engine-image base slimming, dual-stack listeners, engine auto-restart** — post-parity backlog (spec §11).

## Execution handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two gates per task (independent reviewer + review-broker scan, severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` pointing into the worktree). Implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — never on main. Every implementer/fix dispatch carries the no-AI-trailer + clean-content rules verbatim.

**2. Inline Execution** — superpowers:executing-plans, batch execution with checkpoints.







