# DevDB Phase 1: Engine Container & Core Branching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Docker container running Neon's storage engine, orchestrated by a TypeScript daemon, that can create Postgres projects, branch them instantly, serve per-branch endpoints, and time-travel (restore/reset) — all over a REST API, proven by container-level integration tests.

**Architecture:** Node 22 daemon (Fastify) is PID 1 in a Debian container. It supervises the Neon engine binaries copied from the pinned `neond/neond` image (storage_broker, storage_controller + its embedded vanilla Postgres, pageserver, safekeeper) and launches one `compute_ctl`-managed Postgres per running branch endpoint. Control-plane state lives in SQLite. Every engine interaction ports a specific, cited neond call site.

**Tech Stack:** TypeScript (strict), Node 22, pnpm workspaces, Fastify 5, zod, drizzle-orm + better-sqlite3, vitest, testcontainers, `pg` (client for tests/SQL console), execa.

## Phase roadmap (spec → plans)

Spec: `docs/superpowers/specs/2026-07-02-devdb-design.md`. This is **plan 1 of 5**. Later plans, each written after the previous phase lands: **Phase 2** MCP server + agent skills; **Phase 3** Web UI (React + Mantine); **Phase 4** import/export + S3/Azure durability + disaster recovery; **Phase 5** extensions (pg_cron, PostGIS), PG 18 enablement if missing from binaries, packaging polish.

## Global constraints

- Node `>=22`, TypeScript `strict: true`, ESM everywhere (`"type": "module"`).
- Package manager: pnpm **11.9.0** via corepack. Supply-chain policy (user amendment A4): npm dependencies must be **≥24h old** at resolution time — `minimumReleaseAge: 1440` in pnpm-workspace.yaml; native build scripts allowlisted for better-sqlite3 only (`allowBuilds`). Monorepo layout per spec: `packages/daemon`, `packages/shared`, `docker/`, `tests/integration/`.
- Management HTTP port **4400**; endpoint port range default **54300-54339**; engine-internal ports exactly as neond: broker `50051`, storcon `1234`, storcon-DB `5431`, pageserver http `9898` / pg `64000`, safekeeper pg `5454` / http `7676`, all bound to `127.0.0.1` inside the container.
- Default branch name: **`main`**. IDs: Neon tenant id = project id (32-char hex, no dashes); timeline id = 32-char hex.
- Deviations from neond (approved in spec): SQLite instead of management Postgres; **no PgBouncer**; **no TLS** on computes; no orgs/users/auth on our API; **engine runs in trust mode** (no NeonJWT — all engine ports are loopback-only inside the container; see Task 7 note; fallback documented there).
- Engine binaries land at `/usr/local/share/neon/bin`, Postgres installs at `/usr/local/share/neon/pg_install` (same paths as neond image).
- Commit after every task (at minimum); conventional-commit style messages.
- **Oracle rule:** every engine call/config cites its neond source (`// oracle: src/mgmt/service/branch.rs:141` style comments). Do not invent payloads — port them.

## Oracle reference map

| Ours | Ports from neond |
|---|---|
| `packages/daemon/src/engine/configs.ts` | `src/daemon/pageserver/mod.rs` (pageserver.toml/identity/metadata), `src/daemon/mod.rs:67-165` (broker/storcon/safekeeper args) |
| `packages/daemon/src/engine/process.ts` | `src/daemon/process.rs` (spawn + readiness needle + stop) |
| `packages/daemon/src/engine/embedded-postgres.ts` | `src/daemon/postgres/mod.rs` (initdb/postgres args, env) |
| `packages/daemon/src/engine/boot.ts` | `src/daemon/mod.rs:182-244` (start/stop order), `src/daemon/lease/mod.rs` (lockfile) |
| `packages/daemon/src/engine/storcon-client.ts` | `src/mgmt/service/project.rs:95-123` (tenant create), `branch.rs:570-599` (get_lsn_by_timestamp) |
| `packages/daemon/src/engine/pageserver-client.ts` | `src/mgmt/service/branch.rs` timeline_create/info/delete/detach_ancestor call sites |
| `packages/daemon/src/compute/*` | `src/mgmt/compute/mod.rs` (spec JSON :820-917, postgresql.conf :737-809, launch args :121-289, ports :696-736), `src/utils/password.rs` |
| `packages/daemon/src/services/*` | `src/mgmt/service/{project,branch}.rs` flows incl. restore swap :601-848, reset :850+ |

Initialize the neon submodule reference only when a payload is ambiguous: `git -C ~/git/neond submodule update --init --depth 1 neon` (pinned: `6a35a3e9f149`). Prefer reading neond's call sites first.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/vitest.config.ts`, `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: workspace layout; `@devdb/shared` importable from `@devdb/daemon`; `pnpm -r test` and `pnpm -r build` green.

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEVDB } from "@devdb/shared";

describe("workspace", () => {
  it("resolves shared package", () => {
    expect(DEVDB).toBe("devdb");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jordan/git/devdb && corepack enable && pnpm install 2>/dev/null; pnpm --filter @devdb/daemon test`
Expected: FAIL (packages don't exist yet / cannot resolve `@devdb/shared`).

- [ ] **Step 3: Create the workspace files**

Root `package.json`:
```json
{
  "name": "devdb",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm --filter @devdb/shared build && pnpm -r test",
    "test:integration": "pnpm --filter @devdb/integration test"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "tests/integration"
# Supply-chain policy: dependencies must be >=24h old at resolution time
minimumReleaseAge: 1440
allowBuilds:
  better-sqlite3: true
  esbuild: false
```

`.npmrc`:
```
shamefully-hoist=false
engine-strict=true
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.devdb-data/
```

`packages/shared/package.json`:
```json
{
  "name": "@devdb/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "echo no tests" },
  "devDependencies": { "typescript": "^5.7.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`:
```ts
export const DEVDB = "devdb";
```

`packages/daemon/package.json`:
```json
{
  "name": "@devdb/daemon",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "pnpm --filter @devdb/shared build && vitest run"
  },
  "dependencies": {
    "@devdb/shared": "workspace:*",
    "better-sqlite3": "^11.8.0",
    "drizzle-orm": "^0.38.0",
    "execa": "^9.5.0",
    "fastify": "^5.2.0",
    "pg": "^8.13.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/daemon/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/daemon/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`packages/daemon/src/index.ts`:
```ts
export {};
```

- [ ] **Step 4: Install and run test to verify it passes**

Run: `pnpm install && pnpm --filter @devdb/shared build && pnpm --filter @devdb/daemon test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (daemon, shared)"
```

---

### Task 2: Docker image with engine binaries + inventory check

**Files:**
- Create: `docker/Dockerfile`, `docker/compose.yaml`, `docker/verify-binaries.sh`
- Create: `docker/BINARIES.md` (records pinned digest + inventory output)

**Interfaces:**
- Consumes: workspace from Task 1.
- Produces: image `devdb:dev` with engine binaries at `/usr/local/share/neon/bin/{pageserver,safekeeper,storage_broker,storage_controller,compute_ctl}` and Postgres at `/usr/local/share/neon/pg_install/<ver>/`; env `NEON_BINARIES_DIR`, `PG_INSTALL_DIR` set; daemon source runs under Node 22 as user `node`. Constant `SUPPORTED_PG_VERSIONS` decided here, used by Task 3.

- [ ] **Step 1: Pin the neond image digest**

```bash
docker pull neond/neond:latest
docker image inspect neond/neond:latest --format '{{index .RepoDigests 0}}'
```
Record output (`neond/neond@sha256:…`) — used as `FROM` below and written into `docker/BINARIES.md`.

- [ ] **Step 2: Write the verification script (the "failing test")**

`docker/verify-binaries.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
BIN=/usr/local/share/neon/bin
PG=/usr/local/share/neon/pg_install
# Expected shipped majors — keep in sync with docker/BINARIES.md (amendment A7)
EXPECTED_PG_VERSIONS=(14 15 16 17)

for b in pageserver safekeeper storage_broker storage_controller compute_ctl; do
  test -x "$BIN/$b" || { echo "MISSING $b"; exit 1; }
  if ldd "$BIN/$b" 2>/dev/null | grep -q "not found"; then
    echo "BROKEN LINKAGE for $b:"; ldd "$BIN/$b" | grep "not found"; exit 1
  fi
done
"$BIN/pageserver" --version
echo "--- pg_install inventory ---"
ls "$PG"
for v in "${EXPECTED_PG_VERSIONS[@]}"; do
  pgbin="$PG/v$v/bin/postgres"
  test -x "$pgbin" || { echo "MISSING pg_install v$v"; exit 1; }
  echo "v$v: $("$pgbin" --version)"
done
for d in "$PG"/*/; do
  name=$(basename "$d")
  case "$name" in v14|v15|v16|v17) ;; *) echo "extra pg_install dir: $name (informational)";; esac
done
test -x "$PG/vanilla_v17/bin/initdb" && echo "vanilla_v17: OK (storcon DB host)" || echo "WARNING: vanilla_v17 missing — see Task 6 fallback"
node --version
echo "ALL BINARIES OK"
```

- [ ] **Step 3: Run it against a plain node image to verify it fails**

Run: `docker run --rm -v $PWD/docker/verify-binaries.sh:/v.sh node:22-bookworm-slim bash /v.sh`
Expected: FAIL with `MISSING pageserver`.

- [ ] **Step 4: Write the Dockerfile**

`docker/Dockerfile` (replace digest with Step 1 output):
```dockerfile
# syntax=docker/dockerfile:1
FROM neond/neond@sha256:REPLACE_WITH_PINNED_DIGEST AS neon-binaries

FROM node:22-bookworm-slim
# Runtime libs the neon binaries + postgres need (oracle: neond Dockerfile runtime stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 libpq5 libreadline8 libseccomp2 libcurl4 \
    libicu72 zlib1g liblz4-1 libzstd1 libxml2 libkrb5-3 libuuid1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=neon-binaries /usr/local/share/neon /usr/local/share/neon
ENV NEON_BINARIES_DIR=/usr/local/share/neon/bin \
    PG_INSTALL_DIR=/usr/local/share/neon/pg_install \
    DEVDB_DATA_DIR=/data \
    DEVDB_HTTP_PORT=4400 \
    DEVDB_PORT_RANGE=54300-54339
RUN corepack enable && mkdir -p /data /app && chown -R node:node /data /app
WORKDIR /app
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY --chown=node:node packages ./packages
USER node
RUN pnpm install --frozen-lockfile && pnpm -r build
COPY --chown=node:node docker/verify-binaries.sh /usr/local/bin/verify-binaries.sh
RUN bash /usr/local/bin/verify-binaries.sh
EXPOSE 4400 54300-54339
CMD ["node", "packages/daemon/dist/index.js"]
```

`docker/compose.yaml`:
```yaml
services:
  devdb:
    build: { context: .., dockerfile: docker/Dockerfile }
    image: devdb:dev
    init: true
    ports:
      - "4400:4400"
      - "54300-54339:54300-54339"
    volumes:
      - devdb-data:/data
    stop_grace_period: 60s
volumes:
  devdb-data:
```

- [ ] **Step 5: Build and verify**

Run: `docker build -f docker/Dockerfile -t devdb:dev . && docker run --rm devdb:dev bash /usr/local/bin/verify-binaries.sh`
Expected: `ALL BINARIES OK`, plus the pg_install inventory listing.

- [ ] **Step 6: Record the inventory decision**

Write `docker/BINARIES.md` with: the pinned digest, the full inventory output, and the resulting `SUPPORTED_PG_VERSIONS` list = every `v<N>` dir (N ≥ 14) that has `bin/postgres`, e.g. `[14, 15, 16, 17]`. **If `v18` is absent, note it — PG 18 becomes a Phase 5 workstream (spec risk #1), and Task 3's `PgVersionSchema` uses what exists, defaulting to the highest.** If `vanilla_v17` is absent, note Task 6's fallback applies.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: docker image with pinned neon engine binaries + inventory"
```

---

### Task 3: Shared types + daemon config module

> **AMENDED (A8, post-review):** `loadConfig` is hardened beyond the block below — decimal-only `DEVDB_HTTP_PORT`, `.trim().min(1)` path vars, and rejection of endpoint ranges/HTTP ports that collide with the reserved engine ports. See `packages/daemon/src/config.ts` (commit 5ec2418); the `loadConfig` signature and `DevdbConfig` shape are unchanged.

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `packages/daemon/src/config.ts`
- Test: `packages/daemon/test/config.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_PG_VERSIONS` decision from `docker/BINARIES.md` (Task 2).
- Produces (used by all later tasks):
  - shared: `PgVersionSchema`, `type PgVersion`, `DEFAULT_PG_VERSION`, `EndpointStatusSchema`, `type EndpointStatus`, `type ProjectDto`, `type BranchDto`, `type StatusDto`
  - daemon: `loadConfig(env?: NodeJS.ProcessEnv): DevdbConfig` where
    `DevdbConfig = { httpPort: number; dataDir: string; portRange: { min: number; max: number }; neonBinDir: string; pgInstallDir: string; engine: { brokerPort: 50051; storconPort: 1234; storconDbPort: 5431; pageserverHttpPort: 9898; pageserverPgPort: 64000; safekeeperPgPort: 5454; safekeeperHttpPort: 7676 } }`

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DEVDB_DATA_DIR: "/data",
  NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
  PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.httpPort).toBe(4400);
    expect(c.portRange).toEqual({ min: 54300, max: 54339 });
    expect(c.engine.storconPort).toBe(1234);
  });
  it("parses DEVDB_PORT_RANGE", () => {
    const c = loadConfig({ ...base, DEVDB_PORT_RANGE: "60000-60010" });
    expect(c.portRange).toEqual({ min: 60000, max: 60010 });
  });
  it("rejects inverted range", () => {
    expect(() => loadConfig({ ...base, DEVDB_PORT_RANGE: "6000-100" })).toThrow(/PORT_RANGE/);
  });
  it("requires data dir", () => {
    expect(() => loadConfig({})).toThrow(/DEVDB_DATA_DIR/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test`
Expected: FAIL — `config.js` not found.

- [ ] **Step 3: Implement shared types and config**

`packages/shared/src/index.ts` (replace; adjust the PgVersion literals to `docker/BINARIES.md`):
```ts
import { z } from "zod";

export const DEVDB = "devdb";

// Adjust to docker/BINARIES.md inventory (Task 2). Order low→high.
export const SUPPORTED_PG_VERSIONS = [14, 15, 16, 17] as const;
export const PgVersionSchema = z.union([z.literal(14), z.literal(15), z.literal(16), z.literal(17)]);
export type PgVersion = z.infer<typeof PgVersionSchema>;
export const DEFAULT_PG_VERSION: PgVersion = 17;

export const EndpointStatusSchema = z.enum(["stopped", "starting", "running", "stopping", "failed"]);
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

export interface ProjectDto {
  id: string;
  name: string;
  pgVersion: PgVersion;
  createdAt: string;
  updatedAt: string;
}

export interface BranchDto {
  id: string;
  projectId: string;
  parentBranchId: string | null;
  name: string;
  slug: string;
  timelineId: string;
  endpointStatus: EndpointStatus;
  port: number | null;
  connectionString: string | null;
  lastRecordLsn: string | null;
  logicalSizeBytes: number | null;
  createdBy: "ui" | "api" | "mcp";
  createdAt: string;
  updatedAt: string;
}

export interface StatusDto {
  version: string;
  healthy: boolean;
  engine: Record<string, { state: "running" | "stopped" | "failed"; pid: number | null }>;
}
```

Add `"zod": "^3.24.0"` to `packages/shared/package.json` dependencies.

`packages/daemon/src/config.ts`:
```ts
import { z } from "zod";

const EnvSchema = z.object({
  DEVDB_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  DEVDB_DATA_DIR: z.string().min(1),
  DEVDB_PORT_RANGE: z.string().regex(/^\d+-\d+$/).default("54300-54339"),
  NEON_BINARIES_DIR: z.string().min(1),
  PG_INSTALL_DIR: z.string().min(1),
});

export interface DevdbConfig {
  httpPort: number;
  dataDir: string;
  portRange: { min: number; max: number };
  neonBinDir: string;
  pgInstallDir: string;
  engine: {
    brokerPort: 50051;
    storconPort: 1234;
    storconDbPort: 5431;
    pageserverHttpPort: 9898;
    pageserverPgPort: 64000;
    safekeeperPgPort: 5454;
    safekeeperHttpPort: 7676;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DevdbConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;
  const [minS, maxS] = e.DEVDB_PORT_RANGE.split("-") as [string, string];
  const min = Number(minS);
  const max = Number(maxS);
  if (!(min > 0 && max >= min && max <= 65535)) {
    throw new Error(`DEVDB_PORT_RANGE invalid: ${e.DEVDB_PORT_RANGE}`);
  }
  return {
    httpPort: e.DEVDB_HTTP_PORT,
    dataDir: e.DEVDB_DATA_DIR,
    portRange: { min, max },
    neonBinDir: e.NEON_BINARIES_DIR,
    pgInstallDir: e.PG_INSTALL_DIR,
    // oracle: port constants from src/daemon/mod.rs + src/daemon/pageserver/mod.rs
    engine: {
      brokerPort: 50051,
      storconPort: 1234,
      storconDbPort: 5431,
      pageserverHttpPort: 9898,
      pageserverPgPort: 64000,
      safekeeperPgPort: 5454,
      safekeeperHttpPort: 7676,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm install && pnpm --filter @devdb/shared build && pnpm --filter @devdb/daemon test`
Expected: PASS (config tests + smoke).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: shared DTO types and daemon env config"
```

---

### Task 4: SQLite state layer (schema, repos, per-branch mutation queue)

> **AMENDED (A9, post-review):** beyond the blocks below — branches carries `UNIQUE(project_id, id)` + a composite FK enforcing same-project parentage; `restoreSwap` scopes reparenting by `project_id` and NULLs the archived row's `sticky_port`; `BranchQueue` evicts settled tails and exposes `pendingCount()`; repo `delete` methods document the FK-throw contract (services own guard ordering). See commit a76db9d.

**Files:**
- Create: `packages/daemon/src/state/db.ts`, `packages/daemon/src/state/schema.ts`, `packages/daemon/src/state/repos.ts`, `packages/daemon/src/state/queue.ts`
- Test: `packages/daemon/test/state.test.ts`

**Interfaces:**
- Consumes: nothing external (pure).
- Produces (exact names used by Tasks 12-17):
  - `openState(path: string): StateDb` (`":memory:"` allowed in tests)
  - `ProjectsRepo`: `create({id,name,pgVersion}): ProjectRow`, `list(): ProjectRow[]`, `byId(id): ProjectRow | null`, `byName(name): ProjectRow | null`, `delete(id): void`
  - `BranchesRepo`: `create({id,projectId,parentBranchId,name,slug,timelineId,password,createdBy}): BranchRow`, `byId(id)`, `byProjectAndName(projectId,name)`, `listByProject(projectId)`, `listByParent(parentBranchId)`, `updateEndpoint(id,{status,port})`, `setStickyPort(id,port)`, `delete(id)`, `restoreSwap(args): BranchRow` (see Step 3), `countAll(): number`
  - `SettingsRepo`: `get(key): string | null`, `set(key,value): void`
  - `BranchQueue`: `run<T>(branchId: string, fn: () => Promise<T>): Promise<T>` — serializes per branch id
  - Row types: `ProjectRow { id; name; pgVersion; createdAt; updatedAt }`, `BranchRow { id; projectId; parentBranchId; name; slug; timelineId; password; stickyPort: number | null; endpointStatus; importStatus: string; importError: string | null; createdBy; createdAt; updatedAt }`

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/state.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";

function freshState() {
  return openState(":memory:");
}

describe("state", () => {
  it("creates and fetches projects and branches", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const b = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "b".repeat(32),
      password: "pw", createdBy: "api",
    });
    expect(s.projects.byName("acme")?.id).toBe(p.id);
    expect(s.branches.byProjectAndName(p.id, "main")?.id).toBe(b.id);
    expect(s.branches.listByProject(p.id)).toHaveLength(1);
    expect(b.endpointStatus).toBe("stopped");
  });

  it("enforces unique branch name per project", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const mk = () => s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: crypto.randomUUID(), timelineId: "c".repeat(32),
      password: "pw", createdBy: "api",
    });
    mk();
    expect(mk).toThrow();
  });

  it("restoreSwap archives old branch and moves identity to new row", () => {
    const s = freshState();
    const p = s.projects.create({ id: "a".repeat(32), name: "acme", pgVersion: 17 });
    const orig = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: null,
      name: "main", slug: "acme-main", timelineId: "1".repeat(32),
      password: "pw", createdBy: "api",
    });
    const child = s.branches.create({
      id: crypto.randomUUID(), projectId: p.id, parentBranchId: orig.id,
      name: "dev", slug: "acme-dev", timelineId: "2".repeat(32),
      password: "pw2", createdBy: "api",
    });
    const swapped = s.branches.restoreSwap({
      oldBranchId: orig.id, newBranchId: crypto.randomUUID(),
      newTimelineId: "3".repeat(32), archiveName: "main_pitr_archived_x",
      archiveSlug: "acme-main-arch", reparentedTimelineIds: [child.timelineId],
    });
    expect(swapped.name).toBe("main");
    expect(swapped.slug).toBe("acme-main");
    expect(swapped.timelineId).toBe("3".repeat(32));
    const archived = s.branches.byId(orig.id)!;
    expect(archived.name).toBe("main_pitr_archived_x");
    // child whose timeline was reparented now points at the new branch row
    expect(s.branches.byId(child.id)!.parentBranchId).toBe(swapped.id);
  });

  it("BranchQueue serializes per branch", async () => {
    const q = new BranchQueue();
    const order: string[] = [];
    await Promise.all([
      q.run("b1", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("first"); }),
      q.run("b1", async () => { order.push("second"); }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/state/schema.ts`:
```ts
export const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pg_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_branch_id TEXT REFERENCES branches(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timeline_id TEXT NOT NULL,
  password TEXT NOT NULL,
  sticky_port INTEGER,
  endpoint_status TEXT NOT NULL DEFAULT 'stopped',
  import_status TEXT NOT NULL DEFAULT 'none',
  import_error TEXT,
  created_by TEXT NOT NULL DEFAULT 'api',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  branch_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  log_path TEXT,
  lsn TEXT,
  size_bytes INTEGER,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS export_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
```

`packages/daemon/src/state/db.ts`:
```ts
import Database from "better-sqlite3";
import { DDL } from "./schema.js";
import { BranchesRepo, ProjectsRepo, SettingsRepo } from "./repos.js";

export interface StateDb {
  raw: Database.Database;
  projects: ProjectsRepo;
  branches: BranchesRepo;
  settings: SettingsRepo;
}

export function openState(path: string): StateDb {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(DDL);
  return {
    raw,
    projects: new ProjectsRepo(raw),
    branches: new BranchesRepo(raw),
    settings: new SettingsRepo(raw),
  };
}
```

`packages/daemon/src/state/repos.ts`:
```ts
import type Database from "better-sqlite3";
import type { PgVersion } from "@devdb/shared";

export interface ProjectRow {
  id: string; name: string; pgVersion: PgVersion; createdAt: string; updatedAt: string;
}
export interface BranchRow {
  id: string; projectId: string; parentBranchId: string | null; name: string; slug: string;
  timelineId: string; password: string; stickyPort: number | null; endpointStatus: string;
  importStatus: string; importError: string | null; createdBy: string;
  createdAt: string; updatedAt: string;
}

function projectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string, name: r.name as string, pgVersion: r.pg_version as PgVersion,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function branchRow(r: Record<string, unknown>): BranchRow {
  return {
    id: r.id as string, projectId: r.project_id as string,
    parentBranchId: (r.parent_branch_id as string | null) ?? null,
    name: r.name as string, slug: r.slug as string, timelineId: r.timeline_id as string,
    password: r.password as string, stickyPort: (r.sticky_port as number | null) ?? null,
    endpointStatus: r.endpoint_status as string, importStatus: r.import_status as string,
    importError: (r.import_error as string | null) ?? null, createdBy: r.created_by as string,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export class ProjectsRepo {
  constructor(private db: Database.Database) {}
  create(a: { id: string; name: string; pgVersion: PgVersion }): ProjectRow {
    this.db.prepare("INSERT INTO projects (id, name, pg_version) VALUES (?, ?, ?)")
      .run(a.id, a.name, a.pgVersion);
    return this.byId(a.id)!;
  }
  list(): ProjectRow[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all()
      .map((r) => projectRow(r as Record<string, unknown>));
  }
  byId(id: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? projectRow(r as Record<string, unknown>) : null;
  }
  byName(name: string): ProjectRow | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
    return r ? projectRow(r as Record<string, unknown>) : null;
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

export class BranchesRepo {
  constructor(private db: Database.Database) {}
  create(a: {
    id: string; projectId: string; parentBranchId: string | null; name: string; slug: string;
    timelineId: string; password: string; createdBy: string;
  }): BranchRow {
    this.db.prepare(
      `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.projectId, a.parentBranchId, a.name, a.slug, a.timelineId, a.password, a.createdBy);
    return this.byId(a.id)!;
  }
  byId(id: string): BranchRow | null {
    const r = this.db.prepare("SELECT * FROM branches WHERE id = ?").get(id);
    return r ? branchRow(r as Record<string, unknown>) : null;
  }
  byProjectAndName(projectId: string, name: string): BranchRow | null {
    const r = this.db.prepare("SELECT * FROM branches WHERE project_id = ? AND name = ?")
      .get(projectId, name);
    return r ? branchRow(r as Record<string, unknown>) : null;
  }
  listByProject(projectId: string): BranchRow[] {
    return this.db.prepare("SELECT * FROM branches WHERE project_id = ? ORDER BY created_at")
      .all(projectId).map((r) => branchRow(r as Record<string, unknown>));
  }
  listByParent(parentBranchId: string): BranchRow[] {
    return this.db.prepare("SELECT * FROM branches WHERE parent_branch_id = ?")
      .all(parentBranchId).map((r) => branchRow(r as Record<string, unknown>));
  }
  updateEndpoint(id: string, a: { status: string; port: number | null }): void {
    this.db.prepare(
      "UPDATE branches SET endpoint_status = ?, sticky_port = COALESCE(?, sticky_port), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(a.status, a.port, id);
  }
  setStickyPort(id: string, port: number): void {
    this.db.prepare("UPDATE branches SET sticky_port = ? WHERE id = ?").run(port, id);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM branches WHERE id = ?").run(id);
  }
  countAll(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM branches").get() as { n: number };
    return r.n;
  }
  // oracle: src/mgmt/repository/branch.rs:251 restore_swap — archive old row under new
  // name/slug, insert replacement carrying the original identity (name/slug/password/port),
  // reparent children whose timelines the engine reparented, repoint remaining children.
  restoreSwap(a: {
    oldBranchId: string; newBranchId: string; newTimelineId: string;
    archiveName: string; archiveSlug: string; reparentedTimelineIds: string[];
  }): BranchRow {
    const tx = this.db.transaction(() => {
      const old = this.byId(a.oldBranchId);
      if (!old) throw new Error(`branch ${a.oldBranchId} not found`);
      this.db.prepare("UPDATE branches SET name = ?, slug = ? WHERE id = ?")
        .run(a.archiveName, a.archiveSlug, a.oldBranchId);
      this.db.prepare(
        `INSERT INTO branches (id, project_id, parent_branch_id, name, slug, timeline_id, password, sticky_port, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.newBranchId, old.projectId, old.parentBranchId, old.name, old.slug,
        a.newTimelineId, old.password, old.stickyPort, old.createdBy);
      if (a.reparentedTimelineIds.length > 0) {
        const placeholders = a.reparentedTimelineIds.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE branches SET parent_branch_id = ? WHERE timeline_id IN (${placeholders})`,
        ).run(a.newBranchId, ...a.reparentedTimelineIds);
      }
      this.db.prepare("UPDATE branches SET parent_branch_id = ? WHERE parent_branch_id = ? AND id != ?")
        .run(a.newBranchId, a.oldBranchId, a.newBranchId);
    });
    tx();
    return this.byId(a.newBranchId)!;
  }
}

export class SettingsRepo {
  constructor(private db: Database.Database) {}
  get(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string } | undefined;
    return r?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
}
```

`packages/daemon/src/state/queue.ts`:
```ts
export class BranchQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(branchId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    this.tails.set(branchId, next.catch(() => undefined));
    return next;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test`
Expected: PASS (state + queue + config + smoke).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sqlite state layer with repos and per-branch queue"
```

---

### Task 5: ManagedProcess supervisor

**Files:**
- Create: `packages/daemon/src/engine/process.ts`
- Test: `packages/daemon/test/process.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6-8, 11):
  - `class ManagedProcess` — `new ManagedProcess(opts: { name: string; bin: string; args: string[]; env?: Record<string,string>; cwd?: string; readyNeedle: string; readyTimeoutMs?: number; onLine?: (line: string, stream: "stdout"|"stderr") => void })`
  - `start(): Promise<void>` (resolves when `readyNeedle` seen on stdout or stderr; rejects on timeout/exit)
  - `stop(timeoutMs?: number): Promise<void>` (SIGTERM, then SIGKILL after timeout; resolves on exit)
  - `state: "stopped"|"starting"|"running"|"failed"`, `pid: number | null`, `recentLines(n: number): string[]`
  - ~~`waitForLine` internal helper~~ **AMENDED (A10):** needle-watching is inlined in `start()` (per-stream readline watch, one shared readiness timeout) rather than a named helper — oracle: neond `wait_for_output_timeout` (`src/mgmt/compute/mod.rs:245-252`). Post-review the class also fences handlers by child identity, survives stop()-during-starting, evicts readline interfaces on exit, and swallows onLine observer errors (commit b1623d5).

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/process.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/engine/process.js";

const node = process.execPath;

describe("ManagedProcess", () => {
  it("start resolves when needle appears and captures lines", async () => {
    const p = new ManagedProcess({
      name: "fake", bin: node,
      args: ["-e", "console.log('booting'); console.log('READY now'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    expect(p.state).toBe("running");
    expect(p.recentLines(10).join("\n")).toContain("booting");
    await p.stop();
    expect(p.state).toBe("stopped");
  });

  it("start rejects when process exits before needle", async () => {
    const p = new ManagedProcess({
      name: "dies", bin: node, args: ["-e", "console.log('nope')"],
      readyNeedle: "READY", readyTimeoutMs: 5000,
    });
    await expect(p.start()).rejects.toThrow(/exited|READY/);
    expect(p.state).toBe("failed");
  });

  it("start rejects on timeout", async () => {
    const p = new ManagedProcess({
      name: "slow", bin: node, args: ["-e", "setInterval(()=>{},1000)"],
      readyNeedle: "READY", readyTimeoutMs: 300,
    });
    await expect(p.start()).rejects.toThrow(/timed out/i);
    await p.stop();
  });

  it("stop escalates to SIGKILL", async () => {
    const p = new ManagedProcess({
      name: "stubborn", bin: node,
      args: ["-e", "process.on('SIGTERM',()=>{}); console.log('READY'); setInterval(()=>{},1000)"],
      readyNeedle: "READY",
    });
    await p.start();
    await p.stop(500);
    expect(p.state).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test process`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/engine/process.ts`:
```ts
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface ManagedProcessOpts {
  name: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  readyNeedle: string;
  readyTimeoutMs?: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

const RING_SIZE = 500;

export class ManagedProcess {
  state: "stopped" | "starting" | "running" | "failed" = "stopped";
  pid: number | null = null;
  private child: ChildProcess | null = null;
  private ring: string[] = [];

  constructor(private opts: ManagedProcessOpts) {}

  recentLines(n: number): string[] {
    return this.ring.slice(-n);
  }

  private ingest(line: string, stream: "stdout" | "stderr"): void {
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.opts.onLine?.(line, stream);
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error(`${this.opts.name} already ${this.state}`);
    }
    this.state = "starting";
    const timeoutMs = this.opts.readyTimeoutMs ?? 60_000;
    const child = spawn(this.opts.bin, this.opts.args, {
      env: this.opts.env ?? {},
      cwd: this.opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid ?? null;

    let ready: () => void;
    let failed: (e: Error) => void;
    const readiness = new Promise<void>((res, rej) => { ready = res; failed = rej; });

    let seen = false;
    const watch = (stream: NodeJS.ReadableStream, which: "stdout" | "stderr") => {
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => {
        this.ingest(line, which);
        if (!seen && line.includes(this.opts.readyNeedle)) {
          seen = true;
          ready();
        }
      });
    };
    watch(child.stdout!, "stdout");
    watch(child.stderr!, "stderr");

    const timer = setTimeout(() => {
      failed(new Error(`${this.opts.name}: timed out waiting for "${this.opts.readyNeedle}" after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      this.pid = null;
      if (!seen) {
        failed(new Error(`${this.opts.name}: exited (code=${code} signal=${signal}) before ready. Last output:\n${this.recentLines(20).join("\n")}`));
      }
      if (this.state !== "stopped") this.state = seen && this.state === "running" ? "failed" : this.state;
      this.child = null;
    });
    child.on("error", (e) => failed(new Error(`${this.opts.name}: spawn error: ${e.message}`)));

    try {
      await readiness;
      this.state = "running";
    } catch (e) {
      this.state = "failed";
      child.kill("SIGKILL");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return;
    }
    this.state = "stopped";
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(killer);
    this.child = null;
    this.pid = null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test process`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: managed process supervisor with readiness needles"
```

---

### Task 6: Embedded Postgres for the storage controller

> **AMENDED (A11, post-review):** beyond the block below — `connectionUri()` percent-encodes the password; the pwfile lives in a private `mkdtemp` dir written with `wx`; `start()` refuses while a prior process is starting/running; `init()` dedupes concurrent calls via an in-flight promise and clears a PG_VERSION-less (interrupted-init) data dir before running initdb. See commit 50ea41c. Cross-task note: T13's `connectionString` builder must also percent-encode the branch password.

**Files:**
- Create: `packages/daemon/src/engine/embedded-postgres.ts`
- Test: `packages/daemon/test/embedded-postgres.test.ts` (unit, mocked spawn paths) — real behavior covered in Task 8's integration test.

**Interfaces:**
- Consumes: `ManagedProcess` (Task 5).
- Produces (used by Task 8):
  - `class EmbeddedPostgres` — `new EmbeddedPostgres(opts: { name: string; dataDir: string; pgInstallDir: string; port: number; password: string; onLine?: (line: string) => void })`
  - `init(): Promise<void>` (initdb if data dir missing), `start(): Promise<void>`, `stop(): Promise<void>`, `connectionUri(): string` → `postgresql://devdb:<password>@127.0.0.1:<port>/postgres`
  - `resolveVanillaPgDir(pgInstallDir: string): string` — picks `vanilla_v17` if present, else highest `v<N>` dir (Task 2 fallback).

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/embedded-postgres.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgres, resolveVanillaPgDir } from "../src/engine/embedded-postgres.js";

describe("EmbeddedPostgres", () => {
  it("builds connection uri", () => {
    const pg = new EmbeddedPostgres({
      name: "storcon-db", dataDir: "/tmp/x", pgInstallDir: "/tmp/pg", port: 5431, password: "s3cret",
    });
    expect(pg.connectionUri()).toBe("postgresql://devdb:s3cret@127.0.0.1:5431/postgres");
  });

  it("resolveVanillaPgDir prefers vanilla_v17, falls back to highest v<N>", () => {
    const root = mkdtempSync(join(tmpdir(), "pgi-"));
    mkdirSync(join(root, "v16"));
    mkdirSync(join(root, "v17"));
    expect(resolveVanillaPgDir(root)).toBe(join(root, "v17"));
    mkdirSync(join(root, "vanilla_v17"));
    expect(resolveVanillaPgDir(root)).toBe(join(root, "vanilla_v17"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test embedded`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/engine/embedded-postgres.ts`:
```ts
import { execa } from "execa";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedProcess } from "./process.js";

// oracle: src/daemon/postgres/mod.rs — initdb/postgres args and env.
// Deviation: user is `devdb` (neond uses `neond`).
export function resolveVanillaPgDir(pgInstallDir: string): string {
  const vanilla = join(pgInstallDir, "vanilla_v17");
  if (existsSync(vanilla)) return vanilla;
  const versions = readdirSync(pgInstallDir)
    .filter((d) => /^v\d+$/.test(d))
    .map((d) => Number(d.slice(1)))
    .sort((a, b) => b - a);
  if (versions.length === 0) throw new Error(`no postgres install found in ${pgInstallDir}`);
  return join(pgInstallDir, `v${versions[0]}`);
}

export class EmbeddedPostgres {
  private proc: ManagedProcess | null = null;
  private pgDir: string;

  constructor(private opts: {
    name: string; dataDir: string; pgInstallDir: string; port: number; password: string;
    onLine?: (line: string) => void;
  }) {
    this.pgDir = resolveVanillaPgDir(opts.pgInstallDir);
  }

  connectionUri(): string {
    return `postgresql://devdb:${this.opts.password}@127.0.0.1:${this.opts.port}/postgres`;
  }

  async init(): Promise<void> {
    if (existsSync(join(this.opts.dataDir, "PG_VERSION"))) return;
    await mkdir(this.opts.dataDir, { recursive: true });
    const pwfile = join(tmpdir(), `devdb-pw-${process.pid}-${this.opts.port}`);
    await writeFile(pwfile, this.opts.password, { mode: 0o600 });
    try {
      // oracle: initdb -U <user> --pwfile <f> --auth-local=scram-sha-256 --auth-host=scram-sha-256 -D <dir>
      await execa(join(this.pgDir, "bin", "initdb"), [
        "-U", "devdb", "--pwfile", pwfile,
        "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
        "-D", this.opts.dataDir,
      ], { env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") } });
    } finally {
      await rm(pwfile, { force: true });
    }
  }

  async start(): Promise<void> {
    this.proc = new ManagedProcess({
      name: this.opts.name,
      bin: join(this.pgDir, "bin", "postgres"),
      args: ["-D", this.opts.dataDir, "-p", String(this.opts.port)],
      env: { LD_LIBRARY_PATH: join(this.pgDir, "lib") },
      // oracle: readiness needle "connections" ("ready to accept connections")
      readyNeedle: "connections",
      onLine: (l) => this.opts.onLine?.(l),
    });
    await this.proc.start();
  }

  async stop(): Promise<void> {
    await this.proc?.stop();
    this.proc = null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test embedded`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: embedded postgres wrapper for storage controller db"
```

---

### Task 7: Engine config generation (trust mode)

> **AMENDED (A12, post-review):** beyond the blocks below — TOML path values go through a `tomlString()` escaping helper; `pageserverMetadataJson(cfg)` and `safekeeperRegistrationBody(cfg, nowIso)` now take the config so ports derive from `cfg.engine` (single source of truth; Task 8's call sites in this plan were updated to match); `loadConfig` additionally requires the three path env vars to be absolute. See commit 749f6f6.

**Files:**
- Create: `packages/daemon/src/engine/configs.ts`
- Test: `packages/daemon/test/configs.test.ts`

> **Trust-mode deviation (spec decision #7 detail):** neond enables NeonJWT auth on every engine component via an Ed25519 keypair (`http_auth_type`/`pg_auth_type = "NeonJWT"`, storcon `--jwt-token/--peer-jwt-token/--safekeeper-jwt-token/--public-key`, safekeeper `--*-auth-public-key-path`, pageserver `NEON_AUTH_TOKEN`, compute `storage_auth_token`). DevDB omits ALL of it: engine ports bind to `127.0.0.1` inside the container and upstream `neon_local` runs this exact stack in trust mode by default. **Fallback if any component refuses trust mode during Task 8:** port neond's `component_auth` (Ed25519 keypair + JWT per scope) — the flags to re-add are all listed above and in the oracle map.

**Interfaces:**
- Consumes: `DevdbConfig` (Task 3).
- Produces (used by Task 8):
  - `engineDirs(cfg): { pageserverDir; pageserverLayers; safekeeperDir; storconDbDir; logsDir; computesDir }` (absolute paths under `cfg.dataDir`)
  - `pageserverToml(cfg): string`, `pageserverIdentityToml(): string`, `pageserverMetadataJson(): string`
  - `brokerSpec(cfg)`, `storconSpec(cfg, dbUri: string)`, `safekeeperSpec(cfg)`, `pageserverSpec(cfg)` — each `{ name; bin; args: string[]; readyNeedle: string }`
  - `safekeeperRegistrationBody(nowIso: string): object`

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/configs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  brokerSpec, engineDirs, pageserverIdentityToml, pageserverMetadataJson,
  pageserverSpec, pageserverToml, safekeeperRegistrationBody, safekeeperSpec, storconSpec,
} from "../src/engine/configs.js";

const cfg = loadConfig({
  DEVDB_DATA_DIR: "/data",
  NEON_BINARIES_DIR: "/usr/local/share/neon/bin",
  PG_INSTALL_DIR: "/usr/local/share/neon/pg_install",
});

describe("engine configs", () => {
  it("pageserver.toml matches oracle shape in trust mode", () => {
    const toml = pageserverToml(cfg);
    expect(toml).toContain(`pg_distrib_dir = "/usr/local/share/neon/pg_install"`);
    expect(toml).toContain(`broker_endpoint = "http://127.0.0.1:50051/"`);
    expect(toml).toContain(`listen_pg_addr = "127.0.0.1:64000"`);
    expect(toml).toContain(`listen_http_addr = "127.0.0.1:9898"`);
    expect(toml).toContain(`control_plane_api = "http://127.0.0.1:1234/upcall/v1/"`);
    expect(toml).toContain(`local_path = "/data/pageserver_1"`);
    expect(toml).toContain("[disk_usage_based_eviction]");
    expect(toml).not.toContain("NeonJWT");
  });

  it("identity and metadata match oracle", () => {
    expect(pageserverIdentityToml()).toBe("id = 1\n");
    expect(JSON.parse(pageserverMetadataJson())).toEqual({
      host: "127.0.0.1", http_host: "127.0.0.1", http_port: 9898, port: 64000,
    });
  });

  it("process specs carry oracle args and needles", () => {
    expect(brokerSpec(cfg).args).toEqual(["-l", "127.0.0.1:50051"]);
    expect(brokerSpec(cfg).readyNeedle).toBe("listening");
    const storcon = storconSpec(cfg, "postgresql://devdb:x@127.0.0.1:5431/postgres");
    expect(storcon.args).toEqual([
      "-l", "127.0.0.1:1234",
      "--database-url", "postgresql://devdb:x@127.0.0.1:5431/postgres",
      "--dev",
      "--timeline-safekeeper-count", "1",
      "--timelines-onto-safekeepers",
      "--control-plane-url", "http://127.0.0.1:4318",
    ]);
    expect(storcon.readyNeedle).toBe("Serving HTTP on 127.0.0.1:1234");
    const sk = safekeeperSpec(cfg);
    expect(sk.args).toContain("--broker-endpoint");
    expect(sk.readyNeedle).toBe("starting safekeeper WAL service on");
    expect(pageserverSpec(cfg).readyNeedle).toBe("Starting pageserver http handler on 127.0.0.1:9898");
  });

  it("safekeeper registration body matches oracle", () => {
    expect(safekeeperRegistrationBody("2026-07-02T00:00:00Z")).toEqual({
      id: 1, region_id: "devdb-1", host: "127.0.0.1", port: 5454, http_port: 7676,
      version: 1, availability_zone_id: "devdb-1",
      created_at: "2026-07-02T00:00:00Z", updated_at: "2026-07-02T00:00:00Z",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test configs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/engine/configs.ts`:
```ts
import { join } from "node:path";
import type { DevdbConfig } from "../config.js";

export function engineDirs(cfg: DevdbConfig) {
  return {
    pageserverDir: join(cfg.dataDir, "pageserver"),
    pageserverLayers: join(cfg.dataDir, "pageserver_1"),
    safekeeperDir: join(cfg.dataDir, "safekeeper"),
    storconDbDir: join(cfg.dataDir, "daemon_data", "storage_controller_pg_data"),
    logsDir: join(cfg.dataDir, "logs"),
    computesDir: join(cfg.dataDir, "computes"),
  };
}

// oracle: src/daemon/pageserver/mod.rs:67-96 (auth keys omitted — trust mode, see Task 7 note)
export function pageserverToml(cfg: DevdbConfig): string {
  const layers = engineDirs(cfg).pageserverLayers;
  return [
    `availability_zone = "devdb-1"`,
    `pg_distrib_dir = "${cfg.pgInstallDir}"`,
    `broker_endpoint = "http://127.0.0.1:${cfg.engine.brokerPort}/"`,
    `listen_pg_addr = "127.0.0.1:${cfg.engine.pageserverPgPort}"`,
    `listen_http_addr = "127.0.0.1:${cfg.engine.pageserverHttpPort}"`,
    `control_plane_api = "http://127.0.0.1:${cfg.engine.storconPort}/upcall/v1/"`,
    ``,
    `[remote_storage]`,
    `local_path = "${layers}"`,
    ``,
    `[disk_usage_based_eviction]`,
    `enabled = true`,
    `max_usage_pct = 100`,
    `min_avail_bytes = 2000000000`,
    ``,
  ].join("\n");
}

export function pageserverIdentityToml(): string {
  return "id = 1\n"; // oracle: identity.toml content "id=1"
}

export function pageserverMetadataJson(): string {
  // oracle: src/daemon/pageserver/mod.rs:125-130
  return JSON.stringify({ host: "127.0.0.1", http_host: "127.0.0.1", http_port: 9898, port: 64000 });
}

export interface ProcessSpec {
  name: string; bin: string; args: string[]; readyNeedle: string;
}

export function brokerSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: src/daemon/mod.rs:67-75
  return {
    name: "storage_broker",
    bin: join(cfg.neonBinDir, "storage_broker"),
    args: ["-l", `127.0.0.1:${cfg.engine.brokerPort}`],
    readyNeedle: "listening",
  };
}

export function storconSpec(cfg: DevdbConfig, dbUri: string): ProcessSpec {
  // oracle: src/daemon/mod.rs:83-109 (JWT args omitted — trust mode)
  return {
    name: "storage_controller",
    bin: join(cfg.neonBinDir, "storage_controller"),
    args: [
      "-l", `127.0.0.1:${cfg.engine.storconPort}`,
      "--database-url", dbUri,
      "--dev",
      "--timeline-safekeeper-count", "1",
      "--timelines-onto-safekeepers",
      "--control-plane-url", "http://127.0.0.1:4318",
    ],
    readyNeedle: `Serving HTTP on 127.0.0.1:${cfg.engine.storconPort}`,
  };
}

export function safekeeperSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: src/daemon/mod.rs:117-144 (auth key paths omitted — trust mode)
  return {
    name: "safekeeper",
    bin: join(cfg.neonBinDir, "safekeeper"),
    args: [
      "-D", engineDirs(cfg).safekeeperDir,
      "--id", "1",
      "--broker-endpoint", `http://127.0.0.1:${cfg.engine.brokerPort}`,
      "--listen-pg", `127.0.0.1:${cfg.engine.safekeeperPgPort}`,
      "--listen-http", `127.0.0.1:${cfg.engine.safekeeperHttpPort}`,
      "--availability-zone", "devdb-1",
    ],
    readyNeedle: "starting safekeeper WAL service on",
  };
}

export function pageserverSpec(cfg: DevdbConfig): ProcessSpec {
  // oracle: src/daemon/mod.rs:152-165 (NEON_AUTH_TOKEN omitted — trust mode)
  return {
    name: "pageserver",
    bin: join(cfg.neonBinDir, "pageserver"),
    args: ["-D", engineDirs(cfg).pageserverDir],
    readyNeedle: `Starting pageserver http handler on 127.0.0.1:${cfg.engine.pageserverHttpPort}`,
  };
}

export function safekeeperRegistrationBody(nowIso: string): object {
  // oracle: src/daemon/mod.rs:247-281
  return {
    id: 1, region_id: "devdb-1", host: "127.0.0.1", port: 5454, http_port: 7676,
    version: 1, availability_zone_id: "devdb-1", created_at: nowIso, updated_at: nowIso,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test configs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: engine config and process spec generation (trust mode)"
```

---

### Task 8: Engine boot orchestration + status endpoint + first container integration test

> **AMENDED (A13, post-review):** beyond the blocks below — `EngineRuntime.start()` reverse-stops started components and rethrows on partial-boot failure; `main()` releases the lockfile on failed boot; `shutdown()` logs-and-continues per step with a 45s unref'd hard-exit timer and second-signal force exit (130); safekeeper registration uses a 10s AbortSignal timeout with 3-attempt backoff (4xx non-retryable). See commit 372772f.

**Files:**
- Create: `packages/daemon/src/engine/boot.ts`, `packages/daemon/src/http/api.ts`
- Modify: `packages/daemon/src/index.ts`
- Create: `tests/integration/package.json`, `tests/integration/vitest.config.ts`, `tests/integration/helpers/container.ts`
- Test: `tests/integration/boot.test.ts`

**Interfaces:**
- Consumes: Tasks 3-7 (`loadConfig`, `openState`, `ManagedProcess`, `EmbeddedPostgres`, config generators).
- Produces:
  - `class EngineRuntime` — `new EngineRuntime(cfg: DevdbConfig, state: StateDb)`; `start(): Promise<void>`; `stop(): Promise<void>`; `status(): Record<string, { state: string; pid: number | null }>`; property `storconDbUri: string`
  - `buildServer(deps: { cfg: DevdbConfig; state: StateDb; engine: EngineRuntime }): FastifyInstance` with `GET /api/status` → `StatusDto`
  - Integration helper: `startDevdb(): Promise<{ base: string; container: StartedTestContainer; mappedPort(p: number): number; stop(): Promise<void> }>`
  - Daemon main: lockfile at `<dataDir>/.lock` (`wx` create; on failure exit 1 with hint), SIGTERM → graceful stop.

- [ ] **Step 1: Set up the integration test package and write the failing test**

`tests/integration/package.json`:
```json
{
  "name": "@devdb/integration",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "execa": "^9.5.0",
    "pg": "^8.13.0",
    "testcontainers": "^10.16.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`tests/integration/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
```

`tests/integration/helpers/container.ts`:
```ts
import { execa } from "execa";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

const IMAGE = "devdb:dev";
let built = false;

export async function buildImage(): Promise<void> {
  if (built) return;
  await execa("docker", ["build", "-f", "docker/Dockerfile", "-t", IMAGE, "."], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: "inherit",
  });
  built = true;
}

export interface Devdb {
  base: string;
  container: StartedTestContainer;
  mappedPort(containerPort: number): number;
  stop(): Promise<void>;
}

export async function startDevdb(env: Record<string, string> = {}): Promise<Devdb> {
  await buildImage();
  const endpointPorts = Array.from({ length: 10 }, (_, i) => 54300 + i);
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ DEVDB_PORT_RANGE: "54300-54309", ...env })
    .withExposedPorts(4400, ...endpointPorts)
    .withWaitStrategy(Wait.forHttp("/api/status", 4400).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();
  const base = `http://localhost:${container.getMappedPort(4400)}`;
  return {
    base,
    container,
    mappedPort: (p) => container.getMappedPort(p),
    stop: async () => { await container.stop({ timeout: 30_000 }); },
  };
}
```

`tests/integration/boot.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("boot", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("reports all engine components running", async () => {
    const res = await fetch(`${dev.base}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    for (const name of ["storcon_db", "storage_broker", "storage_controller", "safekeeper", "pageserver"]) {
      expect(body.engine[name].state, name).toBe("running");
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm install && pnpm --filter @devdb/integration test`
Expected: FAIL — container never becomes healthy (daemon `index.ts` is still a stub), wait strategy times out.

- [ ] **Step 3: Implement EngineRuntime**

`packages/daemon/src/engine/boot.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import { ManagedProcess } from "./process.js";
import { EmbeddedPostgres } from "./embedded-postgres.js";
import {
  brokerSpec, engineDirs, pageserverIdentityToml, pageserverMetadataJson,
  pageserverSpec, pageserverToml, safekeeperRegistrationBody, safekeeperSpec, storconSpec,
} from "./configs.js";

export class EngineRuntime {
  private storconDb: EmbeddedPostgres;
  private procs = new Map<string, ManagedProcess>();
  storconDbUri: string;

  constructor(private cfg: DevdbConfig, private state: StateDb) {
    let pw = state.settings.get("storcon_db_password");
    if (!pw) {
      pw = randomBytes(24).toString("hex");
      state.settings.set("storcon_db_password", pw);
    }
    this.storconDb = new EmbeddedPostgres({
      name: "storcon_db",
      dataDir: engineDirs(cfg).storconDbDir,
      pgInstallDir: cfg.pgInstallDir,
      port: cfg.engine.storconDbPort,
      password: pw,
    });
    this.storconDbUri = this.storconDb.connectionUri();
  }

  private async launch(spec: { name: string; bin: string; args: string[]; readyNeedle: string }): Promise<void> {
    const proc = new ManagedProcess({ ...spec, readyTimeoutMs: 120_000 });
    this.procs.set(spec.name, proc);
    await proc.start();
  }

  // oracle: startup order src/daemon/mod.rs:182-232
  async start(): Promise<void> {
    const dirs = engineDirs(this.cfg);
    await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));

    await this.storconDb.init();
    await this.storconDb.start();

    await this.launch(brokerSpec(this.cfg));
    await this.launch(storconSpec(this.cfg, this.storconDbUri));

    await this.launch(safekeeperSpec(this.cfg));
    await this.registerSafekeeper();

    await writeFile(join(dirs.pageserverDir, "identity.toml"), pageserverIdentityToml());
    await writeFile(join(dirs.pageserverDir, "pageserver.toml"), pageserverToml(this.cfg));
    await writeFile(join(dirs.pageserverDir, "metadata.json"), pageserverMetadataJson(this.cfg));
    await this.launch(pageserverSpec(this.cfg));
  }

  // oracle: src/daemon/mod.rs:247-281 (no bearer — trust mode)
  private async registerSafekeeper(): Promise<void> {
    const url = `http://127.0.0.1:${this.cfg.engine.storconPort}/control/v1/safekeeper/1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(safekeeperRegistrationBody(this.cfg, new Date().toISOString())),
    });
    if (!res.ok) {
      throw new Error(`safekeeper registration failed: ${res.status} ${await res.text()}`);
    }
  }

  // oracle: shutdown order src/daemon/mod.rs:235-244
  async stop(): Promise<void> {
    for (const name of ["pageserver", "safekeeper", "storage_controller", "storage_broker"]) {
      await this.procs.get(name)?.stop();
    }
    await this.storconDb.stop();
  }

  status(): Record<string, { state: string; pid: number | null }> {
    const out: Record<string, { state: string; pid: number | null }> = {};
    out.storcon_db = { state: "running", pid: null };
    for (const [name, proc] of this.procs) {
      out[name] = { state: proc.state, pid: proc.pid };
    }
    return out;
  }
}
```

`packages/daemon/src/http/api.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/api/status", async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    return { version: "0.1.0", healthy, engine };
  });

  return app;
}
```

`packages/daemon/src/index.ts` (replace):
```ts
import { open } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openState } from "./state/db.js";
import { EngineRuntime } from "./engine/boot.js";
import { buildServer } from "./http/api.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });

  // oracle: src/daemon/lease/mod.rs — exclusive-create lockfile
  const lockPath = join(cfg.dataDir, ".lock");
  try {
    const fh = await open(lockPath, "wx");
    await fh.close();
  } catch {
    console.error(`lockfile ${lockPath} exists — another devdb owns this data dir, or it crashed. Remove the file if you are sure no other instance runs.`);
    process.exit(1);
  }

  const state = openState(join(cfg.dataDir, "state.db"));
  const engine = new EngineRuntime(cfg, state);
  await engine.start();

  const app = buildServer({ cfg, state, engine });
  await app.listen({ host: "0.0.0.0", port: cfg.httpPort });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await engine.stop();
    const { rm } = await import("node:fs/promises");
    await rm(lockPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note: `/api/status` binds `0.0.0.0` **inside the container**; only published ports reach the host (compose maps 4400 to localhost).

- [ ] **Step 4: Run unit tests, rebuild image, run the integration test**

Run: `pnpm --filter @devdb/daemon test && pnpm --filter @devdb/integration test`
Expected: PASS. If a component refuses to start, read its output in the failure message (ManagedProcess includes last 20 lines). Known risk to check here: storcon in trust mode (Task 7 note) and `vanilla_v17` presence (Task 2/6). Fix forward per those notes before proceeding — this task gates everything after it.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: engine boot orchestration, status endpoint, container integration harness"
```

---

### Task 9: Engine HTTP clients (storcon, pageserver, safekeeper)

> **AMENDED (A14, post-review):** beyond the blocks below — client methods validate 32-hex engine ids via `assertEngineId` before any request; 2xx JSON parsing goes through `parseJson(operation, res)` so malformed engine responses surface as `EngineApiError` with context; the stub-server test suite resets shared state in `beforeEach` and pins every allowlist branch. See commit 191b271.

**Files:**
- Create: `packages/daemon/src/engine/http.ts`, `packages/daemon/src/engine/storcon-client.ts`, `packages/daemon/src/engine/pageserver-client.ts`, `packages/daemon/src/engine/safekeeper-client.ts`, `packages/daemon/src/engine/ids.ts`
- Test: `packages/daemon/test/engine-clients.test.ts`

**Interfaces:**
- Consumes: `DevdbConfig` (Task 3).
- Produces (used by Tasks 12-15):
  - `ids.ts`: `newHexId(): string` (32-char lowercase hex), `uuidToHex(uuid: string): string`
  - `class StorconClient(base = "http://127.0.0.1:1234")`: `tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void>` (expects 201), `getLsnByTimestamp(tenantId, timelineId, isoTimestamp): Promise<{ lsn: string; kind: string }>`
  - `class PageserverClient(base = "http://127.0.0.1:9898")`: `timelineCreate(tenantId, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson>`, `timelineInfo(tenantId, timelineId): Promise<TimelineInfoJson>`, `timelineDelete(tenantId, timelineId): Promise<void>`, `timelineDetachAncestor(tenantId, timelineId): Promise<{ reparented_timelines: string[] }>`, `tenantDelete(tenantId): Promise<void>`
  - `class SafekeeperClient(base = "http://127.0.0.1:7676")`: `timelineDelete(tenantId, timelineId): Promise<void>`, `tenantDelete(tenantId): Promise<void>`
  - `TimelineInfoJson = { timeline_id: string; ancestor_timeline_id?: string | null; ancestor_lsn?: string | null; last_record_lsn?: string | null; current_logical_size?: number | null }` (tolerant — extra fields ignored)
  - `EngineApiError extends Error { status: number; body: string; operation: string }`

- [ ] **Step 1: Write the failing tests** (local `node:http` stub server; asserts method, path, query, body, and error surfacing)

`packages/daemon/test/engine-clients.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { StorconClient } from "../src/engine/storcon-client.js";
import { PageserverClient } from "../src/engine/pageserver-client.js";
import { SafekeeperClient } from "../src/engine/safekeeper-client.js";
import { newHexId, uuidToHex } from "../src/engine/ids.js";

interface Seen { method: string; url: string; body: string }
let server: http.Server;
let base: string;
let seen: Seen[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method!, url: req.url!, body });
    res.writeHead(nextResponse.status, { "content-type": "application/json" });
    res.end(nextResponse.body);
  });
  server.listen(0);
  await once(server, "listening");
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

describe("ids", () => {
  it("newHexId is 32 hex chars", () => expect(newHexId()).toMatch(/^[0-9a-f]{32}$/));
  it("uuidToHex strips dashes", () =>
    expect(uuidToHex("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567e89b12d3a456426614174000"));
});

describe("StorconClient", () => {
  it("tenantCreate POSTs oracle payload to /v1/tenant and accepts 201", async () => {
    seen = []; nextResponse = { status: 201, body: "{}" };
    const c = new StorconClient(base);
    await c.tenantCreate("a".repeat(32), {
      gc_period: "1h", gc_horizon: 67108864, pitr_interval: "7 days",
      checkpoint_distance: 268435456, checkpoint_timeout: "5m",
    });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/tenant" });
    const body = JSON.parse(seen[0]!.body);
    expect(body.new_tenant_id).toBe("a".repeat(32));
    expect(body.config.gc_horizon).toBe(67108864);
  });

  it("getLsnByTimestamp GETs with timestamp query", async () => {
    seen = []; nextResponse = { status: 200, body: JSON.stringify({ lsn: "0/1A2B3C", kind: "present" }) };
    const c = new StorconClient(base);
    const out = await c.getLsnByTimestamp("a".repeat(32), "b".repeat(32), "2026-07-02T10:00:00.000Z");
    expect(out).toEqual({ lsn: "0/1A2B3C", kind: "present" });
    expect(seen[0]!.url).toBe(
      `/v1/tenant/${"a".repeat(32)}/timeline/${"b".repeat(32)}/get_lsn_by_timestamp?timestamp=2026-07-02T10%3A00%3A00.000Z`,
    );
  });

  it("surfaces engine errors with status and body", async () => {
    nextResponse = { status: 400, body: '{"msg":"bad lsn"}' };
    const c = new StorconClient(base);
    await expect(c.getLsnByTimestamp("a".repeat(32), "b".repeat(32), "x")).rejects.toMatchObject({
      status: 400, operation: "get_lsn_by_timestamp",
    });
  });
});

describe("PageserverClient", () => {
  it("timelineCreate POSTs to /v1/tenant/{t}/timeline", async () => {
    seen = []; nextResponse = { status: 201, body: JSON.stringify({ timeline_id: "c".repeat(32) }) };
    const c = new PageserverClient(base);
    await c.timelineCreate("a".repeat(32), {
      new_timeline_id: "c".repeat(32), ancestor_timeline_id: "b".repeat(32), read_only: false,
    });
    expect(seen[0]).toMatchObject({ method: "POST", url: `/v1/tenant/${"a".repeat(32)}/timeline` });
    expect(JSON.parse(seen[0]!.body).ancestor_timeline_id).toBe("b".repeat(32));
  });

  it("timelineDetachAncestor PUTs and parses reparented list", async () => {
    seen = []; nextResponse = { status: 200, body: JSON.stringify({ reparented_timelines: ["d".repeat(32)] }) };
    const c = new PageserverClient(base);
    const out = await c.timelineDetachAncestor("a".repeat(32), "c".repeat(32));
    expect(out.reparented_timelines).toEqual(["d".repeat(32)]);
    expect(seen[0]).toMatchObject({
      method: "PUT", url: `/v1/tenant/${"a".repeat(32)}/timeline/${"c".repeat(32)}/detach_ancestor`,
    });
  });

  it("timelineDelete DELETEs and tolerates 202/404", async () => {
    seen = []; nextResponse = { status: 202, body: "{}" };
    const c = new PageserverClient(base);
    await c.timelineDelete("a".repeat(32), "c".repeat(32));
    nextResponse = { status: 404, body: "{}" };
    await c.timelineDelete("a".repeat(32), "c".repeat(32));
    expect(seen).toHaveLength(2);
  });
});

describe("SafekeeperClient", () => {
  it("timelineDelete DELETEs /v1/tenant/{t}/timeline/{tl}", async () => {
    seen = []; nextResponse = { status: 200, body: "{}" };
    const c = new SafekeeperClient(base);
    await c.timelineDelete("a".repeat(32), "b".repeat(32));
    expect(seen[0]).toMatchObject({
      method: "DELETE", url: `/v1/tenant/${"a".repeat(32)}/timeline/${"b".repeat(32)}`,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test engine-clients`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/engine/ids.ts`:
```ts
import { randomUUID } from "node:crypto";

export function newHexId(): string {
  return randomUUID().replaceAll("-", "");
}
export function uuidToHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}
```

`packages/daemon/src/engine/http.ts`:
```ts
export class EngineApiError extends Error {
  constructor(
    public operation: string,
    public status: number,
    public body: string,
  ) {
    super(`${operation}: engine returned ${status}: ${body}`);
  }
}

export async function engineFetch(
  operation: string,
  url: string,
  init: RequestInit = {},
  okStatuses: number[] = [200, 201, 202],
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  } catch (e) {
    throw new EngineApiError(operation, 0, String(e));
  }
  if (!okStatuses.includes(res.status)) {
    throw new EngineApiError(operation, res.status, await res.text());
  }
  return res;
}
```

`packages/daemon/src/engine/storcon-client.ts`:
```ts
import { engineFetch } from "./http.js";

export interface TenantConfigJson {
  gc_period: string; gc_horizon: number; pitr_interval: string;
  checkpoint_distance: number; checkpoint_timeout: string;
}

export class StorconClient {
  constructor(private base = "http://127.0.0.1:1234") {}

  // oracle: src/mgmt/service/project.rs:95-123 — POST /v1/tenant, expect 201.
  // VERIFY on first live run: duration/byte field encodings (humantime strings vs numbers);
  // authoritative shape: neon submodule libs/pageserver_api/src/models.rs TenantCreateRequest/TenantConfig.
  async tenantCreate(tenantId: string, config: TenantConfigJson): Promise<void> {
    await engineFetch("tenant_create", `${this.base}/v1/tenant`, {
      method: "POST",
      body: JSON.stringify({
        new_tenant_id: tenantId,
        generation: null,
        placement_policy: null,
        config,
      }),
    }, [201]);
  }

  // oracle: src/mgmt/service/branch.rs:570-599 — storcon proxies this pageserver route.
  async getLsnByTimestamp(tenantId: string, timelineId: string, isoTimestamp: string): Promise<{ lsn: string; kind: string }> {
    const url = `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}/get_lsn_by_timestamp?timestamp=${encodeURIComponent(isoTimestamp)}`;
    const res = await engineFetch("get_lsn_by_timestamp", url, {}, [200]);
    return (await res.json()) as { lsn: string; kind: string };
  }
}
```

`packages/daemon/src/engine/pageserver-client.ts`:
```ts
import { engineFetch } from "./http.js";

export interface TimelineInfoJson {
  timeline_id: string;
  ancestor_timeline_id?: string | null;
  ancestor_lsn?: string | null;
  last_record_lsn?: string | null;
  current_logical_size?: number | null;
}

export class PageserverClient {
  constructor(private base = "http://127.0.0.1:9898") {}

  private tl(tenantId: string, timelineId: string): string {
    return `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}`;
  }

  // oracle: src/mgmt/service/branch.rs:141-152 (create), 675-701 (create at LSN).
  // Body is TimelineCreateRequest with the mode variant's fields flattened
  // (branch: ancestor_timeline_id [+ ancestor_start_lsn]; bootstrap: pg_version).
  async timelineCreate(tenantId: string, req: { new_timeline_id: string } & Record<string, unknown>): Promise<TimelineInfoJson> {
    const res = await engineFetch("timeline_create", `${this.base}/v1/tenant/${tenantId}/timeline`, {
      method: "POST", body: JSON.stringify(req),
    }, [200, 201]);
    return (await res.json()) as TimelineInfoJson;
  }

  // oracle: src/mgmt/service/branch.rs:251-260 timeline_info(ForceAwaitLogicalSize::No)
  async timelineInfo(tenantId: string, timelineId: string): Promise<TimelineInfoJson> {
    const res = await engineFetch("timeline_info", this.tl(tenantId, timelineId), {}, [200]);
    return (await res.json()) as TimelineInfoJson;
  }

  // oracle: src/mgmt/service/branch.rs:487. Deletion is async on the engine side (202).
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    await engineFetch("timeline_delete", this.tl(tenantId, timelineId), { method: "DELETE" }, [200, 202, 404]);
  }

  // oracle: src/mgmt/service/branch.rs:703-736
  async timelineDetachAncestor(tenantId: string, timelineId: string): Promise<{ reparented_timelines: string[] }> {
    const res = await engineFetch(
      "timeline_detach_ancestor",
      `${this.tl(tenantId, timelineId)}/detach_ancestor`,
      { method: "PUT" },
      [200],
    );
    return (await res.json()) as { reparented_timelines: string[] };
  }

  // oracle: src/mgmt/service/project.rs:375
  async tenantDelete(tenantId: string): Promise<void> {
    await engineFetch("tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 202, 404]);
  }
}
```

`packages/daemon/src/engine/safekeeper-client.ts`:
```ts
import { engineFetch } from "./http.js";

export class SafekeeperClient {
  constructor(private base = "http://127.0.0.1:7676") {}

  // oracle: src/mgmt/service/branch.rs:722-731 safekeeper_client.delete_timeline
  async timelineDelete(tenantId: string, timelineId: string): Promise<void> {
    await engineFetch("sk_timeline_delete", `${this.base}/v1/tenant/${tenantId}/timeline/${timelineId}`, { method: "DELETE" }, [200, 404]);
  }

  // oracle: src/mgmt/service/project.rs:393 safekeeper_client.delete_tenant
  async tenantDelete(tenantId: string): Promise<void> {
    await engineFetch("sk_tenant_delete", `${this.base}/v1/tenant/${tenantId}`, { method: "DELETE" }, [200, 404]);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test engine-clients`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: typed engine http clients (storcon, pageserver, safekeeper)"
```

---

### Task 10: Compute config generation (SCRAM, postgresql.conf, pg_hba, ComputeSpec JSON)

> **AMENDED (A15, post-review):** beyond the blocks below — pg_hba's IPv6 loopback row is `::1/128` (the oracle's `::1/32` is an upstream bug: far broader than loopback — documented internally in docs/notes/2026-07-02-neond-pg-hba-ipv6-loopback.md; do not report upstream, per policy); `hba_file` is GUC-quoted via `pgQuote`; `computeConfigJson` validates both ids with `assertEngineId`; tests pin `pageserver_connection_info` exactly and cover SCRAM salt freshness + custom iterations. T11 live-run watchpoint: `format_version` serializes as JSON `1` (JS int/float) — expected fine for the Rust deserializer, confirm. See commit 9a17afd.

**Files:**
- Create: `packages/daemon/src/compute/scram.ts`, `packages/daemon/src/compute/pgconf.ts`, `packages/daemon/src/compute/spec.ts`, `packages/daemon/src/compute/password.ts`
- Test: `packages/daemon/test/compute-config.test.ts`

**Interfaces:**
- Consumes: `DevdbConfig` (Task 3), `BranchRow`/`ProjectRow` (Task 4).
- Produces (used by Task 11):
  - `scramSha256Verifier(password: string, salt?: Buffer, iterations = 4096): string` → `SCRAM-SHA-256$4096:<saltB64>$<storedKeyB64>:<serverKeyB64>`
  - `generatePassword(length = 32): string` (alphanumeric — oracle: `src/utils/password.rs`)
  - `computePostgresqlConf(a: { port: number; hbaPath: string }): string`
  - `PG_HBA: string`
  - `computeConfigJson(a: { tenantIdHex: string; timelineIdHex: string; port: number; hbaPath: string; password: string }): string` (full ComputeConfig document for `compute_ctl --config`)

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/compute-config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { scramSha256Verifier, generatePassword } from "../src/compute/scram.js";
import { computePostgresqlConf, PG_HBA } from "../src/compute/pgconf.js";
import { computeConfigJson } from "../src/compute/spec.js";

describe("scram", () => {
  it("produces a valid RFC 5803 verifier", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8");
    const v = scramSha256Verifier("secret", salt);
    const m = v.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
    expect(m).not.toBeNull();
    const [, iter, saltB64, storedB64, serverB64] = m!;
    expect(Number(iter)).toBe(4096);
    expect(Buffer.from(saltB64!, "base64")).toEqual(salt);
    const salted = pbkdf2Sync("secret", salt, 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    expect(Buffer.from(storedB64!, "base64")).toEqual(createHash("sha256").update(clientKey).digest());
    expect(Buffer.from(serverB64!, "base64")).toEqual(createHmac("sha256", salted).update("Server Key").digest());
  });
  it("generatePassword is 32 alphanumerics", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});

describe("postgresql.conf", () => {
  it("carries the oracle settings minus TLS", () => {
    const conf = computePostgresqlConf({ port: 54321, hbaPath: "/x/pg_hba.conf" });
    for (const line of [
      "shared_buffers=128MB", "fsync=off", "wal_level=logical",
      "listen_addresses=0.0.0.0", "port=54321", "shared_preload_libraries=neon",
      "synchronous_standby_names=walproposer", "neon.safekeepers=localhost:5454",
      "password_encryption=scram-sha-256", "hba_file=/x/pg_hba.conf",
    ]) expect(conf, line).toContain(line);
    expect(conf).not.toContain("ssl=on");
    expect(conf).not.toContain("ssl_cert_file");
  });
  it("pg_hba keeps scram for remote, trust for local cloud_admin, no hostssl", () => {
    expect(PG_HBA).toContain("local   all       cloud_admin                 trust");
    expect(PG_HBA).toContain("host    all       all           all           scram-sha-256");
    expect(PG_HBA).toContain("::1/128"); // not upstream's ::1/32 — that's a prefix, not loopback
    expect(PG_HBA).not.toContain("hostssl");
  });
});

describe("compute config json", () => {
  it("matches the oracle ComputeSpec shape (trust mode)", () => {
    const doc = JSON.parse(computeConfigJson({
      tenantIdHex: "a".repeat(32), timelineIdHex: "b".repeat(32),
      port: 54321, hbaPath: "/x/pg_hba.conf", password: "pw",
    }));
    const spec = doc.spec;
    expect(spec.format_version).toBe(1.0);
    expect(spec.cluster.roles[0].name).toBe("postgres");
    expect(spec.cluster.roles[0].encrypted_password).toMatch(/^SCRAM-SHA-256\$/);
    expect(spec.cluster.databases[0]).toMatchObject({ name: "postgres", owner: "postgres" });
    expect(spec.tenant_id).toBe("a".repeat(32));
    expect(spec.timeline_id).toBe("b".repeat(32));
    expect(spec.pageserver_connstring).toBe("postgres://cloud_admin@127.0.0.1:64000");
    expect(spec.safekeeper_connstrings).toEqual(["127.0.0.1:5454"]);
    expect(spec.mode).toBe("Primary");
    expect(spec.endpoint_id).toBe(`compute-${"b".repeat(32)}`);
    expect(spec.suspend_timeout_seconds).toBe(-1);
    expect(spec.storage_auth_token).toBeUndefined();
    expect(doc.compute_ctl_config).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test compute-config`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/compute/scram.ts`:
```ts
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

// oracle: postgres_protocol::password::scram_sha_256 (used at src/mgmt/compute/mod.rs:580)
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// oracle: src/utils/password.rs — 32 alphanumerics
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function generatePassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CHARSET[randomInt(CHARSET.length)];
  return out;
}
```

Re-export from `packages/daemon/src/compute/password.ts`:
```ts
export { generatePassword } from "./scram.js";
```

`packages/daemon/src/compute/pgconf.ts`:
```ts
// oracle: src/mgmt/compute/mod.rs:737-809 setup_pg_conf. Deviations: no ssl block, no cert files.
export function computePostgresqlConf(a: { port: number; hbaPath: string }): string {
  const kv: Array<[string, string]> = [
    ["max_wal_senders", "10"], ["wal_log_hints", "off"], ["max_replication_slots", "10"],
    ["hot_standby", "on"],
    ["shared_buffers", "128MB"], ["effective_cache_size", "512MB"], ["work_mem", "8MB"],
    ["maintenance_work_mem", "128MB"], ["max_connections", "100"],
    ["effective_io_concurrency", "100"], ["random_page_cost", "1.1"],
    ["fsync", "off"], ["synchronous_commit", "on"],
    ["wal_level", "logical"], ["wal_sender_timeout", "60s"], ["wal_keep_size", "0"],
    ["restart_after_crash", "off"],
    ["listen_addresses", "0.0.0.0"], ["port", String(a.port)],
    ["shared_preload_libraries", "neon"],
    ["jit", "off"],
    ["statement_timeout", "0"], ["idle_in_transaction_session_timeout", "600000"],
    ["autovacuum_max_workers", "4"], ["autovacuum_naptime", "10s"],
    ["autovacuum_vacuum_scale_factor", "0.05"], ["autovacuum_analyze_scale_factor", "0.02"],
    ["autovacuum_vacuum_cost_limit", "2000"],
    ["log_min_duration_statement", "1000"], ["log_connections", "on"],
    ["log_disconnections", "on"], ["log_checkpoints", "on"], ["log_lock_waits", "on"],
    ["log_temp_files", "0"], ["log_autovacuum_min_duration", "1000"],
    ["log_line_prefix", "'%m [%p] %q%u@%d '"],
    ["max_replication_write_lag", "500MB"], ["max_replication_flush_lag", "10GB"],
    ["synchronous_standby_names", "walproposer"],
    ["neon.safekeepers", "localhost:5454"],
    ["password_encryption", "scram-sha-256"],
    ["hba_file", a.hbaPath],
  ];
  return kv.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// oracle: src/mgmt/compute/pg_hba.conf, hostssl lines dropped (no TLS).
// Deviation: ::1/128, not upstream's ::1/32 — /32 is a prefix (matches all of ::/32,
// incl. v4-mapped addrs), not loopback. See docs/notes/2026-07-02-neond-pg-hba-ipv6-loopback.md.
export const PG_HBA = `# TYPE  DATABASE  USER          ADDRESS       METHOD
local   all       cloud_admin                 trust
host    all       cloud_admin   127.0.0.1/32  trust
host    all       cloud_admin   ::1/128       trust
host    all       all           all           scram-sha-256
`;
```

`packages/daemon/src/compute/spec.ts`:
```ts
import { computePostgresqlConf } from "./pgconf.js";
import { scramSha256Verifier } from "./scram.js";

// oracle: src/mgmt/compute/mod.rs:820-917 generate_config.
// Deviation: storage_auth_token omitted (trust mode).
// VERIFY on first live run (Task 11 step 5): the pageserver_connection_info shards key
// ("0000") — authoritative encoding in neon submodule libs/compute_api/src/spec.rs and
// libs/pageserver_api/src/shard.rs. compute_ctl also honors legacy pageserver_connstring.
export function computeConfigJson(a: {
  tenantIdHex: string; timelineIdHex: string; port: number; hbaPath: string; password: string;
}): string {
  const spec = {
    format_version: 1.0,
    features: [],
    cluster: {
      cluster_id: null,
      name: null,
      state: null,
      roles: [{ name: "postgres", encrypted_password: scramSha256Verifier(a.password), options: null }],
      databases: [{ name: "postgres", owner: "postgres", options: null, restrict_conn: false, invalid: false }],
      postgresql_conf: computePostgresqlConf({ port: a.port, hbaPath: a.hbaPath }),
      settings: null,
    },
    delta_operations: null,
    skip_pg_catalog_updates: false,
    tenant_id: a.tenantIdHex,
    timeline_id: a.timelineIdHex,
    pageserver_connection_info: {
      shard_count: 0,
      stripe_size: null,
      shards: {
        "0000": {
          pageservers: [{ id: 1, libpq_url: "postgres://cloud_admin@127.0.0.1:64000", grpc_url: null }],
        },
      },
      prefer_protocol: "libpq",
    },
    pageserver_connstring: "postgres://cloud_admin@127.0.0.1:64000",
    endpoint_id: `compute-${a.timelineIdHex}`,
    safekeeper_connstrings: ["127.0.0.1:5454"],
    mode: "Primary",
    remote_extensions: null,
    pgbouncer_settings: null,
    reconfigure_concurrency: 1,
    drop_subscriptions_before_start: false,
    audit_log_level: "Disabled",
    suspend_timeout_seconds: -1,
  };
  return JSON.stringify({ spec, compute_ctl_config: {} }, null, 2);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test compute-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: compute scram/pgconf/spec generation"
```

---

### Task 11: ComputeManager (compute_ctl lifecycle + port allocation)

> **AMENDED (A16, post-review):** beyond the blocks below — `start()` reserves the branch's map slot synchronously (closing the double-start TOCTOU) and all cleanup is identity-aware; the whole setup path after reservation is failure-cleaned (ports released, dir removed); a manager-held reservation Set feeds `allocatePort(range, preferred?, exclude?)` so concurrent starts and metrics/endpoint ranges can't collide; `stop()` exposes a real `"stopping"` status and cleans up in `finally`; onLine fanout snapshots listeners with per-callback catch. Launch contract pinned by mock-level manager.test.ts. See commit ee7e382.

> **AMENDED (A20, live):** the launch args in the block below (and as reviewed in A16) stop at `--external-http-port`, leaving compute_ctl's `--internal-http-port` at its default **3081** for every compute — verified via `compute_ctl --help` + `/proc/net/tcp` in a live devdb:dev container: the first compute binds 3081 and later concurrent computes collide on it. Nonfatal today (the extra computes run fine), but the internal HTTP server (remote-extension downloads for the neon extension, local_proxy config) is silently missing/misrouted for every compute after the first. `start()` now allocates a second per-compute port from the same 40000-40999 reservation-set mechanism as the metrics port and passes `--internal-http-port` explicitly; it is released on launch failure and in `stop()` exactly like the endpoint and metrics ports. manager.test.ts launch-contract assertions extended: `--internal-http-port` pinned in the byte-exact arg list, and both HTTP ports asserted in-range and distinct (from each other and from the postgres port).

**Files:**
- Create: `packages/daemon/src/compute/ports.ts`, `packages/daemon/src/compute/manager.ts`
- Test: `packages/daemon/test/ports.test.ts` (unit); live compute start is exercised in Task 14's integration test.

**Interfaces:**
- Consumes: Tasks 3-5, 10 (`DevdbConfig`, `BranchRow`, `ManagedProcess`, spec generators).
- Produces (used by Tasks 12-15):
  - `allocatePort(range: { min: number; max: number }, preferred?: number | null): Promise<number>` — bind-tests `127.0.0.1`; tries `preferred` first, then random in range, 100 attempts; throws `PortExhaustedError` (oracle: `src/mgmt/compute/mod.rs:696-736`)
  - `class ComputeManager(cfg: DevdbConfig)`:
    - `start(a: { branch: BranchRow; pgVersion: PgVersion }): Promise<{ port: number }>` — allocates port (sticky first), writes `config.json` + `pg_hba.conf` under a fresh dir in `<dataDir>/computes/`, spawns `compute_ctl`, readiness needle `"listening on IPv4 address"` (50s)
    - `stop(branchId: string): Promise<void>` (SIGTERM compute_ctl, cleanup dir)
    - `statusOf(branchId: string): EndpointStatus`, `portOf(branchId: string): number | null`, `stopAll(): Promise<void>`, `onLine(branchId, cb)` for log streaming (Task 16)
  - `class PortExhaustedError extends Error { constructor(public running: Array<{ branchId: string; port: number }>) }`

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/ports.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { allocatePort, PortExhaustedError } from "../src/compute/ports.js";

describe("allocatePort", () => {
  it("prefers the sticky port when free", async () => {
    expect(await allocatePort({ min: 56000, max: 56010 }, 56005)).toBe(56005);
  });
  it("falls back into the range when sticky is taken", async () => {
    const blocker = net.createServer().listen(56005, "127.0.0.1");
    await once(blocker, "listening");
    try {
      const p = await allocatePort({ min: 56000, max: 56010 }, 56005);
      expect(p).toBeGreaterThanOrEqual(56000);
      expect(p).toBeLessThanOrEqual(56010);
      expect(p).not.toBe(56005);
    } finally { blocker.close(); }
  });
  it("throws PortExhaustedError when range is fully occupied", async () => {
    const blockers = await Promise.all([56020, 56021].map(async (p) => {
      const s = net.createServer().listen(p, "127.0.0.1");
      await once(s, "listening");
      return s;
    }));
    try {
      await expect(allocatePort({ min: 56020, max: 56021 })).rejects.toBeInstanceOf(PortExhaustedError);
    } finally { blockers.forEach((s) => s.close()); }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test ports`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/compute/ports.ts`:
```ts
import net from "node:net";
import { randomInt } from "node:crypto";

export class PortExhaustedError extends Error {
  constructor(public running: Array<{ branchId: string; port: number }> = []) {
    super("no free port in DEVDB_PORT_RANGE — stop an endpoint or widen the range");
  }
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// oracle: src/mgmt/compute/mod.rs:696-736 (sticky preferred port, then random, 100 attempts)
export async function allocatePort(
  range: { min: number; max: number },
  preferred?: number | null,
): Promise<number> {
  if (preferred && preferred >= range.min && preferred <= range.max && (await tryBind(preferred))) {
    return preferred;
  }
  for (let i = 0; i < 100; i++) {
    const port = range.min + randomInt(range.max - range.min + 1);
    if (await tryBind(port)) return port;
  }
  throw new PortExhaustedError();
}
```

`packages/daemon/src/compute/manager.ts`:
```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EndpointStatus, PgVersion } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { BranchRow } from "../state/repos.js";
import { engineDirs } from "../engine/configs.js";
import { ManagedProcess } from "../engine/process.js";
import { computeConfigJson } from "./spec.js";
import { PG_HBA } from "./pgconf.js";
import { allocatePort } from "./ports.js";

interface RunningCompute {
  proc: ManagedProcess;
  port: number;
  dir: string;
  listeners: Array<(line: string) => void>;
}

export class ComputeManager {
  private computes = new Map<string, RunningCompute>();

  constructor(private cfg: DevdbConfig) {}

  statusOf(branchId: string): EndpointStatus {
    const c = this.computes.get(branchId);
    if (!c) return "stopped";
    return c.proc.state as EndpointStatus;
  }

  portOf(branchId: string): number | null {
    return this.computes.get(branchId)?.port ?? null;
  }

  runningPorts(): Array<{ branchId: string; port: number }> {
    return [...this.computes.entries()]
      .filter(([, c]) => c.proc.state === "running")
      .map(([branchId, c]) => ({ branchId, port: c.port }));
  }

  onLine(branchId: string, cb: (line: string) => void): () => void {
    const c = this.computes.get(branchId);
    if (!c) return () => {};
    c.listeners.push(cb);
    return () => { c.listeners = c.listeners.filter((l) => l !== cb); };
  }

  // oracle: src/mgmt/compute/mod.rs:121-289 launch()
  async start(a: { branch: BranchRow; pgVersion: PgVersion }): Promise<{ port: number }> {
    if (this.computes.get(a.branch.id)?.proc.state === "running") {
      throw new Error(`endpoint for branch ${a.branch.name} already running`);
    }
    const port = await allocatePort(this.cfg.portRange, a.branch.stickyPort);
    const computesDir = engineDirs(this.cfg).computesDir;
    await mkdir(computesDir, { recursive: true });
    const dir = await mkdtemp(join(computesDir, `compute_${a.branch.timelineId}_`));
    const hbaPath = join(dir, "pg_hba.conf");
    await writeFile(hbaPath, PG_HBA);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, computeConfigJson({
      tenantIdHex: a.branch.projectId,
      timelineIdHex: a.branch.timelineId,
      port, hbaPath,
      password: a.branch.password,
    }));
    const metricsPort = await allocatePort({ min: 40000, max: 40999 });

    const entry: RunningCompute = { port, dir, listeners: [], proc: null as unknown as ManagedProcess };
    // oracle args: src/mgmt/compute/mod.rs:189-208; readiness: :245-252 ("listening on IPv4 address", 50s)
    entry.proc = new ManagedProcess({
      name: `compute-${a.branch.slug}`,
      bin: join(this.cfg.neonBinDir, "compute_ctl"),
      args: [
        "--pgdata", join(dir, "pg_data"),
        "--pgbin", join(this.cfg.pgInstallDir, `v${a.pgVersion}`, "bin", "postgres"),
        "--compute-id", `compute-${a.branch.timelineId}`,
        "--connstr", `postgresql://cloud_admin@localhost:${port}/postgres`,
        "--config", configPath,
        "--external-http-port", String(metricsPort),
      ],
      env: {},
      readyNeedle: "listening on IPv4 address",
      readyTimeoutMs: 50_000,
      onLine: (line) => entry.listeners.forEach((cb) => cb(line)),
    });
    this.computes.set(a.branch.id, entry);
    try {
      await entry.proc.start();
    } catch (e) {
      this.computes.delete(a.branch.id);
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { port };
  }

  async stop(branchId: string): Promise<void> {
    const c = this.computes.get(branchId);
    if (!c) return;
    await c.proc.stop(30_000);
    this.computes.delete(branchId);
    await rm(c.dir, { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.computes.keys()].map((id) => this.stop(id)));
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @devdb/daemon test ports`
Expected: PASS.

- [ ] **Step 5: Live verification note**

The first real `compute_ctl` launch happens in Task 14's integration test. If it fails there, the error will name this task's spec JSON (see VERIFY comments in `spec.ts`) — resolve against the neon submodule before touching anything else.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: compute manager with compute_ctl lifecycle and port allocation"
```

---

### Task 12: Projects service + REST

> **AMENDED (A17, post-review + live engine):** the live engine resolved the tenant_create VERIFY note — config fields are FLAT on the body (nested `config` 400s); a bounded 3-attempt retry covers the ~5s post-boot storcon scheduling window (substring-gated, fail-safe); `create()` compensates the tenant on any post-create failure, wraps the two local inserts in one transaction, maps unique violations to 409, and suffixes the main slug with 6 hex of the timeline id; delete's leaves loop aborts loudly on dangling parents; ZodError maps to 400; the daemon test script now runs `tsc --noEmit -p tsconfig.test.json` (A2 conformance standing guard); integration probes pageserver in-container for real teardown. See commits 719fe20 + de2fa28.

**Files:**
- Create: `packages/daemon/src/services/errors.ts`, `packages/daemon/src/services/slug.ts`, `packages/daemon/src/services/projects.ts`
- Modify: `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/projects-service.test.ts` (unit, fake clients), `tests/integration/projects.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9, 11 (`StateDb`, engine clients, `ComputeManager`).
- Produces (used by Tasks 13-17):
  - `class DevdbError extends Error { constructor(public statusCode: number, message: string) }`
  - `slugify(...parts: string[]): string` — lowercase, `[a-z0-9-]`, parts joined with `-`
  - `class ProjectsService(deps: { state: StateDb; storcon: StorconClient; pageserver: PageserverClient; safekeeper: SafekeeperClient; computes: ComputeManager })`:
    - `create(a: { name: string; pgVersion?: PgVersion }): Promise<{ project: ProjectRow; mainBranch: BranchRow }>`
    - `list(): ProjectRow[]`, `byIdOr404(id): ProjectRow`
    - `delete(id: string): Promise<void>` — stops endpoints, deletes all branch timelines (children first), tenant on pageserver + safekeeper, then rows
  - REST: `POST /api/projects {name, pgVersion?}` → 201 `{project, mainBranch}`; `GET /api/projects`; `GET /api/projects/:id`; `DELETE /api/projects/:id` → 204
  - `buildServer` gains `deps.services: { projects: ProjectsService }`

- [ ] **Step 1: Write the failing unit test**

`packages/daemon/test/projects-service.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { ProjectsService } from "../src/services/projects.js";
import { slugify } from "../src/services/slug.js";

function fakes() {
  return {
    storcon: { tenantCreate: vi.fn(async () => {}) },
    pageserver: {
      timelineCreate: vi.fn(async () => ({ timeline_id: "x" })),
      timelineDelete: vi.fn(async () => {}),
      tenantDelete: vi.fn(async () => {}),
    },
    safekeeper: { timelineDelete: vi.fn(async () => {}), tenantDelete: vi.fn(async () => {}) },
    computes: { stop: vi.fn(async () => {}), statusOf: () => "stopped", portOf: () => null },
  };
}

describe("slugify", () => {
  it("normalizes", () => expect(slugify("Acme App", "Main!")).toBe("acme-app-main"));
});

describe("ProjectsService", () => {
  it("create makes tenant, bootstrap timeline, main branch row", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f } as never);
    const { project, mainBranch } = await svc.create({ name: "acme", pgVersion: 17 });
    expect(project.id).toMatch(/^[0-9a-f]{32}$/);
    expect(f.storcon.tenantCreate).toHaveBeenCalledWith(project.id, expect.objectContaining({ gc_horizon: 67108864 }));
    expect(f.pageserver.timelineCreate).toHaveBeenCalledWith(project.id, expect.objectContaining({ pg_version: 17 }));
    expect(mainBranch.name).toBe("main");
    expect(mainBranch.parentBranchId).toBeNull();
    expect(state.branches.byProjectAndName(project.id, "main")).not.toBeNull();
  });

  it("rejects duplicate project names with 409", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f } as never);
    await svc.create({ name: "acme" });
    await expect(svc.create({ name: "acme" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("delete removes branches (children first), timelines, tenant", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f } as never);
    const { project, mainBranch } = await svc.create({ name: "acme" });
    state.branches.create({
      id: crypto.randomUUID(), projectId: project.id, parentBranchId: mainBranch.id,
      name: "dev", slug: "acme-dev", timelineId: "c".repeat(32), password: "x", createdBy: "api",
    });
    await svc.delete(project.id);
    expect(state.projects.byId(project.id)).toBeNull();
    expect(state.branches.countAll()).toBe(0);
    // child timeline deleted before parent timeline
    const order = f.pageserver.timelineDelete.mock.calls.map((c) => c[1]);
    expect(order.indexOf("c".repeat(32))).toBeLessThan(order.indexOf(mainBranch.timelineId));
    expect(f.pageserver.tenantDelete).toHaveBeenCalledWith(project.id);
    expect(f.safekeeper.tenantDelete).toHaveBeenCalledWith(project.id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test projects-service`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/services/errors.ts`:
```ts
export class DevdbError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
```

`packages/daemon/src/services/slug.ts`:
```ts
export function slugify(...parts: string[]): string {
  return parts
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");
}
```

`packages/daemon/src/services/projects.ts`:
```ts
import { DEFAULT_PG_VERSION, type PgVersion } from "@devdb/shared";
import type { StateDb } from "../state/db.js";
import type { StorconClient } from "../engine/storcon-client.js";
import type { PageserverClient } from "../engine/pageserver-client.js";
import type { SafekeeperClient } from "../engine/safekeeper-client.js";
import type { ComputeManager } from "../compute/manager.js";
import type { BranchRow, ProjectRow } from "../state/repos.js";
import { newHexId } from "../engine/ids.js";
import { generatePassword } from "../compute/scram.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";

export interface ProjectsDeps {
  state: StateDb;
  storcon: StorconClient;
  pageserver: PageserverClient;
  safekeeper: SafekeeperClient;
  computes: ComputeManager;
}

// oracle: tenant config values src/mgmt/service/project.rs:95-108
export const TENANT_CONFIG = {
  gc_period: "1h",
  gc_horizon: 67108864,
  pitr_interval: "7 days",
  checkpoint_distance: 268435456,
  checkpoint_timeout: "5m",
};

export class ProjectsService {
  constructor(private deps: ProjectsDeps) {}

  async create(a: { name: string; pgVersion?: PgVersion }): Promise<{ project: ProjectRow; mainBranch: BranchRow }> {
    const name = a.name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,62}$/.test(name)) {
      throw new DevdbError(400, `invalid project name: ${JSON.stringify(a.name)}`);
    }
    if (this.deps.state.projects.byName(name)) {
      throw new DevdbError(409, `project "${name}" already exists`);
    }
    const pgVersion = a.pgVersion ?? DEFAULT_PG_VERSION;
    const projectId = newHexId(); // doubles as tenant id — oracle: project.rs:83-84

    await this.deps.storcon.tenantCreate(projectId, TENANT_CONFIG);

    // oracle: bootstrap mode timeline create — src/mgmt/service/branch.rs:124-128
    const timelineId = newHexId();
    await this.deps.pageserver.timelineCreate(projectId, {
      new_timeline_id: timelineId,
      pg_version: pgVersion,
    });

    const project = this.deps.state.projects.create({ id: projectId, name, pgVersion });
    const mainBranch = this.deps.state.branches.create({
      id: crypto.randomUUID(),
      projectId,
      parentBranchId: null,
      name: "main",
      slug: slugify(name, "main"),
      timelineId,
      password: generatePassword(),
      createdBy: "api",
    });
    return { project, mainBranch };
  }

  list(): ProjectRow[] {
    return this.deps.state.projects.list();
  }

  byIdOr404(id: string): ProjectRow {
    const p = this.deps.state.projects.byId(id);
    if (!p) throw new DevdbError(404, `project ${id} not found`);
    return p;
  }

  async delete(id: string): Promise<void> {
    const project = this.byIdOr404(id);
    const branches = this.deps.state.branches.listByProject(project.id);
    // children before parents: repeatedly remove leaves
    const remaining = new Map(branches.map((b) => [b.id, b]));
    while (remaining.size > 0) {
      const leaves = [...remaining.values()].filter(
        (b) => ![...remaining.values()].some((o) => o.parentBranchId === b.id),
      );
      for (const leaf of leaves) {
        await this.deps.computes.stop(leaf.id);
        await this.deps.pageserver.timelineDelete(project.id, leaf.timelineId);
        await this.deps.safekeeper.timelineDelete(project.id, leaf.timelineId);
        this.deps.state.branches.delete(leaf.id);
        remaining.delete(leaf.id);
      }
    }
    // oracle: src/mgmt/service/project.rs:351-395
    await this.deps.pageserver.tenantDelete(project.id);
    await this.deps.safekeeper.tenantDelete(project.id);
    this.deps.state.projects.delete(project.id);
  }
}
```

Extend `packages/daemon/src/http/api.ts` — add to `Deps` and register routes (replace file):
```ts
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { PgVersionSchema } from "@devdb/shared";
import type { DevdbConfig } from "../config.js";
import type { StateDb } from "../state/db.js";
import type { EngineRuntime } from "../engine/boot.js";
import type { ProjectsService } from "../services/projects.js";
import { DevdbError } from "../services/errors.js";

export interface Deps {
  cfg: DevdbConfig;
  state: StateDb;
  engine: EngineRuntime;
  services: { projects: ProjectsService };
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DevdbError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: err.message });
  });

  app.get("/api/status", async () => {
    const engine = deps.engine.status();
    const healthy = Object.values(engine).every((p) => p.state === "running");
    return { version: "0.1.0", healthy, engine };
  });

  const CreateProject = z.object({ name: z.string(), pgVersion: PgVersionSchema.optional() });
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProject.parse(req.body);
    const out = await deps.services.projects.create(body);
    return reply.status(201).send(out);
  });
  app.get("/api/projects", async () => deps.services.projects.list());
  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.projects.byIdOr404(id);
  });
  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.services.projects.delete(id);
    return reply.status(204).send();
  });

  return app;
}
```

Update `packages/daemon/src/index.ts` main to construct clients/services (insert after `await engine.start();`):
```ts
  const { StorconClient } = await import("./engine/storcon-client.js");
  const { PageserverClient } = await import("./engine/pageserver-client.js");
  const { SafekeeperClient } = await import("./engine/safekeeper-client.js");
  const { ComputeManager } = await import("./compute/manager.js");
  const { ProjectsService } = await import("./services/projects.js");

  const storcon = new StorconClient();
  const pageserver = new PageserverClient();
  const safekeeper = new SafekeeperClient();
  const computes = new ComputeManager(cfg);
  const projects = new ProjectsService({ state, storcon, pageserver, safekeeper, computes });

  const app = buildServer({ cfg, state, engine, services: { projects } });
```
and in `shutdown()` stop computes before the engine: `await computes.stopAll();` before `await engine.stop();`.

- [ ] **Step 4: Run unit tests**

Run: `pnpm --filter @devdb/daemon test`
Expected: PASS.

- [ ] **Step 5: Write and run the integration test**

`tests/integration/projects.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("projects", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("creates a project with a main branch and deletes it", async () => {
    const res = await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme" }),
    });
    expect(res.status).toBe(201);
    const { project, mainBranch } = await res.json();
    expect(mainBranch.name).toBe("main");

    const del = await fetch(`${dev.base}/api/projects/${project.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const list = await (await fetch(`${dev.base}/api/projects`)).json();
    expect(list).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @devdb/integration test projects`
Expected: PASS. **If `tenant_create` or `timeline_create` return 4xx, the JSON encodings (duration strings, flattened mode) need pinning against the neon submodule — fix in `storcon-client.ts`/`pageserver-client.ts`, document the corrected shape in the oracle comments.**

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: projects service and REST with tenant + main branch bootstrap"
```

---

### Task 13: Branch service + REST (create/list/get/delete + connection strings)

> **AMENDED (A18, post-review):** beyond the blocks below — `create()` trims names, serializes under the PARENT's queue key (re-checking parent existence + name uniqueness inside the queue; closes the create-vs-parent-delete race) and compensates the engine timeline on local-insert failure (unique → 409), mirroring the projects pattern; `detail()` enrichment only swallows `EngineApiError` (logged) — programming errors surface; `connectionString` percent-encodes the password (A11); api.ts's generic error branch respects 4xx/5xx `err.statusCode`; index.ts stops computes+engine on post-start boot failures before releasing the lock; four branch routes have inject tests. Integration helpers live in tests/integration/helpers/pg.ts (A1). See commits 04a1787 + a31aa70.

**Files:**
- Create: `packages/daemon/src/services/branches.ts`
- Modify: `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/branches-service.test.ts` (unit), `tests/integration/branching.test.ts` (the money test — needs Task 14's endpoint start; write it here, run it fully in Task 14 Step 5)

**Interfaces:**
- Consumes: Tasks 4, 9, 11, 12.
- Produces (used by Tasks 14-17 + Phase 2 MCP):
  - `class BranchesService(deps: ProjectsDeps & { queue: BranchQueue })`:
    - `create(a: { projectId: string; name: string; parentBranchId?: string | null; atLsn?: string | null; createdBy?: "ui"|"api"|"mcp" }): Promise<BranchRow>` — parent defaults to the project's `main`... **no:** parent default = `null` means branch from `main`? **Exact rule: `parentBranchId` omitted → parent is the project's `main` branch; explicitly `null` is invalid (root branches only exist via project create).**
    - `list(projectId: string): Promise<BranchDetail[]>`, `byIdOr404(id): BranchRow`, `detail(branch: BranchRow): Promise<BranchDetail>`
    - `delete(id: string): Promise<void>` — 409 if children exist (names them), stops endpoint, deletes timeline on pageserver + safekeeper
    - `connectionString(branch: BranchRow, port: number): string` → `postgresql://postgres:<password>@localhost:<port>/postgres`
    - `type BranchDetail = BranchRow & { endpointStatus: EndpointStatus; port: number | null; connectionString: string | null; lastRecordLsn: string | null; logicalSizeBytes: number | null; ancestorLsn: string | null }`
  - REST: `GET|POST /api/projects/:id/branches`, `GET /api/branches/:id`, `DELETE /api/branches/:id`

- [ ] **Step 1: Write the failing unit tests**

`packages/daemon/test/branches-service.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { BranchesService } from "../src/services/branches.js";
import { ProjectsService } from "../src/services/projects.js";

function fakes() {
  return {
    storcon: { tenantCreate: vi.fn(async () => {}) },
    pageserver: {
      timelineCreate: vi.fn(async () => ({ timeline_id: "x" })),
      timelineInfo: vi.fn(async () => ({
        timeline_id: "x", ancestor_timeline_id: null, ancestor_lsn: "0/1",
        last_record_lsn: "0/2", current_logical_size: 1234,
      })),
      timelineDelete: vi.fn(async () => {}),
      tenantDelete: vi.fn(async () => {}),
    },
    safekeeper: { timelineDelete: vi.fn(async () => {}), tenantDelete: vi.fn(async () => {}) },
    computes: {
      stop: vi.fn(async () => {}), statusOf: vi.fn(() => "stopped"), portOf: vi.fn(() => null),
    },
  };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  const projects = new ProjectsService({ state, ...f } as never);
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const branches = new BranchesService({ state, queue: new BranchQueue(), ...f } as never);
  return { f, state, project, mainBranch, branches };
}

describe("BranchesService", () => {
  it("create defaults parent to main and calls timeline_create with ancestor", async () => {
    const { f, project, mainBranch, branches } = await seeded();
    const b = await branches.create({ projectId: project.id, name: "agent/fix-auth" });
    expect(b.parentBranchId).toBe(mainBranch.id);
    expect(f.pageserver.timelineCreate).toHaveBeenLastCalledWith(project.id, expect.objectContaining({
      ancestor_timeline_id: mainBranch.timelineId,
      read_only: false,
    }));
    const last = f.pageserver.timelineCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last.ancestor_start_lsn).toBeUndefined();
  });

  it("passes ancestor_start_lsn for branch-at-point", async () => {
    const { f, project, branches } = await seeded();
    await branches.create({ projectId: project.id, name: "pitr", atLsn: "0/1A2B3C" });
    const req = f.pageserver.timelineCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(req.ancestor_start_lsn).toBe("0/1A2B3C");
  });

  it("rejects duplicate names within a project", async () => {
    const { project, branches } = await seeded();
    await branches.create({ projectId: project.id, name: "dev" });
    await expect(branches.create({ projectId: project.id, name: "dev" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("delete blocks when children exist and names them", async () => {
    const { project, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await branches.create({ projectId: project.id, name: "dev-child", parentBranchId: dev.id });
    await expect(branches.delete(dev.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(branches.delete(dev.id)).rejects.toThrow(/dev-child/);
  });

  it("delete removes timeline on pageserver and safekeeper", async () => {
    const { f, project, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await branches.delete(dev.id);
    expect(f.pageserver.timelineDelete).toHaveBeenCalledWith(project.id, dev.timelineId);
    expect(f.safekeeper.timelineDelete).toHaveBeenCalledWith(project.id, dev.timelineId);
  });

  it("connectionString shape", async () => {
    const { branches, mainBranch } = await seeded();
    expect(branches.connectionString(mainBranch, 54301))
      .toBe(`postgresql://postgres:${mainBranch.password}@localhost:54301/postgres`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test branches-service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/services/branches.ts`:
```ts
import type { EndpointStatus } from "@devdb/shared";
import type { BranchRow } from "../state/repos.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { generatePassword } from "../compute/scram.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";
import type { ProjectsDeps } from "./projects.js";

export type BranchDetail = BranchRow & {
  endpointStatus: EndpointStatus;
  port: number | null;
  connectionString: string | null;
  lastRecordLsn: string | null;
  logicalSizeBytes: number | null;
  ancestorLsn: string | null;
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 /._-]{0,62}$/;

export class BranchesService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue }) {}

  byIdOr404(id: string): BranchRow {
    const b = this.deps.state.branches.byId(id);
    if (!b) throw new DevdbError(404, `branch ${id} not found`);
    return b;
  }

  connectionString(branch: BranchRow, port: number): string {
    // oracle: src/mgmt/model/branch.rs get_connection_string; no sslmode (no TLS in devdb)
    return `postgresql://postgres:${branch.password}@localhost:${port}/postgres`;
  }

  // oracle: src/mgmt/service/branch.rs:66-208 create()
  async create(a: {
    projectId: string; name: string; parentBranchId?: string | null;
    atLsn?: string | null; createdBy?: "ui" | "api" | "mcp";
  }): Promise<BranchRow> {
    const project = this.deps.state.projects.byId(a.projectId);
    if (!project) throw new DevdbError(404, `project ${a.projectId} not found`);
    if (!NAME_RE.test(a.name)) throw new DevdbError(400, `invalid branch name: ${JSON.stringify(a.name)}`);
    if (this.deps.state.branches.byProjectAndName(project.id, a.name)) {
      throw new DevdbError(409, `branch "${a.name}" already exists in project "${project.name}"`);
    }

    let parent: BranchRow | null;
    if (a.parentBranchId === undefined) {
      parent = this.deps.state.branches.byProjectAndName(project.id, "main");
      if (!parent) throw new DevdbError(500, `project "${project.name}" has no main branch`);
    } else if (a.parentBranchId === null) {
      throw new DevdbError(400, "parentBranchId cannot be null — root branches only exist via project create");
    } else {
      parent = this.byIdOr404(a.parentBranchId);
      if (parent.projectId !== project.id) throw new DevdbError(400, "parent branch belongs to a different project");
    }

    const timelineId = newHexId();
    const req: Record<string, unknown> = {
      new_timeline_id: timelineId,
      ancestor_timeline_id: parent.timelineId,
      read_only: false,
    };
    if (a.atLsn) req.ancestor_start_lsn = a.atLsn;
    await this.deps.pageserver.timelineCreate(project.id, req);

    return this.deps.state.branches.create({
      id: crypto.randomUUID(),
      projectId: project.id,
      parentBranchId: parent.id,
      name: a.name,
      slug: `${slugify(project.name, a.name)}-${timelineId.slice(0, 6)}`,
      timelineId,
      password: generatePassword(),
      createdBy: a.createdBy ?? "api",
    });
  }

  async detail(branch: BranchRow): Promise<BranchDetail> {
    const status = this.deps.computes.statusOf(branch.id);
    const port = this.deps.computes.portOf(branch.id);
    let lastRecordLsn: string | null = null;
    let logicalSizeBytes: number | null = null;
    let ancestorLsn: string | null = null;
    try {
      const info = await this.deps.pageserver.timelineInfo(branch.projectId, branch.timelineId);
      lastRecordLsn = info.last_record_lsn ?? null;
      logicalSizeBytes = info.current_logical_size ?? null;
      ancestorLsn = info.ancestor_lsn ?? null;
    } catch {
      // timeline info is enrichment — a briefly unavailable pageserver must not 500 branch listings
    }
    return {
      ...branch,
      endpointStatus: status,
      port,
      connectionString: status === "running" && port ? this.connectionString(branch, port) : null,
      lastRecordLsn,
      logicalSizeBytes,
      ancestorLsn,
    };
  }

  async list(projectId: string): Promise<BranchDetail[]> {
    const rows = this.deps.state.branches.listByProject(projectId);
    return Promise.all(rows.map((b) => this.detail(b)));
  }

  // oracle: src/mgmt/service/branch.rs:416-519 delete()
  async delete(id: string): Promise<void> {
    return this.deps.queue.run(id, async () => {
      const branch = this.byIdOr404(id);
      const children = this.deps.state.branches.listByParent(branch.id);
      if (children.length > 0) {
        throw new DevdbError(409,
          `branch "${branch.name}" has child branches: ${children.map((c) => c.name).join(", ")} — delete them first`);
      }
      await this.deps.computes.stop(branch.id);
      await this.deps.pageserver.timelineDelete(branch.projectId, branch.timelineId);
      await this.deps.safekeeper.timelineDelete(branch.projectId, branch.timelineId);
      this.deps.state.branches.delete(branch.id);
    });
  }
}
```

Add routes to `packages/daemon/src/http/api.ts` (inside `buildServer`, after project routes; extend `Deps.services` with `branches: BranchesService`):
```ts
  const CreateBranch = z.object({
    name: z.string(),
    parentBranchId: z.string().optional(),
    atLsn: z.string().optional(),
  });
  app.post("/api/projects/:id/branches", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateBranch.parse(req.body);
    const branch = await deps.services.branches.create({ projectId: id, ...body, createdBy: "api" });
    return reply.status(201).send(await deps.services.branches.detail(branch));
  });
  app.get("/api/projects/:id/branches", async (req) => {
    const { id } = req.params as { id: string };
    deps.services.projects.byIdOr404(id);
    return deps.services.branches.list(id);
  });
  app.get("/api/branches/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.branches.detail(deps.services.branches.byIdOr404(id));
  });
  app.delete("/api/branches/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deps.services.branches.delete(id);
    return reply.status(204).send();
  });
```

In `packages/daemon/src/index.ts`, construct and pass it:
```ts
  const { BranchesService } = await import("./services/branches.js");
  const { BranchQueue } = await import("./state/queue.js");
  const queue = new BranchQueue();
  const branchesSvc = new BranchesService({ state, storcon, pageserver, safekeeper, computes, queue });
  const app = buildServer({ cfg, state, engine, services: { projects, branches: branchesSvc } });
```
(ProjectsService.delete also gains child-safe ordering already; no change.)

- [ ] **Step 4: Run unit tests**

Run: `pnpm --filter @devdb/daemon test`
Expected: PASS.

- [ ] **Step 5: Write the integration money test (runs green after Task 14)**

`tests/integration/branching.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startDevdb, type Devdb } from "./helpers/container.js";

async function connect(dev: Devdb, connectionString: string): Promise<pg.Client> {
  const url = new URL(connectionString);
  const client = new pg.Client({
    host: "localhost",
    port: dev.mappedPort(Number(url.port)),
    user: url.username,
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  });
  await client.connect();
  return client;
}

async function api<T>(dev: Devdb, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${dev.base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

describe("branching isolation (the money test)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("branch sees parent data; writes are isolated both ways", async () => {
    const { project, mainBranch } = await api<{ project: { id: string }; mainBranch: { id: string } }>(
      dev, "POST", "/api/projects", { name: "acme" });

    const mainEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${mainBranch.id}/endpoint/start`);
    const main = await connect(dev, mainEp.connectionString);
    await main.query("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
    await main.query("INSERT INTO notes (body) VALUES ('from-main')");

    const branch = await api<{ id: string }>(
      dev, "POST", `/api/projects/${project.id}/branches`, { name: "agent/task-1" });
    const brEp = await api<{ connectionString: string }>(
      dev, "POST", `/api/branches/${branch.id}/endpoint/start`);
    const br = await connect(dev, brEp.connectionString);

    // branch sees parent data
    const seen = await br.query("SELECT body FROM notes");
    expect(seen.rows).toEqual([{ body: "from-main" }]);

    // branch writes don't reach parent
    await br.query("INSERT INTO notes (body) VALUES ('from-branch')");
    expect((await main.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(1);

    // parent writes after the fork don't reach the branch
    await main.query("INSERT INTO notes (body) VALUES ('main-after-fork')");
    expect((await br.query("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(2);

    await main.end();
    await br.end();
  });
});
```

Run: `pnpm --filter @devdb/integration test branching`
Expected at this point: FAIL with 404 on `/endpoint/start` (Task 14 adds it). That failure is this task's exit state — Task 14 turns it green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: branch service and REST (create/list/get/delete)"
```

---

### Task 14: Endpoint lifecycle REST + live compute verification

> **AMENDED (A19, post-review + live):** live launch surfaced: `compute_ctl_config` requires `{ jwks: { keys: [] } }` even in trust mode; `listen_addresses` must be GUC-quoted; shards "0000" CONFIRMED; compute signals ready ~10ms before SCRAM usable (bounded test-helper retry, daemon-side fix chipped). Post-review: `ensureRunning` runs its check inside the queue via an extracted `startLocked`; post-launch persist failures compensate by stopping the compute; `stop` persists "stopped" in `finally`; **branches carry a durable `endpoint_error`** (cleared on healthy transitions, exposed via detail + BranchDto) so polling clients can diagnose failures; exhaustion 409s are project-qualified; live coverage includes stop → status/port-null → restart-freed-capacity. See commits d9f06df + 650ad2b.

**Files:**
- Create: `packages/daemon/src/services/endpoints.ts`
- Modify: `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `tests/integration/branching.test.ts` (from Task 13), `tests/integration/endpoints.test.ts`

**Interfaces:**
- Consumes: Tasks 11-13.
- Produces (used by Tasks 15-17 + Phase 2 MCP):
  - `class EndpointsService(deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService })`:
    - `start(branchId: string): Promise<BranchDetail>` — queued; allocates via sticky port; updates state (`endpointStatus`, `stickyPort`); maps `PortExhaustedError` to `DevdbError(409, …names running endpoints…)`
    - `stop(branchId: string): Promise<BranchDetail>` — queued
    - `ensureRunning(branchId: string): Promise<BranchDetail>` — start if not running (Phase 2 MCP's `get_branch` uses this)
  - REST: `POST /api/branches/:id/endpoint/start` → 200 `BranchDetail` (with `connectionString`); `POST /api/branches/:id/endpoint/stop` → 200 `BranchDetail`; `GET /api/branches/:id/endpoint` → `{ status, port }`

- [ ] **Step 1: Implement (integration test from Task 13 is the failing test)**

`packages/daemon/src/services/endpoints.ts`:
```ts
import type { BranchQueue } from "../state/queue.js";
import { PortExhaustedError } from "../compute/ports.js";
import { DevdbError } from "./errors.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";

export class EndpointsService {
  constructor(private deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService }) {}

  async start(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      const project = this.deps.state.projects.byId(branch.projectId)!;
      if (this.deps.computes.statusOf(branch.id) === "running") {
        return this.deps.branches.detail(branch);
      }
      this.deps.state.branches.updateEndpoint(branch.id, { status: "starting", port: null });
      try {
        const { port } = await this.deps.computes.start({ branch, pgVersion: project.pgVersion });
        this.deps.state.branches.updateEndpoint(branch.id, { status: "running", port });
      } catch (e) {
        this.deps.state.branches.updateEndpoint(branch.id, { status: "failed", port: null });
        if (e instanceof PortExhaustedError) {
          const running = this.deps.computes.runningPorts()
            .map((r) => this.deps.state.branches.byId(r.branchId)?.name ?? r.branchId);
          throw new DevdbError(409,
            `no free endpoint port in range — running endpoints: ${running.join(", ")}. Stop one or widen DEVDB_PORT_RANGE.`);
        }
        throw e;
      }
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    });
  }

  async stop(branchId: string): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      this.deps.state.branches.updateEndpoint(branch.id, { status: "stopping", port: null });
      await this.deps.computes.stop(branch.id);
      this.deps.state.branches.updateEndpoint(branch.id, { status: "stopped", port: null });
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    });
  }

  async ensureRunning(branchId: string): Promise<BranchDetail> {
    if (this.deps.computes.statusOf(branchId) === "running") {
      return this.deps.branches.detail(this.deps.branches.byIdOr404(branchId));
    }
    return this.start(branchId);
  }
}
```

Routes in `api.ts` (extend `Deps.services` with `endpoints: EndpointsService`):
```ts
  app.post("/api/branches/:id/endpoint/start", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.endpoints.start(id);
  });
  app.post("/api/branches/:id/endpoint/stop", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.endpoints.stop(id);
  });
  app.get("/api/branches/:id/endpoint", async (req) => {
    const { id } = req.params as { id: string };
    const detail = await deps.services.branches.detail(deps.services.branches.byIdOr404(id));
    return { status: detail.endpointStatus, port: detail.port };
  });
```
Wire in `index.ts`:
```ts
  const { EndpointsService } = await import("./services/endpoints.js");
  const endpoints = new EndpointsService({ state, storcon, pageserver, safekeeper, computes, queue, branches: branchesSvc });
  const app = buildServer({ cfg, state, engine, services: { projects, branches: branchesSvc, endpoints } });
```

- [ ] **Step 2: Run the money test**

Run: `pnpm --filter @devdb/integration test branching`
Expected: PASS. **This is the phase's biggest milestone — live compute + CoW isolation.** If `compute_ctl` fails to start, its last output lines are in the API error; check the VERIFY notes in `compute/spec.ts` (shards key encoding) and `docker/BINARIES.md` inventory before changing anything else.

- [ ] **Step 3: Add the port-exhaustion integration test**

`tests/integration/endpoints.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("endpoint port exhaustion", () => {
  let dev: Devdb;
  beforeAll(async () => {
    dev = await startDevdb({ DEVDB_PORT_RANGE: "54300-54301" });
  });
  afterAll(async () => { await dev?.stop(); });

  it("names running endpoints when the range is full", async () => {
    const mk = async (name: string) => {
      const r = await fetch(`${dev.base}/api/projects`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return (await r.json()).mainBranch.id as string;
    };
    const b1 = await mk("p1"); const b2 = await mk("p2"); const b3 = await mk("p3");
    for (const b of [b1, b2]) {
      const r = await fetch(`${dev.base}/api/branches/${b}/endpoint/start`, { method: "POST" });
      expect(r.status).toBe(200);
    }
    const r3 = await fetch(`${dev.base}/api/branches/${b3}/endpoint/start`, { method: "POST" });
    expect(r3.status).toBe(409);
    const body = await r3.json();
    expect(body.error).toContain("main");
    expect(body.error).toContain("DEVDB_PORT_RANGE");
  });
});
```

Run: `pnpm --filter @devdb/integration test endpoints`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: endpoint lifecycle with sticky ports and exhaustion errors"
```

---

### Task 15: Time travel — LSN by timestamp, branch-at-point, restore, reset

> **AMENDED (A21, post-review + live):** all three time-travel engine APIs worked on first live contact. Post-review: reset's child/parent guards run INSIDE the branch lane; the queued swap compensates ANY post-stop failure (orphan timeline deleted, original endpoint restarted) with the detach→swap crash window documented (boot reconciliation tracked for the durability phase); LSN-range engine rejections map to 400 per the oracle's classification (branch.rs:689-701); timestamps require an explicit timezone; reapOrphanedPostgres kills all matches (invariant warning on >1) with a bounded post-kill wait and one rm retry. Live lesson: get_lsn_by_timestamp stays kind=future until later COMMITS advance the timeline clock — integration polls after the destructive write. See commits 31e0fff + 82567cf.

**Files:**
- Create: `packages/daemon/src/services/timetravel.ts`
- Modify: `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/timetravel.test.ts` (unit), `tests/integration/timetravel.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 9, 13, 14.
- Produces (used by Phase 2 MCP):
  - `class TimeTravelService(deps: ProjectsDeps & { queue: BranchQueue; branches: BranchesService; endpoints: EndpointsService })`:
    - `lsnAtTimestamp(branchId: string, isoTimestamp: string): Promise<string>` — 400 with explanation when `kind !== "present"` (`"future"` → "timestamp is ahead of this branch", `"past"|"nodata"` → "before retained history")
    - `branchAtTimestamp(a: { projectId: string; sourceBranchId: string; name: string; isoTimestamp: string; createdBy?: "ui"|"api"|"mcp" }): Promise<BranchRow>` — non-destructive PITR: new branch at that point
    - `restoreInPlace(branchId: string, isoTimestamp: string): Promise<BranchDetail>` — oracle's swap flow (see Step 3 comments)
    - `resetToParent(branchId: string): Promise<BranchDetail>` — 409 if branch has children; swap onto a fresh fork of the parent's head
  - REST: `GET /api/branches/:id/lsn?timestamp=ISO`; `POST /api/branches/:id/restore {to: ISO, mode: "in_place"} | {to: ISO, mode: "new_branch", name}`; `POST /api/branches/:id/reset`

- [ ] **Step 1: Write the failing unit tests**

`packages/daemon/test/timetravel.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { ProjectsService } from "../src/services/projects.js";
import { BranchesService } from "../src/services/branches.js";
import { TimeTravelService } from "../src/services/timetravel.js";

function fakes() {
  return {
    storcon: {
      tenantCreate: vi.fn(async () => {}),
      getLsnByTimestamp: vi.fn(async () => ({ lsn: "0/AA", kind: "present" })),
    },
    pageserver: {
      timelineCreate: vi.fn(async () => ({ timeline_id: "x" })),
      timelineInfo: vi.fn(async () => ({ timeline_id: "x", last_record_lsn: "0/2" })),
      timelineDelete: vi.fn(async () => {}),
      timelineDetachAncestor: vi.fn(async () => ({ reparented_timelines: [] })),
      tenantDelete: vi.fn(async () => {}),
    },
    safekeeper: { timelineDelete: vi.fn(async () => {}), tenantDelete: vi.fn(async () => {}) },
    computes: { stop: vi.fn(async () => {}), statusOf: vi.fn(() => "stopped"), portOf: vi.fn(() => null), runningPorts: () => [] },
  };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  const projects = new ProjectsService({ state, ...f } as never);
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const queue = new BranchQueue();
  const branches = new BranchesService({ state, queue, ...f } as never);
  const endpoints = { ensureRunning: vi.fn(), start: vi.fn(), stop: vi.fn(async () => {}) };
  const tt = new TimeTravelService({ state, queue, branches, endpoints, ...f } as never);
  return { f, state, project, mainBranch, branches, tt };
}

describe("TimeTravelService", () => {
  it("lsnAtTimestamp rejects non-present kinds with explanation", async () => {
    const { f, mainBranch, tt } = await seeded();
    f.storcon.getLsnByTimestamp.mockResolvedValueOnce({ lsn: "0/0", kind: "future" });
    await expect(tt.lsnAtTimestamp(mainBranch.id, "2030-01-01T00:00:00Z"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("branchAtTimestamp creates a branch at the resolved LSN", async () => {
    const { f, project, mainBranch, tt, state } = await seeded();
    const b = await tt.branchAtTimestamp({
      projectId: project.id, sourceBranchId: mainBranch.id,
      name: "recovered", isoTimestamp: "2026-07-02T10:00:00Z",
    });
    expect(b.parentBranchId).toBe(mainBranch.id);
    const req = f.pageserver.timelineCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(req.ancestor_start_lsn).toBe("0/AA");
    expect(state.branches.byProjectAndName(project.id, "recovered")).not.toBeNull();
  });

  it("restoreInPlace swaps identity onto a new timeline and archives the old row", async () => {
    const { f, mainBranch, tt, state } = await seeded();
    const out = await tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z");
    expect(f.pageserver.timelineDetachAncestor).toHaveBeenCalled();
    expect(out.name).toBe("main");
    expect(out.id).not.toBe(mainBranch.id);
    const archived = state.branches.byId(mainBranch.id)!;
    expect(archived.name).toContain("main_pitr_archived_");
  });

  it("restoreInPlace cleans up the orphan timeline when detach fails", async () => {
    const { f, mainBranch, tt } = await seeded();
    f.pageserver.timelineDetachAncestor.mockRejectedValueOnce(new Error("detach boom"));
    await expect(tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/detach boom/);
    expect(f.pageserver.timelineDelete).toHaveBeenCalled();
    expect(f.safekeeper.timelineDelete).toHaveBeenCalled();
  });

  it("resetToParent refuses when children exist", async () => {
    const { project, tt, state, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await branches.create({ projectId: project.id, name: "grandchild", parentBranchId: dev.id });
    await expect(tt.resetToParent(dev.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resetToParent swaps onto a fresh fork of the parent head", async () => {
    const { f, project, tt, branches, state } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    const out = await tt.resetToParent(dev.id);
    const req = f.pageserver.timelineCreate.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(req.ancestor_start_lsn).toBeUndefined(); // parent head
    expect(out.name).toBe("dev");
    expect(state.branches.byId(dev.id)!.name).toContain("dev_reset_archived_");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test timetravel`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/services/timetravel.ts`:
```ts
import type { BranchRow } from "../state/repos.js";
import type { BranchQueue } from "../state/queue.js";
import { newHexId } from "../engine/ids.js";
import { DevdbError } from "./errors.js";
import { slugify } from "./slug.js";
import type { ProjectsDeps } from "./projects.js";
import type { BranchesService, BranchDetail } from "./branches.js";
import type { EndpointsService } from "./endpoints.js";

export class TimeTravelService {
  constructor(private deps: ProjectsDeps & {
    queue: BranchQueue; branches: BranchesService; endpoints: EndpointsService;
  }) {}

  // oracle: src/mgmt/service/branch.rs:520-599 (via storcon :1234)
  async lsnAtTimestamp(branchId: string, isoTimestamp: string): Promise<string> {
    const branch = this.deps.branches.byIdOr404(branchId);
    const ts = new Date(isoTimestamp);
    if (Number.isNaN(ts.getTime())) throw new DevdbError(400, `invalid timestamp: ${isoTimestamp}`);
    const out = await this.deps.storcon.getLsnByTimestamp(
      branch.projectId, branch.timelineId, ts.toISOString());
    if (out.kind !== "present") {
      const why = out.kind === "future"
        ? "that timestamp is ahead of this branch's history"
        : "that timestamp is before this branch's retained history";
      throw new DevdbError(400, `cannot resolve ${isoTimestamp} on "${branch.name}": ${why} (kind=${out.kind})`);
    }
    return out.lsn;
  }

  async branchAtTimestamp(a: {
    projectId: string; sourceBranchId: string; name: string; isoTimestamp: string;
    createdBy?: "ui" | "api" | "mcp";
  }): Promise<BranchRow> {
    const lsn = await this.lsnAtTimestamp(a.sourceBranchId, a.isoTimestamp);
    return this.deps.branches.create({
      projectId: a.projectId, name: a.name, parentBranchId: a.sourceBranchId,
      atLsn: lsn, createdBy: a.createdBy ?? "api",
    });
  }

  // oracle: src/mgmt/service/branch.rs:601-848 restore(): new timeline at LSN from the
  // branch's own timeline → detach_ancestor (reparents children) → DB identity swap,
  // old row archived as <name>_pitr_archived_<ts>; endpoint stopped/relaunched around it.
  async restoreInPlace(branchId: string, isoTimestamp: string): Promise<BranchDetail> {
    const lsn = await this.lsnAtTimestamp(branchId, isoTimestamp);
    return this.swapOntoNewTimeline(branchId, {
      ancestorTimelineId: (b) => b.timelineId,
      atLsn: lsn,
      archiveTag: "pitr",
      detachAncestor: true,
    });
  }

  // reset = fresh fork of the parent's current head, same swap machinery.
  // No detach_ancestor: the new timeline's ancestor IS the parent (correct final shape).
  async resetToParent(branchId: string): Promise<BranchDetail> {
    const branch = this.deps.branches.byIdOr404(branchId);
    if (!branch.parentBranchId) throw new DevdbError(400, `branch "${branch.name}" has no parent`);
    const children = this.deps.state.branches.listByParent(branch.id);
    if (children.length > 0) {
      throw new DevdbError(409,
        `branch "${branch.name}" has child branches: ${children.map((c) => c.name).join(", ")} — delete them first`);
    }
    const parent = this.deps.branches.byIdOr404(branch.parentBranchId);
    return this.swapOntoNewTimeline(branchId, {
      ancestorTimelineId: () => parent.timelineId,
      atLsn: null,
      archiveTag: "reset",
      detachAncestor: false,
    });
  }

  private async swapOntoNewTimeline(branchId: string, opts: {
    ancestorTimelineId: (b: BranchRow) => string;
    atLsn: string | null;
    archiveTag: string;
    detachAncestor: boolean;
  }): Promise<BranchDetail> {
    return this.deps.queue.run(branchId, async () => {
      const branch = this.deps.branches.byIdOr404(branchId);
      const status = this.deps.computes.statusOf(branch.id);
      if (status === "starting" || status === "stopping") {
        throw new DevdbError(409, "endpoint is mid-transition — retry when it settles");
      }
      const wasRunning = status === "running";
      if (wasRunning) await this.deps.computes.stop(branch.id);

      const newTimelineId = newHexId();
      const req: Record<string, unknown> = {
        new_timeline_id: newTimelineId,
        ancestor_timeline_id: opts.ancestorTimelineId(branch),
        read_only: false,
      };
      if (opts.atLsn) req.ancestor_start_lsn = opts.atLsn;
      await this.deps.pageserver.timelineCreate(branch.projectId, req);

      let reparented: string[] = [];
      if (opts.detachAncestor) {
        try {
          const out = await this.deps.pageserver.timelineDetachAncestor(branch.projectId, newTimelineId);
          reparented = out.reparented_timelines;
        } catch (e) {
          // oracle cleanup: branch.rs:709-735
          await this.deps.pageserver.timelineDelete(branch.projectId, newTimelineId).catch(() => {});
          await this.deps.safekeeper.timelineDelete(branch.projectId, newTimelineId).catch(() => {});
          throw e;
        }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const swapped = this.deps.state.branches.restoreSwap({
        oldBranchId: branch.id,
        newBranchId: crypto.randomUUID(),
        newTimelineId,
        archiveName: `${branch.name}_${opts.archiveTag}_archived_${stamp}`,
        archiveSlug: `${slugify(branch.slug)}-${opts.archiveTag}-${newTimelineId.slice(0, 6)}`,
        reparentedTimelineIds: reparented,
      });

      if (wasRunning) await this.deps.endpoints.start(swapped.id);
      return this.deps.branches.detail(this.deps.branches.byIdOr404(swapped.id));
    });
  }
}
```

Routes in `api.ts` (extend `Deps.services` with `timetravel: TimeTravelService`):
```ts
  app.get("/api/branches/:id/lsn", async (req) => {
    const { id } = req.params as { id: string };
    const { timestamp } = req.query as { timestamp?: string };
    if (!timestamp) throw new DevdbError(400, "timestamp query parameter required");
    return { lsn: await deps.services.timetravel.lsnAtTimestamp(id, timestamp) };
  });

  const Restore = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("in_place"), to: z.string() }),
    z.object({ mode: z.literal("new_branch"), to: z.string(), name: z.string() }),
  ]);
  app.post("/api/branches/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    const body = Restore.parse(req.body);
    if (body.mode === "in_place") {
      return deps.services.timetravel.restoreInPlace(id, body.to);
    }
    const src = deps.services.branches.byIdOr404(id);
    const b = await deps.services.timetravel.branchAtTimestamp({
      projectId: src.projectId, sourceBranchId: id, name: body.name,
      isoTimestamp: body.to, createdBy: "api",
    });
    return deps.services.branches.detail(b);
  });

  app.post("/api/branches/:id/reset", async (req) => {
    const { id } = req.params as { id: string };
    return deps.services.timetravel.resetToParent(id);
  });
```
Wire in `index.ts`:
```ts
  const { TimeTravelService } = await import("./services/timetravel.js");
  const timetravel = new TimeTravelService({ state, storcon, pageserver, safekeeper, computes, queue, branches: branchesSvc, endpoints });
  const app = buildServer({ cfg, state, engine, services: { projects, branches: branchesSvc, endpoints, timetravel } });
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm --filter @devdb/daemon test`
Expected: PASS.

- [ ] **Step 5: Write and run the integration test**

`tests/integration/timetravel.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startDevdb, type Devdb } from "./helpers/container.js";

async function connect(dev: Devdb, connectionString: string): Promise<pg.Client> {
  const url = new URL(connectionString);
  const client = new pg.Client({
    host: "localhost", port: dev.mappedPort(Number(url.port)),
    user: url.username, password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  });
  await client.connect();
  return client;
}

describe("time travel", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("restores dropped data in place and via new branch", async () => {
    const created = await (await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tt" }),
    })).json();
    const mainId = created.mainBranch.id as string;

    const ep = await (await fetch(`${dev.base}/api/branches/${mainId}/endpoint/start`, { method: "POST" })).json();
    let c = await connect(dev, ep.connectionString);
    await c.query("CREATE TABLE t (v text)");
    await c.query("INSERT INTO t VALUES ('precious')");
    // let WAL land + a clear timestamp gap
    await new Promise((r) => setTimeout(r, 3000));
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 3000));
    await c.query("DROP TABLE t");
    await c.end();

    // non-destructive: recover into a new branch
    const rb = await (await fetch(`${dev.base}/api/branches/${mainId}/restore`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "new_branch", to: before, name: "rescued" }),
    })).json();
    const rbEp = await (await fetch(`${dev.base}/api/branches/${rb.id}/endpoint/start`, { method: "POST" })).json();
    const rc = await connect(dev, rbEp.connectionString);
    expect((await rc.query("SELECT v FROM t")).rows).toEqual([{ v: "precious" }]);
    await rc.end();

    // destructive: restore main itself
    const restored = await (await fetch(`${dev.base}/api/branches/${mainId}/restore`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "in_place", to: before }),
    })).json();
    expect(restored.name).toBe("main");
    const rEp = await (await fetch(`${dev.base}/api/branches/${restored.id}/endpoint/start`, { method: "POST" })).json();
    c = await connect(dev, rEp.connectionString);
    expect((await c.query("SELECT v FROM t")).rows).toEqual([{ v: "precious" }]);
    await c.end();
  });

  it("reset returns a branch to its parent's state", async () => {
    const created = await (await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rt" }),
    })).json();
    const mainId = created.mainBranch.id as string;
    const ep = await (await fetch(`${dev.base}/api/branches/${mainId}/endpoint/start`, { method: "POST" })).json();
    const mc = await connect(dev, ep.connectionString);
    await mc.query("CREATE TABLE base (v text)");
    await mc.query("INSERT INTO base VALUES ('parent-state')");
    await mc.end();

    const br = await (await fetch(`${dev.base}/api/projects/${created.project.id}/branches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scratch" }),
    })).json();
    const brEp = await (await fetch(`${dev.base}/api/branches/${br.id}/endpoint/start`, { method: "POST" })).json();
    let bc = await connect(dev, brEp.connectionString);
    await bc.query("INSERT INTO base VALUES ('scratch-garbage')");
    await bc.end();

    const reset = await (await fetch(`${dev.base}/api/branches/${br.id}/reset`, { method: "POST" })).json();
    const rEp = await (await fetch(`${dev.base}/api/branches/${reset.id}/endpoint/start`, { method: "POST" })).json();
    bc = await connect(dev, rEp.connectionString);
    expect((await bc.query("SELECT count(*)::int AS n FROM base")).rows[0].n).toBe(1);
    await bc.end();
  });
});
```

Run: `pnpm --filter @devdb/integration test timetravel`
Expected: PASS. Timing note: `get_lsn_by_timestamp` needs the commit timestamp to be durably behind the target — the 3s sleeps provide the gap; if `kind=future` errors appear, widen them.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: time travel — lsn lookup, branch-at-point, restore, reset"
```

---

### Task 16: Logs (SSE), full status, boot reconciliation, restart resilience

**Files:**
- Create: `packages/daemon/src/services/logs.ts`
- Modify: `packages/daemon/src/engine/boot.ts` (wire `onLine` → LogsService), `packages/daemon/src/compute/manager.ts` (already exposes `onLine`), `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/logs.test.ts` (unit), `tests/integration/restart.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 8, 11, 14.
- Produces:
  - `class LogsService`: `ingest(channel: string, line: string): void`, `recent(channel: string, n = 200): string[]`, `subscribe(channel: string, cb: (line: string) => void): () => void`. Channels: `daemon:<component>` (engine procs) and `branch:<branchId>:compute`.
  - REST: `GET /api/daemon/logs/:component` and `GET /api/branches/:id/logs?channel=compute` — SSE (`text/event-stream`, replay `recent()` then live).
  - Boot reconciliation in `index.ts`: after `engine.start()`, every branch row with `endpoint_status != 'stopped'` is reset to `stopped` (computes died with the old container; timelines survive in the engine).

- [ ] **Step 1: Write the failing unit test**

`packages/daemon/test/logs.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LogsService } from "../src/services/logs.js";

describe("LogsService", () => {
  it("keeps a bounded ring and notifies subscribers", () => {
    const logs = new LogsService(3);
    const got: string[] = [];
    const unsub = logs.subscribe("c", (l) => got.push(l));
    for (const l of ["a", "b", "c", "d"]) logs.ingest("c", l);
    expect(logs.recent("c")).toEqual(["b", "c", "d"]);
    expect(got).toEqual(["a", "b", "c", "d"]);
    unsub();
    logs.ingest("c", "e");
    expect(got).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @devdb/daemon test logs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/services/logs.ts`:
```ts
export class LogsService {
  private rings = new Map<string, string[]>();
  private subs = new Map<string, Set<(line: string) => void>>();

  constructor(private ringSize = 500) {}

  ingest(channel: string, line: string): void {
    let ring = this.rings.get(channel);
    if (!ring) { ring = []; this.rings.set(channel, ring); }
    ring.push(line);
    if (ring.length > this.ringSize) ring.shift();
    this.subs.get(channel)?.forEach((cb) => cb(line));
  }

  recent(channel: string, n = 200): string[] {
    return (this.rings.get(channel) ?? []).slice(-n);
  }

  subscribe(channel: string, cb: (line: string) => void): () => void {
    let set = this.subs.get(channel);
    if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
}
```

Wire engine output — in `packages/daemon/src/index.ts`, construct the service **before** the engine and pass it through:
```ts
  const { LogsService } = await import("./services/logs.js");
  const logs = new LogsService();
  const engine = new EngineRuntime(cfg, state, logs); // replaces the existing 2-arg call
```
In `EngineRuntime` accept `logs: LogsService` as third constructor arg; in `launch()` pass `onLine: (l) => this.logs.ingest(\`daemon:${spec.name}\`, l)` to `ManagedProcess`, and give the storcon-db `onLine: (l) => this.logs.ingest("daemon:storcon_db", l)`. In `ComputeManager.start`, after `entry.proc` is created, `EndpointsService.start` (Task 14) adds:
```ts
      this.deps.computes.onLine(branch.id, (line) =>
        this.deps.logs.ingest(`branch:${branch.id}:compute`, line));
```
(add `logs: LogsService` to `EndpointsService` deps and `index.ts` wiring).

SSE routes in `api.ts`:
```ts
  function sse(reply: import("fastify").FastifyReply, channel: string) {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const line of deps.logs.recent(channel)) {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    const unsub = deps.logs.subscribe(channel, (line) => {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    });
    reply.raw.on("close", unsub);
  }

  app.get("/api/daemon/logs/:component", (req, reply) => {
    const { component } = req.params as { component: string };
    sse(reply, `daemon:${component}`);
  });
  app.get("/api/branches/:id/logs", (req, reply) => {
    const { id } = req.params as { id: string };
    deps.services.branches.byIdOr404(id);
    sse(reply, `branch:${id}:compute`);
  });
```
(`Deps` gains `logs: LogsService`.)

Boot reconciliation in `index.ts` after `engine.start()`:
```ts
  for (const p of state.projects.list()) {
    for (const b of state.branches.listByProject(p.id)) {
      if (b.endpointStatus !== "stopped") {
        state.branches.updateEndpoint(b.id, { status: "stopped", port: null });
      }
    }
  }
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm --filter @devdb/daemon test`
Expected: PASS.

- [ ] **Step 5: Write and run the restart integration test**

`tests/integration/restart.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("restart resilience", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("branches survive a container restart; endpoint statuses reconcile", async () => {
    const created = await (await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme" }),
    })).json();
    const mainId = created.mainBranch.id as string;
    const ep = await (await fetch(`${dev.base}/api/branches/${mainId}/endpoint/start`, { method: "POST" })).json();
    const url = new URL(ep.connectionString);
    let c = new pg.Client({
      host: "localhost", port: dev.mappedPort(Number(url.port)),
      user: "postgres", password: decodeURIComponent(url.password), database: "postgres",
    });
    await c.connect();
    await c.query("CREATE TABLE keep (v text)");
    await c.query("INSERT INTO keep VALUES ('survives')");
    await c.end();

    await dev.container.restart({ timeout: 60 });
    // wait for healthy again
    for (let i = 0; i < 120; i++) {
      try {
        const s = await fetch(`${dev.base}/api/status`);
        if (s.ok && (await s.json()).healthy) break;
      } catch { /* container coming back */ }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const detail = await (await fetch(`${dev.base}/api/branches/${mainId}`)).json();
    expect(detail.endpointStatus).toBe("stopped"); // reconciled

    const ep2 = await (await fetch(`${dev.base}/api/branches/${mainId}/endpoint/start`, { method: "POST" })).json();
    const url2 = new URL(ep2.connectionString);
    c = new pg.Client({
      host: "localhost", port: dev.mappedPort(Number(url2.port)),
      user: "postgres", password: decodeURIComponent(url2.password), database: "postgres",
    });
    await c.connect();
    expect((await c.query("SELECT v FROM keep")).rows).toEqual([{ v: "survives" }]);
    await c.end();
  });
});
```

Note: `dev.container.restart` keeps the same mapped ports and the anonymous volume, so `/data` (lockfile included) persists — the daemon must **tolerate an existing lockfile left by an unclean stop**? No: restart sends SIGTERM first, our shutdown removes the lockfile. If this test flakes on the lockfile, the daemon's message names the file — that is working as designed for crash detection; the test asserting a clean restart is exactly what validates graceful shutdown.

Run: `pnpm --filter @devdb/integration test restart`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: log streaming, boot reconciliation, restart resilience"
```

---

### Task 17: SQL console, acceptance test, README quickstart

**Files:**
- Create: `packages/daemon/src/services/sql.ts`, `README.md`
- Modify: `packages/daemon/src/http/api.ts`, `packages/daemon/src/index.ts`
- Test: `tests/integration/acceptance.test.ts`

**Interfaces:**
- Consumes: Tasks 13-15.
- Produces:
  - `class SqlService(deps: { branches: BranchesService; endpoints: EndpointsService })`: `run(branchId: string, query: string): Promise<{ rows: unknown[]; rowCount: number; fields: string[] }>` — connects to the branch endpoint via `pg` (ensureRunning first), 30s timeout, max 1000 rows returned
  - REST: `POST /api/sql {branchId, query}`
  - `README.md` quickstart (docker compose up → curl flow) — the human-facing entry point
  - Phase-1 acceptance = spec "v1 acceptance" items 1-4 as one scripted test

- [ ] **Step 1: Implement SqlService + route**

`packages/daemon/src/services/sql.ts`:
```ts
import pg from "pg";
import { DevdbError } from "./errors.js";
import type { BranchesService } from "./branches.js";
import type { EndpointsService } from "./endpoints.js";

export class SqlService {
  constructor(private deps: { branches: BranchesService; endpoints: EndpointsService }) {}

  async run(branchId: string, query: string): Promise<{ rows: unknown[]; rowCount: number; fields: string[] }> {
    if (!query.trim()) throw new DevdbError(400, "empty query");
    const detail = await this.deps.endpoints.ensureRunning(branchId);
    if (!detail.connectionString || !detail.port) {
      throw new DevdbError(502, `endpoint for "${detail.name}" is not running`);
    }
    const client = new pg.Client({
      host: "127.0.0.1", port: detail.port, user: "postgres",
      password: detail.password, database: "postgres",
      statement_timeout: 30_000, connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    try {
      const res = await client.query(query);
      const rows = (res.rows ?? []).slice(0, 1000);
      return { rows, rowCount: res.rowCount ?? rows.length, fields: (res.fields ?? []).map((f) => f.name) };
    } finally {
      await client.end();
    }
  }
}
```

Route in `api.ts` (`Deps.services` gains `sql: SqlService`):
```ts
  const SqlBody = z.object({ branchId: z.string(), query: z.string() });
  app.post("/api/sql", async (req) => {
    const body = SqlBody.parse(req.body);
    return deps.services.sql.run(body.branchId, body.query);
  });
```
Wire in `index.ts`:
```ts
  const { SqlService } = await import("./services/sql.js");
  const sql = new SqlService({ branches: branchesSvc, endpoints });
```
Note: the SQL console connects to `127.0.0.1:<port>` **inside** the container — the daemon shares the network namespace with computes, so container-internal loopback is correct here (unlike external clients, which use the published ports).

- [ ] **Step 2: Write the acceptance test (spec v1 items 1-4)**

`tests/integration/acceptance.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevdb, type Devdb } from "./helpers/container.js";

describe("phase-1 acceptance (spec v1 items 1-4, REST edition)", () => {
  let dev: Devdb;
  beforeAll(async () => { dev = await startDevdb(); });
  afterAll(async () => { await dev?.stop(); });

  it("boot → project → write → branch → isolate → reset → restore", async () => {
    // 1. healthy boot
    expect((await (await fetch(`${dev.base}/api/status`)).json()).healthy).toBe(true);

    // 2. project + main + SQL write (SQL console doubles as the write path here)
    const created = await (await fetch(`${dev.base}/api/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    })).json();
    const mainId = created.mainBranch.id as string;
    const sql = (q: string, branchId = mainId) =>
      fetch(`${dev.base}/api/sql`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ branchId, query: q }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      });
    await sql("CREATE TABLE notes (body text)");
    await sql("INSERT INTO notes VALUES ('hello devdb')");

    // 3. branch is isolated
    const br = await (await fetch(`${dev.base}/api/projects/${created.project.id}/branches`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "agent/demo-task" }),
    })).json();
    await sql("DELETE FROM notes", br.id);
    expect((await sql("SELECT count(*)::int AS n FROM notes")).rows[0].n).toBe(1);

    // 4. reset brings the branch back to parent state
    const reset = await (await fetch(`${dev.base}/api/branches/${br.id}/reset`, { method: "POST" })).json();
    expect((await sql("SELECT count(*)::int AS n FROM notes", reset.id)).rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 3: Run the full integration suite**

Run: `pnpm --filter @devdb/integration test`
Expected: ALL PASS (boot, projects, branching, endpoints, timetravel, restart, acceptance).

- [ ] **Step 4: Write README quickstart**

`README.md`:
```markdown
# DevDB

Local Postgres with Neon-style instant branching, built for AI coding agents.
One Docker container; branches are copy-on-write and cost nothing to create.

## Quickstart

    docker compose -f docker/compose.yaml up --build -d
    curl http://localhost:4400/api/status

Create a project (comes with a `main` branch):

    curl -X POST http://localhost:4400/api/projects \
      -H 'content-type: application/json' -d '{"name":"acme"}'

Start `main`'s endpoint and connect:

    curl -X POST http://localhost:4400/api/branches/<mainBranchId>/endpoint/start
    psql 'postgresql://postgres:<password>@localhost:<port>/postgres'

Branch it (instant, copy-on-write) and get an isolated database:

    curl -X POST http://localhost:4400/api/projects/<projectId>/branches \
      -H 'content-type: application/json' -d '{"name":"agent/my-task"}'

Time travel:

    # non-destructive: recover a past state into a new branch
    curl -X POST http://localhost:4400/api/branches/<id>/restore \
      -H 'content-type: application/json' \
      -d '{"mode":"new_branch","to":"2026-07-02T10:00:00Z","name":"rescued"}'
    # discard a branch's changes (back to parent state)
    curl -X POST http://localhost:4400/api/branches/<id>/reset

Status: Phase 1 (engine + branching over REST). Web UI, MCP server for agents,
import/export, and S3/Azure durability land in subsequent phases.
Built on [Neon](https://github.com/neondatabase/neon)'s storage engine;
architecture informed by [neond](https://github.com/matisiekpl/neond) (Apache 2.0).
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sql console, phase-1 acceptance test, README quickstart"
```

---

## Post-plan verification checklist (run once, after Task 17)

- [ ] `pnpm -r test` green (unit) and `pnpm --filter @devdb/integration test` green (container).
- [ ] `docker compose -f docker/compose.yaml up` from scratch reaches healthy `/api/status` and the README quickstart works by hand.
- [ ] Every VERIFY comment in the code has either been confirmed against the neon submodule or corrected (grep for `VERIFY`).
- [ ] Invoke superpowers:finishing-a-development-branch, then write the Phase 2 (MCP + skills) plan with what this phase taught us.

## Deferred to later phases (explicitly NOT in this plan)

Durability/"checkpoint" sync status in `/api/status` (Phase 4), remote storage config (Phase 4), import/export (Phase 4), MCP + skills (Phase 2), web UI (Phase 3), extensions + PG 18 (Phase 5), branch rename — the spec's `PATCH /api/branches/:id` (Phase 3, alongside the UI that exposes it), auto-restart of crashed engine processes with backoff (the supervisor restarts nothing in phase 1 — a crashed engine component degrades `/api/status.healthy` to `false` and the failure is visible in logs; supervised backoff-restart arrives with the UI banner work in Phase 3).
