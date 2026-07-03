import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { ProjectsService } from "../src/services/projects.js";
import { BranchesService } from "../src/services/branches.js";
import { EndpointsService, type EndpointsLockedApi } from "../src/services/endpoints.js";
import type { BranchDetail } from "../src/services/branches.js";
import { TimeTravelService } from "../src/services/timetravel.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { EngineApiError } from "../src/engine/http.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { Logger } from "../src/logging/logger.js";
import type { DevdbEvent, EndpointStatus } from "@devdb/shared";

// Fix 3 (review): a small typed BranchDetail fixture builder — replaces the `({}) as never`
// casts the EndpointsLockedApi fakes below used to return, which bypassed the A2 typed-fake
// contract entirely (an empty object cast past the type system, not structurally checked against
// the real return shape at all). `overrides` lets individual call sites vary just the fields they
// care about (e.g. branchId-bearing tests don't need one here since these fakes never read the
// input branchId to build their return value) while everything else stays a valid BranchDetail.
function branchDetailFixture(overrides: Partial<BranchDetail> = {}): BranchDetail {
  return {
    id: "fixture-branch-id", projectId: "fixture-project-id", parentBranchId: null,
    name: "fixture", slug: "fixture", timelineId: "t".repeat(32), password: "pw",
    stickyPort: null, endpointStatus: "running", endpointError: null,
    importStatus: "none", importError: null, createdBy: "test", context: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    port: 54300, connectionString: null, lastRecordLsn: null,
    logicalSizeBytes: null, ancestorLsn: null,
    ...overrides,
  };
}

// Amendment A2 (controller, extended to this task): typed fakes satisfying the narrow
// service-facing interfaces from services/engine-api.ts — no `as never` casts. Mirrors
// branches-service.test.ts / endpoints-service.test.ts's fakes().
//
// Task 4: `logger` is a typed fake (Logger's three methods as vi.fn()s), not a cast — every
// service's deps now require it (ProjectsDeps), for compensation-path logging.
function fakes(): {
  storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi; logger: Logger;
} {
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
  const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { storcon, pageserver, safekeeper, computes, logger };
}

// TimeTravelService depends on EndpointsService only through its unqueued *Locked internals
// (see EndpointsLockedApi in services/endpoints.ts) — the queued swap it runs under
// queue.run(branchId, ...) must not re-enter the same branch id's lane via the public
// start()/stop() (see the deadlock note on TimeTravelService.swapOntoNewTimeline). A typed fake
// against that narrow interface, structurally identical to the real EndpointsService's surface.
function fakeEndpointsLocked(): EndpointsLockedApi {
  return {
    startLocked: vi.fn(async () => branchDetailFixture()),
    stopLocked: vi.fn(async () => branchDetailFixture()),
  };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  // Fix 1 (review): ProjectsDeps now requires `queue` — declared up front and shared with the
  // sibling services below (mirrors how they already share one queue instance with each other).
  const queue = new BranchQueue();
  const projects = new ProjectsService({ state, queue, ...f });
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const events = new EventsService();
  const seen: DevdbEvent[] = [];
  events.subscribe((e) => seen.push(e));
  // `events` threaded through `branches` too (not just `tt`) — TimeTravelService.branchAtTimestamp
  // delegates to THIS SAME BranchesService instance's create(), so it must share the one
  // EventsService for that delegated branch.created to actually fire (mirrors production wiring,
  // where every service is constructed against one shared EventsService instance).
  const branches = new BranchesService({ state, queue, events, ...f });
  const logs = new LogsService();
  const endpoints = new EndpointsService({ state, queue, branches, logs, ...f });
  const tt = new TimeTravelService({ state, queue, branches, endpoints, events, ...f });
  return { f, state, project, mainBranch, branches, endpoints, tt, queue, events, seen };
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

  // Fix 2 (review, task-2-fix.md): service-level coverage — proves branchAtTimestamp actually
  // PERSISTS the given context (not just accepts the param) by reading the row back from state,
  // catching a regression where the field was threaded into the arg type but silently dropped
  // before reaching branches.create().
  it("branchAtTimestamp persists the given fork context on the created branch", async () => {
    const { project, mainBranch, tt, state } = await seeded();
    const ctx = { git_branch: "feat/recover", workdir: "/w3", agent: "mcp", purpose: "pitr recovery" };
    const b = await tt.branchAtTimestamp({
      projectId: project.id, sourceBranchId: mainBranch.id,
      name: "recovered-ctx", isoTimestamp: "2026-07-02T10:00:00Z", context: ctx,
    });
    expect(state.branches.byId(b.id)!.context).toEqual(ctx);
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

  // Fix 1 (review, task-2-fix.md): restoreSwap's new-live-row INSERT previously omitted
  // `context`, so a branch created WITH fork context lost it silently on the swapped identity
  // (the new live row got NULL). Restore/reset is an identity CONTINUATION of the same branch —
  // its fork context must survive, exactly like `created_by` already does.
  it("restoreInPlace carries the branch's fork context through the identity swap", async () => {
    const { project, tt, branches, state } = await seeded();
    const ctx = { git_branch: "feat/x", workdir: "/w", agent: "claude", purpose: "try a migration" };
    const dev = await branches.create({ projectId: project.id, name: "dev", context: ctx });
    const out = await tt.restoreInPlace(dev.id, "2026-07-02T10:00:00Z");
    expect(out.context).toEqual(ctx);
    expect(state.branches.byId(out.id)!.context).toEqual(ctx);
  });

  it("resetToParent carries the branch's fork context through the identity swap", async () => {
    const { project, tt, branches, state } = await seeded();
    const ctx = { git_branch: "feat/y", workdir: "/w2", agent: "mcp", purpose: "reset test" };
    const dev = await branches.create({ projectId: project.id, name: "dev", context: ctx });
    const out = await tt.resetToParent(dev.id);
    expect(out.context).toEqual(ctx);
    expect(state.branches.byId(out.id)!.context).toEqual(ctx);
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
    // Fix 3: typed BranchDetail fixtures rather than `({}) as never` — a fake return value that
    // structurally matches EndpointsLockedApi's real contract.
    const stopLocked = vi.fn(async () => branchDetailFixture());
    const startLocked = vi.fn(async () => branchDetailFixture());
    // Rebuild tt with an endpoints fake we can assert call order/args on directly — the
    // seeded() default wires a real EndpointsService, which is exercised by the test above;
    // this test targets TimeTravelService's own orchestration of the *Locked calls.
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const { mainBranch: main2 } = await projects.create({ name: "acme2" });
    const branches = new BranchesService({ state, queue, ...f });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });
    const out = await tt2.restoreInPlace(main2.id, "2026-07-02T10:00:00Z");
    expect(stopLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: main2.id }), main2.id);
    // Fix 2 (review): the post-swap restart must target the NEW (swapped) branch identity, not
    // the original/archived one — before this fix, the fake accepted any lane/id, so a regression
    // restarting on the archived id (or with the wrong lane) would still pass. `out.id` is the
    // fresh identity restoreSwap minted; asserting against it (and explicitly NOT the original
    // main2.id) proves startLocked was actually called for the branch the caller now holds.
    expect(startLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: out.id }), out.id);
    expect(startLocked).not.toHaveBeenCalledWith(expect.objectContaining({ branchId: main2.id }), main2.id);
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
    const startLocked = vi.fn(async () => branchDetailFixture());
    const stopLocked = vi.fn(async () => branchDetailFixture());
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const { mainBranch: main2 } = await projects.create({ name: "acme3" });
    const branches = new BranchesService({ state, queue, ...f });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });
    vi.mocked(f.pageserver.timelineDetachAncestor).mockRejectedValueOnce(new Error("detach boom"));
    await expect(tt2.restoreInPlace(main2.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/detach boom/);
    // the swap never happened — branch.id is still the ORIGINAL, unchanged identity — so the
    // restart must target that same id, not some new/swapped id (there is no swapped id here).
    expect(stopLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: main2.id }), main2.id);
    expect(startLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: main2.id }), main2.id);
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

  // Emission map (spec Decision 1): swapOntoNewTimeline's single success point covers BOTH
  // restoreInPlace and resetToParent — exactly one branch.updated per call, for the SWAPPED
  // (new) branch id, with the ORIGINAL project id.
  it("restoreInPlace publishes exactly one branch.updated for the swapped branch id", async () => {
    const { project, mainBranch, tt, seen } = await seeded();
    const out = await tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z");
    const updated = seen.filter((e) => e.type === "branch.updated");
    expect(updated).toEqual([
      expect.objectContaining({ type: "branch.updated", projectId: project.id, branchId: out.id }),
    ]);
  });

  it("resetToParent publishes exactly one branch.updated for the swapped branch id", async () => {
    const { project, tt, branches, seen } = await seeded();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    seen.length = 0; // isolate resetToParent's own event from the branch.created above
    const out = await tt.resetToParent(dev.id);
    const updated = seen.filter((e) => e.type === "branch.updated");
    expect(updated).toEqual([
      expect.objectContaining({ type: "branch.updated", projectId: project.id, branchId: out.id }),
    ]);
  });

  // branchAtTimestamp delegates to BranchesService.create() — no separate emission in
  // branchAtTimestamp itself, so exactly one branch.created (not two, and not branch.updated).
  it("branchAtTimestamp publishes exactly one branch.created via delegation (no duplicate)", async () => {
    const { project, mainBranch, tt, seen } = await seeded();
    const b = await tt.branchAtTimestamp({
      projectId: project.id, sourceBranchId: mainBranch.id,
      name: "recovered", isoTimestamp: "2026-07-02T10:00:00Z",
    });
    expect(seen).toEqual([
      expect.objectContaining({ type: "branch.created", projectId: project.id, branchId: b.id }),
    ]);
  });

  // `events` is an OPTIONAL dep, same rationale as `logs` elsewhere in this codebase.
  it("restoreInPlace and resetToParent work without throwing when events is omitted from deps", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const { project, mainBranch } = await projects.create({ name: "acme" });
    const branches = new BranchesService({ state, queue, ...f });
    const logs = new LogsService();
    const endpoints = new EndpointsService({ state, queue, branches, logs, ...f });
    const tt = new TimeTravelService({ state, queue, branches, endpoints, ...f });
    await expect(tt.restoreInPlace(mainBranch.id, "2026-07-02T10:00:00Z")).resolves.toBeDefined();
    const dev = await branches.create({ projectId: project.id, name: "dev" });
    await expect(tt.resetToParent(dev.id)).resolves.toBeDefined();
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
    const startLocked = vi.fn(async () => branchDetailFixture());
    const stopLocked = vi.fn(async () => branchDetailFixture());
    const queue = new BranchQueue();
    const project2 = await new ProjectsService({ state, queue, ...f }).create({ name: "swapfail" });
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
    expect(stopLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: project2.mainBranch.id }), project2.mainBranch.id);
    expect(startLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: project2.mainBranch.id }), project2.mainBranch.id);
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });

  // Fix wave 1, Fix 1: the durable swap (restoreSwap) must be announced via branch.updated even
  // if the POST-swap restart (the `if (wasRunning) { ...startLocked(swapped.id)... }` block,
  // which runs AFTER the swap's own try/catch) subsequently throws. Before this fix, the publish
  // sat after that restart — so a restart failure meant the swap silently committed a new branch
  // identity with zero invalidation for any client watching /api/events, even though the swapped
  // branch row is durably real and queryable.
  it("restoreInPlace publishes branch.updated for the swapped branch even when the post-swap restart fails", async () => {
    const { f, mainBranch, state } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    // stopLocked (the PRE-swap stop) must succeed so the swap itself proceeds; startLocked (the
    // POST-swap restart) rejects — exactly the failure window this fix targets. Rebuild the
    // service graph with a fresh events/seen collector (mirrors the other rebuilt-fixture tests in
    // this file) rather than reusing seeded()'s default EndpointsService, since this test needs to
    // control startLocked's outcome directly.
    const stopLocked = vi.fn(async () => branchDetailFixture());
    const startLocked = vi.fn(async () => { throw new Error("restart boom"); });
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const { mainBranch: main2 } = await projects.create({ name: "restartfail" });
    const branches = new BranchesService({ state, queue, ...f });
    const events = new EventsService();
    const seen: DevdbEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, events, ...f,
    });

    await expect(tt2.restoreInPlace(main2.id, "2026-07-02T10:00:00Z")).rejects.toThrow(/restart boom/);

    // (a) the swap committed durably — the original row is archived under its new suffixed name,
    // and a new sibling row (the swapped/live identity) now exists alongside it.
    const archived = state.branches.byId(main2.id)!;
    expect(archived.name).toContain("main_pitr_archived_");
    const swapped = state.branches.listByProject(archived.projectId).find((b) => b.id !== main2.id)!;
    expect(swapped).toBeDefined();
    expect(swapped.name).toBe("main");
    // (b) exactly ONE branch.updated fired, for the swapped (new, now-live) branch id — NOT the
    // archived original id.
    const updated = seen.filter((e) => e.type === "branch.updated");
    expect(updated).toEqual([
      expect.objectContaining({ type: "branch.updated", projectId: archived.projectId, branchId: swapped.id }),
    ]);
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });

  // Regression (P3, initial-stop strand): the FIRST stop — the one that quiesces a running
  // endpoint BEFORE the swap's try/catch — used to sit OUTSIDE that try/catch. If it threw, the
  // method exited before the compensation path, leaving the previously-running branch stranded
  // stopped even though no timeline/swap work happened and the restore ultimately failed. The
  // initial stop must be under the same discipline: a stop failure restarts the original endpoint
  // and rethrows, and — since no timeline was created yet — must NOT try to delete one.
  it("restoreInPlace restarts the original endpoint when the INITIAL stop fails (no strand)", async () => {
    const { f, mainBranch, state } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    const queue = new BranchQueue();
    const project2 = await new ProjectsService({ state, queue, ...f }).create({ name: "stopfail" });
    const branches = new BranchesService({ state, queue, ...f });
    // Typed BranchDetail fixture for the compensating restart's return (no `as never` cast);
    // resolving rather than rejecting keeps the compensation's best-effort .catch() quiet.
    const startLocked = vi.fn(async () => branchDetailFixture());
    const stopLocked = vi.fn(async () => { throw new Error("stop boom"); });
    const tt2 = new TimeTravelService({
      state, queue, branches, endpoints: { startLocked, stopLocked }, ...f,
    });

    await expect(tt2.restoreInPlace(project2.mainBranch.id, "2026-07-02T10:00:00Z"))
      .rejects.toThrow(/stop boom/);

    expect(stopLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: project2.mainBranch.id }), project2.mainBranch.id);
    // The strand fix: the swap never began (the stop is its first side effect), so branch.id is
    // still the ORIGINAL, unchanged identity — the previously-running endpoint is restarted on
    // THAT id (under that same held lane), not left stopped.
    expect(startLocked).toHaveBeenCalledWith(expect.objectContaining({ branchId: project2.mainBranch.id }), project2.mainBranch.id);
    // ...and strictly AFTER the failed stop — the restart is a COMPENSATION for it, never a
    // pre-stop start (invocationCallOrder is vitest's global 1-indexed call sequence).
    expect(stopLocked.mock.invocationCallOrder[0]!)
      .toBeLessThan(startLocked.mock.invocationCallOrder[0]!);
    // The stop failed before any timeline was created — the newTimelineCreated guard must keep the
    // compensation from deleting a timeline that never existed.
    expect(f.pageserver.timelineDelete).not.toHaveBeenCalled();
    expect(f.safekeeper.timelineDelete).not.toHaveBeenCalled();
    void mainBranch; // unused in this rebuilt-fixture test; kept for destructure symmetry
  });
});
