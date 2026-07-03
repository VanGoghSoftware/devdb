import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/http/api.js";
import type { EngineRuntime } from "../src/engine/boot.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { BranchesService } from "../src/services/branches.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { TimeTravelService } from "../src/services/timetravel.js";
import { LogsService } from "../src/services/logs.js";
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

// LogsService (T16) is a plain in-process class with no external dependencies — a real instance
// is cheaper and more honest here than a typed fake (unlike the engine-client interfaces above,
// there's no external system boundary to stand in for).
function fakeLogs(): LogsService {
  return new LogsService();
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects, branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
    });

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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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

describe("buildServer endpoint routes", () => {
  it("POST /api/branches/:id/endpoint/start — 200 with the service's BranchDetail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    const fakeDetail = { id: "branch-1", endpointStatus: "running", port: 54300, connectionString: "postgresql://..." };
    vi.mocked(endpoints.start).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<EndpointsService["start"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/start" });

    expect(res.statusCode).toBe(200);
    expect(endpoints.start).toHaveBeenCalledWith("branch-1");
    expect(res.json()).toEqual(fakeDetail);
  });

  it("POST /api/branches/:id/endpoint/start — 409 when the service maps PortExhaustedError", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    vi.mocked(endpoints.start).mockRejectedValue(
      new DevdbError(409, "no free endpoint port in range — running endpoints: main, dev. Stop one or widen DEVDB_PORT_RANGE."),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/start" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/DEVDB_PORT_RANGE/);
  });

  it("POST /api/branches/:id/endpoint/stop — 200 with the service's BranchDetail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const endpoints = fakeEndpoints();
    const fakeDetail = { id: "branch-1", endpointStatus: "stopped", port: null, connectionString: null };
    vi.mocked(endpoints.stop).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<EndpointsService["stop"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints, timetravel: fakeTimetravel() },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/endpoint/stop" });

    expect(res.statusCode).toBe(200);
    expect(endpoints.stop).toHaveBeenCalledWith("branch-1");
    expect(res.json()).toEqual(fakeDetail);
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel },
    });

    const res = await app.inject({ method: "GET", url: "/api/branches/branch-1/lsn?timestamp=2030-01-01T00:00:00Z" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ahead of this branch/);
  });

  it("POST /api/branches/:id/restore { mode: in_place } — calls restoreInPlace and returns its BranchDetail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    const fakeDetail = { id: "branch-2", name: "main", endpointStatus: "stopped", port: null, connectionString: null };
    vi.mocked(timetravel.restoreInPlace).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<TimeTravelService["restoreInPlace"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel },
    });

    const res = await app.inject({
      method: "POST", url: "/api/branches/branch-1/restore",
      payload: { mode: "in_place", to: "2026-07-02T10:00:00Z" },
    });

    expect(res.statusCode).toBe(200);
    expect(timetravel.restoreInPlace).toHaveBeenCalledWith("branch-1", "2026-07-02T10:00:00Z");
    expect(res.json()).toEqual(fakeDetail);
  });

  it("POST /api/branches/:id/restore { mode: new_branch } — calls branchAtTimestamp scoped to the source branch's project, then returns branches.detail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const branches = fakeBranches();
    const timetravel = fakeTimetravel();
    vi.mocked(branches.byIdOr404).mockReturnValue(
      { id: "branch-1", projectId: "project-1" } as unknown as ReturnType<BranchesService["byIdOr404"]>,
    );
    const newRow = { id: "branch-3", name: "rescued" };
    vi.mocked(timetravel.branchAtTimestamp).mockResolvedValue(newRow as unknown as Awaited<ReturnType<TimeTravelService["branchAtTimestamp"]>>);
    const fakeDetail = { id: "branch-3", name: "rescued", endpointStatus: "stopped", port: null, connectionString: null };
    vi.mocked(branches.detail).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<BranchesService["detail"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches, endpoints: fakeEndpoints(), timetravel },
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
    expect(res.json()).toEqual(fakeDetail);
  });

  it("POST /api/branches/:id/restore — 400 when the body matches neither discriminated-union variant", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
    });

    const res = await app.inject({
      method: "POST", url: "/api/branches/branch-1/restore",
      payload: { mode: "new_branch", to: "2026-07-02T10:00:00Z" }, // missing required `name`
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /api/branches/:id/reset — 200 with the service's BranchDetail", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    const fakeDetail = { id: "branch-4", name: "dev", endpointStatus: "stopped", port: null, connectionString: null };
    vi.mocked(timetravel.resetToParent).mockResolvedValue(fakeDetail as unknown as Awaited<ReturnType<TimeTravelService["resetToParent"]>>);
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/reset" });

    expect(res.statusCode).toBe(200);
    expect(timetravel.resetToParent).toHaveBeenCalledWith("branch-1");
    expect(res.json()).toEqual(fakeDetail);
  });

  it("POST /api/branches/:id/reset — 409 when the service reports child branches block it", async () => {
    const cfg = testCfg();
    const state = openState(":memory:");
    const timetravel = fakeTimetravel();
    vi.mocked(timetravel.resetToParent).mockRejectedValue(
      new DevdbError(409, `branch "dev" has child branches: grandchild — delete them first`),
    );
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel },
    });

    const res = await app.inject({ method: "POST", url: "/api/branches/branch-1/reset" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/grandchild/);
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
      cfg, state, engine, logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
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
      cfg, state, engine, logs: fakeLogs(),
      services: { projects: fakeProjects(), branches: fakeBranches(), endpoints: fakeEndpoints(), timetravel: fakeTimetravel() },
    });

    const res = await app.inject({ method: "GET", url: "/api/status" });

    expect(res.json().healthy).toBe(false);
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
  async function listening(logs: LogsService, extra: Partial<{ endpoints: EndpointsService; branches: BranchesService }> = {}) {
    const cfg = testCfg();
    const state = openState(":memory:");
    const app = buildServer({
      cfg, state, engine: fakeEngine(), logs,
      services: {
        projects: fakeProjects(),
        branches: extra.branches ?? fakeBranches(),
        endpoints: extra.endpoints ?? fakeEndpoints(),
        timetravel: fakeTimetravel(),
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
});
