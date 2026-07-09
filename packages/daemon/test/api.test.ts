import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/http/api.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService, BranchDetail } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { TimeTravelService } from "../src/services/timetravel.js";
import type { SqlService } from "../src/services/sql.js";
import { LogsService } from "../src/services/logs.js";
import { EventsService } from "../src/services/events.js";
import { DevdbError } from "../src/services/errors.js";
import { loadConfig } from "../src/config.js";
import { openState } from "../src/state/db.js";
import { toBranchDto, toPgBuildDto } from "../src/services/dto.js";
import { BuildRegistry } from "../src/compute/builds/registry.js";
import type { Provisioner } from "../src/compute/builds/provisioner.js";
import type { ComputesApi } from "../src/services/engine-api.js";
import {
  cleanupDirs, fakeInstallDir, fakeVolumeBuild, noopLogger, scaffoldBuildDirs, trackedDirs,
} from "./helpers/build-fixtures.js";

// Task 3 (DTO mappers): a realistic, FULLY-populated BranchDetail fixture — including the
// internal-only `password`/`stickyPort`/`importStatus`/`importError` columns — so route tests
// below can prove redaction actually happens through the real HTTP response, not just that a
// sparse fake happens to lack a `password` key to begin with (JSON.stringify drops `undefined`
// values, so a fake missing a field would make a leaking mapper pass these tests too).
function fakeBranchDetail(overrides: Partial<BranchDetail> = {}): BranchDetail {
  return {
    id: "branch-1", projectId: "project-1", parentBranchId: null, name: "dev", slug: "acme-dev-abc123",
    timelineId: "t".repeat(32), password: "SECRET-PW", stickyPort: 54301,
    endpointStatus: "stopped", endpointError: null, importStatus: "none", importError: null,
    createdBy: "api", context: null,
    createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
    port: null, connectionString: null, jdbcUrl: null, lastRecordLsn: null, logicalSizeBytes: null, ancestorLsn: null,
    runningPgVersion: null, // Task 8: stopped by default, matching endpointStatus above
    ...overrides,
  };
}

// buildServer's Deps.engine is typed against the concrete EngineRuntime class (unlike
// ProjectsDeps, which was retyped to the narrow *Api interfaces in engine-api.ts under
// amendment A2) — EngineRuntime carries private fields, so a plain fake object needs a single
// narrowly-scoped cast here to stand in for it. Only `.status()` is ever called by the routes
// exercised in this file.
function fakeEngine(): EngineRuntime {
  return { status: () => ({}) } as unknown as EngineRuntime;
}

// LogsService (T16) is a plain in-process class with no external dependencies — a real instance
// is cheaper and more honest here than a typed fake (unlike the engine-client interfaces above,
// there's no external system boundary to stand in for).
function fakeLogs(): LogsService {
  return new LogsService();
}

// EventsService (Task 1) — same rationale as fakeLogs(): a plain in-process fanout class with no
// external dependencies, so a real instance is used rather than a mock.
function fakeEvents(): EventsService {
  return new EventsService();
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
    detail: vi.fn(), connectionString: vi.fn(), rename: vi.fn(),
  } as unknown as BranchesService;
}

// Same rationale as fakeProjects()/fakeBranches() — Deps.services.endpoints is typed against
// the concrete EndpointsService class.
function fakeEndpoints(): EndpointsService {
  return {
    start: vi.fn(), stop: vi.fn(), ensureRunning: vi.fn(),
  } as unknown as EndpointsService;
}

// Same rationale as fakeProjects()/fakeBranches()/fakeEndpoints() — Deps.services.timetravel is
// typed against the concrete TimeTravelService class.
function fakeTimetravel(): TimeTravelService {
  return {
    lsnAtTimestamp: vi.fn(), branchAtTimestamp: vi.fn(), restoreInPlace: vi.fn(), resetToParent: vi.fn(),
  } as unknown as TimeTravelService;
}

// Same rationale as the fakes above — Deps.services.sql (T17) is typed against the concrete
// SqlService class.
function fakeSql(): SqlService {
  return { run: vi.fn() } as unknown as SqlService;
}

// Task 10 (dynamic-pg-builds): Deps.computes/registry/provisioner became required so the
// pg-builds routes below can call them unconditionally (Task 9 left them optional purely so
// this file's ~30 pre-existing inline Deps literals — none of which touched pg-builds — didn't
// all need editing just to satisfy a new required field; Task 10 IS the task that touches them).
// A minimal no-op fake is enough for every route test that doesn't exercise pg-builds; the
// pg-builds describe block below overrides these three per test.
function fakeComputes(): ComputesApi {
  return {
    start: vi.fn(), stop: vi.fn(), statusOf: vi.fn(), portOf: vi.fn(),
    runningPorts: vi.fn(() => []), runningPgbin: vi.fn(() => null), runningPgbins: vi.fn(() => []),
    onLine: vi.fn(() => () => {}), stopAll: vi.fn(),
  } as unknown as ComputesApi;
}

// Same rationale as fakeProjects()/fakeBranches() above — Deps.registry is typed against the
// concrete BuildRegistry class. Only the methods the pg-builds routes call need to exist; the
// pg-builds describe block below builds a REAL BuildRegistry over scaffolded temp dirs (via
// makePgBuildsRegistry) instead of this bare default, since those tests need real row/fs behavior.
function fakeRegistry(): BuildRegistry {
  return {
    list: vi.fn(() => []), installedMajors: vi.fn(() => []), degradedMajors: vi.fn(() => []),
    activate: vi.fn(), pgbinFor: vi.fn(), versionForPgbin: vi.fn(() => null),
    assertRemovable: vi.fn(), gcCandidates: vi.fn(() => []),
  } as unknown as BuildRegistry;
}

// Only the methods api.ts's pg-builds routes actually call need to exist — same rationale as
// fakeProjects()/fakeBranches() etc. above. Deps.provisioner is typed against the concrete
// Provisioner class, so a plain fake needs the same narrowly-scoped cast.
//
// Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3 — mutation lane): the activate
// ROUTE now calls provisioner.activate(id, opts) instead of registry.activate() +
// provisioner.recomposeDistrib() + events.publish() directly (see api.ts's own comment on that
// route) — Provisioner.activate()'s OWN behavior (that it really does call registry.activate,
// recomposeDistrib, and publish, in that order, inside its mutation lane) is covered directly in
// provisioner.test.ts; the tests in THIS file only need to prove the route calls
// provisioner.activate with the right args and maps its result/rejection correctly, so the
// default fake here is a bare vi.fn() like every other method — individual tests below wire it
// to either delegate into a REAL registry (via makePgBuildsRegistry()) or reject with a specific
// DevdbError, whichever the test is proving.
function fakeProvisioner(): Provisioner {
  return {
    check: vi.fn(), pull: vi.fn(), remove: vi.fn(), activate: vi.fn(),
    updateAvailableFor: vi.fn(() => null),
  } as unknown as Provisioner;
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { bogus: true } });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid request body");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toMatch(/name/);
  });

  // Task 8: REST-path parity for ProjectsService.create()'s major-installed guard — the route
  // itself has no opinion on pgVersion validity beyond the shared PgVersionSchema (gte(14), no
  // upper bound post dynamic-pg-builds Task 1); "is this major actually installed" is entirely a
  // service-layer concern (ProjectsService.create(), gated on its optional `builds` dep — see
  // projects-service.test.ts's own "create() major guard" tests for full service-level coverage).
  // This test proves only the HTTP wiring: a DevdbError(400) thrown by projects.create() surfaces
  // as a 400 with that exact message, the same way every other service-thrown DevdbError already
  // does through this route layer (see the 409/404 tests elsewhere in this file) — not a
  // duplicate of the guard's own logic, which belongs to the service, not the route.
  it("POST /api/projects — 400 when the service rejects an uninstalled pgVersion major", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const projects = fakeProjects();
    vi.mocked(projects.create).mockRejectedValue(
      new DevdbError(400, "Postgres 18 is not installed — installed majors: 14, 15, 16, 17. Pull it via POST /api/pg-builds/pull."),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects, branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "shop", pgVersion: 18 } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not installed — installed majors: 14, 15, 16, 17/);
  });
});

describe("buildServer branch routes", () => {
  it("POST /api/projects/:id/branches — valid body creates a branch as createdBy 'api', response DTO drops password", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const fakeBranch = { id: "branch-1", projectId: "project-1", name: "dev" };
    const fakeDetail = fakeBranchDetail({ id: "branch-1", projectId: "project-1", name: "dev" });
    vi.mocked(branches.create).mockResolvedValue(fakeBranch as unknown as Awaited<ReturnType<BranchesService["create"]>>);
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
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
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
    expect(body.stickyPort).toBeUndefined();
  });

  // Task 12: REST fork-context parity — non-MCP callers (e.g. a human or script hitting the
  // REST API directly rather than through an MCP-connected agent) must be able to attach the
  // same fork context (git_branch/workdir/agent/purpose/client) that create_branch (MCP) does,
  // and it must round-trip through the response DTO. createdBy stays "api" here — this is
  // explicitly the non-MCP path, distinguished from MCP's own createdBy: "mcp".
  it("POST /api/projects/:id/branches — accepts an optional context body, round-trips it in the response DTO, createdBy stays 'api'", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const context = { git_branch: "feature/foo", workdir: "/repo/worktrees/foo", purpose: "manual test" };
    const fakeBranch = { id: "branch-1", projectId: "project-1", name: "dev" };
    const fakeDetail = fakeBranchDetail({ id: "branch-1", projectId: "project-1", name: "dev", context });
    vi.mocked(branches.create).mockResolvedValue(fakeBranch as unknown as Awaited<ReturnType<BranchesService["create"]>>);
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/branches",
      payload: { name: "dev", context },
    });

    expect(res.statusCode).toBe(201);
    expect(branches.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", name: "dev", createdBy: "api", context }),
    );
    const body = res.json();
    expect(body.context).toEqual(context);
    expect(body.createdBy).toBe("api");
  });

  it("GET /api/projects/:id/branches — returns the service's array mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const projects = fakeProjects();
    const branches = fakeBranches();
    const rows = [fakeBranchDetail({ id: "branch-1" }), fakeBranchDetail({ id: "branch-2" })];
    vi.mocked(branches.list).mockResolvedValue(rows);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects, branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/projects/project-1/branches" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(rows.map(toBranchDto));
    for (const b of res.json()) expect(b.password).toBeUndefined();
    expect(branches.list).toHaveBeenCalledWith("project-1");
  });

  it("GET /api/branches/:id — 200 with the service's BranchDetail mapped to BranchDto (password/internal fields dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const fakeDetail = fakeBranchDetail({ id: "branch-1", projectId: "project-1", name: "dev" });
    vi.mocked(branches.byIdOr404).mockReturnValue(
      { id: "branch-1" } as unknown as ReturnType<BranchesService["byIdOr404"]>,
    );
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
    expect(body.stickyPort).toBeUndefined();
    expect(body.importStatus).toBeUndefined();
    expect(body.importError).toBeUndefined();
    expect(body.connectionString).toBeDefined();
    expect(body.context).toBeDefined();
  });

  it("GET /api/branches/:id — 404s when the service throws DevdbError(404)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    vi.mocked(branches.byIdOr404).mockImplementation(() => {
      throw new DevdbError(404, "branch does-not-exist not found");
    });
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
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

  // Task 4 (Phase 3): PATCH /api/branches/:id rename — the route delegates validation/semantics
  // entirely to BranchesService.rename (covered service-side in branches-service.test.ts); this
  // route test proves only the HTTP wiring: body -> service call -> detail() -> BranchDto.
  it("PATCH /api/branches/:id — 200 with the renamed branch DTO (redacted, not a raw row)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const fakeRow = fakeBranchDetail({ id: "branch-1", projectId: "project-1", name: "renamed" });
    // Fix 2 (broker): detail()'s mock must be FULLY populated with the internal-only fields
    // (password/stickyPort/importStatus/importError) — a sparse fake would make a leaking mapper
    // pass this test too, since JSON.stringify drops undefined keys (same rationale as
    // fakeBranchDetail's own doc comment above).
    const fakeDetail = fakeBranchDetail({ id: "branch-1", projectId: "project-1", name: "renamed" });
    vi.mocked(branches.rename).mockResolvedValue(fakeRow);
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "PATCH", url: "/api/branches/branch-1", payload: { name: "renamed" } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.name).toBe("renamed");
    expect(branches.rename).toHaveBeenCalledWith("branch-1", "renamed");
    expect(body.password).toBeUndefined();
    expect(body.stickyPort).toBeUndefined();
    expect(body.importStatus).toBeUndefined();
    expect(body.importError).toBeUndefined();
  });

  it("PATCH /api/branches/:id — zod 400 on a missing name", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "PATCH", url: "/api/branches/branch-1", payload: {} });

    expect(res.statusCode).toBe(400);
  });
});

describe("buildServer endpoint routes", () => {
  it("POST /api/branches/:id/endpoint/start — 200 with the service's BranchDetail mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    const fakeDetail = fakeBranchDetail({
      id: "branch-1", endpointStatus: "running", port: 54300,
      connectionString: "postgresql://postgres:SECRET-PW@localhost:54300/postgres",
    });
    vi.mocked(endpoints.start).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/start" });

    expect(res.statusCode).toBe(200);
    expect(endpoints.start).toHaveBeenCalledWith("branch-1");
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
    expect(body.connectionString).toContain("SECRET-PW"); // connstring is how the agent gets creds
  });

  it("POST /api/branches/:id/endpoint/start — 409 when the service maps PortExhaustedError", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    vi.mocked(endpoints.start).mockRejectedValue(
      new DevdbError(409, "no free endpoint port in range — running endpoints: main, dev. Stop one or widen DEVDB_PORT_RANGE."),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/start" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/DEVDB_PORT_RANGE/);
  });

  it("POST /api/branches/:id/endpoint/stop — 200 with the service's BranchDetail mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    const fakeDetail = fakeBranchDetail({ id: "branch-1", endpointStatus: "stopped", port: null, connectionString: null });
    vi.mocked(endpoints.stop).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/stop" });

    expect(res.statusCode).toBe(200);
    expect(endpoints.stop).toHaveBeenCalledWith("branch-1");
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
  });

  it("GET /api/branches/:id/endpoint — returns { status, port } from branches.detail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    vi.mocked(branches.byIdOr404).mockReturnValue({ id: "branch-1" } as unknown as ReturnType<BranchesService["byIdOr404"]>);
    vi.mocked(branches.detail).mockResolvedValue(
      { endpointStatus: "running", port: 54300 } as unknown as Awaited<ReturnType<BranchesService["detail"]>>,
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1/endpoint" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "running", port: 54300 });
  });
});

describe("buildServer time travel routes", () => {
  it("GET /api/branches/:id/lsn — 200 with { lsn } on success", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    vi.mocked(timetravel.lsnAtTimestamp).mockResolvedValue("0/1A2B3C");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1/lsn?timestamp=2026-07-02T10:00:00Z" });

    expect(res.statusCode).toBe(200);
    expect(timetravel.lsnAtTimestamp).toHaveBeenCalledWith("branch-1", "2026-07-02T10:00:00Z");
    expect(res.json()).toEqual({ lsn: "0/1A2B3C" });
  });

  it("GET /api/branches/:id/lsn — 400 when the timestamp query parameter is missing", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1/lsn" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/timestamp/);
  });

  it("GET /api/branches/:id/lsn — 400 when the service rejects a non-present kind", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    vi.mocked(timetravel.lsnAtTimestamp).mockRejectedValue(
      new DevdbError(400, `cannot resolve 2030-01-01T00:00:00Z on "main": that timestamp is ahead of this branch's history (kind=future)`),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1/lsn?timestamp=2030-01-01T00:00:00Z" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ahead of this branch/);
  });

  it("POST /api/branches/:id/restore { mode: in_place } — calls restoreInPlace and returns its BranchDetail mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    const fakeDetail = fakeBranchDetail({ id: "branch-2", name: "main", endpointStatus: "stopped", port: null, connectionString: null });
    vi.mocked(timetravel.restoreInPlace).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({
      method: "POST", url: "/api/branches/branch-1/restore",
      payload: { mode: "in_place", to: "2026-07-02T10:00:00Z" },
    });

    expect(res.statusCode).toBe(200);
    expect(timetravel.restoreInPlace).toHaveBeenCalledWith("branch-1", "2026-07-02T10:00:00Z");
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
  });

  it("POST /api/branches/:id/restore { mode: new_branch } — calls branchAtTimestamp scoped to the source branch's project, then returns branches.detail mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const timetravel = fakeTimetravel();
    vi.mocked(branches.byIdOr404).mockReturnValue(
      { id: "branch-1", projectId: "project-1" } as unknown as ReturnType<BranchesService["byIdOr404"]>,
    );
    const newRow = { id: "branch-3", name: "rescued" };
    vi.mocked(timetravel.branchAtTimestamp).mockResolvedValue(newRow as unknown as Awaited<ReturnType<TimeTravelService["branchAtTimestamp"]>>);
    const fakeDetail = fakeBranchDetail({ id: "branch-3", name: "rescued", endpointStatus: "stopped", port: null, connectionString: null });
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({
      method: "POST", url: "/api/branches/branch-1/restore",
      payload: { mode: "new_branch", to: "2026-07-02T10:00:00Z", name: "rescued" },
    });

    expect(res.statusCode).toBe(200);
    expect(timetravel.branchAtTimestamp).toHaveBeenCalledWith({
      projectId: "project-1", sourceBranchId: "branch-1", name: "rescued",
      isoTimestamp: "2026-07-02T10:00:00Z", createdBy: "api",
    });
    expect(branches.detail).toHaveBeenCalledWith(newRow);
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
  });

  it("POST /api/branches/:id/restore — 400 when the body matches neither discriminated-union variant", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({
      method: "POST", url: "/api/branches/branch-1/restore",
      payload: { mode: "new_branch", to: "2026-07-02T10:00:00Z" }, // missing required `name`
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/branches/:id/reset — 200 with the service's BranchDetail mapped to BranchDto (password dropped)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    const fakeDetail = fakeBranchDetail({ id: "branch-4", name: "dev", endpointStatus: "stopped", port: null, connectionString: null });
    vi.mocked(timetravel.resetToParent).mockResolvedValue(fakeDetail);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/reset" });

    expect(res.statusCode).toBe(200);
    expect(timetravel.resetToParent).toHaveBeenCalledWith("branch-1");
    const body = res.json();
    expect(body).toEqual(toBranchDto(fakeDetail));
    expect(body.password).toBeUndefined();
  });

  it("POST /api/branches/:id/reset — 409 when the service reports child branches block it", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    vi.mocked(timetravel.resetToParent).mockRejectedValue(
      new DevdbError(409, `branch "dev" has child branches: grandchild — delete them first`),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel, sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/reset" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/grandchild/);
  });
});

describe("buildServer /api/sql", () => {
  it("POST /api/sql — 200 with the service's { rows, rowCount, fields } on success", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const sql = fakeSql();
    const fakeResult = { rows: [{ n: 1 }], rowCount: 1, fields: ["n"] };
    vi.mocked(sql.run).mockResolvedValue(fakeResult as unknown as Awaited<ReturnType<SqlService["run"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql },
    });

    const res = await app.inject({
      method: "POST", url: "/api/sql",
      payload: { branchId: "branch-1", query: "SELECT 1 AS n" },
    });

    expect(res.statusCode).toBe(200);
    expect(sql.run).toHaveBeenCalledWith("branch-1", "SELECT 1 AS n");
    expect(res.json()).toEqual(fakeResult);
  });

  it("POST /api/sql — 400 via the global ZodError handler when branchId is missing", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const sql = fakeSql();
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql },
    });

    const res = await app.inject({ method: "POST", url: "/api/sql", payload: { query: "SELECT 1" } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid request body");
    expect(sql.run).not.toHaveBeenCalled();
  });

  it("POST /api/sql — 400 via the global ZodError handler when query is missing", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const sql = fakeSql();
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql },
    });

    const res = await app.inject({ method: "POST", url: "/api/sql", payload: { branchId: "branch-1" } });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toMatch(/query/);
    expect(sql.run).not.toHaveBeenCalled();
  });

  it("POST /api/sql — passes through the service's DevdbError status code (e.g. 400 empty query, 502 endpoint not running)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const sql = fakeSql();
    vi.mocked(sql.run).mockRejectedValue(new DevdbError(502, `endpoint for "main" is not running`));
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql },
    });

    const res = await app.inject({
      method: "POST", url: "/api/sql",
      payload: { branchId: "branch-1", query: "SELECT 1" },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/not running/);
  });
});

describe("buildServer /api/status", () => {
  // T16 rider (ledgered at Task 12, optional): version comes from THIS package's own
  // package.json (currently "0.1.0"), not a hand-maintained literal in api.ts.
  it("GET /api/status — version matches packages/daemon/package.json, healthy reflects engine.status()", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const engine = { status: () => ({ storcon_db: { state: "running", pid: 123 } }) } as unknown as EngineRuntime;
    const app = buildServer({
      cfg, state, engine, logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe("0.1.0");
    expect(body.healthy).toBe(true);
    expect(body.engine).toEqual({ storcon_db: { state: "running", pid: 123 } });
  });

  it("GET /api/status — healthy is false when any engine component isn't 'running'", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const engine = {
      status: () => ({
        storcon_db: { state: "running", pid: 123 },
        pageserver: { state: "failed", pid: null },
      }),
    } as unknown as EngineRuntime;
    const app = buildServer({
      cfg, state, engine, logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/status" });

    expect(res.json().healthy).toBe(false);
  });

  // Fix 3 (fix wave 1): asserting the DEFAULT range here would pass even if the route hardcoded
  // it instead of reading cfg.portRange — override the loaded cfg with a non-default range before
  // buildServer so the assertion can only pass if the response actually echoes cfg.portRange.
  it("GET /api/status — includes portRange and storage (phase-4 modes hardcoded 'none')", async () => {
    const cfg = testCfg();
    cfg.portRange = { min: 55500, max: 55599 };
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.portRange).toEqual({ min: 55500, max: 55599 }); // proves it's cfg.portRange, not a hardcoded default
    expect(body.storage).toBe("none");
  });
});

// The SSE routes hijack the reply and never call reply.raw.end() on their own (only on client
// disconnect, or the preClose hook on shutdown) — app.inject() resolves only once a response is
// considered complete, so a plain inject() call here would hang forever (verified empirically
// against the installed fastify/light-my-request versions before writing this). A real
// listen()+fetch()+AbortController is the reliable way to exercise a still-open SSE stream and
// its cleanup-on-disconnect behavior, and doubles as a closer approximation of how a real SSE
// client (browser EventSource, or restart.test.ts's polling) actually interacts with the route.
describe("buildServer SSE log routes", () => {
  async function listening(
    logs: LogsService,
    extra: Partial<{ endpoints: EndpointsService; branches: BranchesService; events: EventsService }> = {},
  ) {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs, events: extra.events ?? fakeEvents(),
      registry: fakeRegistry(), provisioner: fakeProvisioner(), computes: fakeComputes(),
      services: {
        projects: fakeProjects(),
        branches: extra.branches ?? fakeBranches(),
        endpoints: extra.endpoints ?? fakeEndpoints(),
        timetravel: fakeTimetravel(),
        sql: fakeSql(),
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
    return { app, base: `http://127.0.0.1:${address.port}` };
  }

  it("GET /api/daemon/logs/:component — text/event-stream, replays recent() then streams live ingests", async () => {
    const logs = new LogsService();
    logs.ingest("daemon:pageserver", "line from before the client connected");
    const { app, base } = await listening(logs);
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/daemon/logs/pageserver`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value: replay } = await reader.read();
      expect(decoder.decode(replay)).toBe(`data: ${JSON.stringify("line from before the client connected")}\n\n`);

      // A line ingested AFTER the client connected must also reach the open stream — proves
      // subscribe(), not just the recent() replay, is wired.
      logs.ingest("daemon:pageserver", "live line");
      const { value: live } = await reader.read();
      expect(decoder.decode(live)).toBe(`data: ${JSON.stringify("live line")}\n\n`);

      ac.abort();
      await reader.cancel().catch(() => {});
    } finally {
      await app.close();
    }
  });

  // Fix 3 (review) changed the component-name contract for this route from "any string" to an
  // explicit allowlist (see the DAEMON_LOG_COMPONENTS check in api.ts) — a genuinely nonexistent
  // component (this test's original "never-touched") is now correctly a 404, covered separately
  // below. "pageserver" is a real allowlisted component that simply hasn't had anything ingested
  // to it YET in this particular LogsService instance — that's the actual case this test targets:
  // an empty recent() replay must still open a 200 stream, not that any arbitrary string does.
  it("GET /api/daemon/logs/:component — an allowlisted channel with no ingested lines yet still opens a 200 stream with an empty replay", async () => {
    const logs = new LogsService();
    const { app, base } = await listening(logs);
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/daemon/logs/pageserver`, { signal: ac.signal });
      expect(res.status).toBe(200);
      ac.abort();
    } finally {
      await app.close();
    }
  });

  // Fix 3 (review): the daemon logs route now 404s for any component NOT in the fixed allowlist
  // (storcon_db, storage_broker, storage_controller, safekeeper, pageserver — the exact set
  // EngineRuntime ever ingests under `daemon:<component>`, see engine/boot.ts and engine/
  // configs.ts's *Spec() functions). Before this fix, any string opened an indefinite 200 SSE
  // stream against a channel LogsService had never heard of and never would.
  it("GET /api/daemon/logs/:component — 404s for a component outside the fixed allowlist", async () => {
    const logs = new LogsService();
    const { app, base } = await listening(logs);
    try {
      const res = await fetch(`${base}/api/daemon/logs/never-touched`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/never-touched/);
    } finally {
      await app.close();
    }
  });

  it("GET /api/branches/:id/logs — 404s via byIdOr404 for an unknown branch id (never opens the stream)", async () => {
    const logs = new LogsService();
    const branches = fakeBranches();
    vi.mocked(branches.byIdOr404).mockImplementation(() => {
      throw new DevdbError(404, "branch does-not-exist not found");
    });
    const { app, base } = await listening(logs, { branches });
    try {
      const res = await fetch(`${base}/api/branches/does-not-exist/logs`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/not found/);
    } finally {
      await app.close();
    }
  });

  it("GET /api/branches/:id/logs — streams the branch:<id>:compute channel, not the daemon namespace", async () => {
    const logs = new LogsService();
    logs.ingest("branch:branch-1:compute", "compute output");
    logs.ingest("daemon:branch-1", "must not leak onto the branch channel");
    const branches = fakeBranches();
    vi.mocked(branches.byIdOr404).mockReturnValue({ id: "branch-1" } as unknown as ReturnType<BranchesService["byIdOr404"]>);
    const { app, base } = await listening(logs, { branches });
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/branches/branch-1/logs`, { signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(`data: ${JSON.stringify("compute output")}\n\n`);
      ac.abort();
    } finally {
      await app.close();
    }
  });

  // Self-review: an SSE client that disconnects must not leak its subscriber callback inside
  // LogsService forever. Spies on LogsService.subscribe to capture the unsub function api.ts's
  // sse() helper receives, then proves the HTTP-layer "close" event actually invokes it — the
  // concrete regression test for that concern (logs.test.ts covers subscribe()/unsub() in
  // isolation; this proves api.ts's route wires real socket-close events to it).
  it("client disconnect calls the unsub function returned by LogsService.subscribe", async () => {
    const logs = new LogsService();
    // A line to replay so reader.read() below has an actual body chunk to resolve on — fetch()
    // itself only waits for headers (flushHeaders() covers that, see the "empty replay" test
    // above), but ReadableStreamDefaultReader.read() waits for real body bytes.
    logs.ingest("daemon:pageserver", "seed line so the stream has something to read");
    const unsubSpy = vi.fn();
    const originalSubscribe = logs.subscribe.bind(logs);
    vi.spyOn(logs, "subscribe").mockImplementation((channel, cb) => {
      const realUnsub = originalSubscribe(channel, cb);
      return () => {
        unsubSpy();
        realUnsub();
      };
    });
    const { app, base } = await listening(logs);
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/daemon/logs/pageserver`, { signal: ac.signal });
      const reader = res.body!.getReader();
      await reader.read(); // establish the stream (replays the seed line)
      expect(unsubSpy).not.toHaveBeenCalled();

      ac.abort();
      await reader.cancel().catch(() => {});
      // Poll briefly for the server's "close" event to fire and run the unsub callback — the
      // exact event ordering between an aborted fetch and the server observing socket close
      // isn't instantaneous, but this must land well within a couple of event-loop turns.
      await vi.waitFor(() => expect(unsubSpy).toHaveBeenCalledTimes(1), { timeout: 2000 });
    } finally {
      await app.close();
    }
  });

  it("GET /api/events — text/event-stream; delivers ONLY post-connect events as JSON (no replay)", async () => {
    const events = new EventsService();
    const { app, base } = await listening(fakeLogs(), { events });
    try {
      events.publish({ type: "project.created", projectId: "before" }); // pre-connect: must NOT arrive
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      events.publish({ type: "branch.created", projectId: "p1", branchId: "b1" });
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: ");
      const evt = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!);
      expect(evt).toMatchObject({ type: "branch.created", projectId: "p1", branchId: "b1" });
      expect(text).not.toContain("before");
      ac.abort();
    } finally {
      await app.close();
    }
  });

  // Fix wave 1 (self-review): the prior version of this test only aborted the fetch and asserted
  // a LATER publish() didn't throw — that passes even if the route's close handler failed to
  // unsubscribe, because publish() swallows subscriber errors and a subsequent publish's own
  // teardown-on-throw would silently remove the leaked subscriber anyway. This version proves the
  // unsubscribe fires on disconnect directly, without relying on any later publish: spy on
  // EventsService.subscribe, wrap the real unsub in a counter, and vi.waitFor the counter — same
  // pattern as the logs-route disconnect test above ("client disconnect calls the unsub function
  // returned by LogsService.subscribe").
  it("GET /api/events — client disconnect unsubscribes from EventsService (no leak)", async () => {
    const events = new EventsService();
    let unsubCalls = 0;
    const realSubscribe = events.subscribe.bind(events);
    vi.spyOn(events, "subscribe").mockImplementation((cb) => {
      const unsub = realSubscribe(cb);
      return () => { unsubCalls++; unsub(); };
    });
    const { app, base } = await listening(fakeLogs(), { events });
    try {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { signal: ac.signal });
      expect(res.status).toBe(200); // subscription established (headers flush on connect)
      ac.abort();
      await vi.waitFor(() => expect(unsubCalls).toBe(1)); // close handler unsubscribed — no publish needed
    } finally {
      await app.close();
    }
  });
});

// Task 10 (dynamic-pg-builds): REST routes over BuildRegistry (Task 4) + Provisioner (Task 7),
// wired into Deps at Task 9. Unlike the generic fakeRegistry()/fakeProvisioner() used by every
// OTHER describe block above (which never touch a pg-builds route and so get bare vi.fn() stand-
// ins), these tests need a REAL BuildRegistry over scaffolded temp dirs — its whole job is real
// fs scanning + real SQLite row bookkeeping (toPgBuildDto, installedMajors, degradedMajors,
// activate's downgrade-consent logic) that a typed fake would just have to reimplement badly.
// Provisioner stays a typed fake here (per the task brief): its own real behavior (OCI pulls,
// validation gate, disk preflight) is covered end-to-end in provisioner.test.ts; these tests only
// need to prove the ROUTE calls the right Provisioner method with the right args and maps the
// result/error correctly.
describe("buildServer pg-builds routes", () => {
  const pgBuildsDirs = trackedDirs();
  afterEach(async () => { await cleanupDirs(pgBuildsDirs); });

  // A real BuildRegistry seeded with one baked v16 row (active) and one downloaded v17 row (also
  // active — different major, so no exclusivity conflict) via the SAME seedBaked/adoptVolumeBuilds/
  // resolveActives pipeline pg-build-registry.test.ts exercises directly. Returns state too, so
  // tests needing extra seeding (e.g. pgMajors.recordRun for the degraded-status test) can reach it.
  async function makePgBuildsRegistry(): Promise<{ registry: BuildRegistry; state: ReturnType<typeof openState> }> {
    const { root, install, builds } = await scaffoldBuildDirs();
    pgBuildsDirs.push(root);
    const v16 = await fakeInstallDir(install, "v16");
    const v17dl = await fakeVolumeBuild(builds, 17, "9124", {
      digest: "sha256:" + "a".repeat(64), tag: "9124", major: 17, minor: 5, extractedAt: "2026-07-01T00:00:00.000Z",
    });
    const state = openState(":memory:");
    const registry = new BuildRegistry({
      state, pgInstallDir: install, pgBuildsDir: builds, logger: noopLogger,
      detectVersion: async (pgbin) => {
        if (pgbin.startsWith(v16)) return { major: 16, minor: 9 };
        if (pgbin.startsWith(v17dl)) return { major: 17, minor: 5 };
        throw new Error(`no fake version for ${pgbin}`);
      },
    });
    await registry.seedBaked();
    await registry.adoptVolumeBuilds();
    registry.resolveActives();
    return { registry, state };
  }

  it("GET /api/pg-builds lists rows as DTOs with inUse derived from running pgbins", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const { registry } = await makePgBuildsRegistry();
    const rows = registry.list();
    const downloadedRow = rows.find((r) => r.source === "downloaded")!;
    const computes = fakeComputes();
    // Running pgbin path is UNDER the downloaded build's dir (path + "/bin/postgres") — inUse
    // derivation (toPgBuildDto) checks a prefix match against row.path + "/", not exact equality.
    vi.mocked(computes.runningPgbins).mockReturnValue([`${downloadedRow.path}/bin/postgres`]);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner: fakeProvisioner(), computes,
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/pg-builds" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    const dl = body.find((r: { source: string }) => r.source === "downloaded");
    const baked = body.find((r: { source: string }) => r.source === "baked");
    expect(dl).toMatchObject({ major: 17, minor: 5, version: "17.5", inUse: true, active: true, status: "ready" });
    expect(baked).toMatchObject({ major: 16, minor: 9, version: "16.9", inUse: false, active: true, status: "ready" });
    // Cross-check against the real mapper directly, not just field-by-field — proves the route
    // is genuinely delegating to toPgBuildDto rather than reimplementing (or drifting from) it.
    expect(body).toEqual(
      expect.arrayContaining(rows.map((r) => toPgBuildDto(r, [`${downloadedRow.path}/bin/postgres`]))),
    );
  });

  it("POST /api/pg-builds/pull returns 202 with buildId; concurrent pull surfaces 409", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.pull)
      .mockResolvedValueOnce({ buildId: "b1" })
      .mockRejectedValueOnce(new DevdbError(409, "a build pull is already in progress"));
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const first = await app.inject({ method: "POST", url: "/api/pg-builds/pull", payload: { major: 17 } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ buildId: "b1" });
    expect(provisioner.pull).toHaveBeenCalledWith({ major: 17, tag: undefined });

    const second = await app.inject({ method: "POST", url: "/api/pg-builds/pull", payload: { major: 17 } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already in progress/);
  });

  it("POST /api/pg-builds/pull — zod 400 on an invalid major (below the gte(14) floor)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const provisioner = fakeProvisioner();
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/pg-builds/pull", payload: { major: 9 } });

    expect(res.statusCode).toBe(400);
    expect(provisioner.pull).not.toHaveBeenCalled();
  });

  // Fix round 1 (review of Task 10 commit 3bfc859, Fix #2, P3 — mutation lane): the activate
  // route now calls provisioner.activate(id, opts) rather than registry.activate() +
  // provisioner.recomposeDistrib() + events.publish() directly (see api.ts's route comment) —
  // that internal sequencing is Provisioner's OWN behavior now, covered directly in
  // provisioner.test.ts's "Provisioner.activate() runs registry.activate + recomposeDistrib +
  // publish" test. This route test's job is narrower: prove the route forwards to
  // provisioner.activate with the right (id, opts) and maps ITS result to the response DTO —
  // the fake here delegates into the SAME real registry the test seeded, so the response can
  // still be cross-checked against toPgBuildDto without re-asserting Provisioner's internals.
  it("POST /api/pg-builds/:id/activate returns the activated dto (via provisioner.activate); DELETE returns 204", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const { registry } = await makePgBuildsRegistry();
    const bakedId = registry.list().find((r) => r.source === "baked")!.id;
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.activate).mockImplementation(
      async (id: string, opts?: { consented?: boolean }) => registry.activate(id, opts),
    );
    const computes = fakeComputes();
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes,
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const activateRes = await app.inject({
      method: "POST", url: `/api/pg-builds/${bakedId}/activate`, payload: {},
    });
    expect(activateRes.statusCode).toBe(200);
    const activated = registry.list().find((r) => r.id === bakedId)!;
    expect(activateRes.json()).toEqual(toPgBuildDto(activated, []));
    expect(provisioner.activate).toHaveBeenCalledWith(bakedId, { consented: undefined });

    // DELETE targets the (now-inactive) downloaded v17 row — the active baked-v16 row above would
    // 409 via assertRemovable's "is the active build" guard, which isn't what this test proves.
    const downloadedId = registry.list().find((r) => r.source === "downloaded")!.id;
    vi.mocked(provisioner.remove).mockResolvedValue(undefined);
    const deleteRes = await app.inject({ method: "DELETE", url: `/api/pg-builds/${downloadedId}` });
    expect(deleteRes.statusCode).toBe(204);
    // HARD-1 (hardening pass, P2): the route passes the running-pgbins SOURCE — a supplier
    // remove() invokes inside its mutation lane — never a pre-lane snapshot array. Prove the
    // supplier is LIVE: it must delegate to computes.runningPgbins() at call time, so an endpoint
    // that starts while the DELETE is queued behind a laned mutation is visible to the in-use guard.
    const [removedId, supplier] = vi.mocked(provisioner.remove).mock.calls[0]!;
    expect(removedId).toBe(downloadedId);
    vi.mocked(computes.runningPgbins).mockReturnValue(["/data/pg_builds/v17/aaaa/bin/postgres"]);
    expect(supplier()).toEqual(["/data/pg_builds/v17/aaaa/bin/postgres"]);
  });

  // Fastify sets req.body to `undefined` (not `{}`) when a request carries no payload at all —
  // verified empirically against this installed Fastify version (a bare inject() with no
  // `payload` key produces `bodyType: "undefined"`, only an explicit `payload: {}` produces an
  // actual object). ActivateBody/CheckBody's `.parse(req.body ?? {})` fallback exists specifically
  // for this real-client case (a plain `POST .../activate` with no body); every OTHER `it()` in
  // this describe block only ever tests the `payload: {}` case, which would pass even without
  // that `?? {}` guard — this test is the one that actually exercises the guard's reason to exist.
  it("POST /api/pg-builds/:id/activate — a request with NO body at all (not even {}) still defaults consented to undefined", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const { registry } = await makePgBuildsRegistry();
    const bakedId = registry.list().find((r) => r.source === "baked")!.id;
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.activate).mockImplementation(
      async (id: string, opts?: { consented?: boolean }) => registry.activate(id, opts),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: `/api/pg-builds/${bakedId}/activate` }); // no payload key

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: bakedId, active: true });
    expect(provisioner.activate).toHaveBeenCalledWith(bakedId, { consented: undefined });
  });

  it("POST /api/pg-builds/:id/activate — 409 surfaces the registry's downgrade-consent DevdbError", async () => {
    const cfg = testCfg();
    // NOTE: reuses the `state` makePgBuildsRegistry() itself constructed `registry` over (NOT a
    // second, unrelated openState(":memory:")) — the seeded "older" row below must land in the
    // SAME SQLite instance registry.activate()'s lookups actually query, or byId() correctly
    // finds nothing and this test would only prove the generic "not found" 409, not the downgrade-
    // consent one it's named for.
    const { registry, state } = await makePgBuildsRegistry();
    const downloadedId = registry.list().find((r) => r.source === "downloaded")!.id;
    registry.activate(downloadedId); // 17.5 becomes active
    // registry.activate() alone does NOT raise the high-water mark — only recordRun() does (it
    // models an endpoint START of that version, see registry.ts's own doc comment on recordRun).
    // Without this explicit call, activate()'s downgrade check (which compares against
    // pgMajors.lastRunMinor) would see lastRun === null and never flag a downgrade at all — same
    // recipe pg-build-registry.test.ts's own downgrade tests use (state.pgMajors.recordRun(...)).
    registry.recordRun(17, 5);
    // Re-seed an OLDER 17.x row to attempt a downgrade activation against.
    state.pgBuilds.insert({
      id: "dl-17-older", major: 17, minor: 4, source: "downloaded",
      releaseTag: "old", imageDigest: "sha256:" + "b".repeat(64), path: "/fake/older", status: "ready",
    });
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.activate).mockImplementation(
      async (id: string, opts?: { consented?: boolean }) => registry.activate(id, opts),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "POST", url: "/api/pg-builds/dl-17-older/activate", payload: {} });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/downgrade/);
  });

  it("DELETE /api/pg-builds/:id — 409 when the registry refuses (e.g. active/baked/in-use)", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const { registry } = await makePgBuildsRegistry();
    const bakedId = registry.list().find((r) => r.source === "baked")!.id; // active baked row
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.remove).mockRejectedValue(
      new DevdbError(409, `pg_build ${bakedId} is a baked build and cannot be removed`),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "DELETE", url: `/api/pg-builds/${bakedId}` });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/baked build and cannot be removed/);
  });

  it("POST /api/pg-builds/check forwards majors and returns the provisioner's map", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const { registry } = await makePgBuildsRegistry(); // installedMajors() -> [16, 17]
    const provisioner = fakeProvisioner();
    const checkResult = {
      "16": { tag: "latest" as const, digest: "sha256:c".repeat(1), state: "current" as const, isNew: false, at: "2026-07-04T00:00:00.000Z" },
      "17": { tag: "latest" as const, digest: "sha256:d".repeat(1), state: "unverified" as const, isNew: true, at: "2026-07-04T00:00:00.000Z" },
    };
    vi.mocked(provisioner.check).mockResolvedValue(checkResult);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    // Default: truly NO body at all (no `payload` key — Fastify leaves req.body `undefined` in
    // this case, verified empirically; see the activate route's own "no body at all" test above
    // for the same guard) -> majors defaults to registry.installedMajors().
    const defaultRes = await app.inject({ method: "POST", url: "/api/pg-builds/check" });
    expect(defaultRes.statusCode).toBe(200);
    expect(provisioner.check).toHaveBeenCalledWith([16, 17]);
    expect(defaultRes.json()).toEqual(checkResult);

    // Explicit majors -> forwarded as-is, not defaulted.
    vi.mocked(provisioner.check).mockClear();
    vi.mocked(provisioner.check).mockResolvedValue({ "18": checkResult["17"]! });
    const explicitRes = await app.inject({ method: "POST", url: "/api/pg-builds/check", payload: { majors: [18] } });
    expect(explicitRes.statusCode).toBe(200);
    expect(provisioner.check).toHaveBeenCalledWith([18]);
  });

  // FIX-7 (final whole-branch review): CheckBody accepted any int — provisioner.check then threw
  // the raw fetch error on the first bad major, a 500 on a public route. The majors must be
  // bounded by PgVersionSchema (gte 14) at the route, same as the pull route's PullBody.
  it("POST /api/pg-builds/check — zod 400 on an out-of-range major, provisioner never called", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const provisioner = fakeProvisioner();
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry: fakeRegistry(), provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    for (const majors of [[9], [17, 0], [-1]]) {
      const res = await app.inject({ method: "POST", url: "/api/pg-builds/check", payload: { majors } });
      expect(res.statusCode).toBe(400);
    }
    expect(provisioner.check).not.toHaveBeenCalled();
  });

  // Fix round 1 (review of Task 10 commit 3bfc859, Fix #3, P4): an unknown :id must 404, not 409
  // — these two routes use a REAL BuildRegistry (not the generic fakeRegistry() vi.fn() stand-in)
  // specifically so registry.activate()/assertRemovable()'s real byId(id)===null branch is what
  // produces the response, not a mocked provisioner method standing in for it. The activate
  // route now calls provisioner.activate(id, opts) (Fix #2's mutation lane) — the fake here
  // delegates straight through to the real registry.activate(), same as Provisioner.activate()
  // itself does before its recompose/publish side effects.
  it("POST /api/pg-builds/<unknown>/activate — 404, not 409", async () => {
    const cfg = testCfg();
    const { registry, state } = await makePgBuildsRegistry();
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.activate).mockImplementation(
      async (id: string, opts?: { consented?: boolean }) => registry.activate(id, opts),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({
      method: "POST", url: "/api/pg-builds/no-such-build/activate", payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/pg-builds/<unknown> — 404, not 409", async () => {
    const cfg = testCfg();
    const { registry, state } = await makePgBuildsRegistry();
    const provisioner = fakeProvisioner();
    // provisioner.remove(id, ...) must actually reach registry.assertRemovable's real 404 branch
    // (not a mocked resolution) — delegate the fake straight through to the real registry, same
    // as Provisioner.remove itself does before its rm()/delete() side effects.
    vi.mocked(provisioner.remove).mockImplementation(async (id: string, running: () => string[]) => {
      registry.assertRemovable(id, running());
    });
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "DELETE", url: "/api/pg-builds/no-such-build" });

    expect(res.statusCode).toBe(404);
  });

  it("GET /api/status carries pgBuilds with activeVersion/degradedDowngrade/updateAvailable", async () => {
    const cfg = testCfg();
    const { registry, state } = await makePgBuildsRegistry();
    // Force major 16 into a degraded state: record a HIGHER minor as having run than the one
    // currently resolved active, then re-resolve — mirrors pg-build-registry.test.ts's own
    // "silent downgrade forbidden" test recipe (state.pgMajors.recordRun then resolveActives()).
    state.pgMajors.recordRun(16, 99);
    registry.resolveActives();
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.updateAvailableFor).mockImplementation((major) =>
      major === 17 ? "latest@abc123def456" : null,
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(), events: fakeEvents(),
      registry, provisioner, computes: fakeComputes(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel(), sql: fakeSql() },
    });

    const res = await app.inject({ method: "GET", url: "/api/status" });

    expect(res.statusCode).toBe(200);
    const { pgBuilds } = res.json();
    expect(pgBuilds["16"]).toEqual({
      activeVersion: "16.9", source: "baked", degradedDowngrade: true, updateAvailable: null,
    });
    expect(pgBuilds["17"]).toEqual({
      activeVersion: "17.5", source: "downloaded", degradedDowngrade: false, updateAvailable: "latest@abc123def456",
    });
  });
});
