# Initiative A — build-from-source assessment (own CI pipeline vs extracting from Neon's Docker images)

Research date: 2026-07-06. Read-only, no upstream issues/PRs/comments filed (per hard rule).

Sources: local `~/git/neond` (Makefile, Dockerfile, rust-toolchain absence), local `~/git/neon @ 8f60b04`
(Makefile, postgres.mk, Dockerfile, compute/compute-node.Dockerfile [2042 lines], build-tools/Dockerfile,
rust-toolchain.toml, README.md, docs/docker.md, .github/workflows/{release.yml, release-storage.yml,
release-compute.yml, build_and_test.yml, build-build-tools-image.yml}, storage_controller/{migrations,schema.rs}),
Docker Hub registry API (live pulls for neondatabase/neon + compute-node-v14..v17 image sizes),
DevDB's own docker/Dockerfile + docker/BINARIES.md + docs/superpowers/specs/2026-07-04-devdb-dynamic-pg-builds-design.md,
and the prior extract-side feasibility doc at `neond-cut-feasibility.md`.

---

## 1. How neond builds from source today (toolchain + steps)

Single `rust:1.94.1-bookworm` base for everything. Steps, in order:

1. **Toolchain install** (apt): `build-essential libtool libreadline-dev zlib1g-dev flex bison
   libseccomp-dev libssl-dev clang pkg-config libpq-dev cmake postgresql-client protobuf-compiler
   libprotobuf-dev libcurl4-openssl-dev openssl lsof libicu-dev libxml2-dev uuid-dev` + a hand-fetched
   `protoc` binary (v22.2) + `rustup target add {aarch64,x86_64}-unknown-linux-gnu`. No `mold`, no
   `cargo-chef`, no self-hosted-runner cache registry — a plain, minimal toolchain image built fresh
   each time (no shared pre-baked base image the way upstream neon has `build-tools`).
2. **`make -C neon -j $JOBS -s`** — this literally invokes the *upstream* `neondatabase/neon` Makefile
   (neond's `neon/` submodule is a full clone of the real repo), which internally does
   `postgres-headers-install → walproposer-lib → cargo build` for the Rust workspace, plus per-major
   `postgres-install-v{14..17}` (autoconf `./configure && make install`, ~7 contrib modules) via
   `postgres.mk`. One Cargo workspace build produces `pageserver`, `safekeeper`, `storage_broker`,
   `storage_controller`, and (uniquely to neond's usage — see below) `compute_ctl`, all at once.
3. **`make vanillapg`** — `./configure --prefix=.../vanilla_v17 --without-icu --with-openssl` against
   the plain `postgres/postgres` submodule (pinned `80156cee...`, self-reports `19devel`) → `make install`.
   Plain C/autoconf, no Rust.
4. **`make neon-contrib` / `make neon-contrib-extras`** — for v14..v17, installs ~30 stock contrib
   modules (`pgcrypto`, `postgres_fdw`, `pg_stat_statements`, etc.) plus a reconfigure-and-rebuild pass
   for `xml2`/`uuid-ossp` (these need `--with-libxml --with-uuid=e2fs`, forcing a second full Postgres
   rebuild per major — the priciest single step in neond's own recipe after the initial Cargo build).
5. **`make vector`** — pgvector submodule, built once per major via `pg_config`.

Submodule pins observed: `neon@6a35a3e9...` (checked-out tree one commit ahead, i.e. an uncommitted
bump), `postgres@80156cee...`, `pgvector@d238409b...`. No lockfile/manifest ties these three pins
together as a matched set beyond `.gitmodules` — a human has to bump all three in lockstep by hand.

**Toolchain drift, real and unremarked**: neond pins `rust:1.94.1-bookworm`; upstream neon's own
`rust-toolchain.toml` (and its `build-tools/Dockerfile`) pins `RUSTC_VERSION=1.88.0`. neond is building
upstream's Cargo workspace with a materially newer compiler than upstream tests against. (Confirmed via
`git log` on neond's Dockerfile — last touched 2026-05-12, not a typo.) This is a toolchain-provenance
gap regardless of which sourcing path DevDB picks, since it currently inherits whatever neond baked.

**Build-time estimate for neond's approach**: no in-repo number: `JOBS=1` in neond's own Makefile
default (misleadingly serial-looking; the Dockerfile's `ARG JOBS=1` default is almost certainly
overridden at actual build time via `--build-arg JOBS=$(nproc)`, otherwise this would be
prohibitively slow). Reasoning from job structure rather than a measured number: a full from-scratch
Cargo release build of the neon workspace (~15+ crates: pageserver, safekeeper, storage_controller,
storage_broker, compute_ctl, libs) plus 4× full PostgreSQL `./configure && make install` (each with a
contrib pass, and v14-17 rebuilt *twice* — once for the base contrib set, again for xml2/uuid-ossp) is
a realistic **45–90+ minutes on a well-resourced multi-core CI runner with warm dependency caches**,
and **materially longer cold** (Cargo dependency compilation alone, uncached, commonly runs 15-30 min
for a workspace this size before any neon-specific code is touched). This is an order-of-magnitude
estimate, not a measurement — no timing data exists in either repo's CI logs available to this
research pass.

---

## 2. How upstream `neondatabase/neon` builds it itself (their CI's actual pipeline)

This is the more informative comparison, because it's what a DevDB-owned pipeline would essentially be
re-deriving on a smaller scale.

**Toolchain**: NOT a stock `rust:*` image. Upstream builds and publishes its own pinned
`ghcr.io/neondatabase/build-tools:pinned` image (`build-tools/Dockerfile`, parameterized by
`DEBIAN_VERSION` bookworm/bullseye, rebuilt via a dedicated `build-build-tools-image.yml` /
`pin-build-tools-image.yml` workflow pair) containing: Rust `1.88.0` (pinned via `rustup-init`,
matching `rust-toolchain.toml`), LLVM/clang 20, `mold` linker (built from source, v2.37.1),
`cargo-chef`/`cargo-nextest`/`cargo-auditable`/`cargo-hakari`/`cargo-deny`/`diesel_cli`, Node 24,
Docker CLI, AWS CLI, a static ICU 67.1 build, Python via pyenv, and (bookworm only) a patched
`pgcopydb`. This image is the single shared base for *both* the storage build (`Dockerfile`) and the
compute build (`compute/compute-node.Dockerfile`'s `build-deps-with-cargo`/`compute-tools` stages) —
i.e., upstream already treats "one consistent toolchain base, built once, reused everywhere" as
foundational infrastructure, not an afterthought.

**Storage build** (`Dockerfile`, the same recipe DevDB's extract-side plan would pull from as
`neondatabase/neon`): `pg-build` stage compiles all 4 PG majors via the shared `Makefile`/`postgres.mk`
(`mold -run make -j $(nproc) -s postgres`) *once*, cached independently of Rust changes; `cargo chef`
prepares a dependency-only recipe so Cargo deps rebuild only when `Cargo.lock` changes; the real `build`
stage does one `cargo auditable build` for all 10 storage binaries (`pg_sni_router pageserver pagectl
safekeeper storage_broker storage_controller proxy endpoint_storage neon_local storage_scrubber`) plus
`make neon-pg-ext` (the walproposer/neon.so PG extensions). Uses `mold` + `clang` linker flags
(`-Clinker=clang -Clink-arg=-fuse-ld=mold`) for materially faster link times than neond's plain Cargo
defaults.

**Compute build** (`compute/compute-node.Dockerfile`, 2042 lines, 98 `FROM` stages): explicitly
parameterized `ARG DEBIAN_VERSION` / `ARG PG_VERSION` — the SAME Dockerfile is invoked 4 times in CI
(once per major) with `DEBIAN_VERSION=bullseye` for v14/v15/v16 and `DEBIAN_VERSION=bookworm` for v17
(confirmed directly in `build_and_test.yml`'s `matrix.version` list — `v14/v15/v16→bullseye,
v17→bookworm` is hardcoded as an intentional, versioned CI matrix, not an accident of unrelated
builds). `compute_ctl`/`fast_import`/`local_proxy` are compiled once per invocation in the
`compute-tools` stage (`build-deps-with-cargo`, itself `FROM build_tools`) — so `compute_ctl` is
implicitly rebuilt 4× (once per major/Debian-version combo) even though its source doesn't change
across majors; upstream doesn't bother deduplicating that. The extension surface is enormous — 98
Dockerfile stages covering PostGIS, pgrouting, plv8, h3-pg, pgvector, pg_repack, and dozens more,
each with its own source-fetch + build stage, several needing extra system libs beyond
`build-tools`'s base set.

**CI infrastructure this actually runs on** (this is the load-bearing fact for a maintenance-cost
estimate): `runs-on: [self-hosted, large]` / `[self-hosted, large-arm64]` — **dedicated self-hosted
runners**, not standard GitHub-hosted ones — with a **remote build-cache registry**
(`cache.neon.build`, populated via `cache-to`/`cache-from` on every build, `mode=max`) and multi-arch
matrix builds (x64 + arm64 built separately, then stitched into one manifest via
`docker buildx imagetools create`). Publishing targets: `ghcr.io/neondatabase/{neon,compute-node-v{N},
vm-compute-node-v{N},neon-test-extensions-v{N}}` plus Docker Hub. Release cadence: **weekly**,
automated — `release-storage.yml` (Fridays 06:00 UTC) and `release-compute.yml` (Fridays 07:00 UTC)
each open a release PR via a shared `release.yml` workflow; storage and compute are versioned and
released **independently** of each other.

**`neon_local`'s own dev-build path** (what a contributor runs locally, `README.md`): `make -j$(nproc)`
(Linux) / `make -j$(sysctl -n hw.logicalcpu)` (macOS) — same `all: neon postgres-install neon-pg-ext`
target graph as the Makefile above, run directly on the host (not in Docker), with the same apt/brew
dependency list DevDB would need to replicate in a build image. No published wall-clock number here
either — "expect it to take a while, use `-j`" is the entire guidance.

---

## 3. Sketch: a DevDB-owned build pipeline

Goal per the task: everything on ONE consistent Debian base (bookworm), one artifact store both the
Docker image build and the runtime dynamic-pg-build-pull feature can consume.

### Shape

```
┌─────────────────────────────────────────────────────────────┐
│ Stage 0: devdb-build-tools image (built rarely, cached)      │
│   FROM rust:<pinned>-bookworm (or replicate neon's           │
│   build-tools recipe: clang+mold+cargo-chef, one Debian ver) │
│   -> published once, reused by every downstream build        │
└─────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 1: storage-binaries build (bookworm only)               │
│   clone neondatabase/neon @ pinned tag/sha                    │
│   make postgres  (v14-v17 PG-fork headers, needed for the     │
│                    Rust build's postgres_ffi crate)            │
│   cargo build --release --bin {pageserver,safekeeper,          │
│     storage_broker,storage_controller}                         │
│   -> 4 binaries, bookworm-native, no libssl1.1/libicu67 need   │
└─────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 2: per-major compute build, x4, bookworm ONLY            │
│   (the key deviation from upstream: build v14/v15/v16 on       │
│    bookworm instead of upstream's bullseye choice — upstream    │
│    parameterizes DEBIAN_VERSION precisely so DevDB CAN force    │
│    all four to bookworm without fighting their Dockerfile;      │
│    verified: compute-node.Dockerfile's ARG DEBIAN_VERSION and    │
│    build-tools' bullseye/bookworm split both already support     │
│    "bookworm for all four" as a valid, unmodified invocation —   │
│    it's just not the combination upstream's CI matrix runs)      │
│   for major in 14 15 16 17:                                     │
│     make postgres-install-v{major}  (fork-patched PG + neon.so) │
│     cargo build --bin compute_ctl (once is enough — same        │
│       source across majors; build once, reuse the binary        │
│       across all 4 output artifacts instead of upstream's        │
│       4x-rebuild-same-source waste)                              │
│   -> 4x pg_install/v{N} trees, all bookworm-native               │
└─────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 3: vanilla_v17 (storcon catalog-DB host)                 │
│   EITHER (a) build postgres/postgres from source (cheap, C-     │
│   only, minutes) — replicates neond's exact recipe, OR           │
│   (b) [recommended] substitute one of Stage 2's own v17          │
│   pg_install tree, or a trivial `apt install postgresql-17`      │
│   pull, as storcon's catalog-DB host — its diesel migrations     │
│   (safekeepers, scheduling_policy — confirmed via reading         │
│   storage_controller/migrations/*.sql + schema.rs) show no        │
│   19devel-specific SQL; "any modern real Postgres" satisfies it.  │
│   (b) ELIMINATES this build step entirely — zero extra cost.      │
└─────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 4: publish                                                │
│   Package Stages 1+2(+3) as an OCI image (NOT a bare tarball —   │
│   see §4, the runtime pull mechanism specifically speaks         │
│   registry-v2/manifest+blobs) -> push to a registry DevDB owns    │
│   or controls: options ranked below.                             │
└─────────────────────────────────────────────────────────────┘
```

### Artifact-hosting options (ranked, given the OCI-client constraint from §4)

1. **GHCR (`ghcr.io/<devdb-org>/...`)** — free for public images, speaks registry-v2 natively, zero new
   infra, DevDB's existing `oci.ts` client works UNMODIFIED (it already targets
   `registry-1.docker.io` by config; swapping `DEVDB_PG_REGISTRY_BASE`/`DEVDB_PG_IMAGE_TEMPLATE` to
   `ghcr.io`/`devdb/compute-vN` is a config change, not a code change, per the confirmed env-injectable
   design). **Recommended default.**
2. **Self-hosted `registry:2`** — full control, matches the integration test's own hermetic fixture
   pattern (`docs/superpowers/specs/2026-07-04-...` already seeds a `registry:2` container for tests) —
   viable but adds real hosting/uptime/cost burden DevDB doesn't currently carry.
3. **S3/bucket + GH Releases (tarball)** — cheapest to host, but **breaks the existing runtime-pull
   client as-is**: `oci.ts` is a registry-v2 manifest+blob client, not a generic HTTP/tarball fetcher —
   this path requires a second fetch mode in the daemon, a real code change, not just a config swap.
   Only worth it if avoiding any registry dependency is a harder requirement than reusing existing code.

### Effort estimate

- **Build time per full pipeline run**: same order of magnitude as neond's own build (§1) — 45-90+ min
  warm-cache, longer cold — since the actual compilation work (4x PG fork build, 1x large Cargo
  workspace, contrib passes) doesn't shrink just because DevDB owns the CI config. The savings versus
  neond's current recipe are in *toolchain setup* (a shared build-tools base, mold linker, cargo-chef
  caching — all copyable from upstream's own approach) and in *eliminating the vanilla_v17 gap*
  (option 3b above), not in the core PG/Rust compile time itself.
- **CI/toolchain needs**: a Linux CI runner (self-hosted or a beefy hosted runner — GitHub-hosted free
  runners are almost certainly too small/slow for this; upstream itself uses dedicated `large`/
  `large-arm64` self-hosted runners for exactly this reason), Rust toolchain pin (recommend matching
  upstream's `1.88.0` rather than neond's unpinned-drift `1.94.1`), the same apt dependency list neond
  already documents, a registry-v2 push target (see options above), and ideally a remote build-cache
  (`sccache`/registry-cache-mount) to keep incremental builds fast — without one, every release-tracking
  rebuild pays the full 45-90+ min cost again.
- **Maintenance cadence**: matching upstream's independent storage/compute weekly release cadence is
  optional — DevDB doesn't need weekly rebuilds; a pragmatic cadence is "rebuild when DevDB decides to
  bump its pinned neon commit/tag," likely monthly-to-quarterly, plus ad hoc for security patches. Each
  rebuild requires re-verifying the three submodule pins (neon/postgres-fork/pgvector) move together
  coherently — no automated tooling for this exists in either source repo; it's manual `.gitmodules`
  bumping today.
- **Multi-arch**: doubles build cost (x64 + arm64 built separately, either on two runner pools or via
  QEMU emulation — upstream uses real arm64 self-hosted runners, avoiding emulation's slowdown; DevDB's
  own current image is verified on arm64 per `docker/BINARIES.md`, so parity would need real arm64 CI
  capacity, not just a single-arch pipeline).

---

## 4. Comparison table: build-from-source (own pipeline) vs extract-from-Neon-images

| Dimension | Build-from-source (own pipeline) | Extract-from-Neon-images |
|---|---|---|
| **Base/ABI control** | **Full** — one pipeline, one Debian base (bookworm) chosen for every artifact, including v14-16. Confirmed buildable: upstream's own Dockerfiles already parameterize `DEBIAN_VERSION` per invocation (`compute-node.Dockerfile`'s `ARG DEBIAN_VERSION`, `build-tools/Dockerfile` same), so "build v14-16 on bookworm instead of bullseye" is a config-arg change to *upstream's own, unmodified* Dockerfiles — not a fork, not new build logic. This **eliminates** the mixed-base ABI mismatch (bullseye `libssl1.1`/`libicu67` vs bookworm `libssl3`/`libicu72`) at its root, because DevDB never pulls a pre-built bullseye binary at all. | **Contained, not eliminated.** Each `COPY --from=` only copies filesystop contents; DevDB's own final-stage base (bookworm) still has to carry compat shims (`libicu72` etc., already present) for the bullseye-built v14-16 binaries' transitive shared-lib needs. Functionally workable (per the prior feasibility doc) but the mismatch itself persists structurally — DevDB is permanently downstream of upstream's bullseye/bookworm split and inherits any future drift in it (e.g., if upstream ever bumps v14-16's base without also updating DevDB's compat-lib list). |
| **Reproducibility / provenance** | **High, and self-controlled.** DevDB pins exact source commits/tags for neon+postgres-fork+pgvector; build is fully auditable (`cargo auditable build` even matches upstream's own supply-chain practice); no dependency on a third party's *published binary* trustworthiness — only on the *source* being what it claims (mitigated by pinning to upstream's own tagged releases, not neond's arbitrary submodule pins). | **Good but derivative.** Depends on upstream's own release pipeline + Docker Hub's distribution integrity; DevDB inherits upstream's `cargo auditable`/SBOM/provenance attestations (`type=provenance,mode=max` on every upstream build) for free — arguably *equal or better* provenance than a fresh DevDB pipeline would generate on day one, since upstream's CI already attaches these. |
| **Infra + maintenance cost** | **High.** Needs: a real CI build farm (self-hosted runners recommended — GitHub-hosted free tier is very likely inadequate for a 45-90+ min multi-arch Rust+PG build), a registry to publish to, a build-cache strategy to keep rebuilds affordable, and an owner tracking upstream neon releases + re-pinning submodules. This is a genuinely new piece of infrastructure DevDB doesn't operate today. | **Low.** Zero build infrastructure — `docker pull` + `COPY --from=`. The only ongoing cost is periodically re-pinning the consumed image digests/tags, already the exact workflow DevDB's `docker/BINARIES.md` documents today. |
| **Offline/digest-pin ethos** | Compatible — DevDB would digest-pin its OWN published images the same way it digest-pins `neond/neond` today; philosophically identical, just one more hop removed from upstream. | Compatible today, proven — `docker/Dockerfile`'s `FROM neond/neond@sha256:...` pins by digest already; the same pattern applies directly to `neondatabase/neon@sha256:...` / `compute-node-v{N}@sha256:...`. |
| **Runtime dynamic-minor-pull requirement** | **Both paths need a pullable artifact — this is symmetric, not a differentiator by itself.** But build-from-source means DevDB must ALSO stand up and operate that pullable source (a registry it owns/controls), rather than pointing at one that already exists. Concretely: the existing runtime feature (`packages/daemon/src/compute/builds/oci.ts`) is a real **OCI registry-v2 client** — manifest-list + sha256-verified layer blobs — not a generic tarball fetcher; publishing a from-source build to plain S3/GH-Releases would NOT work with the existing client unmodified (a genuine code change), whereas publishing to GHCR/any registry-v2 endpoint DOES work unmodified — `DEVDB_PG_REGISTRY_BASE`/`DEVDB_PG_IMAGE_TEMPLATE` are already env-configurable for exactly this kind of swap (confirmed in `config.ts` + the dynamic-pg-builds design doc). | **Already exactly satisfied, today, with zero new code.** The dynamic-pg-build-pull feature is *already built and shipped* pointing at `neondatabase/compute-node-v{major}` on Docker Hub — this is the literal artifact source it was designed against (per its own design doc, "Source = official Neon per-major compute images... pulled directly by the daemon. No DevDB-hosted artifacts, no curated manifest" was an explicit, deliberate decision). Extraction and the runtime-pull feature are naturally the same sourcing decision applied twice — build image and runtime pull both point at the same upstream Docker Hub images. |
| **`vanilla_v17` gap** | Present but cheaply closed — same two options as the extract path (build stock PG from source, ~minutes, OR substitute an already-built v17/stock-PG tree — confirmed via `storage_controller`'s migrations/schema having no `19devel`-specific SQL). Because DevDB already owns the whole pipeline here, option (b) is trivially available as "just don't build a 5th PG, reuse Stage 2's v17 output" — no separate stage needed at all. | Present, same substance — no Neon Docker Hub image publishes a vanilla/stock Postgres; DevDB must either build one from source (small, ~minutes) or substitute a stock `postgres:17-bookworm` package/build. Functionally identical resolution to the build-from-source side; the gap's *size* doesn't change based on which path DevDB picks — only the surrounding infrastructure to build/host it does. |

**Bottom line the table drives toward**: build-from-source's ONE real, structural advantage over
extraction — eliminating the mixed-base ABI problem at the root rather than containing it — is
genuine and confirmed (upstream's own Dockerfiles already parameterize Debian version, so this isn't
speculative). But that advantage costs a standing CI/registry-hosting commitment DevDB doesn't have
today, applied against a problem the extraction path has *already been shown to contain adequately*
(prior feasibility doc: "nothing else requires a from-source build... zero extra build if DevDB
substitutes an already-pulled compute-node Postgres"). The runtime dynamic-pull feature is a strong
argument specifically FOR extraction, not neutral: it's already live, already pointed at the exact
images extraction would consume, and needs zero new code — whereas build-from-source would need to
either stand up a registry-v2-speaking publish target (moderate lift, config-only on the consuming
side) or extend the runtime client to a second fetch protocol (real code change).
