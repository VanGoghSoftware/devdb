import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ProjectsService } from "../../services/projects.js";
import type { EndpointsService } from "../../services/endpoints.js";
import type { SqlService } from "../../services/sql.js";

// The in-container validation gate (spec pipeline step 5): a downloaded build must drive a REAL
// compute against the LIVE storage — basebackup from the pageserver, WAL to the safekeeper, neon
// extension load — before it may activate. Uses the normal service layer end-to-end; the special
// affordances are exactly three, each carved for this gate alone:
//   - EndpointsService.startWithPgbin (pgbin override, no run-high-water),
//   - ProjectsService.create's `{ internal: true }` (Fix 1 — see the create() call below),
//   - SqlService.run's `{ noAutoStart: true }` (Fix 2 — see the first sql.run call below).
//
// deps are narrow Picks of the REAL services (not a bespoke interface) — a caller supplying the
// full ProjectsService/EndpointsService/SqlService instance satisfies these structurally, and the
// Picks alone prove exactly what surface this module touches.

// Runs one gate step under the runner's AbortSignal (Fix 3): an already-aborted signal
// short-circuits BEFORE the step is even invoked; an abort arriving while the step is in flight
// settles the await immediately (rejecting with the abort reason — the Provisioner's timeout
// error) instead of waiting out the step's own bounded timeout (readyTimeout ~50s, query_timeout
// ~35s). The abandoned step keeps running until its own timeout settles it — its eventual
// rejection is marked handled so it can never surface as an unhandled rejection.
async function step<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return fn();
  signal.throwIfAborted();
  const p = fn();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e as Error); },
    );
  });
}

export function makeValidationRunner(deps: {
  projects: Pick<ProjectsService, "create" | "delete" | "list">;
  endpoints: Pick<EndpointsService, "startWithPgbin" | "stop">;
  sql: Pick<SqlService, "run">;
  logger: { info(m: string): void; error(m: string, e?: unknown): void };
}) {
  return async (a: { major: number; buildPath: string; signal?: AbortSignal }): Promise<void> => {
    const name = `_devdb_validate_${randomBytes(4).toString("hex")}`;
    // Fix 1: `{ internal: true }` — this reserved `_devdb_validate_` name deliberately fails the
    // public name regex (users can never collide with gate names), and the candidate major is
    // still `validating`, not yet in installedMajors(), so BOTH public create() guards would
    // reject the gate's own project. The public callers (REST/MCP) never pass this option.
    const { project, mainBranch } = await deps.projects.create({ name, pgVersion: a.major }, { internal: true });
    try {
      await step(a.signal, () =>
        deps.endpoints.startWithPgbin(mainBranch.id, join(a.buildPath, "bin", "postgres")));
      // Fix 2: `{ noAutoStart: true }` on EVERY smoke query. run()'s default path auto-starts a
      // non-running endpoint via ensureRunning — whose crash recovery resolves the ACTIVE build's
      // pgbin, not the candidate's. If the candidate crashed right after startWithPgbin, that
      // recovery would silently run this SQL against the OLD build, and a same-major version()
      // probe still passes — a broken candidate would be marked ready. A crashed candidate must
      // FAIL the gate (noAutoStart throws on a non-running endpoint), not validate another binary.
      const v = await step(a.signal, () =>
        deps.sql.run(mainBranch.id, "SELECT version()", { noAutoStart: true }));
      const banner = JSON.stringify(v.rows[0] ?? "");
      if (!banner.includes(`${a.major}.`)) {
        throw new Error(`gate: expected PostgreSQL ${a.major}.x, got ${banner.slice(0, 120)}`);
      }
      // Real writes through the full path (pageserver-backed relation + WAL), then a neon-ext probe:
      await step(a.signal, () => deps.sql.run(
        mainBranch.id,
        "CREATE TABLE _devdb_validate(x int); INSERT INTO _devdb_validate SELECT generate_series(1, 100); SELECT count(*) FROM _devdb_validate",
        { noAutoStart: true },
      ));
      await step(a.signal, () => deps.sql.run(mainBranch.id, "SHOW neon.timeline_id", { noAutoStart: true }));
    } finally {
      // Fix 3: on abort (the Provisioner's gate timeout) the candidate's compute may still be
      // coming up or running — stop it explicitly (the queued stop serializes behind whatever
      // holds the branch lane) before deleting, so teardown is prompt and deterministic instead
      // of deferred to the boot sweep. Best-effort, like the delete below.
      if (a.signal?.aborted) {
        await deps.endpoints.stop(mainBranch.id).catch((e: unknown) =>
          deps.logger.error(`gate cleanup: failed to stop endpoint for ${name}`, e));
      }
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
