# Neon engine build-from-source (Worktree DB — initiative A)

Builds the Neon storage + compute engine that DevDB / Worktree DB runs on **from
pinned upstream source**, on one Debian **bookworm** base. This from-source build
**replaced** the third-party `neond/neond` image as the engine-binary supplier,
eliminating the mixed-base (bullseye/bookworm) shared-library ABI problem at the root.

## What it produces

A single-arch engine image `worktreedb-neon-engine:local-<arch>` carrying the
exact `/usr/local/share/neon` layout the outer DevDB image consumes:

- `bin/` — the 5 storage/compute binaries: `pageserver`, `safekeeper`,
  `storage_broker`, `storage_controller`, `compute_ctl`.
- `pg_install/v14..v17` — the per-major Neon compute Postgres (DevDB contrib set
  + `neon.so` + pgvector, marked trusted).
- `pg_install/vanilla_v17` — a **true upstream Postgres 17** (NOT the neon fork)
  hosting `storage_controller`'s metadata catalog (storcon_db).

## Source of truth

`versions.json` pins the entire source set (neon release + commit, the 4
per-major postgres-fork submodule commits, the pgvector tarball + sha256, the
vanilla upstream-postgres commit, Rust, the Debian base). Bumped by hand in
lockstep — no upstream tooling. `worktreedb-build check-manifest` validates it, and
cross-checks that the product `docker/Dockerfile`'s engine base-image digest still
matches the published engine digest recorded here (`publishedDigests.images.engine`).

## Build

```bash
go run ./cmd/worktreedb-build build --arch arm64   # or amd64
```

Runs `docker buildx build` for the given arch, then the in-image
`verify-binaries.sh` gate. `check-manifest` statically validates the manifest.

## Phase-1 result (2026-07-06) — go/no-go for Phase 2: **GO**

The recipe is **proven**: it compiles all four PG majors + the storage binaries +
`compute_ctl` + pgvector + a true-vanilla storcon host from source on one
bookworm base, and the self-built engine passes the full acceptance gate.

| Metric | Value |
|---|---|
| Engine image (`worktreedb-neon-engine:local-arm64`) | 2.23 GB |
| Self-built product image (`devdb:selfbuilt`) | 2.57 GB |
| Cold build (arm64, empty buildkit cache, **host under load ~15**) | ~22 min |
| `verify-binaries.sh` | `ALL BINARIES OK` — v14.18 / v15.13 / v16.9 / v17.5 + vanilla_v17 |
| Full container integration suite vs `devdb:selfbuilt` | **34/34 green** |

The build time is a **pessimistic upper bound** — measured on a machine at load
~15 (parallel sessions). A quiet host + a warm buildkit cache are substantially
faster (an incremental rebuild after a late-stage change lands in seconds to a
few minutes, since stages 0–2 cache-hit). Phase 2 measures the clean-runner figure.

## Deviations from the neond recipe (the port source)

The recipe ports neond's from-source build, adapted to assemble **all four majors
in one image** (neond builds one major per compute-node image). That adaptation +
DevDB's needs required:

1. **Rust pinned to 1.88.0** (neon's `rust-toolchain.toml`), not neond's drifted 1.94.1.
2. **rustup components pre-installed** (`llvm-tools rustfmt clippy`) — the parallel
   per-major `make -j neon-pg-ext` otherwise races on rustup's shared download dir.
3. **pgvector 0.7.4 SQL stashed/restored** across the per-major `make clean` (the
   downloaded 0.7.4→0.8.0 upgrade-base file has no make rule to regenerate).
4. **pgvector trusted-control path derived from `pg_config --sharedir`** (our
   pg_install prefix differs from neon's hardcoded `/usr/local/pgsql`).
5. **`vanilla_v17` = a separate true-upstream Postgres 17 build** (`postgres/postgres`
   @ REL_17_5), matching neond. The spec originally proposed reusing the neon-v17
   tree "for free"; Task 3's integration suite found that reuse FATALs storcon_db's
   WAL crash recovery after an unclean stop (`resource manager with ID 134 not
   registered` — the fork emits Neon-custom WAL that can't replay without the neon
   extension loaded during redo), so it was reverted to a true-vanilla build.

## Scope

Phase 1 (this directory + `cmd/worktreedb-build`) is the local, validated recipe.
Phase 2 (GitHub Actions → GHCR, multi-arch, digest-pinned manifest, `Dockerfile` +
`oci.ts` repoint, neond-ref retirement) is gated separately — see
`docs/superpowers/plans/2026-07-06-devdb-initiative-a-neon-build-pipeline.md`.
