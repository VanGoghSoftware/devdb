# Worktree DB M5 — Suspend + wake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first post-parity feature — auto-suspend idle branch endpoints and wake-on-connect — so an idle branch frees its compute's port + directory while keeping its published slot dial-able, and the next connection transparently cold-starts the compute against the same branch data.

**Architecture:** The idle signal is the daemon's OWN L4-proxy live connection count (`proxy.ConnConnt` already tracked, unconsumed since M2), never a compute_ctl probe. A background sweeper (~tick) finds converged-running endpoints idle for ≥ a configured timeout and, through one atomic `Proxy.SuspendIfIdle` (which closes the sweeper-vs-arriving-connection race under the slot's mutex) plus a job on the branch's owner lane, stops the compute and commits `status_endpoint='suspended'` while `spec_endpoint` stays `'running'`. Wake is a connection: the proxy `splice` holds the accepted conn, nudges the branch owner, and waits for `Proxy.Resume` to retarget the still-bound listener onto a freshly cold-started compute — the owner's own converge, seeing `status=suspended && ConnCount>0`, drives back to running. Everything (sweep-suspend, wake, user stop/start, delete, restore) funnels through the one per-branch owner lane; the only cross-lane state is the proxy's `live` count, made race-safe by `SuspendIfIdle`. Suspend is cold-start (full `Computes.Stop`/`Computes.Start`, no new compute-manager path — the compute is stateless, data lives in the pageserver). This milestone AMENDS the 2026-07-02 product spec's "no auto-suspend in v1" non-goal (recorded explicitly, T8). Master spec: `docs/superpowers/specs/2026-07-11-worktreedb-go-rewrite-design.md` (D8 line 35; §4/§6 lines 112-130; §8-M5 lines 176-181).

**Tech Stack:** Go 1.25 stdlib only — `time`, `sync`, `sync/atomic`, `context`, `net`, `log/slog` (NO new module; `go.mod` untouched; no `go mod tidy`). `modernc.org/sqlite` (already present) via the existing store. `jackc/pgx/v5/pgconn` (already present) for the integration test's client dial. Web (copied app, already present): React 19 / Mantine 9 / zod 3 / vitest 4. `testcontainers-go` (integration only, already present). The reference parity suite runs workshop-side (`~/git/devdb/tests/integration`, TypeScript/vitest).

## Global Constraints

- **Repo split:** all product code lands in `~/git/worktreedb` (module `github.com/VanGoghSoftware/worktreedb`, `go 1.25.0`); implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — **never on its `main`** (base = `main@83fb6f1` or later). Commands below say `cd ~/git/worktreedb`; substitute the worktree path. **T7's devdb portion and all of T8's spec-amendment step are `~/git/devdb` (workshop) work.** This plan and the ledger stay in devdb — never commit them to worktreedb.
- **Commits (worktreedb):** conventional commits, **NO AI co-author trailers of any kind** (spec D4) — this overrides any harness default. The devdb-repo commits (T7 parity record, T8 spec amendment) keep devdb's usual `Co-Authored-By` trailer.
- **Clean-history rule (spec §3):** worktreedb code, comments, tests, commit messages, and docs NEVER mention the TypeScript implementation, the devdb repo, `matisiekpl/neond`, Fastify, or "parity with the old daemon". The **one required exception** in this milestone is the single `// oracle: neon …` citation proving compute_ctl has no connection count (T3, verbatim below) — that citation is expected and must be present. The web edits (T6) touch the copied app but are **normal, non-squashed worktreedb commits** (the enum value `"suspended"` and a color entry are clean content).
- **go.mod is frozen:** stdlib only (`time`, `sync`, `sync/atomic`, `context`). `go get` is not run; **no `go mod tidy`**. Any temptation to add a dependency is a design error in this milestone.
- **The `-race` tests are load-bearing.** The suspend/wake concurrency crux (T2, T3) MUST be covered by `go test -race` tests; a green `-race` run is part of acceptance, not optional polish.
- **Do NOT touch `suspend_timeout_seconds` in the ComputeSpec** (`internal/compute/spec.go`, value `-1`). That is a compute-side knob; M5's policy lives entirely in the daemon. Leave it at `-1`.
- **Acceptance (spec §8-M5):** `go build ./... && go vet ./...` clean; `go test ./... -race -count=1` green (incl. the new race tests); `golangci-lint run` 0 issues; `go test -tags integration ./integration/...` green including a new suspend/wake container test; **the full reference parity suite green vs `worktreedb:dev` with auto-suspend DISABLED** (`WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0` injected by the cross-run harness so the additive feature never enters the parity gate — spec D8), assertions unmodified; clean-history spot check empty.
- **Execution:** SDD, two gates per task (independent reviewer + review-broker scan; severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` pointing into the worktree).

## File map (M5 end state — new/modified only)

```
worktreedb repo:
internal/config/config.go              MODIFY (T1): + SuspendTimeout field + suspendTimeoutEnv parser (0=never)
internal/config/config_test.go         MODIFY (T1): default 300, 0 allowed, negative/non-int rejected
internal/proxy/proxy.go                MODIFY (T2): endpoint.{branchID,target,suspended,resumed}; SuspendIfIdle/
                                        Resume/Unsuspend/SetWake; splice hold-for-wake; acceptLoop/Bind target-field
internal/proxy/proxy_test.go           MODIFY (T2): SuspendIfIdle race, hold-for-wake retarget, Release-unblocks,
                                        Unsuspend, timeout-drop, -race stress
internal/store/rows.go                 MODIFY (T3): + EndpointsByStatus(ctx, status)
internal/store/rows_test.go            MODIFY (T3): EndpointsByStatus filter test
internal/service/core.go               MODIFY (T3): ProxyAPI += SuspendIfIdle/Resume/Unsuspend
internal/service/endpoints.go          MODIFY (T3): suspended resting arm; wakeEndpoint; suspendEndpointLocked;
                                        EndpointDialable helper; detailOf suspended (T5)
internal/service/endpoints_test.go     MODIFY (T3): park, wake-by-conn, wake-by-start, crash-not-detected, resting
internal/service/fakes_test.go         MODIFY (T3): fakeProxy += conns/suspended + SuspendIfIdle/Resume/Unsuspend
internal/service/sweeper.go            CREATE (T4): Sweeper (idle tracking off ConnCount, tickFor, sweepOnce, Run)
internal/service/sweeper_test.go       CREATE (T4): idle-duration → suspend; busy resets; SuspendIfIdle-abort; GC
internal/api/dto.go                    MODIFY (T5): toBranchDTO Port surfaced for suspended (verified e2e by T7)
internal/service/timetravel.go         MODIFY (T5): restore treats suspended like running (wasRunning)
internal/service/timetravel_test.go    MODIFY (T5): restore of a suspended endpoint stops+restarts it
cmd/worktreedbd/main.go                MODIFY (T3 wake wiring; T4 sweeper start+join; T5 in-use supplier)
web/src/shared.ts                      MODIFY (T6): EndpointStatusSchema += "suspended"
web/src/tree/chips.tsx                 MODIFY (T6): STATUS_COLOR += suspended; label arm
web/src/tree/BranchActionsMenu.tsx     MODIFY (T6): Stop action treats suspended like running
web/src/drawer/BranchDrawer.tsx        MODIFY (T6): Stop button treats suspended like running
integration/suspend_test.go            CREATE (T7): container suspend→wake→data-survives
README.md                              MODIFY (T8): suspend/wake section + WORKTREEDB_SUSPEND_TIMEOUT_SECONDS row
AGENTS.md                              MODIFY (T8): suspend/wake note in the architecture paragraph

devdb repo (workshop):
tests/integration/helpers/container.ts MODIFY (T7): inject WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0 for the Go cross-run
docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md  MODIFY (T7): M5 parity record (suspend disabled)
docs/superpowers/specs/2026-07-02-devdb-design.md       MODIFY (T8): amend the "no auto-suspend in v1" non-goal
```

**Task dependency order:** T1 → T2 → T3 → T4 → {T5, T6} → T7 → T8. T2 (proxy primitives) and T3 (converge + state) are the concurrency core and must land before the sweeper (T4). T5 (surfacing/carry-throughs) and T6 (web) are independent once T3 lands. T7 needs the full image (all prior tasks). T8 is documentation.

---

### Task 1: Config — `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS` (default 300, 0 = never)

Add the one new env knob. The existing `portEnv` rejects `< 1`; auto-suspend needs `0` to mean "disabled", so this needs its own parser that ALLOWS `0` and rejects only negatives / non-integers.

**Files:**
- Modify: `internal/config/config.go`, `internal/config/config_test.go`

**Interfaces:**
- Consumes: the `Load(getenv func(string) string)` pattern already in `config.go`.
- Produces: `config.Config.SuspendTimeout time.Duration` — `0` means auto-suspend disabled; otherwise the idle timeout. Later tasks read `cfg.SuspendTimeout` (T4 starts the sweeper only when `> 0`).

- [ ] **Step 1: Write the failing test**

In `internal/config/config_test.go`, add (the `valid()` / `env()` helpers already exist at the top of the file):

```go
func TestSuspendTimeout(t *testing.T) {
	// default: unset -> 5 minutes
	cfg, err := Load(env(valid()))
	if err != nil || cfg.SuspendTimeout != 300*time.Second {
		t.Fatalf("default SuspendTimeout = %v err = %v", cfg.SuspendTimeout, err)
	}
	// 0 disables auto-suspend and MUST be accepted (unlike a port, which rejects <1)
	m := valid()
	m["WORKTREEDB_SUSPEND_TIMEOUT_SECONDS"] = "0"
	cfg, err = Load(env(m))
	if err != nil || cfg.SuspendTimeout != 0 {
		t.Fatalf("zero SuspendTimeout = %v err = %v", cfg.SuspendTimeout, err)
	}
	// a positive value is seconds
	m["WORKTREEDB_SUSPEND_TIMEOUT_SECONDS"] = "45"
	cfg, err = Load(env(m))
	if err != nil || cfg.SuspendTimeout != 45*time.Second {
		t.Fatalf("45s SuspendTimeout = %v err = %v", cfg.SuspendTimeout, err)
	}
	// negative and non-integer are rejected
	for _, bad := range []string{"-1", "notnum", "1.5"} {
		m["WORKTREEDB_SUSPEND_TIMEOUT_SECONDS"] = bad
		if _, err := Load(env(m)); err == nil {
			t.Fatalf("WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=%q must error", bad)
		}
	}
}
```

`time` must be imported in `config_test.go` — add it to that file's import block.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -run TestSuspendTimeout -count=1`
Expected: **FAIL to compile** — `cfg.SuspendTimeout` undefined.

- [ ] **Step 3: Implement the field + parser**

In `internal/config/config.go`, add `"time"` to the import block. Add to the `Config` struct (after `WebDist string`):

```go
	// Auto-suspend idle-timeout: an endpoint with zero live proxy connections
	// for this long is parked (compute stopped, slot kept dial-able) by the
	// idle sweeper. 0 disables auto-suspend entirely. Default 5 minutes.
	SuspendTimeout time.Duration
```

In `Load`, before `return cfg, nil`:

```go
	suspend, err := suspendTimeoutEnv(getenv)
	if err != nil {
		return nil, err
	}
	cfg.SuspendTimeout = suspend
```

Add the parser near `portEnv` (note: unlike `portEnv`, `0` is VALID and means disabled):

```go
// suspendTimeoutEnv parses WORKTREEDB_SUSPEND_TIMEOUT_SECONDS. Default 300s
// (5 minutes). 0 is a valid value meaning "never auto-suspend" — so this
// deliberately does NOT reuse portEnv, which rejects anything below 1. Only a
// negative or non-integer value is an error.
func suspendTimeoutEnv(getenv func(string) string) (time.Duration, error) {
	raw := strings.TrimSpace(getenv("WORKTREEDB_SUSPEND_TIMEOUT_SECONDS"))
	if raw == "" {
		return 300 * time.Second, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("WORKTREEDB_SUSPEND_TIMEOUT_SECONDS must be an integer number of seconds, got: %q", raw)
	}
	if n < 0 {
		return 0, fmt.Errorf("WORKTREEDB_SUSPEND_TIMEOUT_SECONDS must be >= 0 (0 disables auto-suspend), got: %d", n)
	}
	return time.Duration(n) * time.Second, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/git/worktreedb && go test ./internal/config/ -count=1`
Expected: **PASS** (all config tests, including the new one).

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/config/config.go internal/config/config_test.go
git commit -m "feat(config): WORKTREEDB_SUSPEND_TIMEOUT_SECONDS (default 300, 0 disables)"
```

---

### Task 2: Proxy suspend/wake primitives (the concurrency core)

Turn the slot's dial target into a mutable, mutex-guarded `endpoint` field; add the atomic idle-check-and-flip (`SuspendIfIdle`), the retarget/clear-and-wake primitives (`Resume`, `Unsuspend`), the late-bound wake callback (`SetWake`), and the hold-for-wake in `splice`. This is the deepest, most race-sensitive task; its `-race` tests are load-bearing.

**Files:**
- Modify: `internal/proxy/proxy.go`, `internal/proxy/proxy_test.go`

**Interfaces:**
- Consumes: the existing `Proxy` (`Reserve`/`Bind`/`Release`/`ConnCount`/splice) and its test seams (`copyFn`, `sleepFn`).
- Produces (all consumed in T3/T4):
  - `func (p *Proxy) SuspendIfIdle(branchID string) bool` — under the slot's `e.mu`: if the slot is bound and `live == 0`, mark it suspended (listener STAYS bound) and return `true`; otherwise return `false` (abort). This is the atomic that closes the sweeper-vs-arriving-connection race.
  - `func (p *Proxy) Resume(branchID string, computePort int) error` — swap the slot's dial target to the new compute port, clear suspended, wake every held splice. Error if the branch holds no slot.
  - `func (p *Proxy) Unsuspend(branchID string)` — clear suspended and wake held splices WITHOUT changing the target (the back-out when a suspend decision is abandoned but the compute is still up). No-op if not suspended.
  - `func (p *Proxy) SetWake(fn func(branchID string))` — late-bind the callback `splice` fires when it holds a connection on a suspended slot (production: `owner.Nudge()`).

- [ ] **Step 1: Write the failing tests**

Append to `internal/proxy/proxy_test.go` (the `echoBackend`, `freeRange`, `testLog` helpers already exist):

```go
// dialAndHold opens a client connection to the slot and returns it without
// writing — the caller drives the splice's hold/wake timing.
func dialAndHold(t *testing.T, slot int) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", slot))
	if err != nil {
		t.Fatalf("dial slot %d: %v", slot, err)
	}
	return c
}

// roundTrip proves the splice is live end-to-end against an echoBackend.
func roundTrip(t *testing.T, c net.Conn, msg string) string {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(buf[:n])
}

func TestSuspendIfIdleTrueWhenNoConns(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	port, closeB := echoBackend(t)
	defer closeB()
	slot, _ := p.Reserve("b", nil)
	if err := p.Bind("b", port); err != nil {
		t.Fatal(err)
	}
	defer p.Release("b")
	if !p.SuspendIfIdle("b") {
		t.Fatal("idle bound slot must suspend")
	}
	if p.SuspendIfIdle("b") {
		t.Fatal("already-suspended slot must not re-suspend")
	}
	_ = slot
}

func TestSuspendIfIdleFalseWithLiveConn(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	port, closeB := echoBackend(t)
	defer closeB()
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", port)
	defer p.Release("b")
	c := dialAndHold(t, slot)
	defer c.Close()
	if got := roundTrip(t, c, "hi"); got != "echo:hi" {
		t.Fatalf("round trip = %q", got)
	}
	// a live connection is registered -> suspend must abort
	if p.SuspendIfIdle("b") {
		t.Fatal("slot with a live connection must not suspend")
	}
}

func TestHoldForWakeResumeRetargets(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	portA, closeA := echoBackend(t) // the pre-suspend backend (goes away on suspend)
	defer closeA()
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", portA)
	defer p.Release("b")

	var woke atomic.Int32
	p.SetWake(func(branchID string) {
		if branchID == "b" {
			woke.Add(1)
		}
	})
	if !p.SuspendIfIdle("b") {
		t.Fatal("suspend")
	}

	// A connection to the suspended slot is HELD: it fires the wake callback and
	// blocks until Resume retargets. Prove it does not complete a round trip yet.
	c := dialAndHold(t, slot)
	defer c.Close()
	// Give the accept+splice a moment to register and hold.
	deadline := time.Now().Add(2 * time.Second)
	for woke.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if woke.Load() == 0 {
		t.Fatal("held connection did not fire the wake callback")
	}

	// Cold-start a NEW backend and Resume onto it; the held conn now dials the
	// new target (proves the retarget, not the stale suspended target).
	portB, closeB := echoBackend(t)
	defer closeB()
	if err := p.Resume("b", portB); err != nil {
		t.Fatal(err)
	}
	if got := roundTrip(t, c, "wake"); got != "echo:wake" {
		t.Fatalf("post-wake round trip = %q", got)
	}
}

func TestReleaseUnblocksHeldConn(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	portA, closeA := echoBackend(t)
	defer closeA()
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", portA)
	p.SetWake(func(string) {})
	if !p.SuspendIfIdle("b") {
		t.Fatal("suspend")
	}
	c := dialAndHold(t, slot)
	defer c.Close()
	time.Sleep(50 * time.Millisecond) // let it register + hold

	// Release must unblock the held splice promptly (Release deletes the slot);
	// the client conn is closed, so a read returns quickly, NOT after wakeBudget.
	done := make(chan struct{})
	go func() { p.Release("b"); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Release hung on a held connection")
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Read(make([]byte, 8)); err == nil {
		t.Fatal("held connection must be dropped when the slot is released")
	}
}

func TestUnsuspendWakesWithoutRetarget(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	portA, closeA := echoBackend(t) // stays UP: Unsuspend keeps the current target
	defer closeA()
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", portA)
	defer p.Release("b")
	p.SetWake(func(string) {})
	if !p.SuspendIfIdle("b") {
		t.Fatal("suspend")
	}
	c := dialAndHold(t, slot)
	defer c.Close()
	time.Sleep(50 * time.Millisecond)
	p.Unsuspend("b") // back-out: the compute never stopped; dial the current target
	if got := roundTrip(t, c, "ok"); got != "echo:ok" {
		t.Fatalf("post-unsuspend round trip = %q", got)
	}
}

func TestHoldForWakeTimesOut(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	portA, closeA := echoBackend(t)
	defer closeA()
	// Force the wake budget to fire immediately so the drop path is fast.
	fired := make(chan time.Time, 1)
	fired <- time.Now()
	p.afterFn = func(time.Duration) <-chan time.Time { return fired }
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", portA)
	defer p.Release("b")
	p.SetWake(func(string) {})
	if !p.SuspendIfIdle("b") {
		t.Fatal("suspend")
	}
	c := dialAndHold(t, slot)
	defer c.Close()
	// No Resume ever comes -> the held conn is dropped when the budget fires.
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 8)); err == nil {
		t.Fatal("a wake that never completes must drop the held connection")
	}
}

// TestSuspendWakeRace stresses SuspendIfIdle / Resume / splice concurrently:
// under -race this must stay clean, and no dial that completes may observe a
// torn target. Run with: go test ./internal/proxy/ -race -run TestSuspendWakeRace
func TestSuspendWakeRace(t *testing.T) {
	rng := freeRange(t, 1)
	p := New(rng, testLog())
	port, closeB := echoBackend(t)
	defer closeB()
	slot, _ := p.Reserve("b", nil)
	_ = p.Bind("b", port)
	defer p.Release("b")
	p.SetWake(func(string) {})

	var wg sync.WaitGroup
	// suspend/resume churn
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			if p.SuspendIfIdle("b") {
				p.Resume("b", port)
			}
		}
	}()
	// concurrent dials
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", slot))
				if err != nil {
					continue
				}
				_ = c.SetDeadline(time.Now().Add(2 * time.Second))
				_, _ = c.Write([]byte("x"))
				_, _ = c.Read(make([]byte, 16))
				_ = c.Close()
			}
		}()
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/git/worktreedb && go test ./internal/proxy/ -run 'TestSuspend|TestHold|TestRelease|TestUnsuspend' -count=1`
Expected: **FAIL to compile** — `SuspendIfIdle`, `Resume`, `Unsuspend`, `SetWake`, `p.afterFn` are undefined.

- [ ] **Step 3: Add the endpoint fields + wake/timeout seams**

In `internal/proxy/proxy.go`, extend the `endpoint` struct (add the four fields; keep the existing ones):

```go
type endpoint struct {
	slot     int
	branchID string // immutable after Reserve; splice hands it to the wake callback

	mu       sync.Mutex
	listener net.Listener
	conns    map[net.Conn]struct{}
	closed   bool

	// target/suspended/resumed are all guarded by mu. target is the current
	// dial address — a MUTABLE field now (was a captured acceptLoop local) so
	// Resume can retarget a bound listener without closing it. suspended keeps
	// the listener bound but parks arriving splices on resumed; Resume/Unsuspend/
	// Release close-and-replace resumed to broadcast "re-check your state".
	target    string
	suspended bool
	resumed   chan struct{}

	live atomic.Int64 // live client connections — the suspend/wake idle signal
}
```

Extend the `Proxy` struct (add `wake` + `afterFn` after the existing test seams):

```go
	// wake is fired by splice when it holds a connection on a suspended slot —
	// late-bound (SetWake) because the owner registry is constructed after the
	// proxy. Guarded by p.mu (set once at boot, read per held connection).
	wake func(branchID string)
	// afterFn is the wake-timeout seam (time.After in production) so tests can
	// force the drop-on-timeout path without waiting out wakeBudget.
	afterFn func(d time.Duration) <-chan time.Time
```

In `New`, initialize `afterFn`:

```go
func New(rng config.PortRange, log *slog.Logger) *Proxy {
	return &Proxy{
		rng: rng, log: log,
		bySlot: map[int]*endpoint{}, byBranch: map[string]*endpoint{},
		copyFn: io.Copy, sleepFn: time.Sleep, afterFn: time.After,
	}
}
```

Add the wake-budget constant near `dialTimeout`:

```go
// wakeBudget bounds how long a splice holds an accepted connection waiting for
// a suspended slot to be woken (Resume). It must comfortably exceed a compute
// cold-start; if it fires, the wake never completed (e.g. the compute failed to
// start) and the held connection is dropped rather than hung forever.
const wakeBudget = 60 * time.Second
```

- [ ] **Step 4: Set branchID + resumed in Reserve; make target a field in Bind; drop the acceptLoop/splice target arg**

In `Reserve`, construct the endpoint with the new fields (find the `e := &endpoint{...}` line):

```go
	e := &endpoint{slot: slot, branchID: branchID, conns: map[net.Conn]struct{}{}, resumed: make(chan struct{})}
```

In `Bind`, set `e.target` (and clear any stale suspended) under `e.mu` instead of passing `target` to the goroutine. Replace the target-local handling:

```go
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return fmt.Errorf("proxy: branch %s was released during bind", branchID)
	}
	if e.listener != nil {
		e.mu.Unlock()
		return fmt.Errorf("proxy: branch %s is already bound on slot %d", branchID, e.slot)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", e.slot))
	if err != nil {
		e.mu.Unlock()
		return fmt.Errorf("proxy: bind slot %d: %w", e.slot, err)
	}
	e.listener = ln
	e.target = fmt.Sprintf("127.0.0.1:%d", computePort) // mutable field; Resume retargets it
	e.suspended = false                                 // a fresh bind is never suspended
	e.mu.Unlock()

	go p.acceptLoop(e, ln)
	p.log.Debug("proxy: bound slot", "branch", branchID, "slot", e.slot, "target", e.target)
	return nil
```

(Remove the earlier `target := fmt.Sprintf(...)` local at the top of `Bind`.)

Change `acceptLoop` to drop the `target` parameter:

```go
func (p *Proxy) acceptLoop(e *endpoint, ln net.Listener) {
	backoff := acceptBackoffMin
	for {
		client, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			p.log.Warn("proxy: accept failed, retrying", "slot", e.slot, "err", err, "backoff", backoff)
			p.sleepFn(backoff)
			backoff = min(backoff*2, acceptBackoffMax)
			continue
		}
		backoff = acceptBackoffMin
		go p.splice(e, client)
	}
}
```

- [ ] **Step 5: Rework `splice` to register, hold-for-wake if suspended, then dial the current target**

Replace the head of `splice` (the register + dial section, up to `backend = b`) so it reads `e.target` under `e.mu` and holds when suspended. The copier machinery below `backend = b` is UNCHANGED:

```go
func (p *Proxy) splice(e *endpoint, client net.Conn) {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		_ = client.Close()
		return
	}
	e.conns[client] = struct{}{}
	e.live.Add(1)
	suspended := e.suspended
	target := e.target
	e.mu.Unlock()

	var backend net.Conn
	defer func() {
		e.mu.Lock()
		delete(e.conns, client)
		if backend != nil {
			delete(e.conns, backend)
		}
		e.live.Add(-1)
		e.mu.Unlock()
		_ = client.Close()
		if backend != nil {
			_ = backend.Close()
		}
	}()

	// A connection that arrives on a suspended slot is HELD: fire the wake
	// callback (which nudges the branch owner) and block until Resume retargets
	// (or Release/timeout drops us). live was already incremented above, so a
	// concurrent SuspendIfIdle sees live>0 and aborts — this connection can
	// never be black-holed by a suspend that races it.
	if suspended {
		var ok bool
		target, ok = p.holdForWake(e)
		if !ok {
			return // released or wake budget exhausted — deferred cleanup runs
		}
	}

	b, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		p.log.Warn("proxy: backend dial failed", "slot", e.slot, "target", target, "err", err)
		return
	}
	backend = b

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.conns[backend] = struct{}{}
	e.mu.Unlock()

	// ---- unchanged copier machinery from here down (done chan, copyOneWay) ----
	done := make(chan struct{}, 2)
	copyOneWay := func(dst, src net.Conn) {
		defer func() {
			if r := recover(); r != nil {
				p.log.Error("proxy: splice copier panicked", "slot", e.slot, "target", target, "panic", r)
				_ = client.Close()
				_ = backend.Close()
			}
			done <- struct{}{}
		}()
		_, _ = p.copyFn(dst, src)
		halfClose(dst)
	}
	go copyOneWay(backend, client)
	go copyOneWay(client, backend)
	<-done
	<-done
}
```

Add `holdForWake` (the bounded hold + fresh-target return) after `splice`:

```go
// holdForWake fires the wake callback once, then blocks until the slot is
// resumed (returns the fresh target, true), released/closed (returns "", false),
// or the wake budget is exhausted (returns "", false). It never reads target
// except under e.mu, so a concurrent Resume's retarget is observed atomically.
func (p *Proxy) holdForWake(e *endpoint) (string, bool) {
	p.mu.Lock()
	fn := p.wake
	p.mu.Unlock()
	if fn != nil {
		fn(e.branchID) // production: owner.Nudge() — non-blocking by contract
	}
	timeout := p.afterFn(wakeBudget)
	for {
		e.mu.Lock()
		if e.closed {
			e.mu.Unlock()
			return "", false
		}
		if !e.suspended {
			t := e.target
			e.mu.Unlock()
			return t, true
		}
		ch := e.resumed
		e.mu.Unlock()
		select {
		case <-ch: // Resume/Unsuspend/Release broadcast — re-check under mu
		case <-timeout:
			return "", false
		}
	}
}
```

- [ ] **Step 6: Add SuspendIfIdle / Resume / Unsuspend / SetWake, and broadcast on Release**

Add the four primitives (place them after `ConnCount`):

```go
// SuspendIfIdle atomically parks a bound, idle slot: under e.mu, if the slot is
// bound and has ZERO live connections, it is marked suspended (the listener
// stays BOUND — the port keeps accepting, and arriving connections will hold
// for wake) and true is returned. If a connection is present, or the slot is
// unbound/closed/already suspended, it returns false and changes nothing. This
// is the single atomic that closes the sweeper-vs-arriving-connection race:
// splice increments live under the SAME e.mu, so a connection that registered
// first makes this abort, and one that registers after sees suspended and holds.
func (p *Proxy) SuspendIfIdle(branchID string) bool {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	p.mu.Unlock()
	if !ok {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed || e.listener == nil || e.suspended {
		return false
	}
	if e.live.Load() != 0 {
		return false
	}
	e.suspended = true
	return true
}

// Resume retargets a suspended slot onto a freshly started compute and wakes
// every held splice: they re-check, observe !suspended, and dial the new target.
// Keeps the listener bound throughout (never Release+Bind, which would drop held
// connections). Errors if the branch holds no slot.
func (p *Proxy) Resume(branchID string, computePort int) error {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("proxy: branch %s holds no slot to resume", branchID)
	}
	e.mu.Lock()
	if !e.closed {
		e.target = fmt.Sprintf("127.0.0.1:%d", computePort)
		e.suspended = false
		close(e.resumed)
		e.resumed = make(chan struct{})
	}
	e.mu.Unlock()
	return nil
}

// Unsuspend clears the suspended flag WITHOUT retargeting and wakes held
// splices — the back-out when a suspend decision is abandoned but the compute
// is still up (held connections dial the unchanged current target). No-op if
// the branch holds no slot or the slot is not suspended.
func (p *Proxy) Unsuspend(branchID string) {
	p.mu.Lock()
	e, ok := p.byBranch[branchID]
	p.mu.Unlock()
	if !ok {
		return
	}
	e.mu.Lock()
	if !e.closed && e.suspended {
		e.suspended = false
		close(e.resumed)
		e.resumed = make(chan struct{})
	}
	e.mu.Unlock()
}

// SetWake late-binds the callback splice fires when it holds a connection on a
// suspended slot. Set once at boot before any Bind serves traffic.
func (p *Proxy) SetWake(fn func(branchID string)) {
	p.mu.Lock()
	p.wake = fn
	p.mu.Unlock()
}
```

In `Release`, broadcast to any held splice so it unblocks promptly. Inside the `e.mu`-held section where `e.closed = true` is set, add the `resumed` broadcast (right after `e.closed = true`):

```go
	e.mu.Lock()
	e.closed = true // registration re-checks under e.mu: no conn slips past this sweep
	if e.resumed != nil {
		close(e.resumed) // wake any splice held for resume: it sees closed -> drops
		e.resumed = nil
	}
	ln := e.listener
	e.listener = nil
	// ... (unchanged: collect conns, e.listener = nil, etc.)
```

(`holdForWake` guards on `e.closed` first, so a nil `resumed` after Release is never selected on.)

- [ ] **Step 7: Run the proxy tests, then the full package with `-race`**

Run: `cd ~/git/worktreedb && go test ./internal/proxy/ -count=1`
Expected: **PASS** (new + existing).

Run: `cd ~/git/worktreedb && go test ./internal/proxy/ -race -count=1`
Expected: **PASS with no data races** (the `-race` stress `TestSuspendWakeRace` is the crux).

Run: `cd ~/git/worktreedb && go vet ./internal/proxy/ && golangci-lint run ./internal/proxy/...`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd ~/git/worktreedb && git add internal/proxy/proxy.go internal/proxy/proxy_test.go
git commit -m "feat(proxy): suspend/wake slot primitives with a held-connection wake path"
```

---

### Task 3: Owner converge, park + wake, and state (the in-lane heart)

Wire the proxy primitives into the branch owner's convergence: a `suspended` resting arm, the in-lane park action, the wake path (`suspended` → cold-start → `Resume` → `running`), the store query the sweeper/carry-throughs need, the widened `ProxyAPI`, and the wake-callback wiring in `main`.

**Files:**
- Modify: `internal/store/rows.go`, `internal/store/rows_test.go`, `internal/service/core.go`, `internal/service/endpoints.go`, `internal/service/endpoints_test.go`, `internal/service/fakes_test.go`, `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: `proxy.SuspendIfIdle/Resume/Unsuspend/SetWake` (T2); `store.CommitStatus` (generation-checked); `runtime.Owner.Nudge/Run`; the existing `convergeEndpoint`/`convergeToRunning`.
- Produces (consumed by T4/T5):
  - `func (s *Store) EndpointsByStatus(ctx context.Context, status string) ([]BranchRow, error)`.
  - `ProxyAPI` widened with `SuspendIfIdle(branchID string) bool`, `Resume(branchID string, computePort int) error`, `Unsuspend(branchID string)`.
  - `func (c *Core) suspendEndpointLocked(ctx context.Context, branchID string) error` — the in-lane park (re-check → `Computes.Stop` → commit `suspended`; re-nudge if a connection raced in).
  - `func EndpointDialable(status string) bool` — `status == "running" || status == "suspended"` (exported; reused by T5's DTO + detail).
  - `convergeToRunning` now handles a `suspended` row by cold-starting + `Resume` instead of `Release`+`Bind`.

- [ ] **Step 1: Add `EndpointsByStatus` (store) — failing test first**

In `internal/store/rows_test.go`, add (match the existing store-test bootstrap — the file already opens a temp store and creates a project/branch; reuse that helper. If the file's helper is named differently, adapt the setup line only):

```go
func TestEndpointsByStatus(t *testing.T) {
	st := open(t) // existing store-test helper (store_test.go): temp-dir *Store
	ctx := context.Background()
	p, _ := st.CreateProject(ctx, ProjectParams{ID: NewID(), Name: "p", PgMajor: 17})
	mk := func(name, status string) string {
		b, _ := st.CreateBranch(ctx, BranchParams{ID: NewID(), ProjectID: p.ID, Name: name, Slug: name, TimelineID: NewID()})
		_ = st.CommitStatus(ctx, "branches", b.ID, 1, func(tx *sql.Tx) error {
			return ApplyEndpointStatus(tx, b.ID, EndpointStatusUpdate{Endpoint: status})
		})
		return b.ID
	}
	runID := mk("r", "running")
	mk("s", "suspended")
	mk("x", "stopped")

	got, err := st.EndpointsByStatus(ctx, "running")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != runID {
		t.Fatalf("running endpoints = %+v", got)
	}
	sus, _ := st.EndpointsByStatus(ctx, "suspended")
	if len(sus) != 1 || sus[0].Name != "s" {
		t.Fatalf("suspended endpoints = %+v", sus)
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/store/ -run TestEndpointsByStatus -count=1`
Expected: **FAIL to compile** — `EndpointsByStatus` undefined.

- [ ] **Step 2: Implement `EndpointsByStatus`**

In `internal/store/rows.go`, add after `BranchesByParent`:

```go
// EndpointsByStatus returns every branch whose observed endpoint status matches
// — the idle sweeper reads "running" candidates, the build in-use guard reads
// "suspended" installs. Reuses branchQuery, so callers get full BranchRows.
func (s *Store) EndpointsByStatus(ctx context.Context, status string) ([]BranchRow, error) {
	return s.branchQuery(ctx,
		`SELECT `+branchCols+` FROM branches WHERE status_endpoint = ? ORDER BY created_at, id`, status)
}
```

Run: `cd ~/git/worktreedb && go test ./internal/store/ -run TestEndpointsByStatus -count=1`
Expected: **PASS**.

- [ ] **Step 3: Widen `ProxyAPI` and update the fake proxy**

In `internal/service/core.go`, extend the `ProxyAPI` interface:

```go
type ProxyAPI interface {
	Reserve(branchID string, sticky *int) (int, error)
	Bind(branchID string, computePort int) error
	Release(branchID string)
	ConnCount(branchID string) int64
	// M5 suspend/wake: SuspendIfIdle atomically parks an idle bound slot; Resume
	// retargets a suspended slot onto a new compute and wakes held connections;
	// Unsuspend clears a suspend decision without retargeting.
	SuspendIfIdle(branchID string) bool
	Resume(branchID string, computePort int) error
	Unsuspend(branchID string)
}
```

In `internal/service/fakes_test.go`, give `fakeProxy` a controllable conn count + suspended set, and implement the three methods. Change the struct + `ConnCount`, and append the methods:

```go
type fakeProxy struct {
	mu        sync.Mutex
	slots     map[string]int
	bound     map[string]int
	conns     map[string]int64 // test-settable live count per branch
	suspended map[string]bool
	min       int
	max       int
	reserves  int
}

func newFakeProxy(min, max int) *fakeProxy {
	return &fakeProxy{slots: map[string]int{}, bound: map[string]int{}, conns: map[string]int64{}, suspended: map[string]bool{}, min: min, max: max}
}
```

Replace `ConnCount` and add the methods:

```go
func (f *fakeProxy) ConnCount(branchID string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conns[branchID]
}

func (f *fakeProxy) SuspendIfIdle(branchID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, bound := f.bound[branchID]; !bound || f.conns[branchID] != 0 || f.suspended[branchID] {
		return false
	}
	f.suspended[branchID] = true
	return true
}

func (f *fakeProxy) Resume(branchID string, computePort int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bound[branchID] = computePort
	f.suspended[branchID] = false
	return nil
}

func (f *fakeProxy) Unsuspend(branchID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.suspended[branchID] = false
}
```

(Also set `f.conns[branchID]` in tests where a wake must be triggered — see Step 6.)

- [ ] **Step 4: Add the `suspended` resting arm + the `EndpointDialable` helper**

In `internal/service/endpoints.go`, add the exported helper near the top (after the connection-string helpers):

```go
// EndpointDialable reports whether an endpoint status has a live, dial-able
// slot: running, and suspended (a parked endpoint keeps its bound slot and
// wakes on connect). Used by the read model and the DTO so a suspended branch
// still surfaces its port and connection string.
func EndpointDialable(status string) bool {
	return status == "running" || status == "suspended"
}
```

In `convergeEndpoint`, extend the `converged` predicate with the suspended arm (insert the new line into the existing `converged :=` expression):

```go
		converged := b.ObservedGen == b.SpecGen &&
			((b.SpecEndpoint == "running" && b.StatusEndpoint == "running" && mgr == "running") ||
				// Parked: spec still wants running, the endpoint is suspended, and
				// nothing is knocking. A connection (ConnCount>0) breaks the rest
				// and drives convergeToRunning's wake path. The generation guard
				// (leading conjunct) means a user Start (which bumps spec) also
				// breaks it — so an explicit start wakes a parked endpoint too.
				(b.SpecEndpoint == "running" && b.StatusEndpoint == "suspended" && c.Proxy.ConnCount(b.ID) == 0) ||
				(b.SpecEndpoint == "running" && b.StatusEndpoint == "failed") ||
				(b.SpecEndpoint == "stopped" && (b.StatusEndpoint == "stopped" || b.StatusEndpoint == "failed") && mgr == "stopped"))
```

(The crash-detection block above it already keys on `b.StatusEndpoint == "running"`, so a suspended row — status `"suspended"` — never trips crash detection. No change there; this is the "compute crash while suspended is not crash-detected" property.)

- [ ] **Step 5: Add the wake path to `convergeToRunning`, and `wakeEndpoint`**

In `internal/service/endpoints.go`, make `convergeToRunning`'s FIRST statement route a suspended row to the wake path (before the `mgr == "running"` block):

```go
func (c *Core) convergeToRunning(ctx context.Context, b store.BranchRow, mgr string) error {
	gen := b.SpecGen
	// Waking a parked endpoint: the slot is still BOUND (a client may be held on
	// it), so a fresh compute is cold-started and the live listener RETARGETED —
	// never Release+Bind, which would drop the held connection. The compute is
	// stateless (data lives in the pageserver); same TenantID/TimelineID/pgbin
	// means the same branch data on a new dir + ephemeral port.
	if b.StatusEndpoint == "suspended" {
		return c.wakeEndpoint(ctx, b, gen)
	}
	if mgr == "running" {
		// ... unchanged existing body ...
```

Add `wakeEndpoint` (place it right after `convergeToRunning`):

```go
// wakeEndpoint cold-starts a parked endpoint and retargets its bound slot. It
// assumes the parked invariant (mgr stopped, slot bound+suspended) — guaranteed
// because suspend does Computes.Stop before committing "suspended" and the lane
// serializes wake against every other mutation. On any failure it releases the
// slot (dropping the held connection promptly instead of hanging it out to the
// wake budget) and records "failed", so a retry re-runs the normal start path.
func (c *Core) wakeEndpoint(ctx context.Context, b store.BranchRow, gen int64) error {
	slot, err := c.Proxy.Reserve(b.ID, b.PortSlot) // idempotent: returns the held slot
	if err != nil {
		return err
	}
	project, err := c.projectOr404(ctx, b.ProjectID)
	if err != nil {
		c.Proxy.Release(b.ID)
		c.commitFailed(ctx, b, gen, truncateErr(err))
		return err
	}
	pgbin, overridden, err := c.resolvePgbin(b.ID, project.PgMajor)
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
	if err := c.Proxy.Resume(b.ID, computePort); err != nil {
		c.Computes.Stop(b.ID)
		c.Proxy.Release(b.ID)
		c.commitFailed(ctx, b, gen, truncateErr(err))
		return err
	}
	if !overridden && c.NoteRun != nil {
		c.NoteRun(ctx, pgbin)
	}
	return c.commitEndpoint(ctx, b, gen, store.EndpointStatusUpdate{
		Endpoint: "running", Port: &slot, Pgbin: &pgbin, PortSlot: &slot,
	})
}
```

- [ ] **Step 6: Add the in-lane park action `suspendEndpointLocked`**

In `internal/service/endpoints.go`, add (place it after `convergeToStopped`). Note the oracle citation is REQUIRED here — it grounds the "idle count is ours, not compute_ctl's" decision:

```go
// suspendEndpointLocked parks a converged-running, idle endpoint. It runs INSIDE
// the branch lane (owner.Run, dispatched by the idle sweeper), which is why it
// commits status directly rather than through a spec bump: spec stays "running",
// only observed status becomes "suspended". The sweeper already flipped the
// proxy slot to suspended (keeping the listener bound); this frees the compute's
// port + directory and persists the parked state.
//
// The idle signal is the daemon's own live proxy connection count, never
// compute_ctl — the engine's compute has no connection count to read:
// oracle: neon libs/compute_api/src/responses.rs:143 (ComputeStatusResponse: no
// connection count) + compute_tools/src/http/server.rs:116 (/status JWT-gated).
//
// If a connection raced in after SuspendIfIdle (ConnCount>0), the compute is
// stopped and "suspended" committed anyway, then the lane is re-nudged so the
// next converge wakes it — the harmless suspend→wake flap the design accepts,
// never a dropped connection.
func (c *Core) suspendEndpointLocked(ctx context.Context, branchID string) error {
	b, ok, err := c.Store.BranchByID(ctx, branchID)
	if err != nil {
		return err
	}
	if !ok {
		return nil // deleted while the park was queued
	}
	// Only a CONVERGED running endpoint may be parked. If spec/status moved
	// (a user stop/restore, or a pending start) the sweeper's decision is stale
	// — that path already tore the slot down; nothing to do here.
	if b.SpecEndpoint != "running" || b.StatusEndpoint != "running" || b.ObservedGen != b.SpecGen {
		return nil
	}
	c.Computes.Stop(branchID) // frees the compute's port + dir; data is in the pageserver
	if err := c.commitEndpoint(ctx, b, b.SpecGen, store.EndpointStatusUpdate{
		Endpoint: "suspended", Port: b.StatusPort, Pgbin: b.StatusPgbin, PortSlot: b.PortSlot,
	}); err != nil {
		if errors.Is(err, store.ErrStaleGeneration) {
			return nil
		}
		return err
	}
	if c.Proxy.ConnCount(branchID) > 0 {
		if owner, ok := c.Owners.Get(branchID); ok {
			owner.Nudge() // own-lane Nudge: token consumed after this job returns
		}
	}
	return nil
}
```

- [ ] **Step 7: Write the converge tests (park / wake-by-conn / wake-by-start / crash-not-detected)**

In `internal/service/endpoints_test.go`, add these. They use the verified harness exactly as `TestStartEndpointHappyPath` does: `newTestCore(t)` → `tc.seedBranch(t, "p1", "b1")` (creates project+branch and registers the owner) → `tc.core.StartEndpoint(ctx, "b1")` drives it to running (the fake proxy records the bind, so `SuspendIfIdle("b1")` will succeed):

```go
func TestSuspendParksThenWakesOnConn(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Park it in-lane exactly as the sweeper would.
	owner, _ := tc.core.Owners.Get("b1")
	if err := owner.Run(ctx, func(ctx context.Context) error {
		return tc.core.suspendEndpointLocked(ctx, "b1")
	}); err != nil {
		t.Fatalf("park: %v", err)
	}
	b, _, _ := tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "suspended" || b.SpecEndpoint != "running" {
		t.Fatalf("after park: spec=%s status=%s", b.SpecEndpoint, b.StatusEndpoint)
	}
	if b.StatusPort == nil {
		t.Fatal("suspended endpoint must retain status_port (still dial-able)")
	}

	// A connection arrives: simulate ConnCount>0 and nudge -> wake converge.
	tc.prox.mu.Lock()
	tc.prox.conns["b1"] = 1
	tc.prox.mu.Unlock()
	if err := owner.Do(ctx); err != nil {
		t.Fatalf("wake converge: %v", err)
	}
	b, _, _ = tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "running" {
		t.Fatalf("after wake: status=%s (want running)", b.StatusEndpoint)
	}
}

func TestSuspendedRestsWhenIdle(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	owner, _ := tc.core.Owners.Get("b1")
	_ = owner.Run(ctx, func(ctx context.Context) error {
		return tc.core.suspendEndpointLocked(ctx, "b1")
	})
	// ConnCount==0 (fake default) -> a converge must be a no-op, staying suspended
	// and NOT flipping to failed (crash detection must not fire on a suspended row).
	if err := owner.Do(ctx); err != nil {
		t.Fatalf("idle converge: %v", err)
	}
	b, _, _ := tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "suspended" {
		t.Fatalf("idle suspended endpoint must rest suspended, got %s", b.StatusEndpoint)
	}
}

func TestExplicitStartWakesSuspended(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	owner, _ := tc.core.Owners.Get("b1")
	_ = owner.Run(ctx, func(ctx context.Context) error {
		return tc.core.suspendEndpointLocked(ctx, "b1")
	})
	// A user Start bumps spec_generation -> breaks the suspended resting arm even
	// with ConnCount==0 -> wakes.
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("StartEndpoint on a suspended endpoint: %v", err)
	}
	b, _, _ := tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "running" {
		t.Fatalf("explicit start must wake suspended endpoint, got %s", b.StatusEndpoint)
	}
}
```

- [ ] **Step 8: Run the service tests (with `-race`)**

Run: `cd ~/git/worktreedb && go test ./internal/store/ ./internal/service/ -race -count=1`
Expected: **PASS** (new + existing). Run `go vet ./... && golangci-lint run` — clean.

- [ ] **Step 9: Wire the wake callback in `main`**

In `cmd/worktreedbd/main.go`, after `core` is constructed and the branch owners are registered (the block ending ~line 237), add the wake wiring (the proxy fires this when a connection is held on a suspended slot):

```go
	// Wake-on-connect: the proxy holds an accepted connection on a suspended
	// slot and nudges the branch owner, whose converge cold-starts the compute
	// and retargets the slot (through the lane, so wake serializes against
	// delete/restore/stop by construction).
	prox.SetWake(func(branchID string) {
		if o, ok := owners.Get(branchID); ok {
			o.Nudge()
		}
	})
```

Run: `cd ~/git/worktreedb && go build ./... && go test ./... -count=1`
Expected: builds; unit tests pass.

- [ ] **Step 10: Commit**

```bash
cd ~/git/worktreedb && git add internal/store/rows.go internal/store/rows_test.go internal/service/core.go internal/service/endpoints.go internal/service/endpoints_test.go internal/service/fakes_test.go cmd/worktreedbd/main.go
git commit -m "feat(service): park + wake-on-connect converge with in-lane suspend"
```

---

### Task 4: The idle sweeper

Add the background sweeper: per-endpoint idle-duration tracking off the proxy `ConnCount`, an atomic `SuspendIfIdle` gate, and the in-lane park dispatch. Wire it into `main` bound to the root ctx, and JOIN it at shutdown BEFORE `owners.Shutdown()` so it can never nudge a dead owner.

**Files:**
- Create: `internal/service/sweeper.go`, `internal/service/sweeper_test.go`
- Modify: `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: `core.Store.EndpointsByStatus` + `core.Proxy` (T2/T3), `core.Owners.Get`, `core.suspendEndpointLocked`.
- Produces:
  - `func NewSweeper(core *Core, timeout time.Duration, log *slog.Logger) *Sweeper`.
  - `func (s *Sweeper) Run(ctx context.Context)` — ticks until ctx is done.
  - `func (s *Sweeper) sweepOnce(ctx context.Context, now time.Time)` — one pass (unit-testable with an injected clock).

- [ ] **Step 1: Write the failing sweeper tests**

Create `internal/service/sweeper_test.go`:

```go
package service

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"
)

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSweeperSuspendsAfterIdleTimeout(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	s := NewSweeper(tc.core, 30*time.Second, discardLog())

	t0 := time.Unix(1_000_000, 0)
	s.sweepOnce(ctx, t0) // first observation: records idle-since
	b, _, _ := tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "running" {
		t.Fatalf("must not suspend on first idle observation, got %s", b.StatusEndpoint)
	}
	s.sweepOnce(ctx, t0.Add(31*time.Second)) // past the timeout -> park
	b, _, _ = tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "suspended" {
		t.Fatalf("idle past timeout must suspend, got %s", b.StatusEndpoint)
	}
}

func TestSweeperBusyEndpointResetsIdle(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	s := NewSweeper(tc.core, 30*time.Second, discardLog())
	t0 := time.Unix(1_000_000, 0)
	s.sweepOnce(ctx, t0)
	// a connection appears before the timeout -> idle clock resets
	tc.prox.mu.Lock()
	tc.prox.conns["b1"] = 1
	tc.prox.mu.Unlock()
	s.sweepOnce(ctx, t0.Add(20*time.Second))
	// connection gone again, but the clock restarts from here
	tc.prox.mu.Lock()
	tc.prox.conns["b1"] = 0
	tc.prox.mu.Unlock()
	s.sweepOnce(ctx, t0.Add(21*time.Second)) // re-observe idle
	s.sweepOnce(ctx, t0.Add(40*time.Second)) // only 19s idle -> no suspend
	b, _, _ := tc.st.BranchByID(ctx, "b1")
	if b.StatusEndpoint != "running" {
		t.Fatalf("a connection must reset the idle clock, got %s", b.StatusEndpoint)
	}
}
```

(`newTestCore`, `seedBranch`, and the `tc.prox`/`tc.st` fields are the existing `fakes_test.go` harness. `discardLog` is defined here because the service tests otherwise build their logger inline.)

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestSweeper -count=1`
Expected: **FAIL to compile** — `NewSweeper` undefined.

- [ ] **Step 2: Implement the sweeper**

Create `internal/service/sweeper.go`:

```go
package service

import (
	"context"
	"log/slog"
	"time"
)

// Sweeper parks idle branch endpoints. Each tick it reads the running endpoints,
// tracks how long each has had zero live proxy connections, and once one has
// been idle for the configured timeout it flips the slot to suspended (atomic,
// race-safe) and dispatches the in-lane park. All map state is owned by the
// single goroutine that calls sweepOnce; nothing here is shared across
// goroutines, so the only cross-lane interaction is through the proxy's atomic
// SuspendIfIdle and the owner lane.
type Sweeper struct {
	core      *Core
	timeout   time.Duration
	tick      time.Duration
	log       *slog.Logger
	idleSince map[string]time.Time
}

func NewSweeper(core *Core, timeout time.Duration, log *slog.Logger) *Sweeper {
	return &Sweeper{core: core, timeout: timeout, tick: tickFor(timeout), log: log, idleSince: map[string]time.Time{}}
}

// tickFor derives the sweep interval from the timeout: poll ~4x per idle window
// so suspend latency is a small fraction over the configured timeout, capped at
// 30s so the default 5-minute timeout only wakes the sweeper twice a minute, and
// floored at 1s. Deriving the tick keeps a SINGLE config knob.
func tickFor(timeout time.Duration) time.Duration {
	d := timeout / 4
	if d > 30*time.Second {
		d = 30 * time.Second
	}
	if d < time.Second {
		d = time.Second
	}
	return d
}

// Run sweeps every tick until ctx is cancelled. Bound to the daemon's root ctx
// and JOINED before owner teardown, so it never nudges a dead owner.
func (s *Sweeper) Run(ctx context.Context) {
	t := time.NewTicker(s.tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweepOnce(ctx, time.Now())
		}
	}
}

func (s *Sweeper) sweepOnce(ctx context.Context, now time.Time) {
	running, err := s.core.Store.EndpointsByStatus(ctx, "running")
	if err != nil {
		s.log.Error("suspend sweep: reading running endpoints failed", "err", err)
		return
	}
	live := make(map[string]bool, len(running))
	for _, b := range running {
		live[b.ID] = true
		if s.core.Proxy.ConnCount(b.ID) > 0 {
			delete(s.idleSince, b.ID) // busy: reset the idle clock
			continue
		}
		since, seen := s.idleSince[b.ID]
		if !seen {
			s.idleSince[b.ID] = now // first idle observation
			continue
		}
		if now.Sub(since) >= s.timeout {
			s.trySuspend(ctx, b.ID)
		}
	}
	// Forget endpoints that are no longer running (suspended/stopped/deleted).
	for id := range s.idleSince {
		if !live[id] {
			delete(s.idleSince, id)
		}
	}
}

func (s *Sweeper) trySuspend(ctx context.Context, branchID string) {
	delete(s.idleSince, branchID) // decision made either way; re-observe fresh next tick
	if !s.core.Proxy.SuspendIfIdle(branchID) {
		return // a connection arrived (or the slot moved) — abort cleanly
	}
	owner, ok := s.core.Owners.Get(branchID)
	if !ok {
		s.core.Proxy.Unsuspend(branchID) // no owner (deleted) — undo the flip
		return
	}
	if err := owner.Run(ctx, func(ctx context.Context) error {
		return s.core.suspendEndpointLocked(ctx, branchID)
	}); err != nil {
		s.log.Warn("suspend park failed", "branch", branchID, "err", err)
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestSweeper -count=1`
Expected: **PASS**.

- [ ] **Step 3: Wire the sweeper into `main` (start bound to root ctx + JOIN at shutdown)**

In `cmd/worktreedbd/main.go`, after the wake wiring (T3) and the gate/sweep bootstrap, before building the HTTP handler, start the sweeper when enabled:

```go
	// Auto-suspend sweeper: bound to the ROOT ctx and joined before owners
	// quiesce (below). Disabled when the timeout is 0.
	var sweeperDone chan struct{}
	if cfg.SuspendTimeout > 0 {
		sweeper := service.NewSweeper(core, cfg.SuspendTimeout, log)
		sweeperDone = make(chan struct{})
		go func() {
			defer close(sweeperDone)
			sweeper.Run(ctx)
		}()
		log.Info("auto-suspend enabled", "idle_timeout", cfg.SuspendTimeout.String())
	} else {
		log.Info("auto-suspend disabled (WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0)")
	}
```

In the teardown block (the `cancel()` … `owners.Shutdown()` sequence at the end of `run()`), JOIN the sweeper right after `cancel()` and BEFORE `owners.Shutdown()`:

```go
	cancel()
	if sweeperDone != nil {
		<-sweeperDone // the sweeper must stop before owners tear down — it nudges them
	}
	owners.Shutdown()
	computes.StopAll()
	prox.Shutdown()
	sup.Stop()
	eng.Wait()
	removeLock()
	return shutdownErr
```

(The sweeper's `owner.Run` takes the root ctx, so `cancel()` unblocks any in-flight park submission; the join then completes promptly.)

- [ ] **Step 4: Build + full unit suite with `-race`**

Run: `cd ~/git/worktreedb && go build ./... && go vet ./... && go test ./... -race -count=1 && golangci-lint run`
Expected: builds clean; all unit tests pass under `-race`; 0 lint issues.

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktreedb && git add internal/service/sweeper.go internal/service/sweeper_test.go cmd/worktreedbd/main.go
git commit -m "feat(service): idle sweeper parks endpoints and joins clean at shutdown"
```

---

### Task 5: Surfacing + carry-throughs (DTO/detail, restore, build in-use)

Make a suspended endpoint behave like a running one everywhere its dial-able slot matters: surface its port/connection string, let restore stop+restart it, and keep its install out of the build GC's reach.

**Files:**
- Modify: `internal/service/endpoints.go`, `internal/service/endpoints_test.go`, `internal/api/dto.go`, `internal/service/timetravel.go`, `internal/service/timetravel_test.go`, `cmd/worktreedbd/main.go`

**Interfaces:**
- Consumes: `service.EndpointDialable` (T3), `store.EndpointsByStatus` (T3), `compute.RunningPgbins`.
- Produces: DTO `port`/`connectionString`/`jdbcUrl` populated for suspended; restore treats suspended like running; the build in-use supplier includes suspended endpoints' `status_pgbin`.

- [ ] **Step 1: Service `BranchDetail` surfaces a suspended endpoint — failing test first**

The read model (`detailOf`) is the single source the DTO is built from; test it at the verified service level. In `internal/service/endpoints_test.go`, add (same `newTestCore`/`seedBranch` harness):

```go
func TestSuspendedEndpointSurfacesConnString(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	owner, _ := tc.core.Owners.Get("b1")
	_ = owner.Run(ctx, func(ctx context.Context) error {
		return tc.core.suspendEndpointLocked(ctx, "b1")
	})
	d, err := tc.core.BranchDetail(ctx, "b1")
	if err != nil {
		t.Fatalf("BranchDetail: %v", err)
	}
	if d.Row.StatusEndpoint != "suspended" {
		t.Fatalf("status = %s", d.Row.StatusEndpoint)
	}
	// A suspended endpoint keeps its dial-able slot, so it must still surface a
	// port + connection string (currently the guard is status == "running").
	if d.ConnectionString == nil || d.JdbcURL == nil || d.Row.StatusPort == nil {
		t.Fatal("a suspended endpoint must still surface its port + connection string")
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestSuspendedEndpointSurfaces -count=1`
Expected: **FAIL** — `detailOf`'s `== "running"` guards leave `ConnectionString`/`JdbcURL` nil for a suspended row.

- [ ] **Step 2: DTO + detail treat suspended like running**

In `internal/service/endpoints.go`, in `detailOf`, change the two `== "running"` guards to the helper (package `service`, so `EndpointDialable` is unqualified):

```go
	if EndpointDialable(b.StatusEndpoint) && b.StatusPort != nil {
		cs := ConnectionString(b.Password, *b.StatusPort)
		ju := JdbcURL(b.Password, *b.StatusPort)
		d.ConnectionString = &cs
		d.JdbcURL = &ju
	}
	// RunningPgVersion ...
	if EndpointDialable(b.StatusEndpoint) && b.StatusPgbin != nil && c.VersionForPgbin != nil {
		d.RunningPgVersion = c.VersionForPgbin(ctx, *b.StatusPgbin)
	}
```

In `internal/api/dto.go`, in `toBranchDTO`, change the port guard (`dto.go` is package `api` and already imports `service`):

```go
	var port *int
	if service.EndpointDialable(b.StatusEndpoint) {
		port = b.StatusPort
	}
```

Run: `cd ~/git/worktreedb && go test ./internal/api/ ./internal/service/ -count=1`
Expected: **PASS**. (The DTO-layer change is additionally exercised end-to-end by T7, which asserts `body["port"]` + `body["connectionString"]` for a suspended endpoint over the real HTTP API.)

- [ ] **Step 3: Restore treats suspended like running — failing test first**

In `internal/service/timetravel_test.go`, add the case below. It mirrors `TestRestoreInPlaceSwapsIdentityAndRestarts` exactly (the fake storcon resolves the literal `"2026-07-11T09:00:00Z"` to a `present` LSN by default), but parks the endpoint first; the key assertion is that the endpoint ends running post-restore (proving suspended was treated like running — stopped around the swap, restarted after):

```go
func TestRestoreSuspendedEndpointRestartsIt(t *testing.T) {
	tc := newTestCore(t)
	ctx := context.Background()
	tc.seedBranch(t, "p1", "b1")
	if _, err := tc.core.StartEndpoint(ctx, "b1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	// park it (as the sweeper would)
	owner, _ := tc.core.Owners.Get("b1")
	if err := owner.Run(ctx, func(ctx context.Context) error {
		return tc.core.suspendEndpointLocked(ctx, "b1")
	}); err != nil {
		t.Fatalf("park: %v", err)
	}
	// restore-in-place must treat suspended like running: stop around the swap,
	// then restart under the new (swapped) identity.
	detail, err := tc.core.RestoreInPlace(ctx, "b1", "2026-07-11T09:00:00Z")
	if err != nil {
		t.Fatalf("restore of a suspended endpoint: %v", err)
	}
	if detail.Row.StatusEndpoint != "running" {
		t.Fatalf("restore must restart a suspended endpoint, got %s", detail.Row.StatusEndpoint)
	}
}
```

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestRestoreSuspended -count=1`
Expected: **FAIL** — with the current `wasRunning := b.StatusEndpoint == "running"`, a suspended endpoint is neither stopped nor restarted; the assertion fails.

- [ ] **Step 4: Restore reads suspended as running**

In `internal/service/timetravel.go`, in `swapOntoNewTimeline`, change the `wasRunning` derivation (line ~150). The mid-transition guard just above it (`"starting"`/`"stopping"`) is unchanged — suspended is a rest state and proceeds:

```go
		// Suspended endpoints have spec=running and a bound slot; treat them like
		// running — stop around the swap, restart after — so a restore never
		// leaves a parked endpoint pointing at a rewound timeline.
		wasRunning = b.StatusEndpoint == "running" || b.StatusEndpoint == "suspended"
```

Run: `cd ~/git/worktreedb && go test ./internal/service/ -run TestRestore -count=1`
Expected: **PASS**.

- [ ] **Step 5: Build in-use guard includes suspended installs (main wiring)**

In `cmd/worktreedbd/main.go`, replace the in-use supplier late-bind (currently `buildsSvc.SetRunningPgbins(computes.RunningPgbins)`) with a combined supplier that also protects the installs suspended endpoints will cold-start onto:

```go
	// In-use protocol: live computes PLUS the installs suspended endpoints will
	// wake onto. A suspended compute is Stopped (drops out of RunningPgbins), but
	// spec is still running — its status_pgbin must not be GC'd out from under
	// the next wake. status_pgbin is the install's bin dir; the removal guard
	// prefix-matches the install path, so this list feeds it directly.
	buildsSvc.SetRunningPgbins(func() []string {
		pgbins := computes.RunningPgbins()
		suspended, err := st.EndpointsByStatus(context.Background(), "suspended")
		if err != nil {
			log.Error("in-use scan: reading suspended endpoints failed", "err", err)
			return pgbins
		}
		for _, b := range suspended {
			if b.StatusPgbin != nil {
				pgbins = append(pgbins, *b.StatusPgbin)
			}
		}
		return pgbins
	})
```

Run: `cd ~/git/worktreedb && go build ./... && go test ./... -race -count=1 && golangci-lint run`
Expected: builds; all pass; 0 lint.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktreedb && git add internal/service/endpoints.go internal/service/endpoints_test.go internal/api/dto.go internal/service/timetravel.go internal/service/timetravel_test.go cmd/worktreedbd/main.go
git commit -m "feat(service): surface suspended endpoints and guard their installs and restores"
```

---

### Task 6: Web — the `suspended` status

Teach the copied React app about the additive `suspended` status: the zod enum (strict — it rejects unknown values, so this is required for the UI not to break), the status chip color, and the two running/starting-keyed action controls.

**Files:**
- Modify: `web/src/shared.ts`, `web/src/tree/chips.tsx`, `web/src/tree/BranchActionsMenu.tsx`, `web/src/drawer/BranchDrawer.tsx`

**Interfaces:**
- Consumes: the `EndpointStatus` union from `shared.ts`.
- Produces: `pnpm build` (tsc + vite) + `pnpm test` green with `suspended` in the union.

- [ ] **Step 1: Add `suspended` to the endpoint-status enum**

In `web/src/shared.ts`, extend `EndpointStatusSchema`:

```ts
export const EndpointStatusSchema = z.enum(["stopped", "starting", "running", "stopping", "suspended", "failed"]);
```

- [ ] **Step 2: Prove the exhaustive Record now fails to compile**

Run: `cd "$WT/web" && pnpm build` (substitute your worktree's `web/` path)
Expected: **`tsc` FAILS** — `STATUS_COLOR` in `chips.tsx` is `Record<BranchDto["endpointStatus"], string>` and no longer covers every member. This is the intended RED: the enum change forces the color map to be handled.

- [ ] **Step 3: Add the chip color + label for suspended**

In `web/src/tree/chips.tsx`, add the `suspended` entry to `STATUS_COLOR` and a label arm so a parked endpoint shows its port (it is still dial-able):

```tsx
const STATUS_COLOR: Record<BranchDto["endpointStatus"], string> = {
  running: "green", starting: "yellow", stopping: "yellow", suspended: "blue", stopped: "gray", failed: "red",
};

export function StatusChip(a: { branch: Pick<BranchDto, "endpointStatus" | "port" | "endpointError"> }) {
  const { endpointStatus: s, port, endpointError } = a.branch;
  const label =
    s === "running" && port ? `● running :${port}`
    : s === "suspended" && port ? `◐ suspended :${port}`
    : s === "failed" ? "✕ failed"
    : `○ ${s}`;
  const chip = <Badge variant="light" color={STATUS_COLOR[s]} ff="monospace">{label}</Badge>;
  return s === "failed" && endpointError ? <Tooltip label={endpointError} multiline maw={420}>{chip}</Tooltip> : chip;
}
```

- [ ] **Step 4: Treat suspended like running in the two Stop controls**

In `web/src/tree/BranchActionsMenu.tsx`, the action shows "Stop endpoint" for running/starting; a suspended endpoint (spec running, wakes on connect) should offer Stop too:

```tsx
        {b.endpointStatus === "running" || b.endpointStatus === "starting" || b.endpointStatus === "suspended"
          ? <Menu.Item onClick={() => stop.mutate(b.id)}>Stop endpoint</Menu.Item>
          : <Menu.Item onClick={() => start.mutate(b.id)}>Start endpoint</Menu.Item>}
```

In `web/src/drawer/BranchDrawer.tsx`, the danger-zone Stop button (line ~158):

```tsx
            {(b.endpointStatus === "running" || b.endpointStatus === "starting" || b.endpointStatus === "suspended") && (
              <Button variant="light" onClick={() => stop.mutate(b.id)} loading={stop.isPending}>Stop endpoint</Button>
            )}
```

- [ ] **Step 5: Build + test the web app (GREEN) + clean-content check**

Run: `cd "$WT/web" && pnpm build && pnpm test`
Expected: `tsc --noEmit` typechecks (the Record is exhaustive again) and `vite build` + `vitest run` pass.

Run: `grep -riE 'devdb' "$WT/web/src/shared.ts" "$WT/web/src/tree/chips.tsx" "$WT/web/src/tree/BranchActionsMenu.tsx" "$WT/web/src/drawer/BranchDrawer.tsx"`
Expected: empty (no reference-implementation strings introduced).

- [ ] **Step 6: Remove any generated dist, commit source only**

```bash
rm -rf "$WT/web/dist"                       # a local pnpm build rewrites the placeholder; drop it
git checkout "$WT/web/dist/index.html" 2>/dev/null || true   # restore the tracked placeholder if it moved
cd "$WT" && git add web/src/shared.ts web/src/tree/chips.tsx web/src/tree/BranchActionsMenu.tsx web/src/drawer/BranchDrawer.tsx
git commit -m "feat(web): render and act on the suspended endpoint status"
```

(These are NORMAL worktreedb commits — not the M4 squashed web commit. The clean-history rule allows the value `"suspended"` and a color entry; verify the diff mentions nothing about the reference implementation.)

---

### Task 7: Prove it — Go-native integration test + parity stays clean (suspend disabled)

Add a container-level test that actually suspends and wakes against `worktreedb:dev`, then keep the reference parity suite green by having the cross-run DISABLE auto-suspend (spec D8 — the additive feature never enters the parity gate).

**Files:**
- Create (worktreedb): `integration/suspend_test.go`
- Modify (devdb): `~/git/devdb/tests/integration/helpers/container.ts`, `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`

**Interfaces:**
- Consumes: `worktreedb:dev` (all prior tasks), the `image()`/`hostDSN`/`apiJSON` integration helpers (existing, `//go:build integration`, `package integration`).
- Produces: a proven suspend→wake→data-survives cycle Go-side; the full reference suite green with `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0`.

- [ ] **Step 1: Write the Go-native suspend/wake test (worktreedb)**

Create `integration/suspend_test.go`. It boots a container with a SHORT idle timeout (the sweep tick is derived from it), creates a branch, starts + writes data, waits for `suspended`, then reconnects (which wakes it) and asserts the data survived:

```go
//go:build integration

package integration

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

func startSuspendContainer(t *testing.T, idleSeconds int) (testcontainers.Container, string) {
	t.Helper()
	ctx := context.Background()
	ports := []string{"4400/tcp"}
	for p := 54300; p <= 54309; p++ {
		ports = append(ports, fmt.Sprintf("%d/tcp", p))
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        image(),
			ExposedPorts: ports,
			Env: map[string]string{
				"WORKTREEDB_PORT_RANGE":              "54300-54309",
				"WORKTREEDB_SUSPEND_TIMEOUT_SECONDS": fmt.Sprintf("%d", idleSeconds),
			},
			WaitingFor: wait.ForHTTP("/api/status").WithPort("4400/tcp").WithStartupTimeout(3 * time.Minute),
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

// TestSuspendThenWakePreservesData: an idle endpoint parks (status suspended),
// an external connection wakes it through the proxy (status running) and the
// data written before the suspend is still there — cold-start against the same
// branch data. Uses the verified helpers apiJSON/sqlOn/hostDSN from
// branching_test.go (same package).
func TestSuspendThenWakePreservesData(t *testing.T) {
	ctx := context.Background()
	c, base := startSuspendContainer(t, 3) // 3s idle -> tick ~1s -> parks within ~5s

	// Create a project; its main branch is the target.
	code, created := apiJSON(t, "POST", base+"/api/projects", `{"name":"m5"}`)
	if code != 201 {
		t.Fatalf("project create = %d %v", code, created)
	}
	mainID := created["mainBranch"].(map[string]any)["id"].(string)

	// Seed data — sqlOn auto-starts the endpoint (RunSQL -> EnsureRunning), runs,
	// and disconnects, leaving the endpoint idle for the sweeper to park.
	sqlOn(t, base, mainID, "CREATE TABLE m5(x int)")
	sqlOn(t, base, mainID, "INSERT INTO m5 VALUES (42)")

	// Poll until the idle endpoint parks — a suspended endpoint still surfaces
	// its port + connection string (it is dial-able).
	suspended := false
	for i := 0; i < 40; i++ {
		code, body := apiJSON(t, "GET", base+"/api/branches/"+mainID, "")
		if code == 200 && body["endpointStatus"] == "suspended" {
			if body["port"] == nil || body["connectionString"] == nil {
				t.Fatal("a suspended endpoint must still surface its port + connection string")
			}
			suspended = true
			break
		}
		time.Sleep(time.Second)
	}
	if !suspended {
		t.Fatal("endpoint never suspended within the idle window")
	}

	// WAKE-ON-CONNECT: an external client dial to the suspended slot is HELD by
	// the proxy while it cold-starts a fresh compute, then splices through. Keep
	// the connection OPEN through the final status check so the sweeper can't
	// re-park it (a live connection aborts SuspendIfIdle).
	_, detail := apiJSON(t, "GET", base+"/api/branches/"+mainID, "")
	dsn := hostDSN(t, c, detail["connectionString"].(string))
	wakeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	conn, err := pgconn.Connect(wakeCtx, dsn)
	if err != nil {
		t.Fatalf("wake-on-connect dial: %v", err)
	}
	defer conn.Close(ctx)
	res, err := conn.Exec(ctx, "SELECT x FROM m5").ReadAll()
	if err != nil || len(res) == 0 || len(res[0].Rows) != 1 || string(res[0].Rows[0][0]) != "42" {
		t.Fatalf("data did not survive suspend/wake: res=%v err=%v", res, err)
	}
	code, body := apiJSON(t, "GET", base+"/api/branches/"+mainID, "")
	if code != 200 || body["endpointStatus"] != "running" {
		t.Fatalf("post-wake status = %v (want running)", body["endpointStatus"])
	}
}
```

(`apiJSON`, `sqlOn`, `hostDSN`, and the `startBranchingContainer` env pattern all already exist in `package integration` — reuse them verbatim; `startSuspendContainer` above just adds the suspend-timeout env to that pattern.)

- [ ] **Step 2: Build the image and run the Go-native test**

```bash
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
cd ~/git/worktreedb && docker build -t worktreedb:dev .
go test -tags integration ./integration/ -run TestSuspendThenWakePreservesData -count=1 -timeout 15m -v
```
Expected: **PASS** — parks within the idle window, wakes on reconnect, `SELECT` returns 42.

- [ ] **Step 3: Disable auto-suspend for the reference cross-run (devdb helper)**

In `~/git/devdb/tests/integration/helpers/container.ts`, inject `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0` for the Go cross-run ONLY (leave devdb's own DEVDB_-prefixed runs untouched — zero risk to the already-merged M4 gate). This mirrors the existing `ENV_PREFIX === "DEVDB_"` conditional pattern and the already-injected `DEVDB_PORT_RANGE` default. In `buildUnstarted`, change the environment line:

```ts
    // Auto-suspend is M5 (Go image only) and must never fire during the parity
    // run: a long-running test file would otherwise see a running endpoint flip
    // to "suspended" (spec D8 — the additive feature stays out of the parity
    // gate). Only inject it for the reprefixed (non-DEVDB_) cross-run; devdb's
    // own TS daemon has no such env and its runs are unchanged.
    const suspendOff = ENV_PREFIX === "DEVDB_" ? {} : { DEVDB_SUSPEND_TIMEOUT_SECONDS: "0" };
    const unstarted = new GenericContainer(IMAGE)
      .withName(name)
      .withEnvironment(reprefix({ DEVDB_PORT_RANGE: "54300-54309", ...suspendOff, ...env }))
      .withExposedPorts(...exposedPorts)
      .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
      .withStartupTimeout(240_000);
```

(`reprefix` rewrites `DEVDB_SUSPEND_TIMEOUT_SECONDS` → `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS` for the Go image. Assertions are untouched — this is harness parameterization, exactly like the port-range default already there.)

- [ ] **Step 4: Run the FULL reference parity suite against the Go image (suspend disabled)**

```bash
cd ~/git/devdb/tests/integration && \
  DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
  pnpm vitest run acceptance projects branching endpoints timetravel events \
    boot restart unclean-restart retry-helper storcon-major-guard \
    pg-builds mcp mcp-handshake mcp-concurrency web-ui
```
Expected: **16 files green, assertions unmodified** — identical to the M4 gate, now with the additive suspend feature present in the image but disabled by the injected `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0`. (Sequential; budget 60–90 min. A lone red under cumulative load: re-run that file isolated before treating it as real — documented flake behavior.)

- [ ] **Step 5: Record the M5 parity result (devdb cross-run doc)**

In `~/git/devdb/docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md`, append an M5 section:

```markdown
## M5 gate — parity holds with suspend/wake present but DISABLED (spec D8)

M5 adds auto-suspend + wake to the Go image. Per D8 the additive behavior never
enters the parity gate: helpers/container.ts injects
WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0 for the reprefixed cross-run (only when
ENV_PREFIX != DEVDB_), so no endpoint parks mid-test. Same 16 files, assertions
unmodified.

    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run acceptance projects branching endpoints timetravel events \
        boot restart unclean-restart retry-helper storcon-major-guard \
        pg-builds mcp mcp-handshake mcp-concurrency web-ui

Full 16-file suite 2026-07-XX (suspend disabled): <record the summary line here>

Suspend/wake itself is proven Go-side by integration/suspend_test.go
(TestSuspendThenWakePreservesData) against the same image.
```

Fill `2026-07-XX` with the actual run summary.

- [ ] **Step 6: Commit (two repos)**

```bash
# worktreedb (no trailer)
cd ~/git/worktreedb && git add integration/suspend_test.go
git commit -m "test(integration): suspend then wake preserves branch data"

# devdb (workshop conventions, WITH trailer)
cd ~/git/devdb && git add tests/integration/helpers/container.ts docs/superpowers/2026-07-11-worktreedb-m2-cross-run.md
git commit -m "test(integration): keep suspend out of the parity gate (D8) + record M5 result

Injects WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0 for the Go cross-run so the
additive auto-suspend never fires during the reference suite, and records the
full 16-file suite green against worktreedb:dev with suspend disabled.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs + spec amendment

Document suspend/wake in the worktreedb repo (README/AGENTS, no trailer) and record the explicit amendment of the 2026-07-02 product spec's "no auto-suspend in v1" non-goal in the devdb workshop (with trailer) — recorded, not silently contradicted (spec §8-M5).

**Files:**
- Modify (worktreedb): `README.md`, `AGENTS.md`
- Modify (devdb): `~/git/devdb/docs/superpowers/specs/2026-07-02-devdb-design.md`

**Interfaces:**
- Consumes: the shipped behavior (T1–T5) + the config knob (T1).
- Produces: user-facing docs + the paper trail for the non-goal reversal.

- [ ] **Step 1: README — a suspend/wake section + the config row**

In `~/git/worktreedb/README.md`, update the status blurb (the M4 line "Auto-suspend + wake-on-connect is the next milestone." becomes shipped) and add a subsection after the endpoints/branching description:

```markdown
### Auto-suspend + wake-on-connect

An endpoint with no live connections for `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS`
(default 300; `0` disables) is automatically suspended: its compute is stopped
to free the port and disk, but its published slot stays bound and dial-able. The
next connection transparently wakes it — the daemon holds the accepted
connection while it cold-starts a fresh compute against the same branch data
(the data lives in the storage engine, not the compute), then splices through.
Wake latency is roughly a compute cold-start (about 1–2 s); GUI clients that time
out a first connect quickly may need one retry. A suspended endpoint keeps its
connection string and JDBC URL and reports `endpointStatus: "suspended"`; an
explicit stop (`spec: stopped`) still fully releases it.
```

Add a Configuration-table row:

```markdown
| `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS` | `300` | idle seconds before an endpoint auto-suspends; `0` disables auto-suspend |
```

- [ ] **Step 2: AGENTS — a one-line note in the architecture paragraph**

In `~/git/worktreedb/AGENTS.md`, extend the architecture paragraph (after the proxy/endpoint sentence) with:

```markdown
Idle endpoints auto-suspend (an idle sweeper parks the compute and commits
`status: suspended` while `spec: running`); a connection wakes them through the
proxy, which holds the accept and nudges the branch owner to cold-start and
retarget the slot — all serialized on the one per-branch owner lane.
```

- [ ] **Step 3: Build the docs-affected check (worktreedb clean-history)**

Run: `cd ~/git/worktreedb && grep -riE 'devdb|neond|matisiekpl|typescript|fastify' README.md AGENTS.md | grep -v neondatabase`
Expected: empty.

- [ ] **Step 4: Commit the worktreedb docs (no trailer)**

```bash
cd ~/git/worktreedb && git add README.md AGENTS.md
git commit -m "docs: describe auto-suspend and wake-on-connect"
```

- [ ] **Step 5: Amend the product-spec non-goal (devdb, with trailer)**

In `~/git/devdb/docs/superpowers/specs/2026-07-02-devdb-design.md`, amend BOTH places that assert the non-goal (line ~26 and line ~49) so the reversal is recorded, not contradicted. Add an `AMENDED` note rather than deleting the original (the spec's changelog convention):

At line ~26 (the non-goals list entry "Auto-suspend of idle endpoints …"):

```markdown
- Auto-suspend of idle endpoints (start is automated where it helps agents; stop stays explicit).
  **AMENDED 2026-07-13 (Worktree DB M5):** auto-suspend + wake-on-connect now
  SHIPS as the first post-parity milestone — idle endpoints park automatically
  (`WORKTREEDB_SUSPEND_TIMEOUT_SECONDS`, default 300, 0 disables) and wake on the
  next connection. See `docs/superpowers/plans/2026-07-13-worktreedb-m5-suspend-wake.md`
  and master-spec §8-M5 / D8. This reverses the v1 non-goal deliberately, on the
  daemon-owned-listener foundation that made a transparent wake possible.
```

At line ~49 (the Endpoint glossary "Auto-suspend of idle endpoints is a non-goal for v1."):

```markdown
- **Endpoint** — the Postgres compute process serving a branch. Started on demand (explicitly, or automatically by MCP `create_branch`/`get_branch`), stopped explicitly. ~~Auto-suspend of idle endpoints is a non-goal for v1.~~ **AMENDED 2026-07-13 (Worktree DB M5): auto-suspend + wake-on-connect ships (see the non-goals note above).** Statuses: `stopped | starting | running | stopping | suspended | failed`.
```

- [ ] **Step 6: Commit the spec amendment (devdb, with trailer)**

```bash
cd ~/git/devdb && git add docs/superpowers/specs/2026-07-02-devdb-design.md
git commit -m "docs(specs): amend the no-auto-suspend-in-v1 non-goal (Worktree DB M5 ships it)

Records the deliberate reversal of the 2026-07-02 v1 non-goal — auto-suspend +
wake-on-connect now ships as the first post-parity milestone on the
daemon-owned-listener foundation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Milestone acceptance (spec §8-M5)

- `go build ./... && go vet ./...` clean; `go test ./... -race -count=1` green (the proxy suspend/wake race tests + the service park/wake/sweeper tests are load-bearing); `golangci-lint run` 0 issues.
- `go test -tags integration ./integration/...` green including `TestSuspendThenWakePreservesData` (parks within the idle window, wakes on reconnect, data survives).
- **The full 16-file reference parity suite green against `worktreedb:dev` with `WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0` injected by the cross-run harness (spec D8), assertions unmodified** — recorded in the cross-run doc.
- Behavior proven end-to-end: an idle endpoint reaches `status: suspended` while `spec: running`, keeps its port/connection string, and a new connection transparently wakes it (cold-start) with data intact; an explicit stop still fully releases; a suspended endpoint survives restore (stopped+restarted around the swap) and its install is not GC'd by the builds owner.
- Clean-history spot check before merging the worktree branch:
  `cd ~/git/worktreedb && git log --format=%B <base>..HEAD | grep -iE 'devdb|neond|matisiekpl|typescript|fastify|co-authored'` — empty;
  `grep -riE 'devdb|neond|matisiekpl|typescript|fastify' --include='*.go' --include='*.md' . | grep -v neondatabase` — empty (the single `// oracle: neon …` connection-count citation is the sanctioned exception);
  `go.mod`/`go.sum` unchanged vs `<base>`.

## Deferred out of M5 (recorded, deliberate)

- **No new compute-manager park/resume path** — suspend is cold-start (`Computes.Stop`/`Computes.Start`), by decision D8; a warm-park optimization is post-M5 if wake latency ever matters.
- **`suspended` is not added to the `starting`-style status DTO union widening backlog item** — that item (`starting` in the status block) is independent (spec §11); M5 only adds `suspended` to the endpoint-status enum it needs.
- **Engine auto-restart, resume-interrupted-pulls, dual-stack listeners, UI restyle, phases 4–5** — untouched (spec §11 backlog).
- **`suspend_timeout_seconds` in the ComputeSpec stays `-1`** — the compute-side knob is deliberately not the policy surface; M5's policy is daemon-only.

## Execution handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two gates per task (independent reviewer + review-broker scan; severity map P1–P2 Critical / P3 Important / P4–P5 Minor; `REVIEW_BROKER_DOC=~/git/devdb/docs/codebase-review.md`, absolute `focusFiles` + `repoRoot` into the worktree). Implementation happens on a worktree branch under `~/git/worktreedb/.worktrees/` — never on main. Every worktreedb implementer/fix dispatch carries the **no-AI-trailer + clean-history** rules verbatim (the one sanctioned exception is the required `// oracle: neon` connection-count citation in T3). T7's devdb portion and T8's spec-amendment step run in `~/git/devdb` with devdb conventions (trailer kept). T2 and T3 are the concurrency core — their `-race` tests are part of the gate, not optional.

**2. Inline Execution** — superpowers:executing-plans, batch execution with checkpoints.
