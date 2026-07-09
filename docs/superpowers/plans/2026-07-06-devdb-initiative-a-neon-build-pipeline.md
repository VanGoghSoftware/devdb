# Initiative A — Neon Build-from-Source Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **AMENDED 2026-07-06 (Phase-1 Task-3, post-validation).** The "v17-tree-as-vanilla-storcon-PG" / "reuse v17" element below (the **Architecture** line; **Task 2 Step 1 §3**; the **Spec-coverage** line "vanilla=v17") was **REVERSED** during Phase-1 validation. Reusing the neon-FORKED v17 as storcon_db's catalog host FATALs its WAL crash recovery after an unclean stop (`resource manager with ID 134 not registered` — the fork emits Neon-custom WAL that can't replay without the neon extension loaded during redo). `vanilla_v17` is now built as a **true upstream Postgres 17** (`postgres/postgres` @ REL_17_5), matching neond's `vanillapg`. See the design-spec amendment, the build README's deviation #5, and `versions.json`'s `vanillaPostgres` pin.

**Goal:** Replace `FROM neond/neond` with a DevDB-owned pipeline that builds the Neon engine from pinned upstream source on one bookworm base, publishes digest-pinned multi-arch OCI images to GHCR, and has both the docker build and the runtime dynamic-minor-pull consume from it — eliminating the mixed-base ABI problem at the root.

**Architecture:** A multi-stage build (build-tools base → storage binaries → per-major compute `pg_install` on `DEBIAN_VERSION=bookworm` → v17-tree-as-vanilla-storcon-PG) ported from neond's working recipe + upstream neon's own `Makefile`/Dockerfiles, validated locally first, then wrapped in GitHub Actions publishing to GHCR. The daemon consumes it with **no code change** (Dockerfile `FROM` swap + `oci.ts` env-config swap).

**Tech Stack:** Docker multi-stage build; upstream `neondatabase/neon` `Makefile` + `compute/compute-node.Dockerfile` (`ARG DEBIAN_VERSION`) + `Dockerfile` (storage); Rust (pinned **1.88.0**, upstream's `rust-toolchain.toml`, not neond's drifted 1.94.1); GitHub Actions + `docker buildx` (multi-arch); GHCR (registry-v2).

## Global Constraints

- **Oracle = official `neondatabase/neon` @ a pinned release tag** (clone `~/git/neon`); `~/git/neond`'s `Dockerfile`/`Makefile` is the *working from-source recipe to port*, not an authority to copy blindly. No upstream issues/PRs/comments (hard rule).
- **Build every major on ONE base: bookworm.** `DEBIAN_VERSION=bookworm` for v14/v15/v16/v17 — a config arg to upstream's *unmodified* `compute-node.Dockerfile`, not a fork.
- **Pin a matched source set:** `neon` release tag + its `postgres`-fork + `pgvector` submodule commits, recorded in a versions manifest; bumped in lockstep by hand (no upstream tooling).
- **Behavior-preserving cutover:** produce the same `/usr/local/share/neon` layout (`bin/` + `pg_install/v14..v17` + vanilla) and the same major.minor versions the neond image provided. `docker/verify-binaries.sh` + the full container integration suite are the acceptance gate.
- **Multi-arch: amd64 + arm64** (arm64 required for native Apple-Silicon execution; current runtime is arm64).
- **Registry: GHCR, private** (`ghcr.io/<org>/…`, `<org>` TBD until the repo is pushed). The daemon consumes via `DEVDB_PG_REGISTRY_BASE` / `DEVDB_PG_IMAGE_TEMPLATE` (already env-configurable — config, not code).
- **Extension scope = match what DevDB ships today**, NOT upstream's full 98-stage surface (PostGIS/plv8/etc. are out unless already baked). Task 1 pins the exact target set.
- **Build tooling is written in Go.** The project is being renamed **DevDB → Worktree DB** and rewritten in Go (see `docs/2026-07-06-rename-to-worktree-db-and-go-rewrite.md`). The build/verify/manifest orchestration (referred to below as `build-local.sh`) is a **Go CLI at `cmd/worktreedb-build/`** under a root module `github.com/<org>/worktreedb` (`<org>` TBD; code identifier is `worktreedb`, one word — NOT `worktree`, which collides with the git term) — the first Go code, seeding the rewrite. The `neon-build/Dockerfile` + Actions YAML + `versions.json` stay declarative; the Go tool drives them. Published engine images use the new name: `ghcr.io/vangoghsoftware/worktreedb-neon-engine`, `ghcr.io/vangoghsoftware/worktreedb-compute-v{N}` *(P2-A1: org resolved = VanGoghSoftware; identifier `worktreedb`, correcting this line's earlier `worktree-` prefix)*. ~~The daemon-side repoint (Task 8) is **DEFERRED into the Go rewrite** — the Go pull client will target GHCR from the start; do NOT rewire the TS `oci.ts` now.~~ **P2-A1: defer REVERSED by Jordan (2026-07-09)** — Task 8 repoints the TS runtime pull now (two config defaults + an optional token-auth arm; see Task 8's amendment).
- npm/dep supply-chain rules unchanged; conventional commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## ⚠️ Phase gating

**Phase 1 (Tasks 1–4) is fully executable now** — it builds + validates the recipe locally on the dev Mac (arm64), no GitHub remote needed. **Phase 2 (Tasks 5–8) is GATED on the DevDB repo being pushed to a GitHub remote** (org + GHCR + Actions), which is **not done yet**. Execute Phase 1 to completion (it de-risks the whole initiative); pause before Phase 2 until the remote exists. Phase 2 tasks are authored (workflow YAML, manifest, repoints) but their *validation* (a real Actions run + live GHCR pull) happens once pushed.

## File Structure

- `docker/neon-build/Dockerfile` — **new**, the multi-stage from-source build (build-tools → storage → per-major compute → assemble `/usr/local/share/neon`). The single source of the build recipe; both local builds and CI invoke it.
- `docker/neon-build/versions.json` — **new**, the pinned manifest (neon tag + 3 submodule commits + built major.minor per major + published image digests).
- `docker/neon-build/build-local.sh` — **new**, a thin wrapper to build `neon-build/Dockerfile` locally for one arch + run `verify-binaries.sh` against the output (the Phase-1 local validation harness).
- `.github/workflows/build-neon-engine.yml` — **new** (Phase 2), CI wrapping the same Dockerfile, multi-arch, publishing to GHCR.
- `docker/Dockerfile` — **modify**, `FROM neond/neond@…` → `FROM ghcr.io/<org>/devdb-neon-engine@<digest>` (Phase 2).
- `docker/BINARIES.md` — **modify**, retire the neond image provenance → the new GHCR images + versions.json (Phase 2).
- `packages/daemon/src/config.ts` — **modify** only the two default values (`pgRegistryBase`, `pgImageTemplate`) → GHCR (Phase 2); no logic change.

---

## PHASE 1 — Local build recipe (executable now)

### Task 1: Pin the source set + define the exact build target

**Files:** Create `docker/neon-build/versions.json`.

**Interfaces:**
- Produces: `versions.json` — `{ neonTag, neonCommit, postgresForkCommit, pgvectorCommit, majors: {14,15,16,17: {minor}}, rust: "1.88.0" }` — consumed by every later task as the pin.

- [ ] **Step 1: Read the two recipes + DevDB's current target.** Read `~/git/neond/Dockerfile` + `~/git/neond/Makefile` (the working port source) and `~/git/neon/{Makefile,postgres.mk,Dockerfile,compute/compute-node.Dockerfile,build-tools/Dockerfile,rust-toolchain.toml}` (upstream). Read `docker/verify-binaries.sh` and the current running image's layout (`docker exec docker-devdb-1 sh -c 'ls /usr/local/share/neon/bin; ls /usr/local/share/neon/pg_install; /usr/local/share/neon/pg_install/v17/bin/postgres --version'`) to capture the EXACT set to reproduce: 5 storage/compute bins, `pg_install/{v14,v15,v16,v17,vanilla_v17}`, and each major's `major.minor`.

- [ ] **Step 2: Pick the pinned neon release tag.** Choose a `neondatabase/neon` release tag (a `release-compute-*` / `release-*` pair or a coherent commit) whose per-major PG minors are ≥ what the neond image ships today (so no downgrade). Record `neonTag` + resolved `neonCommit` + the `postgres`/`pgvector` submodule commits *at that tag* (`git -C ~/git/neon show <tag>:.gitmodules` + `ls-tree` the submodule gitlinks).

- [ ] **Step 3: Write `versions.json`** with those pins + the per-major minors + `rust: "1.88.0"`. This is the manifest.

- [ ] **Step 4 (test): coherence check.** Assert the manifest's majors == {14,15,16,17}, each minor ≥ the current image's minor, and the three submodule commits resolve at `neonTag`. (A shell assertion in `build-local.sh`'s `--check-manifest` mode, added here.)

- [ ] **Step 5: Commit.** `git add docker/neon-build/versions.json && git commit -m "build(neon): pin source set + build target manifest"`

---

### Task 2: Multi-stage from-source Dockerfile (storage + compute, bookworm, one arch)

**Files:** Create `docker/neon-build/Dockerfile`, `docker/neon-build/build-local.sh`.

**Interfaces:**
- Consumes: `versions.json` (Task 1).
- Produces: a build context that, when built, yields `/usr/local/share/neon/{bin,pg_install/v14..v17}` identical in layout to the neond image. `build-local.sh <arch>` builds it + runs `verify-binaries.sh`.

- [ ] **Step 1: Author the Dockerfile by porting neond's recipe with the bookworm-all adaptation.** Stages: (0) `build-tools` `FROM rust:1.88.0-bookworm` + the apt toolchain list from neond's Dockerfile (`build-essential libtool libreadline-dev zlib1g-dev flex bison libseccomp-dev libssl-dev clang pkg-config libpq-dev cmake postgresql-client protobuf-compiler libprotobuf-dev libcurl4-openssl-dev openssl libicu-dev libxml2-dev uuid-dev` + `protoc` v22.2) — one base for all. (1) clone `neondatabase/neon` @ `neonCommit` + init the `postgres`/`pgvector` submodules @ their pinned commits; `make -j$(nproc) -s postgres` then `cargo build --release --bin pageserver --bin safekeeper --bin storage_broker --bin storage_controller --bin compute_ctl` + `make neon-pg-ext` (the neon.so/walproposer PG extensions). (2) per major in 14 15 16 17: `make postgres-install-v$major` (already bookworm since the whole image is bookworm — the `DEBIAN_VERSION` axis collapses to one value here) + `make neon-contrib` for the contrib set Task 1 identified (NOT the full extension surface). (3) final stage: assemble `/usr/local/share/neon/bin` (the 5 bins) + `pg_install/v{14..17}` + `pg_install/vanilla_v17` = a copy/symlink of the v17 tree (per spec: reuse v17 as storcon's catalog host). Cite neond's Dockerfile lines as `# port: neond Dockerfile:NN` and upstream Makefile targets as `# oracle: neon Makefile <target>`.

- [ ] **Step 2: Author `build-local.sh`** — `docker buildx build --platform linux/$ARCH -f docker/neon-build/Dockerfile -t devdb-neon-engine:local-$ARCH --load .` then `docker run --rm devdb-neon-engine:local-$ARCH bash /usr/local/bin/verify-binaries.sh` (COPY `verify-binaries.sh` into the final stage first).

- [ ] **Step 3 (test = RED then GREEN): build locally for arm64 + run verify-binaries.** `bash docker/neon-build/build-local.sh arm64`. Expected first run: iterate until it builds; then `verify-binaries.sh` must print `ALL BINARIES OK` with v14.x/v15.x/v16.x/v17.x + node-less (this is the engine image, node is added by the outer devdb image) — i.e. the same major.minor set as the manifest. **This is the recipe's proof.** (Wall-clock unknown — expect 45–90+ min cold; that's the measurement.)

- [ ] **Step 4: Record the measured build time + image size** as a comment in `build-local.sh` (fills the spec's #1 risk with a real number).

- [ ] **Step 5: Commit.** `git add docker/neon-build/ && git commit -m "build(neon): multi-stage from-source Dockerfile (bookworm, all majors) + local build harness"`

---

### Task 3: Assemble a self-built devdb image + pass the full integration suite

**Files:** Create `docker/Dockerfile.selfbuilt` (a temporary Phase-1 variant; folds into `docker/Dockerfile` in Task 7).

**Interfaces:** Consumes Task 2's `devdb-neon-engine:local-arm64`. Produces a `devdb:selfbuilt` image the integration suite runs against.

- [ ] **Step 1: Author `Dockerfile.selfbuilt`** = a copy of `docker/Dockerfile` with `FROM neond/neond@…` replaced by `FROM devdb-neon-engine:local-arm64 AS neon-binaries` (everything else — node base, apt runtime libs, COPY `/usr/local/share/neon`, the daemon/web build — unchanged).

- [ ] **Step 2 (test): build it + run the in-build verify gate.** `docker build -f docker/Dockerfile.selfbuilt -t devdb:selfbuilt .` → must pass the in-build `verify-binaries.sh` (proves the assembled layout is correct).

- [ ] **Step 3 (test): the full integration suite against the self-built image.** Point the integration harness at `devdb:selfbuilt` (the tests build `devdb:dev`; run with the image overridden — `DEVDB_TEST_IMAGE=devdb:selfbuilt pnpm --filter @devdb/integration test`, adding that env override to `tests/integration/helpers/container.ts` if not present). Expected: acceptance / timetravel / mcp / pg-builds / branch-restore all green — **the recipe produces a functionally-identical engine.** (Per [[integration-timetravel-fullsuite-flake]], re-run a reddened file isolated before treating it as real.)

- [ ] **Step 4: Commit.** `git add docker/Dockerfile.selfbuilt tests/integration/helpers/container.ts && git commit -m "build(neon): self-built devdb image passes verify + full integration suite"`

---

### Task 4: Phase-1 sign-off (the local recipe is proven)

- [ ] **Step 1:** Confirm Tasks 1–3 green: manifest coherent, `verify-binaries` OK on the self-built engine, integration suite green against `devdb:selfbuilt`, build time measured. **This is the go/no-go for Phase 2** — if the recipe doesn't reproduce the engine locally, stop and revisit before touching CI.
- [ ] **Step 2:** Write a one-paragraph Phase-1 result note (measured build time, image size, any recipe deviations from neond) into `docker/neon-build/README.md`. Commit.

---

## PHASE 2 — GitHub Actions + GHCR + repoint (GATED on the repo being on a GitHub remote)

> Do not start until the DevDB repo is pushed to GitHub and `<org>` + GHCR are available. These tasks are authorable earlier, but their acceptance gates need the remote.

> **AMENDED (P2-A1, 2026-07-09 — Phase-2 pre-execution reconciliation, Fable pass; Jordan's rulings inline).**
> The gate above is **MET**: the repo is pushed to `github.com/VanGoghSoftware/devdb` (org `VanGoghSoftware`, GHCR namespace `ghcr.io/vangoghsoftware`). Changes that bind every Phase-2 task:
>
> 1. **Image names** (rename doc governs; this plan's `devdb-*` names are stale): engine → `ghcr.io/vangoghsoftware/worktreedb-neon-engine`, per-major compute → `ghcr.io/vangoghsoftware/worktreedb-compute-v{14,15,16,17}`.
> 2. **Packages stay PRIVATE + token auth (Jordan, 2026-07-09):** no public release before a whole-project + open-source-license review. GHCR packages created by a private repo's workflow are born private — no visibility action needed. Consequences: (a) the runtime pull needs credentials → Task 8 adds an optional `DEVDB_PG_REGISTRY_TOKEN` config + a Basic-auth arm on `OciClient`'s existing token exchange; (b) any machine building `docker/Dockerfile` needs a one-time `docker login ghcr.io` with a `read:packages` PAT (README note, Task 7); (c) CI authenticates with the workflow's `GITHUB_TOKEN` (`permissions: packages: write`).
> 3. **Task 8's defer is REVERSED (Jordan, 2026-07-09):** repoint the TS runtime pull now. Rationale: it proved to be two `config.ts` defaults + the small auth arm (not an `oci.ts` rewire), and it makes v14–16 Pull functional (the live ABI limitation Jordan hit while dogfooding, 2026-07-08). The Go client later targets the same images.
> 4. **New Task 7b (storcon cutover guard; Jordan's ruling: detect + refuse):** repointing `devdb:dev` (Task 7) strands PRE-EXISTING volumes — their storcon catalog was initdb'd by neond's vanilla (PG **19devel**), and the self-built engine's true-vanilla is **17.5**; PG cannot run a data dir from a different (here: newer) major, failing with a cryptic FATAL loop (observed live 2026-07-08: `unrecognized configuration parameter "autovacuum_worker_slots"`). The integration suite structurally cannot catch this (fresh volumes only). Task 7b adds a boot-time major check + actionable refusal. **Automated catalog migration is explicitly Phase-4 scope** (import/export is the user-grade migration path); installed base today ≈ Jordan's machine.
> 5. **Plan bug fixed in Task 8's text:** `DEVDB_PG_IMAGE_TEMPLATE` is a *repository path* resolved against `DEVDB_PG_REGISTRY_BASE` — the template must be `vangoghsoftware/worktreedb-compute-v{major}` (no `ghcr.io/` host prefix, which the original text wrongly baked in).
> 6. **Final-review fold-ins land here:** the `verify-binaries.sh` vanilla-regression tripwire + wiring `check-manifest` into CI (both Task 5), license inventory in BINARIES.md (Task 6).

### Task 5: GitHub Actions workflow — build multi-arch + publish to GHCR

**Files:** Create `.github/workflows/build-neon-engine.yml`.

> **AMENDED (P2-A1):** concretized against the validated Phase-1 recipe:
> - **Per-major compute images are new Dockerfile stages**, not workflow tricks: append to `docker/neon-build/Dockerfile` four artifact-carrier stages — `FROM scratch AS compute-v14` + `COPY --from=engine /out/pg_install/v14 /usr/local` (…v15/v16/v17). They are never run, only pulled: the contract is `neondatabase/compute-node-v{N}`'s layout — the pg install under `usr/local/`, which is exactly the prefix `oci.ts` extracts (`pullPrefix(prefix: "usr/local/")`). The workflow builds each with `--target compute-vNN`; the engine build and the four carriers share one cache (the carriers are cheap COPYs off the `engine` stage).
> - **Also in this task (small, pre-CI):** the `verify-binaries.sh` vanilla tripwire — the neon fork's `postgres --version` prints `17.5 (<fork-commit-hash>)`, true upstream prints bare `17.5`; assert `vanilla_v17/bin/postgres --version` does NOT match the hash-suffix pattern, so reintroducing the fork-as-vanilla rmgr-134 durability bug fails the fast gate (today only the integration suite would catch it).
> - **Workflow skeleton:** `permissions: { contents: read, packages: write }`; login via `docker/login-action` with `${{ secrets.GITHUB_TOKEN }}`; a `check-manifest` gate step (`go run ./cmd/worktreedb-build check-manifest`) before any build; a free-disk-space step FIRST on each build leg (the cold build measured ~26 GB of Docker footprint locally — standard runners need the reclaim); `--build-arg JOBS=$(nproc)`; cache `type=gha` per arch.
> - **Runners:** `ubuntu-24.04` (amd64) + `ubuntu-24.04-arm` (arm64 — standard arm64 runners cover private repos on included minutes since 2026-01-29). Both legs run the engine image's `verify-binaries.sh` natively before pushing.
> - **Tags:** engine `release-9129` (the pinned neon tag); compute `{major}.{minor}` (from `versions.json` majors) **and** `latest` (the runtime pull's default tag). Names per P2-A1: `worktreedb-neon-engine` / `worktreedb-compute-v{N}`.
> - Trigger unchanged (`workflow_dispatch` + `versions.json` path). Multi-arch stitch unchanged (`docker buildx imagetools create`).

- [ ] **Step 1: Author the workflow.** Matrix `arch: [amd64, arm64]` on the best available runners (start with GitHub-hosted `ubuntu-24.04` + `ubuntu-24.04-arm`; **flag** that upstream uses self-hosted `large` runners and GitHub-hosted may be too small/slow or hit the 6h job cap — if so, the fallback is self-hosted or larger runners). Each leg: `docker buildx build -f docker/neon-build/Dockerfile --platform linux/${arch}` reading pins from `versions.json`, push per-arch to `ghcr.io/<org>/devdb-neon-engine` + `ghcr.io/<org>/devdb-compute-v{14..17}`; then a `merge` job stitches per-arch into a multi-arch manifest (`docker buildx imagetools create`). Add a build-cache (`cache-to/cache-from: type=registry` or `type=gha`) so re-runs don't pay the full cost. Trigger: manual `workflow_dispatch` + on `versions.json` change.

- [ ] **Step 2: Author the compute-image split.** The runtime pull fetches ONE major (`devdb-compute-v{N}:{minor}`); ensure the workflow publishes each major's `pg_install` as its own image (for the pull) AND the combined `devdb-neon-engine` (for the bake). DRY: both come from the same Dockerfile's stages.

- [ ] **Step 3 (test, post-push): run the workflow.** `workflow_dispatch` → both arches build green → images appear in GHCR → `docker buildx imagetools inspect ghcr.io/<org>/devdb-neon-engine:<tag>` shows amd64+arm64.

- [ ] **Step 4:** Record the published digests into `versions.json`. Commit.

### Task 6: Update the versions manifest with published digests + write BINARIES.md

- [ ] **Step 1:** Fill `versions.json` `publishedDigests` (engine + per-major compute, per arch/manifest). **Step 2:** Rewrite `docker/BINARIES.md` — retire the `neond/neond@sha256:…` provenance; document the from-source pipeline, the pinned neon tag + 3 submodule commits, the GHCR images + digests, and the `verify-binaries` inventory. **Step 3:** Commit. (This retires the last two whitelisted neond references.)

> **AMENDED (P2-A1):** BINARIES.md additionally documents (a) the **license inventory** of what these images redistribute — PostgreSQL (PostgreSQL License), Neon engine + compute_ctl (Apache-2.0), pgvector (PostgreSQL License) — groundwork for Jordan's pre-public license review; (b) **private-registry access**: images are private — builders run `docker login ghcr.io` with a `read:packages` PAT once; the runtime pull authenticates via `DEVDB_PG_REGISTRY_TOKEN` (Task 8). Image names per P2-A1 (`worktreedb-*`).

### Task 7: Repoint the devdb Dockerfile at GHCR

- [ ] **Step 1:** In `docker/Dockerfile`, replace `FROM neond/neond@sha256:…` with `FROM ghcr.io/<org>/devdb-neon-engine@<digest>` (from `versions.json`); delete `Dockerfile.selfbuilt` (folded in). **Step 2 (test):** `docker build -f docker/Dockerfile -t devdb:dev .` passes the in-build verify gate. **Step 3 (test):** the full integration suite green against `devdb:dev`. **Step 4:** Commit.

> **AMENDED (P2-A1):** the `FROM` is `ghcr.io/vangoghsoftware/worktreedb-neon-engine@<digest>` (names per P2-A1). Because the image is **private**, Step 2 requires a one-time `docker login ghcr.io -u <github-user>` with a `read:packages` PAT on the building machine — add that prereq to README's build section (and note it in `docker/compose.yaml`'s comment if it references building). The integration suite (Step 3) is unaffected: the image is built locally by the logged-in host docker; containers never pull the engine image themselves.

### Task 7b: Storcon-catalog major guard (detect + refuse) — NEW (P2-A1)

**Files:** Modify `packages/daemon/src/engine/embedded-postgres.ts` (the storcon_db wrapper); test `packages/daemon/test/embedded-postgres.test.ts`; one integration test file `tests/integration/storcon-major-guard.test.ts`.

**Why:** Task 7 puts the true-vanilla **17.5** storcon host into `devdb:dev`, but a pre-existing volume's `storage_controller_pg_data` was initdb'd by neond's vanilla (**19devel**). PG refuses a data dir from another major with a cryptic FATAL loop (observed live 2026-07-08). Fail honest and actionable instead. Automated migration = Phase 4 (import/export).

- [ ] **Step 1 (test, RED — unit):** `EmbeddedPostgres.start()` with a data dir whose `PG_VERSION` file reads a major ≠ the binary's major must reject BEFORE spawning postgres, with an error naming both majors and the options ("this volume's storage_controller catalog was created by PostgreSQL <found>; this image ships <expected>. Start with a fresh volume, or keep running the previous image; automated migration arrives with import/export (Phase 4)."). A matching-major dir and a missing `PG_VERSION` (fresh initdb path) must start normally. Parse the file's leading integer (`17`, `19devel` → 19).
- [ ] **Step 2:** Implement the check in `EmbeddedPostgres.start()`: read `<dataDir>/PG_VERSION` if present; derive the expected major from the configured binary once (`postgres --version` at first start, or a constructor-provided expected major — match the class's existing style); on mismatch throw the actionable error (which the daemon's boot path already surfaces fatally + logs).
- [ ] **Step 3 (test, GREEN):** unit suite green.
- [ ] **Step 4 (test — integration):** fresh container boots healthy (baseline); then `docker exec` overwrite `storage_controller_pg_data/PG_VERSION` to `19devel`, restart the container, assert it exits with the actionable message in `docker logs` (deterministic — no PG-19 binaries needed to simulate the mismatch).
- [ ] **Step 5:** README upgrade note ("Upgrading from a neond-engine devdb volume") + commit.

### Task 8: Repoint the runtime dynamic-pull at GHCR + live-pull test

**Files:** Modify `packages/daemon/src/config.ts` (two default values only).

> **AMENDED (P2-A1):** scope grew by one small seam — private GHCR needs credentials — and one plan bug is corrected. Files now: `packages/daemon/src/config.ts`, `packages/daemon/src/compute/builds/oci.ts`, `packages/daemon/src/index.ts` (one line), tests `config.test.ts` + `oci.test.ts`.
> - **Corrected defaults (plan bug — the template is a repo path, no host):** `pgRegistryBase` → `https://ghcr.io`; `pgImageTemplate` → `vangoghsoftware/worktreedb-compute-v{major}`. Both stay env-overridable (`DEVDB_PG_REGISTRY_BASE` / `DEVDB_PG_IMAGE_TEMPLATE`) — pointing them back at Docker Hub + `neondatabase/compute-node-v{major}` must keep working (that's also the fallback story if GHCR is down).
> - **New optional config `DEVDB_PG_REGISTRY_TOKEN`** (string, optional, default unset) → `cfg.pgRegistryToken`. **Never logged, never in any DTO/status payload** — it lives only in config + the `OciClient` constructor.
> - **Auth arm in `OciClient`:** constructor opts gain `authToken?: string`; in `authedFetch`'s 401-challenge path, the token-endpoint request (`oci.ts:326`, currently a bare `fetch(tokenUrl)`) attaches `Authorization: Basic ${base64("x-access-token:" + authToken)}` when `authToken` is set. GHCR's token endpoint accepts a PAT via Basic (username ignored); Docker Hub's anonymous flow is untouched when unset. `index.ts:184` threads `cfg.pgRegistryToken` in.
> - **Unit tests:** config defaults + optional token parsing; `oci.test.ts` — with `authToken` set, the token request carries the Basic header (fake fetch asserts it); without, no Authorization header (anonymous unchanged); the token string never appears in thrown error messages (the token-failure error includes the URL + status/body — assert it does not echo the header).
> - **Live acceptance (Step 4) prerequisites:** a running `devdb:dev` with `DEVDB_PG_REGISTRY_TOKEN=<Jordan's read:packages PAT>` in its environment (compose `environment:` or `docker run -e`). The pull target is a published `worktreedb-compute-v{N}` from Task 5 — v14 is the meaningful one (the major that was ABI-broken from Docker Hub): pull → validate → activate → a v14 branch runs on it. That closes the loop this initiative opened.

- [ ] **Step 1 (test, RED):** add/point a unit test in `packages/daemon/test/config.test.ts` asserting the defaults are the GHCR base + `ghcr.io/<org>/devdb-compute-v{major}` template. **Step 2:** change the two defaults in `config.ts` (`pgRegistryBase` default → `https://ghcr.io`, `pgImageTemplate` default → `ghcr.io/<org>/devdb-compute-v{major}`). Keep them env-overridable. **Step 3 (test, GREEN):** `pnpm --filter @devdb/daemon test` (623+ green — logic unchanged). **Step 4 (test, post-push, live):** on a running `devdb:dev`, trigger a runtime pull of a newer minor from GHCR (`POST /api/pg-builds/pull`), confirm it downloads + validates + activates + a branch runs on it (the oci.ts client works unmodified against GHCR). **Step 5:** Commit.

---

## Divergence / decisions notes (fill during execution)

- _(record any deviation from neond's recipe, the measured build time, GitHub-hosted-vs-self-hosted runner outcome, extension-set decisions here)_

---

## Self-review

**Spec coverage:** ✅ build pipeline (T2/T5) · ✅ one-bookworm-base (T2) · ✅ per-major compute + vanilla=v17 (T2) · ✅ multi-arch (T5) · ✅ GHCR private (T5) · ✅ versions manifest (T1/T6) · ✅ Dockerfile repoint (T7) · ✅ oci.ts repoint (T8) · ✅ retire neond refs (T6) · ✅ verify-binaries + integration acceptance (T3/T7/T8) · ✅ local-first de-risk (Phase 1) · ✅ GitHub-push gating (Phase 2 banner). Future/parked (R2, public repo) intentionally out of plan scope per spec.

**Placeholder honesty:** `<org>` is a genuine known-unknown (repo not pushed) — flagged, not lazy. The Dockerfile's exact lines are Task 2's deliverable *ported from a named, existing recipe* (neond's Dockerfile + upstream Makefile targets) with the specific adaptations spelled out — not "figure it out." The extension set is pinned by Task 1 against the current image, not left vague.

**Biggest risks (carried from spec + research):** (1) build time / whether GitHub-hosted runners suffice — measured in T2, confronted in T5; (2) building v14–16 on bookworm must actually compile + pass verify — proven in T2/T3 before any CI; (3) 3-submodule lockstep — pinned in T1's manifest.
