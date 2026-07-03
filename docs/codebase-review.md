# Code Review Findings

> Durable, append-only log of model-backed review findings for this project.
> The review broker uses this as duplicate memory: prior findings are shown to
> the reviewer for de-duplication, not as an exclusion map. New sections are
> appended by `append_review_section` / scans run with `appendToDoc`.


## 2026-07-02 17:59 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan; no tests were run.

Findings:
- P3: Workspace smoke test depends on generated shared dist output (package.json:8, packages/shared/package.json:5, packages/shared/package.json:7, .gitignore:3, packages/daemon/test/smoke.test.ts:2).
- P4: Root integration test script has no root-owned Vitest binary (package.json:9, packages/daemon/package.json:26, .npmrc:1).
- P4: Node 22+ requirement is not enforced by the scaffold (package.json:5, .npmrc:1).


## 2026-07-02 18:20 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of Task 2 Dockerfile, compose wiring, digest-pinned binary inventory, frozen-lockfile install path, and verify script; no tests were run.

Findings:
- P3: verify-binaries.sh only executes pageserver, so most engine binaries can be executable-but-broken while the script reports success.
- P3: pg_install inventory is informational only; missing or non-runnable Postgres versions still reach ALL BINARIES OK.
- P3: BINARIES.md records linux/arm64 inventory, but Dockerfile/compose do not constrain or verify the build platform.
- P3: the Docker image build does not run the binary verification gate.
- P4: /usr/local/share/neon is chowned to the runtime user, making the pinned engine inventory mutable.


## 2026-07-02 18:55 CEST - Model-backed whole-surface scan

Scope: whole-surface code scan of the supplied source bundle; no tests were run.

Findings: 5 new issues. The highest-risk gaps are missing runtime Zod schemas for the shared DTOs, endpoint port ranges that can collide with fixed engine ports, and absent parity coverage for manually copied daemon port constants.


## 2026-07-02 19:40 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the attached source bundle; no tests were run.

- P2: restoreSwap can reparent unrelated rows by timeline id alone at packages/daemon/src/state/repos.ts:117.
- P2: archived branch keeps sticky port after identity is moved to replacement at packages/daemon/src/state/repos.ts:110 and packages/daemon/src/state/repos.ts:113.
- P3: branch parent foreign key does not enforce same-project ancestry at packages/daemon/src/state/schema.ts:11 and packages/daemon/src/state/schema.ts:12.
- P4: BranchQueue retains a tail entry forever for every branch id at packages/daemon/src/state/queue.ts:2 and packages/daemon/src/state/queue.ts:7.
- P4: queue rejection serialization is requested but untested at packages/daemon/test/state.test.ts:63.


## 2026-07-02 19:50 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of ManagedProcess supervisor and tests; no tests were run.

Found 5 new findings. The highest-risk issue is the timeout/retry lifecycle race: failed starts reject before the killed child has fully exited, and stale exit handlers can clear a later child. Coverage is also thin for several explicit Task 5 requirements, especially stderr readiness, fanout metadata, and ring-buffer bounds.


## 2026-07-02 20:02 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the supplied Task 6 source bundle; no tests were run.

### Findings
- P2: Connection URI does not percent-encode the password at packages/daemon/src/engine/embedded-postgres.ts:33.
- P3: Predictable pwfile path can collide or reuse unsafe file permissions at packages/daemon/src/engine/embedded-postgres.ts:39.
- P2: Repeated start() can lose the handle to an already-running postgres process at packages/daemon/src/engine/embedded-postgres.ts:54.
- P3: init() is not serialized or atomic for first-boot initialization at packages/daemon/src/engine/embedded-postgres.ts:37.
- P4: Unit tests do not pin the initdb and postgres supervisor contract at packages/daemon/test/embedded-postgres.test.ts:7.


## 2026-07-02 20:11 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the supplied Task 7 engine config generation bundle; no tests were run.

Found 5 new findings: 1 P3 source correctness issue and 4 P4 coverage or drift-resistance issues. The highest-risk item is unescaped TOML path interpolation in `pageserverToml`; the remaining findings focus on path-contract enforcement, incomplete ProcessSpec arg coverage, readiness needle parity, and duplicated port sources of truth.


## 2026-07-02 20:35 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the attached source bundle; no tests were run.

Findings: 6 new findings. Highest risk is startup failure cleanup: boot can leave an exclusive lock and already-started engine processes behind. The shutdown path also needs escalation/error handling, safekeeper registration needs bounded retry/timeout behavior, lock cleanup should verify ownership, the testcontainers image tag should be isolated per run/worktree, and the boot test should prove live downstream engine behavior rather than only the daemon status self-report.


## 2026-07-02 20:48 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the attached source bundle; no tests were run.

Findings: 5 new findings. The main implementation risk is malformed 2xx JSON bypassing EngineApiError. The remaining findings are actionable coverage gaps around error body assertions, status allowlists, method coverage, and real engine parity, plus a low-severity ID/path validation risk.


## 2026-07-02 21:00 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of Task 10 compute config generation using the supplied bundle; no tests were run.

Findings:
- P3: IPv6 cloud_admin trust rule is broader than loopback at packages/daemon/src/compute/pgconf.ts:36.
- P3: hba_file is emitted without PostgreSQL config quoting at packages/daemon/src/compute/pgconf.ts:27.
- P4: Compute config IDs are serialized without validation at packages/daemon/src/compute/spec.ts:26.
- P4: pageserver_connection_info shape is not pinned by tests at packages/daemon/src/compute/spec.ts:28.
- P4: SCRAM salt freshness and iteration binding lack targeted coverage at packages/daemon/src/compute/scram.ts:4.


## 2026-07-02 21:11 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the supplied Task 11 source bundle, focused on ComputeManager, port allocation, temp-dir lifecycle, map hygiene, status/listener behavior, and recent tests; no tests were run.

Findings:
- P2: Branch lifecycle races can orphan or untrack compute processes.
- P3: Setup failures after mkdtemp leak compute directories.
- P3: Allocated ports are not reserved before compute_ctl binds them.
- P4: ComputeManager launch contract has no unit coverage.
- P4: One log listener can prevent later listeners from seeing a line.


## 2026-07-02 21:47 CEST - Model-backed whole-surface scan

Scope: whole-surface code scan of the Task 12 project service, REST routes, narrow engine APIs, storcon tenant_create retry, and related unit/integration coverage. No tests were run.

Found six new findings: three create-path correctness risks, one REST validation mapping bug, and two actionable coverage gaps around retry bounds and live delete parity.


## 2026-07-02 22:14 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan; no tests were run.

Findings: P2 branch create lacks compensation for local insert failure after timeline creation; P2 create is not queued against parent deletion; P3 detail swallows non-transient timelineInfo failures; P3 boot failure after engine start skips engine cleanup; P4 branch REST params lack id-format validation; P4 branch names are not normalized before uniqueness checks.


## 2026-07-02 22:57 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan of the supplied endpoint lifecycle, REST route, compute config, and integration helper changes. No tests were run.

Found six credible issues at or above P4, mostly around queue semantics, failure-path state consistency, and coverage gaps in live endpoint behavior.


## 2026-07-03 00:36 CEST - Model-backed whole-surface scan

Scope: whole-surface code scan over TimeTravelService, endpoint locked API, compute manager, HTTP time-travel routes, and time-travel tests; no tests were run.

Findings: 7 new findings. The highest-risk areas are reset/create serialization, non-atomic restore/reset failure paths between engine and DB state, and compute stop cleanup when orphaned postgres reaping is incomplete.


## 2026-07-03 02:46 CEST - Model-backed whole-surface scan
Scope: whole-surface code scan; no tests were run.

Found 6 new issues: SSE backpressure can buffer without bound, compute startup logs are missed, compute log subscriptions leak through branch deletion, LogsService channel maps are unbounded, the testcontainers retry workaround can leave live failed-attempt containers during the run, and boot reconciliation lacks coverage for failed/error-preservation cases.


## 2026-07-03 03:51 CEST - Model-backed whole-surface scan

Scope: whole-surface code scan over the supplied source bundle; no tests were run.

Found 6 new issues. The highest-risk items are that the SQL execution deadline is only a server-side setting that submitted SQL can disable, and the 1000-row cap happens after pg has already loaded the entire result into daemon memory. I also found result-shape problems for multi-statement queries and duplicate column names, plus weaker acceptance coverage around child-branch mutation and a README quickstart gap around endpoint connection details and the new SQL route.


## 2026-07-03 12:57 CEST - TimeTravelService initial-stop-strand fix + verification scan
Scope: focused fix + review of `TimeTravelService.swapOntoNewTimeline` (the shared engine behind `restoreInPlace`/`resetToParent`) and its unit tests. Fix committed as 3a738c7; daemon unit suite green (226/226).

Fixed (was P3, originally found in a phase-2 broker scan): the initial endpoint stop (`stopLocked`, quiescing a running branch before the swap) sat OUTSIDE the try/catch that restarts it on failure, so a stop failure stranded a previously-running branch STOPPED even though no timeline/swap work happened and the restore/reset ultimately failed. Moved the stop to the first statement inside the try — a stop failure now routes through the existing compensation (restart original endpoint; `newTimelineCreated` still false → the timeline deletes are correctly skipped). Regression test asserts restart on the original un-swapped id, strictly after the failed stop. Both gates (review-broker gpt-5.5 + independent Fable reviewer, which re-proved the test RED against HEAD) concluded the fix is correct and complete with no P1–P4 regressions; the parked post-swap-`startLocked` crash-window (durability phase) was left untouched.

Adjacent findings surfaced by the verification scan — all PRE-EXISTING, not introduced by this change, and out of scope for the strand fix:
- P3 — timetravel.ts:199-218: if `timelineDetachAncestor` reparented child timelines and `restoreSwap` then throws, the catch deletes `newTimelineId` without undoing the already-reparented children, so engine and DB branch ancestry can diverge. Same non-atomic restore/reset failure path already noted in the 2026-07-03 00:36 scan; tracked for the durability phase. Missing test: detach returning ≥1 reparented id + `restoreSwap` throwing.
- P4 — timetravel.ts:127-134 `classifyLsnRangeError`: the regex `/lsn|out of range|bad request|not found/i` also matches generic "bad request"/"not found", so unrelated `EngineApiError` faults (missing tenant/timeline, malformed non-LSN payloads) get misclassified as client-actionable PITR-range 400s. Narrow to LSN-specific text/status per oracle branch.rs:689-701 and add a negative test proving unrelated engine errors pass through. Spun off as a follow-up task.
- P5 — timetravel.test.ts:54,126,156,277: pre-existing `EndpointsLockedApi` fakes still return `({}) as never` (rule A2 forbids `as any`/`as never`). The new stop-failure test models the compliant pattern (a real typed `BranchDetail`). Left as-is here to avoid churn with the concurrent phase-2 refactor of this file.
