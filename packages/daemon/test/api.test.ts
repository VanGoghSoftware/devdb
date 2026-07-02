import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/http/api.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
import { DevdbError } from "../src/services/errors.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";

// buildServer's Deps.engine is typed against the concrete EngineRuntime class (unlike
// ProjectsDeps, which was retyped to the narrow *Api interfaces in engine-api.ts under
// amendment A2) — EngineRuntime carries private fields, so a plain fake object needs a single
// narrowly-scoped cast here to stand in for it. Only `.status()` is ever called by the routes
// exercised in this file.
function fakeEngine(): EngineRuntime {
  return { status: () => ({}) } as unknown as EngineRuntime;
}

// Only the methods api.ts's routes actually call need to exist for these tests; the rest of
// ProjectsService's surface isn't touched by the route under test.
function fakeProjects(): ProjectsService {
  return { create: vi.fn(), list: vi.fn(), byIdOr404: vi.fn(), delete: vi.fn() } as unknown as ProjectsService;
}

// Same rationale as fakeProjects() — Deps.services.branches is typed against the concrete
// BranchesService class, so a plain fake needs the same narrowly-scoped cast.
function fakeBranches(): BranchesService {
  return {
    create: vi.fn(), list: vi.fn(), byIdOr404: vi.fn(), delete: vi.fn(),
    detail: vi.fn(), connectionString: vi.fn(),
  } as unknown as BranchesService;
}

function testCfg() {
  return loadConfig({
    DEVDB_DATA_DIR: "/tmp/devdb-api-test-only",
    NEON_BINARIES_DIR: "/tmp/devdb-api-test-only/bin",
    PG_INSTALL_DIR: "/tmp/devdb-api-test-only/pg",
  });
}

describe("buildServer error handling", () => {
  it("maps a Zod validation failure on POST /api/projects to 400 with an issues array", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(),
      services: { projects: fakeProjects(), branches: fakeBranches() },
    });

    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { bogus: true } });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid request body");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toMatch(/name/);
  });
});

describe("buildServer branch routes", () => {
  it("POST /api/projects/:id/branches — valid body creates a branch as createdBy 'api'", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const fakeBranch = { id: "branch-1", projectId: "project-1", name: "dev" };
    const fakeDetail = { ...fakeBranch, endpointStatus: "stopped", port: null, connectionString: null };
    vi.mocked(branches.create).mockResolvedValue(fakeBranch as unknown as Awaited<ReturnType<BranchesService["create"]>>);
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<BranchesService["detail"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(),
      services: { projects: fakeProjects(), branches },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/branches",
      payload: { name: "dev" },
    });

    expect(res.statusCode).toBe(201);
    expect(branches.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", name: "dev", createdBy: "api" }),
    );
    expect(res.json()).toEqual(fakeDetail);
  });

  it("GET /api/projects/:id/branches — returns the service's array as 200", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const projects = fakeProjects();
    const branches = fakeBranches();
    const rows = [{ id: "branch-1" }, { id: "branch-2" }];
    vi.mocked(branches.list).mockResolvedValue(rows as unknown as Awaited<ReturnType<BranchesService["list"]>>);
    const app = buildServer({ cfg, state, engine: fakeEngine(), services: { projects, branches } });

    const res = await app.inject({ method: "GET", url: "/api/projects/project-1/branches" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(rows);
    expect(branches.list).toHaveBeenCalledWith("project-1");
  });

  it("GET /api/branches/:id — 404s when the service throws DevdbError(404)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    vi.mocked(branches.byIdOr404).mockImplementation(() => {
      throw new DevdbError(404, "branch does-not-exist not found");
    });
    const app = buildServer({
      cfg, state, engine: fakeEngine(),
      services: { projects: fakeProjects(), branches },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/);
  });

  it("DELETE /api/branches/:id — 204 on success, 409 with child names when blocked", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    vi.mocked(branches.delete).mockResolvedValueOnce(undefined);
    const app = buildServer({
      cfg, state, engine: fakeEngine(),
      services: { projects: fakeProjects(), branches },
    });

    const okRes = await app.inject({ method: "DELETE", url: "/api/branches/branch-1" });
    expect(okRes.statusCode).toBe(204);

    vi.mocked(branches.delete).mockRejectedValueOnce(
      new DevdbError(409, `branch "dev" has child branches: dev-child, dev-child-2 — delete them first`),
    );
    const blockedRes = await app.inject({ method: "DELETE", url: "/api/branches/branch-1" });
    expect(blockedRes.statusCode).toBe(409);
    expect(blockedRes.json().error).toMatch(/dev-child/);
    expect(blockedRes.json().error).toMatch(/dev-child-2/);
  });
});
