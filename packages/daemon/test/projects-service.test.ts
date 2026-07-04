import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { ProjectsService } from "../src/services/projects.js";
import { DevdbError } from "../src/services/errors.js";
import { slugify } from "../src/services/slug.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { BranchQueue } from "../src/state/queue.js";
import type { BuildsResolverApi, ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { Logger } from "../src/logging/logger.js";
import type { BranchRow } from "../src/state/repos.js";
import type { DevdbEvent, EndpointStatus } from "@devdb/shared";
import { StorconClient } from "../src/engine/storcon-client.js";
import { PageserverClient } from "../src/engine/pageserver-client.js";
import { SafekeeperClient } from "../src/engine/safekeeper-client.js";
import { ComputeManager } from "../src/compute/manager.js";
import { loadConfig } from "../src/config.js";

// Amendment A2: typed fakes satisfying the narrow service-facing interfaces from
// services/engine-api.ts — no `as never` casts. Every method the interfaces declare must
// exist on the fake (even ones a given test never exercises) or this file fails to typecheck.
//
// Fix 1 (review): `queue` is a fresh BranchQueue per call — ProjectsDeps now requires one so
// delete() can serialize each leaf's teardown against concurrent start()/stop()/create() lane
// jobs for that branch. Bundled here (not threaded through every call site individually) so
// every existing `new ProjectsService({ state, ...f })` call keeps working unchanged; tests that
// need to occupy a lane by hand destructure `f.queue` directly (see the two tests below).
//
// Task 4: `logger` is a typed fake (Logger's three methods as vi.fn()s), not a cast — every
// service's deps now require it (ProjectsDeps), for compensation-path logging.
//
// Task 8: `computes` gains `runningPgbin`/`runningPgbins` (tsc-forced by ComputesApi). `builds` is
// NOT included in this base fakes() bag's return — ProjectsDeps' `builds` field is OPTIONAL and
// every EXISTING test in this file constructs ProjectsService via `{ state, ...f }` relying on the
// pre-Task-8 no-guard behavior; the two new tests below build their own `builds` fake inline
// (mirroring how `queue` is sometimes destructured directly rather than folded into this bag) so
// that backward-compatibility default stays proven by every other test in the file, unchanged.
function fakes(): {
  storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi;
  queue: BranchQueue; logger: Logger;
} {
  const storcon: StorconApi = {
    tenantCreate: vi.fn(async () => {}),
    getLsnByTimestamp: vi.fn(async () => ({ lsn: "0/0", kind: "present" })),
  };
  const pageserver: PageserverApi = {
    timelineCreate: vi.fn(async () => ({ timeline_id: "x".repeat(32) })),
    timelineInfo: vi.fn(async () => ({ timeline_id: "x".repeat(32) })),
    timelineDelete: vi.fn(async () => {}),
    timelineDetachAncestor: vi.fn(async () => ({ reparented_timelines: [] })),
    tenantDelete: vi.fn(async () => {}),
  };
  const safekeeper: SafekeeperApi = {
    timelineDelete: vi.fn(async () => {}),
    tenantDelete: vi.fn(async () => {}),
  };
  const computes: ComputesApi = {
    start: vi.fn(async () => ({ port: 1 })),
    stop: vi.fn(async () => {}),
    statusOf: vi.fn((): EndpointStatus => "stopped"),
    portOf: vi.fn(() => null),
    runningPorts: vi.fn(() => []),
    runningPgbin: vi.fn(() => null),
    runningPgbins: vi.fn(() => []),
    onLine: vi.fn(() => () => {}),
    stopAll: vi.fn(async () => {}),
  };
  const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { storcon, pageserver, safekeeper, computes, queue: new BranchQueue(), logger };
}

// Task 8: a minimal BuildsResolverApi fake carrying only what ProjectsService.create()'s major
// guard consumes (installedMajors) — ProjectsDeps types this dep as
// `Pick<BuildsResolverApi, "installedMajors">`, but the full interface fake is supplied anyway so
// it also satisfies BuildsResolverApi itself where a test wants that.
function fakeBuilds(installedMajors: number[] = [14, 15, 16, 17]): BuildsResolverApi {
  return {
    pgbinFor: vi.fn((major: number) => ({ path: `/b/v${major}/bin/postgres`, version: `${major}.10`, buildId: `dl-${major}-t` })),
    versionForPgbin: vi.fn(() => null),
    recordRun: vi.fn(),
    installedMajors: vi.fn(() => installedMajors),
  };
}

describe("slugify", () => {
  it("normalizes", () => expect(slugify("Acme App", "Main!")).toBe("acme-app-main"));
});

describe("engine clients satisfy the narrow service interfaces (A2 type-level conformance)", () => {
  it("StorconClient, PageserverClient, SafekeeperClient, ComputeManager structurally satisfy the Api interfaces", () => {
    const cfg = loadConfig({
      DEVDB_DATA_DIR: "/tmp/devdb-typecheck-only",
      NEON_BINARIES_DIR: "/tmp/devdb-typecheck-only/bin",
      PG_INSTALL_DIR: "/tmp/devdb-typecheck-only/pg",
    });
    const _storcon: StorconApi = new StorconClient();
    const _pageserver: PageserverApi = new PageserverClient();
    const _safekeeper: SafekeeperApi = new SafekeeperClient();
    const _computes: ComputesApi = new ComputeManager(cfg, { error: vi.fn(), warn: vi.fn(), info: vi.fn() });
    // Structural satisfaction above IS the check — if any interface method is missing or has
    // an incompatible signature, this file fails to typecheck (tsc / `vitest run --typecheck`).
    expect([_storcon, _pageserver, _safekeeper, _computes].every(Boolean)).toBe(true);
  });
});

describe("ProjectsService", () => {
  it("create makes tenant, bootstrap timeline, main branch row", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme", pgVersion: 17 });
    expect(project.id).toMatch(/^[0-9a-f]{32}$/);
    expect(f.storcon.tenantCreate).toHaveBeenCalledWith(project.id, expect.objectContaining({ gc_horizon: 67108864 }));
    expect(f.pageserver.timelineCreate).toHaveBeenCalledWith(project.id, expect.objectContaining({ pg_version: 17 }));
    expect(mainBranch.name).toBe("main");
    expect(mainBranch.parentBranchId).toBeNull();
    expect(state.branches.byProjectAndName(project.id, "main")).not.toBeNull();
  });

  // Task 8: the project-create major guard — a WHITELIST against builds.installedMajors(),
  // rejecting ANY major not in that list (not a spot-check of one hardcoded "unsupported" value).
  // Gated on `deps.builds` being PRESENT: when the caller supplies no builds dep at all, create()
  // must fall back to the pre-Task-8 no-guard behavior unchanged (every other test in this file
  // exercises exactly that default, via `fakes()`'s bag which carries no `builds` key).
  describe("create() major guard (Task 8)", () => {
    it("rejects a major the registry doesn't know", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      await expect(svc.create({ name: "p", pgVersion: 18 }))
        .rejects.toThrow(/not installed — installed majors: 14, 15, 16, 17/);
      await expect(svc.create({ name: "p", pgVersion: 18 })).rejects.toMatchObject({ statusCode: 400 });
    });

    // A whitelist, not a spot-check: an absurdly out-of-range major must be rejected exactly like
    // 18 is — proving the guard isn't hardcoded against some specific "known bad" value.
    it("rejects a wildly-out-of-range major (whitelist, not a spot-check of one value)", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      await expect(svc.create({ name: "p", pgVersion: 999 }))
        .rejects.toThrow(/not installed — installed majors: 14, 15, 16, 17/);
    });

    it("create accepts a registry-known major and stays backward-compatible when builds dep absent", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svcWithBuilds = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      await expect(svcWithBuilds.create({ name: "known", pgVersion: 16 })).resolves.toBeDefined();

      // Old behavior: no `builds` key at all (not even `builds: undefined`) — create() must not
      // guard, so a major the registry (if it existed) wouldn't recognize still resolves.
      const state2 = openState(":memory:");
      const svcNoBuilds = new ProjectsService({ state: state2, ...f });
      await expect(svcNoBuilds.create({ name: "unguarded", pgVersion: 18 })).resolves.toBeDefined();
    });
  });

  // Fix 1 (task-9 gate integration): the validation gate's OWN project must get past both public
  // guards — its reserved `_devdb_validate_` prefix deliberately fails the name regex (users can
  // never squat/collide with gate names), and the candidate major is still `validating`, not yet
  // in installedMajors(). `internal: true` is the gate's private affordance for exactly those two
  // checks; everything else (dup-name 409, engine calls, compensation) applies to internal creates
  // unchanged, and NO public caller (REST POST /api/projects, MCP create_project) passes opts.
  describe("create() internal option (Fix 1, task-9 gate integration)", () => {
    it("internal create bypasses BOTH the name regex and the installed-major guard — real guards active", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      // 18 is NOT in installedMajors() (a mid-gate candidate is still `validating`), and the
      // leading underscore fails the public regex — the PUBLIC form of this exact call is proven
      // to reject in the two tests below.
      const { project, mainBranch } = await svc.create(
        { name: "_devdb_validate_x", pgVersion: 18 }, { internal: true },
      );
      expect(project.name).toBe("_devdb_validate_x");
      expect(project.pgVersion).toBe(18);
      expect(mainBranch.name).toBe("main");
      expect(state.projects.byName("_devdb_validate_x")).not.toBeNull();
    });

    it("public create (no opts) still rejects the underscore-prefixed name with 400", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      await expect(svc.create({ name: "_devdb_validate_x" })).rejects.toMatchObject({ statusCode: 400 });
      await expect(svc.create({ name: "_devdb_validate_x" })).rejects.toThrow(/invalid project name/);
    });

    it("public create (no opts) still rejects an uninstalled major with 400", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([14, 15, 16, 17]) });
      await expect(svc.create({ name: "ok", pgVersion: 18 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(svc.create({ name: "ok2", pgVersion: 18 })).rejects.toThrow(/not installed/);
    });

    it("internal create keeps the duplicate-name 409 — only the two gate-blocking checks are skipped", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const svc = new ProjectsService({ state, ...f, builds: fakeBuilds([17]) });
      await svc.create({ name: "_devdb_validate_dup", pgVersion: 17 }, { internal: true });
      await expect(svc.create({ name: "_devdb_validate_dup", pgVersion: 17 }, { internal: true }))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  it("rejects duplicate project names with 409", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    await svc.create({ name: "acme" });
    await expect(svc.create({ name: "acme" })).rejects.toMatchObject({ statusCode: 409 });
  });

  // Emission map (spec Decision 1): create() publishes exactly ONE project.created event — no
  // separate branch.created for the seeded main branch, since clients invalidate both projects
  // AND branches off this single event.
  it("create publishes project.created with the project id, and nothing else", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const svc = new ProjectsService({ state, events, ...f });
    const { project } = await svc.create({ name: "acme" });
    expect(seen).toEqual([
      expect.objectContaining({ type: "project.created", projectId: project.id }),
    ]);
  });

  // A create() that fails engine-side (compensated) must publish NOTHING — the event marks a
  // successful local write, never an attempted one.
  it("a create() that fails engine-side publishes no events", async () => {
    const f = fakes();
    vi.mocked(f.pageserver.timelineCreate).mockRejectedValueOnce(new Error("bootstrap timeline failed"));
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const svc = new ProjectsService({ state, events, ...f });
    await expect(svc.create({ name: "acme" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("delete removes branches (children first), timelines, tenant", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });
    state.branches.create({
      id: crypto.randomUUID(), projectId: project.id, parentBranchId: mainBranch.id,
      name: "dev", slug: "acme-dev", timelineId: "c".repeat(32), password: "x", createdBy: "api",
    });
    await svc.delete(project.id);
    expect(state.projects.byId(project.id)).toBeNull();
    expect(state.branches.countAll()).toBe(0);
    // child timeline deleted before parent timeline
    const order = vi.mocked(f.pageserver.timelineDelete).mock.calls.map((c) => c[1]);
    expect(order.indexOf("c".repeat(32))).toBeLessThan(order.indexOf(mainBranch.timelineId));
    expect(f.pageserver.tenantDelete).toHaveBeenCalledWith(project.id);
    expect(f.safekeeper.tenantDelete).toHaveBeenCalledWith(project.id);
  });

  // Fix 3 (review): the leaves loop in delete() evicts EVERY branch's `branch:<id>:compute`
  // channel as it's removed (children first, same as the timeline/tenant cleanup order above) —
  // mirrors BranchesService.delete()'s own single-branch evict(), applied per-leaf here since a
  // project delete can remove many branches in one call.
  it("delete evicts every removed branch's logs channel", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const logs = new LogsService();
    const svc = new ProjectsService({ state, logs, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });
    const dev = state.branches.create({
      id: crypto.randomUUID(), projectId: project.id, parentBranchId: mainBranch.id,
      name: "dev", slug: "acme-dev", timelineId: "c".repeat(32), password: "x", createdBy: "api",
    });
    logs.ingest(`branch:${mainBranch.id}:compute`, "main output");
    logs.ingest(`branch:${dev.id}:compute`, "dev output");

    await svc.delete(project.id);

    expect(logs.recent(`branch:${mainBranch.id}:compute`)).toEqual([]);
    expect(logs.recent(`branch:${dev.id}:compute`)).toEqual([]);
  });

  // `logs` is an OPTIONAL dep (see the constructor's doc comment) — delete() must not throw when
  // it's simply omitted, which is exactly what every OTHER test in this file (fakes()-only) does.
  it("delete works without throwing when logs is omitted from deps", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project } = await svc.create({ name: "acme" });
    await expect(svc.delete(project.id)).resolves.toBeUndefined();
  });

  // Emission map: delete() publishes project.deleted after the project row is actually gone.
  // Fix wave 1, Fix 3: a freshly-created project's only branch (main) is also drained as part of
  // delete(), so branch.deleted for that branch now fires too (symmetric with BranchesService's
  // own emit) — updated from this test's original single-event expectation to assert both, in the
  // correct order (the leaf branch drains before the project row itself is deleted).
  it("delete publishes project.deleted with the project id (and branch.deleted for the drained main branch)", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    const svc = new ProjectsService({ state, events, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });
    events.subscribe((e) => seen.push(e)); // subscribe AFTER create() so only delete()'s events are seen
    await svc.delete(project.id);
    expect(seen).toEqual([
      expect.objectContaining({ type: "branch.deleted", projectId: project.id, branchId: mainBranch.id }),
      expect.objectContaining({ type: "project.deleted", projectId: project.id }),
    ]);
  });

  // `events` is an OPTIONAL dep, same rationale as `logs` above — every existing test in this
  // file (fakes()-only) constructs ProjectsService without one.
  it("create and delete work without throwing when events is omitted from deps", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project } = await svc.create({ name: "acme" });
    await expect(svc.delete(project.id)).resolves.toBeUndefined();
  });

  // Fix 1 (review): delete() now recomputes `remaining` from state on EVERY `while` iteration
  // (not once up front) specifically so a branch created mid-delete — after the initial
  // listByProject() snapshot but before the loop finishes — still gets caught in a later round
  // instead of silently surviving the project delete (which would then throw an FK constraint
  // on the final projects.delete() call, or worse, leave an orphaned branch row referencing a
  // now-gone project). Simulated here by monkey-patching listByProject to inject a new leaf row
  // the FIRST time it's called after main has already been created — i.e. exactly the "state
  // changed after our snapshot" case a naive one-shot snapshot would miss.
  it("a branch created between rounds still gets deleted", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });

    const original = state.branches.listByProject.bind(state.branches);
    let calls = 0;
    let injected: BranchRow | null = null;
    state.branches.listByProject = ((projectId: string) => {
      calls++;
      const rows = original(projectId);
      // On the very first snapshot (round 1), main is the only row and is about to be deleted as
      // a leaf. Inject a second branch directly into state right then — simulating a create()
      // that lands in the window between this snapshot and delete()'s next iteration — so it is
      // ABSENT from round 1's snapshot but present in state by the time round 2 re-queries.
      if (calls === 1 && !injected) {
        injected = state.branches.create({
          id: crypto.randomUUID(), projectId: project.id, parentBranchId: mainBranch.id,
          name: "late-arrival", slug: "acme-late-arrival", timelineId: "d".repeat(32),
          password: "x", createdBy: "api",
        });
      }
      return rows;
    }) as typeof original;

    try {
      await svc.delete(project.id);
    } finally {
      state.branches.listByProject = original;
    }

    expect(state.projects.byId(project.id)).toBeNull();
    expect(state.branches.countAll()).toBe(0);
    expect(calls).toBeGreaterThan(1); // proves re-snapshotting actually happened across rounds
  });

  // Fix 1 (review): each leaf's teardown now runs inside `queue.run(leaf.id, ...)` — the SAME
  // per-branch lane that start()/stop()/create() use — so a project delete can never race a
  // concurrent endpoint operation on one of its branches. Proven here by occupying the leaf's
  // lane with a slow, still-pending job BEFORE calling delete(), then asserting computes.stop()
  // (delete's first teardown step for that leaf) is only invoked after the slow job's own body
  // has run to completion — i.e. delete() waited its turn in line rather than reaching straight
  // into computes.stop() while the lane was busy.
  it("delete serializes with an in-flight endpoint lane job", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });

    const order: string[] = [];
    let releaseSlowJob!: () => void;
    const slowJobStarted = new Promise<void>((resolveStarted) => {
      const blocker = f.queue.run(mainBranch.id, () => {
        order.push("slow-job-start");
        resolveStarted();
        return new Promise<void>((resolve) => { releaseSlowJob = resolve; }).then(() => {
          order.push("slow-job-end");
        });
      });
      void blocker;
    });
    vi.mocked(f.computes.stop).mockImplementation(async () => {
      order.push("delete-stop");
    });

    await slowJobStarted; // the lane job is now occupying mainBranch.id's queue slot
    const deletePromise = svc.delete(project.id);
    // Give delete() a chance to reach queue.run() and enqueue behind the slow job — it must not
    // proceed to computes.stop() yet, since the lane is still occupied.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["slow-job-start"]);

    releaseSlowJob();
    await deletePromise;

    expect(order).toEqual(["slow-job-start", "slow-job-end", "delete-stop"]);
  });

  it("compensates the tenant when bootstrap fails", async () => {
    const f = fakes();
    vi.mocked(f.pageserver.timelineCreate).mockRejectedValueOnce(new Error("bootstrap timeline failed"));
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    await expect(svc.create({ name: "acme" })).rejects.toThrow(/bootstrap timeline failed/);
    // the tenant id passed to storcon.tenantCreate is the same one create() must clean up.
    const projectId = vi.mocked(f.storcon.tenantCreate).mock.calls[0]![0];
    expect(f.pageserver.tenantDelete).toHaveBeenCalledWith(projectId);
    expect(f.safekeeper.tenantDelete).toHaveBeenCalledWith(projectId);
    // nothing local should have been persisted for a create that never reached the local insert.
    expect(state.projects.list()).toHaveLength(0);
  });

  it("maps local unique violations to 409 and compensates", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    // Force the local-insert transaction to fail exactly once, the way a real SQLITE_CONSTRAINT
    // violation would (e.g. a slug/name collision) — without needing to engineer an actual
    // colliding row (the timeline-suffixed slug makes that impractical to set up synchronously).
    // The repo method is reassigned on the instance for one call, then restored, so no other
    // test observes the stubbed behavior.
    const original = state.branches.create.bind(state.branches);
    let calls = 0;
    state.branches.create = ((a: Parameters<typeof original>[0]) => {
      calls++;
      if (calls === 1) {
        const err = new Error("UNIQUE constraint failed: branches.slug") as Error & { code?: string };
        err.code = "SQLITE_CONSTRAINT_UNIQUE";
        throw err;
      }
      return original(a);
    }) as typeof original;
    try {
      // Fix 2 (task-3 coverage): pin the EXACT generic message, not just the 409 status — a
      // regression reintroducing `${(e as Error).message}` (leaking raw SQLite text like the
      // "UNIQUE constraint failed: branches.slug" thrown above) would still pass a status-only
      // check. Assert equality on the message AND explicitly that none of the SQLite internals
      // from the stubbed error (its code, table name, or the `.slug` column) leaked through.
      let caught: DevdbError | undefined;
      try {
        await svc.create({ name: "acme" });
      } catch (e) {
        caught = e as DevdbError;
      }
      expect(caught).toBeInstanceOf(DevdbError);
      expect(caught?.statusCode).toBe(409);
      expect(caught?.message).toBe("project or branch identity conflicts with an existing one");
      expect(caught?.message).not.toContain("SQLITE_CONSTRAINT");
      expect(caught?.message).not.toContain("branches");
      expect(caught?.message).not.toContain(".slug");
      const projectId = vi.mocked(f.storcon.tenantCreate).mock.calls[0]![0];
      expect(f.pageserver.tenantDelete).toHaveBeenCalledWith(projectId);
      expect(f.safekeeper.tenantDelete).toHaveBeenCalledWith(projectId);
      // the failed transaction must not have left a project row behind (atomic with the branch insert).
      expect(state.projects.list()).toHaveLength(0);
    } finally {
      state.branches.create = original;
    }
  });

  // Fix wave 1, Fix 3: drainBranches() deletes each leaf branch row directly via
  // `state.branches.delete(...)` (NOT BranchesService.delete(), so it never went through THAT
  // service's own branch.deleted emit) — every branch-row deletion in the codebase must announce
  // branch.deleted, symmetric with BranchesService.delete()'s own publish. Two branches (main +
  // one child) means two per-leaf branch.deleted events (child torn down first, then main), plus
  // the one project.deleted once the project row itself is gone.
  it("delete emits branch.deleted for each branch drained, plus one project.deleted", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const svc = new ProjectsService({ state, events, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });
    seen.length = 0; // isolate delete()'s own events from create()'s project.created
    const dev = state.branches.create({
      id: crypto.randomUUID(), projectId: project.id, parentBranchId: mainBranch.id,
      name: "dev", slug: "acme-dev", timelineId: "c".repeat(32), password: "x", createdBy: "api",
    });

    await svc.delete(project.id);

    const branchDeleted = seen.filter((e) => e.type === "branch.deleted");
    expect(branchDeleted).toHaveLength(2);
    const deletedIds = branchDeleted.map((e) => e.branchId).sort();
    expect(deletedIds).toEqual([dev.id, mainBranch.id].sort());
    for (const e of branchDeleted) {
      expect(e).toMatchObject({ type: "branch.deleted", projectId: project.id });
    }
    const projectDeleted = seen.filter((e) => e.type === "project.deleted");
    expect(projectDeleted).toEqual([
      expect.objectContaining({ type: "project.deleted", projectId: project.id }),
    ]);
  });

  // Fix wave 1, Fix 3 continued: if tenantDelete throws AFTER drainBranches() already committed
  // the per-leaf branch-row deletes, those branch.deleted events must still have fired — the rows
  // are durably gone regardless of what the enclosing project delete does next (project delete
  // ordering itself is out of scope here — see the brief). project.deleted must NOT have fired,
  // since the project row delete never even runs (tenantDelete throws first).
  it("branch.deleted still fires for drained leaves even when the project delete fails after the drain", async () => {
    const f = fakes();
    vi.mocked(f.pageserver.tenantDelete).mockRejectedValueOnce(new Error("tenant delete boom"));
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const svc = new ProjectsService({ state, events, ...f });
    const { project, mainBranch } = await svc.create({ name: "acme" });
    seen.length = 0; // isolate delete()'s own events from create()'s project.created

    await expect(svc.delete(project.id)).rejects.toThrow(/tenant delete boom/);

    const branchDeleted = seen.filter((e) => e.type === "branch.deleted");
    expect(branchDeleted).toEqual([
      expect.objectContaining({ type: "branch.deleted", projectId: project.id, branchId: mainBranch.id }),
    ]);
    const projectDeleted = seen.filter((e) => e.type === "project.deleted");
    expect(projectDeleted).toEqual([]);
    // the branch row really is gone, even though the enclosing project delete ultimately failed —
    // confirms the event reflects a real, durable state change, not a rolled-back one.
    expect(state.branches.byId(mainBranch.id)).toBeNull();
  });

  it("aborts delete loudly on dangling parent", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const svc = new ProjectsService({ state, ...f });
    const { project } = await svc.create({ name: "acme" });
    const original = state.branches.listByProject.bind(state.branches);
    // Fabricate two branches that parent each other — no valid leaf exists, so the
    // children-before-parents loop can never make progress and must abort loudly instead of
    // looping forever or silently doing nothing.
    const a: BranchRow = {
      id: "branch-a", projectId: project.id, parentBranchId: "branch-b", name: "a", slug: "a",
      timelineId: "a".repeat(32), password: "x", stickyPort: null, endpointStatus: "stopped",
      endpointError: null,
      importStatus: "none", importError: null, createdBy: "api", context: null,
      createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const b: BranchRow = {
      id: "branch-b", projectId: project.id, parentBranchId: "branch-a", name: "b", slug: "b",
      timelineId: "b".repeat(32), password: "x", stickyPort: null, endpointStatus: "stopped",
      endpointError: null,
      importStatus: "none", importError: null, createdBy: "api", context: null,
      createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z",
    };
    state.branches.listByProject = ((projectId: string) => {
      if (projectId === project.id) return [a, b];
      return original(projectId);
    }) as typeof original;
    try {
      await expect(svc.delete(project.id)).rejects.toThrow(/cycle|dangling/);
    } finally {
      state.branches.listByProject = original;
    }
  });
});
