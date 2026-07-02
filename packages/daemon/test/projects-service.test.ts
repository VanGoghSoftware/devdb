import { describe, expect, it, vi } from "vitest";
import { openState } from "../src/state/db.js";
import { ProjectsService } from "../src/services/projects.js";
import { slugify } from "../src/services/slug.js";
import type { ComputesApi, PageserverApi, SafekeeperApi, StorconApi } from "../src/services/engine-api.js";
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
});
