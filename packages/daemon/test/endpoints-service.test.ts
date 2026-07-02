import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { BranchesService } from "../src/services/branches.js";
import { ProjectsService } from "../src/services/projects.js";
import { EndpointsService } from "../src/services/endpoints.js";
import { PortExhaustedError } from "../src/compute/ports.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { EndpointStatus } from "@devdb/shared";

// Amendment A2 (controller): typed fakes satisfying the narrow service-facing interfaces from
// services/engine-api.ts — no `as never` casts. Mirrors branches-service.test.ts's fakes().
function fakes(): { storcon: StorconApi; pageserver: PageserverApi; safekeeper: SafekeeperApi; computes: ComputesApi } {
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
  return { storcon, pageserver, safekeeper, computes };
}

async function seeded() {
  const f = fakes();
  const state = openState(":memory:");
  const projects = new ProjectsService({ state, ...f });
  const { project, mainBranch } = await projects.create({ name: "acme" });
  const queue = new BranchQueue();
  const branches = new BranchesService({ state, queue, ...f });
  const endpoints = new EndpointsService({ state, queue, branches, ...f });
  return { f, state, project, mainBranch, branches, endpoints, queue };
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

  it("start maps PortExhaustedError to a 409 naming running endpoints and DEVDB_PORT_RANGE", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValue(new PortExhaustedError());
    vi.mocked(f.computes.runningPorts).mockReturnValue([{ branchId: mainBranch.id, port: 54300 }]);
    await expect(endpoints.start(mainBranch.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/main/);
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/DEVDB_PORT_RANGE/);
  });

  it("start still 404s via byIdOr404 for an unknown branch id even when ports are exhausted", async () => {
    const { f, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValue(new PortExhaustedError());
    await expect(endpoints.start("other-branch-id")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("start sets the persisted endpointStatus to failed (not left at starting) when computes.start throws a non-port error", async () => {
    const { f, state, mainBranch, endpoints } = await seeded();
    vi.mocked(f.computes.start).mockRejectedValueOnce(new Error("compute_ctl exited before ready"));
    await expect(endpoints.start(mainBranch.id)).rejects.toThrow(/compute_ctl exited/);
    // computes.statusOf (mocked, defaults to "stopped") is what BranchesService.detail() reads
    // for the live-derived endpointStatus, so it can't show this test's persisted-row assertion.
    // Read the SQLite row directly to confirm the catch block's updateEndpoint({status:"failed"})
    // actually ran, rather than leaving the row stuck at the earlier "starting" write.
    expect(state.branches.byId(mainBranch.id)!.endpointStatus).toBe("failed");
  });

  it("stop calls computes.stop and returns the branch as stopped", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    await endpoints.start(mainBranch.id);
    const detail = await endpoints.stop(mainBranch.id);
    expect(f.computes.stop).toHaveBeenCalledWith(mainBranch.id);
    expect(detail.endpointStatus).toBe("stopped");
    expect(detail.port).toBeNull();
  });

  it("ensureRunning starts when not running", async () => {
    const { f, mainBranch, endpoints } = await seeded();
    // Same statusOf-transition rationale as the "start allocates..." test above: ensureRunning's
    // own not-running check, then start()'s idempotency check, both need "stopped" before the
    // compute is (fake-)started; detail() at the end needs "running".
    vi.mocked(f.computes.statusOf).mockReturnValueOnce("stopped").mockReturnValueOnce("stopped").mockReturnValue("running");
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
});
