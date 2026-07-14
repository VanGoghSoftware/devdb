# syntax=docker/dockerfile:1
#
# From-source multi-stage build of Neon's storage engine + PostgreSQL forks
# (initiative A / Worktree DB, Phase 1 Task 2).
#
# PORTED from ~/git/neond/Dockerfile + ~/git/neond/Makefile (the working
# from-source recipe), re-based onto the OFFICIAL neondatabase/neon tree
# @ release-9129 as the oracle (make targets: postgres.mk / Makefile).
#
# Adaptation vs. neond:
#   - ONE base for every PG major: bookworm. neond's compute-node axis
#     (DEBIAN_VERSION) collapses to a single value here, so there is no
#     per-major base variation.
#   - Rust is pinned to upstream's toolchain (1.88.0), NOT neond's drifted
#     rust:1.94.1 base.
#   - pgvector is fetched as a sha256-pinned RELEASE TARBALL and PATCHED with
#     neon's compute/patches/pgvector.patch (the NEON_SMGR unlogged-build hook),
#     matching upstream compute-node.Dockerfile — NOT neond's unpatched
#     /pgvector submodule.
#   - Extension surface = exactly what DevDB ships today (neond's
#     NEON_CONTRIB_DIRS + NEON_CONTRIB_EXTRAS + vector + neon-pg-ext), NOT
#     upstream compute-node.Dockerfile's full ~98-stage surface.
#
# All source pins live in docker/neon-build/versions.json and are duplicated
# into ARGs below (Docker cannot read JSON at build time; the worktreedb-build
# `check-manifest` subcommand guards drift between the two).
#
# Output layout (behavior-preserving cutover target, identical to the neond
# image): /usr/local/share/neon/{bin, pg_install/v14..v17, pg_install/vanilla_v17}.

##############################################################################
# Pins — keep in lockstep with docker/neon-build/versions.json
##############################################################################
ARG RUST_VERSION=1.88.0
ARG DEBIAN_VERSION=bookworm

ARG NEON_COMMIT=5340423416b46c85841904f42c93be9af145c643

# Per-major neon postgres-fork submodule commits (vendor/postgres-v{N}).
ARG PG_V14_COMMIT=c9f9fdd0113b52c0bd535afdb09d3a543aeee25f
ARG PG_V15_COMMIT=aaaeff2550d5deba58847f112af9b98fa3a58b00
ARG PG_V16_COMMIT=9b9cb4b3e33347aea8f61e606bb6569979516de5
ARG PG_V17_COMMIT=fa1788475e3146cc9c7c6a1b74f48fd296898fcd

# vanilla_v17 source: TRUE upstream Postgres (postgres/postgres @ REL_17_5), NOT
# the neon fork. storage_controller's catalog DB (storcon_db) must be plain PG —
# the neon fork emits Neon-custom WAL (rmgr id 134) that FATALs on crash recovery
# when the neon extension isn't loaded during redo (fine for a neon compute,
# fatal for a standalone catalog host after an unclean stop; Phase-1 Task-3
# integration finding). neond builds vanilla from upstream postgres for the same
# reason. REL_17_5 matches the neon-v17 minor (17.5).
# oracle: neond Makefile:21-24 (vanillapg: upstream postgres, --without-icu --with-openssl).
ARG VANILLA_PG_COMMIT=5e2f3df49d4298c6097789364a5a53be172f6e85

# pgvector: release tarball (NOT a submodule), sha256-pinned, then patched.
ARG PGVECTOR_VERSION=0.8.0
ARG PGVECTOR_SHA256=867a2c328d4928a5a9d6f052cd3bc78c7d60228a9b914ad32aa3db88e9de27b0
# v0.7.4 SQL upgrade path that neon's patched Makefile also installs.
ARG PGVECTOR_074_SQL_SHA256=10218d05dc02299562252a9484775178b14a1d8edb92a2d1672ef488530f7778

# oracle: neon compute/compute-node.Dockerfile (pg_cron-src, postgis-src,
# postgis-build) pins these sources for the matching compute release.
ARG PG_CRON_VERSION=1.6.4
ARG PG_CRON_SHA256=52d1850ee7beb85a4cb7185731ef4e5a90d1de216709d8988324b0d02e76af61
ARG SFCGAL_VERSION=1.4.1
ARG SFCGAL_SHA256=1800c8a26241588f11cddcf433049e9b9aea902e923414d2ecef33a3295626c3
ARG POSTGIS_14_16_VERSION=3.3.3
ARG POSTGIS_14_16_SHA256=74eb356e3f85f14233791013360881b6748f78081cc688ff9d6f0f673a762d13
ARG POSTGIS_17_VERSION=3.5.0
ARG POSTGIS_17_SHA256=ca698a22cc2b2b3467ac4e063b43a28413f3004ddd505bdccdd74c56a647f510

# Build parallelism. Overridable: --build-arg JOBS=$(nproc).
ARG JOBS=4

##############################################################################
# Stage 0: build-tools — one toolchain base for the whole build.
# port: neond Dockerfile:11 (FROM rust:<ver>-bookworm) — pinned to upstream's
#       1.88.0 instead of neond's drifted 1.94.1.
##############################################################################
FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS build-tools

# Fail fast on any pipeline error.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# port: neond Dockerfile:14-17 — the apt toolchain list, verbatim (git is
# already present in the rust base, but harmless to request; lsof is dev-only
# and dropped).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git autoconf automake build-essential g++ libtool ninja-build \
        libreadline-dev zlib1g-dev flex bison \
        libseccomp-dev libssl-dev clang pkg-config libpq-dev cmake \
        postgresql-client protobuf-compiler libprotobuf-dev \
        libcurl4-openssl-dev openssl libicu-dev libxml2-dev uuid-dev \
        libboost-dev libboost-filesystem-dev libboost-iostreams-dev \
        libboost-program-options-dev libboost-system-dev libboost-thread-dev \
        libboost-timer-dev libcgal-dev libgdal-dev libgeos-dev libgmp-dev \
        libjson-c-dev libmpfr-dev libopenscenegraph-dev libpcre2-dev \
        libproj-dev libprotobuf-c-dev libxslt1-dev protobuf-c-compiler xsltproc \
    && rm -rf /var/lib/apt/lists/*

# port: neond Dockerfile:18-22 — protoc v22.2 (neon's build-tools uses 25.1;
# neond pins 22.2 and it is sufficient for the storage crates). Pinned here to
# keep the recipe self-contained rather than trusting the apt protoc version.
ARG PROTOC_VERSION=22.2
RUN curl -fsSL "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-$(uname -m | sed 's/aarch64/aarch_64/g').zip" -o protoc.zip \
    && unzip -q protoc.zip -d protoc \
    && mv protoc/bin/protoc /usr/local/bin/protoc \
    && mv protoc/include/google /usr/local/include/google \
    && rm -rf protoc.zip protoc

# grounding: neondatabase/neon rust-toolchain.toml — channel = "1.88.0",
# components = ["llvm-tools", "rustfmt", "clippy"]. cargo auto-installs those
# components on first use inside the neon tree; the per-major `make -j neon-pg-ext`
# fires 4 cargo builds in parallel, so without pre-installing them the concurrent
# rustup downloads race on the shared download dir and fail non-deterministically
# ("could not rename <hash>.partial … to … : No such file or directory"). The stock
# rust base ships none of them; pre-install once here so the parallel build finds
# them already present (this is what upstream's build-tools image does).
RUN rustup component add llvm-tools rustfmt clippy

##############################################################################
# Stage 1: fetch — clone neon @ pinned commit and pin the 4 per-major
# postgres-fork submodules to their exact commits.
#
# We check out each vendor/postgres-v{N} at the versions.json-pinned commit
# explicitly (rather than trusting neon's gitlink) so the manifest is the single
# source of truth. pgvector is fetched separately in the pg-build stage (it is a
# tarball, not a submodule).
##############################################################################
FROM build-tools AS fetch
ARG NEON_COMMIT
ARG PG_V14_COMMIT
ARG PG_V15_COMMIT
ARG PG_V16_COMMIT
ARG PG_V17_COMMIT

WORKDIR /src
# Shallow-fetch exactly the pinned neon commit.
RUN git init -q neon \
    && cd neon \
    && git remote add origin https://github.com/neondatabase/neon.git \
    && git fetch -q --depth 1 origin "${NEON_COMMIT}" \
    && git checkout -q FETCH_HEAD

WORKDIR /src/neon
# Initialise the 4 per-major postgres-fork submodules, then hard-pin each to its
# versions.json commit. `submodule update --init` wires them from neon's gitlink
# (which, at release-9129, already matches these commits); the explicit fetch +
# checkout makes the pin authoritative and independent of the gitlink.
# oracle: neon postgres.mk:83-86 (the submodule-present check the build enforces)
RUN git submodule update --init --depth 2 \
        vendor/postgres-v14 vendor/postgres-v15 \
        vendor/postgres-v16 vendor/postgres-v17 \
    && for pair in "v14:${PG_V14_COMMIT}" "v15:${PG_V15_COMMIT}" \
                   "v16:${PG_V16_COMMIT}" "v17:${PG_V17_COMMIT}"; do \
        ver="${pair%%:*}"; sha="${pair##*:}"; \
        echo "==> pinning vendor/postgres-${ver} @ ${sha}"; \
        ( cd "vendor/postgres-${ver}" \
          && git fetch -q --depth 1 origin "${sha}" \
          && git checkout -q "${sha}" ); \
    done

##############################################################################
# Stage 2v: vanilla — a TRUE upstream Postgres 17 for pg_install/vanilla_v17.
# (Rationale + oracle: see the VANILLA_PG_COMMIT ARG above.) storcon_db — the
# storage_controller's metadata catalog — must run on plain upstream PG; the neon
# fork's custom WAL rmgr (id 134) breaks its crash recovery after an unclean stop.
# A separate shallow clone of postgres/postgres at the pinned REL_17_5 commit,
# built on the SAME bookworm build-tools base as everything else (one base).
# oracle: neond Makefile:21-24 (vanillapg: ./configure --without-icu --with-openssl
#         then make install — core only, no contrib/extensions).
##############################################################################
FROM build-tools AS vanilla
ARG JOBS
ARG VANILLA_PG_COMMIT
WORKDIR /src/vanilla-postgres
RUN git init -q \
    && git remote add origin https://github.com/postgres/postgres.git \
    && git fetch -q --depth 1 origin "${VANILLA_PG_COMMIT}" \
    && git checkout -q FETCH_HEAD
# Minimal catalog-host config — core PG only (no contrib, no neon ext), matching
# neond's vanillapg. `make install` builds then installs the core tree.
RUN ./configure --prefix=/usr/local/vanilla_v17 --without-icu --with-openssl \
    && make MAKELEVEL=0 -j"${JOBS}" install

##############################################################################
# Stage 2: engine — build the Rust storage binaries + neon PG extensions +
# all four PostgreSQL majors (with the DevDB contrib set) + pgvector.
#
# This is a single heavy stage: PG installs, neon-pg-ext, and the Rust build all
# share the one neon checkout and its pg_install/ tree, exactly as neond's
# `make build` does in one working directory.
##############################################################################
FROM fetch AS engine
ARG JOBS
ARG PGVECTOR_VERSION
ARG PGVECTOR_SHA256
ARG PGVECTOR_074_SQL_SHA256
ARG PG_CRON_VERSION
ARG PG_CRON_SHA256
ARG SFCGAL_VERSION
ARG SFCGAL_SHA256
ARG POSTGIS_14_16_VERSION
ARG POSTGIS_14_16_SHA256
ARG POSTGIS_17_VERSION
ARG POSTGIS_17_SHA256

ENV BUILD_TYPE=release
WORKDIR /src/neon

# ---------------------------------------------------------------------------
# 2a. PostgreSQL majors — configure + install per major.
# oracle: neon postgres.mk:35 (postgres-install-%) / :108-118 (compile+install
#         with the 7 baked contribs: pg_prewarm pg_buffercache pg_visibility
#         pageinspect pg_trgm amcheck test_decoding).
# `make postgres` == postgres-install-{v14,v15,v16,v17} (postgres.mk:60-63).
# ICU: we install libicu-dev, so PG configures with dynamic system ICU (matches
# the neond image, which links libicu72 at runtime). We do NOT use upstream's
# static-ICU path (that is gated on build-tools' /home/nonroot/.docker_build
# marker, which we deliberately do not create).
# ---------------------------------------------------------------------------
RUN BUILD_TYPE=release make -j"${JOBS}" -s postgres

# ---------------------------------------------------------------------------
# 2b. DevDB contrib set. Upstream postgres.mk installs only 7 contribs (done in
#     2a); the rest of DevDB's shipped surface comes from neond's Makefile
#     NEON_CONTRIB_DIRS. Ported verbatim (path-adjusted to neon's own
#     build/pg_install layout — neond nested neon as a subdir, we are at root).
# port: neond Makefile:12-17 (NEON_CONTRIB_DIRS), :26-36 (neon-contrib loop).
# Each contrib is guarded by [ -d ]: e.g. pg_logicalinspect exists in no
# supported major and is silently skipped, matching neond (its .control is
# absent from the shipped image — verified against the running container).
# NB: intagg's contrib dir installs the _int/intarray shim; spi installs
# autoinc/insert_username/moddatetime/refint/tcn — matching the running image's
# .so inventory (autoinc.so, insert_username.so, moddatetime.so, refint.so).
# ---------------------------------------------------------------------------
RUN set -e; \
    NEON_CONTRIB_DIRS="bloom btree_gin btree_gist citext cube dblink \
        dict_int dict_xsyn earthdistance file_fdw fuzzystrmatch hstore \
        intagg intarray isn lo ltree pg_freespacemap pg_logicalinspect \
        pg_stat_statements pg_surgery pg_walinspect pgcrypto pgrowlocks \
        pgstattuple postgres_fdw seg sslinfo spi tablefunc tcn \
        tsm_system_rows tsm_system_time unaccent"; \
    for ver in v14 v15 v16 v17; do \
      for ext in $NEON_CONTRIB_DIRS; do \
        dir="build/$ver/contrib/$ext"; \
        if [ -d "$dir" ]; then \
          echo "==> installing $ext for $ver"; \
          make MAKELEVEL=0 -C "$dir" -j"${JOBS}" install; \
        fi; \
      done; \
    done

# ---------------------------------------------------------------------------
# 2c. Contrib EXTRAS that need extra configure flags: xml2 (--with-libxml) and
#     uuid-ossp (--with-uuid=e2fs). We install libxml2-dev + uuid-dev in the
#     toolchain, so we reconfigure each major's build tree with the two flags
#     and reinstall, then build the two extras.
# port: neond Makefile:19 (NEON_CONTRIB_EXTRAS), :38-55 (neon-contrib-extras).
# NOTE: neond's reconfigure runs `config.status --config` to re-run configure
# with the ORIGINAL flags + the two extras, then `clean` + rebuild + install.
# This is done BEFORE neon-pg-ext / cargo so the PG installs are final before
# anything links against them (no rebuild-after-reconfigure needed downstream).
# ---------------------------------------------------------------------------
RUN set -e; \
    NEON_CONTRIB_EXTRAS="xml2 uuid-ossp"; \
    for ver in v14 v15 v16 v17; do \
      build="build/$ver"; \
      [ -d "$build" ] || continue; \
      echo "==> reconfiguring $ver with --with-libxml --with-uuid=e2fs"; \
      ( cd "$build" \
        && eval "../../vendor/postgres-$ver/configure $(./config.status --config) --with-libxml --with-uuid=e2fs" > reconfigure.log ); \
      make MAKELEVEL=0 -C "$build" clean; \
      make MAKELEVEL=0 -C "$build" -j"${JOBS}" install; \
      for ext in $NEON_CONTRIB_EXTRAS; do \
        dir="$build/contrib/$ext"; \
        if [ -d "$dir" ]; then \
          echo "==> installing $ext for $ver"; \
          make MAKELEVEL=0 -C "$dir" -j"${JOBS}" install; \
        fi; \
      done; \
    done

# ---------------------------------------------------------------------------
# 2d. neon-specific PG extensions (neon.so, neon_rmgr, neon_walredo,
#     neon_utils, neon_test_utils) for every major, plus walproposer-lib.
#     Built ONCE here, AFTER the PG installs are final (2a+2b+2c), so every
#     neon.so links against the finished xml/uuid-enabled PG.
# oracle: neon Makefile:168-169 (neon-pg-ext == neon-pg-ext-v{14..17}),
#         :124-133 (per-major ext build), :144-165 (walproposer-lib).
# ---------------------------------------------------------------------------
RUN BUILD_TYPE=release make -j"${JOBS}" -s neon-pg-ext

# ---------------------------------------------------------------------------
# 2e. Rust storage binaries. compute_ctl is built ONCE here and reused for all
#     majors (it is version-agnostic). `make neon` would re-drive
#     walproposer-lib + headers; those are already satisfied by 2d, so we invoke
#     cargo directly and name only the 5 bins DevDB ships (skips proxy/tests/etc).
# port: neond Dockerfile:29 (make -C neon) + :45-49 (cargo build --release).
# oracle: neon Makefile:113-116 (neon target -> cargo build --release).
# --locked: honour the committed Cargo.lock (supply-chain: no silent bumps).
# ---------------------------------------------------------------------------
RUN CARGO_TERM_PROGRESS_WHEN=never CI=1 \
    cargo build --release --locked \
        --bin pageserver \
        --bin safekeeper \
        --bin storage_broker \
        --bin storage_controller \
        --bin compute_ctl

# ---------------------------------------------------------------------------
# 2f. pgvector — fetch the sha256-pinned tarball, add the v0.7.4 SQL upgrade
#     path, apply neon's NEON_SMGR patch, build once per major via PGXS.
# oracle: neon compute/compute-node.Dockerfile:526-538 (pgvector-src fetch +
#         patch, pgvector-build make/install). Patch source: neon's own tree
#         (compute/patches/pgvector.patch), available from the clone.
# Upstream builds one major per compute-node image (a single make/install, no
# re-clean). We assemble all four majors in one stage, so we loop and `make
# clean` between majors (each needs a fresh build against its own PG headers).
# That clean removes the downloaded sql/vector--0.7.4.sql (pgvector's
# 0.7.4->0.8.0 upgrade base) — which, unlike vector--0.8.0.sql (regenerated from
# sql/vector.sql by a make rule), has NO rule to recreate it. So we stash it once
# and restore it after each clean, before that major's install.
# We mark pgvector trusted (neon compute-node.Dockerfile:538) so a non-superuser
# can CREATE EXTENSION vector. neon hardcodes its own prefix
# (/usr/local/pgsql/share/extension); our pg_install prefix differs, so we derive
# the control-file dir from `pg_config --sharedir` — the exact sharedir PGXS
# installed vector.control into.
# `OPTFLAGS=""` strips pgvector's default -march=native (we build on a different
# machine than we run) — compute-node.Dockerfile:520-522.
# ---------------------------------------------------------------------------
RUN set -e; \
    mkdir -p /tmp/pgvector-src; \
    curl -fsSL "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" -o /tmp/pgvector.tar.gz; \
    echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum --check; \
    tar xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector-src; \
    curl -fsSL "https://github.com/pgvector/pgvector/raw/refs/tags/v0.7.4/sql/vector.sql" -o /tmp/pgvector-src/sql/vector--0.7.4.sql; \
    echo "${PGVECTOR_074_SQL_SHA256}  /tmp/pgvector-src/sql/vector--0.7.4.sql" | sha256sum --check; \
    ( cd /tmp/pgvector-src && patch -p1 < /src/neon/compute/patches/pgvector.patch ); \
    cp /tmp/pgvector-src/sql/vector--0.7.4.sql /tmp/vector--0.7.4.sql.keep; \
    for ver in v14 v15 v16 v17; do \
      pg_config="/src/neon/pg_install/$ver/bin/pg_config"; \
      [ -x "$pg_config" ] || { echo "MISSING $pg_config"; exit 1; }; \
      echo "==> building pgvector for $ver"; \
      make MAKELEVEL=0 -C /tmp/pgvector-src USE_PGXS=1 PG_CONFIG="$pg_config" OPTFLAGS="" clean; \
      cp /tmp/vector--0.7.4.sql.keep /tmp/pgvector-src/sql/vector--0.7.4.sql; \
      make MAKELEVEL=0 -C /tmp/pgvector-src USE_PGXS=1 PG_CONFIG="$pg_config" OPTFLAGS="" -j"${JOBS}" install; \
      sharedir="$("$pg_config" --sharedir)"; \
      echo 'trusted = true' >> "$sharedir/extension/vector.control"; \
    done; \
    rm -rf /tmp/pgvector.tar.gz /tmp/pgvector-src /tmp/vector--0.7.4.sql.keep

# ---------------------------------------------------------------------------
# 2g. Promised extension surface — pg_cron + PostGIS for every compute major.
# pgvector was installed in 2f. This script downloads only the manifest-pinned
# sources, builds SFCGAL once, then uses each bundled installation's exact
# pg_config so the carrier and baked-engine artifacts have identical ABI.
# oracle: neon compute/compute-node.Dockerfile (pg_cron-build, postgis-build,
# extensions-minimal).
# ---------------------------------------------------------------------------
COPY docker/neon-build/build-promised-extensions.sh /usr/local/bin/build-promised-extensions
RUN chmod +x /usr/local/bin/build-promised-extensions \
    && PG_CRON_VERSION="$PG_CRON_VERSION" PG_CRON_SHA256="$PG_CRON_SHA256" \
       SFCGAL_VERSION="$SFCGAL_VERSION" SFCGAL_SHA256="$SFCGAL_SHA256" \
       POSTGIS_14_16_VERSION="$POSTGIS_14_16_VERSION" POSTGIS_14_16_SHA256="$POSTGIS_14_16_SHA256" \
       POSTGIS_17_VERSION="$POSTGIS_17_VERSION" POSTGIS_17_SHA256="$POSTGIS_17_SHA256" \
       EXTENSION_JOBS=2 /usr/local/bin/build-promised-extensions /src/neon/pg_install

# ---------------------------------------------------------------------------
# 2h. Assemble the exact /usr/local/share/neon layout inside this stage so the
#     final stage is a single clean COPY.
#   - bin/         : the 5 storage binaries.
#   - pg_install/v14..v17 : the per-major installs (with contrib + neon ext +
#                    pgvector).
#   - pg_install/vanilla_v17 : NOT assembled here — it is a TRUE upstream Postgres
#     17 built in the `vanilla` stage (postgres/postgres @ REL_17_5) and COPY'd
#     into the tree by the final stage, deliberately NOT the neon-forked v17.
#     storcon_db (the storage_controller's metadata catalog) must be plain PG: the
#     fork emits Neon-custom WAL (rmgr id 134) that FATALs storcon_db's crash
#     recovery after an unclean stop when the neon extension isn't loaded during
#     redo (Phase-1 Task-3 integration finding). This matches neond, which
#     likewise builds a SEPARATE upstream-vanilla tree for storcon's catalog host.
#     See the VANILLA_PG_COMMIT ARG + the `vanilla` stage.
# port: neond Dockerfile:67-73 (the COPY-into-share layout) + Makefile:21-24
#       (the separate upstream-vanilla build for storcon's catalog host).
# ---------------------------------------------------------------------------
RUN set -e; \
    mkdir -p /out/bin /out/pg_install; \
    for b in pageserver safekeeper storage_broker storage_controller compute_ctl; do \
      cp "target/release/$b" "/out/bin/$b"; \
    done; \
    cp -a pg_install/v14 pg_install/v15 pg_install/v16 pg_install/v17 /out/pg_install/

##############################################################################
# Compute carriers — one artifact-only image per PG major (Phase-2 Task 5).
#
# Each is a `FROM scratch` image whose ONLY content is that major's pg_install
# tree laid down under /usr/local. They are NEVER run — only pulled: the runtime
# dynamic-minor pull (packages/daemon/src/compute/builds/oci.ts) fetches ONE
# major's image and extracts exactly the `usr/local/` prefix, then consumes
# `bin/postgres` at the extracted tree's root (provisioner.ts detectVersion +
# validate.ts both `join(dir, "bin", "postgres")`). This is the same contract as
# neondatabase/compute-node-v{N}, whose /usr/local ships bin/ lib/ share/ direct.
#
# COPY semantics: `COPY <srcDir> /usr/local` copies the CONTENTS of pg_install/vN
# (its bin/ lib/ share/) INTO /usr/local — not a nested /usr/local/vN — so the
# binary lands at /usr/local/bin/postgres, exactly where oci.ts's
# pullPrefix("usr/local/") assembles it.
#
# Placed AFTER `engine` and BEFORE `final` so `final` stays the Dockerfile's
# DEFAULT (last) target: the local `worktreedb-build build` driver and
# docker/Dockerfile keep building the engine runtime image with no --target,
# and these cheap COPY-only stages are pruned from that graph (final does not
# depend on them). CI selects each carrier with `--target compute-v{N}`; they
# reuse the already-built `engine` stage from cache.
##############################################################################
FROM scratch AS compute-v14
COPY --from=engine /out/pg_install/v14 /usr/local

FROM scratch AS compute-v15
COPY --from=engine /out/pg_install/v15 /usr/local

FROM scratch AS compute-v16
COPY --from=engine /out/pg_install/v16 /usr/local

FROM scratch AS compute-v17
COPY --from=engine /out/pg_install/v17 /usr/local

##############################################################################
# Stage 3: final — slim runtime carrying only the assembled engine tree + the
# verify script.
#
# Base = node:22-bookworm-slim to MATCH the outer DevDB image's base
# (docker/Dockerfile FROM node:22-bookworm-slim). This keeps the engine image's
# runtime-lib + node surface identical to what the outer image already provides,
# so verify-binaries.sh (which probes `node --version`) passes unmodified. The
# outer DevDB image consumes this tree via COPY --from, exactly as it currently
# COPYs from the neond image.
# port: neond Dockerfile:63-76 (debian-slim runtime + apt runtime libs) —
#       re-based onto node:22-bookworm-slim for parity with docker/Dockerfile.
##############################################################################
FROM node:22-bookworm-slim AS final
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Runtime shared libs the neon binaries + postgres need.
# port: neond Dockerfile:65 (runtime apt set). Matches docker/Dockerfile:7-10.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl libssl3 libpq5 libreadline8 libseccomp2 \
        libcurl4 libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1 \
        libgdal32 libgeos-c1v5 libproj25 libprotobuf-c1 libsfcgal1 libxslt1.1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=engine /out /usr/local/share/neon
# vanilla_v17 = a TRUE upstream Postgres 17 (the `vanilla` stage), NOT the neon
# fork — so storcon_db crash-recovers without the neon WAL rmgr (Phase-1 Task-3).
COPY --from=vanilla /usr/local/vanilla_v17 /usr/local/share/neon/pg_install/vanilla_v17
ENV NEON_BINARIES_DIR=/usr/local/share/neon/bin \
    PG_INSTALL_DIR=/usr/local/share/neon/pg_install

# Acceptance gate: the same verify script the outer image runs.
COPY docker/verify-binaries.sh /usr/local/bin/verify-binaries.sh
COPY docker/verify-promised-extensions.sh /usr/local/bin/verify-promised-extensions
RUN chmod +x /usr/local/bin/verify-binaries.sh /usr/local/bin/verify-promised-extensions

# Default command runs the verifier so `docker run <image>` self-checks.
CMD ["bash", "/usr/local/bin/verify-binaries.sh"]
