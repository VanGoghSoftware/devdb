import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { BranchQueue } from "../src/state/queue.js";
import { BranchesService } from "../src/services/branches.js";
import { ProjectsService } from "../src/services/projects.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { EndpointStatus } from "@devdb/shared";

// Amendment A2: typed fakes satisfying the narrow service-facing interfaces from
// services/engine-api.ts — no `as never` casts. Every method the interfaces declare must
// exist on the fake (even ones a given test never exercises) or this file fails to typecheck.
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
    start: vi.fn(async () => ({ port: 1 })),
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
    vi.mocked(f.pageserver.timelineInfo).mockRejectedValueOnce(new Error("pageserver unreachable"));
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
    const projects = new ProjectsService({ state, ...f });
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
});
