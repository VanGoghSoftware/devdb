import { describe, expect, it, vi } from "vitest";
import { makeValidationRunner, sweepValidationProjects } from "../src/compute/builds/validate.js";
import type { ProjectsService } from "../src/services/projects.js";
import type { EndpointsService } from "../src/services/endpoints.js";
import type { SqlService } from "../src/services/sql.js";
import type { BranchRow, ProjectRow } from "../src/state/repos.js";

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
