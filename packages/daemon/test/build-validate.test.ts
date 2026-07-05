import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeValidationRunner, sweepValidationProjects } from "../src/compute/builds/validate.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { SqlService } from "../src/services/sql.js";
import type { BranchesService } from "../src/services/branches.js";
import type { BranchRow, ProjectRow } from "../src/state/repos.js";

// ——— pg module mock (for the Fix 2 REAL-SqlService tests below) ———
// Same idiom as sql.test.ts: pg's Client is a process boundary (a real TCP/SCRAM handshake
// against a live postgres), so it is vi.mock'd at the module seam and the REAL SqlService is
// imported dynamically AFTER the mock declarations so its `import pg from "pg"` resolves here.
interface FakePgQueryResult { rows: unknown[]; rowCount: number | null; fields: { name: string }[] }
const mockConnect = vi.fn(async () => {});
const mockEnd = vi.fn(async () => {});
const mockQuery = vi.fn<(query: string) => Promise<FakePgQueryResult>>(
  async () => ({ rows: [], rowCount: 0, fields: [] }),
);
const ClientMock = vi.fn(() => ({ connect: mockConnect, end: mockEnd, query: mockQuery }));
vi.mock("pg", () => ({ default: { Client: ClientMock } }));
const { SqlService: RealSqlService } = await import("../src/services/sql.js");

// Typed fakes narrowly matching the REAL service signatures (ProjectsService.create/delete/list,
// EndpointsService.startWithPgbin/stop, SqlService.run) — no `as never`/`as any`, and no
// type-erasing `as unknown as X` either: every vi.fn() below is given real parameter/return types
// up front so it satisfies the Pick<...> dep type by plain structural assignment.
function fakeProject(major: number): { project: ProjectRow; mainBranch: BranchRow } {
  const now = new Date().toISOString();
  const project: ProjectRow = {
    id: "proj-1", name: "_devdb_validate_deadbeef", pgVersion: major as ProjectRow["pgVersion"],
    createdAt: now, updatedAt: now,
  };
  const mainBranch: BranchRow = {
    id: "branch-1", projectId: project.id, parentBranchId: null, name: "main", slug: "main-abc123",
    timelineId: "tl-1", password: "pw", stickyPort: null, endpointStatus: "stopped",
    endpointError: null, importStatus: "none", importError: null, createdBy: "api",
    context: null, createdAt: now, updatedAt: now,
  };
  return { project, mainBranch };
}

const noopLogger = { info: () => {}, error: () => {} };

type BranchDetail = Awaited<ReturnType<EndpointsService["startWithPgbin"]>>;
const fakeBranchDetail = {} as BranchDetail; // startWithPgbin's resolved value is unused by the runner

// A COMPLETE BranchDetail (BranchRow + enrichment) so the real-SqlService tests need no
// type-erasing cast on the VALUE: running=true is the shape BranchesService.detail() reports for
// a live compute (connectionString/port non-null), running=false the shape after a crash (null).
function detailFor(b: BranchRow, running: boolean, port = 54399): BranchDetail {
  return {
    ...b,
    endpointStatus: running ? "running" : "failed",
    endpointError: null,
    port: running ? port : null,
    connectionString: running ? `postgresql://postgres:${b.password}@localhost:${port}/postgres` : null,
    jdbcUrl: null, // merge: main added jdbcUrl to BranchDetail (JDBC-URL drawer)
    lastRecordLsn: null,
    logicalSizeBytes: null,
    ancestorLsn: null,
    runningPgVersion: null,
  };
}

// The three smoke queries answered plausibly for `major` — shared by the fix-round tests below.
// Typed with run()'s full post-fix signature so `mock.calls[i][2]` is inspectable.
function okSmokeSql(major = 17) {
  return vi.fn(async (_branchId: string, query: string, _opts?: { noAutoStart?: boolean }) => {
    if (query.includes("version()")) {
      return { rows: [{ version: `PostgreSQL ${major}.5 on x86_64-pc-linux-gnu` }], rowCount: 1, fields: ["version"], truncated: false };
    }
    return { rows: [{ count: "100" }], rowCount: 1, fields: ["count"], truncated: false };
  });
}

describe("makeValidationRunner", () => {
  it("gate: creates _devdb_validate_* project of the candidate major, starts via startWithPgbin, runs smoke SQL, deletes project", async () => {
    const { project, mainBranch } = fakeProject(17);
    const createSpy = vi.fn(async (_a: { name: string; pgVersion?: number }) => ({ project, mainBranch }));
    const deleteSpy = vi.fn(async (_id: string) => {});
    const listSpy = vi.fn((): ProjectRow[] => []);
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: createSpy, delete: deleteSpy, list: listSpy,
    };
    const startWithPgbinSpy = vi.fn(async (_branchId: string, _pgbinPath: string) => fakeBranchDetail);
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      startWithPgbin: startWithPgbinSpy,
      stop: vi.fn(async (_branchId: string) => fakeBranchDetail),
    };
    const runSpy = vi.fn(async (_branchId: string, query: string) => {
      if (query.includes("version()")) {
        return { rows: [{ version: "PostgreSQL 17.5 on x86_64-pc-linux-gnu" }], rowCount: 1, fields: ["version"], truncated: false };
      }
      return { rows: [{ count: "100" }], rowCount: 1, fields: ["count"], truncated: false };
    });
    const sql: Pick<SqlService, "run"> = { run: runSpy };

    const runner = makeValidationRunner({ projects, endpoints, sql, logger: noopLogger });
    await runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const createArg = createSpy.mock.calls[0]![0];
    expect(createArg.name).toMatch(/^_devdb_validate_[0-9a-f]{8}$/);
    expect(createArg.pgVersion).toBe(17);

    expect(startWithPgbinSpy).toHaveBeenCalledWith(mainBranch.id, "/data/pg_builds/v17/abc123/bin/postgres");

    // version probe called first
    expect(runSpy.mock.calls[0]![1]).toContain("version()");

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(project.id);
  });

  it("gate: a version-probe response lacking the expected major REJECTS", async () => {
    const { project, mainBranch } = fakeProject(17);
    const deleteSpy = vi.fn(async (_id: string) => {});
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: vi.fn(async (_a: { name: string; pgVersion?: number }) => ({ project, mainBranch })),
      delete: deleteSpy,
      list: vi.fn((): ProjectRow[] => []),
    };
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      startWithPgbin: vi.fn(async (_branchId: string, _pgbinPath: string) => fakeBranchDetail),
      stop: vi.fn(async (_branchId: string) => fakeBranchDetail),
    };
    const sql: Pick<SqlService, "run"> = {
      run: vi.fn(async (_branchId: string, _query: string) => (
        { rows: [{ version: "PostgreSQL 16.9 on x86_64" }], rowCount: 1, fields: ["version"], truncated: false }
      )),
    };

    const runner = makeValidationRunner({ projects, endpoints, sql, logger: noopLogger });
    await expect(runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" })).rejects.toThrow(/PostgreSQL 17/);

    // cleanup still happens even though the gate rejected on the version mismatch
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(project.id);
  });

  it("gate failure surfaces the cause and still cleans up", async () => {
    const { project, mainBranch } = fakeProject(17);
    const deleteSpy = vi.fn(async (_id: string) => {});
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: vi.fn(async (_a: { name: string; pgVersion?: number }) => ({ project, mainBranch })),
      delete: deleteSpy,
      list: vi.fn((): ProjectRow[] => []),
    };
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      startWithPgbin: vi.fn(async (_branchId: string, _pgbinPath: string): Promise<BranchDetail> => {
        throw new Error("compute never became ready");
      }),
      stop: vi.fn(async (_branchId: string) => fakeBranchDetail),
    };
    const sql: Pick<SqlService, "run"> = { run: vi.fn(async (_branchId: string, _query: string) => {
      throw new Error("unreachable — startWithPgbin already rejected");
    }) };

    const runner = makeValidationRunner({ projects, endpoints, sql, logger: noopLogger });
    await expect(runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" })).rejects.toThrow("compute never became ready");

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(project.id);
  });

  it("cleanup still runs (and is logged) when projects.delete itself fails — the boot sweep retries", async () => {
    const { project, mainBranch } = fakeProject(17);
    const deleteSpy = vi.fn(async (_id: string) => { throw new Error("engine unreachable"); });
    const errorSpy = vi.fn((_m: string, _e?: unknown) => {});
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: vi.fn(async (_a: { name: string; pgVersion?: number }) => ({ project, mainBranch })),
      delete: deleteSpy,
      list: vi.fn((): ProjectRow[] => []),
    };
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      startWithPgbin: vi.fn(async (_branchId: string, _pgbinPath: string) => fakeBranchDetail),
      stop: vi.fn(async (_branchId: string) => fakeBranchDetail),
    };
    const sql: Pick<SqlService, "run"> = {
      run: vi.fn(async (_branchId: string, query: string) => {
        if (query.includes("version()")) return { rows: [{ version: "PostgreSQL 17.5" }], rowCount: 1, fields: ["version"], truncated: false };
        return { rows: [{ count: "100" }], rowCount: 1, fields: ["count"], truncated: false };
      }),
    };

    const runner = makeValidationRunner({ projects, endpoints, sql, logger: { info: () => {}, error: errorSpy } });
    // the gate itself succeeded — only cleanup failed — so the runner must NOT reject on that
    await expect(runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" })).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// ——— Task-9 fix round: gate integration bugs. The original tests above pass because their fakes
// apply none of the real services' guards; each fix below is therefore ALSO proven against the
// real guard (projects-service.test.ts for the create guards, and a REAL SqlService here). ———
describe("makeValidationRunner — gate integration fixes", () => {
  function gateProjects(rows: { project: ProjectRow; mainBranch: BranchRow }) {
    const createSpy = vi.fn(async (
      _a: { name: string; pgVersion?: number },
      _opts?: { internal?: boolean },
    ) => rows);
    const deleteSpy = vi.fn(async (_id: string) => {});
    const projects: Pick<ProjectsService, "create" | "delete" | "list"> = {
      create: createSpy, delete: deleteSpy, list: vi.fn((): ProjectRow[] => []),
    };
    return { projects, createSpy, deleteSpy };
  }
  function gateEndpoints() {
    const startSpy = vi.fn(async (_branchId: string, _pgbinPath: string) => fakeBranchDetail);
    const stopSpy = vi.fn(async (_branchId: string) => fakeBranchDetail);
    const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
      startWithPgbin: startSpy, stop: stopSpy,
    };
    return { endpoints, startSpy, stopSpy };
  }

  // ——— Fix 1: the gate's own project-create must be marked internal ———
  it("passes { internal: true } to projects.create — the reserved _devdb_validate_ name and the not-yet-installed candidate major must bypass the PUBLIC guards", async () => {
    const rows = fakeProject(17);
    const { projects, createSpy } = gateProjects(rows);
    const { endpoints } = gateEndpoints();

    const runner = makeValidationRunner({ projects, endpoints, sql: { run: okSmokeSql() }, logger: noopLogger });
    await runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]![1]).toEqual({ internal: true });
  });

  // ——— Fix 2: the gate's smoke SQL must never auto-start (and thereby validate) another build ———
  it("passes { noAutoStart: true } on EVERY smoke-SQL call", async () => {
    const rows = fakeProject(17);
    const { projects } = gateProjects(rows);
    const { endpoints } = gateEndpoints();
    const runSpy = okSmokeSql();

    const runner = makeValidationRunner({ projects, endpoints, sql: { run: runSpy }, logger: noopLogger });
    await runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" });

    expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of runSpy.mock.calls) expect(call[2]).toEqual({ noAutoStart: true });
  });

  describe("gate smoke SQL through the REAL SqlService (Fix 2 end-to-end)", () => {
    beforeEach(() => {
      ClientMock.mockClear(); mockConnect.mockClear(); mockEnd.mockClear(); mockQuery.mockClear();
      mockConnect.mockResolvedValue(undefined);
      mockEnd.mockResolvedValue(undefined);
      mockQuery.mockImplementation(async (q: string) => {
        if (q.includes("version()")) return { rows: [{ version: "PostgreSQL 17.5 on aarch64" }], rowCount: 1, fields: [{ name: "version" }] };
        if (q.includes("neon.timeline_id")) return { rows: [{ "neon.timeline_id": "tl-1" }], rowCount: 1, fields: [{ name: "neon.timeline_id" }] };
        return { rows: [{ count: "100" }], rowCount: 1, fields: [{ name: "count" }] };
      });
    });

    // REAL SqlService over a fake BranchesService whose detail() reports the endpoint's CURRENT
    // state, plus a fake EndpointsService whose ensureRunning() stands in for the wrong-build
    // recovery path (restarting a crashed compute with the ACTIVE build's pgbin, not the
    // candidate's). The runner's own endpoints dep (startWithPgbin/stop) is a separate fake.
    function realSqlHarness(a: { runningWhenQueried: boolean; mainBranch: BranchRow }) {
      const ensureRunningSpy = vi.fn(async (_branchId: string) => detailFor(a.mainBranch, true));
      const branches = {
        byIdOr404: vi.fn((_id: string) => a.mainBranch),
        detail: vi.fn(async (_b: BranchRow) => detailFor(a.mainBranch, a.runningWhenQueried)),
      } as unknown as BranchesService;
      const endpoints = { ensureRunning: ensureRunningSpy } as unknown as EndpointsService;
      return { sql: new RealSqlService({ branches, endpoints }), ensureRunningSpy };
    }

    it("candidate crashed after startWithPgbin: the gate FAILS instead of silently validating the ACTIVE build", async () => {
      const rows = fakeProject(17);
      const { projects, deleteSpy } = gateProjects(rows);
      const { endpoints } = gateEndpoints(); // startWithPgbin "succeeds"...
      // ...but by the time the smoke SQL runs, the candidate's compute is DEAD.
      const { sql, ensureRunningSpy } = realSqlHarness({ runningWhenQueried: false, mainBranch: rows.mainBranch });

      const runner = makeValidationRunner({ projects, endpoints, sql, logger: noopLogger });
      await expect(runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" })).rejects.toThrow(/not running/);

      expect(ensureRunningSpy).not.toHaveBeenCalled(); // the wrong-build recovery was never taken
      expect(ClientMock).not.toHaveBeenCalled();       // no SQL ran against ANY build
      expect(deleteSpy).toHaveBeenCalledWith(rows.project.id); // cleanup still ran
    });

    it("candidate running: the gate passes end-to-end through the real SqlService (happy path stays green)", async () => {
      const rows = fakeProject(17);
      const { projects, deleteSpy } = gateProjects(rows);
      const { endpoints } = gateEndpoints();
      const { sql, ensureRunningSpy } = realSqlHarness({ runningWhenQueried: true, mainBranch: rows.mainBranch });

      const runner = makeValidationRunner({ projects, endpoints, sql, logger: noopLogger });
      await expect(runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123" })).resolves.toBeUndefined();

      expect(ensureRunningSpy).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(3); // version probe + write probe + neon-ext probe
      expect(deleteSpy).toHaveBeenCalledWith(rows.project.id);
    });
  });

  // ——— Fix 3: the Provisioner's gate timeout aborts the runner; cleanup must be prompt ———
  describe("abortable gate (Fix 3)", () => {
    it("abort during a hung step: the runner rejects promptly, stops the endpoint, deletes the project — later smoke SQL never starts", async () => {
      const rows = fakeProject(17);
      const { projects, deleteSpy } = gateProjects(rows);
      const stopSpy = vi.fn(async (_branchId: string) => fakeBranchDetail);
      const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
        // A compute start that never settles — the exact shape that used to park the abandoned
        // runner past the Provisioner's timeout, leaking the gate project until the boot sweep.
        startWithPgbin: vi.fn((_branchId: string, _pgbinPath: string) => new Promise<BranchDetail>(() => {})),
        stop: stopSpy,
      };
      const runSpy = okSmokeSql();
      const ac = new AbortController();

      const runner = makeValidationRunner({ projects, endpoints, sql: { run: runSpy }, logger: noopLogger });
      const gate = runner({ major: 17, buildPath: "/data/pg_builds/v17/abc123", signal: ac.signal });
      await new Promise((r) => setTimeout(r, 10)); // the runner is now parked on the hung start
      ac.abort(new Error("gate timed out after 90s"));

      await expect(gate).rejects.toThrow(/gate timed out/);
      expect(runSpy).not.toHaveBeenCalled(); // short-circuited — no smoke SQL ran anywhere
      expect(stopSpy).toHaveBeenCalledWith(rows.mainBranch.id);
      expect(deleteSpy).toHaveBeenCalledWith(rows.project.id);
    });

    it("a signal aborted while a step is in flight prevents every later step from starting", async () => {
      const rows = fakeProject(17);
      const { projects, deleteSpy } = gateProjects(rows);
      const ac = new AbortController();
      const stopSpy = vi.fn(async (_branchId: string) => fakeBranchDetail);
      const endpoints: Pick<EndpointsService, "startWithPgbin" | "stop"> = {
        // The step itself completes, but the budget blew mid-flight — its result no longer matters.
        startWithPgbin: vi.fn(async (_branchId: string, _pgbinPath: string) => {
          ac.abort(new Error("gate timed out after 90s"));
          return fakeBranchDetail;
        }),
        stop: stopSpy,
      };
      const runSpy = okSmokeSql();

      const runner = makeValidationRunner({ projects, endpoints, sql: { run: runSpy }, logger: noopLogger });
      await expect(runner({ major: 17, buildPath: "/x", signal: ac.signal })).rejects.toThrow(/gate timed out/);

      expect(runSpy).not.toHaveBeenCalled();
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// Full ProjectRow fakes (not just {id, name}) — sweepValidationProjects's dep type is
// Pick<ProjectsService, "list" | "delete">, and ProjectsService.list() returns the complete
// ProjectRow[], so a fake matching only the two fields this test happens to read would not
// structurally satisfy that Pick (a Pick of a method preserves its full return type).
function rowNamed(id: string, name: string): ProjectRow {
  const now = new Date().toISOString();
  return { id, name, pgVersion: 17 as ProjectRow["pgVersion"], createdAt: now, updatedAt: now };
}

describe("sweepValidationProjects", () => {
  it("deletes only _devdb_validate_* projects", async () => {
    const deleteSpy = vi.fn(async (_id: string) => {});
    const projects: Pick<ProjectsService, "list" | "delete"> = {
      list: () => [rowNamed("p1", "app"), rowNamed("p2", "_devdb_validate_deadbeef")],
      delete: deleteSpy,
    };
    const count = await sweepValidationProjects(projects);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("p2");
    expect(count).toBe(1);
  });

  it("returns 0 and deletes nothing when no validate projects exist", async () => {
    const deleteSpy = vi.fn(async (_id: string) => {});
    const projects: Pick<ProjectsService, "list" | "delete"> = {
      list: () => [rowNamed("p1", "app")],
      delete: deleteSpy,
    };
    const count = await sweepValidationProjects(projects);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});
