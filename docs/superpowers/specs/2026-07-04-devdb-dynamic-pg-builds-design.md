# DevDB Dynamic Postgres Build Provisioning — Design

**Date:** 2026-07-04 · **Status:** approved (brainstormed with Jordan) · **Scope:** its own phase, independent of phase 4 (no bucket dependency); sequencing vs phase 4 at Jordan's discretion.

## Problem & goal

DevDB's Postgres builds are frozen at image-build time (digest-pinned neond snapshot: 14.18 / 15.13 / 16.9 / 17.5). Users should be able to (a) pull a **newer minor** of an installed major (bugfixes, e.g. 16.9 → 16.10) and (b) add a **major not baked into the image**, at **runtime, from inside the product, without destroying and re-upping the container**. Agents must be able to do the same over MCP.

## Settled decisions

1. **Source = official Neon per-major compute images** (`neondatabase/compute-node-v{major}` on Docker Hub), pulled **directly** by the daemon. No DevDB-hosted artifacts, no curated manifest. Verified live: images are pushed per release (tags = release numbers + `latest`), multi-arch (amd64+arm64), and their `/usr/local` prefix is exactly the `bin/lib/share/include` shape of our `pg_install/v{N}` dirs (probe: `neondatabase/compute-node-v17:latest` → `bin/postgres` 17.5, `lib/neon.so`, `lib/neon_rmgr.so`, `share/extension/neon.control`, bundled `compute_ctl`).
2. **Reproducibility = digest-pinning at install time** (tag→digest resolved at pull, both recorded; every layer sha256-verified) + everything cached on the `/data` volume. Offline behavior unchanged: no network means no *new* pulls, everything installed keeps working.
3. **Safety = in-container validation gate**, not pre-curation: every downloaded build must boot a throwaway compute against the *live* storage and pass smoke SQL before it becomes activatable.
4. **Global active build per major.** No side-by-side minors, no per-project minor pinning (Neon's own model). Project `pgVersion` remains a major.
5. **Adopt on next endpoint restart.** Activation never touches running endpoints; each records the `pgbinPath` it started with, and the UI hints "running 16.9 → 16.10 active, restart to adopt".
6. **User/agent-initiated only.** No background update checks, no auto-pulls. The only network egress is the explicit check/pull actions (hosts: `auth.docker.io`, `registry-1.docker.io`).
7. **In-daemon provisioner** (chosen over host-side scripts and image re-pins): everything through UI/REST/MCP, agents can self-serve, no host docker required.
8. **Baked `compute_ctl` is retained; only `--pgbin` swaps.** `compute_ctl` is built to drive multiple Postgres versions; adopting a downloaded `compute_ctl` would drag its ComputeSpec/config schema into our oracle-derived contract. If a build's neon extension can't pair with the baked `compute_ctl`, the gate fails it cleanly.
9. **Minor refresh is the first-class guarantee. New-major-via-pull is supported-if-the-baked-storage-supports-it** — per-tenant WAL-redo runs inside the baked pageserver, so a major the storage release predates cannot be served regardless of compute binaries. The gate answers this empirically (it exercises basebackup + WAL-redo through the real pageserver). The guaranteed new-major path remains re-pinning the base image (phase 5).
10. **Downgrades are never silent** (see Boot reconciliation). Rationale: computes are stateless (pg_data synthesized from pageserver each start) and WAL/page formats are frozen within a major, but the **neon extension's catalog version persists in user data and upgrades forward only** — backward is the direction that can bite.

## Architecture

New daemon unit `packages/daemon/src/compute/builds/` — three focused files:

- **`registry.ts` (BuildRegistry)** — owns the SQLite `pg_builds` table and the resolution rule. The rest of the daemon uses one method: `pgbinFor(major) → absolute path to bin/postgres`, consulted per endpoint start (this is what makes adopt-on-restart structural). Baked builds are seeded as ordinary rows (`source: 'baked'`, path = image `pg_install/v{N}`), so fallback needs no special case.
- **`provisioner.ts` (Provisioner)** — orchestrates check / pull → verify → extract → validate → activate as an async job; one global provisioning job at a time (concurrent attempts → generic 409). Writes a `jobs` row for bookkeeping; job *observability* this phase is the `pg_builds.status` field + SSE events + a `pgbuild:<id>` log channel (a jobs REST API remains phase 4's contract).
- **`oci.ts` (OciClient)** — minimal anonymous registry-v2 pull: token → manifest list (select by `process.arch`) → layer blobs. Streams each blob to a spool file while sha256-verifying against its content address, then two `tar` passes (list → apply `.wh.` whiteouts → extract `usr/local/` only). **Zero new npm deps** (node `fetch`/`zlib`/`crypto` + system `tar`); registry base URL and image template are config-injectable.

**Volume layout:** `/data/pg_builds/v{major}/{shortDigest}/` — **content-addressed**, not tag-addressed: `shortDigest` is the first 16 hex chars of the image's sha256 digest (`registry.ts`'s `shortDigest`), and it's also the row id's basis (`dl-{major}-{shortDigest}`). The release tag is recorded as row/marker **metadata only**, never as a path component — a self-describing `build.json` marker (digest, tag, minor, extractedAt) lives inside each build dir. Content-addressing means a re-pull of a mutable tag (e.g. `latest`) that has moved to a new digest lands in a new dir beside the old one instead of colliding with it. Extraction goes to a `.tmp-{shortDigest}` sibling and is **atomically renamed** into place — a crash leaves only a sweepable `.tmp-*`, never a half-registered build.

**Seam changes in existing code:**
- `compute/manager.ts:148` — `--pgbin` stops join-ing `cfg.pgInstallDir` and takes the path resolved via `pgbinFor(major)` (threaded from EndpointsService). `RunningCompute` gains `pgbinPath` (adoption hints; delete/GC protection).
- `engine/configs.ts:27` — pageserver `pg_distrib_dir` points at a **composed symlink dir** `/data/pg_distrib`, rebuilt at boot and on activation: majors that exist baked **always** symlink to the baked dir (minors never perturb the storage engine's binaries); only majors with no baked dir symlink to their downloaded build (WAL-redo for a new major necessarily uses the downloaded bits). `resolveVanillaPgDir` (storcon's internal DB) stays on the baked `pg_install`, untouched.
- `packages/shared` — `SUPPORTED_PG_VERSIONS`/`PgVersionSchema` relax from the 14–17 literal union to integer (≥14) + runtime validation against the registry; UI/MCP fetch the live major list. A downloaded v18 then appears with no code change.
- `config.ts` — new envs `DEVDB_PG_REGISTRY_BASE` (default `https://registry-1.docker.io`) and `DEVDB_PG_IMAGE_TEMPLATE` (default `neondatabase/compute-node-v{major}`), validated like the rest; overrides serve mirrors/air-gap and the hermetic test registry. Builds dir derives from `dataDir` (no env).

## Data model

Two additive migrations. `pg_builds`: `id, major, minor, source ('baked'|'downloaded'), releaseTag, imageDigest, path, status ('downloading'|'validating'|'ready'|'failed'), active (0|1, ≤1 per major), sizeBytes, createdAt`. `pg_majors`: `major (PK), lastRunMinor` — the per-major high-water mark the downgrade guard compares against (updated when an endpoint of that major starts; lowered only by consented rollback). Nonexistent-repo majors fail the pull with the registry's 404 surfaced cleanly.

## Provisioning pipeline

1. **Check** (`POST /api/pg-builds/check`) — compare remote `latest` digest per major against installed digests → "update available (Neon release 9124)". Tags are release numbers, not PG minors: the actual minor is only knowable post-extract, and the surface is honest about that (minor confirmed and shown after step 4). Explicit tags supported (also the rollback re-pull path).
2. **Preflight** — `fs.statfs` on `/data`, require ~1.5 GB headroom; dedup by digest (already installed → friendly no-op).
3. **Download + extract** — per the OciClient above, into `.tmp-{shortDigest}`.
4. **Fixup + marker** — run `bin/postgres --version`; **must match the requested major** (mismatch → failed); record minor + `du` size; write `build.json`; atomic rename into place.
5. **Validation gate** (~90 s budget) — create a throwaway `_devdb_validate_{ts}` project of that major **through the normal service layer**; start its endpoint with an internal `pgbinPath` override (EndpointsService → ComputeManager; never exposed over REST/MCP); this exercises the real path — basebackup from the live pageserver, WAL to the safekeeper, neon extension load — then smoke SQL (`SELECT version()`, create/insert/select, a neon-GUC probe). Success → `ready`. Failure → `failed`: extracted dir deleted (no 250 MB corpses), job log tail kept, row kept for the record, retry allowed. Temp project deleted in `finally`; boot sweeps orphans.
6. **Activate** — a validated pull **auto-activates** (that is what the pull gesture means): one atomic flip of `active` within the major + SSE event. Explicit activate/rollback among installed `ready` builds is allowed; rollback carries a confirm warning (decision 10) and consented rollback lowers `lastRunMinor` so it doesn't trip the guard. An endpoint start that already resolved the old path just runs the old build (adopt-on-restart tolerates the race; activation itself is a single synchronous SQLite update).

   **Decision (Jordan, 2026-07-05): the MCP `activate_pg_build` tool refuses downgrades outright.** It checks downgrade-ness against the `pg_majors` high-water mark *before* ever calling `BuildRegistry.activate`, and if the target is below the last-run minor it returns an error directing the caller to the human-consent path — it never passes `consented:true` on an agent's behalf, and never even attempts the call. The only ways to consent a downgrade are the **web UI's confirm dialog** or **REST `POST /api/pg-builds/:id/activate` with `{"consented":true}`**; both activate the build *and* lower `lastRunMinor`, clearing the degraded flag. Rationale: an autonomous agent must not silently roll a branch's data back onto an older Postgres minor — that has to be a human's call.

**GC:** keep active + one previous per major; never delete a build whose path a running compute holds (`pgbinPath`) — explicit `DELETE` gets a 409. **Baked builds can never be deleted at all**: they ship in the image, have no removable on-disk pull dir, and `assertRemovable` 409s any baked row unconditionally (the web Settings card disables Delete for baked rows accordingly). Only downloaded rows are GC/delete-eligible. The rest is deletable explicitly; boot GC enforces keep-2.

## Boot reconciliation

Runs with state setup, before endpoints resume; the composed `/data/pg_distrib` is (re)built here, before the pageserver starts.

1. Seed/refresh baked rows from the image's `pg_install/v{N}` (minor detected once via `--version`).
2. Scan `/data/pg_builds/*/*/build.json` — re-adopt volume builds into the registry (markers are self-describing, so this recovers from a lost SQLite); presence-check `bin/postgres` rather than re-hashing 250 MB per boot (the atomic-rename discipline is what makes that trustworthy); rows whose dirs vanished → `failed`.
3. Sweep `.tmp-*` dirs and orphaned `_devdb_validate_*` projects.
4. **Resolve actives:** per major, **newest valid minor wins regardless of source** (valid = `ready`/baked with its dir and `bin/postgres` present; tie → baked; the duplicate downloaded copy becomes GC-eligible). This is the recreate-the-container scenario handled structurally: a volume 16.10 survives re-up and keeps winning over a still-16.9 image; a newer image's baked 16.11 wins over a downloaded 16.10 (upgrade, consistent with adopt-on-restart since boot restarts everything).
5. **Monotonicity guard:** if resolution lands below `lastRunMinor` (volume build lost/corrupt, only older baked remains), the major gets a **degraded-downgrade flag** — `/api/status` + UI banner naming the fix ("PG 16 running 16.9, previously 16.10 — re-pull release 9124") — and endpoints still start (local-dev pragmatism; data stays safe in the pageserver either way). Never silent.

## Surfaces

- **REST:** `GET /api/pg-builds`; `POST /api/pg-builds/check`; `POST /api/pg-builds/pull {major, tag?}` → 202 (409 if one runs); `POST /api/pg-builds/:id/activate`; `DELETE /api/pg-builds/:id` (409 active/in-use/baked). Zod → 400, generic 409s, per house rules.
- **Events:** new type `pg_builds` in the strict whitelist (no ids) → invalidates builds query + status.
- **Status:** `/api/status` gains `pgBuilds` (per major: active minor, source, last-seen update, degraded flags). This touch also folds in the deferred `StatusDto.engine` union widening (`"starting"` — handover §5).
- **MCP:** `list_pg_builds`, `check_pg_updates`, `pull_pg_build {major, tag?}` (returns immediately; poll `list_pg_builds`), `activate_pg_build` (refuses downgrades below the high-water mark — see Provisioning pipeline step 6). No MCP delete (infra-destructive stays human).
- **UI:** one Settings card (per-major: active minor + source chip, check-for-updates, update badge, pull with progress via status + log tail, installed list with activate/rollback/delete, downgrade banner) + the per-endpoint "restart to adopt" chip (drawer/tree) where running `pgbinPath` ≠ active.

## Compatibility & security posture

- Trust root = the `neondatabase` Docker Hub org — the same org the baked binaries derive from. Digest pinning + layer sha256 + the validation gate bound the blast radius. Downloaded postgres runs as the same non-root `node` user as everything else.
- Residual skew risk (frozen baked storage vs fresh compute — the neond snapshot's release is unknown; `pageserver --version` reports `git:unknown`) is owned by the gate. Documented troubleshooting knob if a gate fails on protocol negotiation: pin `neon.protocol_version` via pgconf (not built proactively). Hygiene, not guarantee: re-pin the base image at each devdb release (phase-5 CI) to keep the skew window small.
- Docker Hub anonymous rate limits are a non-issue at user-initiated frequency; the registry/template overrides are the documented mirror path if it ever matters.
- Supply chain: no new npm/native deps; the `minimumReleaseAge`/`allowBuilds` rules are untouched.

## Testing

- **Unit** (typed fakes; no `as any`): BuildRegistry resolution matrix (baked-only / newer-downloaded / tie→baked / missing-dir / downgrade flag / consented rollback); Provisioner state machine vs fake OciClient + fake services (success; failure → dir deleted + active unchanged; timeout; crash-sweep); OciClient vs an in-process HTTP fixture (token → manifest → blobs; arch selection; sha mismatch rejected; whiteouts applied).
- **Integration** (testcontainers, hermetic — no Docker Hub in CI): seed a `registry:2` container with a synthetic compute-node image **built from the container's own baked `pg_install/v17`**; daemon pulls from the fixture; the gate runs a real postgres against real storage end-to-end → `ready` + active. A stub-image case proves the failure path (gate fails clean; nothing half-registered). A restart case proves reconciliation: volume build survives re-up and wins; removing its dir between runs surfaces the downgrade banner.
- One documented **opt-in manual smoke script** does a real Docker Hub pull (never CI).

## Out of scope

Background/auto update checks or auto-pulls; per-project minor pinning / side-by-side minors; refreshing pageserver/safekeeper/storcon binaries; swapping in downloaded `compute_ctl`; amd64 work (code follows `process.arch`; multi-arch is phase-5); a jobs REST API (phase 4 defines it).

## Risks

- **Upstream image restructure** (compute-node layout moves off `/usr/local`): step-4 fixup fails the pull cleanly; adjust extraction and/or template override. The layout was verified live 2026-07-04.
- **Large skew gate failures** (very old baked storage vs new compute): gate rejects; user recourse = re-pin image (phase 5) or pull an older release tag. The spec's honesty about decision 9 keeps expectations right.
- **Registry API drift / auth changes:** isolated in `oci.ts` (~250 lines) behind an interface the tests fake.
