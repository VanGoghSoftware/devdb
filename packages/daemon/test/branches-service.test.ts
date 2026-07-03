import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { BranchesService } from "../src/services/branches.js";
import { ProjectsService } from "../src/services/projects.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { EngineApiError } from "../src/engine/http.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { Logger } from "../src/logging/logger.js";
import type { DevdbEvent, EndpointStatus } from "@devdb/shared";

// Amendment A2: typed fakes satisfying the narrow service-facing interfaces from
// services/engine-api.ts — no `as never` casts. Every method the interfaces declare must
// exist on the fake (even ones a given test never exercises) or this file fails to typecheck.
//
// Task 4: `logger` is a typed fake (Logger's three methods as vi.fn()s), not a cast — every
// service's deps now require it (ProjectsDeps), for compensation-path logging.
function fakes(): {
  storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi; logger: Logger;
} {
  const storcon: StorconApi = {
    tenantCreate: vi.fn(async () => {}),
    getLsnByTimestamp: vi.fn(async () => ({ lsn: "0/0", kind: "present" })),
  };
  const pageserver: PageserverApi = {
    timelineCreate: vi.fn(async () => ({ timeline_id: "x".repeat(32) })),
    timelineInfo: vi.fn(async () => ({
      timeline_id: "x".repeat(32), ancestor_timeline_id: null, ancestor_lsn: "0/1",
      last_record_lsn: "0/2", current_logical_size: 1234,
    })),
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
  return { storcon, pageserver, safekeeper, computes, logger };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  // Fix 1 (review): ProjectsDeps now requires `queue` (delete()'s per-leaf teardown runs inside
  // it) — a fresh instance is fine here since this helper only ever calls projects.create(),
  // which never touches the queue.
  const projects = new ProjectsService({ state, queue: new BranchQueue(), ...f });
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const branches = new BranchesService({ state, queue: new BranchQueue(), ...f });
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
    const last = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last.ancestor_start_lsn).toBeUndefined();
  });

  it("passes ancestor_start_lsn for branch-at-point", async () => {
    const { f, project, branches } = await seeded();
    await branches.create({ projectId: project.id, name: "pitr", atLsn: "0/1A2B3C" });
    const req = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)![1] as Record<string, unknown>;
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

  // Fix 3 (review): delete() evicts the deleted branch's `branch:<id>:compute` channel — a
  // deleted branch id is never reused, so its logs channel (ring buffer + any subscribers) has
  // nothing left to serve and would otherwise sit in LogsService forever.
  it("delete evicts the branch's logs channel", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const projects = new ProjectsService({ state, queue: new BranchQueue(), ...f });
    const { project } = await projects.create({ name: "acme" });
    const logs = new LogsService();
    const branches = new BranchesService({ state, queue: new BranchQueue(), logs, ...f });
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    logs.ingest(`branch:${dev.id}:compute`, "some compute output");
    expect(logs.recent(`branch:${dev.id}:compute`)).toEqual(["some compute output"]);

    await branches.delete(dev.id);

    expect(logs.recent(`branch:${dev.id}:compute`)).toEqual([]);
  });

  // `logs` is an OPTIONAL dep (see the constructor's doc comment) — delete() must not throw when
  // it's simply omitted, which is exactly what every OTHER test in this file (via seeded()) does.
  it("delete works without throwing when logs is omitted from deps", async () => {
    const { project, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await expect(branches.delete(dev.id)).resolves.toBeUndefined();
  });

  // Emission map (spec Decision 1): create() publishes branch.created with project+branch ids
  // AFTER the row exists — capture the created row, then publish it.
  it("create publishes branch.created with project + branch ids after the row exists", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const projects = new ProjectsService({ state, queue, ...f });
    const { project } = await projects.create({ name: "acme" });
    const branches = new BranchesService({ state, queue, events, ...f });
    const row = await branches.create({ projectId: project.id, name: "dev" });
    expect(seen).toEqual([
      expect.objectContaining({ type: "branch.created", projectId: project.id, branchId: row.id }),
    ]);
  });

  // A create() that fails engine-side (compensated) must publish NOTHING.
  it("a create() that fails engine-side publishes no events", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    const projects = new ProjectsService({ state, queue, ...f });
    const { project } = await projects.create({ name: "acme" });
    const branches = new BranchesService({ state, queue, events, ...f });
    events.subscribe((e) => seen.push(e)); // subscribe AFTER seeding the project's own create()
    const err = { code: "SQLITE_CONSTRAINT_UNIQUE" } as unknown as Error;
    vi.spyOn(state.branches, "create").mockImplementationOnce(() => { throw err; });
    await expect(branches.create({ projectId: project.id, name: "dev" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  // Emission map: delete() publishes branch.deleted after the row is gone (next to logs?.evict).
  it("delete publishes branch.deleted after the row is gone", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const projects = new ProjectsService({ state, queue, ...f });
    const { project } = await projects.create({ name: "acme" });
    const branches = new BranchesService({ state, queue, events, ...f });
    const row = await branches.create({ projectId: project.id, name: "doomed" });
    await branches.delete(row.id);
    expect(seen.filter((e) => e.type === "branch.deleted")).toEqual([
      expect.objectContaining({ projectId: project.id, branchId: row.id }),
    ]);
  });

  // `events` is an OPTIONAL dep, same rationale as `logs` above.
  it("create and delete work without throwing when events is omitted from deps", async () => {
    const { project, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await expect(branches.delete(dev.id)).resolves.toBeUndefined();
  });

  // Amendment A11 (controller): connectionString percent-encodes the password via
  // encodeURIComponent — passwords are alphanumeric today (see compute/scram.ts CHARSET) so the
  // encoded form is identical to the raw one, but the contract is now safe if that charset ever
  // grows special characters.
  it("connectionString shape (password percent-encoded)", async () => {
    const { branches, mainBranch } = await seeded();
    expect(branches.connectionString(mainBranch, 54301))
      .toBe(`postgresql://postgres:${encodeURIComponent(mainBranch.password)}@localhost:54301/postgres`);
  });

  it("detail enriches with lsn/size from pageserver timeline_info and a connectionString when running", async () => {
    const { f, mainBranch, branches } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54301);
    const d = await branches.detail(mainBranch);
    expect(d.endpointStatus).toBe("running");
    expect(d.port).toBe(54301);
    expect(d.lastRecordLsn).toBe("0/2");
    expect(d.logicalSizeBytes).toBe(1234);
    expect(d.ancestorLsn).toBe("0/1");
    expect(d.connectionString).toBe(branches.connectionString(mainBranch, 54301));
  });

  it("detail tolerates a pageserver blip on timeline_info instead of throwing", async () => {
    const { f, mainBranch, branches } = await seeded();
    // A real "pageserver unreachable" condition surfaces as an EngineApiError (see
    // engine/http.ts engineFetch) — that's the class of failure detail() is meant to tolerate,
    // per the narrowed catch in Fix 2 (services/branches.ts). Non-engine errors (e.g. a
    // programming bug) are covered separately by "surfaces non-engine errors from enrichment".
    vi.mocked(f.pageserver.timelineInfo).mockRejectedValueOnce(
      new EngineApiError("timeline_info", 503, "pageserver unreachable"),
    );
    const d = await branches.detail(mainBranch);
    expect(d.lastRecordLsn).toBeNull();
    expect(d.logicalSizeBytes).toBeNull();
    expect(d.ancestorLsn).toBeNull();
    // endpoint is stopped in this fixture, so connectionString is null regardless — the point of
    // this test is solely that the timeline_info rejection above did not propagate.
    expect(d.connectionString).toBeNull();
  });

  it("detail omits connectionString when running but the port isn't known yet", async () => {
    const { f, mainBranch, branches } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(null);
    const d = await branches.detail(mainBranch);
    expect(d.connectionString).toBeNull();
  });

  it("list returns detail-enriched rows for every branch in the project", async () => {
    const { project, mainBranch, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    const rows = await branches.list(project.id);
    expect(rows.map((r) => r.id).sort()).toEqual([mainBranch.id, dev.id].sort());
    for (const r of rows) {
      expect(r.endpointStatus).toBe("stopped");
      expect(r.lastRecordLsn).toBe("0/2");
    }
  });

  it("byIdOr404 throws 404 for an unknown branch id", async () => {
    const { branches } = await seeded();
    expect(() => branches.byIdOr404("does-not-exist")).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it("create rejects an explicit null parentBranchId (root branches only exist via project create)", async () => {
    const { project, branches } = await seeded();
    await expect(branches.create({ projectId: project.id, name: "dev", parentBranchId: null }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("create rejects a parent branch belonging to a different project", async () => {
    // Both projects must share one state/service instance — byIdOr404 checks the parent id
    // against this service's own state db, so a truly separate StateDb would 404 instead of
    // exercising the cross-project 400 guard this test targets.
    const f = fakes();
    const state = openState(":memory:");
    const projects = new ProjectsService({ state, queue: new BranchQueue(), ...f });
    const branches = new BranchesService({ state, queue: new BranchQueue(), ...f });
    const { project } = await projects.create({ name: "acme" });
    const { mainBranch: otherMain } = await projects.create({ name: "other" });
    await expect(branches.create({ projectId: project.id, name: "dev", parentBranchId: otherMain.id }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("create rejects an invalid branch name", async () => {
    const { project, branches } = await seeded();
    await expect(branches.create({ projectId: project.id, name: "" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("create 404s for an unknown project", async () => {
    const { branches } = await seeded();
    await expect(branches.create({ projectId: "does-not-exist", name: "dev" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("compensates the timeline when the local insert fails", async () => {
    const { f, state, project, branches } = await seeded();
    const err = { code: "SQLITE_CONSTRAINT_UNIQUE" } as unknown as Error;
    const createSpy = vi.spyOn(state.branches, "create").mockImplementationOnce(() => {
      throw err;
    });

    await expect(branches.create({ projectId: project.id, name: "dev" }))
      .rejects.toMatchObject({ statusCode: 409 });

    const [, req] = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)!;
    const newTimelineId = (req as Record<string, unknown>).new_timeline_id as string;
    expect(f.pageserver.timelineDelete).toHaveBeenCalledWith(project.id, newTimelineId);
    expect(f.safekeeper.timelineDelete).toHaveBeenCalledWith(project.id, newTimelineId);

    createSpy.mockRestore();
  });

  it("rejects create when the parent vanishes while queued", async () => {
    // Built manually (not via seeded()) so the test holds a direct reference to the same
    // BranchQueue instance the service uses — needed to occupy the parent's queue lane by hand.
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const branches = new BranchesService({ state, queue, ...f });
    const { project, mainBranch } = await projects.create({ name: "acme" });

    // Occupy the parent's queue lane first so our create() call below (which also queues under
    // parent.id per Fix 1) is forced to wait behind this job — by the time it runs, the parent
    // row is gone.
    const blocker = queue.run(mainBranch.id, async () => {
      state.branches.delete(mainBranch.id); // main is a leaf here — no FK/child issue
    });

    await expect(branches.create({ projectId: project.id, name: "dev", parentBranchId: mainBranch.id }))
      .rejects.toThrow(/was deleted/);
    await blocker;
  });

  it("surfaces non-engine errors from enrichment", async () => {
    const { f, mainBranch, branches } = await seeded();
    vi.mocked(f.pageserver.timelineInfo).mockRejectedValueOnce(new TypeError("boom"));
    await expect(branches.detail(mainBranch)).rejects.toThrow(TypeError);
  });

  it("trims branch names", async () => {
    const { project, branches } = await seeded();
    const b = await branches.create({ projectId: project.id, name: "  dev  " });
    expect(b.name).toBe("dev");
    expect(branches.byIdOr404(b.id).name).toBe("dev");
  });

  // Fix 2 (review, task-2-fix.md): service-level coverage — a repo-only test (branch-context.test.ts)
  // wouldn't catch a regression where BranchesService.create stopped passing `context` through to
  // the repo. Assert the PERSISTED row (read back from state), not just create()'s return value.
  it("create persists the given fork context on the branch row", async () => {
    const { project, branches, state } = await seeded();
    const ctx = { git_branch: "feat/x", workdir: "/w", agent: "claude", purpose: "try a migration" };
    const b = await branches.create({ projectId: project.id, name: "dev", context: ctx });
    expect(state.branches.byId(b.id)!.context).toEqual(ctx);
  });

  // Task 4 (Phase 3): PATCH /api/branches/:id rename — slug is IMMUTABLE (it feeds compute
  // naming and directories), the root branch is not renameable, duplicate names 409 (except
  // renaming to one's own current name, a no-op success), and a rename announces branch.updated
  // through the events channel Tasks 1-3 built.
  describe("rename", () => {
    it("renames a child branch, bumps updatedAt, keeps slug, emits branch.updated", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const queue = new BranchQueue();
      const events = new EventsService();
      const seen: DevdbEvent[] = [];
      events.subscribe((e) => seen.push(e));
      const projects = new ProjectsService({ state, queue, ...f });
      const { project } = await projects.create({ name: "acme" });
      const branches = new BranchesService({ state, queue, events, ...f });
      const b = await branches.create({ projectId: project.id, name: "dev" });
      const out = await branches.rename(b.id, "dev-renamed");
      expect(out.name).toBe("dev-renamed");
      expect(out.slug).toBe(b.slug); // immutable — feeds compute naming/dirs
      expect(out.updatedAt >= b.updatedAt).toBe(true);
      expect(seen.filter((e) => e.type === "branch.updated")).toEqual([
        expect.objectContaining({ projectId: project.id, branchId: b.id }),
      ]);
    });

    // Fix 1 (broker): renaming a branch to its OWN current name must be a TRUE no-op — no DB
    // write (updatedAt unchanged), no branch.updated event. Wires a real EventsService +
    // collector (same pattern as the "renames a child branch..." test above) so the assertion
    // covers the actual publish call, not just the returned row.
    it("renaming to its own current name is a true no-op: unchanged updatedAt, zero events", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const queue = new BranchQueue();
      const events = new EventsService();
      const seen: DevdbEvent[] = [];
      const projects = new ProjectsService({ state, queue, ...f });
      const { project } = await projects.create({ name: "acme" });
      const branches = new BranchesService({ state, queue, events, ...f });
      const b = await branches.create({ projectId: project.id, name: "a" });
      events.subscribe((e) => seen.push(e)); // subscribe AFTER the seeding create() above

      const out = await branches.rename(b.id, "a");

      expect(out).toMatchObject({ id: b.id, name: "a" });
      expect(out.updatedAt).toBe(b.updatedAt); // unchanged — proves no DB write happened
      expect(seen.filter((e) => e.type === "branch.updated")).toEqual([]);
    });

    it("refuses to rename the root branch with a 400 naming the reason", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const queue = new BranchQueue();
      const events = new EventsService();
      const seen: DevdbEvent[] = [];
      const projects = new ProjectsService({ state, queue, ...f });
      const { project, mainBranch } = await projects.create({ name: "acme" });
      const branches = new BranchesService({ state, queue, events, ...f });
      events.subscribe((e) => seen.push(e)); // subscribe AFTER the seeding create() above
      expect(mainBranch.parentBranchId).toBeNull();

      await expect(branches.rename(mainBranch.id, "primary")).rejects.toMatchObject({ statusCode: 400 });

      expect(project.id).toBe(mainBranch.projectId);
      // Fix 3 (broker): a rejected rename must publish nothing.
      expect(seen.filter((e) => e.type === "branch.updated")).toEqual([]);
    });

    it("409s on a duplicate name in the same project; renaming to its own name is a no-op success", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const queue = new BranchQueue();
      const events = new EventsService();
      const seen: DevdbEvent[] = [];
      const projects = new ProjectsService({ state, queue, ...f });
      const { project } = await projects.create({ name: "acme" });
      const branches = new BranchesService({ state, queue, events, ...f });
      const a = await branches.create({ projectId: project.id, name: "a" });
      await branches.create({ projectId: project.id, name: "b" });
      events.subscribe((e) => seen.push(e)); // subscribe AFTER the seeding creates above

      await expect(branches.rename(a.id, "b")).rejects.toMatchObject({ statusCode: 409 });
      await expect(branches.rename(a.id, "a")).resolves.toMatchObject({ name: "a" });

      // Fix 3 (broker): the rejected 409 rename must publish nothing. (The self-rename no-op is
      // covered separately above; this test's own no-op resolve above would also publish nothing,
      // so the zero-count assertion holds across both calls.)
      expect(seen.filter((e) => e.type === "branch.updated")).toEqual([]);
    });

    it("400s on a name failing NAME_RE", async () => {
      const f = fakes();
      const state = openState(":memory:");
      const queue = new BranchQueue();
      const events = new EventsService();
      const seen: DevdbEvent[] = [];
      const projects = new ProjectsService({ state, queue, ...f });
      const { project } = await projects.create({ name: "acme" });
      const branches = new BranchesService({ state, queue, events, ...f });
      const b = await branches.create({ projectId: project.id, name: "ok" });
      events.subscribe((e) => seen.push(e)); // subscribe AFTER the seeding create() above

      await expect(branches.rename(b.id, "  ")).rejects.toMatchObject({ statusCode: 400 });

      // Fix 3 (broker): a rejected rename must publish nothing.
      expect(seen.filter((e) => e.type === "branch.updated")).toEqual([]);
    });
  });
});
