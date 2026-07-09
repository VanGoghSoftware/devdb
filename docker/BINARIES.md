# Engine binaries: pinned source + inventory

DevDB's Neon engine binaries are **built from pinned upstream source** and
published as digest-pinned, multi-arch OCI images to a private GHCR registry.
`docker/Dockerfile` bakes the engine image into `devdb:dev`; the runtime
dynamic-minor pull can opt into the per-major compute images. This doc records
the pipeline, the pinned source set, the published images + their digests, the
verified inventory, a license inventory of what is redistributed, and how to
authenticate to the private registry.

> **Provenance.** The from-source pipeline (initiative A, Phase 2, 2026-07-09)
> replaced the prior third-party engine image. All binary provenance now traces
> to `neondatabase/neon` + `postgres/postgres` + `pgvector/pgvector` at the
> commits pinned in [`docker/neon-build/versions.json`](neon-build/versions.json)
> — the single source of truth. Retiring the old image reference here closes the
> last whitelisted third-party image dependency.

## The build pipeline

- **Recipe:** [`docker/neon-build/Dockerfile`](neon-build/Dockerfile) — one
  multi-stage build on a single Debian **bookworm** base (build-tools → fetch +
  `engine` stage → per-major `pg_install` → true-upstream `vanilla` → `final`
  engine image + four `FROM scratch` `compute-v{14..17}` carriers). Ports a
  proven from-source recipe, re-based onto the official `neondatabase/neon` tree.
- **Manifest / pins:** [`docker/neon-build/versions.json`](neon-build/versions.json)
  — every pinned commit/tag + the published digests.
  `go run ./cmd/worktreedb-build check-manifest` statically validates it (the
  source set **and** the `publishedDigests` shape: five images, each with a
  well-formed `sha256:<64hex>` manifest digest). Bump the pins there, in lockstep.
- **CI:** [`.github/workflows/build-neon-engine.yml`](../.github/workflows/build-neon-engine.yml)
  — builds each arch **natively** (amd64 on `ubuntu-24.04`, arm64 on
  `ubuntu-24.04-arm`; no QEMU — the from-source PostgreSQL + Rust compile is too
  slow under emulation), runs `check-manifest` and `verify-binaries.sh` on each
  leg before pushing by digest, then stitches the per-arch pushes into multi-arch
  manifest lists (`docker buildx imagetools create`) and publishes to GHCR.
- **Local build:** `go run ./cmd/worktreedb-build build --arch <arm64|amd64>`
  builds the engine image for one arch + runs the verify gate (Phase-1 harness;
  see [`docker/neon-build/README.md`](neon-build/README.md)).

## Pinned source set

Authoritative values live in `versions.json`; summarized here:

| Component | Pin |
|---|---|
| Neon engine | `neondatabase/neon` tag **`release-9129`** @ `5340423416b46c85841904f42c93be9af145c643` |
| Rust toolchain | `1.88.0` (upstream `rust-toolchain.toml`) |
| Debian base | `bookworm` (one base for every major) |
| Postgres fork v14 | `vendor/postgres-v14` @ `c9f9fdd0113b52c0bd535afdb09d3a543aeee25f` → **14.18** |
| Postgres fork v15 | `vendor/postgres-v15` @ `aaaeff2550d5deba58847f112af9b98fa3a58b00` → **15.13** |
| Postgres fork v16 | `vendor/postgres-v16` @ `9b9cb4b3e33347aea8f61e606bb6569979516de5` → **16.9** |
| Postgres fork v17 | `vendor/postgres-v17` @ `fa1788475e3146cc9c7c6a1b74f48fd296898fcd` → **17.5** |
| pgvector | `v0.8.0` @ `2627c5ff775ae6d7aef0c430121ccf857842d2f2` (release tarball, sha256-pinned) |
| vanilla_v17 (storcon host) | **true upstream** `postgres/postgres` **`REL_17_5`** @ `5e2f3df49d4298c6097789364a5a53be172f6e85` |

`vanilla_v17` is deliberately **true upstream Postgres 17.5**, NOT the neon fork:
the fork emits Neon-custom WAL (rmgr id 134) that FATALs `storage_controller`'s
catalog DB (`storcon_db`) during crash recovery after an unclean stop, when the
neon extension isn't loaded during redo (Phase-1 Task-3 finding). It is a
separate build under `pg_install/vanilla_v17`, and `verify-binaries.sh` has a
tripwire (below) asserting it prints a bare `17.5` with no 40-hex commit hash.

## Published images (GHCR — private)

Multi-arch (amd64 + arm64) manifest-list digests — workflow run `29035944537`,
source `92886fc`. Full digests are also in `versions.json`'s `publishedDigests`;
`docker/Dockerfile`'s `FROM` pins the **engine** digest exactly.

```
ghcr.io/vangoghsoftware/worktreedb-neon-engine:release-9129
  @sha256:7c042751bb0fbe5c1593dd95c49418fc57abbead2b91565e5696fe6b8c8629f4   (engine — the /usr/local/share/neon tree)

ghcr.io/vangoghsoftware/worktreedb-compute-v14:14.18  (+ :latest)
  @sha256:6d29d3f44e840e863406895b9ed6f2389d22f574c6ead4e0fd7ea94712c60fa3
ghcr.io/vangoghsoftware/worktreedb-compute-v15:15.13  (+ :latest)
  @sha256:edd1f32867443fdae126da760573f4e122555202201f63724105307de2d6deff
ghcr.io/vangoghsoftware/worktreedb-compute-v16:16.9   (+ :latest)
  @sha256:a38e706ae8ecb358ac1bc760f51142ae63bf3539f9fa2d27e4c9e5364b94c7a1
ghcr.io/vangoghsoftware/worktreedb-compute-v17:17.5   (+ :latest)
  @sha256:b7dffec7638a8a8c944868dd492b0799e3cd2b37ef378bb94cd4430da6ec5709
```

The **engine** image carries the full `/usr/local/share/neon` tree the outer
`docker/Dockerfile` `COPY`s. The four `worktreedb-compute-v{N}` images are
`FROM scratch` carriers, each holding one major's `pg_install` under
`/usr/local/` — exactly the prefix the runtime pull
(`packages/daemon/src/compute/builds/oci.ts`, `prefix "usr/local/"`) extracts.

## `verify-binaries.sh` inventory

The in-build gate ([`docker/verify-binaries.sh`](verify-binaries.sh)) asserts the
assembled layout on every image build and each CI leg. Its `ALL BINARIES OK`
run confirms:

### Engine binaries — `/usr/local/share/neon/bin/`

`pageserver`, `safekeeper`, `storage_broker`, `storage_controller`, `compute_ctl`
— all present, executable, and free of missing dynamic-library linkage (checked
with `ldd`). The gate runs `pageserver --version`
(→ `Neon page server git:… features: []`) and `test -x` (+ `ldd`) on the rest
(the other four have CLI quirks around `--version`, so the gate does not invoke
it on them).

### `pg_install/` — the Postgres majors

| dir | `postgres --version` | role |
|---|---|---|
| `v14` | PostgreSQL 14.18 | tenant PG (supported) |
| `v15` | PostgreSQL 15.13 | tenant PG (supported) |
| `v16` | PostgreSQL 16.9 | tenant PG (supported) |
| `v17` | PostgreSQL 17.5 | tenant PG (supported) |
| `vanilla_v17` | PostgreSQL 17.5 (true upstream — **bare** version, no commit hash) | `storcon_db` catalog host — **not** tenant-selectable |

```
SUPPORTED_PG_VERSIONS = [14, 15, 16, 17]
```

Every `v<N>` directory (N ≥ 14, excluding the `vanilla_v17` special case) with an
executable `bin/postgres`; default = highest = `17`. **v18 is absent** (deferred
to a later phase — do not add it here). `verify-binaries.sh`'s
`EXPECTED_PG_VERSIONS` is kept in sync with this list.

**Two hard tripwires** (both fail the fast gate, exit 1):

- `vanilla_v17/bin/{postgres,initdb}` MUST be present — otherwise
  `EmbeddedPostgres.resolveVanillaPgDir` silently falls back to the neon-forked
  `v17`, reintroducing the rmgr-134 crash-recovery regression through a side door.
- `vanilla_v17/bin/postgres --version` MUST print a **bare** `17.5` — the neon
  fork carries a 40-hex commit hash in parens (`17.5 (fa1788475e…)`); if that
  pattern appears, someone reintroduced the fork-as-vanilla durability bug.

> Note vs. the prior third-party image: its `vanilla_v17` reported `19devel` (a
> bleeding-edge internal build). It is now a pinned, true-upstream **17.5**, and
> the tripwire enforces "true upstream, not fork."

## License inventory (redistributed content)

Groundwork for the pre-public open-source license review. These images
redistribute compiled binaries of:

| Component | License | Upstream source |
|---|---|---|
| PostgreSQL — `v14`–`v17` (neon fork) + `vanilla_v17` (true upstream) | PostgreSQL License (permissive, BSD-like) | `neondatabase/neon` postgres fork; `postgres/postgres` |
| Neon storage engine — `pageserver`, `safekeeper`, `storage_broker`, `storage_controller` | Apache-2.0 | `neondatabase/neon` |
| `compute_ctl` + neon PG extensions (`neon.so`, walproposer) | Apache-2.0 | `neondatabase/neon` |
| pgvector | PostgreSQL License | `pgvector/pgvector` v0.8.0 |

These are DevDB's own builds of the above upstream sources at the pinned commits;
no upstream license text is altered. Redistribution obligations (attribution /
`NOTICE`) are to be settled in the pre-public review — until then the images are
**private** (see below).

## Private-registry access

The GHCR packages are **private** (born private under the private repo; no public
release until the license review). Two consumers need credentials:

- **Building `docker/Dockerfile`** — the `devdb:dev` image `FROM`s the private
  engine image, so the building machine needs a **one-time**
  `docker login ghcr.io -u <github-user>` with a **`read:packages`** PAT. The
  container integration suite is unaffected: the image is built by the logged-in
  host docker; the test containers never pull the engine image themselves.
- **Runtime dynamic-minor pull (opt-in)** — the daemon **defaults to Neon's
  public Docker Hub compute images** (anonymous; v17 works, v14–16 are ABI-broken
  on the bookworm runtime). To pull the from-source, all-bookworm
  `worktreedb-compute-v{N}` images instead (all majors fixed), set all three env
  vars (see `docker/compose.yaml`'s commented `environment:` block):

  | Env var | Opt-in value |
  |---|---|
  | `DEVDB_PG_REGISTRY_BASE` | `https://ghcr.io` |
  | `DEVDB_PG_IMAGE_TEMPLATE` | `vangoghsoftware/worktreedb-compute-v{major}` (a repo path — no `ghcr.io/` host prefix) |
  | `DEVDB_PG_REGISTRY_TOKEN` | a `read:packages` PAT |

  The token is Basic-auth'd to GHCR's token endpoint by `oci.ts`; it is **never
  logged** and **never** appears in any DTO / status payload.

CI authenticates with the workflow's `GITHUB_TOKEN` (`permissions: packages: write`).

## Runtime-pulled builds are not part of this inventory

Everything above is the engine image's baked set, fixed at build time and pinned
by the engine digest. Since the dynamic-pg-builds phase, DevDB can additionally
pull compute builds at runtime onto the `/data` volume, under
`/data/pg_builds/v{major}/{shortDigest}` (a content-addressed directory name
derived from the pulled image's sha256 digest — not the release tag, which is
recorded as metadata alongside it). These live entirely **outside** this image's
inventory and its digest pin: they're pulled, verified, and validated
independently per install, and the registry (SQLite `pg_builds` table) records
the resolved tag and image digest for each one. See the README's
[Postgres builds](../README.md#postgres-builds) section for the user-facing
surfaces (Settings / REST / MCP).

## Runtime interface

Set by `docker/Dockerfile`:

```
NEON_BINARIES_DIR=/usr/local/share/neon/bin
PG_INSTALL_DIR=/usr/local/share/neon/pg_install
DEVDB_DATA_DIR=/data
DEVDB_HTTP_PORT=4400
DEVDB_PORT_RANGE=54300-54339
```

The outer image runs as user `node` under Node `v22.x`. Workspace install uses
`pnpm install --frozen-lockfile` followed by `pnpm -r build`; the lockfile's
supply-chain policy check (`minimumReleaseAge: 1440`) passes inside the image
build.

## Platform coverage

Both `linux/amd64` and `linux/arm64` are built **natively** in CI and each leg
runs `verify-binaries.sh` before publishing, so the multi-arch manifest lists
above are verified on both architectures. A `<repo>@<manifestDigest>` pull selects
the host's arch automatically. (The current dev runtime is arm64 — Apple Silicon.)
