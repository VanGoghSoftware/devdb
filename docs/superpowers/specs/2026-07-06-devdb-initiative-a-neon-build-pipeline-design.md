# Initiative A — Neon Build-from-Source Pipeline (binary-supply cut)

**Status:** approved design (brainstormed 2026-07-06), pending implementation plan.
**Goal:** Replace the third-party `neond/neond` image as DevDB's engine-binary source with a DevDB-owned pipeline that builds the Neon engine from pinned upstream source on **one consistent base** and publishes it to our own registry — eliminating the shared-library ABI problem at the root and giving true supply-chain provenance.

## Context & motivation

DevDB's engine binaries — storage (pageserver / safekeeper / storage_controller / storage_broker), compute (`compute_ctl` + `pg_install` for v14–v17), and a vanilla PG for storcon's catalog DB — currently come from `FROM neond/neond@sha256:…`, a third-party solo-maintainer image (`matisiekpl/neond`) that itself compiles `neondatabase/neon` + the postgres fork from source. The **de-neond references** initiative (merged 2026-07-06, `613a89c`) removed all *reference* dependence on neond; this initiative (A) removes the *binary* dependence — the last thing tying DevDB to neond.

The image-extraction alternative (pull `neondatabase/neon` + `neondatabase/compute-node-v{N}` directly) was evaluated and **rejected**: Neon's images use **mixed Debian bases** — compute v14/v15/v16 = bullseye, v17 + the storage image = bookworm — which causes a shared-lib ABI mismatch on our bookworm runtime (the live PG-14 pull failure that fix-E surfaced: `postgres` needs OpenSSL 1.1 / ICU 67, runtime has OpenSSL 3 / ICU 72). Extraction can only *contain* this (bundle EOL OpenSSL 1.1 + touch the security-sensitive extraction path); **build-from-source eliminates it** — because building every major on one base is a `DEBIAN_VERSION` **config arg to Neon's own compute-node Dockerfiles, not a fork**. Feasibility: `docs/superpowers/research/2026-07-06-neond-cut-feasibility.md` + `docs/superpowers/research/2026-07-06-initiative-A-build-from-source.md`.

Jordan chose build-from-source (2026-07-06) — control, provenance, and ABI-correctness over infra-minimalism.

## Architecture

**Build (GitHub Actions)** — from a pinned Neon release (the `neondatabase/neon` repo + its `postgres` fork + `pgvector` submodules), a workflow builds:
- **Storage binaries** (pageserver, safekeeper, storage_controller, storage_broker) + `compute_ctl` — one Rust build, on a bookworm build-tools base (Rust pinned to upstream's version).
- **Per-major compute `pg_install`** (v14, v15, v16, v17) — each from Neon's own compute-node recipe with **`DEBIAN_VERSION=bookworm`** (config arg, not a fork), so all majors land on ONE base.
- **vanilla PG for storcon's catalog DB** — the v17 tree doubles as this (confirmed: storcon's diesel migrations have no `19devel`-specific SQL), closing the `vanilla_v17` gap for free.
- **Multi-arch: amd64 + arm64.** arm64 is *required* for native execution on Apple Silicon (the current runtime image is already arm64 — verified `uname -m` = `aarch64`); amd64 is kept for other/cloud users. Both build on standard runners (arm64 now covers private repos on included minutes).

**Publish** — digest-pinned OCI images to **GHCR** (private for now):
- `ghcr.io/<org>/devdb-neon-storage:<neon-release>` — storage engine + `compute_ctl`.
- `ghcr.io/<org>/devdb-compute-v{N}:<pg-minor>` — per-major compute `pg_install`; these serve **both** the image bake **and** the runtime pull.

(`<org>` = DevDB's GitHub org/user — TBD, repo not yet pushed.)

**Consume (zero daemon code change):**
- **DevDB image build:** `FROM ghcr.io/<org>/devdb-neon-storage@<digest>` + COPY the baked `pg_install`s from the per-major compute images, assembling the same `/usr/local/share/neon` layout — replacing `FROM neond/neond`.
- **Runtime dynamic-minor-pull:** repoint `oci.ts`'s config (`DEVDB_PG_REGISTRY_BASE=ghcr.io`, `DEVDB_PG_IMAGE_TEMPLATE=ghcr.io/<org>/devdb-compute-v{major}`) — `oci.ts` is already a registry-v2 client, so **no client code changes**.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Source | **build-from-source** | control/provenance; eliminates ABI at root |
| Registry | **GHCR, private** | `oci.ts` already speaks registry-v2 → config swap; private until public-ready |
| Version matrix | **latest minor per major, accumulating** | covers bugfix-minor + new-major use cases; older built minors stay published & pullable |
| Base | **bookworm, all majors** | `DEBIAN_VERSION` config arg → one base → no ABI mismatch |
| Arch | **multi-arch amd64 + arm64** | arm64 native on Apple Silicon; amd64 for other/cloud users |
| vanilla_v17 | **reuse the v17 tree** | no separate artifact needed |
| Update contract | **storage image-pinned; compute minors pull + hot-swap** | unchanged from the shipped dynamic-pg-builds feature; WAL/page format stable within a major |
| Pinning | **Neon release tag + 3 submodule commits, manual bump** | no upstream lockstep tooling; recorded in a versions manifest |

## Scope

**In scope:**
- The GitHub Actions build pipeline (storage + per-major compute + vanilla, multi-arch, bookworm) publishing to GHCR.
- A pinned **versions manifest** (Neon release tag + `neon`/postgres-fork/`pgvector` submodule commits + the built pg minor per major + image digests).
- Repoint the DevDB `Dockerfile` `FROM neond/neond` → GHCR images; assemble the same `/usr/local/share/neon` layout; keep the in-build `verify-binaries.sh` gate.
- Repoint the runtime `oci.ts` config (registry base + image template) → GHCR.
- **Retire the `neond/neond` image references** (`Dockerfile` + `docker/BINARIES.md`) — the last whitelisted neond occurrences left by the de-neond sweep.
- Validation: built binaries pass `verify-binaries.sh`; the full container integration suite is the acceptance test.

**Out of scope (parked / future — see below):** public repo + public binary hosting on Cloudflare R2; automated Neon-release/submodule bump tooling; larger-runner build-speed tuning.

## What this obviates

- **The deferred lib-bundling ABI fix** — gone entirely (one base → no missing libs → no `LD_LIBRARY_PATH` bundling, no EOL OpenSSL 1.1, no touching the security-sensitive extraction path).
- **The `vanilla_v17` gap** — closed (v17 tree reused).

## Maintenance model

Bumping to a newer Neon release (for new compute minors, new majors, or engine fixes): update the pinned Neon release tag + the 3 submodule commits in the versions manifest → run the pipeline → it builds + publishes the new storage + compute images → verify (`verify-binaries` + integration) → bump the DevDB `Dockerfile`'s digest pin for the baked set. New minors become runtime-pullable once published. Deliberate, manual cadence (no upstream lockstep tooling exists).

## Migration / acceptance

Cutover is **behavior-preserving**: the pipeline must produce binaries with the same `/usr/local/share/neon` layout + versions the neond image provided. Acceptance =
1. `docker build` passes the in-build `verify-binaries.sh` gate (all majors + node report correct versions);
2. the full container integration suite (acceptance / timetravel / mcp / pg-builds / branch-restore) stays green against the self-built image;
3. a runtime dynamic-pull from GHCR works end-to-end (pull a newer minor → activate → a branch runs on it).

## Future / parked

- **Public hosting on Cloudflare R2 (free egress) — Jordan's 2026-07-06 note.** When DevDB goes public and distribution scales, GHCR egress (private data-transfer quota) becomes a cost/scale concern. Cloudflare **R2** offers **free egress**, making it the right home for public binary hosting. Caveat: R2 is S3-compatible **object storage, not an OCI registry**, so two options — (a) run a registry-v2-compatible layer over R2 (e.g. CNCF `distribution`/`zot` backed by R2), or (b) publish binaries as **tarballs by pinned URL + checksum** and add a plain-HTTP tarball fetch path alongside the OCI one. Option (b) fits DevDB's existing pinned-URL / checksum / offline ethos and is simpler. Decide when going public.
- **Public repo** — flip from private when comfortable; makes Actions + GHCR free and keeps free arm64/amd64 public runners.

## Risks / unknowns

1. **No measured build time** — the Neon Rust build + 4 PG majors is estimated 45–90 min (unbenchmarked); the first pipeline run measures it. Larger runners (Team/Enterprise, per-minute) are the speed lever if needed.
2. **arm64 Rust build time** — arm64 standard runners now cover private repos (included minutes), but the arm64 build wall-clock is unmeasured.
3. **3-submodule lockstep** — bumping `neon` + postgres-fork + `pgvector` coherently is manual; the versions manifest + a bump checklist mitigate.
4. **Base-build validation** — building v14/v15/v16 on bookworm (vs their default bullseye) is a config arg, but must be empirically verified to compile AND pass `verify-binaries` + the live storage-validation gate for each major.
