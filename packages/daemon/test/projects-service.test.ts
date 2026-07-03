import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { ProjectsService } from "../src/services/projects.js";
import { DevdbError } from "../src/services/errors.js";
import { slugify } from "../src/services/slug.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { BranchQueue } from "../src/state/queue.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
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
    onLine: vi.fn(() => () => {}),
    stopAll: vi.fn(async () => {}),
  };
  const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { storcon, pageserver, safekeeper, computes, queue: new BranchQueue(), logger };
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
  it("delete publishes project.deleted with the project id", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    const svc = new ProjectsService({ state, events, ...f });
    const { project } = await svc.create({ name: "acme" });
    events.subscribe((e) => seen.push(e)); // subscribe AFTER create() so only delete()'s event is seen
    await svc.delete(project.id);
    expect(seen).toEqual([
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
