import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { ProjectsService } from "../src/services/projects.js";
import { BranchesService } from "../src/services/branches.js";
import { EndpointsService, type EndpointsLockedApi } from "../src/services/endpoints.js";
import { TimeTravelService } from "../src/services/timetravel.js";
import { LogsService } from "../src/services/logs.js";
import { EngineApiError } from "../src/engine/http.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { EndpointStatus } from "@devdb/shared";

// Amendment A2 (controller, extended to this task): typed fakes satisfying the narrow
// service-facing interfaces from services/engine-api.ts — no `as never` casts. Mirrors
// branches-service.test.ts / endpoints-service.test.ts's fakes().
function fakes(): { storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi } {
  const storcon: StorconApi = {
    tenantCreate: vi.fn(async () => {}),
    getLsnByTimestamp: vi.fn(async () => ({ lsn: "0/AA", kind: "present" })),
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
    start: vi.fn(async () => ({ port: 54300 })),
    stop: vi.fn(async () => {}),
    statusOf: vi.fn((): EndpointStatus => "stopped"),
    portOf: vi.fn(() => null),
    runningPorts: vi.fn(() => []),
    onLine: vi.fn(() => () => {}),
    stopAll: vi.fn(async () => {}),
  };
  return { storcon, pageserver, safekeeper, computes };
}

// TimeTravelService depends on EndpointsService only through its unqueued *Locked internals
// (see EndpointsLockedApi in services/endpoints.ts) — the queued swap it runs under
// queue.run(branchId, ...) must not re-enter the same branch id's lane via the public
// start()/stop() (see the deadlock note on TimeTravelService.swapOntoNewTimeline). A typed fake
// against that narrow interface, structurally identical to the real EndpointsService's surface.
function fakeEndpointsLocked(): EndpointsLockedApi {
  return {
    startLocked: vi.fn(async () => ({}) as never),
    stopLocked: vi.fn(async () => ({}) as never),
  };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  const projects = new ProjectsService({ state, ...f });
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const queue = new BranchQueue();
  const branches = new BranchesService({ state, queue, ...f });
  const logs = new LogsService();
  const endpoints = new EndpointsService({ state, queue, branches, logs, ...f });
  const tt = new TimeTravelService({ state, queue, branches, endpoints, ...f });
  return { f, state, project, mainBranch, branches, endpoints, tt, queue };
}

describe("TimeTravelService", () => {
  it("lsnAtTimestamp rejects non-present kinds with explanation", async () => {
    const { f, mainBranch, tt } = await seeded();
    vi.mocked(f.storcon.getLsnByTimestamp).mockResolvedValueOnce({ lsn: "0/0", kind: "future" });
    await expect(tt.lsnAtTimestamp(mainBranch.id, "2030-01-01T00:00:00Z"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("lsnAtTimestamp rejects an invalid timestamp string", async () => {
    const { mainBranch, tt } = await seeded();
    await expect(tt.lsnAtTimestamp(mainBranch.id, "not-a-date"))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("lsnAtTimestamp returns the lsn when kind is present", async () => {
    const { mainBranch, tt } = await seeded();
    await expect(tt.lsnAtTimestamp(mainBranch.id, "2026-07-02T10:00:00Z")).resolves.toBe("0/AA");
  });

  it("branchAtTimestamp creates a branch at the resolved LSN", async () => {
    const { f, project, mainBranch, tt, state } = await seeded();
    const b = await tt.branchAtTimestamp({
      projectId: project.id, sourceBranchId: mainBranch.id,
      name: "recovered", isoTimestamp: "2026-07-02T10:00:00Z",
    });
    expect(b.parentBranchId).toBe(mainBranch.id);
    const req = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)![1] as Record<string, unknown>;
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

  it("restoreInPlace creates the new timeline ancestored on the branch's OWN timeline at the resolved lsn", async () => {
    const { f, mainBranch, tt } = await seeded();
    await tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z");
    const req = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(req.ancestor_timeline_id).toBe(mainBranch.timelineId);
    expect(req.ancestor_start_lsn).toBe("0/AA");
  });

  it("restoreInPlace stops a running endpoint before the swap and restarts it after", async () => {
    const { f, mainBranch, tt } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    const stopLocked = vi.fn(async () => ({}) as never);
    const startLocked = vi.fn(async () => ({}) as never);
    // Rebuild tt with an endpoints fake we can assert call order/args on directly — the
    // seeded() default wires a real EndpointsService, which is exercised by the test above;
    // this test targets TimeTravelService's own orchestration of the *Locked calls.
    const state = openState(":memory:");
    const projects = new ProjectsService({ state, ...f });
    const { mainBranch: main2 } = await projects.create({ name: "acme2" });
    const queue = new BranchQueue();
    const branches = new BranchesService({ state, queue, ...f });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });
    await tt2.restoreInPlace(main2.id, "2026-07-02T10:00:00Z");
    expect(stopLocked).toHaveBeenCalledWith(main2.id);
    expect(startLocked).toHaveBeenCalled();
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });

  it("restoreInPlace cleans up the orphan timeline when detach fails", async () => {
    const { f, mainBranch, tt } = await seeded();
    vi.mocked(f.pageserver.timelineDetachAncestor).mockRejectedValueOnce(new Error("detach boom"));
    await expect(tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/detach boom/);
    expect(f.pageserver.timelineDelete).toHaveBeenCalled();
    expect(f.safekeeper.timelineDelete).toHaveBeenCalled();
  });

  it("restoreInPlace restarts a previously-running endpoint on the ORIGINAL branch when detach fails (no side effect from a failed attempt)", async () => {
    const { f, mainBranch, tt } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    const startLocked = vi.fn(async () => ({}) as never);
    const stopLocked = vi.fn(async () => ({}) as never);
    const state = openState(":memory:");
    const projects = new ProjectsService({ state, ...f });
    const { mainBranch: main2 } = await projects.create({ name: "acme3" });
    const queue = new BranchQueue();
    const branches = new BranchesService({ state, queue, ...f });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });
    vi.mocked(f.pageserver.timelineDetachAncestor).mockRejectedValueOnce(new Error("detach boom"));
    await expect(tt2.restoreInPlace(main2.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/detach boom/);
    // the swap never happened — branch.id is still the ORIGINAL, unchanged identity — so the
    // restart must target that same id, not some new/swapped id (there is no swapped id here).
    expect(stopLocked).toHaveBeenCalledWith(main2.id);
    expect(startLocked).toHaveBeenCalledWith(main2.id);
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });

  it("resetToParent refuses when children exist", async () => {
    const { project, tt, branches } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await branches.create({ projectId: project.id, name: "grandchild", parentBranchId: dev.id });
    await expect(tt.resetToParent(dev.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resetToParent refuses on a branch with no parent (main)", async () => {
    const { mainBranch, tt } = await seeded();
    await expect(tt.resetToParent(mainBranch.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("resetToParent swaps onto a fresh fork of the parent head (no detach_ancestor)", async () => {
    const { f, project, tt, branches, state } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    const out = await tt.resetToParent(dev.id);
    const req = vi.mocked(f.pageserver.timelineCreate).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(req.ancestor_start_lsn).toBeUndefined(); // parent head
    expect(req.ancestor_timeline_id).toBe(project ? state.branches.byProjectAndName(project.id, "main")!.timelineId : undefined);
    expect(f.pageserver.timelineDetachAncestor).not.toHaveBeenCalled();
    expect(out.name).toBe("dev");
    expect(state.branches.byId(dev.id)!.name).toContain("dev_reset_archived_");
  });

  it("swap serializes under the branch's own queue lane (no concurrent swap for the same branch)", async () => {
    const { mainBranch, tt, queue, state } = await seeded();
    const p1 = tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z");
    // A second op queued under the SAME original branch id must run strictly after the first
    // settles, reading FRESH state rather than a stale snapshot from before p1 ran. Proof: by the
    // time p2's queued body executes, byIdOr404(mainBranch.id) resolves to p1's already-archived
    // row (mainBranch.id itself was renamed, not deleted, by p1's swap) — so p2 legitimately
    // restores THAT row and archives it again (double-suffixed name). If the two calls had
    // instead raced (queue NOT serializing), p2 would have read the pre-p1 "main" row and
    // produced a second sibling row also named "main", which restoreSwap's UNIQUE(slug)/
    // UNIQUE(project_id, id) constraints don't even prevent by name — this ordering is the real
    // signal, not a uniqueness violation.
    const p2 = tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:01Z");
    const [out1, out2] = await Promise.all([p1, p2]);
    expect(out1.name).toBe("main"); // p1 ran first, against the still-untouched original row
    expect(out2.name).toContain("main_pitr_archived_"); // p2 ran second, against p1's archived leftover
    expect(state.branches.byId(mainBranch.id)!.name).toContain("main_pitr_archived_");
    expect(queue.pendingCount()).toBe(0);
  });

  // Review fix 3: oracle (neond branch.rs:689-701) classifies engine LSN-range failures at
  // create-at-LSN time into a client-actionable 400, not a generic passthrough of whatever status
  // the engine returned. restoreInPlace always creates at an LSN (its own-timeline branch point),
  // so it's the most direct path to exercise this without also standing up a second scenario for
  // branchAtTimestamp (which shares the exact same classifyLsnRangeError() helper).
  it("restoreInPlace maps an engine LSN-out-of-range failure to a 400 carrying the engine's text", async () => {
    const { f, mainBranch, tt } = await seeded();
    vi.mocked(f.pageserver.timelineCreate).mockRejectedValueOnce(
      new EngineApiError("timeline_create", 400, "requested LSN is out of range"),
    );
    await expect(tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z")).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("requested LSN is out of range"),
    });
  });

  // Review fix 4: a timestamp with no explicit offset is silently interpreted in the SERVER's
  // local timezone by the Date constructor — a correctness trap for a PITR timestamp, not a
  // style nit. Must be rejected before it ever reaches storcon.
  it("lsnAtTimestamp rejects a timestamp with no explicit timezone", async () => {
    const { mainBranch, tt } = await seeded();
    await expect(tt.lsnAtTimestamp(mainBranch.id, "2026-07-02T10:00:00"))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/timezone/) });
  });

  // Review fix 1: resetToParent's children-exist check must run INSIDE the queued lane against
  // lane-fresh state, not against a pre-queue snapshot taken before the caller even reached the
  // front of the line. Proof: queue a job on dev.id's OWN lane that inserts a child of dev
  // BEFORE resetToParent(dev.id) is even called — branches.create() for a child of dev queues
  // under parent.id (i.e. dev.id, see BranchesService.create), the exact same lane key
  // resetToParent(dev.id) uses, and both calls reach their respective queue.run(dev.id, ...)
  // registration synchronously (no `await` precedes it in either call chain) — so the child-
  // creating job is guaranteed to be queued first and to have committed its insert before
  // reset's own queued body runs its (now lane-scoped) children check.
  it("resetToParent's children check sees a child created after the call was queued but before its lane turn (TOCTOU)", async () => {
    const { project, tt, branches, queue } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });

    const childPromise = branches.create({
      projectId: project.id, name: "late-child", parentBranchId: dev.id,
    });
    const resetPromise = tt.resetToParent(dev.id);

    await childPromise;
    await expect(resetPromise).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("late-child"),
    });
    expect(queue.pendingCount()).toBe(0);
  });

  // Review fix 2: ANY failure after the endpoint was stopped — not just a failed detachAncestor —
  // must trigger the full compensation: best-effort delete the new timeline on both engine
  // components, restart the ORIGINAL branch's endpoint if it was running, rethrow. restoreSwap is
  // the failure point never previously covered (only detachAncestor had a compensation path).
  it("restoreInPlace compensates a restoreSwap failure: new timeline deleted on both engines, original endpoint restarted", async () => {
    const { f, mainBranch, tt, state } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    const startLocked = vi.fn(async () => ({}) as never);
    const stopLocked = vi.fn(async () => ({}) as never);
    const project2 = await new ProjectsService({ state, ...f }).create({ name: "swapfail" });
    const queue = new BranchQueue();
    const branches = new BranchesService({ state, queue, ...f });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });

    vi.spyOn(state.branches, "restoreSwap").mockImplementationOnce(() => {
      throw new Error("swap boom");
    });

    await expect(tt2.restoreInPlace(project2.mainBranch.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/swap boom/);

    expect(f.pageserver.timelineDelete).toHaveBeenCalled();
    expect(f.safekeeper.timelineDelete).toHaveBeenCalled();
    // the swap never committed — branch.id is still the ORIGINAL, unchanged identity, so the
    // restart must target that same id.
    expect(stopLocked).toHaveBeenCalledWith(project2.mainBranch.id);
    expect(startLocked).toHaveBeenCalledWith(project2.mainBranch.id);
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });
});
