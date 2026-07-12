# Worktree DB M4 — UI + packaging + parity gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the React/Mantine web app into the Go daemon — copied + renamed, its `@devdb/shared` types vendored, `//go:embed`ed into the binary and served with the exact SPA-fallback hardening of the reference daemon — then prove FULL parity by running the complete reference integration suite (M2's 11 + M3's 4 + `web-ui`) green against `worktreedb:dev` with assertions unmodified.

**Architecture:** The web app is copied verbatim into a repo-root `web/` (one squashed `feat: web ui` commit — the sole sanctioned clean-history exception), with its single cross-package dependency (`packages/shared/src/index.ts`, 121 lines, only `zod`) vendored to `web/src/shared.ts` and every `@devdb/shared` import rewritten relative. A tiny `web/embed.go` (`package web`, `//go:embed all:dist`) exposes the built dist as an `fs.FS`; the daemon threads it through `api.Deps.Web` and mounts a `spaHandler` at `mux.Handle("/", …)` — Go 1.22+ most-specific-pattern-wins means the existing `/api/…` and `/mcp` routes always beat `/`, so the SPA can never shadow them. The handler reimplements the reference `static.ts`'s four fallback rules by construction. The Docker image gains a `node:22` web-build stage that produces the real Vite dist and COPYs it into the golang stage before `go build`; a committed placeholder `web/dist/index.html` keeps `go build`/`go test`/CI (which run without Node) compilable. Master spec: `docs/superpowers/specs/2026-07-11-worktreedb-go-rewrite-design.md` (D2, §3, §4, §7–§8-M4).

**Tech Stack:** Web (copied, unchanged) — React 19 / Mantine 9 / Vite 8 / vitest 4 / TypeScript 5.7 / zod 3 / pnpm 11.9.0. Go — stdlib `net/http` + `io/fs` + `embed` + `testing/fstest` + `path` (no new module). Docker multi-stage (node → golang → runtime). `testcontainers-go` (integration only).

## Global Constraints

- **Repo split:** all product code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`, `go 1.25.0`); implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — **never on its `main`** (base = `main@1a3fdd9` or later). Commands below say `cd ~/git/worktreedb`; substitute the worktree path. **Task 6 is the ONE devdb-repo task** (`~/git/devdb`). This plan and the ledger stay in devdb (workshop) — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers of any kind** (spec D4) — this overrides any harness default. The web copy is **ONE squashed `feat: web ui` commit** (spec D2 exception). The devdb-repo commit in Task 6 keeps devdb's usual trailer policy.
- **Clean-history rule (spec §3):** worktreedb code, comments, tests, commit messages, and docs NEVER mention the TypeScript implementation, the devdb repo, `matisiekpl/neond`, Fastify, Node-as-runtime, or "parity with the old daemon". **The copied web app's renamed strings are the sole sanctioned exception (D2); `// oracle: neon` citations to official `neondatabase/neon` are the other.** The web-copy clean-content gate is `grep -riE 'devdb' web/ --include='*.ts' --include='*.tsx' --include='*.html' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist` returning **empty** (the `--exclude-dir` flags keep third-party `node_modules` JSON and generated `dist` out of the audit — our source is what must be clean).
- **API is frozen this milestone:** the Go REST surface stays byte-compatible — the copied app consumes `/api/*` unchanged. **No API changes, no CORS added, no new routes** beyond mounting the SPA at `/`. The SPA fallback must NEVER shadow `/api` or `/mcp`.
- **Dependency policy:** stdlib-first on the Go side — **zero new Go modules** in M4 (`embed`, `io/fs`, `testing/fstest`, `path` are all stdlib). The web side ships the copied dependency set **plus `zod` promoted to a direct dep** (all copied deps are already > 24h old; a `web/.npmrc` `minimum-release-age=1440` governs future installs, matching the repo's 1440-minute policy). `go get` is not run; **no `go mod tidy`**. pnpm is pinned `pnpm@11.9.0`.
- **Acceptance (spec §8-M4):** the **full reference suite (16 files) green vs `worktreedb:dev`, assertions unmodified**; `go build ./... && go vet ./...` clean; `go test ./... -race` green; `golangci-lint run` 0 issues; `go test -tags integration ./integration/...` green; clean-history spot check empty. Then the dogfood cutover to `:4400`.
- **Execution:** SDD, two gates per task (independent reviewer + review-broker scan; severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` into the worktree).

## File map (M4 end state, worktreedb repo — new/modified only)

```
web/                              CREATE: the copied React app (one squashed `feat: web ui` commit)
  src/**                          copied from devdb packages/web/src (13 files rewrite the shared import)
  src/shared.ts                   CREATE: vendored packages/shared/src/index.ts (symbols/const/comment scrubbed)
  test/**                         copied (23 files; 11 rewrite the shared import; app + prefs tests re-branded)
  index.html                      copied + <title> re-branded
  package.json                    copied + name, drop workspace:*, +zod, +packageManager
  pnpm-lock.yaml                  CREATE: standalone lockfile (pnpm install, no workspace)
  .npmrc                          CREATE: minimum-release-age=1440
  vite.config.ts                  copied verbatim
  tsconfig.json                   copied verbatim
  embed.go                        CREATE (Task 2): package web, //go:embed all:dist -> fs.FS
  dist/index.html                 CREATE (Task 2): committed placeholder <div id="root"></div>
internal/api/server.go            MODIFY (Task 2): Deps.Web fs.FS + spaHandler mounted at "/"
internal/api/spa_test.go          CREATE (Task 2): fstest.MapFS unit test pinning the 4 rules
cmd/worktreedbd/main.go           MODIFY (Task 2): version bump + Web wiring; (Task 3) disk-override select
internal/config/config.go         MODIFY (Task 3): WORKTREEDB_WEB_DIST optional disk override
internal/config/config_test.go    MODIFY (Task 3)
Dockerfile                        MODIFY (Task 3): + node:22 web-build stage; COPY dist into golang stage
.gitignore                        MODIFY (Task 1): web/node_modules/ + web/dist/assets/
.dockerignore                     MODIFY (Task 1): web/node_modules + web/dist
.github/workflows/ci.yml          MODIFY (Task 4, OPTIONAL): + Node web build+test job
compose.yaml                      CREATE (Task 5): docker compose serving :4400 with the UI
README.md                         MODIFY (Task 5): embedded-UI + compose + dogfood cutover
AGENTS.md                         MODIFY (Task 5): a web/ note in the architecture paragraph
integration/web_test.go           CREATE (Task 7, OPTIONAL): //go:build integration Go-native SPA smoke

devdb repo (Task 6 only):
docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md   MODIFY: M4 section (full 16-file suite) + result
```

**Task dependency order:** 1 → 2 → 3 → {4, 5} → 6 → 7. Task 4 (CI) and Task 5 (packaging) are independent once the image builds (Task 3). Task 6 (the parity gate) needs the Task 3 image. Task 7 needs the Task 3 image and is best run alongside/after Task 6.

---

### Task 1: Copy + rename the web app (one squashed `feat: web ui` commit)

Copy `packages/web/` into the repo-root `web/`, vendor `packages/shared/src/index.ts` as `web/src/shared.ts`, rewrite all 25 `@devdb/shared` import sites relative, rename the vendored symbols/const/comment, re-brand every `devdb`/`DevDB` string, generate a standalone lockfile, and prove the whole transform with `pnpm build` + `pnpm test` green and the clean-content grep empty. This task is inherently **one large commit** — the review gate checks rename completeness, clean content, and build/test green, not per-file TDD.

**Files:**
- Create: `web/` (copied tree) + `web/src/shared.ts` + `web/.npmrc` + `web/pnpm-lock.yaml`
- Modify (post-copy): `web/index.html`, `web/package.json`, `web/src/App.tsx`, `web/src/prefs.ts`, `web/src/api/events.ts`, `web/src/pages/DashboardPage.tsx`, `web/test/app.test.tsx`, `web/test/prefs.test.ts`, and every file importing `@devdb/shared`
- Modify: `~/git/worktreedb/.gitignore`, `~/git/worktreedb/.dockerignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `web/src/shared.ts` exporting the vendored types/values — `BranchDto`, `ProjectDto`, `StatusDto`, `BranchContext`, `PgBuildDto`, `PgMajorStatusDto`, `SUPPORTED_PG_VERSIONS`, `DEFAULT_PG_VERSION`, `PgVersion`, `PgVersionSchema`, `EndpointStatus`/`EndpointStatusSchema`, `BranchContextSchema`, `PgBuildStatus`/`PgBuildStatusSchema`, and the renamed `WORKTREEDB`, `WorktreedbEventType`, `WorktreedbEventTypeSchema`, `WorktreedbEvent`, `WorktreedbEventSchema`; a `web/` that `pnpm build` + `pnpm test` pass on. Task 2 embeds `web/dist`.

- [ ] **Step 1: Bulk-copy the app + the vendor target**

Run (substitute your worktree path for `$WT`):

```bash
export WT=~/git/worktreedb          # <-- set to the .worktrees/<branch> path
export SRC=~/git/devdb/packages/web
mkdir -p "$WT/web"
cp -R "$SRC/src" "$SRC/test" "$WT/web/"
cp "$SRC/index.html" "$SRC/vite.config.ts" "$SRC/tsconfig.json" "$SRC/package.json" "$WT/web/"
cp ~/git/devdb/packages/shared/src/index.ts "$WT/web/src/shared.ts"
```

- [ ] **Step 2: Rewrite the 25 `@devdb/shared` import sites relative**

`web/src/shared.ts` is the vendored module. Files under `web/src/**` import it as `../shared` (they all live one level deep — `src/api`, `src/drawer`, `src/pages`, `src/settings`, `src/tree`); files under `web/test/**` import it as `../src/shared`. (macOS `sed` — the `-i ''` form.)

```bash
cd "$WT/web"
grep -rl '@devdb/shared' src --include='*.ts' --include='*.tsx' | xargs sed -i '' 's#@devdb/shared#../shared#g'
grep -rl '@devdb/shared' test --include='*.ts' --include='*.tsx' | xargs sed -i '' 's#@devdb/shared#../src/shared#g'
grep -rn '@devdb/shared' src test    # expect: no output
```

Expected: the final grep prints nothing (all 25 sites rewritten).

- [ ] **Step 3: Rename the vendored event symbols across `web/`**

The `Devdb*` event symbols are defined in `shared.ts` and referenced in `src/api/events.ts`. Longest-name-first so overlapping prefixes are safe:

```bash
cd "$WT/web"
grep -rl 'Devdb' src --include='*.ts' --include='*.tsx' | xargs sed -i '' \
  -e 's/DevdbEventTypeSchema/WorktreedbEventTypeSchema/g' \
  -e 's/DevdbEventType/WorktreedbEventType/g' \
  -e 's/DevdbEventSchema/WorktreedbEventSchema/g' \
  -e 's/DevdbEvent/WorktreedbEvent/g'
```

- [ ] **Step 4: Rename the vendored `DEVDB` const + scrub the vendored comment**

In `web/src/shared.ts`, change line 3:

```ts
export const DEVDB = "devdb";
```

to:

```ts
export const WORKTREEDB = "worktreedb";
```

and reword the events-schema comment (it cites a `devdb`-named spec doc, which would fail the clean-content gate). Change:

```ts
// Phase 3: /api/events wire schema. Events are coarse INVALIDATION HINTS, never data — the UI
// refetches via REST on receipt (spec 2026-07-03-devdb-phase-3-web-ui-design.md, Decision 1).
// branch.updated covers every branch-row mutation that isn't create/delete: rename, reset,
// in-place restore (timeline swap). LSN/size churn is deliberately NOT an event.
```

to:

```ts
// /api/events wire schema. Events are coarse INVALIDATION HINTS, never data — the UI refetches
// via REST on receipt. branch.updated covers every branch-row mutation that isn't create/delete:
// rename, reset, in-place restore (timeline swap). LSN/size churn is deliberately NOT an event.
```

Verify the vendored file is clean:

```bash
grep -niE 'devdb' "$WT/web/src/shared.ts"    # expect: no output
```

- [ ] **Step 5: Re-brand the display + config strings**

```bash
cd "$WT/web"
# Browser tab title + shell brand
sed -i '' 's#<title>DevDB</title>#<title>Worktree DB</title>#' index.html
sed -i '' 's/◆ DevDB/◆ Worktree DB/' src/App.tsx
# localStorage keys (value + the doc comment that names main.tsx's key literal)
sed -i '' -e 's/devdb\.theme/worktreedb.theme/g' -e 's/devdb\.defaultTreeView/worktreedb.defaultTreeView/g' src/prefs.ts
# Dashboard remediation copy (docker + MCP onboarding strings)
sed -i '' -e 's/docker compose restart devdb/docker compose restart worktreedb/' \
  -e 's#claude mcp add --transport http devdb #claude mcp add --transport http worktreedb #' src/pages/DashboardPage.tsx
# Test assertions that pin the above (brand text + localStorage keys)
sed -i '' 's#DevDB#Worktree DB#g' test/app.test.tsx
sed -i '' -e 's/devdb\.theme/worktreedb.theme/g' -e 's/devdb\.defaultTreeView/worktreedb.defaultTreeView/g' test/prefs.test.ts
```

Notes on why the test files are in scope: `test/app.test.tsx` asserts the shell brand via `getByText(/DevDB/)` — which becomes `getByText(/Worktree DB/)`, matching the re-branded `◆ Worktree DB` node — and `test/prefs.test.ts` asserts the exact `worktreedb.theme` / `worktreedb.defaultTreeView` localStorage keys. `main.tsx` needs NO edit: it imports `THEME_STORAGE_KEY` from `prefs.ts` (single source of truth), so re-branding `prefs.ts` propagates.

- [ ] **Step 6: Rewrite `web/package.json`**

Replace the whole file with (name renamed, `@devdb/shared` dropped, `zod` promoted to a direct dep at the workspace-pinned `^3.24.0`, `packageManager` pinned so corepack/CI resolve the same pnpm):

```json
{
  "name": "worktreedb-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "test": "tsc --noEmit -p tsconfig.json && NODE_OPTIONS=--no-experimental-webstorage vitest run"
  },
  "dependencies": {
    "@mantine/core": "^9.4.1",
    "@mantine/hooks": "^9.4.1",
    "@mantine/notifications": "^9.4.1",
    "@tanstack/react-query": "^5.101.2",
    "@xyflow/react": "^12.11.1",
    "d3-hierarchy": "^3.1.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router": "^8.1.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.1",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/d3-hierarchy": "^3.1.7",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "jsdom": "^29.1.1",
    "typescript": "^5.7.0",
    "vite": "^8.1.3",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 7: Add `web/.npmrc` (supply-chain release-age floor)**

Create `web/.npmrc`:

```
; Future installs honor the repo's 24h npm-package-age policy (1440 minutes).
; The copied dependency set is already older than this; this governs upgrades.
minimum-release-age=1440
```

- [ ] **Step 8: Ignore build artifacts (final state)**

Append to `~/git/worktreedb/.gitignore` (the committed placeholder `web/dist/index.html` from Task 2 stays TRACKED — only `dist/assets/` is generated):

```
web/node_modules/
web/dist/assets/
```

Append to `~/git/worktreedb/.dockerignore` (the golang stage never needs the placeholder — the web-build stage produces the real dist and the golang stage COPYs it in; keeping the stale placeholder + node_modules out of the build context keeps it small):

```
web/node_modules
web/dist
```

- [ ] **Step 9: Install (standalone lockfile) — the RED/GREEN gate begins**

worktreedb has no pnpm workspace, so this generates a **standalone** `web/pnpm-lock.yaml`:

```bash
cd "$WT/web" && pnpm install
```

Expected: resolves and writes `web/pnpm-lock.yaml` + `web/node_modules` (both git/docker-ignored except the lockfile). Use plain `pnpm` (corepack's shim is broken on this machine).

- [ ] **Step 10: Copy gate — build + test + clean-content (GREEN)**

```bash
cd "$WT/web" && pnpm build
```
Expected: `tsc --noEmit` typechecks (proves every rewritten import + renamed symbol resolves) and `vite build` writes `web/dist/` (real hashed assets).

```bash
cd "$WT/web" && pnpm test
```
Expected: `tsc --noEmit` + `vitest run` — **all suites pass** (a broken rename fails typecheck; a missed brand/key rename fails `app.test.tsx` / `prefs.test.ts`).

```bash
grep -rn '@devdb/shared' "$WT/web/src" "$WT/web/test"   # expect: empty
grep -riE 'devdb' "$WT/web" --include='*.ts' --include='*.tsx' --include='*.html' --include='*.json' \
  --exclude-dir=node_modules --exclude-dir=dist          # expect: empty
```
Expected: both empty — the clean-history gate for the web copy.

- [ ] **Step 11: Remove the generated dist, then commit source only**

`pnpm build` produced a real `web/dist/` (its `index.html` references hashed assets). The committed placeholder is created deliberately in Task 2 — so drop the generated dist now to keep this commit source-only:

```bash
rm -rf "$WT/web/dist"
cd "$WT" && git add web .gitignore .dockerignore
git status   # confirm: no web/dist, no web/node_modules staged; web/pnpm-lock.yaml IS staged
git commit -m "feat: web ui"
```

Expected: one commit adding the web source, the vendored `shared.ts`, the standalone lockfile, `.npmrc`, and the ignore entries. **No AI trailer** (and this is the D2-sanctioned exception where renamed brand strings live).

---

### Task 2: `//go:embed` the dist + the Go SPA handler

Add `web/embed.go` exposing the built dist as an `fs.FS`, a committed placeholder `web/dist/index.html` so no-Node builds compile, thread an `fs.FS` through `api.Deps.Web`, and mount a `spaHandler` at `mux.Handle("/", …)` that reimplements the reference `static.ts`'s four fallback rules. TDD with `testing/fstest`.

**Files:**
- Create: `web/embed.go`, `web/dist/index.html` (placeholder), `internal/api/spa_test.go`
- Modify: `internal/api/server.go`, `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: the `web/` tree from Task 1.
- Produces: `web.Dist() fs.FS` (dist file tree); `api.Deps.Web fs.FS` (mounted at `/` when non-nil); `spaHandler(fs.FS) http.Handler`. Task 3 swaps `main.go` to prefer a disk override.

- [ ] **Step 1: Commit the placeholder dist so the embed compiles**

`//go:embed` is COMPILE-time; `go build`/`go test`/CI run without Node, so the embed dir must exist in-tree. Create `web/dist/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Worktree DB</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

(`web/dist/assets/` stays gitignored from Task 1; only this file is tracked. The Docker web-build stage in Task 3 overwrites this with the real Vite output before `go build`. Wrinkle to remember: a local `pnpm build` rewrites this file with the hashed one — `git checkout web/dist/index.html` restores the placeholder.)

- [ ] **Step 2: Add `web/embed.go`**

```go
// Package web carries the built single-page app, embedded into the daemon
// binary at compile time. The committed dist/index.html placeholder keeps
// no-Node builds (go build / go test / CI) compilable; the Docker web-build
// stage overwrites dist with the real Vite output before the binary is built.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// Dist returns the built SPA file tree (the contents of dist/). It panics only
// on a malformed embed — a build-time guarantee, never a runtime path.
func Dist() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
```

Verify it compiles standalone:

```bash
cd ~/git/worktreedb && go build ./web/
```
Expected: builds (the placeholder satisfies the embed).

- [ ] **Step 3: Write the failing SPA handler test**

Create `internal/api/spa_test.go` (same `package api` — it reuses `allComponentsRunning`, `fakeCore`, `fakeBuilds`, `sampleBranch` from the existing route tests):

```go
package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/VanGoghSoftware/worktreedb/internal/config"
	"github.com/VanGoghSoftware/worktreedb/internal/events"
)

// newWebHandler builds the full server with a fake embedded dist (index.html
// plus one hashed asset) so the SPA fallback rules can be pinned without the
// real Vite build.
func newWebHandler() http.Handler {
	dist := fstest.MapFS{
		"index.html":             {Data: []byte(`<!doctype html><div id="root"></div>`)},
		"assets/index-abc123.js": {Data: []byte("export const x = 1;\n")},
	}
	return NewServer(Deps{
		Version: "0.4.0", PortRange: config.PortRange{Min: 54300, Max: 54339},
		Engine: allComponentsRunning(1), Core: &fakeCore{branch: sampleBranch()},
		Builds: &fakeBuilds{}, Bus: events.NewBus(), Hub: events.NewLogHub(),
		Web: dist, ShutdownCtx: context.Background(),
	})
}

func TestSPAServesShellAtRoot(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("status=%v err=%v", res, err)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("content-type = %q", ct)
	}
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), `id="root"`) {
		t.Fatalf("body = %q", body)
	}
}

func TestSPAServesHashedAsset(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/assets/index-abc123.js")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("status=%v err=%v", res, err)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestSPADeepLinkFallsBackToShell(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/projects/00000000-0000-0000-0000-000000000000")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("status=%v err=%v", res, err)
	}
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), `id="root"`) {
		t.Fatalf("deep link did not serve the shell: %q", body)
	}
}

func TestSPAMissingAssetIsRealNotFound(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/assets/does-not-exist.js")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 404 {
		t.Fatalf("missing asset must 404, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if strings.Contains(string(body), `id="root"`) {
		t.Fatalf("missing asset served the shell (would break as JS): %q", body)
	}
}

func TestSPAUnknownApiStaysJSON404(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/api/definitely-not-a-route")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 404 {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("unknown /api route must stay JSON 404, got %q", ct)
	}
}

func TestSPAReservedMcpNeverServesShell(t *testing.T) {
	srv := httptest.NewServer(newWebHandler()) // Web set, MCP nil here
	defer srv.Close()
	res, err := srv.Client().Get(srv.URL + "/mcp/deep")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode == 200 && strings.Contains(string(body), `id="root"`) {
		t.Fatalf("/mcp subtree fell back to the shell: %d %q", res.StatusCode, body)
	}
}

func TestSPAPostRootIsNotFound(t *testing.T) {
	srv := httptest.NewServer(newWebHandler())
	defer srv.Close()
	res, err := srv.Client().Post(srv.URL+"/", "text/plain", strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 404 {
		t.Fatalf("POST / must 404 (only GET/HEAD navigate), got %d", res.StatusCode)
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/api/ -run TestSPA -count=1`
Expected: **FAIL to compile** — `Deps` has no `Web` field and `spaHandler` is undefined.

- [ ] **Step 4: Implement — thread `Web` through `Deps`, mount `spaHandler`**

In `internal/api/server.go`, add `"io/fs"` and `"path"` to the import block, then add the field to `Deps` (after `MCP`):

```go
	MCP         http.Handler // mounted at /mcp when non-nil
	Web         fs.FS        // embedded (or disk-override) SPA tree; mounted at "/" when non-nil
	ShutdownCtx context.Context
```

In `NewServer`, AFTER the MCP mount and the `/api/` JSON-404 catch-all and BEFORE `return mux`, add:

```go
	// The SPA is mounted at "/", the least-specific pattern. Go 1.22+ routing
	// gives every more-specific pattern priority, so "/api/…" (the JSON-404
	// catch-all) and "/mcp" always win — the app can never shadow them.
	// Registered here for readability; precedence does not depend on order.
	if d.Web != nil {
		mux.Handle("/", spaHandler(d.Web))
	}

	return mux
}
```

Then add the handler + helper at the end of the file (near the other unexported helpers):

```go
// reservedAPIorMCP marks the surfaces that must never resolve to the app shell:
// /api and /mcp and their subtrees. In practice the mux dispatches /api/* to the
// JSON-404 catch-all and an exact /mcp to the MCP handler before this runs; this
// guard covers the residue — a /mcp/… subpath when no MCP subtree is registered,
// and a bare /api — so a reserved path is answered with a real 404, not HTML.
func reservedAPIorMCP(p string) bool {
	return p == "/api" || strings.HasPrefix(p, "/api/") || p == "/mcp" || strings.HasPrefix(p, "/mcp")
}

// spaHandler serves the built single-page app and owns the fallback policy —
// four rules, matching the reference daemon's static handler:
//   (a) only GET/HEAD navigate; any other method is a real 404;
//   (b) a request for an existing file (hashed asset, favicon) serves that file
//       with an extension-derived Content-Type (Go sets .js -> text/javascript,
//       .html -> text/html);
//   (c) a MISSING path WITH a file extension is a real 404 — a stale
//       /assets/x.js reference must not silently return HTML the browser then
//       fails to parse as JS;
//   (d) a missing EXTENSIONLESS path (/, /projects/<id>, /settings) serves
//       index.html and the client router takes over.
func spaHandler(dist fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r) // (a)
			return
		}
		p := r.URL.Path // net/http has already cleaned + percent-decoded this
		if reservedAPIorMCP(p) {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(p, "/")
		if name != "" {
			if info, err := fs.Stat(dist, name); err == nil && !info.IsDir() {
				http.ServeFileFS(w, r, dist, name) // (b)
				return
			}
		}
		if path.Ext(p) != "" {
			http.NotFound(w, r) // (c)
			return
		}
		http.ServeFileFS(w, r, dist, "index.html") // (d)
	})
}
```

Run: `cd ~/git/worktreedb && go test ./internal/api/ -run TestSPA -count=1`
Expected: **PASS** (all 7 cases).

- [ ] **Step 5: Wire the embedded dist into the daemon + bump the version**

In `cmd/worktreedbd/main.go`: bump `const version = "0.3.0"` → `const version = "0.4.0"`; add `"github.com/VanGoghSoftware/worktreedb/web"` to the import block; and pass `Web: web.Dist()` in the `api.Deps` literal:

```go
	handler := api.NewServer(api.Deps{
		Version: version, PortRange: cfg.PortRange, Engine: sup,
		Core: core, Builds: buildsSvc, Bus: bus, Hub: hub, MCP: mcpHandler,
		Web: web.Dist(), ShutdownCtx: sseCtx,
	})
```

- [ ] **Step 6: Full unit build + test**

Run: `cd ~/git/worktreedb && go build ./... && go vet ./... && go test ./... -race -count=1`
Expected: builds clean; ALL unit tests pass (the placeholder dist serves the shell in the unit path; the fstest cases pin the rules).

Run: `cd ~/git/worktreedb && golangci-lint run`
Expected: 0 issues.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktreedb && git add web/embed.go web/dist/index.html internal/api/server.go internal/api/spa_test.go cmd/worktreedbd/main.go
git commit -m "feat(web): embed the SPA and serve it with hardened fallback"
```

---

### Task 3: Dockerfile web-build stage + optional disk override

Add a `node:22` stage that builds the real Vite dist and COPY it into the golang stage before `go build`, so the shipped binary embeds the real UI. Add the optional `WORKTREEDB_WEB_DIST` disk override (mirrors the reference daemon's dev override) so a running container can serve a dist from `/data`-mounted disk without a rebuild.

**Files:**
- Modify: `Dockerfile`, `internal/config/config.go`, `internal/config/config_test.go`, `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: `web/` (Task 1), `web.Dist()` + `api.Deps.Web` (Task 2).
- Produces: `worktreedb:dev` whose `/` serves the real UI; `config.Config.WebDist string` (optional absolute path); `main.go` prefers `os.DirFS(cfg.WebDist)` over the embedded FS when set.

- [ ] **Step 1: Add the `WORKTREEDB_WEB_DIST` config field (failing test first)**

In `internal/config/config_test.go`, add:

```go
func TestWebDistOptionalAbsolute(t *testing.T) {
	base := map[string]string{
		"WORKTREEDB_DATA_DIR": "/data", "WORKTREEDB_NEON_BIN_DIR": "/bin", "WORKTREEDB_PG_INSTALL_DIR": "/pg",
	}
	// unset -> empty
	cfg, err := Load(func(k string) string { return base[k] })
	if err != nil || cfg.WebDist != "" {
		t.Fatalf("unset: cfg.WebDist=%q err=%v", cfg.WebDist, err)
	}
	// absolute -> kept
	base["WORKTREEDB_WEB_DIST"] = "/srv/dist"
	cfg, err = Load(func(k string) string { return base[k] })
	if err != nil || cfg.WebDist != "/srv/dist" {
		t.Fatalf("abs: cfg.WebDist=%q err=%v", cfg.WebDist, err)
	}
	// relative -> error
	base["WORKTREEDB_WEB_DIST"] = "rel/dist"
	if _, err = Load(func(k string) string { return base[k] }); err == nil {
		t.Fatal("relative WORKTREEDB_WEB_DIST must error")
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/config/ -run TestWebDist -count=1`
Expected: FAIL — `cfg.WebDist` undefined.

- [ ] **Step 2: Implement the field**

In `internal/config/config.go`, add to the `Config` struct (after `MCPAllowedOrigins`):

```go
	// Optional dev override: serve the web UI from this absolute disk path
	// instead of the binary's embedded dist. Unset -> the embedded UI is served.
	WebDist string
```

and in `Load`, before `return cfg, nil`:

```go
	if wd := strings.TrimSpace(getenv("WORKTREEDB_WEB_DIST")); wd != "" {
		if !filepath.IsAbs(wd) {
			return nil, fmt.Errorf("WORKTREEDB_WEB_DIST must be an absolute path, got: %s", wd)
		}
		cfg.WebDist = wd
	}
```

Run: `cd ~/git/worktreedb && go test ./internal/config/ -count=1`
Expected: PASS.

- [ ] **Step 3: Prefer the disk override in `main.go`**

In `cmd/worktreedbd/main.go`, add `"io/fs"` to the imports, and replace `Web: web.Dist()` (from Task 2) with a selected FS built just above the `api.NewServer` call:

```go
	// The embedded UI is the default; WORKTREEDB_WEB_DIST swaps in a disk dist
	// (dev/hot-swap) without rebuilding the binary.
	var webFS fs.FS = web.Dist()
	if cfg.WebDist != "" {
		webFS = os.DirFS(cfg.WebDist)
		log.Info("serving web UI from disk override", "dir", cfg.WebDist)
	}
	handler := api.NewServer(api.Deps{
		Version: version, PortRange: cfg.PortRange, Engine: sup,
		Core: core, Builds: buildsSvc, Bus: bus, Hub: hub, MCP: mcpHandler,
		Web: webFS, ShutdownCtx: sseCtx,
	})
```

Run: `cd ~/git/worktreedb && go build ./... && go test ./... -count=1`
Expected: builds + unit tests pass.

- [ ] **Step 4: Add the web-build stage + COPY dist into the golang stage**

Edit `Dockerfile`. Insert a web-build stage AFTER the `neon-binaries` FROM and BEFORE the golang `build` stage:

```dockerfile
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
RUN corepack enable
# Install with only the manifest + lockfile first for layer caching.
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build
```

Then in the golang `build` stage, add ONE line — the COPY of the real dist, AFTER `COPY . .` (which brings the source but not `web/dist`, excluded by `.dockerignore`) and BEFORE `go build`:

```dockerfile
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-build /web/dist ./web/dist
RUN CGO_ENABLED=0 go build -o /out/worktreedbd ./cmd/worktreedbd
```

(The runtime stage is unchanged — the UI is baked into the binary. `.dockerignore`'s `web/dist` + `web/node_modules` from Task 1 keep the stale placeholder and deps out of the golang build context; the embed picks up the real dist from the `--from=web-build` COPY.)

- [ ] **Step 5: Build the image + verify it serves the real UI**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
```
Expected: all three build stages succeed (web-build runs `pnpm build`; golang embeds the real dist).

```bash
docker rm -f wtdb-m4 2>/dev/null; docker volume rm wtdb-m4 2>/dev/null; docker volume create wtdb-m4
docker run -d --name wtdb-m4 --init -p 127.0.0.1:4400:4400 -v wtdb-m4:/data worktreedb:dev
sleep 8
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:4400/            # 200 text/html
ASSET=$(curl -s http://127.0.0.1:4400/ | grep -oE '/assets/[^"]+\.js' | head -1); echo "asset=$ASSET"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "http://127.0.0.1:4400$ASSET"     # 200 .../javascript
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:4400/api/nope    # 404 application/json
docker rm -f wtdb-m4; docker volume rm wtdb-m4
```
Expected: `/` → `200 text/html`; the fingerprinted asset → `200` with a `javascript` content-type; `/api/nope` → `404 application/json`. (This is the web-ui.test.ts contract, exercised by hand; Task 6 runs it as the real gate.)

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add Dockerfile internal/config/config.go internal/config/config_test.go cmd/worktreedbd/main.go
git commit -m "build(web): node web-build stage embeds the dist; optional disk override"
```

---

### Task 4: CI — Node web build+test job (OPTIONAL; default: include)

> **OPTIONAL.** This adds the ONLY non-Go job to worktreedb CI. **Default: include** — it gates future web-source changes (a broken rename or a failing component test) on PRs, the same discipline the daemon gets. **To drop it and keep CI pure-Go:** skip this task entirely; the web copy is still gated locally by `pnpm build` + `pnpm test` (Task 1) and end-to-end by the Docker build (Task 3) + the parity gate (Task 6). devdb itself has no committed web-CI job (its web suite runs via local `pnpm --filter @devdb/web test`), so dropping this does not diverge from devdb.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `web/` with its standalone lockfile + pinned `packageManager` (Task 1).
- Produces: a `web` CI job (build + test) parallel to the existing `test` (Go) job.

- [ ] **Step 1: Add the `web` job**

In `.github/workflows/ci.yml`, add a second job under `jobs:` (leave the existing `test` job unchanged):

```yaml
  web:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4          # reads packageManager (pnpm@11.9.0) from web/package.json
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: web/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
        working-directory: web
      - run: pnpm build
        working-directory: web
      - run: pnpm test
        working-directory: web
```

- [ ] **Step 2: Lint the workflow locally**

Run: `cd ~/git/worktreedb && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo OK`
Expected: `OK` (valid YAML; `pnpm build` + `pnpm test` already proven green in Task 1, so the job is expected to pass on CI).

- [ ] **Step 3: Commit**

```bash
cd ~/git/worktreedb && git add .github/workflows/ci.yml
git commit -m "ci: build and test the web app on pull requests"
```

---

### Task 5: Packaging — compose, README, AGENTS note

Ship a `docker compose` path that serves `:4400` with the UI, and update the repo docs to describe the embedded UI and the dogfood cutover. The README currently claims the daemon only serves `/api/status` — stale since M2/M3; refresh it.

**Files:**
- Create: `compose.yaml`
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: the `worktreedb:dev` image (Task 3).
- Produces: `docker compose up` on `:4400` with the UI + the registry opt-in comment.

- [ ] **Step 1: Add `compose.yaml`** (repo root — the `Dockerfile` is at the repo root)

```yaml
services:
  worktreedb:
    # First `--build` only: the Dockerfile FROMs a PRIVATE GHCR engine image, so
    # run a one-time `docker login ghcr.io` (read:packages PAT) first.
    build: { context: ., dockerfile: Dockerfile }
    image: worktreedb:dev
    init: true
    # Dynamic PG-build pull defaults to Neon's public Docker Hub compute images
    # (anonymous; v17 works, v14-16 are ABI-broken on this bookworm runtime). To
    # pull the from-source, all-bookworm compute images instead (all majors), opt
    # into the private GHCR registry by uncommenting these + a read:packages PAT:
    #environment:
    #  WORKTREEDB_PG_REGISTRY_BASE: https://ghcr.io
    #  WORKTREEDB_PG_IMAGE_TEMPLATE: vangoghsoftware/worktreedb-compute-v{major}
    #  WORKTREEDB_PG_REGISTRY_TOKEN: <your ghcr.io read:packages PAT>
    ports:
      - "127.0.0.1:4400:4400"
      - "127.0.0.1:54300-54339:54300-54339"
    volumes:
      - worktreedb-data:/data
    stop_grace_period: 60s
volumes:
  worktreedb-data:
```

- [ ] **Step 2: Verify compose parses + serves the UI**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker compose config >/dev/null && echo "compose OK"
docker compose up -d
sleep 8
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:4400/    # 200 text/html
docker compose down -v
```
Expected: `compose OK`; `/` → `200 text/html` (the UI shell).

- [ ] **Step 3: Refresh `README.md`**

Replace the stale status blurb (currently: "**Status: early development.** The daemon currently boots the storage engine and serves `GET /api/status`; branching APIs are landing next.") with:

```markdown
**Status: full local parity.** The daemon supervises the storage engine and
serves the complete branch/endpoint/timetravel REST API, an MCP surface at
`/mcp` for coding agents, and the web UI — all on `:4400`. Auto-suspend +
wake-on-connect is the next milestone.
```

Add a compose section after the existing `docker run` block:

```markdown
### With Docker Compose

```bash
docker login ghcr.io          # one-time, read:packages PAT (engine base is private)
docker compose up -d --build
open http://127.0.0.1:4400     # the web UI (embedded in the daemon binary)
```

The UI is served from the daemon itself — no separate web server. For UI
development against a running daemon, run Vite locally (it proxies `/api` and
`/mcp` to `:4400`); to hot-swap a built dist into a running container without a
rebuild, set `WORKTREEDB_WEB_DIST` to an absolute disk path.
```

Add one row to the Configuration table:

```markdown
| `WORKTREEDB_WEB_DIST` | _(unset → embedded UI)_ | absolute path to serve the web UI from disk instead of the embedded build |
```

- [ ] **Step 4: Add a web note to `AGENTS.md`**

In `AGENTS.md`, extend the architecture paragraph's final sentence (after "published ports are owned by the daemon.") with:

```markdown
The React/Mantine web UI is embedded in the binary (`web/`, `//go:embed`) and
served at `/` behind a SPA fallback that never shadows `/api` or `/mcp`;
`WORKTREEDB_WEB_DIST` overrides it with a disk dist for development.
```

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add compose.yaml README.md AGENTS.md
git commit -m "docs: compose path, embedded-UI + dogfood notes"
```

---

### Task 6: devdb parity gate — add `web-ui` to the cross-run (THE milestone acceptance)

Works in **`~/git/devdb`** with **devdb conventions (WITH the Co-Authored-By trailer)**. `web-ui.test.ts` is image-agnostic (no state injection, no helper change needed — unlike M3's pg-builds), so this is purely: add it to the cross-run gate, run the full 16-file suite against `worktreedb:dev` with unmodified assertions, and record the result. **This is the M4 milestone acceptance.**

**Files:**
- Modify: `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`

**Interfaces:**
- Consumes: `worktreedb:dev` (Task 3), the unmodified reference suite.
- Produces: the recorded full-suite green result — the parity gate.

- [ ] **Step 1: Confirm the image under test is the M4 build**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
```
Expected: image built from the worktree holding Tasks 1–3.

- [ ] **Step 2: Run the new web-ui file against the Go image (incremental gate)**

```bash
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run web-ui
```
Expected: **1 file / 3 tests pass** — GET `/` → 200 `text/html` + `id="root"`; the fingerprinted `/assets/*.js` → 200 `/javascript/`; a deep link `/projects/<uuid>` → 200 `id="root"` AND `/api/definitely-not-a-route` → 404 `application/json`. **Assertions unmodified.** (`web-ui.test.ts` is image-agnostic — no env-prefix branching, no state injection.)

- [ ] **Step 3: Run the FULL 16-file suite (the parity gate)**

```bash
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run acceptance projects branching endpoints timetravel events \
    boot restart unclean-restart retry-helper storcon-major-guard \
    pg-builds mcp mcp-handshake mcp-concurrency web-ui
```
Expected: **16 files green.** (Sequential; budget 60–90 min — `pg-builds` alone is ~15–20 min. A single red under cumulative machine load: re-run that file isolated before treating it as real — this is documented flake behavior, not a parity failure.)

- [ ] **Step 4: Record the M4 gate in the cross-run doc**

In `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`, replace the trailer line `Later gates: web-ui at M4 (full suite = the parity gate).` with:

```markdown
## M4 gate — the FULL parity suite (16 files, assertions unmodified)

M2's 11 + M3's 4 + web-ui. web-ui is image-agnostic (no state injection): it
GETs / (200 text/html, id=root), the fingerprinted /assets/*.js (200,
javascript), a deep link (200, id=root), and /api/<miss> (404, JSON).

    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run acceptance projects branching endpoints timetravel \
        events boot restart unclean-restart retry-helper storcon-major-guard \
        pg-builds mcp mcp-handshake mcp-concurrency web-ui

web-ui incremental 2026-07-XX: <record the 3/3 summary line here>
Full 16-file suite 2026-07-XX: <record the summary line here>

This is the M4 milestone acceptance: full functional parity with the reference
daemon, reference assertions unmodified.
```

Fill both `2026-07-XX` result lines with the actual run summaries from Steps 2–3.

- [ ] **Step 5: Commit (devdb repo — devdb conventions, WITH trailer)**

```bash
cd ~/git/devdb && git add docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md
git commit -m "test(integration): M4 parity gate — full 16-file suite vs worktreedb:dev

Adds web-ui to the cross-run (image-agnostic, no state injection) and records
the full reference suite green against the Go image with unmodified assertions
— the M4 milestone acceptance.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Go-native integration smoke for the served UI (OPTIONAL; default: include)

> **OPTIONAL** but consistent with M1–M3, which each ship a `//go:build integration` container-level smoke alongside the TS parity oracle. **Default: include.** The M4 *acceptance* is Task 6's TS suite; this is the Go-side belt-and-suspenders (and keeps the integration suite exercising the real image end-to-end).

**Files:**
- Create: `integration/web_test.go`

**Interfaces:**
- Consumes: `startContainer(t)`, `baseURL`, `image()` (existing helpers in `integration/boot_test.go`).
- Produces: a container-level test asserting the served UI + SPA fallback + reserved passthrough.

- [ ] **Step 1: Write the test**

Create `integration/web_test.go`:

```go
//go:build integration

package integration

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

var assetRe = regexp.MustCompile(`/assets/[^"]+\.js`)

func TestWebUISmoke(t *testing.T) {
	_, base := startContainer(t)

	// (1) app shell at /
	res, err := http.Get(base + "/")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("GET /: status=%v err=%v", res, err)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("GET / content-type = %q", ct)
	}
	html, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(html), `id="root"`) {
		t.Fatalf("GET / body missing id=root")
	}

	// (2) the fingerprinted asset index.html references
	asset := assetRe.FindString(string(html))
	if asset == "" {
		t.Fatal("no /assets/*.js reference in index.html")
	}
	ares, err := http.Get(base + asset)
	if err != nil || ares.StatusCode != 200 {
		t.Fatalf("GET %s: status=%v err=%v", asset, ares, err)
	}
	if ct := ares.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("asset content-type = %q", ct)
	}

	// (3) SPA fallback on a deep link, but /api stays a JSON 404
	deep, err := http.Get(base + "/projects/00000000-0000-0000-0000-000000000000")
	if err != nil || deep.StatusCode != 200 {
		t.Fatalf("deep link: status=%v err=%v", deep, err)
	}
	dbody, _ := io.ReadAll(deep.Body)
	if !strings.Contains(string(dbody), `id="root"`) {
		t.Fatalf("deep link did not serve the shell")
	}
	miss, err := http.Get(base + "/api/definitely-not-a-route")
	if err != nil {
		t.Fatal(err)
	}
	if miss.StatusCode != 404 || !strings.Contains(miss.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("unknown /api route: status=%d ct=%q", miss.StatusCode, miss.Header.Get("Content-Type"))
	}
}
```

- [ ] **Step 2: Run it against the image**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && go test -tags integration ./integration/ -run TestWebUISmoke -count=1 -timeout 10m
```
Expected: PASS (serves the real embedded UI; mirrors `web-ui.test.ts` Go-side).

- [ ] **Step 3: Commit**

```bash
cd ~/git/worktreedb && git add integration/web_test.go
git commit -m "test(integration): container-level web UI serving smoke"
```

---

## M4 gate (the full reference suite — all 16 files pass, assertions unmodified)

`acceptance` · `projects` · `branching` · `endpoints` · `timetravel` · `events` · `boot` · `restart` · `unclean-restart` · `retry-helper` · `storcon-major-guard` · `pg-builds` · `mcp` · `mcp-handshake` · `mcp-concurrency` · **`web-ui`**

## Invocation

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run acceptance projects branching endpoints timetravel events \
    boot restart unclean-restart retry-helper storcon-major-guard \
    pg-builds mcp mcp-handshake mcp-concurrency web-ui
```

## Milestone acceptance (spec §8-M4)

- `web/`: `pnpm build` + `pnpm test` green; `grep -riE 'devdb' web/ --include='*.ts' --include='*.tsx' --include='*.html' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist` empty (the D2-sanctioned renamed strings are the exception, and there are none left).
- worktreedb: `go build ./... && go vet ./...` clean; `go test ./... -race -count=1` green; `golangci-lint run` 0 issues; `go test -tags integration ./integration/...` green (M1/M2/M3 cases + the web smoke).
- **The parity gate: the FULL 16-file reference suite green against `worktreedb:dev` with unmodified assertions** (Task 6 Steps 2–3, recorded in the cross-run doc). This is full functional parity.
- Clean-history spot check before merging the worktree branch:
  `cd ~/git/worktreedb && git log --format=%B <base>..HEAD | grep -iE 'devdb|neond|matisiekpl|typescript|fastify|co-authored'` — empty EXCEPT the single `feat: web ui` subject line has no such tokens either (the app's renamed content lives in files, not the message);
  `grep -riE 'devdb|neond|matisiekpl|typescript|fastify' --include='*.go' --include='*.md' . | grep -v neondatabase` — empty (the `neondatabase/neon` oracle mentions excepted);
  `grep -riE 'devdb' web/ --include='*.ts' --include='*.tsx' --include='*.html' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist` — empty.
- **Dogfood cutover:** `docker compose up -d --build`, open `http://127.0.0.1:4400`, drive a create-project → branch → connect loop through the UI, then adopt `worktreedb:dev` on `:4400` as the daily local database (spec §8-M4).

## Deferred out of M4 (recorded, deliberate)

- **Suspend + wake** — M5 (first post-parity; the idle sweeper, wake-on-accept, and the `suspended` status DTO field).
- **The parked Octopus-style UI restyle** — post-parity backlog (spec §11); M4 keeps the copied look by decision D2.
- **A multi-stage slim runtime for the web tooling** — the web-build stage is already discarded (only its `dist` is COPYed forward), so no web tooling ships in the runtime image; further engine-base slimming is a devdb-pipeline backlog item (spec §11).
- **Any REST/API change** — frozen this milestone by constraint; the app consumes `/api/*` byte-unchanged.
- **Dual-stack listeners** (the `localhost`-vs-`127.0.0.1` papercut) — post-parity backlog; needs a compose publish change too.

## Execution handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two gates per task (independent reviewer + review-broker scan, severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` pointing into the worktree). Implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — never on main. Every implementer/fix dispatch for Tasks 1–5 & 7 carries the **no-AI-trailer + clean-content** rules verbatim; Task 6 runs in `~/git/devdb` with devdb conventions (trailer kept). Task 1 is one squashed `feat: web ui` commit — its review checks rename completeness + clean content + build/test green, not per-file TDD.

**2. Inline Execution** — superpowers:executing-plans, batch execution with checkpoints.
