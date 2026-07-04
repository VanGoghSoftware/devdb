import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ProjectsService } from "../../services/projects.js";
import type { EndpointsService } from "../../services/endpoints.js";
import type { SqlService } from "../../services/sql.js";

// The in-container validation gate (spec pipeline step 5): a downloaded build must drive a REAL
// compute against the LIVE storage — basebackup from the pageserver, WAL to the safekeeper, neon
// extension load — before it may activate. Uses the normal service layer end-to-end; the only
// special affordance is EndpointsService.startWithPgbin (pgbin override, no run-high-water).
//
// deps are narrow Picks of the REAL services (not a bespoke interface) — a caller supplying the
// full ProjectsService/EndpointsService/SqlService instance satisfies these structurally, and the
// Picks alone prove exactly what surface this module touches.
export function makeValidationRunner(deps: {
  projects: Pick<ProjectsService, "create" | "delete" | "list">;
  endpoints: Pick<EndpointsService, "startWithPgbin" | "stop">;
  sql: Pick<SqlService, "run">;
  logger: { info(m: string): void; error(m: string, e?: unknown): void };
}) {
  return async (a: { major: number; buildPath: string }): Promise<void> => {
    const name = `_devdb_validate_${randomBytes(4).toString("hex")}`;
    const { project, mainBranch } = await deps.projects.create({ name, pgVersion: a.major });
    try {
      await deps.endpoints.startWithPgbin(mainBranch.id, join(a.buildPath, "bin", "postgres"));
      const v = await deps.sql.run(mainBranch.id, "SELECT version()");
      const banner = JSON.stringify(v.rows[0] ?? "");
      if (!banner.includes(`${a.major}.`)) {
        throw new Error(`gate: expected PostgreSQL ${a.major}.x, got ${banner.slice(0, 120)}`);
      }
      // Real writes through the full path (pageserver-backed relation + WAL), then a neon-ext probe:
      await deps.sql.run(
        mainBranch.id,
        "CREATE TABLE _devdb_validate(x int); INSERT INTO _devdb_validate SELECT generate_series(1, 100); SELECT count(*) FROM _devdb_validate",
      );
      await deps.sql.run(mainBranch.id, "SHOW neon.timeline_id");
    } finally {
      // Cleanup failure must never mask (or, absent a real gate failure, invent) a rejection — it
      // is logged instead. The boot sweep (sweepValidationProjects, below) retries any orphan left
      // behind by a delete() that fails here (e.g. the engine was briefly unreachable).
      await deps.projects.delete(project.id).catch((e: unknown) =>
        deps.logger.error(`gate cleanup: failed to delete ${name} — boot sweep will retry`, e));
    }
  };
}

// Deletes every project whose name starts with `_devdb_validate_` — orphans left behind by a
// runner whose OWN cleanup (above) failed (engine unreachable, daemon crashed mid-gate, etc.).
// Called once at boot (index.ts) after the engine and services are up, so `delete()` here has a
// live tenant/compute stack to tear down against.
export async function sweepValidationProjects(
  projects: Pick<ProjectsService, "list" | "delete">,
): Promise<number> {
  let n = 0;
  for (const p of projects.list()) {
    if (p.name.startsWith("_devdb_validate_")) {
      await projects.delete(p.id);
      n++;
    }
  }
  return n;
}
