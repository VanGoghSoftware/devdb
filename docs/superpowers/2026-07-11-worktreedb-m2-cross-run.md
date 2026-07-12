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

Later gates: pg-builds + mcp/mcp-handshake/mcp-concurrency at M3;
web-ui at M4 (full suite = the parity gate).

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
