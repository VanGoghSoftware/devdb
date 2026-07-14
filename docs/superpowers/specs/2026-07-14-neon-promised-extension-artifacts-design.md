# Neon Promised Extension Artifacts Design

**Date:** 2026-07-14
**Status:** Approved
**Repositories:** `devdb` (artifact producer), `worktreedb` (artifact consumer)

## Goal

Make `pg_cron`, `vector`, and `postgis` part of the PostgreSQL artifact
contract at its source. Both the baked Neon engine image and every downloadable
PostgreSQL 14–17 carrier image must contain the complete promised extension
surface before publication. Worktree DB will then consume the published engine
image directly instead of rebuilding missing extensions in its product image.

The release includes a real native amd64/arm64 GHCR publish. Worktree DB is
repinned only after the published manifests and their contents have passed the
release gates.

## Ownership Boundary

The approved Go-rewrite architecture remains unchanged:

- `devdb` owns the Neon source build, source manifest, native multi-architecture
  workflow, engine image, and per-major compute carriers;
- `worktreedb` owns product orchestration, runtime configuration, dynamic-build
  activation, and end-to-end product tests;
- the cross-repository binary contract is an OCI manifest digest plus the
  validated `/usr/local/share/neon` and `/usr/local` filesystem layouts.

Moving the producer into Worktree DB is outside this change. Compiling an
extension after a carrier is downloaded is also rejected: it would require a
compiler and networked source build in the product runtime, make activation
slow, and turn one immutable carrier into a locally reconstructed artifact.

## Promised Version Matrix

The versions follow the official Neon compute image at the pinned engine
release:

| SQL extension | PostgreSQL 14 | PostgreSQL 15 | PostgreSQL 16 | PostgreSQL 17 |
|---|---:|---:|---:|---:|
| `pg_cron` | 1.6 | 1.6 | 1.6 | 1.6 |
| `vector` | 0.8.0 | 0.8.0 | 0.8.0 | 0.8.0 |
| `postgis` | 3.3.3 | 3.3.3 | 3.3.3 | 3.5.0 |

`pg_cron` release 1.6.4 installs SQL extension version 1.6. pgvector 0.8.0
already builds in the producer. PostGIS uses SFCGAL 1.4.1, matching the pinned
Neon recipe.

All extension source URLs, release identifiers, commits where applicable, and
SHA-256 checksums become first-class fields in
`docker/neon-build/versions.json`. `worktreedb-build check-manifest` validates
their presence and checksum shape. The Dockerfile duplicates the build ARGs,
as it already does for Neon and pgvector, and the static gate prevents drift.

## Producer Build

The existing `docker/neon-build/Dockerfile` remains the one source build for all
artifacts. After PostgreSQL, Neon extensions, and pgvector are installed, it
will:

1. download and checksum pg_cron 1.6.4, SFCGAL 1.4.1, PostGIS 3.3.3, and
   PostGIS 3.5.0;
2. build SFCGAL once on the Bookworm toolchain;
3. build pg_cron separately against each `pg_install/v14..v17/bin/pg_config`;
4. build PostGIS 3.3.3 against PostgreSQL 14–16 and PostGIS 3.5.0 against
   PostgreSQL 17;
5. mark the promised extension control files trusted, matching Neon's compute
   image behavior for the non-superuser compute role;
6. assemble the completed per-major trees into `/out/pg_install`.

The commands and dependency choices derived from Neon carry use-site comments
in the required `oracle: neon <path-or-endpoint>` form. Source archives remain
network inputs only during the controlled image build; no source or compiler is
shipped in a carrier.

Because both artifact families copy from `/out`, this one producer change puts
the extensions in:

- `worktreedb-neon-engine`, under
  `/usr/local/share/neon/pg_install/v14..v17`;
- `worktreedb-compute-v14..v17`, with each selected major rooted directly at
  `/usr/local` for the dynamic OCI extractor.

The true-upstream `vanilla_v17` catalog host remains unchanged and does not
receive compute extensions.

## Runtime Libraries and Licensing

The engine image's Bookworm runtime stage gains the native libraries required
by PostGIS and SFCGAL. The legacy devdb product image and Worktree DB final
image retain the same runtime package surface so `ldd` evaluates the filesystem
that will actually execute PostgreSQL.

The source inventory and binary documentation record the versions, checksums,
upstream locations, and licenses for pg_cron, pgvector, PostGIS, and SFCGAL.
No unrelated extension becomes supported merely because PostGIS installs
adjacent helper files.

Carrier images remain artifact-only `FROM scratch` images. They intentionally
contain the PostgreSQL tree but not an operating-system root; the Worktree DB
runtime supplies the Bookworm shared libraries when it activates an extracted
carrier.

## Verification Contract

The producer's native verification gate will fail unless every PostgreSQL
14–17 tree contains:

- `pg_cron`, `vector`, and `postgis` control files;
- at least one SQL installation script for each extension;
- `pg_cron.so`, `vector.so`, and `postgis-3.so`;
- only loadable extension libraries whose dynamic dependencies resolve in the
  engine runtime image;
- the expected default extension versions.

The check runs natively in both workflow architecture legs before any digest
is admitted to a multi-architecture tag. Manifest creation remains dependent
on both legs succeeding.

Worktree DB retains the stronger behavioral tier:

- its final-image tripwire repeats artifact and linkage validation after the
  product runtime packages are installed;
- the PG14–17 real-container matrix creates all three extensions and probes
  vector distance, PostGIS geometry, and a live pg_cron schedule;
- the PostgreSQL 16 import regression restores a dump containing all three;
- the dynamic-build live gate creates and functionally probes all three before
  activating any downloaded candidate.

This split gives the producer fast structural/linkage rejection and the
consumer real Neon-compute behavior without bootstrapping the whole product in
each producer architecture leg.

## Publish and Digest Recording

The existing native amd64 and arm64 GitHub Actions jobs build and push by
digest. The merge job publishes one manifest list for the engine and one for
each carrier, preserving the existing release/minor and `latest` tag contract.
Tags are discovery pointers; consumers and release records use the immutable
resolved digest.

Release sequence:

1. land and verify the producer changes on an isolated `devdb` branch;
2. push that branch and dispatch `build-neon-engine.yml` for its exact ref;
3. wait for both native builds and manifest merge;
4. inspect every manifest for amd64 and arm64 and capture its digest;
5. update `versions.json`, `docker/BINARIES.md`, and devdb's legacy product
   Dockerfile with the published digest set;
6. rerun the manifest and unit gates;
7. repin Worktree DB's engine `FROM` to the new engine manifest digest;
8. build and run Worktree DB's extension acceptance tests against that digest.

A failed architecture build, verifier, manifest merge, or consumer test stops
the cutover. Existing digest-pinned installations remain on their previous
artifact.

## Worktree DB Cutover

After publication, Worktree DB removes only the duplicate compilation layer:

- delete the source-build script for pg_cron/PostGIS;
- remove the `promised-extensions` compiler stage and copy the engine tree
  directly from the newly pinned producer image;
- retain the extension verification script and execute it in the final product
  filesystem;
- retain the PostGIS/SFCGAL runtime packages, compute preload settings,
  dynamic-build gate, integration tests, and user documentation;
- update architecture documentation to identify `devdb` as the artifact
  producer rather than claiming the outer Worktree DB Dockerfile compiles the
  extensions.

Per user direction, Worktree DB changes stay on its current checkout/branch;
no additional Worktree DB feature branch or worktree is created. The `devdb`
producer work remains isolated because its main checkout contains unrelated
uncommitted changes.

## Dynamic Download Behavior

The activation contract is based on capabilities, not on a Neon allowlist.
Worktree DB can attempt to download an official Neon carrier or a project-owned
GHCR carrier. It activates the candidate only if the real live gate proves the
three promised extensions and existing Neon storage behavior.

The project-owned `worktreedb-compute-v14..v17` images are the guaranteed
extension-complete carriers. Private GHCR access continues to use the existing
registry base, image template, and token configuration. Official Neon images
remain usable when they independently satisfy the same gate. A newer image
missing pg_cron, vector, PostGIS, or a required runtime ABI is rejected without
changing the active high-water build.

## Failure and Rollback

- A source or checksum mismatch fails the producer build.
- A compilation failure for one major fails that architecture leg.
- A missing artifact, unexpected version, or unresolved library fails native
  verification before manifest publication.
- A partial multi-architecture release is never tagged by the merge job.
- Worktree DB is never repinned before the published digest is inspected.
- A bad dynamic carrier never becomes active; the previous active build stays
  selected.
- A bad baked engine cutover is reverted by restoring the previous immutable
  engine digest; no database catalog migration is performed automatically.

Database extension creation and upgrade remain explicit SQL. Neither producer
nor consumer silently runs `CREATE EXTENSION` or `ALTER EXTENSION UPDATE` in a
user database.

