# Initiative A — Neon Build-from-Source Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

### Task 5: GitHub Actions workflow — build multi-arch + publish to GHCR

**Files:** Create `.github/workflows/build-neon-engine.yml`.

- [ ] **Step 1: Author the workflow.** Matrix `arch: [amd64, arm64]` on the best available runners (start with GitHub-hosted `ubuntu-24.04` + `ubuntu-24.04-arm`; **flag** that upstream uses self-hosted `large` runners and GitHub-hosted may be too small/slow or hit the 6h job cap — if so, the fallback is self-hosted or larger runners). Each leg: `docker buildx build -f docker/neon-build/Dockerfile --platform linux/${arch}` reading pins from `versions.json`, push per-arch to `ghcr.io/<org>/devdb-neon-engine` + `ghcr.io/<org>/devdb-compute-v{14..17}`; then a `merge` job stitches per-arch into a multi-arch manifest (`docker buildx imagetools create`). Add a build-cache (`cache-to/cache-from: type=registry` or `type=gha`) so re-runs don't pay the full cost. Trigger: manual `workflow_dispatch` + on `versions.json` change.

- [ ] **Step 2: Author the compute-image split.** The runtime pull fetches ONE major (`devdb-compute-v{N}:{minor}`); ensure the workflow publishes each major's `pg_install` as its own image (for the pull) AND the combined `devdb-neon-engine` (for the bake). DRY: both come from the same Dockerfile's stages.

- [ ] **Step 3 (test, post-push): run the workflow.** `workflow_dispatch` → both arches build green → images appear in GHCR → `docker buildx imagetools inspect ghcr.io/<org>/devdb-neon-engine:<tag>` shows amd64+arm64.

- [ ] **Step 4:** Record the published digests into `versions.json`. Commit.

### Task 6: Update the versions manifest with published digests + write BINARIES.md

- [ ] **Step 1:** Fill `versions.json` `publishedDigests` (engine + per-major compute, per arch/manifest). **Step 2:** Rewrite `docker/BINARIES.md` — retire the `neond/neond@sha256:…` provenance; document the from-source pipeline, the pinned neon tag + 3 submodule commits, the GHCR images + digests, and the `verify-binaries` inventory. **Step 3:** Commit. (This retires the last two whitelisted neond references.)

### Task 7: Repoint the devdb Dockerfile at GHCR

- [ ] **Step 1:** In `docker/Dockerfile`, replace `FROM neond/neond@sha256:…` with `FROM ghcr.io/<org>/devdb-neon-engine@<digest>` (from `versions.json`); delete `Dockerfile.selfbuilt` (folded in). **Step 2 (test):** `docker build -f docker/Dockerfile -t devdb:dev .` passes the in-build verify gate. **Step 3 (test):** the full integration suite green against `devdb:dev`. **Step 4:** Commit.

### Task 8: Repoint the runtime dynamic-pull at GHCR + live-pull test

**Files:** Modify `packages/daemon/src/config.ts` (two default values only).

- [ ] **Step 1 (test, RED):** add/point a unit test in `packages/daemon/test/config.test.ts` asserting the defaults are the GHCR base + `ghcr.io/<org>/devdb-compute-v{major}` template. **Step 2:** change the two defaults in `config.ts` (`pgRegistryBase` default → `https://ghcr.io`, `pgImageTemplate` default → `ghcr.io/<org>/devdb-compute-v{major}`). Keep them env-overridable. **Step 3 (test, GREEN):** `pnpm --filter @devdb/daemon test` (623+ green — logic unchanged). **Step 4 (test, post-push, live):** on a running `devdb:dev`, trigger a runtime pull of a newer minor from GHCR (`POST /api/pg-builds/pull`), confirm it downloads + validates + activates + a branch runs on it (the oci.ts client works unmodified against GHCR). **Step 5:** Commit.

---

## Divergence / decisions notes (fill during execution)

- _(record any deviation from neond's recipe, the measured build time, GitHub-hosted-vs-self-hosted runner outcome, extension-set decisions here)_

---

## Self-review

**Spec coverage:** ✅ build pipeline (T2/T5) · ✅ one-bookworm-base (T2) · ✅ per-major compute + vanilla=v17 (T2) · ✅ multi-arch (T5) · ✅ GHCR private (T5) · ✅ versions manifest (T1/T6) · ✅ Dockerfile repoint (T7) · ✅ oci.ts repoint (T8) · ✅ retire neond refs (T6) · ✅ verify-binaries + integration acceptance (T3/T7/T8) · ✅ local-first de-risk (Phase 1) · ✅ GitHub-push gating (Phase 2 banner). Future/parked (R2, public repo) intentionally out of plan scope per spec.

**Placeholder honesty:** `<org>` is a genuine known-unknown (repo not pushed) — flagged, not lazy. The Dockerfile's exact lines are Task 2's deliverable *ported from a named, existing recipe* (neond's Dockerfile + upstream Makefile targets) with the specific adaptations spelled out — not "figure it out." The extension set is pinned by Task 1 against the current image, not left vague.

**Biggest risks (carried from spec + research):** (1) build time / whether GitHub-hosted runners suffice — measured in T2, confronted in T5; (2) building v14–16 on bookworm must actually compile + pass verify — proven in T2/T3 before any CI; (3) 3-submodule lockstep — pinned in T1's manifest.
