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
