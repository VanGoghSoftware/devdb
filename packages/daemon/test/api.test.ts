import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/http/api.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
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

describe("buildServer error handling", () => {
  it("maps a Zod validation failure on POST /api/projects to 400 with an issues array", async () => {
    const cfg = loadConfig({
      DEVDB_DATA_DIR: "/tmp/devdb-api-test-only",
      NEON_BINARIES_DIR: "/tmp/devdb-api-test-only/bin",
      PG_INSTALL_DIR: "/tmp/devdb-api-test-only/pg",
    });
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
