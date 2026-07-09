# PG-builds update-check honesty (Settings card + provisioner)

Date: 2026-07-10 · Worktree: `fervent-zhukovsky-81eab1` · Base: `main @ 4b8053e`

Fixes two UX/logic gaps in the dynamic-PG-builds Settings card + its update-check.
Motivating observation: a Docker-Hub-default dogfood where `neondatabase/compute-node-v{14,15,16}`
are Debian **bullseye** (libssl.so.1.1) and won't load on the **bookworm** devdb runtime, so their
pulls fail at `detectVersion` (dynamic linker), while v17 (bookworm) loads.

## Verification (code-level, current main)

- **Gap 1** `check()` (`provisioner.ts`) sets `isNew` purely from digest/recorded-minor matching.
  - A **baked** major carries the `''` digest sentinel → `latest` never digest-matches → `isNew`
    stays true until a *successful* pull records the minor (14/15 on the dogfood: never pulled).
  - An **incompatible** `latest` fails at `detectVersion` (`classifyPgVersionError`, `version.ts`)
    **before** minor is recorded → its failed row has `minor:null` → `isNew` true **forever**, and
    re-pulling re-fails identically (16 on the dogfood). Encoded by the current test at
    `provisioner.test.ts:684` ("failed digest → isNew stays true").
- **Gap 2** both no-op paths write `status:"failed"`: digest-dedup (`provisioner.ts` ~232) and
  same-minor (`~384`). The web renders them as failures with **Retry pull** (re-runs the no-op) +
  Delete (`PgBuildsCard.tsx`). The MajorSection "Pull" is already gated on `updateAvailable`, so
  Gap 1's dishonest `updateAvailable` is what makes Pull appear when there's nothing to fetch.
- `pg_builds.status` is unconstrained `TEXT NOT NULL DEFAULT 'downloading'` (`schema.ts`) → a new
  state needs **no DB migration**, only the shared Zod enum.

## Decisions (delegated: "decide the approach in the worktree")

### Gap 1 → **honest heuristic (the task's "at minimum" B)**, not registry-config minor read (A)

Rejected A (read `latest`'s minor from image config/labels/annotation) because the **default pull
target is Neon's public Docker Hub images**, whose label/env conventions DevDB neither controls nor
can verify — the Oracle rule forbids inventing engine/image payloads. B is honest, needs no new
network round-trip, and is fully unit-testable with the existing typed fakes. A is recorded as a
future enhancement (would upgrade `unverified` → `current`/`newer` without a pull).

`check()` returns an honest per-major `state` (keep `isNew`/`tag`/`digest` for back-compat):

| state          | when                                                                 | badge / Pull                     |
|----------------|----------------------------------------------------------------------|----------------------------------|
| `current`      | `latest` digest installed ready, or its recorded minor installed ready | none                             |
| `incompatible` | `latest` digest has a **failed** row classified as a loader/incompat failure | muted "incompatible"; **no Pull** |
| `unverified`   | `latest` digest unknown, **or** a failed row from a non-incompat (transient) cause | "unverified latest" + **Pull**   |

- `isNew` := `state === "unverified"`; `updateAvailableFor` returns `latest@<digest12>` only then.
- Never claims "confirmed newer minor" (B can't confirm without a pull) — honest badge is
  "unverified latest". Keeps a genuine newer minor reachable (unverified ⇒ Pull offered), and stops
  crying "update available" for a baked-current or incompatible `latest`.
- Incompatibility detection reuses a predicate co-located with `classifyPgVersionError` in
  `version.ts` (matches the daemon-generated "is incompatible with this runtime image" marker), not
  an ad-hoc regex.

### Gap 2 → **new benign `skipped` status** for same-minor / dup no-ops

- Add `"skipped"` to `PgBuildStatusSchema` (shared). Both no-op paths set `skipped` (keep recorded
  minor + cleared path), message `already installed as <maj>.<min> (<source>) — up to date`.
- The recorded digest→minor on the skipped row is **load-bearing** for `check()` (so a baked-current
  major reads `current`) — the row must persist, so we do NOT delete it. To bound accumulation, prune
  older `skipped` siblings at the same `(major, digest)` inside the mutation lane (one survives).
- Preserves the real dedup guard in `extractFixupAndGate` — this only changes how it's surfaced.
- Boot reconcile converts historical `failed … — no-op` rows to `skipped` (idempotent) so the
  running dogfood's existing rows clean up.

## Web / MCP surfacing

- `PgBuildsCard`: badge "update available" → honest wording keyed off `state`; Pull stays gated on
  the (now honest) `updateAvailable`. New `skipped` BuildRow branch: dimmed "up to date" line, no
  Retry/Activate. `incompatible` majors show no update badge/Pull (the failed row's error explains).
- MCP `check_pg_updates` / `renderMajorBlock` / `renderBuildSubline`: honest wording for
  `unverified`/`incompatible`/`skipped`; `noActiveSuffix` treats `skipped` as benign.

## Commit plan (TDD, RED captured per behavior change)

1. `feat(pg-builds): skipped status + incompatibility predicate` — shared enum + `version.ts`.
2. `fix(pg-builds): honest update-check (unverified vs incompatible vs current)` — `check()` + tests.
3. `fix(pg-builds): record dup/same-minor pulls as benign skipped, not failed` — no-op paths + lane
   prune + boot-reconcile migration + tests.
4. `fix(mcp): honest update-check wording + skipped rendering` — `mcp/tools.ts` + tests.
5. `fix(web): honest update badge + benign skipped row` — client type + `PgBuildsCard` + tests.

Gate each at green (`pnpm --filter @devdb/daemon test`, `pnpm --filter @devdb/web test`), then the
two-gate review (independent reviewer subagent + review-broker scan) before proposing merge.

## Model note
Bounded UX/logic fix within one subsystem (provisioner update-check + its DTO/web/MCP surfacing) —
no concurrency-model / storage-durability / engine-contract change → stays on session default (Opus).
Escalate to Fable only if the lane-prune interaction proves subtle in implementation.
