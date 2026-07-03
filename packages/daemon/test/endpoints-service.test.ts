import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { BranchesService } from "../src/services/branches.js";
import { ProjectsService } from "../src/services/projects.js";
import { EndpointsService } from "../src/services/endpoints.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { PortExhaustedError } from "../src/compute/ports.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { Logger } from "../src/logging/logger.js";
import type { DevdbEvent, EndpointStatus } from "@devdb/shared";

// Amendment A2 (controller): typed fakes satisfying the narrow service-facing interfaces from
// services/engine-api.ts — no `as never` casts. Mirrors branches-service.test.ts's fakes().
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

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  // Fix 1 (review): ProjectsDeps now requires `queue` — declared up front and shared with the
  // sibling services below (mirrors how they already share one queue instance with each other).
  const queue = new BranchQueue();
  const projects = new ProjectsService({ state, queue, ...f });
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const branches = new BranchesService({ state, queue, ...f });
  const logs = new LogsService();
  const events = new EventsService();
  const seen: DevdbEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const endpoints = new EndpointsService({ state, queue, branches, logs, events, ...f });
  return { f, state, project, mainBranch, branches, endpoints, queue, logs, events, seen };
}

describe("EndpointsService", () => {
  it("start allocates via computes.start and updates state to running with the port", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    // start() checks computes.statusOf() up front to short-circuit as idempotent when already
    // running (see the next test) — so it must report "stopped" for that first check, then
    // "running" once BranchesService.detail() builds the return value at the end (mirroring
    // a real ComputeManager transitioning from stopped to running across the start() call).
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    const detail = await endpoints.start(mainBranch.id);
    expect(f.computes.start).toHaveBeenCalledWith(
      expect.objectContaining({ branch: expect.objectContaining({ id: mainBranch.id }), pgVersion: 17 }),
    );
    expect(detail.endpointStatus).toBe("running");
    expect(detail.port).toBe(54300);
  });

  it("start is idempotent when computes.statusOf already reports running", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.start(mainBranch.id);
    expect(f.computes.start).not.toHaveBeenCalled();
  });

  // Fix 2 (review, final wave): a crashed compute leaves a "failed" entry in ComputeManager's map
  // — a dead compute_ctl/postgres the manager still believes exists, occupying that branch's slot.
  // Before this fix, startLocked()'s only special case was the "running" short-circuit above; a
  // "failed" status fell through to computes.start(), which throws `endpoint for branch X already
  // failed` (ComputeManager.start()'s own `existing` guard) — so an agent polling /api/sql after a
  // crash could never recover the branch via the API, only by restarting the whole daemon. Now
  // startLocked() calls computes.stop() first to reap the orphaned entry (ports, dir, map slot)
  // before proceeding to computes.start() as normal.
  it("start recovers a crashed (failed) compute by calling computes.stop() before computes.start()", async () => {
    const { f, mainBranch, state, endpoints } = await seeded();
    const order: string[] = [];
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("failed").mockReturnValue("running");
    vi.mocked(f.computes.stop).mockImplementation(async () => { order.push("stop"); });
    vi.mocked(f.computes.start).mockImplementation(async () => { order.push("start"); return { port: 54300 }; });
    vi.mocked(f.computes.portOf).mockReturnValue(54300);

    const detail = await endpoints.start(mainBranch.id);

    expect(order).toEqual(["stop", "start"]);
    expect(f.computes.stop).toHaveBeenCalledWith(mainBranch.id);
    expect(detail.endpointStatus).toBe("running");
    expect(state.branches.byId(mainBranch.id)!.endpointStatus).toBe("running");
  });

  it("start maps PortExhaustedError to a 409 naming running endpoints (project-qualified) and DEVDB_PORT_RANGE", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValue(new PortExhaustedError());
    vi.mocked(f.computes.runningPorts).mockReturnValue([{ branchId: mainBranch.id, port: 54300 }]);
    await expect(endpoints.start(mainBranch.id)).rejects.toMatchObject({ statusCode: 409 });
    // project-qualified (projectName/branchName), not the bare branch name — "acme" is the
    // project seeded() creates, "main" is its root branch.
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/acme\/main/);
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/DEVDB_PORT_RANGE/);
  });

  it("start still 404s via byIdOr404 for an unknown branch id even when ports are exhausted", async () => {
    const { f, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValue(new PortExhaustedError());
    await expect(endpoints.start("other-branch-id")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("start sets the persisted endpointStatus to failed (not left at starting) and durably records the error message when computes.start throws a non-port error", async () => {
    const { f, state, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/compute_ctl exited/);
    // computes.statusOf (mocked, defaults to "stopped") is what BranchesService.detail() reads
    // for the live-derived endpointStatus, so it can't show this test's persisted-row assertion.
    // Read the SQLite row directly to confirm the catch block's updateEndpoint({status:"failed"})
    // actually ran, rather than leaving the row stuck at the earlier "starting" write.
    const row = state.branches.byId(mainBranch.id)!;
    expect(row.endpointStatus).toBe("failed");
    expect(row.endpointError).toContain("compute_ctl exited before ready");
  });

  it("a subsequent successful start clears a previously-persisted endpointError", async () => {
    const { f, state, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/compute_ctl exited/);
    expect(state.branches.byId(mainBranch.id)!.endpointError).toContain("compute_ctl exited before ready");

    vi.mocked(f.computes.start).mockResolvedValueOnce({ port: 54300 });
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.start(mainBranch.id);
    expect(state.branches.byId(mainBranch.id)!.endpointError).toBeNull();
  });

  it("stop calls computes.stop and returns the branch as stopped", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    await endpoints.start(mainBranch.id);
    const detail = await endpoints.stop(mainBranch.id);
    expect(f.computes.stop).toHaveBeenCalledWith(mainBranch.id);
    expect(detail.endpointStatus).toBe("stopped");
    expect(detail.port).toBeNull();
  });

  // Fix 1 (restructure of the T16 wiring): start() now passes `onLine` straight into
  // computes.start()'s args object rather than subscribing after the fact via a separate
  // computes.onLine() call once start() has already resolved — the real ComputeManager
  // registers this listener at map-reservation time (before its own first await), so output
  // from the ENTIRE launch (including a launch that fails before ever reaching "running")
  // reaches LogsService's `branch:<id>:compute` channel, not just output after the compute is
  // already up.
  it("start passes onLine into computes.start(), wired to logs.ingest under the branch:<id>:compute channel", async () => {
    const { f, mainBranch, endpoints, logs } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.start(mainBranch.id);

    expect(f.computes.start).toHaveBeenCalledWith(expect.objectContaining({ onLine: expect.any(Function) }));
    // Drive the exact callback passed to computes.start(), as the real ComputeManager would when
    // the compute prints a line (at any point during its lifetime, including mid-launch), and
    // confirm it lands on the expected LogsService channel.
    const { onLine } = vi.mocked(f.computes.start).mock.calls[0]![0];
    onLine!("compute log line");
    expect(logs.recent(`branch:${mainBranch.id}:compute`)).toEqual(["compute log line"]);
  });

  // Fix 1: lines emitted BEFORE the compute reaches "running" (i.e. during an in-flight launch)
  // must still reach the logs channel — this is the whole point of registering onLine at
  // reservation time inside ComputeManager rather than after start() resolves. Simulated here by
  // invoking the captured onLine callback from inside a still-unresolved computes.start() mock,
  // mirroring exactly how the real manager would call it mid-launch.
  it("onLine passed into computes.start() reaches the logs channel for lines emitted before start() resolves", async () => {
    const { f, mainBranch, endpoints, logs } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    let capturedOnLine!: (line: string) => void;
    vi.mocked(f.computes.start).mockImplementationOnce(async (a) => {
      capturedOnLine = a.onLine!;
      capturedOnLine("line printed while still starting");
      return { port: 54300 };
    });

    await endpoints.start(mainBranch.id);

    expect(logs.recent(`branch:${mainBranch.id}:compute`)).toEqual(["line printed while still starting"]);
  });

  // Fix 1: a launch FAILURE's output must also reach the logs channel — this is exactly the case
  // the old post-hoc computes.onLine() subscription (only wired after a SUCCESSFUL start()) could
  // never cover, since a rejected start() never reached that subscribe call.
  it("onLine passed into computes.start() reaches the logs channel even when the launch fails", async () => {
    const { f, mainBranch, endpoints, logs } = await seeded();
    vi.mocked(f.computes.start).mockImplementationOnce(async (a) => {
      a.onLine!("compute_ctl: fatal error before ready");
      throw new Error("compute_ctl exited before ready");
    });

    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/compute_ctl exited before ready/);

    expect(logs.recent(`branch:${mainBranch.id}:compute`)).toEqual(["compute_ctl: fatal error before ready"]);
  });

  it("ensureRunning starts when not running", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    // ensureRunning() now shares start()'s exact queued startLocked() body (Fix 1) — a single
    // statusOf() idempotency check inside the queue lane, not a separate pre-check outside it.
    // So: one "stopped" for that check, then "running" once detail() builds the return value.
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    const detail = await endpoints.ensureRunning(mainBranch.id);
    expect(f.computes.start).toHaveBeenCalledOnce();
    expect(detail.endpointStatus).toBe("running");
  });

  it("ensureRunning is a no-op (skips start) when computes.statusOf already reports running", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.ensureRunning(mainBranch.id);
    expect(f.computes.start).not.toHaveBeenCalled();
  });

  it("byIdOr404 still guards an unknown branch id for start/stop", async () => {
    const { endpoints } = await seeded();
    await expect(endpoints.start("does-not-exist")).rejects.toMatchObject({ statusCode: 404 });
    await expect(endpoints.stop("does-not-exist")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("start/stop for the same branch are serialized through the shared queue", async () => {
    const { mainBranch, endpoints, queue } = await seeded();
    const p1 = endpoints.start(mainBranch.id);
    const p2 = endpoints.stop(mainBranch.id);
    await Promise.all([p1, p2]);
    // both settled without throwing a "start already running/entry exists" race — the queue
    // serialized them per branch id, exactly like BranchesService.create/delete.
    expect(queue.pendingCount()).toBe(0);
  });

  // Emission map (spec Decision 1): every persisted endpoint status transition is announced via
  // the setEndpointStatus helper — a successful start writes "starting" then "running", so
  // exactly 2 endpoint.status events fire, both for this branch.
  it("a successful start publishes exactly 2 endpoint.status events (starting, running)", async () => {
    const { f, mainBranch, endpoints, seen } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.start(mainBranch.id);
    const statusEvents = seen.filter((e) => e.type === "endpoint.status");
    expect(statusEvents).toHaveLength(2);
    for (const e of statusEvents) {
      expect(e).toMatchObject({ projectId: mainBranch.projectId, branchId: mainBranch.id });
    }
  });

  // A failed start still writes "starting" then "failed" — both persisted transitions must still
  // be announced (the event marks a write happened, not that the operation ultimately succeeded).
  it("a failed start publishes exactly 2 endpoint.status events (starting, failed)", async () => {
    const { f, mainBranch, endpoints, seen } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/compute_ctl exited/);
    const statusEvents = seen.filter((e) => e.type === "endpoint.status");
    expect(statusEvents).toHaveLength(2);
    for (const e of statusEvents) {
      expect(e).toMatchObject({ projectId: mainBranch.projectId, branchId: mainBranch.id });
    }
  });

  // stop() writes "stopping" then "stopped" — 2 endpoint.status events.
  it("stop publishes exactly 2 endpoint.status events (stopping, stopped)", async () => {
    const { f, mainBranch, endpoints, seen } = await seeded();
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await endpoints.start(mainBranch.id);
    seen.length = 0; // isolate stop()'s own events from start()'s
    await endpoints.stop(mainBranch.id);
    const statusEvents = seen.filter((e) => e.type === "endpoint.status");
    expect(statusEvents).toHaveLength(2);
    for (const e of statusEvents) {
      expect(e).toMatchObject({ projectId: mainBranch.projectId, branchId: mainBranch.id });
    }
  });

  // `events` is an OPTIONAL dep, same rationale as `logs` elsewhere in this codebase.
  it("start/stop work without throwing when events is omitted from deps", async () => {
    const f = fakes();
    const state = openState(":memory:");
    const queue = new BranchQueue();
    const projects = new ProjectsService({ state, queue, ...f });
    const { mainBranch } = await projects.create({ name: "acme" });
    const branches = new BranchesService({ state, queue, ...f });
    const logs = new LogsService();
    const endpoints = new EndpointsService({ state, queue, branches, logs, ...f });
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValue("running");
    vi.mocked(f.computes.portOf).mockReturnValue(54300);
    await expect(endpoints.start(mainBranch.id)).resolves.toBeDefined();
    await expect(endpoints.stop(mainBranch.id)).resolves.toBeDefined();
  });
});
