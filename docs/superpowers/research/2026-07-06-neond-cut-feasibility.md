# Feasibility: sourcing DevDB's Neon engine directly from neondatabase/neon instead of neond/neond

Research date: 2026-07-06. Read-only. No upstream issues/PRs/comments filed (per hard rule).

Sources used:
- Local repo `~/git/neond` (Dockerfile, Makefile, docker-compose.yaml, docs/*.md, src/daemon/mod.rs, src/daemon/postgres/mod.rs, Cargo.toml, .gitmodules) — submodule pins: `neon@6a35a3e9f149798df1b1761ee64099d8d75fbe90`, `postgres@80156cee06b9d257251d72379ac43f9b88bd13e1`, `pgvector@d238409becebb8172fe696ffa776badfad4b631c`. (Note: the checked-out `neon/` working tree HEAD reads `f04d396c133d81e28cf52560ea11ef7e9b814d71`, one commit past the recorded submodule gitlink — an uncommitted submodule bump in the local checkout, not a discrepancy in neond's shipped Dockerfile since the Dockerfile builds whatever is checked out.)
- Upstream `neondatabase/neon` GitHub repo via `gh api` (root `Dockerfile`, `compute/compute-node.Dockerfile`, `docker-compose/docker-compose.yml`, `.github/workflows/release.yml` + `release-storage.yml`/`release-compute.yml`).
- Docker Hub registry API (manifest lists + image config blobs, pulled directly, not just docs) for `neondatabase/neon`, `neondatabase/compute-node-v14/v15/v16/v17`.
- DevDB's own `docker/Dockerfile`, `docker/verify-binaries.sh`, `docker/BINARIES.md` (prior Task-2 inventory of the current `neond/neond`-sourced image).

---

## (a) Sourcing table

| Binary / artifact | Real-Neon source | Image path | Debian base | Confidence |
|---|---|---|---|---|
| `pageserver` | `neondatabase/neon` image (built by upstream root `Dockerfile`, `build` stage `cargo auditable build --bin pageserver ...`) | `/usr/local/bin/pageserver` | **bookworm** | High — read exact Dockerfile COPY line + pulled real manifest/config blob, confirmed `debian.sh ... 'bookworm'` in image history |
| `safekeeper` | `neondatabase/neon` image, same build stage | `/usr/local/bin/safekeeper` | bookworm | High — same evidence |
| `storage_broker` | `neondatabase/neon` image, same build stage | `/usr/local/bin/storage_broker` | bookworm | High — Dockerfile explicitly has `COPY --from=build ... /storage_broker /usr/local/bin`; also runs as its own docker-compose *service* using the *same* image with `command: ["storage_broker", ...]` — confirms it's baked in, not a separate image, contradicting a stale summary of `docs/docker.md` that omitted it |
| `storage_controller` | `neondatabase/neon` image, same build stage | `/usr/local/bin/storage_controller` | bookworm | High — same Dockerfile COPY evidence; **this directly contradicts Neon's own `docs/docker.md` prose**, which only mentions pageserver/safekeeper/proxy — the actual root `Dockerfile` and `docker-compose.yml` both prove storage_controller (and storage_broker) ship in the same `neon` image. Doc is stale/incomplete relative to code. |
| `compute_ctl` | **`neondatabase/compute-node-v{N}` images** (NOT the `neon` image — the `neon` image's cargo build list has no `compute_ctl`) | `/usr/local/bin/compute_ctl` (also each image's `ENTRYPOINT`) | Matches whichever `v{N}` image it's pulled from (bullseye for v14-16, bookworm for v17) | High — read upstream `compute/compute-node.Dockerfile` final stage: `COPY --from=compute-tools ... /compute_ctl /usr/local/bin/compute_ctl`, `ENTRYPOINT ["/usr/local/bin/compute_ctl"]`. Confirmed via pulled v14 image config history ending in that exact `ENTRYPOINT`. |
| `postgres` + full `pg_install/v14` | `neondatabase/compute-node-v14` image | `/usr/local/pgsql` inside that image (mapped from `postgres-cleanup-layer`) | **bullseye** | High — empirically pulled amd64 manifest → config blob → history contains literal `# debian.sh --arch 'amd64' out/ 'bullseye' '@1738540800'` and `ARG DEBIAN_VERSION=bullseye` |
| `postgres` + full `pg_install/v15` | `neondatabase/compute-node-v15` image | same pattern | **bullseye** | High — same empirical method, confirmed |
| `postgres` + full `pg_install/v16` | `neondatabase/compute-node-v16` image | same pattern | **bullseye** | High — same empirical method, confirmed |
| `postgres` + full `pg_install/v17` | `neondatabase/compute-node-v17` image | same pattern | **bookworm** | High — same empirical method, confirmed |
| "vanilla" postgres (neond's `vanilla_v17`) | **No published Neon Docker image contains this.** It is `postgres/postgres` (the plain upstream Postgres project, submodule-pinned in neond at `80156cee...`), built by neond itself via `make vanillapg` (`./configure --prefix=.../vanilla_v17 --without-icu --with-openssl` then `make install`), run out of the `rust:1.94.1-bookworm` build stage. It is **not** any of the `neon` submodule's `vendor/postgres-v{14..17}` trees (those are Neon's *forked* Postgres, patched for WAL redo / pageserver integration) — it's stock PostgreSQL. DevDB's own `docker/BINARIES.md` records its `postgres --version` as reporting `19devel`, i.e. bleeding-edge/master, consistent with the `postgres/postgres` submodule tracking a commit ahead of any tagged release. | `pg_install/vanilla_v17/` in the assembled tree | N/A (source-built, not tied to a Debian image) | High for "must build from source, no Docker Hub artifact provides it" — confirmed by reading neond's Makefile `vanillapg` target and Dockerfile stage; the version-string evidence is High confidence from DevDB's own prior verification in `docker/BINARIES.md`. |

**Two embedded-Postgres roles, not one**: `src/daemon/mod.rs` shows neond runs *two* `Postgres::new(...)` instances off `vanilla_v17` — `storage_controller_postgres` (port 5431, storage_controller's own catalog DB — this is the one DevDB's `verify-binaries.sh` comment references as "storcon DB host") and `management_postgres` (port 5430, neond's own projects/branches/users app DB — irrelevant to DevDB, which uses SQLite for that layer per `AGENTS.md`). Only the storage_controller-DB role is relevant to DevDB's assembly gap.

**Multi-arch note (encountered, not asked but relevant to feasibility)**: `neondatabase/neon:latest` and (implicitly, standard for these repos) the compute-node images publish `linux/amd64` + `linux/arm64` manifests in the same index — DevDB's existing engine is verified on `linux/arm64` per `docker/BINARIES.md`, so multi-arch parity looks preserved if switching source.

---

## (b) neond's assembly recipe (what it does today, read directly from `~/git/neond/Dockerfile` + `Makefile`)

neond does **not** consume any of Neon's published images at all — it builds literally everything from source, from three git submodules (`neon`, `postgres`, `pgvector`), inside its own multi-stage Dockerfile:

1. **`web` stage** (`node:lts`) — builds neond's own React UI. Irrelevant to the engine question.

2. **`neon` stage** (`rust:1.94.1-bookworm`) — installs full Postgres/Rust build toolchain (`build-essential libtool libreadline-dev zlib1g-dev flex bison libseccomp-dev libssl-dev clang pkg-config libpq-dev cmake postgresql-client protobuf-compiler libprotobuf-dev libcurl4-openssl-dev openssl lsof libicu-dev libxml2-dev uuid-dev` + a manually-fetched `protoc` binary), copies in the `neon` and `postgres` submodules, then runs `make -C neon -j $JOBS -s` — i.e. **the exact same `neon/Makefile` that the upstream `neondatabase/neon` repo's own root `Dockerfile` effectively drives** (neond's `neon/` IS a full clone of `neondatabase/neon`, so this is running upstream's own build machinery, not a neond reimplementation). This is where `pageserver`, `safekeeper`, `storage_broker`, `storage_controller`, and `compute_ctl` all get compiled together (neond builds `compute_ctl` itself from the same `neon` submodule tree rather than pulling a compute-node image, since it needs everything from one Cargo workspace build for its multi-arch/local dev use case).

3. **`postgres` stage** (extends `neon`) — three things, all via neond's own `Makefile`:
   - `make vanillapg` → configures and builds **plain `postgres/postgres`** (the submodule, stock PostgreSQL — *not* Neon's fork) with `--prefix=neon/pg_install/vanilla_v17 --without-icu --with-openssl`. This is the sole source of `vanilla_v17`.
   - `make neon-contrib` → for each of `v14 v15 v16 v17`, installs a fixed list of stock Postgres contrib extensions (`bloom`, `btree_gin`, `pgcrypto`, `postgres_fdw`, `pg_stat_statements`, etc. — ~30 dirs) into each version's `neon/build/$ver/contrib/*` tree, i.e. into the Neon-fork Postgres builds already produced by step 2's `make -C neon`.
   - `make neon-contrib-extras` → reconfigures each `v14..v17` build with `--with-libxml --with-uuid=e2fs`, rebuilds, and installs `xml2`/`uuid-ossp` contrib on top.

4. **`deps` stage** — pre-builds neond's own Rust crate dependencies (cargo-chef-style dummy-`main.rs` trick) for layer caching. Pure neond control-plane concern, not engine-relevant.

5. **`server` stage** — copies in the built web UI (`dist/`) and neond's own `src/`, does the real `cargo build` of the `neond` binary itself. Not engine-relevant.

6. **Final runtime stage** (`debian:bookworm-slim`) — installs a fixed runtime-lib list (`ca-certificates curl pgbouncer libssl3 libpq5 libreadline8 libseccomp2 libcurl4 libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1`), then:
   ```
   COPY --from=server /neond/target/${BUILD_TYPE}/neond              /usr/local/bin/neond
   COPY --from=server /neond/neon/target/${BUILD_TYPE}/safekeeper           /usr/local/share/neon/bin/safekeeper
   COPY --from=server /neond/neon/target/${BUILD_TYPE}/pageserver           /usr/local/share/neon/bin/pageserver
   COPY --from=server /neond/neon/target/${BUILD_TYPE}/compute_ctl          /usr/local/share/neon/bin/compute_ctl
   COPY --from=server /neond/neon/target/${BUILD_TYPE}/storage_broker       /usr/local/share/neon/bin/storage_broker
   COPY --from=server /neond/neon/target/${BUILD_TYPE}/storage_controller   /usr/local/share/neon/bin/storage_controller
   COPY --from=server /neond/neon/pg_install                                /usr/local/share/neon/pg_install
   ```
   `pg_install` at this point contains `v14/ v15/ v16/ v17/ vanilla_v17/` (the last from stage 3's `vanillapg`), each with contrib extras baked in.

This is the exact tree DevDB's current Dockerfile pulls wholesale via `FROM neond/neond@sha256:... AS neon-binaries` + `COPY --from=neon-binaries /usr/local/share/neon ...`.

**Key structural fact for the gap analysis**: neond gets `pageserver`/`safekeeper`/`storage_broker`/`storage_controller`/`compute_ctl` from **one single build of the `neon` submodule** (all five binaries, one Cargo workspace, one toolchain image). Upstream Neon's *own* CI does **not** assemble it that way — it splits the same source into two separately-published, separately-versioned images: `neondatabase/neon` (pageserver/safekeeper/storage_broker/storage_controller/proxy) and `neondatabase/compute-node-v{N}` (compute_ctl + that version's Postgres). Going direct-to-Neon means DevDB inherits that two-image split instead of neond's single-build convenience.

---

## (c) Assembly-gap analysis — what DevDB's Dockerfile must do instead of `FROM neond/neond`

Replace the single `neon-binaries` stage with (at minimum) two `COPY --from=...` sources plus one from-source build:

1. **`FROM neondatabase/neon:<tag> AS storage-binaries`** → copy `pageserver`, `safekeeper`, `storage_broker`, `storage_controller` out of `/usr/local/bin/*`. Straightforward pull, no build. Also contains `pg_sni_router`, `pagectl`, `proxy`, `endpoint_storage`, `neon_local`, `storage_scrubber` if ever needed (DevDB doesn't use these today per `verify-binaries.sh`'s expected-binary list).

2. **`FROM neondatabase/compute-node-v17:<tag> AS pg17-binaries`** (repeat for v14/v15/v16, 4 separate `FROM` stages) → copy `compute_ctl` from **one** of these (any version works, they're identical builds of the same `compute_tools` crate — but pin the choice, e.g. v17, for reproducibility) and each version's full `/usr/local/pgsql`-equivalent tree into `pg_install/v{N}/`. **Debian-base mismatch across these 4 stages is real** (v14-16 bullseye vs v17 bookworm) but is *contained* — each `COPY --from=` only copies filesystem *contents* (binaries + libs installed under that stage's own `/usr/local`), so the differing OS base of the source stage doesn't itself leak into DevDB's final image; what matters is whether the copied `postgres` binaries' shared-library needs (e.g. v14's `libssl.so.1.1`/`libicu*.so.67`, already empirically hit by DevDB) are satisfied in DevDB's *own* final base image (`node:22-bookworm-slim` today) — i.e. DevDB's Dockerfile must keep installing whatever bullseye-vintage compat libs v14/v15/v16 need (it already does — that's exactly why `docker/Dockerfile` line 8 has `libicu72` etc. commented "oracle: neond Dockerfile runtime stage"; some of those version pins may need re-checking against upstream's actual bullseye list of `libicu67 libgdal28 libproj19` if DevDB ever needs the GIS libs, though DevDB doesn't ship PostGIS today so this is likely moot).

3. **`vanilla_v17` — NO Docker Hub artifact provides this. Must build from source.** This is the one genuine gap. Two source options:
   - **(a) Replicate neond's own recipe**: clone `postgres/postgres` at some pinned commit, `./configure --prefix=.../vanilla_v17 --without-icu --with-openssl && make && make install`. Straightforward autoconf C build, no Rust involved, minutes not hours (`make -j` on plain PostgreSQL is a well-known ~2-5 min build depending on parallelism/hardware) — cheap even inside DevDB's own multi-stage Dockerfile as an added build stage. **Open question**: which commit of stock `postgres/postgres` to pin — neond's is `80156cee06b9d257251d72379ac43f9b88bd13e1`, unclear if that's a released tag or an arbitrary tracking commit (its own `postgres --version` reported `19devel`, i.e., a pre-release/master snapshot — this is *deliberate* upstream-Neon-adjacent practice, not a neond idiosyncrasy: Neon's own `neon` submodule's `vendor/postgres-v17` is likewise a fork-ahead-of-release tree, and storage_controller's actual requirement is almost certainly "any reasonably modern real Postgres to hold its own catalog," not literally v19-anything).
   - **(b) Substitute a stable released Postgres instead of chasing `19devel`.** Since `vanilla_v17` is purely a private catalog-DB host for `storage_controller` (not part of the Neon protocol/WAL surface), DevDB is likely free to substitute **any stock Postgres ≥ some minimum version** — e.g. build (or even just use) a plain `postgres:17-bookworm`-equivalent instead of shadowing Neon's exact `19devel` snapshot. This would need verifying against `storage_controller --database-url` / migration compatibility (its own embedded diesel-style migrations presumably target standard SQL, not `19devel`-specific features) but is a strong candidate for **avoiding the from-source build entirely** by pointing at DevDB's *own already-present* `pg_install/v17` (real Neon-fork v17, from the `compute-node-v17` image, which DevDB already has to pull anyway) or a lightweight plain `postgres:17-bookworm-slim` `apt`/binary install as the storage_controller DB host. This is a design decision, not just a sourcing fact — flagging it as the main open item rather than asserting an answer.

4. **DevDB's runtime base image and libs**: Already compatible in principle — DevDB's final stage is `node:22-bookworm-slim` (bookworm matches the `neon`/v17 binaries' native base) plus a manually-curated compat-lib list for the bullseye-built v14-16 binaries (already required today, unchanged by this switch).

**Binaries NOT published as pullable artifacts** (i.e., requiring from-source build under this plan):
- `vanilla_v17`-equivalent plain Postgres — **the only hard gap**, C/autoconf, order-of-magnitude **minutes** (stock PostgreSQL full build, no extensions), *if* replicating neond's exact recipe; **zero** extra build if DevDB substitutes an already-pulled `compute-node` Postgres or a trivial `postgres:*-slim` apt package instead (recommended follow-up decision, not resolved here).

**Nothing else requires a from-source build.** All five engine binaries (`pageserver`, `safekeeper`, `storage_broker`, `storage_controller`, `compute_ctl`) and all four tenant-Postgres majors (`v14`-`v17`, forked-for-Neon builds, with contrib) are directly `COPY --from=<pullable Docker Hub image>`-able — no Rust compilation needed on DevDB's side at all, a meaningful simplification vs. what neond does internally (neond compiles the whole Rust workspace itself; DevDB going direct-to-Neon would never touch `cargo build` for the engine at all, only (optionally) a small C `./configure && make` for the vanilla-Postgres gap).

**Contrib-extension coverage caveat**: neond's `neon-contrib`/`neon-contrib-extras` Makefile targets install ~30 stock contrib modules (`pgcrypto`, `postgres_fdw`, `pg_stat_statements`, `xml2`, `uuid-ossp`, etc.) into each `v14..v17` tree *after* the base Neon build. It is not yet confirmed from this research whether `neondatabase/compute-node-v{N}`'s own Dockerfile (the much larger `compute/compute-node.Dockerfile`, 2042 lines, dozens of extension build stages) already installs an equal-or-larger superset of these into its own `/usr/local/pgsql` — visually it builds far more extensions than neond's list (PostGIS, pgrouting, plv8, h3-pg, pgvector, pg_repack, etc.), so this is very likely a superset, but a binary-presence diff (`ls contrib/` or check `pg_available_extensions`) between a neond-sourced `pg_install/v17` and a `compute-node-v17`-sourced one would be the concrete verification step before cutover — not performed in this pass (out of scope: this was a sourcing/provenance investigation, not a byte-for-byte diff).

---

## Files referenced (for follow-up)

- `~/git/neond/Dockerfile`, `~/git/neond/Makefile`, `~/git/neond/docker-compose.yaml`, `~/git/neond/.gitmodules`
- `~/git/neond/docs/{installation,storage,startup}.md`
- `~/git/neond/src/daemon/mod.rs` (lines 18-32, 41-56, 83-109 — two embedded-Postgres roles, storage_controller wiring)
- `~/git/neond/src/daemon/postgres/mod.rs` (lines 27-51 — generic `Postgres` struct, `vanilla_v17` paths hardcoded)
- `~/git/neond/src/preflight/binaries.rs`, `~/git/neond/src/mgmt/service/import.rs`, `~/git/neond/src/daemon/backup/mod.rs` (other `vanilla_v17` consumers: import/export pg_dump+pg_restore, backups' pg_basebackup)
- Upstream `neondatabase/neon` (github.com): root `Dockerfile` (fetched via `gh api repos/neondatabase/neon/contents/Dockerfile`), `compute/compute-node.Dockerfile`, `docker-compose/docker-compose.yml`, `.github/workflows/release.yml`
- Docker Hub manifests pulled for: `neondatabase/neon:latest` (amd64 config history), `neondatabase/compute-node-v14/v15/v16/v17:latest` (amd64 config history) — saved locally at `/private/tmp/claude-501/-Users-jordan-git-devdb/7f3dc4c4-3996-443e-9d25-0c77e4b4df29/scratchpad/{neon,v14,v15,v16,v17}-config.json`
- DevDB's own `docker/Dockerfile`, `docker/verify-binaries.sh`, `docker/BINARIES.md` (prior Task-2 arm64 inventory of the current neond-sourced image — includes the `vanilla_v17` → `19devel` finding this report reuses)
