# DevDB Dynamic Postgres Build Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users (and agents over MCP) pull newer Neon-built Postgres builds — newer minors of installed majors, or new majors — at runtime from Neon's official `neondatabase/compute-node-v{N}` Docker Hub images, without destroying/re-upping the container.

**Architecture:** A new `packages/daemon/src/compute/builds/` unit: `BuildRegistry` (SQLite `pg_builds`/`pg_majors` + newest-valid-wins resolution + `pgbinFor(major)`), `OciClient` (anonymous registry-v2 pull, layer sha256 verification, `usr/local/`-only extraction with whiteouts), `Provisioner` (check → pull → fixup → validation gate → auto-activate, one global job at a time). Endpoint starts resolve their `--pgbin` through the registry (adopt-on-restart falls out); the pageserver's `pg_distrib_dir` moves to a composed symlink dir so downloaded-only majors get WAL-redo binaries while baked majors always stay on baked bits. Boot reconciliation re-adopts volume builds (survives container re-ups) and flags downgrades loudly, never silently.

**Tech Stack:** Node 22 built-ins only (`fetch`, `zlib`, `crypto`, `fs`) + system `tar` (present in the image; debian-essential). **Zero new npm dependencies.** SQLite via existing better-sqlite3, Fastify routes, MCP SDK already installed, React 19 + Mantine 9 + React Query 5 for the UI.

**Spec (authoritative):** `docs/superpowers/specs/2026-07-04-devdb-dynamic-pg-builds-design.md`. Read it before deviating from anything here.

## Global Constraints

- **Zero new npm dependencies in this phase** (spec: "no new npm/native deps"). OCI pull uses node `fetch`/`zlib`/`crypto` + spawning system `tar`. If you believe you need a package, STOP and escalate.
- **No self-hosted artifacts, no curated manifest.** Source of truth = `neondatabase/compute-node-v{major}` on Docker Hub; tag→digest resolved at pull time and BOTH recorded (`releaseTag`, `imageDigest`).
- **Egress only on explicit user/agent action** (check/pull). No background polling, no auto-update.
- **Baked `compute_ctl` always; only `--pgbin` swaps.** Never extract or invoke a downloaded image's `compute_ctl`.
- **Adopt on restart:** activation never touches running endpoints. **Downgrades are never silent:** resolution below `pg_majors.lastRunMinor` sets a degraded flag surfaced in `/api/status`; only consented rollback lowers the high-water mark.
- **Minor refresh is the first-class guarantee; new-major-via-pull is supported-if-storage-supports-it** — the validation gate is the arbiter (spec decision 9).
- **Validation gate before `ready`:** every downloaded build must start a throwaway compute against live storage and pass smoke SQL. Failed builds: dir deleted, row kept as `failed`, active pointer untouched.
- **Tests:** unit tests use typed fakes against interfaces (`services/engine-api.ts` pattern) — **no `as never`/`as any`** (tsc gate enforces). TDD: write the failing test first, capture RED output. Integration tests are hermetic — **never pull from Docker Hub in CI**.
- **Oracle rule:** engine interactions cite `// oracle: <file:line>` from `~/git/neond`. The pageserver `pg_distrib_dir` semantic (per-major WAL-redo binary resolution) is upstream neon behavior; cite `pageserverToml`'s existing oracle comment when touching it.
- Conventional commits; commit after every task's GREEN. Never commit secrets. LF endings (`.gitattributes` handles it).
- Workspace commands: plain `pnpm` (corepack shim broken). Daemon suite: `pnpm --filter @devdb/daemon test`. Web: `pnpm --filter @devdb/web test`. Integration: `pnpm --filter @devdb/integration test` (needs Docker, ~6 min).
- Registry/image config env names (exact): `DEVDB_PG_REGISTRY_BASE` (default `https://registry-1.docker.io`), `DEVDB_PG_IMAGE_TEMPLATE` (default `neondatabase/compute-node-v{major}`, literal `{major}` placeholder). Derived dirs (no envs): `pgBuildsDir = <dataDir>/pg_builds`, `pgDistribDir = <dataDir>/pg_distrib`.
- Volume layout (exact): `/data/pg_builds/v{major}/{releaseTag}/` containing the extracted prefix (`bin/`, `lib/`, `share/`, …) plus `build.json` marker `{ digest, tag, major, minor, extractedAt }`. In-progress extraction: sibling `.tmp-{releaseTag}` dir, atomic `rename()` into place.
- Validation project naming (exact): `_devdb_validate_<8 hex chars>`; swept at boot.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/index.ts` | modify | `PgVersionSchema` → int ≥14; `PgBuildStatus`/`PgBuildDto`; `StatusDto.pgBuilds` + engine `"starting"`; event type `pg_builds` |
| `packages/daemon/src/state/schema.ts` | modify | `pg_builds` + `pg_majors` DDL |
| `packages/daemon/src/state/repos.ts` | modify | `PgBuildsRepo`, `PgMajorsRepo`, row types |
| `packages/daemon/src/state/db.ts` | modify | wire new repos into `StateDb` |
| `packages/daemon/src/config.ts` | modify | new envs + derived `pgBuildsDir`/`pgDistribDir` |
| `packages/daemon/src/compute/builds/version.ts` | create | `detectPostgresVersion(pgbin)` via `postgres --version` |
| `packages/daemon/src/compute/builds/registry.ts` | create | `BuildRegistry` — seed/adopt/resolve/pgbinFor/activate/recordRun/gc |
| `packages/daemon/src/compute/builds/pgdistrib.ts` | create | `composePgDistrib()` symlink farm |
| `packages/daemon/src/compute/builds/oci.ts` | create | `OciClient` — token/manifest/blobs/extract |
| `packages/daemon/src/compute/builds/provisioner.ts` | create | `Provisioner` — check/pull pipeline + mutex + events + log channel |
| `packages/daemon/src/compute/builds/validate.ts` | create | `makeValidationRunner()` — gate via real services |
| `packages/daemon/src/engine/configs.ts` | modify | `pg_distrib_dir` → `cfg.pgDistribDir` |
| `packages/daemon/src/services/engine-api.ts` | modify | `ComputesApi.start` gains `pgbinPath`; `runningPgbin()` |
| `packages/daemon/src/compute/manager.ts` | modify | consume `pgbinPath`; record on `RunningCompute`; expose |
| `packages/daemon/src/services/endpoints.ts` | modify | resolve pgbin via `builds` dep; `startWithPgbin`; recordRun |
| `packages/daemon/src/services/projects.ts` | modify | `create()` validates major against registry |
| `packages/daemon/src/services/branches.ts` | modify | `detail()` gains `runningPgVersion` |
| `packages/daemon/src/http/api.ts` | modify | 5 routes + status `pgBuilds` block |
| `packages/daemon/src/mcp/tools.ts` | modify | 4 new tools |
| `packages/daemon/src/index.ts` | modify | boot order: registry → distrib → engine; sweeps; wiring |
| `packages/web/src/api/{client,keys,hooks,events}.ts` | modify | pg-builds API + invalidation |
| `packages/web/src/settings/PgBuildsCard.tsx` | create | Settings card |
| `packages/web/src/pages/{SettingsPage,DashboardPage}.tsx` | modify | card mount; status-driven majors |
| `packages/web/src/drawer/InfoTab.tsx` | modify | restart-to-adopt chip |
| `tests/integration/helpers/fixture-registry.ts` | create | registry:2 + synthetic image seeding |
| `tests/integration/pg-builds.test.ts` | create | happy path / gate failure / restart+downgrade |
| `scripts/pg-pull-smoke.sh` | create | opt-in manual Docker Hub smoke |
| `README.md`, `docker/BINARIES.md` | modify | user docs + inventory note |

Execution order note: Tasks 1→11 are daemon-sequential (each consumes the previous task's exports). Tasks 12–14 (web) depend on Task 10's routes existing. Task 15 needs everything. Task 16 is docs-only.

---

### Task 1: Shared schema groundwork

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `packages/daemon/test/events.test.ts` (whitelist assertion), compile gates of both consumers

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these EXACT names): `PgVersionSchema` (z.number().int().gte(14) — `PgVersion` = `number`), `SUPPORTED_PG_VERSIONS` (unchanged constant, now documented as the *baked fallback list*), `PgBuildStatusSchema`/`PgBuildStatus` (`"downloading" | "validating" | "ready" | "failed"`), `PgBuildDto`, `PgMajorStatusDto`, `StatusDto.pgBuilds: Record<string, PgMajorStatusDto>`, `StatusDto.engine` state union gains `"starting"`, `DevdbEventTypeSchema` gains `"pg_builds"`, `BranchDto.runningPgVersion: string | null`.

- [ ] **Step 1: Write the failing test** — extend the daemon's event-schema whitelist test:

In `packages/daemon/test/events.test.ts`, find the test asserting the `DevdbEventTypeSchema` enum values and extend the expected list:

```ts
it("event type whitelist matches the phase-3+pg-builds contract", () => {
  expect(DevdbEventTypeSchema.options).toEqual([
    "project.created", "project.deleted",
    "branch.created", "branch.updated", "branch.deleted",
    "endpoint.status", "engine.health",
    "pg_builds",
  ]);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm --filter @devdb/daemon test -- events`
Expected: FAIL — received array lacks `"pg_builds"`.

- [ ] **Step 3: Implement the shared changes**

In `packages/shared/src/index.ts` replace lines 5–9 with:

```ts
// Baked fallback list (docker/BINARIES.md inventory). The RUNTIME source of truth for available
// majors is the daemon's BuildRegistry (GET /api/status → pgBuilds; GET /api/pg-builds) — this
// constant exists for UI fallback before status loads and for docs. Order low→high.
export const SUPPORTED_PG_VERSIONS = [14, 15, 16, 17] as const;
// Dynamic-builds phase: majors are registry-validated at runtime (ProjectsService.create), not
// encoded in the type. gte(14) is the floor neon ships; no upper literal so a pulled v18 works.
export const PgVersionSchema = z.number().int().gte(14);
export type PgVersion = z.infer<typeof PgVersionSchema>;
export const DEFAULT_PG_VERSION: PgVersion = 17;
```

Append after the `StatusDto` block (replacing it) and extend events:

```ts
export const PgBuildStatusSchema = z.enum(["downloading", "validating", "ready", "failed"]);
export type PgBuildStatus = z.infer<typeof PgBuildStatusSchema>;

export interface PgBuildDto {
  id: string;
  major: number;
  minor: number | null;          // null until fixup detects it (status "downloading")
  version: string | null;        // "17.5" — render string, null until detected
  source: "baked" | "downloaded";
  releaseTag: string;            // "latest"-resolved tags store the RESOLVED tag when known, else the requested one
  imageDigest: string;           // "sha256:…" — "" for baked rows (not content-addressed)
  status: PgBuildStatus;
  active: boolean;
  inUse: boolean;                // some RUNNING endpoint started from this build's pgbin
  sizeBytes: number | null;
  error: string | null;          // last failure line for status "failed"
  createdAt: string;
}

export interface PgMajorStatusDto {
  activeVersion: string | null;   // "16.9" | null when major has no valid build
  source: "baked" | "downloaded" | null;
  degradedDowngrade: boolean;     // resolution landed below lastRunMinor — never silent (spec decision 10)
  updateAvailable: string | null; // release tag from the LAST explicit check; null = none seen/checked
}

export interface StatusDto {
  version: string;
  healthy: boolean;
  // "starting" added with this phase (deferred widening, handover §5): ManagedProcess reports it
  // between spawn and readyNeedle; the old union silently miscovered that window.
  engine: Record<string, { state: "starting" | "running" | "stopped" | "failed"; pid: number | null }>;
  portRange: { min: number; max: number };
  storage: "none" | "s3" | "azure"; // typed for phase 4; the daemon returns "none" until then
  pgBuilds: Record<string, PgMajorStatusDto>; // keyed by major as string ("16")
}
```

Add `"pg_builds"` to `DevdbEventTypeSchema`'s enum array (after `"engine.health"`), and add to `BranchDto`:

```ts
  // Version string ("16.9") of the build this branch's RUNNING compute was started from;
  // null when stopped or when the daemon can't resolve the path (registry lookup miss).
  runningPgVersion: string | null;
```

- [ ] **Step 4: Verify GREEN + compile ripple**

Run: `pnpm --filter @devdb/shared build && pnpm --filter @devdb/daemon test -- events`
Expected: events test PASS. Then run the FULL daemon suite: `pnpm --filter @devdb/daemon test` — expect compile errors ONLY in `services/dto.ts` (BranchDto now requires `runningPgVersion`) and possibly `http/api.ts` status route (StatusDto.pgBuilds). Patch minimally so this task stays green without pulling later tasks forward:
  - `services/dto.ts` `toBranchDto`: add `runningPgVersion: null,` (Task 8 wires the real value).
  - `http/api.ts` status route: add `pgBuilds: {},` to the returned object (Task 10 wires the real block) and leave a `// Task 10 wires the real registry-backed block` comment.
  - Web suite: `pnpm --filter @devdb/web test` — `StatusDto.pgBuilds` is additive-required; fix any test fixture literals by adding `pgBuilds: {}`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/daemon/src/services/dto.ts packages/daemon/src/http/api.ts packages/daemon/test/events.test.ts packages/web/test
git commit -m "feat(shared): registry-driven PG version typing, PgBuild DTOs, pg_builds event, StatusDto pgBuilds + engine 'starting'"
```

---

### Task 2: State — `pg_builds` / `pg_majors` tables + repos

**Files:**
- Modify: `packages/daemon/src/state/schema.ts`, `packages/daemon/src/state/repos.ts`, `packages/daemon/src/state/db.ts`
- Test: `packages/daemon/test/pg-builds-repo.test.ts` (create)

**Interfaces:**
- Consumes: `PgBuildStatus` from `@devdb/shared` (Task 1).
- Produces: `PgBuildRow` `{ id: string; major: number; minor: number | null; source: "baked"|"downloaded"; releaseTag: string; imageDigest: string; path: string; status: PgBuildStatus; active: boolean; sizeBytes: number | null; error: string | null; createdAt: string }`; `PgBuildsRepo` with `insert(a)`, `byId(id)`, `byDigest(digest)`, `byMajorAndTag(major, tag)`, `list()`, `listByMajor(major)`, `setStatus(id, status, error?)`, `setDetected(id, { minor, sizeBytes })`, `setActiveExclusive(id)` (transactional: clear `active` for the row's major, set on id), `clearActive(major)`, `updatePath(id, path)`, `delete(id)`; `PgMajorsRepo` with `lastRunMinor(major): number | null`, `recordRun(major, minor)` (raise-only), `setLastRunMinor(major, minor)` (unconditional — consented rollback); `StateDb` gains `pgBuilds: PgBuildsRepo; pgMajors: PgMajorsRepo`.

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/pg-builds-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";

function mem() { return openState(":memory:"); }

describe("PgBuildsRepo", () => {
  it("insert + byId round-trips a downloaded row", () => {
    const s = mem();
    const row = s.pgBuilds.insert({
      id: "b1", major: 16, source: "downloaded", releaseTag: "9124",
      imageDigest: "sha256:abc", path: "/data/pg_builds/v16/9124", status: "downloading",
    });
    expect(row).toMatchObject({ id: "b1", major: 16, minor: null, active: false, sizeBytes: null, error: null });
    expect(s.pgBuilds.byId("b1")?.status).toBe("downloading");
  });

  it("setActiveExclusive clears any other active row of the SAME major only", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "a", major: 16, source: "baked", releaseTag: "baked", imageDigest: "", path: "/i/v16", status: "ready" });
    s.pgBuilds.insert({ id: "b", major: 16, source: "downloaded", releaseTag: "9124", imageDigest: "sha256:x", path: "/d/16", status: "ready" });
    s.pgBuilds.insert({ id: "c", major: 17, source: "baked", releaseTag: "baked", imageDigest: "", path: "/i/v17", status: "ready" });
    s.pgBuilds.setActiveExclusive("a");
    s.pgBuilds.setActiveExclusive("c");
    s.pgBuilds.setActiveExclusive("b");
    expect(s.pgBuilds.byId("a")?.active).toBe(false);
    expect(s.pgBuilds.byId("b")?.active).toBe(true);
    expect(s.pgBuilds.byId("c")?.active).toBe(true); // other major untouched
  });

  it("setDetected records minor+size; setStatus failed records error", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "b1", major: 17, source: "downloaded", releaseTag: "t", imageDigest: "sha256:y", path: "/p", status: "downloading" });
    s.pgBuilds.setDetected("b1", { minor: 5, sizeBytes: 1234 });
    s.pgBuilds.setStatus("b1", "failed", "gate: compute never became ready");
    const row = s.pgBuilds.byId("b1")!;
    expect(row).toMatchObject({ minor: 5, sizeBytes: 1234, status: "failed", error: "gate: compute never became ready" });
  });

  it("byMajorAndTag + byDigest find rows; delete removes", () => {
    const s = mem();
    s.pgBuilds.insert({ id: "b1", major: 16, source: "downloaded", releaseTag: "9124", imageDigest: "sha256:z", path: "/p", status: "ready" });
    expect(s.pgBuilds.byMajorAndTag(16, "9124")?.id).toBe("b1");
    expect(s.pgBuilds.byDigest("sha256:z")?.id).toBe("b1");
    s.pgBuilds.delete("b1");
    expect(s.pgBuilds.byId("b1")).toBeNull();
  });
});

describe("PgMajorsRepo", () => {
  it("recordRun is raise-only; setLastRunMinor is unconditional (consented rollback)", () => {
    const s = mem();
    expect(s.pgMajors.lastRunMinor(16)).toBeNull();
    s.pgMajors.recordRun(16, 9);
    s.pgMajors.recordRun(16, 8);          // lower — ignored
    expect(s.pgMajors.lastRunMinor(16)).toBe(9);
    s.pgMajors.recordRun(16, 10);
    expect(s.pgMajors.lastRunMinor(16)).toBe(10);
    s.pgMajors.setLastRunMinor(16, 9);    // consented rollback lowers
    expect(s.pgMajors.lastRunMinor(16)).toBe(9);
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm --filter @devdb/daemon test -- pg-builds-repo`
Expected: FAIL — `s.pgBuilds` is undefined (property does not exist on StateDb).

- [ ] **Step 3: Implement**

`schema.ts` — append inside the DDL template string (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS pg_builds (
  id TEXT PRIMARY KEY,
  major INTEGER NOT NULL,
  minor INTEGER,
  source TEXT NOT NULL,
  release_tag TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'downloading',
  active INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(major, release_tag)
);
CREATE TABLE IF NOT EXISTS pg_majors (
  major INTEGER PRIMARY KEY,
  last_run_minor INTEGER NOT NULL
);
```

(Both are `CREATE TABLE IF NOT EXISTS` — the additive-migration mechanism in `db.ts` needs no new column entries since these are new tables; note this in a one-line comment beside `applyAdditiveMigrations` if you touch it, but do NOT add entries.)

`repos.ts` — add row type + mapper + repos (bottom of file, matching existing style):

```ts
import type { PgBuildStatus } from "@devdb/shared"; // merge into the existing import line

export interface PgBuildRow {
  id: string; major: number; minor: number | null; source: "baked" | "downloaded";
  releaseTag: string; imageDigest: string; path: string; status: PgBuildStatus;
  active: boolean; sizeBytes: number | null; error: string | null; createdAt: string;
}

function pgBuildRow(r: Record<string, unknown>): PgBuildRow {
  return {
    id: r.id as string, major: r.major as number, minor: (r.minor as number | null) ?? null,
    // Row boundary: source/status are constrained by every write path in this file (the only
    // writers), same narrowing rationale as branchRow's createdBy above.
    source: r.source as PgBuildRow["source"], releaseTag: r.release_tag as string,
    imageDigest: r.image_digest as string, path: r.path as string,
    status: r.status as PgBuildStatus, active: (r.active as number) === 1,
    sizeBytes: (r.size_bytes as number | null) ?? null, error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export class PgBuildsRepo {
  constructor(private db: Database.Database) {}
  insert(a: {
    id: string; major: number; source: "baked" | "downloaded"; releaseTag: string;
    imageDigest: string; path: string; status: PgBuildStatus; minor?: number | null; sizeBytes?: number | null;
  }): PgBuildRow {
    this.db.prepare(
      `INSERT INTO pg_builds (id, major, minor, source, release_tag, image_digest, path, status, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.major, a.minor ?? null, a.source, a.releaseTag, a.imageDigest, a.path, a.status, a.sizeBytes ?? null);
    return this.byId(a.id)!;
  }
  byId(id: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE id = ?").get(id);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  byDigest(digest: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE image_digest = ? AND image_digest != ''").get(digest);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  byMajorAndTag(major: number, tag: string): PgBuildRow | null {
    const r = this.db.prepare("SELECT * FROM pg_builds WHERE major = ? AND release_tag = ?").get(major, tag);
    return r ? pgBuildRow(r as Record<string, unknown>) : null;
  }
  list(): PgBuildRow[] {
    return this.db.prepare("SELECT * FROM pg_builds ORDER BY major, created_at").all()
      .map((r) => pgBuildRow(r as Record<string, unknown>));
  }
  listByMajor(major: number): PgBuildRow[] {
    return this.db.prepare("SELECT * FROM pg_builds WHERE major = ? ORDER BY created_at").all(major)
      .map((r) => pgBuildRow(r as Record<string, unknown>));
  }
  setStatus(id: string, status: PgBuildStatus, error?: string | null): void {
    this.db.prepare("UPDATE pg_builds SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
  }
  setDetected(id: string, a: { minor: number; sizeBytes: number | null }): void {
    this.db.prepare("UPDATE pg_builds SET minor = ?, size_bytes = ? WHERE id = ?").run(a.minor, a.sizeBytes, id);
  }
  updatePath(id: string, path: string): void {
    this.db.prepare("UPDATE pg_builds SET path = ? WHERE id = ?").run(path, id);
  }
  // Transactional: at most one active row per major, ever (spec: "one atomic flip within the major").
  setActiveExclusive(id: string): void {
    const tx = this.db.transaction(() => {
      const row = this.byId(id);
      if (!row) throw new Error(`pg_build ${id} not found`);
      this.db.prepare("UPDATE pg_builds SET active = 0 WHERE major = ?").run(row.major);
      this.db.prepare("UPDATE pg_builds SET active = 1 WHERE id = ?").run(id);
    });
    tx();
  }
  clearActive(major: number): void {
    this.db.prepare("UPDATE pg_builds SET active = 0 WHERE major = ?").run(major);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM pg_builds WHERE id = ?").run(id);
  }
}

export class PgMajorsRepo {
  constructor(private db: Database.Database) {}
  lastRunMinor(major: number): number | null {
    const r = this.db.prepare("SELECT last_run_minor FROM pg_majors WHERE major = ?").get(major) as
      | { last_run_minor: number } | undefined;
    return r?.last_run_minor ?? null;
  }
  // Raise-only high-water mark: an endpoint START of version major.minor. Never lowers (the
  // downgrade guard compares against this; only setLastRunMinor — consented rollback — lowers).
  recordRun(major: number, minor: number): void {
    this.db.prepare(
      `INSERT INTO pg_majors (major, last_run_minor) VALUES (?, ?)
       ON CONFLICT(major) DO UPDATE SET last_run_minor = MAX(last_run_minor, excluded.last_run_minor)`,
    ).run(major, minor);
  }
  setLastRunMinor(major: number, minor: number): void {
    this.db.prepare(
      `INSERT INTO pg_majors (major, last_run_minor) VALUES (?, ?)
       ON CONFLICT(major) DO UPDATE SET last_run_minor = excluded.last_run_minor`,
    ).run(major, minor);
  }
}
```

`db.ts` — extend `StateDb` + `openState` return with `pgBuilds: new PgBuildsRepo(raw), pgMajors: new PgMajorsRepo(raw)` (and the interface fields + imports).

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @devdb/daemon test -- pg-builds-repo`
Expected: PASS (5 tests). Full suite still green: `pnpm --filter @devdb/daemon test`.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/state packages/daemon/test/pg-builds-repo.test.ts
git commit -m "feat(state): pg_builds/pg_majors tables + repos (raise-only lastRunMinor high-water)"
```

---

### Task 3: Config — registry envs + derived dirs

**Files:**
- Modify: `packages/daemon/src/config.ts`
- Test: `packages/daemon/test/config.test.ts` (additions)

**Interfaces:**
- Produces: `DevdbConfig.pgRegistryBase: string` (default `https://registry-1.docker.io`, must be http(s) URL, no trailing slash), `DevdbConfig.pgImageTemplate: string` (default `neondatabase/compute-node-v{major}`, must contain the literal `{major}`), `DevdbConfig.pgBuildsDir: string` (= `join(dataDir, "pg_builds")`), `DevdbConfig.pgDistribDir: string` (= `join(dataDir, "pg_distrib")`).

- [ ] **Step 1: Failing tests** — append to `packages/daemon/test/config.test.ts` (mirror the existing test style — build a full valid env object the way neighboring tests do, then override):

```ts
it("pg build provisioning defaults + derived dirs", () => {
  const cfg = loadConfig(validEnv()); // reuse the file's existing valid-env helper/fixture name
  expect(cfg.pgRegistryBase).toBe("https://registry-1.docker.io");
  expect(cfg.pgImageTemplate).toBe("neondatabase/compute-node-v{major}");
  expect(cfg.pgBuildsDir).toBe(`${cfg.dataDir}/pg_builds`);
  expect(cfg.pgDistribDir).toBe(`${cfg.dataDir}/pg_distrib`);
});

it("DEVDB_PG_REGISTRY_BASE must be an http(s) URL; trailing slash stripped", () => {
  expect(() => loadConfig({ ...validEnv(), DEVDB_PG_REGISTRY_BASE: "ftp://nope" })).toThrow(/DEVDB_PG_REGISTRY_BASE/);
  expect(loadConfig({ ...validEnv(), DEVDB_PG_REGISTRY_BASE: "http://pgregistry:5000/" }).pgRegistryBase)
    .toBe("http://pgregistry:5000");
});

it("DEVDB_PG_IMAGE_TEMPLATE must contain {major}", () => {
  expect(() => loadConfig({ ...validEnv(), DEVDB_PG_IMAGE_TEMPLATE: "neondatabase/compute-node" })).toThrow(/\{major\}/);
});
```

(If `config.test.ts` uses inline env literals instead of a helper, copy one test's full literal — do not invent a helper that isn't there.)

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test -- config` → FAIL (`pgRegistryBase` undefined / no throw).

- [ ] **Step 3: Implement** — in `config.ts`: add to `EnvSchema`:

```ts
  DEVDB_PG_REGISTRY_BASE: z.string().optional(),
  DEVDB_PG_IMAGE_TEMPLATE: z.string().optional(),
```

Add to `DevdbConfig`: `pgRegistryBase: string; pgImageTemplate: string; pgBuildsDir: string; pgDistribDir: string;`. In `loadConfig` before the return:

```ts
  // Dynamic PG builds (spec 2026-07-04): overrides exist for mirrors/air-gap AND for the hermetic
  // integration fixture registry. http:// is allowed deliberately (the fixture, an in-network
  // registry:2, has no TLS) — the DEFAULT stays https to Docker Hub.
  const pgRegistryBase = (e.DEVDB_PG_REGISTRY_BASE?.trim() || "https://registry-1.docker.io").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(pgRegistryBase)) {
    throw new Error(`DEVDB_PG_REGISTRY_BASE must be an http(s) URL, got: ${pgRegistryBase}`);
  }
  const pgImageTemplate = e.DEVDB_PG_IMAGE_TEMPLATE?.trim() || "neondatabase/compute-node-v{major}";
  if (!pgImageTemplate.includes("{major}")) {
    throw new Error(`DEVDB_PG_IMAGE_TEMPLATE must contain the literal {major} placeholder, got: ${pgImageTemplate}`);
  }
```

and in the returned object: `pgRegistryBase, pgImageTemplate, pgBuildsDir: join(e.DEVDB_DATA_DIR, "pg_builds"), pgDistribDir: join(e.DEVDB_DATA_DIR, "pg_distrib"),` (add `import { join } from "node:path";`).

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- config` → PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/config.ts packages/daemon/test/config.test.ts
git commit -m "feat(config): DEVDB_PG_REGISTRY_BASE / DEVDB_PG_IMAGE_TEMPLATE + derived pg_builds/pg_distrib dirs"
```

---

### Task 4: `version.ts` + `BuildRegistry`

**Files:**
- Create: `packages/daemon/src/compute/builds/version.ts`, `packages/daemon/src/compute/builds/registry.ts`
- Test: `packages/daemon/test/pg-build-registry.test.ts` (create)

**Interfaces:**
- Consumes: `StateDb.pgBuilds`/`pgMajors` (Task 2), `DevdbConfig.pgInstallDir`/`pgBuildsDir` (Task 3), `DevdbError` from `services/errors.js`.
- Produces:
  - `detectPostgresVersion(pgbinPath: string): Promise<{ major: number; minor: number }>` — spawns `<pgbinPath> --version`, parses `postgres (PostgreSQL) 16.9` (also accepts suffixes like `16.9 (Debian…)`); rejects on unparseable output or spawn failure.
  - `class BuildRegistry` constructor `deps: { state: StateDb; pgInstallDir: string; pgBuildsDir: string; detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>; logger: { info(m: string): void; error(m: string, e?: unknown): void } }` and methods:
    - `seedBaked(): Promise<void>` — scan `pgInstallDir` for `v<digits>` dirs (SKIP `vanilla_*`), detect version once per boot, upsert rows `{ id: "baked-v{major}", source: "baked", releaseTag: "baked", imageDigest: "", status: "ready", path: <dir> }`.
    - `adoptVolumeBuilds(): Promise<void>` — scan `pgBuildsDir/v*/*/build.json`; re-insert missing registry rows from markers (id `dl-{major}-{tag}`); rows whose dir or `bin/postgres` vanished → `setStatus(id, "failed", "build directory missing at boot")`.
    - `sweepTmp(): Promise<number>` — `rm -rf` every `pgBuildsDir/v*/.tmp-*`.
    - `resolveActives(): { degraded: number[] }` — per major: candidates = rows `status === "ready"` AND dir-valid (baked rows trusted); winner = highest `minor` (tie → `source === "baked"`); `setActiveExclusive(winner)` (or `clearActive(major)` if none); if winner.minor < `lastRunMinor(major)` → major flagged degraded (kept in a private `Set<number>`, exposed via `degradedMajors()`).
    - `pgbinFor(major: number): { path: string; version: string; buildId: string }` — active row for major or throw `DevdbError(409, "no usable Postgres {major} build — pull one via POST /api/pg-builds/pull or pick an installed major")`; `path` = `join(row.path, "bin", "postgres")`.
    - `versionForPgbin(pgbinPath: string): string | null` — reverse lookup by row path prefix.
    - `installedMajors(): number[]` — majors with ≥1 `ready` row.
    - `activate(id: string, opts?: { consented?: boolean }): PgBuildRow` — row must be `ready` else `DevdbError(409, …)`; `setActiveExclusive`; when the new active's minor < lastRunMinor AND `opts.consented` → `setLastRunMinor(major, minor)` + clear the degraded flag; when lower and NOT consented → `DevdbError(409, "activating {v} would downgrade below the last-run {lr} — pass consented:true (see docs on extension-catalog downgrades)")`.
    - `recordRun(major: number, minor: number): void` — delegate to `pgMajors.recordRun`.
    - `degradedMajors(): number[]`.
    - `list(): PgBuildRow[]` — pass-through of `state.pgBuilds.list()` (Tasks 9/10 consume it).
    - `assertRemovable(id: string, runningPgbins: string[]): PgBuildRow` — throws `DevdbError(409)` for active row, for `source === "baked"`, or when any running pgbin lives under `row.path`.
    - `gcCandidates(): PgBuildRow[]` — per major, `ready` downloaded rows that are neither active nor the single newest non-active (keep active + one previous).

- [ ] **Step 1: Write the failing tests** — `packages/daemon/test/pg-build-registry.test.ts`. Use REAL temp dirs (`mkdtemp` in `os.tmpdir()`) with tiny fake layouts and a FAKE `detectVersion` keyed by path — no `as any`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openState } from "../src/state/db.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";

const dirs: string[] = [];
async function scaffold(): Promise<{ install: string; builds: string }> {
  const root = await mkdtemp(join(tmpdir(), "devdb-reg-"));
  dirs.push(root);
  const install = join(root, "pg_install");
  const builds = join(root, "pg_builds");
  await mkdir(install, { recursive: true });
  await mkdir(builds, { recursive: true });
  return { install, builds };
}
async function fakeInstallDir(base: string, name: string): Promise<string> {
  const d = join(base, name);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  return d;
}
async function fakeVolumeBuild(builds: string, major: number, tag: string, marker: object): Promise<string> {
  const d = join(builds, `v${major}`, tag);
  await mkdir(join(d, "bin"), { recursive: true });
  await writeFile(join(d, "bin", "postgres"), "#!/bin/sh\n");
  await writeFile(join(d, "build.json"), JSON.stringify(marker));
  return d;
}
const noopLogger = { info: () => {}, error: () => {} };
function makeRegistry(a: { install: string; builds: string; versions: Record<string, { major: number; minor: number }> }) {
  const state = openState(":memory:");
  const registry = new BuildRegistry({
    state, pgInstallDir: a.install, pgBuildsDir: a.builds, logger: noopLogger,
    detectVersion: async (pgbin) => {
      const hit = Object.entries(a.versions).find(([prefix]) => pgbin.startsWith(prefix));
      if (!hit) throw new Error(`no fake version for ${pgbin}`);
      return hit[1];
    },
  });
  return { state, registry };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("BuildRegistry", () => {
  it("seedBaked scans v* dirs, skips vanilla_*, and resolveActives picks baked when alone", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    await fakeInstallDir(install, "vanilla_v17");
    const { registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    expect(registry.installedMajors()).toEqual([16]);
    const { degraded } = registry.resolveActives();
    expect(degraded).toEqual([]);
    expect(registry.pgbinFor(16)).toMatchObject({ path: join(v16, "bin", "postgres"), version: "16.9" });
  });

  it("newest valid minor wins regardless of source; tie goes to baked", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const newer = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const same = await fakeVolumeBuild(builds, 16, "8464", { digest: "sha256:b", tag: "8464", major: 16, minor: 9, extractedAt: "x" });
    const { registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [newer]: { major: 16, minor: 10 }, [same]: { major: 16, minor: 9 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    expect(registry.pgbinFor(16).version).toBe("16.10"); // downloaded newer wins
    // Force the tie: activate the equal-minor downloaded row is NOT what resolve does — resolve prefers baked on tie:
    expect(registry.versionForPgbin(registry.pgbinFor(16).path)).toBe("16.10");
  });

  it("volume build with vanished dir is failed at adopt; resolution falls back and flags downgrade vs lastRunMinor", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const gone = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [gone]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    state.pgMajors.recordRun(16, 10);              // 16.10 has RUN
    await rm(gone, { recursive: true, force: true }); // volume build lost
    await registry.adoptVolumeBuilds();             // re-scan (as a fresh boot would)
    const { degraded } = registry.resolveActives();
    expect(degraded).toEqual([16]);                 // silent downgrade forbidden — flagged
    expect(registry.pgbinFor(16).version).toBe("16.9");
    expect(registry.degradedMajors()).toEqual([16]);
  });

  it("activate: ready-only, exclusive, downgrade needs consent (which lowers the high-water + clears flag)", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const dl = await fakeVolumeBuild(builds, 16, "9124", { digest: "sha256:a", tag: "9124", major: 16, minor: 10, extractedAt: "x" });
    const { state, registry } = makeRegistry({ install, builds, versions: { [v16]: { major: 16, minor: 9 }, [dl]: { major: 16, minor: 10 } } });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    state.pgMajors.recordRun(16, 10);
    const baked = state.pgBuilds.byId("baked-v16")!;
    expect(() => registry.activate(baked.id)).toThrow(/downgrade/);
    const after = registry.activate(baked.id, { consented: true });
    expect(after.active).toBe(true);
    expect(state.pgMajors.lastRunMinor(16)).toBe(9);
    expect(registry.degradedMajors()).toEqual([]);
  });

  it("assertRemovable rejects active, baked, and in-use rows; gcCandidates keeps active + newest previous", async () => {
    const { install, builds } = await scaffold();
    const v16 = await fakeInstallDir(install, "v16");
    const b1 = await fakeVolumeBuild(builds, 16, "t1", { digest: "sha256:1", tag: "t1", major: 16, minor: 10, extractedAt: "x" });
    const b2 = await fakeVolumeBuild(builds, 16, "t2", { digest: "sha256:2", tag: "t2", major: 16, minor: 11, extractedAt: "x" });
    const b3 = await fakeVolumeBuild(builds, 16, "t3", { digest: "sha256:3", tag: "t3", major: 16, minor: 12, extractedAt: "x" });
    const { state, registry } = makeRegistry({
      install, builds,
      versions: { [v16]: { major: 16, minor: 9 }, [b1]: { major: 16, minor: 10 }, [b2]: { major: 16, minor: 11 }, [b3]: { major: 16, minor: 12 } },
    });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives(); // active = 16.12 (t3)
    expect(() => registry.assertRemovable(state.pgBuilds.byMajorAndTag(16, "t3")!.id, [])).toThrow(/active/);
    expect(() => registry.assertRemovable("baked-v16", [])).toThrow(/baked/);
    expect(() => registry.assertRemovable(
      state.pgBuilds.byMajorAndTag(16, "t2")!.id,
      [join(b2, "bin", "postgres")],
    )).toThrow(/running endpoint/);
    // keep active (t3) + newest previous (t2) → only t1 is GC-eligible
    expect(registry.gcCandidates().map((r) => r.releaseTag)).toEqual(["t1"]);
  });
});
```

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test -- pg-build-registry` → FAIL (module not found).

- [ ] **Step 3: Implement `version.ts`**

```ts
import { execFile } from "node:child_process";

// Parses `postgres (PostgreSQL) 16.9` and Debian-suffixed variants. Spawn (not shell) — the
// path came from OUR registry rows, but never interpolate paths into a shell string anyway.
export function detectPostgresVersion(pgbinPath: string): Promise<{ major: number; minor: number }> {
  return new Promise((resolve, reject) => {
    execFile(pgbinPath, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(new Error(`${pgbinPath} --version failed: ${err.message}`));
      const m = /PostgreSQL\)\s+(\d+)\.(\d+)/.exec(stdout);
      if (!m) return reject(new Error(`unparseable postgres version output: ${stdout.trim().slice(0, 200)}`));
      resolve({ major: Number(m[1]), minor: Number(m[2]) });
    });
  });
}
```

**Implement `registry.ts`** — the resolution core. Key excerpts (write the whole class per the Interfaces block; these are the load-bearing parts):

```ts
import { readdir, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DevdbError } from "../../services/errors.js";
import type { StateDb } from "../../state/db.js";
import type { PgBuildRow } from "../../state/repos.js";

interface BuildMarker { digest: string; tag: string; major: number; minor: number; extractedAt: string }

export class BuildRegistry {
  private degraded = new Set<number>();
  constructor(private deps: {
    state: StateDb; pgInstallDir: string; pgBuildsDir: string;
    detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>;
    logger: { info(m: string): void; error(m: string, e?: unknown): void };
  }) {}

  async seedBaked(): Promise<void> {
    const entries = await readdir(this.deps.pgInstallDir).catch(() => [] as string[]);
    for (const name of entries) {
      const m = /^v(\d+)$/.exec(name); // vanilla_v17 (storcon-internal) deliberately excluded
      if (!m) continue;
      const path = join(this.deps.pgInstallDir, name);
      const id = `baked-${name}`;
      if (this.deps.state.pgBuilds.byId(id)) continue; // minor of a BAKED dir can't change without a new image → new container
      const { major, minor } = await this.deps.detectVersion(join(path, "bin", "postgres"));
      this.deps.state.pgBuilds.insert({ id, major, minor, source: "baked", releaseTag: "baked", imageDigest: "", path, status: "ready" });
    }
  }

  async adoptVolumeBuilds(): Promise<void> {
    const majors = await readdir(this.deps.pgBuildsDir).catch(() => [] as string[]);
    const seenPaths = new Set<string>();
    for (const vdir of majors) {
      if (!/^v\d+$/.test(vdir)) continue;
      const tags = await readdir(join(this.deps.pgBuildsDir, vdir)).catch(() => [] as string[]);
      for (const tag of tags) {
        if (tag.startsWith(".tmp-")) continue;
        const path = join(this.deps.pgBuildsDir, vdir, tag);
        seenPaths.add(path);
        const id = `dl-${vdir.slice(1)}-${tag}`;
        if (this.deps.state.pgBuilds.byId(id)) continue;
        try {
          const marker = JSON.parse(await readFile(join(path, "build.json"), "utf8")) as BuildMarker;
          await access(join(path, "bin", "postgres"));
          // Markers are self-describing — this recovers registry rows even from a lost SQLite (spec §Boot).
          this.deps.state.pgBuilds.insert({
            id, major: marker.major, minor: marker.minor, source: "downloaded",
            releaseTag: marker.tag, imageDigest: marker.digest, path, status: "ready",
          });
        } catch (e) {
          this.deps.logger.error(`skipping unadoptable volume build at ${path}`, e);
        }
      }
    }
    // Rows whose dir vanished (user pruned /data/pg_builds): presence check, not a 250MB re-hash —
    // the atomic-rename install discipline is what makes presence trustworthy (spec §Boot step 2).
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.source !== "downloaded" || row.status !== "ready") continue;
      if (!seenPaths.has(row.path)) {
        this.deps.state.pgBuilds.setStatus(row.id, "failed", "build directory missing at boot");
      }
    }
  }

  resolveActives(): { degraded: number[] } {
    this.degraded.clear();
    const byMajor = new Map<number, PgBuildRow[]>();
    for (const row of this.deps.state.pgBuilds.list()) {
      if (row.status !== "ready" || row.minor === null) continue;
      (byMajor.get(row.major) ?? byMajor.set(row.major, []).get(row.major)!).push(row);
    }
    for (const [major, rows] of byMajor) {
      // Newest valid minor wins regardless of source; tie → baked (spec §Boot step 4).
      rows.sort((a, b) => (b.minor! - a.minor!) || (a.source === "baked" ? -1 : 1) - (b.source === "baked" ? -1 : 1));
      const winner = rows[0]!;
      this.deps.state.pgBuilds.setActiveExclusive(winner.id);
      const lastRun = this.deps.state.pgMajors.lastRunMinor(major);
      if (lastRun !== null && winner.minor! < lastRun) this.degraded.add(major); // NEVER silent (decision 10)
    }
    return { degraded: [...this.degraded].sort((a, b) => a - b) };
  }
  // …pgbinFor / versionForPgbin / installedMajors / activate / recordRun / degradedMajors /
  //   assertRemovable / gcCandidates / sweepTmp exactly per the Interfaces block above.
}
```

Implementation notes the engineer must honor: `pgbinFor` reads the ACTIVE `ready` row (`row.active && row.status === "ready"`); `activate`'s non-consented downgrade check compares `row.minor` to `lastRunMinor(row.major)`; `sweepTmp` globs `v*/.tmp-*` with `rm(p, { recursive: true, force: true })` and returns the count; `assertRemovable`'s in-use check is `runningPgbins.some((p) => p.startsWith(row.path + "/"))`; `gcCandidates` sorts ready+downloaded non-active rows per major by minor desc and returns `slice(1)` (keep newest previous only).

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- pg-build-registry` → PASS (5). Full daemon suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/compute/builds packages/daemon/test/pg-build-registry.test.ts
git commit -m "feat(builds): BuildRegistry — seed/adopt/resolve with never-silent downgrade guard + version detection"
```

---

### Task 5: Composed `pg_distrib` symlink dir + pageserver config seam

**Files:**
- Create: `packages/daemon/src/compute/builds/pgdistrib.ts`
- Modify: `packages/daemon/src/engine/configs.ts:27`
- Test: `packages/daemon/test/pgdistrib.test.ts` (create), `packages/daemon/test/api.test.ts`/config-related assertions if any assert the toml (grep `pg_distrib_dir` in tests first)

**Interfaces:**
- Consumes: `BuildRegistry` rows via a plain param (no registry dependency — takes `Array<{ major: number; path: string }>`).
- Produces: `composePgDistrib(a: { distribDir: string; pgInstallDir: string; downloadedOnly: Array<{ major: number; path: string }> }): Promise<void>`.

**Semantics (spec §3 refinement, verbatim):** majors that exist baked ALWAYS symlink to the baked dir — minors never perturb the storage engine's binaries; only majors with NO baked dir symlink to their downloaded build (WAL-redo for a new major necessarily uses downloaded bits). Rebuilt at boot (before the pageserver starts) and on activation.

- [ ] **Step 1: Failing tests** — `packages/daemon/test/pgdistrib.test.ts`:

```ts
import { mkdtemp, mkdir, rm, readlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composePgDistrib } from "../src/compute/builds/pgdistrib.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function scaffold() {
  const root = await mkdtemp(join(tmpdir(), "devdb-distrib-"));
  dirs.push(root);
  const install = join(root, "pg_install");
  for (const v of ["v16", "v17", "vanilla_v17"]) await mkdir(join(install, v), { recursive: true });
  const dl18 = join(root, "pg_builds", "v18", "9200");
  await mkdir(dl18, { recursive: true });
  return { root, install, dl18, distrib: join(root, "pg_distrib") };
}

describe("composePgDistrib", () => {
  it("baked majors always point at baked dirs; downloaded-only majors at their build; vanilla excluded", async () => {
    const { install, dl18, distrib } = await scaffold();
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 18, path: dl18 }] });
    expect(await readlink(join(distrib, "v16"))).toBe(join(install, "v16"));
    expect(await readlink(join(distrib, "v17"))).toBe(join(install, "v17"));
    expect(await readlink(join(distrib, "v18"))).toBe(dl18);
    expect((await readdir(distrib)).sort()).toEqual(["v16", "v17", "v18"]);
  });

  it("recompose replaces stale links atomically (no ENOENT window) and drops removed majors", async () => {
    const { install, dl18, distrib } = await scaffold();
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 18, path: dl18 }] });
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [] });
    expect((await readdir(distrib)).sort()).toEqual(["v16", "v17"]);
    // A baked major that ALSO has a downloaded build still points at BAKED — the invariant:
    await composePgDistrib({ distribDir: distrib, pgInstallDir: install, downloadedOnly: [{ major: 17, path: dl18 }] });
    expect(await readlink(join(distrib, "v17"))).toBe(join(install, "v17"));
  });
});
```

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test -- pgdistrib` → FAIL (module not found).

- [ ] **Step 3: Implement `pgdistrib.ts`**

```ts
import { mkdir, readdir, rm, symlink, rename } from "node:fs/promises";
import { join } from "node:path";

// Composed pg_distrib_dir for the pageserver (spec §Architecture): baked majors ALWAYS win a
// slot (minors must never perturb the storage engine's binaries at runtime); only majors absent
// from the baked install get a downloaded target — that's what gives a pulled v18 WAL-redo bits.
// Callers: index.ts boot (BEFORE EngineRuntime.start() writes/reads pageserver.toml) and
// Provisioner activation. Per-entry atomicity: symlink to a temp name then rename() over the
// slot — a pageserver spawning a walredo mid-recompose reads either the old or the new target,
// never a missing one. oracle: pg_distrib_dir per-major resolution is upstream pageserver
// behavior — see engine/configs.ts pageserverToml's oracle comment (src/daemon/pageserver/mod.rs:67-96).
export async function composePgDistrib(a: {
  distribDir: string; pgInstallDir: string; downloadedOnly: Array<{ major: number; path: string }>;
}): Promise<void> {
  await mkdir(a.distribDir, { recursive: true });
  const targets = new Map<string, string>();
  for (const name of await readdir(a.pgInstallDir)) {
    if (/^v\d+$/.test(name)) targets.set(name, join(a.pgInstallDir, name)); // vanilla_* excluded
  }
  for (const d of a.downloadedOnly) {
    const slot = `v${d.major}`;
    if (!targets.has(slot)) targets.set(slot, d.path); // baked always wins its slot
  }
  for (const [slot, target] of targets) {
    const tmp = join(a.distribDir, `.${slot}.tmp`);
    await rm(tmp, { force: true });
    await symlink(target, tmp);
    await rename(tmp, join(a.distribDir, slot)); // atomic replace over existing symlink
  }
  for (const existing of await readdir(a.distribDir)) {
    if (/^v\d+$/.test(existing) && !targets.has(existing)) {
      await rm(join(a.distribDir, existing), { force: true });
    }
  }
}
```

**Modify `engine/configs.ts:27`** — change `pg_distrib_dir = ${tomlString(cfg.pgInstallDir)}` to `pg_distrib_dir = ${tomlString(cfg.pgDistribDir)}` and extend the function's oracle comment with one line: `// pg_distrib_dir points at the daemon-composed symlink dir (builds/pgdistrib.ts) — baked majors stay baked; downloaded-only majors resolve for walredo.` Then `grep -rn "pg_distrib_dir\|pgInstallDir" packages/daemon/test/` and update any test asserting the old toml value to expect `cfg.pgDistribDir`.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- pgdistrib` PASS; full suite green (fix any toml assertion you found).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/compute/builds/pgdistrib.ts packages/daemon/src/engine/configs.ts packages/daemon/test
git commit -m "feat(builds): composed pg_distrib symlink dir; pageserver pg_distrib_dir now daemon-composed"
```

---

### Task 6: `OciClient` — anonymous registry-v2 pull + extract

**Files:**
- Create: `packages/daemon/src/compute/builds/oci.ts`
- Test: `packages/daemon/test/oci-client.test.ts` (create)

**Interfaces:**
- Consumes: `DevdbConfig.pgRegistryBase` (passed in), node built-ins only.
- Produces:
  - `interface OciPuller { resolveDigest(repository: string, tag: string): Promise<{ digest: string }>; pullPrefix(a: { repository: string; digest: string; destDir: string; prefix: "usr/local/"; onProgress?: (line: string) => void }): Promise<void> }` — the interface `Provisioner` (Task 7) depends on and tests fake.
  - `class OciClient implements OciPuller`, constructor `(opts: { registryBase: string; arch?: string })` (arch defaults from `process.arch`: `arm64→arm64`, `x64→amd64`).

**Protocol facts to implement against (registry v2, stable + documented):**
1. `GET {base}/v2/{repo}/manifests/{tagOrDigest}` with `Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json`.
2. On `401` with `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` → `GET realm?service=…&scope=…` → `{ token }` → retry with `Authorization: Bearer …`. (registry:2 fixture never 401s — the token path only triggers for Docker Hub. Cache the token per repo for the client instance's lifetime.)
3. If the response is a manifest LIST/index: pick the entry with `platform.os === "linux" && platform.architecture === arch`; fetch THAT manifest by its digest. If it's a single manifest already: use directly. `resolveDigest` returns the `Docker-Content-Digest` header (fall back to sha256 of the canonical body bytes if absent).
4. Layers: for each `manifest.layers[]` entry (media type `…tar.gzip`/`…tar+gzip`): `GET {base}/v2/{repo}/blobs/{layer.digest}` — stream through BOTH a sha256 hash (of the COMPRESSED bytes — content-address check: computed hex must equal the digest or throw `sha256 mismatch for layer …`) and `zlib.createGunzip()` into a spool file `layer-N.tar` under a `mkdtemp` spool dir.
5. Apply layers IN ORDER into `destDir`: list pass `tar -tf layer-N.tar` (execFile, capture stdout); collect entries under `prefix`; for whiteout basenames `.wh..wh..opq` → `rm -rf` all CONTENTS of the corresponding dest dir; `.wh.<name>` → `rm -rf` dest path `<dir>/<name>`; if the layer has NO entries under prefix → skip its extract pass (GNU tar exits 2 when asked for members it doesn't have). Extract pass: `execFile("tar", ["-xf", spool, "-C", extractRoot, prefix.replace(/\/$/, "")])`. After all layers: `rename(join(extractRoot, "usr/local"), destDir)` — where `extractRoot` is a second mkdtemp dir; the caller's `destDir` must not pre-exist.
6. Delete spool + extractRoot in `finally`.
7. Every fetch: `signal: AbortSignal.timeout(120_000)` (blobs: `600_000`); non-2xx → throw with status + first 200 chars of body.

- [ ] **Step 1: Failing tests** — `packages/daemon/test/oci-client.test.ts` against an in-process `node:http` fixture registry. The fixture serves: token endpoint (asserting the client only calls it after a 401 challenge), a manifest INDEX with amd64+arm64 entries, per-arch manifests, and two gzipped tar layer blobs built in-test with `tar -c` from scaffolded temp dirs (layer 2 contains a `usr/local/.wh.drop-me` whiteout for a file layer 1 created, plus new content). Assertions:

```ts
// Build layers with system tar from two scaffold dirs:
//   layer1/usr/local/bin/postgres        ("#!/bin/sh\necho one\n")
//   layer1/usr/local/drop-me             ("to be whited out")
//   layer1/usr/other/ignored             (outside prefix — must NOT land in destDir)
//   layer2/usr/local/.wh.drop-me         (whiteout marker file, content irrelevant)
//   layer2/usr/local/share/extension/neon.control
it("pullPrefix extracts usr/local only, applies whiteouts, verifies layer sha256", async () => {
  const { client, destDir } = await startFixtureAndClient(); // helper in this test file
  const { digest } = await client.resolveDigest("neondatabase/compute-node-v17", "latest");
  await client.pullPrefix({ repository: "neondatabase/compute-node-v17", digest, destDir, prefix: "usr/local/" });
  await expect(access(join(destDir, "bin", "postgres"))).resolves.toBeUndefined();
  await expect(access(join(destDir, "share", "extension", "neon.control"))).resolves.toBeUndefined();
  await expect(access(join(destDir, "drop-me"))).rejects.toThrow();      // whiteout applied
  await expect(access(join(destDir, "other"))).rejects.toThrow();        // outside prefix
});

it("selects the manifest matching this arch from an index", async () => { /* fixture records which per-arch manifest was fetched; assert it matches the client's arch option ("arm64" passed explicitly in the test) */ });

it("rejects on layer sha mismatch", async () => { /* fixture flips one byte in a blob response; expect pullPrefix to reject /sha256 mismatch/ and destDir to NOT exist */ });

it("performs the bearer-token dance only when challenged", async () => { /* fixture variant that 401s once with WWW-Authenticate; assert token endpoint hit exactly once and pull succeeds; the no-challenge fixture asserts zero token hits */ });
```

Write these four tests COMPLETELY (the fixture helper is ~80 lines: `http.createServer` routing `/token`, `/v2/:repo/manifests/:ref`, `/v2/:repo/blobs/:digest`; layers pre-built in `beforeAll` via `execFile("tar", ["-czf", …])` and hashed with `createHash("sha256")`).

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test -- oci-client` → FAIL (module not found).

- [ ] **Step 3: Implement `oci.ts`** per the protocol facts above (~230 lines). Structure:

```ts
export interface OciPuller { /* per Interfaces block */ }

export class OciClient implements OciPuller {
  private tokens = new Map<string, string>(); // repo → bearer
  constructor(private opts: { registryBase: string; arch?: string }) {}
  private arch(): string { return this.opts.arch ?? (process.arch === "arm64" ? "arm64" : "amd64"); }
  private async authedFetch(repo: string, url: string, accept?: string): Promise<Response> { /* try; on 401 parse WWW-Authenticate → token → retry once */ }
  async resolveDigest(repository: string, tag: string): Promise<{ digest: string }> { /* manifest GET; if index → select arch entry, return ITS digest; else Docker-Content-Digest header ?? sha256(body) */ }
  async pullPrefix(a: { repository: string; digest: string; destDir: string; prefix: "usr/local/"; onProgress?: (line: string) => void }): Promise<void> { /* manifest by digest (if index → arch select again); spool+verify+gunzip each layer; list/whiteout/extract in order; rename usr/local → destDir; finally cleanup */ }
}
```

`onProgress` lines (exact format — the provisioner forwards them to the log channel): `layer 2/7: 45.3 MB / 112.0 MB` per ~5 MB chunk, and `layer 2/7: verified sha256` on completion.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- oci-client` → PASS (4). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/compute/builds/oci.ts packages/daemon/test/oci-client.test.ts
git commit -m "feat(builds): OciClient — anonymous registry-v2 pull, arch select, sha-verified layers, whiteout-aware usr/local extraction (zero new deps)"
```

---

### Task 7: `Provisioner` — check / pull pipeline

**Files:**
- Create: `packages/daemon/src/compute/builds/provisioner.ts`
- Test: `packages/daemon/test/provisioner.test.ts` (create)

**Interfaces:**
- Consumes: `OciPuller` (Task 6), `BuildRegistry` (Task 4), `composePgDistrib` (Task 5), `LogsService`, `EventsService`, `detectPostgresVersion` signature (injected), `StateDb`.
- Produces: `class Provisioner` constructor deps `{ registry: BuildRegistry; oci: OciPuller; state: StateDb; logs: LogsService; events: EventsService | undefined; cfg: { pgBuildsDir: string; pgImageTemplate: string }; validate: (a: { major: number; buildPath: string }) => Promise<void>; detectVersion: (pgbin: string) => Promise<{ major: number; minor: number }>; du: (dir: string) => Promise<number | null>; statfsFree: (dir: string) => Promise<number>; recomposeDistrib: () => Promise<void>; logger: { info(m: string): void; error(m: string, e?: unknown): void } }` and methods:
  - `check(majors: number[]): Promise<Record<string, { tag: string; digest: string; isNew: boolean }>>` — per major: `resolveDigest(repoFor(major), "latest")`; `isNew` = digest not in `pg_builds`; stores result in a private `lastCheck: Map<number, { tag: "latest"; digest: string; isNew: boolean; at: string }>` exposed via `updateAvailableFor(major): string | null` (returns `"latest@" + digest12` short form ONLY when isNew — the UI badge string).
  - `pull(a: { major: number; tag?: string }): Promise<{ buildId: string }>` — REJECTS with `DevdbError(409, "a build pull is already in progress")` while one runs (private `pulling` flag; `finally` clears). Kicks the pipeline ASYNC (fire-and-forget internal promise; the method returns the buildId immediately after inserting the `downloading` row) — REST/MCP return 202-style.
  - `remove(id: string, runningPgbins: string[]): Promise<void>` — `registry.assertRemovable` → `rm -rf row.path` → `state.pgBuilds.delete(id)` → recomposeDistrib + event.
  - `repoFor(major: number): string` — `pgImageTemplate.replace("{major}", String(major))`.

**Pipeline (inside the async job; every transition publishes `{ type: "pg_builds" }` and ingests a line to channel `pgbuild:{buildId}`):**
1. Preflight: `statfsFree(pgBuildsDir) < 1.5 * 2**30` → fail row `insufficient disk space on /data (< 1.5 GB free)` BEFORE any network. Dedup: `resolveDigest` first; if `state.pgBuilds.byDigest(digest)` exists and is `ready` → mark this row `failed` with `already installed as <that row's version> — no-op` (friendly; row records the outcome).
2. `jobs` bookkeeping row: `INSERT INTO jobs (id, kind, status) VALUES (?, 'pg_build_pull', 'running')` via `state.raw.prepare(…)` — write-only this phase (spec: a jobs REST API is phase 4's contract); finish it (`status`,'done'/'failed'`finished_at`) in the job's `finally`.
3. Extract: dest `.tmp-{tag}` under `pgBuildsDir/v{major}/` → `oci.pullPrefix({ …, destDir: tmpDir })` (onProgress → log channel).
4. Fixup: `detectVersion(join(tmpDir, "bin", "postgres"))` — detected major ≠ requested → fail (`image contained postgres {x}.{y}, expected major {major}`). Write `build.json` `{ digest, tag, major, minor, extractedAt: new Date().toISOString() }`. `du(tmpDir)` for sizeBytes. Atomic `rename(tmpDir, finalDir)`; `updatePath(id, finalDir)`; `setDetected`; status → `validating`.
5. Gate: `await validate({ major, buildPath: finalDir })` with a 90s `Promise.race` timeout (`gate timed out after 90s`). On ANY gate failure: `rm -rf finalDir` (no 250 MB corpses), `setStatus(id, "failed", firstLine(err))`, log tail already in channel, active pointer untouched — return.
6. Activate: `registry.activate(buildId)` — auto-activate is the pull gesture's meaning (spec pipeline step 6; a fresh pull is never a downgrade vs lastRunMinor — but if it somehow is (re-pulling an OLD tag deliberately), catch the 409 and leave the build `ready`-but-inactive with a log line naming `activate` as the next step). Then `recomposeDistrib()` (covers new-major case) and final event.

- [ ] **Step 1: Failing tests** — `packages/daemon/test/provisioner.test.ts` with typed fakes for every dep (`OciPuller` fake writes a scaffold dir; `validate` fake resolves/rejects per test; `statfsFree`/`du` fakes; real `openState(":memory:")` + real `BuildRegistry` over temp dirs — reuse Task 4's scaffold helpers by extracting them to `packages/daemon/test/helpers/build-fixtures.ts` and importing in both files). Cases (write each fully):

1. `pull happy path: downloading→validating→ready+active; build.json written; events published; log channel has layer lines` (fake oci writes `bin/postgres` + marker-ready dir contents into destDir; fake validate resolves; assert row + `readFile(build.json)` + collected events array from a real EventsService subscription + `logs.recent("pgbuild:"+id)` non-empty).
2. `second pull while one runs → DevdbError 409` (fake oci blocks on a deferred promise; call pull twice; assert second rejects with /already in progress/; release; await first).
3. `gate failure: dir deleted, row failed with reason, active pointer unchanged` (seed baked 17 active first; fake validate rejects `new Error("compute never became ready")`; assert `access(finalDir)` rejects, row.status "failed", `registry.pgbinFor(17)` still baked).
4. `digest dedup: already-installed digest → row failed with "already installed" and NO oci.pullPrefix call` (fake oci.resolveDigest returns a digest pre-inserted as ready; assert pullPrefix never called via a spy counter on the typed fake).
5. `detected major mismatch → failed row, no rename into place` (fake oci writes a postgres whose fake detectVersion returns major 16 for a requested 17).
6. `preflight disk: statfsFree below floor → failed before resolveDigest` (fake statfsFree returns 1 GB; spy asserts resolveDigest not called).
7. `check(): isNew digest reported; updateAvailableFor exposes short digest; known digest → isNew false`.

Poll-until-settled helper (the pipeline is async): `await vi.waitFor(() => expect(state.pgBuilds.byId(id)!.status).toBe("ready"))`.

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test -- provisioner` → FAIL (module not found).

- [ ] **Step 3: Implement `provisioner.ts`** (~200 lines) per the pipeline above. Real `du`/`statfsFree` default impls live here too (exported for index.ts): `du` via `execFile("du", ["-sk", dir])` → KB×1024, null on error; `statfsFree` via `(await statfs(dir)).bavail * bsize` (`node:fs/promises` statfs). `firstLine(e)` = `String((e as Error).message ?? e).split("\n")[0]!.slice(0, 500)`.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- provisioner` → PASS (7). Full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/compute/builds/provisioner.ts packages/daemon/test/provisioner.test.ts packages/daemon/test/helpers/build-fixtures.ts
git commit -m "feat(builds): Provisioner — global-mutex pull pipeline, dedup, disk preflight, gate-failure cleanup, auto-activate"
```

---

### Task 8: Seams — ComputeManager `pgbinPath`, EndpointsService resolution, projects guard, branch DTO

**Files:**
- Modify: `packages/daemon/src/services/engine-api.ts:32-43`, `packages/daemon/src/compute/manager.ts:95-148`, `packages/daemon/src/services/endpoints.ts`, `packages/daemon/src/services/projects.ts:61-95`, `packages/daemon/src/services/branches.ts` (detail), `packages/daemon/src/services/dto.ts`
- Test: `packages/daemon/test/manager.test.ts`, `packages/daemon/test/endpoints-service.test.ts`, `packages/daemon/test/projects-service.test.ts`, `packages/daemon/test/branches-service.test.ts` (additions to each)

**Interfaces:**
- Consumes: `BuildRegistry.pgbinFor/versionForPgbin/recordRun/installedMajors` (Task 4).
- Produces (later tasks + the gate rely on these EXACT shapes):
  - `engine-api.ts` `ComputesApi.start(a: { branch: BranchRow; pgVersion: PgVersion; pgbinPath: string; onLine?: (line: string) => void }): Promise<{ port: number }>` (pgbinPath REQUIRED) and new `runningPgbin(branchId: string): string | null`, `runningPgbins(): string[]`.
  - New narrow interface in `engine-api.ts`:
    ```ts
    export interface BuildsResolverApi {
      pgbinFor(major: number): { path: string; version: string; buildId: string };
      versionForPgbin(pgbinPath: string): string | null;
      recordRun(major: number, minor: number): void;
      installedMajors(): number[];
    }
    ```
  - `EndpointsService` deps gain `builds: BuildsResolverApi`; `startLocked(lane, branchId, opts?: { pgbinPath?: string })`; new public `startWithPgbin(branchId: string, pgbinPath: string): Promise<BranchDetail>` (queued wrapper used ONLY by the validation gate — not routed).
  - `ProjectsService` deps gain `builds?: Pick<BuildsResolverApi, "installedMajors">`; `create()` rejects unknown majors with `DevdbError(400, "Postgres {v} is not installed — installed majors: {list}. Pull it via POST /api/pg-builds/pull.")` when `builds` present.
  - `BranchesService` deps gain `builds?: Pick<BuildsResolverApi, "versionForPgbin">`; `detail()` output (`BranchDetail`) gains `runningPgVersion: string | null` (from `computes.runningPgbin(branch.id)` → `builds.versionForPgbin`); `dto.ts` `toBranchDto` maps it through instead of the Task-1 `null` stopgap.

- [ ] **Step 1: Failing tests.** Additions (each in its existing file, matching its established fake style — all four files already build typed fakes against `engine-api.ts`; extend those fakes: the `ComputesApi` fakes gain `runningPgbin`/`runningPgbins` members and their `start` fakes gain the `pgbinPath` param, which the tsc gate forces anyway):

`manager.test.ts`:
```ts
it("start passes the caller-resolved pgbinPath to compute_ctl --pgbin and exposes it via runningPgbin", async () => {
  // Reuse this file's existing spawn-capture harness: assert the spawned args array contains
  // ["--pgbin", "/data/pg_builds/v16/9124/bin/postgres"] exactly as passed in, NOT a
  // pgInstallDir-joined path; after readiness, expect(mgr.runningPgbin(branch.id)).toBe(thatPath);
  // after stop(), expect(mgr.runningPgbin(branch.id)).toBeNull() and runningPgbins() to be [].
});
```

`endpoints-service.test.ts`:
```ts
it("startLocked resolves --pgbin via builds.pgbinFor(project major) and records the run high-water", async () => {
  // builds fake: pgbinFor(16) → { path: "/b/v16/bin/postgres", version: "16.10", buildId: "dl-16-t" }
  // assert computes.start received pgbinPath "/b/v16/bin/postgres"
  // assert builds.recordRun called with (16, 10) exactly once, AFTER start resolved
});
it("startWithPgbin overrides resolution and does NOT recordRun (gate must not raise the high-water)", async () => {
  // call endpoints.startWithPgbin(branchId, "/tmp/candidate/bin/postgres")
  // assert computes.start received the override; assert builds.recordRun was NEVER called;
  // assert builds.pgbinFor was NEVER called (override wins outright)
});
it("pgbinFor throwing DevdbError(409) surfaces as the start failure and records endpoint failed", async () => { /* builds.pgbinFor throws; expect start() to reject with /no usable Postgres/; branch row endpoint_status "failed" */ });
```

`projects-service.test.ts`:
```ts
it("create rejects a major the registry doesn't know", async () => {
  // deps.builds = { installedMajors: () => [14, 15, 16, 17] }
  await expect(projects.create({ name: "p", pgVersion: 18 })).rejects.toThrow(/not installed — installed majors: 14, 15, 16, 17/);
});
it("create accepts a registry-known major and stays backward-compatible when builds dep absent", async () => { /* with builds: create({pgVersion: 16}) resolves; without builds key at all: create({pgVersion: 18}) resolves (old behavior) */ });
```

`branches-service.test.ts`:
```ts
it("detail carries runningPgVersion resolved from the running compute's pgbin", async () => {
  // computes fake: runningPgbin(id) → "/b/v16/bin/postgres"; builds fake: versionForPgbin → "16.10"
  // expect(detail.runningPgVersion).toBe("16.10"); with computes.runningPgbin → null expect null
});
```

- [ ] **Step 2: RED** — `pnpm --filter @devdb/daemon test` → the four files FAIL to compile (missing members) — that IS the red for interface changes; the new `it()` blocks fail on behavior.

- [ ] **Step 3: Implement.**
  - `engine-api.ts`: update `ComputesApi.start` signature, add `runningPgbin`/`runningPgbins`, add `BuildsResolverApi` (code in Interfaces block).
  - `manager.ts`: `start(a)` gains `pgbinPath: string`; line 148 becomes `"--pgbin", a.pgbinPath,` (delete the `join(this.cfg.pgInstallDir, …)`); `RunningCompute` gains `pgbinPath: string | null` (set in the same synchronous reservation tick as `entry.port = null` initialization — i.e. include `pgbinPath: null` in the reservation literal at line 102-104, then `entry.pgbinPath = a.pgbinPath` immediately, before the first await, so a concurrent `runningPgbin()` never sees a half-started entry without it); add:
    ```ts
    runningPgbin(branchId: string): string | null {
      return this.computes.get(branchId)?.pgbinPath ?? null;
    }
    runningPgbins(): string[] {
      return [...this.computes.values()].map((e) => e.pgbinPath).filter((p): p is string => p !== null);
    }
    ```
  - `endpoints.ts`: deps gain `builds: BuildsResolverApi`. In `startLocked(lane, branchId, opts?: { pgbinPath?: string })` replace the `computes.start({ branch, pgVersion: project.pgVersion, onLine })` call:
    ```ts
    // Dynamic builds: the ACTIVE build for this project's major, resolved fresh per start —
    // this is what makes "adopt on restart" structural (spec §Architecture). The validation
    // gate passes an explicit override instead (and must NOT touch the run high-water: the
    // candidate isn't active yet — recording it would arm the downgrade guard against a build
    // that may fail its gate).
    const resolved = opts?.pgbinPath ? null : this.deps.builds.pgbinFor(project.pgVersion);
    const pgbinPath = opts?.pgbinPath ?? resolved!.path;
    const { port } = await this.deps.computes.start({
      branch, pgVersion: project.pgVersion, pgbinPath,
      onLine: (line) => this.deps.logs.ingest(`branch:${branch.id}:compute`, line), // unchanged from today
    });
    if (resolved) {
      const minor = Number(resolved.version.split(".")[1]);
      this.deps.builds.recordRun(project.pgVersion, minor);
    }
    ```
    (Place `pgbinFor` INSIDE the existing try so its 409 lands in the single "failed"-recording catch.) Add:
    ```ts
    // Gate-only queued entry point (builds/validate.ts). Deliberately NOT wired to any route.
    startWithPgbin(branchId: string, pgbinPath: string): Promise<BranchDetail> {
      return this.deps.queue.run(branchId, (lane) => this.startLocked(lane, branchId, { pgbinPath }));
    }
    ```
  - `projects.ts` `create()`: after `const pgVersion = a.pgVersion ?? DEFAULT_PG_VERSION;` insert the guard from the Interfaces block (only when `this.deps.builds` is present).
  - `branches.ts` `detail()`: add `runningPgVersion` per the test; `dto.ts`: map `runningPgVersion: d.runningPgVersion` (BranchDetail → dto).
  - Update `index.ts` construction ONLY as far as compiling: `EndpointsService` now requires `builds` — Task 9 constructs the real registry earlier in boot; for THIS task's commit, do Task 9's minimal prerequisite: construct `BuildRegistry` + seed/adopt/resolve in index.ts before services (the full boot-order work including distrib/sweeps stays Task 9; keep this diff to registry construction + `builds` wiring or the daemon won't build). Mention this handoff in the commit body.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test` full suite (expect the four extended files + everything else green; several existing endpoint/manager tests needed their fakes extended — that's expected fallout, fix by extending fakes, never by loosening types).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src packages/daemon/test
git commit -m "feat(daemon): endpoint starts resolve --pgbin through BuildRegistry (adopt-on-restart); gate override path; project-create major guard; runningPgVersion on branch detail"
```

---

### Task 9: Validation gate runner + boot order + sweeps (composition root)

**Files:**
- Create: `packages/daemon/src/compute/builds/validate.ts`
- Modify: `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/build-validate.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectsService.create/delete/list`, `EndpointsService.startWithPgbin/stop`, `SqlService.run`, `BranchRow`.
- Produces: `makeValidationRunner(deps: { projects: Pick<ProjectsService, "create" | "delete" | "list">; endpoints: Pick<EndpointsService, "startWithPgbin" | "stop">; sql: Pick<SqlService, "run">; logger: { info(m: string): void; error(m: string, e?: unknown): void } }): (a: { major: number; buildPath: string }) => Promise<void>`; `sweepValidationProjects(projects: Pick<ProjectsService, "list" | "delete">): Promise<number>`; the final `index.ts` boot order.

- [ ] **Step 1: Failing tests** — `packages/daemon/test/build-validate.test.ts` with typed fakes:

```ts
it("gate: creates _devdb_validate_* project of the candidate major, starts via startWithPgbin, runs smoke SQL, deletes project", async () => {
  // fakes record calls; sql.run returns { rows: [{ version: "PostgreSQL 17.5 …" }], … } for the
  // version probe and benign results for the rest. Assert:
  //  - projects.create called with { name: matching /^_devdb_validate_[0-9a-f]{8}$/, pgVersion: 17 }
  //  - endpoints.startWithPgbin called with (mainBranch.id, "<buildPath>/bin/postgres")
  //  - sql.run called with the version probe first; a probe whose response lacks "17." REJECTS
  //  - projects.delete called in EVERY outcome (also when start throws — wrap in try/finally)
});
it("gate failure surfaces the cause and still cleans up", async () => {
  // endpoints.startWithPgbin rejects "compute never became ready" → runner rejects with that
  // message; projects.delete still called once.
});
it("sweepValidationProjects deletes only _devdb_validate_* projects", async () => {
  // projects.list → [{name:"app"},{name:"_devdb_validate_deadbeef"}] fakes; assert delete called
  // exactly for the validate one; returns 1.
});
```

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement `validate.ts`:**

```ts
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// The in-container validation gate (spec pipeline step 5): a downloaded build must drive a REAL
// compute against the LIVE storage — basebackup from the pageserver, WAL to the safekeeper, neon
// extension load — before it may activate. Uses the normal service layer end-to-end; the only
// special affordance is EndpointsService.startWithPgbin (pgbin override, no run-high-water).
export function makeValidationRunner(deps: { /* per Interfaces block */ }) {
  return async (a: { major: number; buildPath: string }): Promise<void> => {
    const name = `_devdb_validate_${randomBytes(4).toString("hex")}`;
    const { project, mainBranch } = await deps.projects.create({ name, pgVersion: a.major });
    try {
      await deps.endpoints.startWithPgbin(mainBranch.id, join(a.buildPath, "bin", "postgres"));
      const v = await deps.sql.run(mainBranch.id, "SELECT version()");
      const banner = JSON.stringify(v.rows[0] ?? "");
      if (!banner.includes(`${a.major}.`)) throw new Error(`gate: expected PostgreSQL ${a.major}.x, got ${banner.slice(0, 120)}`);
      // Real writes through the full path (pageserver-backed relation + WAL), then a neon-ext probe:
      await deps.sql.run(mainBranch.id, "CREATE TABLE _devdb_validate(x int); INSERT INTO _devdb_validate SELECT generate_series(1, 100); SELECT count(*) FROM _devdb_validate");
      await deps.sql.run(mainBranch.id, "SHOW neon.timeline_id");
    } finally {
      await deps.projects.delete(project.id).catch((e) => deps.logger.error(`gate cleanup: failed to delete ${name} — boot sweep will retry`, e));
    }
  };
}

export async function sweepValidationProjects(projects: { list(): Array<{ id: string; name: string }>; delete(id: string): Promise<void> }): Promise<number> {
  let n = 0;
  for (const p of projects.list()) {
    if (p.name.startsWith("_devdb_validate_")) { await projects.delete(p.id); n++; }
  }
  return n;
}
```

(Match `ProjectsService.list/create/delete`'s REAL signatures from `projects.ts` when writing the dep Picks — `create` returns `{ project, mainBranch }` per `projects.ts:61`.)

**Modify `index.ts`** — final boot order (comment each insertion; keep existing lines untouched otherwise):

```ts
// after: const state = openState(…); const logs/events/logger …
const registry = new BuildRegistry({ state, pgInstallDir: cfg.pgInstallDir, pgBuildsDir: cfg.pgBuildsDir, detectVersion: detectPostgresVersion, logger });
await mkdir(cfg.pgBuildsDir, { recursive: true });
await registry.seedBaked();
await registry.adoptVolumeBuilds();
const sweptTmp = await registry.sweepTmp();
if (sweptTmp > 0) console.error(`boot: swept ${sweptTmp} interrupted pg_build extraction(s)`);
const { degraded } = registry.resolveActives();
if (degraded.length > 0) console.error(`boot: PG major(s) ${degraded.join(", ")} resolved BELOW their last-run minor — see /api/status pgBuilds (re-pull to clear)`);
// Boot GC (spec §Pipeline: keep active + one previous per major) — nothing is running yet, so no
// in-use check is needed here; runtime deletes still go through assertRemovable.
for (const stale of registry.gcCandidates()) {
  await rm(stale.path, { recursive: true, force: true });
  state.pgBuilds.delete(stale.id);
  console.error(`boot: GC'd pg build ${stale.major}.${stale.minor} (${stale.releaseTag}) — keep-2 policy`);
}
const recomposeDistrib = async () => composePgDistrib({
  distribDir: cfg.pgDistribDir, pgInstallDir: cfg.pgInstallDir,
  downloadedOnly: registry.list().filter((r) => r.source === "downloaded" && r.status === "ready" && r.active).map((r) => ({ major: r.major, path: r.path })),
});
await recomposeDistrib(); // MUST precede engine.start(): pageserver.toml's pg_distrib_dir points here
// … engine = new EngineRuntime(…); await engine.start(); (existing)
```

After services construction: wire `builds: registry` into `EndpointsService` deps and `ProjectsService` deps (`builds: registry` — it satisfies both narrow Picks), `builds: registry` into `BranchesService`; then:

```ts
const sweptValidate = await sweepValidationProjects(projects);
if (sweptValidate > 0) console.error(`boot: swept ${sweptValidate} orphaned _devdb_validate_* project(s)`);
const provisioner = new Provisioner({
  registry, state, logs, events, logger,
  oci: new OciClient({ registryBase: cfg.pgRegistryBase }),
  cfg: { pgBuildsDir: cfg.pgBuildsDir, pgImageTemplate: cfg.pgImageTemplate },
  validate: makeValidationRunner({ projects, endpoints, sql, logger }),
  detectVersion: detectPostgresVersion, du: duDir, statfsFree, recomposeDistrib,
});
// buildServer deps gain { registry, provisioner } — Task 10 consumes them.
```

`BuildRegistry.list()` used above: if Task 4 didn't export a `list(): PgBuildRow[]` pass-through, add it (`return this.deps.state.pgBuilds.list()`).

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test` → build-validate PASS + full suite green (index.ts is composition, not unit-covered; the integration suite proves the order in Task 15).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/compute/builds/validate.ts packages/daemon/src/index.ts packages/daemon/test/build-validate.test.ts
git commit -m "feat(builds): validation-gate runner via real services + boot order (registry→distrib→engine) with tmp/validate sweeps"
```

---

### Task 10: REST — five routes + status `pgBuilds` block

**Files:**
- Modify: `packages/daemon/src/http/api.ts` (Deps + status route at :87-95 + new routes after the SQL route at :404)
- Test: `packages/daemon/test/api.test.ts` (additions)

**Interfaces:**
- Consumes: `registry`/`provisioner` from Deps (Task 9), `PgBuildDto`/`PgMajorStatusDto` (Task 1), `ComputesApi.runningPgbins` (Task 8).
- Produces (web + MCP + integration rely on these EXACT shapes):
  - `Deps` gains `registry: BuildRegistry; provisioner: Provisioner` (import types).
  - `toPgBuildDto(row: PgBuildRow, runningPgbins: string[]): PgBuildDto` in `services/dto.ts` — `version: row.minor === null ? null : \`${row.major}.${row.minor}\``, `inUse: runningPgbins.some((p) => p.startsWith(row.path + "/"))`.
  - `GET /api/pg-builds` → `PgBuildDto[]`.
  - `POST /api/pg-builds/check` body `{ majors?: number[] }` (default: registry.installedMajors()) → `Record<string, { tag: string; digest: string; isNew: boolean }>` (this is THE only egress trigger besides pull).
  - `POST /api/pg-builds/pull` body `{ major: number; tag?: string }` (zod: `{ major: PgVersionSchema, tag: z.string().min(1).optional() }`) → `202 { buildId }`; concurrent → provisioner's `DevdbError(409)` through the existing error handler.
  - `POST /api/pg-builds/:id/activate` body `{ consented?: boolean }` → `PgBuildDto` (registry.activate + `await recomposeDistrib()` — expose recompose on provisioner as `recomposeDistrib()` public method — + `events.publish({ type: "pg_builds" })`).
  - `DELETE /api/pg-builds/:id` → 204 (provisioner.remove with `computes.runningPgbins()`).
  - Status route: replace the Task-1 `pgBuilds: {}` stopgap with the real block:
    ```ts
    const pgBuilds: Record<string, PgMajorStatusDto> = {};
    for (const major of deps.registry.installedMajors()) {
      const active = deps.registry.list().find((r) => r.major === major && r.active && r.status === "ready") ?? null;
      pgBuilds[String(major)] = {
        activeVersion: active?.minor != null ? `${active.major}.${active.minor}` : null,
        source: active?.source ?? null,
        degradedDowngrade: deps.registry.degradedMajors().includes(major),
        updateAvailable: deps.provisioner.updateAvailableFor(major),
      };
    }
    ```
    and the engine mapping now carries `"starting"` through unchanged (the union widened in Task 1 — verify `EngineRuntime.status()`'s `state: string` values flow; no daemon change needed beyond the type).

- [ ] **Step 1: Failing tests** — `api.test.ts` additions, following that file's established buildServer-with-fakes pattern (it already constructs Deps with typed fakes — extend the fixture with a real `BuildRegistry` over temp scaffolds from `helpers/build-fixtures.ts` and a typed fake Provisioner):

```ts
it("GET /api/pg-builds lists rows as DTOs with inUse derived from running pgbins", async () => { /* seed baked+downloaded; computes fake runningPgbins → [path under downloaded]; assert dto fields incl version string + inUse true */ });
it("POST /api/pg-builds/pull returns 202 with buildId; concurrent pull surfaces 409", async () => { /* provisioner fake: first pull resolves {buildId:"b1"}, second throws DevdbError(409,…); expect statuses 202 then 409 */ });
it("POST /api/pg-builds/:id/activate returns the activated dto; DELETE returns 204", async () => {});
it("GET /api/status carries pgBuilds with activeVersion/degradedDowngrade/updateAvailable", async () => { /* registry with baked 17 active; degraded fake via lastRunMinor seeding; provisioner.updateAvailableFor → "latest@abc123def456" */ });
it("POST /api/pg-builds/check forwards majors and returns the provisioner's map", async () => {});
```

- [ ] **Step 2: RED** — routes 404 / Deps compile errors.

- [ ] **Step 3: Implement** per the Interfaces block. Route placement: after the `/api/sql` route. Zod schemas at the same style/scope as `CreateProject` (`api.ts:289`). `toPgBuildDto` goes in `services/dto.ts` beside `toBranchDto`.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test -- api` PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/http/api.ts packages/daemon/src/services/dto.ts packages/daemon/test/api.test.ts
git commit -m "feat(api): pg-builds routes (list/check/pull/activate/delete) + status pgBuilds block"
```

---

### Task 11: MCP tools — `list_pg_builds`, `check_pg_updates`, `pull_pg_build`, `activate_pg_build`

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts` (register after the existing branch-mutation tools), `packages/daemon/src/mcp/server.ts` ONLY if `ToolCtx["deps"]` needs `registry`/`provisioner` added (it mirrors http Deps — check first)
- Test: `packages/daemon/test/mcp-tools.test.ts` or the file the existing tool tests live in (`grep -l "create_project" packages/daemon/test`) — additions

**Interfaces:**
- Consumes: `registry`/`provisioner` via `ToolCtx.deps`, `guard()` (`tools.ts:101`), `text()`/`contextLine()` helpers.
- Produces: four tools, registered through `guard()` like every existing tool. NO MCP delete (spec: infra-destructive stays human).

**Tool contracts (render as plain text lines, matching the existing tools' voice):**
- `list_pg_builds` `{}` — one line per major: `PG 16 — active 16.10 (downloaded, release 9124)` plus per-build sublines `  [ready] 16.9 baked` / `  [failed] release 9101: gate: …`; degraded majors get a leading `⚠ PG 16 is running BELOW its last-run minor — re-pull to clear` line; ends with `updates: PG 16 → latest@ab12cd34ef56` lines when a prior check found news.
- `check_pg_updates` `{ majors?: number[] }` — runs the provisioner check (egress; user-initiated by definition here) and renders the isNew map.
- `pull_pg_build` `{ major: number, tag?: string }` — starts the async pull; returns immediately: `pull started (build <id>). Poll list_pg_builds — status downloading → validating → ready (auto-activates). Progress: GET /api/branches logs channel pgbuild:<id>.`
- `activate_pg_build` `{ major: number, version: string }` — resolves the `ready` row of that major+version (`registry.list()` filter), calls `registry.activate(id, { consented: true })` — MCP activation is EXPLICIT agent intent, consent is implied by the call; the tool text WARNS when it lowered the high-water: `activated 16.9 (rollback below last-run 16.10 — extension-catalog downgrades are forward-only; see README §Postgres builds)`. Unknown version → `errorResult` listing available `ready` versions.

- [ ] **Step 1: Failing tests** — follow the existing MCP tool test harness (`test/helpers/mcp-harness.ts`): register server with fakes, call tools, assert text. Four tests: list renders active/degraded/failed lines; check returns map text; pull returns immediately with the poll instruction (provisioner fake records the call); activate warns on rollback + errors on unknown version.

- [ ] **Step 2: RED** — tools not registered.

- [ ] **Step 3: Implement** — four `mcp.registerTool(…, guard("…", deps, async …))` blocks; zod shapes `{ majors: z.array(PgVersionSchema).optional() }`, `{ major: PgVersionSchema, tag: z.string().min(1).optional() }`, `{ major: PgVersionSchema, version: z.string().regex(/^\d+\.\d+$/) }`.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/daemon test` full suite.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/mcp packages/daemon/test
git commit -m "feat(mcp): list/check/pull/activate pg-build tools (agents self-serve majors; no MCP delete)"
```

---

### Task 12: Web API layer — client, keys, hooks, event mapping

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/api/keys.ts`, `packages/web/src/api/hooks.ts`, `packages/web/src/api/events.ts`
- Test: `packages/web/test/client.test.ts`, `packages/web/test/events.test.ts`, `packages/web/test/hooks.test.tsx` (additions, matching each file's fetch-mock style)

**Interfaces:**
- Consumes: Task 10's routes; `PgBuildDto` from `@devdb/shared`.
- Produces: `api.pgBuilds = { list(): Promise<PgBuildDto[]>; check(majors?: number[]): Promise<Record<string, { tag: string; digest: string; isNew: boolean }>>; pull(a: { major: number; tag?: string }): Promise<{ buildId: string }>; activate(id: string, consented?: boolean): Promise<PgBuildDto>; remove(id: string): Promise<void> }`; `keys.pgBuilds = ["pg-builds"] as const`; hooks `usePgBuilds()`, `useCheckPgUpdates()`, `usePullPgBuild()`, `useActivatePgBuild()`, `useDeletePgBuild()` (mutations via the existing `useApiMutation` factory — its blanket `invalidateQueries()` onSettled already covers refetch); `mapEventToKeys` case `"pg_builds"` → `[keys.pgBuilds, keys.status]`.

- [ ] **Step 1: Failing tests.** `client.test.ts`: assert method/path/body for all five (`POST /api/pg-builds/pull` with `{ major: 16 }`; `POST /api/pg-builds/<id>/activate` with `{ consented: true }`; `DELETE` 204 → resolves void) — copy the file's existing mocked-fetch assertion helpers. `events.test.ts`: `mapEventToKeys({ type: "pg_builds", at: "" })` → `[keys.pgBuilds, keys.status]`. `hooks.tsx`: `usePgBuilds` renders list data through a wrapper QueryClient (mirror `useProjects`' existing test).

- [ ] **Step 2: RED** — `pnpm --filter @devdb/web test` → compile failures on missing exports.

- [ ] **Step 3: Implement** — follow `client.ts`'s existing `req()` helper for every call; keys/hooks/events per the Interfaces block.

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/web test` full suite.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api packages/web/test
git commit -m "feat(web): pg-builds API client, query keys, hooks, event invalidation mapping"
```

---

### Task 13: Web — Settings "Postgres builds" card

**Files:**
- Create: `packages/web/src/settings/PgBuildsCard.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx` (mount card between the Daemon and Preferences cards)
- Test: `packages/web/test/pg-builds-card.test.tsx` (create)

**Interfaces:**
- Consumes: Task 12 hooks; `useStatus()` for `pgBuilds` per-major block.

**Card behavior (complete spec — build exactly this, nothing more):**
- One section per major from `status.pgBuilds` (sorted ascending): header `PG 16` + active chip `16.10 · downloaded` (Badge, green when downloaded, gray when baked) + degraded banner (`Alert color="orange"`) when `degradedDowngrade`: `Running below the last-used minor — re-pull a newer build to clear this.`
- `Check for updates` button (top-right of the card, one for the whole card): fires `useCheckPgUpdates` with no majors (server defaults to installed); while pending, loading state; after, majors with `isNew` render an `update available` Badge + a `Pull` button beside the major header. Pull fires `usePullPgBuild({ major })`.
- Installed-builds list under each major (from `usePgBuilds()` filtered by major): `16.9 · baked · ready` rows; downloaded rows get kebab-less inline actions: `Activate` (hidden when active; passes `consented: true` after a `window.confirm` ONLY when the target minor < the active minor — confirm text: `Activating 16.9 is a downgrade below 16.10. The neon extension's catalog upgrades forward-only. Continue?`), `Delete` (disabled with tooltip when `active` or `inUse`; `window.confirm` first — matches DashboardPage's delete-confirm idiom at `DashboardPage.tsx:87`).
- Rows with `status: "downloading" | "validating"` render a `Loader size="xs"` + the status text; `failed` rows render the `error` text dimmed + a `Retry pull` button (same `usePullPgBuild` with that row's major+releaseTag).
- No log-tail viewer in this card (YAGNI — the logs SSE channel exists for curl/debugging; a UI tail is future polish).

- [ ] **Step 1: Failing tests** — `pg-builds-card.test.tsx` via the shared `renderApp` harness + fetch mocks (mirror `settings.test.tsx`'s mocking): (1) renders per-major sections with active chip from status; (2) degraded major shows the orange alert; (3) `Check for updates` → after resolve, `update available` badge + Pull button appear, Pull posts the right body; (4) Activate on a lower minor confirms + sends `consented: true`; window.confirm mocked true/false both asserted; (5) Delete disabled when active/inUse.

- [ ] **Step 2: RED** — component missing.

- [ ] **Step 3: Implement the card + mount** (`<PgBuildsCard />` in SettingsPage after the Daemon card).

- [ ] **Step 4: GREEN** — `pnpm --filter @devdb/web test` full suite.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/settings packages/web/src/pages/SettingsPage.tsx packages/web/test/pg-builds-card.test.tsx
git commit -m "feat(web): Postgres builds settings card — check/pull/activate/delete with downgrade confirm + degraded banner"
```

---

### Task 14: Web — status-driven majors in create-project + restart-to-adopt chip

**Files:**
- Modify: `packages/web/src/pages/DashboardPage.tsx:34-58` (CreateProjectModal), `packages/web/src/drawer/InfoTab.tsx`
- Test: `packages/web/test/dashboard.test.tsx`, `packages/web/test/drawer.test.tsx` (additions)

**Interfaces:**
- Consumes: `useStatus().data.pgBuilds` (majors + activeVersion), `BranchDto.runningPgVersion` (Task 8 via Task 10's dto).

- [ ] **Step 1: Failing tests.**
`dashboard.test.tsx`: status fixture gains `pgBuilds: { "16": {...}, "17": {...}, "18": { activeVersion: "18.1", source: "downloaded", degradedDowngrade: false, updateAvailable: null } }` → open the create modal → the PG Select offers `PG 14–18`? NO — offers exactly the STATUS majors (`16, 17, 18` in this fixture) sorted ascending, defaulting to `DEFAULT_PG_VERSION` when present else the highest; with status still loading (no fixture), Select falls back to `SUPPORTED_PG_VERSIONS`. Two tests.
`drawer.test.tsx`: a running branch fixture with `runningPgVersion: "16.9"` + status `pgBuilds["16"].activeVersion: "16.10"` → InfoTab shows Badge `restart to adopt 16.10`; equal versions → no badge; stopped branch (`runningPgVersion: null`) → no badge.

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement.** CreateProjectModal:

```tsx
const { data: status } = useStatus();
const majors = status ? Object.keys(status.pgBuilds).map(Number).sort((a, b) => a - b) : [...SUPPORTED_PG_VERSIONS];
// keep useState(String(DEFAULT_PG_VERSION)); clamp when majors load and the current pick vanished:
const effectivePg = majors.includes(Number(pg)) ? pg : String(majors.at(-1) ?? DEFAULT_PG_VERSION);
```

(Select `data` from `majors`; pass `value={effectivePg}`.) InfoTab: with `branch.runningPgVersion` non-null and `status.pgBuilds[String(major)]?.activeVersion` differing → `<Badge color="yellow" variant="light">restart to adopt {activeVersion}</Badge>` next to the endpoint status row; `major` derives from `branch.runningPgVersion.split(".")[0]`.

- [ ] **Step 4: GREEN** — full web suite.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/pages/DashboardPage.tsx packages/web/src/drawer/InfoTab.tsx packages/web/test
git commit -m "feat(web): registry-driven major picker + restart-to-adopt chip"
```

---

### Task 15: Integration — hermetic fixture registry + end-to-end suite

**Files:**
- Create: `tests/integration/helpers/fixture-registry.ts`, `tests/integration/pg-builds.test.ts`

**Interfaces:**
- Consumes: `startDevdb(env)` (`helpers/container.ts:67` — pass `DEVDB_PG_REGISTRY_BASE`), testcontainers `Network`, `execa` (already a helper dep).

**Fixture design (hermetic — Docker Hub is NEVER touched; global constraint):**
- `startFixtureRegistry(net: StartedNetwork)` → starts `registry:2` on the shared network with alias `pgregistry`, returns `{ internalBase: "http://pgregistry:5000", externalBase: "http://localhost:<mapped 5000>", stop() }`.
- `seedComputeImageFromDevdb(a: { devdb: Devdb; externalBase: string; repository: string; sourceMajor: 17; transformToMinorTag: string })`:
  1. Build the layer INSIDE the running devdb container (its baked v17 is a REAL neon postgres): `docker exec <id> tar -czf /tmp/fixture-layer.tgz --transform 's|^v17|usr/local|' -C /usr/local/share/neon/pg_install v17`, then `docker cp <id>:/tmp/fixture-layer.tgz <hostTmp>` (both via `execa`).
  2. Host-side: sha256 + byte-length of the tgz; minimal config blob `JSON.stringify({ architecture: process.arch === "arm64" ? "arm64" : "amd64", os: "linux", rootfs: { type: "layers", diff_ids: [] }, config: {} })`; upload BOTH blobs: `POST {externalBase}/v2/{repo}/blobs/uploads/` → `Location` → `PUT {location}&digest=sha256:{hex}` with the bytes; then `PUT {externalBase}/v2/{repo}/manifests/{tag}` with content-type `application/vnd.docker.distribution.manifest.v2+json` and a schema2 manifest referencing config + the one layer (single manifest, NOT an index — the unit suite covers index/arch selection).
  3. Also seed the STUB image (`repository` `neondatabase/compute-node-v17`, tag `stub`): a tiny host-built tgz whose `usr/local/bin/postgres` is `#!/bin/sh\necho "postgres (PostgreSQL) 17.5"\n` (mode 0755 — build with `tar --mode`/a scaffold dir + `execa tar`) — passes fixup's version detection, CANNOT serve a compute → the gate must kill it.

**Test flow (`pg-builds.test.ts`, one `describe`, `beforeAll` ~4 min budget):** create network → `startDevdb({ DEVDB_PG_REGISTRY_BASE: "http://pgregistry:5000" })` with `.withNetwork(net)` — `startDevdb` needs an optional `network` param added to `container.ts` (additive: `if (a.network) container.withNetwork(a.network)`) → start fixture registry on the same network → seed both images (uses the devdb container itself as the layer source).

```ts
it("pull → validate against LIVE storage → ready + auto-active; project on it runs", async () => {
  // POST /api/pg-builds/pull { major: 17, tag: "9999" }  → 202 { buildId }
  // poll GET /api/pg-builds until that row status === "ready" (timeout 240s, interval 3s) — on
  // "failed" fail fast printing row.error
  // assert row.active === true, version "17.5", imageDigest starts "sha256:"
  // GET /api/status → pgBuilds["17"].source === "downloaded"
  // create a project (pgVersion 17) + start main's endpoint → branch.runningPgVersion === "17.5"
  //   and connect via helpers/pg.ts to SELECT 1 (proves the downloaded-build compute serves SQL)
});
it("stub build fails the gate cleanly: row failed, active pointer untouched, retry allowed", async () => {
  // pull tag "stub" → poll until "failed"; expect row.error to be non-empty;
  // GET /api/status → pgBuilds["17"].source still "downloaded" (the 9999 build from test 1 — order
  // matters: this test runs AFTER; if isolated, expect "baked")
  // second pull of "stub" is ACCEPTED (409 only while in-flight)
});
it("volume build survives container re-up; deleting its dir surfaces the downgrade flag", async () => {
  // devdb.restart({ timeout: 60_000 }) → GET /api/pg-builds still lists the 9999 build ready+active
  //   (markers re-adopted; spec §Boot) and status pgBuilds["17"].activeVersion === "17.5" — NOTE:
  //   baked is ALSO 17.5, so assert source === "downloaded" is NOT guaranteed post-restart (tie →
  //   baked per spec!). Assert instead: the dl row still EXISTS ready; active row's version 17.5.
  // exec rm -rf the build dir + restart → status pgBuilds["17"] has degradedDowngrade === false
  //   (tie case: lastRunMinor 5 == baked 5 — no downgrade) — SO to make the downgrade case REAL,
  //   FIRST exec a sed replacing the marker minor with 99 is NOT possible (postgres --version
  //   detection already ran)… instead: exec `sed -i 's/"minor":5/"minor":99/' <dir>/build.json` +
  //   restart (adopt trusts markers) → verify activeVersion "17.99" + recordRun via starting the
  //   test-1 project's endpoint → THEN rm -rf dir + restart → pgBuilds["17"].degradedDowngrade === true
  //   and activeVersion === "17.5" (baked fallback). This exercises marker-adoption, high-water
  //   recording, and the guard in one flow.
});
```

Write these three fully (the comments above are the assertions to encode — turn each into real fetch/execa/poll code; reuse `helpers/pg.ts` for SQL and `container.ts`'s exec pattern via `execa("docker", ["exec", …])`).

- [ ] **Step 2: RED** — run just this file: `pnpm --filter @devdb/integration test -- pg-builds` → fails at the fixture (or 404 routes if daemon image predates Task 10 — the suite rebuilds the image via `buildImage()`).

- [ ] **Step 3/4: Implement helper + GREEN** — `pnpm --filter @devdb/integration test -- pg-builds` PASS (~4-5 min). Then the FULL integration suite once: `pnpm --filter @devdb/integration test` — all files green.

- [ ] **Step 5: Commit**

```bash
git add tests/integration
git commit -m "test(integration): hermetic pg-builds e2e — fixture registry, real-gate pull, stub gate-failure, re-up survival + downgrade guard"
```

---

### Task 16: Docs + opt-in manual smoke script

**Files:**
- Create: `scripts/pg-pull-smoke.sh`
- Modify: `README.md` (new "Postgres builds" section after the branching section), `docker/BINARIES.md` (one-paragraph note)

- [ ] **Step 1: `scripts/pg-pull-smoke.sh`** (chmod +x; the ONLY thing in the repo that touches Docker Hub, run by a human on demand — never CI):

```bash
#!/usr/bin/env bash
# Manual smoke: pull the real latest compute-node build for one major from Docker Hub through a
# LIVE devdb at localhost:4400 and watch it through the gate. Usage: scripts/pg-pull-smoke.sh 17
set -euo pipefail
MAJOR="${1:?usage: pg-pull-smoke.sh <major>}"
BASE="${DEVDB_BASE:-http://localhost:4400}"
echo "→ checking for updates (egress to Docker Hub)…"
curl -fsS -X POST "$BASE/api/pg-builds/check" -H 'content-type: application/json' -d "{\"majors\":[$MAJOR]}" | tee /dev/stderr
echo "→ pulling latest v$MAJOR…"
BUILD_ID=$(curl -fsS -X POST "$BASE/api/pg-builds/pull" -H 'content-type: application/json' -d "{\"major\":$MAJOR}" | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p')
echo "build: $BUILD_ID — polling (Ctrl-C safe; state survives)"
while true; do
  STATUS=$(curl -fsS "$BASE/api/pg-builds" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(b=>b.id==='$BUILD_ID');console.log(r?r.status+' '+(r.version??'')+' '+(r.error??''):'gone')})")
  echo "  $STATUS"
  case "$STATUS" in ready*|failed*|gone*) break;; esac
  sleep 5
done
```

- [ ] **Step 2: README section** — document (complete prose, user-facing): what pulls do (official Neon compute images, digest-pinned, validated against your live storage before activation), the three surfaces (Settings card, `POST /api/pg-builds/*`, MCP tools), adopt-on-restart semantics + the drawer chip, the downgrade guard + consented rollback (extension catalogs upgrade forward-only), egress honesty (`auth.docker.io`/`registry-1.docker.io`, only on check/pull; mirrors via `DEVDB_PG_REGISTRY_BASE`/`DEVDB_PG_IMAGE_TEMPLATE`), disk (~250 MB/build, keep-active+previous GC, delete via Settings), and the new-major caveat verbatim from the spec: minor refresh is first-class; a new major needs the baked storage release to support it — the gate answers empirically. Include the spec's troubleshooting knob one-liner: if a gate fails on pageserver protocol negotiation, `neon.protocol_version` can be pinned via pgconf (documented, deliberately not built). `docker/BINARIES.md`: note that runtime-pulled builds live on the volume under `/data/pg_builds` and are OUTSIDE the image inventory/digest-pin; the registry records tag+digest per pull.

- [ ] **Step 3: Verify** — `bash -n scripts/pg-pull-smoke.sh` (syntax); README renders (visual skim).

- [ ] **Step 4: Commit**

```bash
git add scripts/pg-pull-smoke.sh README.md docker/BINARIES.md
git commit -m "docs: Postgres builds — user guide, egress/mirror notes, opt-in Docker Hub smoke script"
```

---

## Post-plan notes for the controller

- **Suite gates per task:** daemon tasks end green on `pnpm --filter @devdb/daemon test`; web tasks on `pnpm --filter @devdb/web test`; Task 15 additionally runs the full integration suite. The final whole-branch review precedes any merge (superpowers:finishing-a-development-branch).
- **Deferred by design (do NOT let a reviewer talk a fixer into them):** UI log-tail viewer for pull progress; jobs REST API (phase 4); automatic update checks; MCP delete tool; amd64 fixture variants. Record any new Minors in the ledger for the final review.
- **Escalation triggers:** anything touching the compute↔storage contract beyond the plan (e.g. the gate flaking against live storage in Task 15) — stop and surface; that's a Fable-session conversation, not a fixer loop.



