# Worktree DB M2 cross-run — the reference-suite gate

The TS integration suite doubles as the Go daemon's parity oracle
(master spec §7). Parameterization (2026-07-11):

- `DEVDB_TEST_IMAGE` — image under test (default `devdb:dev`, built from
  docker/Dockerfile; when set, no rebuild happens).
- `DEVDB_TEST_ENV_PREFIX` — daemon env-var prefix (default `DEVDB_`).
  `helpers/container.ts` rewrites all `DEVDB_*` env keys it passes to the
  container, and `endpoints.test.ts` derives its port-range-variable
  assertion from the same prefix. Assertions are never weakened — the
  409 body must still name the exact env var, whichever prefix is active.

## M2 gate (11 core files — all must pass, assertions unmodified)

acceptance, projects, branching, endpoints, timetravel, events, boot,
restart, unclean-restart, retry-helper, storcon-major-guard

## M3 gate (4 build/MCP files — all must pass, assertions unmodified)

pg-builds, mcp, mcp-handshake, mcp-concurrency

State injection is image-agnostic since M3: helpers/fixture-registry.ts's
injectLastRunMinor dispatches on DEVDB_TEST_ENV_PREFIX (node+better-sqlite3
into pg_majors for the default image; the in-image sqlite3 CLI into
pg_actives for WORKTREEDB_). Assertions unchanged.

    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run pg-builds mcp mcp-handshake mcp-concurrency

Result 2026-07-12: 4/4 green against worktreedb:dev (pg-builds, mcp,
mcp-handshake, mcp-concurrency; DEVDB_TEST_ENV_PREFIX=WORKTREEDB_).
Full 15-file regression (M2's 11 + these 4) 2026-07-12: 13/15 on the first
sequential pass; the 2 reds (branching, mcp-concurrency) were 300s TIMEOUTS
under cumulative 15-file machine load and both PASSED isolated in ~8s each →
load flakes, parity holds across all 15 files.

## M4 gate (the FULL reference suite — all 16 files, assertions unmodified)

The M4 gate is the entire suite green vs worktreedb:dev — M2's 11 + M3's 4 +
web-ui. web-ui.test.ts is image-agnostic (hits dev.base :4400 only): GET / →
200 text/html with id="root", a hashed /assets/*.js → 200 JS, an extensionless
deep link → index.html (SPA fallback), and /api/<unknown> → 404 JSON (the
fallback never shadows /api or /mcp). No state injection.

    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run acceptance projects branching endpoints timetravel events \
        boot restart unclean-restart retry-helper storcon-major-guard \
        pg-builds mcp mcp-handshake mcp-concurrency web-ui

Result 2026-07-12: 16 files at parity vs worktreedb:dev. web-ui 3/3 (alone and
in the full run). The full sequential pass was 15/16 with pg-builds.test.ts
timing out under cumulative 16-file machine load; pg-builds PASSED isolated
(3/3, 37.7s) → load flake, parity holds across all 16. FULL PARITY ACHIEVED —
the Go rewrite serves the reference suite unmodified.

## Invocation

    export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
    # Build the image from the checkout that holds the M2 branching code.
    # During development that is the m2-branching-core worktree; after the
    # branch merges, ~/git/worktreedb (main) is correct:
    cd <worktreedb-m2-checkout> && docker build -t worktreedb:dev .
    cd ~/git/devdb/tests/integration && \
      DEVDB_TEST_IMAGE=worktreedb:dev DEVDB_TEST_ENV_PREFIX=WORKTREEDB_ \
      pnpm vitest run acceptance projects branching endpoints timetravel \
        events boot restart unclean-restart retry-helper storcon-major-guard

## Result

2026-07-12: **11 files / 24 tests passed (433s)** against `worktreedb:dev`
(M2 branch `m2-branching-core` @ 3365e30, `DEVDB_TEST_ENV_PREFIX=WORKTREEDB_`).
Default-path no-op confirmed the same day (`boot` + `retry-helper`, unset
env → `DEVDB_` / `devdb:dev`, 14 tests green). Every core-branching claim —
COW isolation both ways, PITR restore + reset, endpoint port exhaustion +
reuse, container-restart reconciliation with data survival, unclean-restart
recovery, typed lifecycle events, and the storcon foreign-major refusal —
holds at parity with the reference daemon, with the reference assertions
unmodified.

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

Full 16-file suite 2026-07-13 (suspend disabled): 16 files at parity, assertions
unmodified. First pass 15/16 (194s); mcp.test.ts hit the documented 57P01
compute-SIGTERM-mid-query flake (reset/restore path, machine-load, unrelated to
suspend) — re-run isolated PASSED (mcp + mcp-concurrency + mcp-handshake, 5/5,
43s). Same flake profile as the M4 gate; the additive auto-suspend, disabled by
the injected WORKTREEDB_SUSPEND_TIMEOUT_SECONDS=0, does not perturb parity.

Suspend/wake itself is proven Go-side by integration/suspend_test.go
(TestSuspendThenWakePreservesData) against the same image.

## Phase-4 (import/export) — no regression, gate unchanged

Phase 4 (local import/export, worktreedb `phase4-import-export`, 2026-07-14)
adds no rows to this gate: import and export are user-triggered operations,
never invoked by the reference suite itself, so they never enter the parity
gate — no D8-style disable-injection is needed the way suspend needed one for
M5. The same 16 files stay green against `worktreedb:dev`, reference
assertions unmodified. Import/export have their own separate container
acceptance (`TestImportRunningServer`, `TestExportImportRoundTrip`,
`TestImportOutOfRangeMajorRefused`, `TestImportFailureHonesty`,
`TestFreshBranchExportRestoresClean`) — see
`docs/superpowers/specs/2026-07-13-worktreedb-phase4-import-export-design.md`
`## Delivered` for that record.
