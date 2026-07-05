# Dynamic PG builds — post-merge follow-ups

The dynamic-Postgres-build-provisioning feature (spec `2026-07-04-devdb-dynamic-pg-builds-design.md`, plan `2026-07-04-devdb-dynamic-pg-builds.md`) merged to main on 2026-07-05. It went through 16 TDD tasks (two gates each), an absorbed provisioner fix-round, a Fable whole-branch review + broker scan, a 6-fix final-review pass (FIX-1..7), the MCP-refuses-downgrade ruling (FIX-8), and a 2-fix concurrency hardening pass (HARD-1/2), re-reviewed by both gates to convergence.

These items were **consciously deferred** at merge (none are data-loss; all recoverable). A background task chip (`task_09f271b8`, ephemeral) was spawned with the same list. Confirm each still reproduces on current main before acting.

## 1. Concurrency-MODEL pass (the only architecturally-significant item — a design decision)
Endpoint starts (`endpoints.startLocked` → `registry.pgbinFor`) are NOT serialized with the provisioner build mutation lane, so a build-dir `rm` can race a live endpoint that launched a compute from that build's `--pgbin` dir. HARD-1 (in-lane live `runningPgbins` read in `remove()`) and HARD-2 (leave a valid build ready+active on a self-healing recompose failure instead of fail+rm) SHRANK the windows but did not close them:
- residual microtask window in `provisioner.remove()` between the in-lane supplier read and the `rm`;
- the compensation `rm` on the (now rarer) non-409 activate-malfunction path racing an endpoint start.
Proper fix is a MODEL change: either serialize endpoint starts with build-lifetime mutations, or a build-dir refcount that blocks `rm` while any running compute references the dir. Blast radius today: an rm'd in-use build dir → endpoint ENOENT, recoverable (re-pull / reboot-to-baked). Not user-data loss.

## 2. ENOTEMPTY: interrupted-validating finalDir blocks same-digest retry (broker P3, flagged 3×)
A crash after `rename(tmp→finalDir)` but before the pull reaches terminal leaves a `downloading`/`validating` row whose path points at `finalDir`. Boot's `failInterrupted` (FIX-5) marks it failed but KEEPS the path/dir (so DELETE can reclaim it), so a same-digest re-pull fails ENOTEMPTY until the user DELETEs the failed row. Fix: on boot, for interrupted rows, `rm` + clear-path when no ready sibling claims that finalDir (mirror `remove()`'s sibling guard).

## 3. FIX-6: `adoptVolumeBuilds` marker trust (broker P3, deferred because it breaks a test)
`registry.ts` `adoptVolumeBuilds` raw-casts `build.json` and trusts `marker.major/minor/digest` after only an `access(bin/postgres)` — no shape validation, no `major`==`vN`-dir check, no `shortDigest(digest)`==entry-dir check, no version re-detect (unlike `seedBaked`). Fix: validate shape + path coherence + `detectVersion` (adopt the DETECTED version, reject on disagreement). This BREAKS `tests/integration/pg-builds.test.ts` test 3, which sed's a marker to `minor:99` to fake a high-water for the downgrade-guard test — rework it to inject the high-water via a legit path (e.g. `docker exec sqlite3` on `pg_majors.last_run_minor`, or a real newer build).

## 4. Web Minors
- **#7 consent-in-degraded:** `PgBuildsCard.tsx` computes downgrade-ness vs the ACTIVE minor; the daemon uses the last-run HIGH-WATER (`registry.ts` activate). In a degraded state an Activate on an in-between build 409s with no UI consent path — catch the 409-downgrade and confirm-retry with `consented:true`.
- **#8 new-major visibility + stale badge:** the Settings card derives major sections from `status.pgBuilds` (ready majors only) — an in-flight/failed new-major pull is invisible though `usePgBuilds()` fetched its row (same class ec0027a fixed for MCP). Union both sources. The `updateAvailable` badge ignores the server's persisted `status.pgBuilds[m].updateAvailable` — fall back to it so it survives reload.
- **#9 failed-row cleanup:** failed rows accumulate unbounded (UI offers only Retry, which on a dedup no-op mints another failed row). Now that FIX-3/FIX-4 made empty-path delete safe, enable UI delete for failed rows and/or a boot-sweep of old failed rows.

## 5. Cosmetics / test hygiene
- MCP `activate_pg_build` (#11) targets by version string; same-minor rebuilds (same major.minor, new digest) are ambiguous (`find` picks oldest) — accept a digest/id disambiguator.
- Dead `PgBuildsRepo.byMajorAndTag` (#12) — drop or move to a test helper.
- `seedBaked` re-probe (FIX-2) destructures only `minor`, ignoring a changed detected MAJOR — fold into FIX-6's detect-vs-identity reconciliation.
- `seedBaked`'s probe-throw→failed branch has no pinning test.
- HARD-1 provisioner test's supplier `() => running` is a live-reference; `() => [...running]` pins the in-lane invocation airtight against an early-read regression (shipped code correct).
- Deferred test-adds: T2 (`setActiveExclusive` atomicity; `byDigest` `''` negative), T14 (clamp-when-DEFAULT-absent).
