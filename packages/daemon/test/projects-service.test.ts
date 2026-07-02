import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { ProjectsService } from "../src/services/projects.js";
import { slugify } from "../src/services/slug.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
import type { BranchRow } from "../src/state/repos.js";
import type { EndpointStatus } from "@devdb/shared";
import { StorconClient } from "../src/engine/storcon-client.js";
import { PageserverClient } from "../src/engine/pageserver-client.js";
import { SafekeeperClient } from "../src/engine/safekeeper-client.js";
import { ComputeManager } from "../src/compute/manager.js";
import { loadConfig } from "../src/config.js";

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
  return { storcon, pageserver, safekeeper, computes };
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
    const _computes: ComputesApi = new ComputeManager(cfg);
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
      await expect(svc.create({ name: "acme" })).rejects.toMatchObject({ statusCode: 409 });
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
      importStatus: "none", importError: null, createdBy: "api",
      createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const b: BranchRow = {
      id: "branch-b", projectId: project.id, parentBranchId: "branch-a", name: "b", slug: "b",
      timelineId: "b".repeat(32), password: "x", stickyPort: null, endpointStatus: "stopped",
      importStatus: "none", importError: null, createdBy: "api",
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
