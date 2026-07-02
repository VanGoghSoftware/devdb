# Engine binaries: pinned source + inventory

Records the exact base image DevDB's engine binaries are pulled from, and what
that image actually contains — established by Task 2, consumed by Task 3
(`PgVersionSchema`) and Task 6 (storage-controller DB host fallback).

## Pinned digest

```
neond/neond@sha256:e94082a476cb348daa59c960e2ce6f279cd7f745ab34ebee5562ae5bf97dafd7
```

Obtained via (2026-07-02):

```bash
docker pull neond/neond:latest
docker image inspect neond/neond:latest --format '{{index .RepoDigests 0}}'
# -> neond/neond@sha256:e94082a476cb348daa59c960e2ce6f279cd7f745ab34ebee5562ae5bf97dafd7
```

Pulled image platform: `linux/arm64`. `docker/Dockerfile`'s `FROM` line pins
this exact digest (not `:latest`) so the engine binary set in the image is
reproducible.

## Verification: fails without the binaries (control)

Before writing the Dockerfile, `docker/verify-binaries.sh` was run against a
plain `node:22-bookworm-slim` image to confirm it actually detects a missing
engine:

```bash
$ docker run --rm -v $PWD/docker/verify-binaries.sh:/v.sh node:22-bookworm-slim bash /v.sh
MISSING pageserver
$ echo $?
1
```

## Verification: passes against the built image

```bash
$ docker build -f docker/Dockerfile -t devdb:dev .
# ... (apt-get runtime libs, COPY --from=neon-binaries, pnpm install --frozen-lockfile, pnpm -r build) ...
# => writing image sha256:a210493c7a03d4d452532a4254878f98a1bff16f1f1ae570e34c6e8ed514af5d
# => naming to docker.io/library/devdb:dev

$ docker run --rm devdb:dev bash /usr/local/bin/verify-binaries.sh
Neon page server git:unknown failpoints: true, features: []
--- pg_install inventory ---
v14
v15
v16
v17
vanilla_v17
v14: postgres (PostgreSQL) 14.18 ()
v15: postgres (PostgreSQL) 15.13 ()
v16: postgres (PostgreSQL) 16.9 ()
v17: postgres (PostgreSQL) 17.5 ()
vanilla_v17: postgres (PostgreSQL) 19devel
vanilla_v17: OK (storcon DB host)
v22.23.1
ALL BINARIES OK
```

Exit code `0`.

## Full pg_install inventory

`/usr/local/share/neon/pg_install/` contains exactly:

| dir           | `bin/postgres`? | `postgres --version`         | Notes |
|---------------|:---:|-------------------------------|-------|
| `v14`         | yes | PostgreSQL 14.18              | supported |
| `v15`         | yes | PostgreSQL 15.13              | supported |
| `v16`         | yes | PostgreSQL 16.9               | supported |
| `v17`         | yes | PostgreSQL 17.5               | supported |
| `vanilla_v17` | yes | PostgreSQL 19devel            | not a tenant PG version — see below |

No other directories are present (checked with `ls` inside the built image;
matches the raw `neond/neond` image at the pinned digest).

### `vanilla_v17`

Present. `bin/initdb` is executable, so the verify script's dedicated check
passes: `vanilla_v17: OK (storcon DB host)`. This directory is Neon's own
build used to host the storage controller's metadata database — its
`postgres --version` reports `19devel` (a bleeding-edge/master build Neon
uses internally), which is unrelated to `SUPPORTED_PG_VERSIONS` below and is
**not** counted as a tenant-selectable Postgres version. Task 6 can rely on
`vanilla_v17` being available; its documented fallback is not needed here.

### Engine binaries (`/usr/local/share/neon/bin/`)

All five present and executable:

| binary | check |
|---|---|
| `pageserver` | `test -x` + `--version` -> `Neon page server git:unknown failpoints: true, features: []` |
| `safekeeper` | `test -x` + `--version` -> `Neon safekeeper git:unknown failpoints: true, features: []` |
| `storage_broker` | `test -x` + `--version` -> `storage_broker git:unknown` |
| `storage_controller` | `test -x` (starts, logs `not initializing Sentry, no SENTRY_DSN given` on `--version`, then exits non-zero — clap doesn't treat `--version` as a no-op flag for this binary; not exercised further by Task 2) |
| `compute_ctl` | `test -x` (no `--version` flag; confirmed functional via `--help`, which prints its clap usage banner and exits 0) |

`verify-binaries.sh` only requires `test -x` for the last three and only
calls `--version` on `pageserver`, so none of the above CLI quirks affect the
"ALL BINARIES OK" result.

## `SUPPORTED_PG_VERSIONS`

Derived per the Task 2 rule: every `v<N>` directory (N >= 14, excluding the
`vanilla_v17` special case) that has an executable `bin/postgres`.

```
SUPPORTED_PG_VERSIONS = [14, 15, 16, 17]
```

**`v18` is absent from this image.** Per plan risk #1, PG 18 support is
deferred to Phase 5 — do not add it here. Task 3's `PgVersionSchema` should
enumerate exactly `[14, 15, 16, 17]` and default to the highest (`17`).

## Runtime interface (for Task 3+)

Set by `docker/Dockerfile`:

```
NEON_BINARIES_DIR=/usr/local/share/neon/bin
PG_INSTALL_DIR=/usr/local/share/neon/pg_install
DEVDB_DATA_DIR=/data
DEVDB_HTTP_PORT=4400
DEVDB_PORT_RANGE=54300-54339
```

Image runs as user `node` under Node `v22.23.1` (confirmed via `node
--version` inside the built image; satisfies workspace `engines.node >=22`
from Task 1). Workspace install uses `pnpm install --frozen-lockfile`
followed by `pnpm -r build` (both packages/shared and packages/daemon build
via `tsc` with no errors); the lockfile's supply-chain policy check
(`minimumReleaseAge: 1440`) passes inside the image build (`Lockfile passes
supply-chain policies (229 entries)`).

## Platform caveat

This inventory was verified on linux/arm64 (Docker Desktop, macOS host). The pinned
digest is a multi-arch index; a build on another platform selects that platform's
manifest, so re-run `verify-binaries.sh` there and re-record the inventory before
trusting SUPPORTED_PG_VERSIONS on that platform. (Review-broker finding, 2026-07-02.)
